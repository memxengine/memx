import { processXlsx } from './index.js';
import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F28 — XLSX pipeline wrapper. SheetJS-based, one markdown table per sheet.
 */
export const xlsxPipeline: Pipeline = {
  name: 'xlsx',
  accepts: (filename, mime) => {
    if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 1;
    if (filename.toLowerCase().endsWith('.xlsx')) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    const result = await processXlsx({
      xlsxBytes: input.buffer,
      filename: input.filename,
    });
    return {
      markdown: result.markdown,
      title: result.title,
      sheetCount: result.sheetCount,
      warnings: [],
    };
  },
};
