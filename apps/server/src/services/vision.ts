import type { DescribeImage } from '@trail/pipelines';

// Read keys at call-time, not module-load-time, so a key added after
// boot (or rotated) gets picked up without restart. Also makes the
// vision-fallback verify-script work — without this, Bun's module
// cache would freeze the env-snapshot from the first import.
const getAnthropicKey = () => process.env.ANTHROPIC_API_KEY ?? '';
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-haiku-4-5-20251001';

/**
 * F161 — return the active vision-model name so persistImagesFromExtraction
 * can stamp `vision_model` on document_images rows.
 *
 * F164 Phase 3 reordered the chain to Anthropic-direct primary (4x
 * faster), OpenRouter fallback. We stamp the PRIMARY's model id when
 * the key is present — even if a specific call falls back to OpenRouter
 * mid-job, the doc's "predominantly described by" is still Anthropic.
 * For NULL-key tenants (rare; only if neither key is set) returns
 * empty string and the stamp falls back to "" which the schema allows.
 */
export function getActiveVisionModel(): string {
  if (process.env.ANTHROPIC_API_KEY) return VISION_MODEL;
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.VISION_MODEL_OPENROUTER ?? 'anthropic/claude-haiku-4.5';
  }
  return '';
}
const VISION_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS ?? 20_000);

// F25/F156 prep — vision pricing per 1M tokens (April 2026).
// Source: Anthropic public price list. Used to convert token-usage
// from API response into USD cents stamped onto documents.extract_cost_cents.
// Add new model entries here as we test/whitelist them.
const VISION_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
};

function visionCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const p = VISION_PRICING[model];
  if (!p) return 0; // unknown model — don't guess a price
  const usd = (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
  return Math.ceil(usd * 100); // → cents, rounded up so 0.4¢ → 1¢
}

/**
 * F25 — describe a standalone image source (full-image, not page-context
 * like the PDF pipeline). Returns markdown describing the content + the
 * USD-cents cost of the call so F156 credits-tracking can deduct it.
 *
 * Different from the per-PDF-image describer below: that one returns
 * a 1-2 sentence factual blurb intended as alt-text inside a larger
 * markdown document. This one produces a self-contained source-doc
 * — the kind of detail level the curator expects when they upload a
 * single image as a Trail source.
 */
export interface ImageDescribeResult {
  markdown: string;
  costCents: number;
  model: string;
}

export async function describeImageAsSource(
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  filename: string,
): Promise<ImageDescribeResult | null> {
  // Anthropic native API path — preferred when configured. Provides
  // detailed token usage in the response.
  if (getAnthropicKey()) {
    return describeViaAnthropic(bytes, mediaType, filename);
  }
  // Fallback: route through OpenRouter — same provider F149 uses for
  // ingest. OpenRouter exposes Anthropic Vision via OpenAI-compatible
  // chat-completions; cost lands on tenant's OpenRouter bill (F156
  // credits-eligible). Tenants that only have OpenRouter keys (most
  // production tenants per F149's tenant_secrets) get vision through
  // this path automatically.
  if (process.env.OPENROUTER_API_KEY) {
    return describeViaOpenRouter(bytes, mediaType, filename);
  }
  return null;
}

async function describeViaAnthropic(
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  filename: string,
): Promise<ImageDescribeResult | null> {
  const base64 = bytes.toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getAnthropicKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text:
                  `Beskriv dette billede som en stand-alone kilde i en knowledge base.\n\n` +
                  `Filnavn: "${filename}"\n\n` +
                  `Returnér markdown:\n` +
                  `- Start med en H1 (\\#) hvor titlen reflekterer billedets indhold\n` +
                  `- Beskriv det visuelle indhold faktuelt: objekter, layout, diagrammer, charts, tekst der er synlig\n` +
                  `- Læs og citér alle synlige tekst-elementer\n` +
                  `- Hvis det er et diagram/flowchart: beskriv komponenter + relationer mellem dem\n` +
                  `- Hvis det er en tabel/skema: gengiv strukturen som markdown-tabel\n` +
                  `- Ingen spekulation — kun det der faktisk er synligt\n` +
                  `- Sprog: dansk\n\n` +
                  `300-500 ord typisk. Ingen "decorative"-svar — billedet er uploaded som kilde, så et svar forventes.`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`vision API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const markdown = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const model = data.model ?? VISION_MODEL;

    return {
      markdown,
      costCents: visionCostCents(model, inputTokens, outputTokens),
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F25 OpenRouter fallback path. OpenRouter exposes Anthropic Vision via
 * its OpenAI-compatible chat-completions endpoint, with `usage.cost`
 * (USD float) returned per response when `usage: { include: true }` is
 * set. We forward that as `costCents` directly — same field F149's
 * runner already trusts as ground-truth for ingest cost.
 *
 * The model name is OpenRouter's slug for haiku-vision; bump via env
 * VISION_MODEL_OPENROUTER if a cheaper/better one ships.
 */
const OPENROUTER_VISION_MODEL =
  process.env.VISION_MODEL_OPENROUTER ?? 'anthropic/claude-haiku-4.5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function describeViaOpenRouter(
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  filename: string,
): Promise<ImageDescribeResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://trailmem.com',
        'X-Title': 'Trail F25 image-source pipeline',
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        max_tokens: 800,
        usage: { include: true },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              {
                type: 'text',
                text:
                  `Beskriv dette billede som en stand-alone kilde i en knowledge base.\n\n` +
                  `Filnavn: "${filename}"\n\n` +
                  `Returnér markdown:\n` +
                  `- Start med en H1 (\\#) hvor titlen reflekterer billedets indhold\n` +
                  `- Beskriv det visuelle indhold faktuelt: objekter, layout, diagrammer, charts, tekst der er synlig\n` +
                  `- Læs og citér alle synlige tekst-elementer\n` +
                  `- Hvis det er et diagram/flowchart: beskriv komponenter + relationer mellem dem\n` +
                  `- Hvis det er en tabel/skema: gengiv strukturen som markdown-tabel\n` +
                  `- Ingen spekulation — kun det der faktisk er synligt\n` +
                  `- Sprog: dansk\n\n` +
                  `300-500 ord typisk. Ingen "decorative"-svar — billedet er uploaded som kilde, så et svar forventes.`,
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openrouter vision ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { cost?: number };
      model?: string;
    };
    const markdown = (data.choices?.[0]?.message?.content ?? '').trim();
    if (!markdown) return null;
    const usdCost = data.usage?.cost ?? 0;
    const costCents = Math.ceil(usdCost * 100);
    return {
      markdown,
      costCents,
      model: data.model ?? OPENROUTER_VISION_MODEL,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short embedded-image description via OpenRouter (Gemini-Vision /
 * Claude-Vision-on-OpenRouter). Used by createVisionBackend's
 * fall-through path when ANTHROPIC_API_KEY is missing but
 * OPENROUTER_API_KEY is set. Mirrors the Anthropic-side prompt
 * style — 1-2 sentences, factual, "decorative" sentinel — so the
 * downstream caller (PDF pipeline) treats the result identically
 * regardless of which provider produced it.
 */
async function describeEmbeddedViaOpenRouter(
  pngBytes: Uint8Array | Buffer,
  context: { page: number },
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const buf = pngBytes instanceof Buffer ? pngBytes : Buffer.from(pngBytes);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://trailmem.com',
        'X-Title': 'Trail F08 PDF embedded-image describe',
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              {
                type: 'text',
                text:
                  `Describe this image from page ${context.page} of a document in 1-2 short sentences.\n` +
                  `Focus on content (diagrams, charts, labels, people, objects). Do not speculate.\n` +
                  `If the image is decorative or contains no information, reply with exactly: "decorative".`,
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openrouter vision ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    if (!text || text.toLowerCase() === 'decorative') return null;
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Direct Anthropic-API implementation of the embedded-describer. Lifted
 * out of createVisionBackend so it can be composed with the OpenRouter
 * fallback in F164 Phase 3. Throws on any API failure (4xx/5xx, abort,
 * network) so the caller can route to the next provider.
 */
async function describeEmbeddedViaAnthropic(
  pngBytes: Uint8Array | Buffer,
  context: { page: number },
): Promise<string | null> {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const buf = pngBytes instanceof Buffer ? pngBytes : Buffer.from(pngBytes);
  const base64 = buf.toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: base64 },
              },
              {
                type: 'text',
                text:
                  `Describe this image from page ${context.page} of a document in 1-2 short sentences.\n` +
                  `Focus on content (diagrams, charts, labels, people, objects). Do not speculate.\n` +
                  `If the image is decorative or contains no information, reply with exactly: "decorative".`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`anthropic vision ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const text = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join(' ')
      .trim();

    if (!text || text.toLowerCase() === 'decorative') return null;
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F164 Phase 3 — provider chain.
 *
 * **Beslutning (omvendt fra dagens kode)**: Anthropic-direct primær,
 * OpenRouter fallback. Direct API er målt ~4x hurtigere end samme model
 * via OpenRouter (ingen middleware-roundtrip, færre 400-fejl på base64-
 * edge-cases). Fallback fyrer kun når Anthropic-call kaster — ikke når
 * den returnerer `null` (= decorative sentinel, et legitimt resultat).
 *
 * Returns null if BOTH:
 *   - No keys configured at all, OR
 *   - Both providers throw (caller treats as 'failed' image)
 *
 * Each individual call honours VISION_TIMEOUT_MS via AbortController,
 * so a hung Anthropic socket doesn't hold up the OpenRouter retry.
 */
export function createVisionBackend(): DescribeImage | null {
  const hasAnthropic = getAnthropicKey().length > 0;
  const hasOpenRouter = (process.env.OPENROUTER_API_KEY ?? '').length > 0;
  if (!hasAnthropic && !hasOpenRouter) return null;

  return async (pngBytes, context) => {
    let firstError: unknown = null;
    if (hasAnthropic) {
      try {
        return await describeEmbeddedViaAnthropic(pngBytes, context);
      } catch (err) {
        firstError = err;
        if (!hasOpenRouter) throw err;
        console.warn(
          `[vision] anthropic failed, falling back to openrouter: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (hasOpenRouter) {
      try {
        return await describeEmbeddedViaOpenRouter(pngBytes, context);
      } catch (err) {
        // Both providers failed — surface the openrouter error, but
        // include a hint about the anthropic error if it was the cause
        // (gives operator a single message to debug from).
        if (firstError) {
          throw new Error(
            `vision both-providers-failed: anthropic=${firstError instanceof Error ? firstError.message : String(firstError)} | openrouter=${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
    // Unreachable given the guard above, but TS wants the explicit fallback.
    return null;
  };
}
