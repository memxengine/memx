import { processPptx } from './index.js';
import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F28 — PPTX pipeline wrapper. JSZip-based slide-text extraction.
 */
export const pptxPipeline: Pipeline = {
  name: 'pptx',
  accepts: (filename, mime) => {
    if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 1;
    if (filename.toLowerCase().endsWith('.pptx')) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    const result = await processPptx({ pptxBytes: input.buffer });
    return {
      markdown: result.markdown,
      title: result.title,
      slideCount: result.slideCount,
      warnings: [],
    };
  },
};
