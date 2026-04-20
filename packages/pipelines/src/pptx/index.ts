/**
 * PPTX extraction pipeline. Opens the OOXML zip directly via JSZip,
 * walks `ppt/slides/slide{N}.xml` in numeric order, and pulls text
 * runs out of each slide's `<a:t>` elements. Per-slide notes
 * (`ppt/notesSlides/notesSlide{N}.xml`) are included as `### Noter`
 * blocks when present.
 *
 * Why not officeparser: its `newlineDelimiter` option separates by
 * text run / paragraph, not by slide — a 3-slide deck with ~25 text
 * boxes per slide reports as 75 "sections". Reading the zip directly
 * gives us an authoritative slide count and clean per-slide boundaries.
 *
 * Images embedded in the deck are dropped for v1 — same reasoning as
 * the DOCX pipeline; text is where the knowledge is.
 */
import JSZip from 'jszip';

export interface PptxResult {
  markdown: string;
  title: string | null;
  slideCount: number;
}

export interface ProcessPptxOptions {
  pptxBytes: Uint8Array | ArrayBuffer | Buffer;
}

export async function processPptx(opts: ProcessPptxOptions): Promise<PptxResult> {
  const buffer = toBuffer(opts.pptxBytes);
  const zip = await JSZip.loadAsync(buffer);

  // Slide files land at `ppt/slides/slide1.xml`, `slide2.xml`, ...
  // Sort numerically (not lexicographic — slide10 must come after
  // slide2, not between slide1 and slide2).
  const slideEntries = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNum(a) - slideNum(b));

  if (slideEntries.length === 0) {
    return { markdown: '', title: null, slideCount: 0 };
  }

  const sections: string[] = [];
  let firstSlideFirstLine = '';
  for (let i = 0; i < slideEntries.length; i++) {
    const file = zip.files[slideEntries[i]!];
    if (!file) continue;
    const xml = await file.async('string');
    const text = extractSlideText(xml);

    // Notes file mirrors the slide name under notesSlides/.
    let notes = '';
    const notesPath = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notesFile = zip.files[notesPath];
    if (notesFile) {
      const notesXml = await notesFile.async('string');
      notes = extractSlideText(notesXml);
      // PPTX defaults its notes placeholder to "1" or the slide number —
      // drop a pure-digit notes block as a false positive.
      if (/^\d+\s*$/.test(notes.trim())) notes = '';
    }

    if (i === 0) {
      const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
      if (firstLine.length > 0 && firstLine.length <= 120) {
        firstSlideFirstLine = firstLine.trim();
      }
    }

    let block = `## Slide ${i + 1}\n\n`;
    if (text.trim()) {
      block += text.trim() + '\n';
    }
    if (notes.trim()) {
      block += `\n### Noter\n\n${notes.trim()}\n`;
    }
    sections.push(block);
  }

  const markdown = sections.join('\n').trim() + '\n';

  return {
    markdown,
    title: firstSlideFirstLine.length > 0 ? firstSlideFirstLine : null,
    slideCount: slideEntries.length,
  };
}

function slideNum(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pull text from a slide XML. PPTX slides use `<a:t>...</a:t>` for
 * text runs. Paragraphs live under `<a:p>...</a:p>` — we emit one
 * line per `<a:p>` so bullet points stay visually separated.
 *
 * A full XML parser would be more correct, but the slide structure
 * is well-defined enough that a two-stage regex pass (paragraphs,
 * then runs within each) produces clean output for the compile LLM
 * to read.
 */
function extractSlideText(xml: string): string {
  const lines: string[] = [];
  // Match each <a:p>...</a:p> block — .*? is fine because XML is
  // well-formed inside a zip entry.
  const paragraphRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paragraphRe.exec(xml)) !== null) {
    const pContent = pMatch[1]!;
    const runs: string[] = [];
    const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = runRe.exec(pContent)) !== null) {
      const text = decodeXmlEntities(rMatch[1]!);
      if (text) runs.push(text);
    }
    const line = runs.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function toBuffer(input: Uint8Array | ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}
