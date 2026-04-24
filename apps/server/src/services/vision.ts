import type { DescribeImage } from '@trail/pipelines';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-haiku-4-5-20251001';
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
  if (ANTHROPIC_API_KEY) {
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
        'x-api-key': ANTHROPIC_API_KEY,
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
 * Returns a vision backend if configuration allows one; otherwise null and the
 * pipeline skips image descriptions. We prefer Anthropic's vision API for this
 * narrow, image-in/text-out use case — the claude CLI's image support is
 * clumsier and per-ingest PDF page counts can be high, so batching through the
 * HTTP API is cleaner.
 */
export function createVisionBackend(): DescribeImage | null {
  if (!ANTHROPIC_API_KEY) return null;

  return async (pngBytes, context) => {
    const base64 = Buffer.from(pngBytes).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
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
        throw new Error(`vision API ${res.status}: ${body.slice(0, 200)}`);
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
  };
}
