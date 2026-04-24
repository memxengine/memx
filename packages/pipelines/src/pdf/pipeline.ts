import { processPdf } from './index.js';
import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F28 — PDF pipeline wrapper. Bridges the existing `processPdf` extractor
 * to the unified Pipeline contract. Orchestrator passes Storage +
 * imagePrefix + imageUrlPrefix + optional describeImage via
 * PipelineInput; we forward them directly to processPdf.
 */
export const pdfPipeline: Pipeline = {
  name: 'pdf',
  accepts: (filename, mime) => {
    if (mime === 'application/pdf') return 1;
    if (filename.toLowerCase().endsWith('.pdf')) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    if (!input.storage || !input.imagePrefix || !input.imageUrlPrefix) {
      throw new Error(
        '[pdf-pipeline] requires storage + imagePrefix + imageUrlPrefix in PipelineInput',
      );
    }
    const result = await processPdf({
      pdfBytes: input.buffer,
      storage: input.storage,
      imagePrefix: input.imagePrefix,
      imageUrlPrefix: input.imageUrlPrefix,
      describe: input.describeImage,
    });
    return {
      markdown: result.markdown,
      pageCount: result.pageCount,
      images: result.images,
      warnings: [],
    };
  },
};
