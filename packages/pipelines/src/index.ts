/**
 * F28 — Pipeline interface lives at the top of this package's public
 * surface. The four built-in pipelines auto-register at module load
 * (the import-then-register sequence below), so consumers just
 * `import { dispatch } from '@trail/pipelines'` and call.
 */

import { registerPipeline } from './registry.js';
import { pdfPipeline } from './pdf/pipeline.js';
import { docxPipeline } from './docx/pipeline.js';
import { pptxPipeline } from './pptx/pipeline.js';
import { xlsxPipeline } from './xlsx/pipeline.js';
import { imagePipeline } from './image/pipeline.js';

// Register on first import. Order = registry insertion order; ties on
// `accepts()` score break by registration order (PDF first wins among
// formats that all return 0.95 for the same extension — none of which
// happens with the five built-ins, but documented behaviour for F46+).
registerPipeline(pdfPipeline);
registerPipeline(docxPipeline);
registerPipeline(pptxPipeline);
registerPipeline(xlsxPipeline);
registerPipeline(imagePipeline);

// ── Public API ──────────────────────────────────────────────────────────
export * from './interface.js';
export * from './registry.js';

// ── Legacy direct-extractor exports (back-compat for callers that still
//    use them — uploads.ts orchestration helpers, recover-pending-sources
//    bootstrap script). New code should use `dispatch()` instead.
export { processPdf } from './pdf/index.js';
export type {
  ExtractedImage as PdfExtractedImage,
  PdfResult,
  ProcessPdfOptions,
  DescribeImage as LegacyDescribeImage,
} from './pdf/index.js';

export { processDocx } from './docx/index.js';
export type { DocxResult, ProcessDocxOptions } from './docx/index.js';

export { processPptx } from './pptx/index.js';
export type { PptxResult, ProcessPptxOptions } from './pptx/index.js';

export { processXlsx } from './xlsx/index.js';
export type { XlsxResult, ProcessXlsxOptions } from './xlsx/index.js';
