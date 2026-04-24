import { processDocx } from './index.js';
import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F28 — DOCX pipeline wrapper. mammoth-based, text-only (no images yet).
 */
export const docxPipeline: Pipeline = {
  name: 'docx',
  accepts: (filename, mime) => {
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 1;
    if (filename.toLowerCase().endsWith('.docx')) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    const result = await processDocx({ docxBytes: input.buffer });
    return {
      markdown: result.markdown,
      title: result.title ?? null,
      warnings: result.warnings ?? [],
    };
  },
};
