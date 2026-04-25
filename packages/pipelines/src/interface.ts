/**
 * F28 — one narrow contract every ingest pipeline implements. Adding a
 * new format (audio, video, email, image) becomes "register a Pipeline";
 * `apps/server/src/routes/uploads.ts` and `bootstrap/recover-pending-
 * sources.ts` see no change.
 *
 * Input/output stays buffer-in / markdown-out — same shape the existing
 * pdf/docx/pptx/xlsx extractors already use, just lifted to a shared
 * type. Format-specific extras (PDF image storage, vision describer)
 * sit in `PipelineInput` as optional fields; pipelines pull what they
 * need and ignore the rest.
 */

import type { Storage } from '@trail/storage';

export type DescribeImage = (
  pngBytes: Uint8Array,
  context: { page: number; width: number; height: number; filename: string },
) => Promise<string | null | undefined>;

export interface PipelineInput {
  /** Raw file bytes. */
  buffer: Buffer;
  /** Original filename — pipelines use it for title-derivation +
   *  `accepts()` extension matching. */
  filename: string;
  /** Optional MIME type — `accepts()` falls back to filename when absent. */
  mime?: string;
  /**
   * F13 Storage adapter used by pipelines that produce images (PDF,
   * future image-source, future video frame-extraction). Pipelines that
   * don't need it ignore the field.
   */
  storage?: Storage;
  /** Storage path prefix for written images (e.g. `tenant/kb/doc/images`). */
  imagePrefix?: string;
  /** URL prefix to embed in markdown for image references. */
  imageUrlPrefix?: string;
  /** F27 Vision adapter callback — adds alt-text to extracted images. */
  describeImage?: DescribeImage;
  /**
   * F25 — describe a standalone image as a self-contained markdown
   * source. Different shape from `describeImage` (which is per-image-
   * inside-a-PDF, returns a 1-2 sentence blurb): this returns a fuller
   * description (300-500 words) AND the USD-cents cost of the call,
   * so the orchestrator can stamp it on `documents.extract_cost_cents`
   * for F156 credits-deduction.
   */
  describeImageAsSource?: (
    bytes: Buffer,
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
    filename: string,
  ) => Promise<{ markdown: string; costCents: number; model: string } | null>;
  /**
   * F47 — transcribe an audio file via OpenAI Whisper (or pluggable
   * provider). Returns text + auto-detected language + duration so
   * the audio pipeline can render a markdown shell with metadata
   * AND stamp `extract_cost_cents` based on duration × Whisper price.
   */
  transcribeAudio?: (
    bytes: Buffer,
    filename: string,
    contentType?: string,
  ) => Promise<{
    text: string;
    language: string;
    durationSeconds: number;
    costCents: number;
    model: string;
  } | null>;
}

export interface ExtractedImage {
  filename: string;
  storagePath: string;
  page: number;
  width: number;
  height: number;
  description?: string;
}

export interface PipelineResult {
  /** The compiled markdown the orchestrator stores in `documents.content`. */
  markdown: string;
  /** First-heading title or null. Orchestrator falls back to filename. */
  title?: string | null;
  /** Soft warnings (parse-warn, image-skip, etc.) for the curator. */
  warnings: string[];
  // ── format-specific metadata, all optional ──
  pageCount?: number;
  slideCount?: number;
  sheetCount?: number;
  /** Extracted images, written through `input.storage`. */
  images?: ExtractedImage[];
  /**
   * F25/F156 — USD-cents spent on extract-time LLM calls (vision for
   * images, future Whisper for audio, future OCR for scans). 0 for
   * pipelines that don't call out (markdown/SVG passthrough). The
   * orchestrator stamps this on `documents.extract_cost_cents`.
   */
  extractCostCents?: number;
  /** Model identifier used for the extract LLM call, if any. */
  extractModel?: string;
}

export interface Pipeline {
  /** Stable identifier — 'pdf', 'docx', 'image-png', ... */
  name: string;
  /**
   * Confidence 0-1 for whether this pipeline handles the source.
   * 0 = doesn't accept; 1 = perfect match (e.g. exact MIME). Orchestrator
   * picks the highest-scoring pipeline; ties default to first registered.
   */
  accepts: (filename: string, mime?: string) => number;
  /** Run the pipeline. Throws on extract-failure (orchestrator marks doc as failed). */
  handle: (input: PipelineInput) => Promise<PipelineResult>;
}
