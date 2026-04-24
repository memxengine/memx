import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F25 — image source pipeline.
 *
 * Two paths inside `handle`:
 *
 *  - **Raster** (PNG / JPEG / WebP / GIF): send to vision LLM via
 *    `input.describeImageAsSource` callback (wired by orchestrator
 *    to Anthropic Vision in `apps/server/src/services/vision.ts`).
 *    Returns a markdown description + the USD-cents cost. Cost is
 *    forwarded as `result.extractCostCents` so the orchestrator can
 *    stamp it on `documents.extract_cost_cents` for F156 credits-
 *    deduction.
 *
 *  - **SVG** (passthrough): SVG is XML, not pixels. Wrap the markup
 *    in a small markdown shell so the wiki reader renders the
 *    diagram inline (browsers handle `<svg>` natively). 0 cost,
 *    0 LLM calls — SVG is already text.
 *
 * Vision-LLMs read text in images natively (screenshots, slides,
 * infographics) so we don't run a separate OCR pass. Pure-text
 * scans where pixel-level OCR matters can grow into an F25b
 * "OCR-augmented" variant later.
 */
export const imagePipeline: Pipeline = {
  name: 'image',
  accepts: (filename, mime) => {
    if (mime?.startsWith('image/')) return 1;
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(filename)) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    const lower = input.filename.toLowerCase();

    // SVG branch — passthrough as text.
    if (lower.endsWith('.svg') || input.mime === 'image/svg+xml') {
      const svgMarkup = input.buffer.toString('utf-8');
      const stem = input.filename.replace(/\.svg$/i, '');
      const markdown = `# ${stem}\n\n${svgMarkup}\n\n*SVG-diagram uploaded as kilde — vises inline i Trail-readeren, kan style'es via CSS, og er accessible via \`<title>\`/\`<desc>\` for skærmlæsere.*`;
      return {
        markdown,
        title: stem,
        warnings: [],
        extractCostCents: 0,
      };
    }

    // Raster branch — vision-describe required.
    if (!input.describeImageAsSource) {
      throw new Error(
        '[image-pipeline] raster image upload requires describeImageAsSource callback ' +
          '(orchestrator must wire vision backend; check ANTHROPIC_API_KEY)',
      );
    }

    const mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
      lower.endsWith('.jpg') || lower.endsWith('.jpeg') || input.mime === 'image/jpeg'
        ? 'image/jpeg'
        : lower.endsWith('.webp') || input.mime === 'image/webp'
          ? 'image/webp'
          : lower.endsWith('.gif') || input.mime === 'image/gif'
            ? 'image/gif'
            : 'image/png';

    const result = await input.describeImageAsSource(input.buffer, mediaType, input.filename);
    if (!result) {
      throw new Error(
        '[image-pipeline] vision backend returned null — likely missing API key or backend disabled',
      );
    }

    // Title: first H1 in vision-LLM output, fall back to filename stem.
    const stem = input.filename.replace(/\.[a-z0-9]+$/i, '');
    const titleMatch = result.markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? stem;

    return {
      markdown: result.markdown,
      title,
      warnings: [],
      extractCostCents: result.costCents,
      extractModel: result.model,
    };
  },
};
