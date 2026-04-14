import { processPdf } from '@memx/pipelines';
import { LocalStorage } from '@memx/storage';
import { readFileSync } from 'node:fs';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: bun run scripts/pdf-smoke.ts <path-to-pdf>');
  process.exit(1);
}

const pdfBytes = readFileSync(pdfPath);
console.log(`PDF size: ${pdfBytes.length} bytes`);

const storage = new LocalStorage('/tmp/memx-pdf-test');
const started = Date.now();

const result = await processPdf({
  pdfBytes: new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength),
  storage,
  imagePrefix: 't1/kb1/doc1/images',
  imageUrlPrefix: '/api/v1/documents/doc1/images',
});

const elapsed = Date.now() - started;
console.log(`Processed in ${elapsed}ms`);
console.log(`Pages: ${result.pageCount}`);
console.log(`Images: ${result.images.length}`);
console.log(`Described: ${result.images.filter((i) => i.description).length}`);
console.log(`Markdown length: ${result.markdown.length} chars`);
console.log('');
console.log('--- First 800 chars of markdown ---');
console.log(result.markdown.slice(0, 800));
console.log('');
console.log('--- First 3 image refs ---');
const imgMatches = [...result.markdown.matchAll(/!\[.*?\]\(.*?\)/g)].slice(0, 3);
for (const m of imgMatches) console.log('  ', m[0]);
