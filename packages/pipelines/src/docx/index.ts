import mammoth from 'mammoth';

export interface DocxResult {
  /** Extracted content as markdown — headings, paragraphs, lists preserved. */
  markdown: string;
  /** First H1 in the document, if any — useful as a default title. */
  title: string | null;
  /** Non-fatal conversion warnings from mammoth (unsupported styles etc.). */
  warnings: string[];
}

export interface ProcessDocxOptions {
  /** .docx file bytes. */
  docxBytes: Uint8Array | ArrayBuffer | Buffer;
}

/**
 * Convert a .docx file to markdown via mammoth.
 *
 * Mammoth maps Word's semantic styles (Heading 1, Heading 2, Normal, List, …)
 * to HTML, and we then convert that subset to markdown inline. Images embedded
 * in the document are dropped for now — Word docs from Sanne are text-heavy,
 * and wiring them through the same storage/vision path as PDFs can wait for
 * a subsequent pass.
 *
 * Tables and complex formatting (footnotes, tracked changes) come through as
 * best-effort markdown or plain text. If mammoth's converter throws, the
 * error propagates up — the upload handler turns that into status='failed'.
 */
export async function processDocx(opts: ProcessDocxOptions): Promise<DocxResult> {
  const buffer = toBuffer(opts.docxBytes);
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      // Default style map covers h1-h6, paragraphs, lists. Strike-through etc.
      // we just let mammoth produce its default HTML spans; the html→md step
      // drops styling it doesn't understand.
      includeDefaultStyleMap: true,
    },
  );

  const markdown = htmlToMarkdown(result.value);
  const title = firstHeading(markdown);

  return {
    markdown,
    title,
    warnings: result.messages.map((m) => m.message),
  };
}

function toBuffer(input: Uint8Array | ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}

/**
 * Minimal HTML→markdown shim for mammoth's output. Mammoth emits a tight,
 * predictable HTML subset — h1-h6, p, strong/em, ul/ol/li, a, table, br —
 * so a regex pass is enough. A full html-to-md parser would be overkill.
 */
function htmlToMarkdown(html: string): string {
  let out = html;

  // Block-level elements first so we can drop them cleanly.
  out = out.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_, level: string, inner: string) => {
    return `\n\n${'#'.repeat(Number(level))} ${stripInline(inner).trim()}\n\n`;
  });
  out = out.replace(/<p[^>]*>(.*?)<\/p>/gis, (_, inner: string) => {
    const text = stripInline(inner).trim();
    return text ? `\n\n${text}\n\n` : '\n\n';
  });
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<li[^>]*>(.*?)<\/li>/gis, (_, inner: string) => {
    return `- ${stripInline(inner).trim()}\n`;
  });
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // Inline formatting pass on whatever survived above.
  out = stripInline(out);

  // Collapse whitespace runs and trim edges.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function stripInline(html: string): string {
  let out = html;
  out = out.replace(/<strong[^>]*>(.*?)<\/strong>/gis, '**$1**');
  out = out.replace(/<b[^>]*>(.*?)<\/b>/gis, '**$1**');
  out = out.replace(/<em[^>]*>(.*?)<\/em>/gis, '*$1*');
  out = out.replace(/<i[^>]*>(.*?)<\/i>/gis, '*$1*');
  out = out.replace(/<code[^>]*>(.*?)<\/code>/gis, '`$1`');
  out = out.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, '[$2]($1)');
  // Remove anything we didn't translate — mammoth's spans etc.
  out = out.replace(/<[^>]+>/g, '');
  // Decode a small set of entities mammoth commonly emits.
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return out;
}

function firstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
