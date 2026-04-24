import { config } from 'dotenv';
config({ path: import.meta.dir + '/../../.env' });

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const MODEL = process.argv[2] ?? 'google/gemini-2.5-flash';

async function translate(content: string): Promise<string> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Du er en professionel oversætter fra engelsk til dansk. Oversæt følgende wiki-side til dansk.

VIGTIGE REGLER:
- YAML frontmatter (mellem --- linjerne) skal forblive UÆNDRET — oversæt IKKE nøglerne (title, tags, date, sources), men oversæt VÆRDIERNE for title og tags
- Oversæt selve indholdet naturligt til dansk
- Bevar alle [[wiki-links]] og [[wiki-links|edge-types]] uændret
- Bevar markdown formatering
- Fagtermer indenfor zoneterapi/TKM skal bruge deres etablerede danske termer
- Returner KUN den oversatte tekst, ingen kommentarer`,
        },
        { role: 'user', content },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Translation failed: ${response.status} ${err.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

const inputDir = process.argv[3];
if (!inputDir) {
  console.error('Usage: bun run src/server/translate.ts [model] <input-dir>');
  process.exit(1);
}

const outputDir = inputDir + '-da-en';
await mkdir(outputDir, { recursive: true });

async function walkDir(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...await walkDir(join(dir, entry.name), prefix + entry.name + '/'));
    } else if (entry.name.endsWith('.md')) {
      files.push(prefix + entry.name);
    }
  }
  return files;
}

const files = await walkDir(inputDir, '');
console.log(`Found ${files.length} files to translate with ${MODEL}`);

for (const relPath of files) {
  const srcPath = join(inputDir, relPath);
  const content = await readFile(srcPath, 'utf-8');

  // EN version
  const enDir = join(outputDir, 'en', dirname(relPath));
  await mkdir(enDir, { recursive: true });
  await writeFile(join(enDir, relPath.split('/').pop()!), content);

  // DA version
  console.log(`Translating: ${relPath}`);
  try {
    const translated = await translate(content);
    const daDir = join(outputDir, 'da', dirname(relPath));
    await mkdir(daDir, { recursive: true });
    await writeFile(join(daDir, relPath.split('/').pop()!), translated);
    console.log(`  ✓ done`);
  } catch (err) {
    console.error(`  ✗ failed:`, err);
    // Fall back to English if translation fails
    const daDir = join(outputDir, 'da', dirname(relPath));
    await mkdir(daDir, { recursive: true });
    await writeFile(join(daDir, relPath.split('/').pop()!), content);
  }

  // Rate limit
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`\nDone! Output in: ${outputDir}/`);
console.log(`  en/ — English originals`);
console.log(`  da/ — Danish translations`);
