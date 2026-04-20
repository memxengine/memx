import { readFileSync } from 'node:fs';
import { processPptx } from '@trail/pipelines';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run scripts/test-pptx.ts <path-to-pptx>');
  process.exit(1);
}

const bytes = readFileSync(path);
const r = await processPptx({ pptxBytes: bytes });
console.log('slideCount:', r.slideCount);
console.log('title:', r.title);
console.log('---markdown (first 2000 chars)---');
console.log(r.markdown.slice(0, 2000));
console.log('---');
console.log(`total markdown bytes: ${r.markdown.length}`);
