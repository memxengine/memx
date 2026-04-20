/**
 * XLSX extraction pipeline. Uses SheetJS (`xlsx`) to read every sheet
 * and convert each into a markdown table. Multi-sheet workbooks emit
 * one `## Sheet: <name>` section per sheet, in workbook order.
 *
 * Why markdown tables and not CSV? The downstream compile LLM reads
 * markdown tables natively and can cite cells ("row 3, column 'dose'
 * ..."). CSV would work but markdown keeps the ingest prompt's
 * formatting contract uniform across file types.
 *
 * Empty sheets + empty trailing rows/cols are trimmed. Formulas are
 * rendered as their computed values (cell.v, not cell.f). Dates + numbers
 * come through as their formatted strings (cell.w) when SheetJS has
 * one — falls back to raw value otherwise.
 */
import * as XLSX from 'xlsx';

export interface XlsxResult {
  markdown: string;
  title: string | null;
  sheetCount: number;
}

export interface ProcessXlsxOptions {
  xlsxBytes: Uint8Array | ArrayBuffer | Buffer;
  /** Filename hint — used as the fallback title when no sheet name is
   *  informative on its own. */
  filename?: string;
}

export async function processXlsx(opts: ProcessXlsxOptions): Promise<XlsxResult> {
  const buffer = toBuffer(opts.xlsxBytes);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const nonEmpty: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const block = sheetToMarkdown(sheet);
    if (!block.trim()) continue;
    nonEmpty.push(`## Sheet: ${name}\n\n${block}`);
  }

  if (nonEmpty.length === 0) {
    return { markdown: '', title: null, sheetCount: 0 };
  }

  const markdown = nonEmpty.join('\n\n').trim() + '\n';
  const title = workbook.SheetNames[0] ?? opts.filename ?? null;

  return {
    markdown,
    title,
    sheetCount: nonEmpty.length,
  };
}

function toBuffer(input: Uint8Array | ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}

function sheetToMarkdown(sheet: XLSX.WorkSheet): string {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: false, // use formatted strings (cell.w) for dates/numbers
  });
  if (aoa.length === 0) return '';

  // Trim trailing empty columns — SheetJS pads to the widest row, so a
  // sheet with one long row and many short ones would otherwise emit
  // a wide, mostly-empty table.
  const maxNonEmpty = aoa.reduce((acc, row) => {
    let last = -1;
    row.forEach((v, i) => {
      if (v !== null && v !== undefined && String(v).trim().length > 0) last = i;
    });
    return Math.max(acc, last);
  }, -1);
  if (maxNonEmpty === -1) return '';
  const width = maxNonEmpty + 1;

  const padded = aoa.map((row) => {
    const trimmed = row.slice(0, width);
    while (trimmed.length < width) trimmed.push('');
    return trimmed.map(cellToString);
  });

  const [header, ...body] = padded;
  if (!header) return '';
  const escape = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines: string[] = [];
  lines.push('| ' + header.map(escape).join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  for (const row of body) {
    lines.push('| ' + row.map(escape).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
