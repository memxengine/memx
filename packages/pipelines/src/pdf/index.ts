import type { Storage } from '@trail/storage';
import type { PDFPageProxy } from 'pdfjs-dist';
import { rgbaToPng } from './png.js';

// Legacy build runs in Node/Bun without needing a DOM canvas.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface ExtractedImage {
  filename: string;
  storagePath: string;
  page: number;
  width: number;
  height: number;
  /** Short factual description produced by the vision backend, if any. */
  description?: string;
}

export interface PdfResult {
  markdown: string;
  pageCount: number;
  images: ExtractedImage[];
}

/**
 * Callback that turns raw PNG bytes into a short description (1-2 sentences).
 * Return null/undefined to skip description for this image.
 */
export type DescribeImage = (
  pngBytes: Uint8Array,
  context: { page: number; width: number; height: number; filename: string },
) => Promise<string | null | undefined>;

export interface ProcessPdfOptions {
  /** PDF file bytes. */
  pdfBytes: Uint8Array | ArrayBuffer;
  /** Storage where extracted images will be written. */
  storage: Storage;
  /**
   * Prefix for image paths in storage. Images land at
   * `${imagePrefix}/${filename}`. The caller typically passes something like
   * `{tenantId}/{kbId}/{docId}/images`.
   */
  imagePrefix: string;
  /** Path used inside the generated markdown (what readers see). */
  imageUrlPrefix: string;
  /** Optional vision backend to annotate images with descriptions. */
  describe?: DescribeImage;
  /** Images smaller than this (in either dim) skip the vision call. */
  minDescribeSize?: number;
}

/** Extract text + images from a PDF, write images through storage, return markdown. */
export async function processPdf(opts: ProcessPdfOptions): Promise<PdfResult> {
  // pdfjs rejects Node's Buffer (a Uint8Array subclass) — always normalise to a
  // plain Uint8Array view over the same bytes.
  const input = opts.pdfBytes;
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const pages: string[] = [];
  const images: ExtractedImage[] = [];
  const minDescribeSize = opts.minDescribeSize ?? 100;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const pageText = await extractText(page);

    const pageImageRefs: string[] = [];
    const pageImages = await extractImages(page, pageNum);

    for (const img of pageImages) {
      const storagePath = `${opts.imagePrefix}/${img.filename}`;
      await opts.storage.put(storagePath, img.bytes, 'image/png');

      let description: string | undefined;
      if (opts.describe && img.width >= minDescribeSize && img.height >= minDescribeSize) {
        try {
          const desc = await opts.describe(img.bytes, {
            page: pageNum,
            width: img.width,
            height: img.height,
            filename: img.filename,
          });
          if (desc && desc.trim()) description = desc.trim();
        } catch (err) {
          // Vision failures are non-fatal — we still keep the raw image.
          console.warn(`[pdf] describe failed for ${img.filename}:`, (err as Error).message);
        }
      }

      images.push({
        filename: img.filename,
        storagePath,
        page: pageNum,
        width: img.width,
        height: img.height,
        description,
      });

      const alt = description ?? '';
      pageImageRefs.push(`\n![${escapeAlt(alt)}](${opts.imageUrlPrefix}/${img.filename})\n`);
    }

    pages.push(`## Page ${pageNum}\n\n${pageText}${pageImageRefs.join('')}`);
  }

  return { markdown: pages.join('\n\n'), pageCount: doc.numPages, images };
}

async function extractText(page: PDFPageProxy): Promise<string> {
  const tc = await page.getTextContent();
  const lines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;

  for (const item of tc.items) {
    if (!('str' in item)) continue; // TextMarkedContent, skip
    const y = item.transform[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
    }
    currentLine += item.str;
    if (item.hasEOL) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
    }
    lastY = y ?? lastY;
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join('\n');
}

interface RawImage {
  filename: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

async function extractImages(page: PDFPageProxy, pageNum: number): Promise<RawImage[]> {
  const images: RawImage[] = [];
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch {
    return images;
  }

  const imgObjectIds = new Set<string>();
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === 85 || fn === 86) {
      const args = opList.argsArray[i];
      if (args && typeof args[0] === 'string') imgObjectIds.add(args[0]);
    }
  }

  let imgIndex = 0;
  for (const objId of imgObjectIds) {
    try {
      const obj = await new Promise<unknown>((resolve) => {
        page.objs.get(objId, resolve);
      });
      const img = obj as
        | { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; kind?: number }
        | null;
      if (!img || !img.data || !img.width || !img.height) continue;

      imgIndex++;
      const filename = `page-${pageNum}-img-${imgIndex}.png`;
      const pngBytes = rgbaToPng(img.data, img.width, img.height, img.kind);
      images.push({ filename, bytes: pngBytes, width: img.width, height: img.height });
    } catch {
      // Skip images that fail to decode.
    }
  }
  return images;
}

function escapeAlt(text: string): string {
  return text.replace(/[\[\]]/g, '').replace(/\n+/g, ' ').slice(0, 300);
}
