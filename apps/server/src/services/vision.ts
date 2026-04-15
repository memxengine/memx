import type { DescribeImage } from '@trail/pipelines';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-haiku-4-5-20251001';
const VISION_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS ?? 20_000);

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
