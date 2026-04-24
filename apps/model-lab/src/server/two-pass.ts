import { config } from 'dotenv';
config({ path: import.meta.dir + '/../../.env' });

import { readFile, writeFile, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { runAgenticLoop, type TurnResult } from './openrouter';
import { buildToolDefinitions, createSimulatedKB, initKB, createToolExecutor, collectKBOutput, cleanupKB } from './tools';
import { insertRun, updateRunCompleted, insertTurnLog, insertQualityScore, getRun } from './db';
import { scoreRun } from './scorer';

const DRAFT_DIR = process.argv[2];
const MODEL = process.argv[3] ?? 'google/gemini-2.5-flash';
const MAX_TURNS = Number(process.argv[4] ?? 80);

if (!DRAFT_DIR) {
  console.error('Usage: bun run src/server/two-pass.ts <draft-output-dir> [model] [max-turns]');
  console.error('Example: bun run src/server/two-pass.ts data/output/z-ai-glm-5.1-run_xxx google/gemini-2.5-flash 80');
  process.exit(1);
}

const sourceFile = 'zoneterapibogen-2026.md';
const runId = 'run_' + crypto.randomUUID().slice(0, 12);
const kbRoot = import.meta.dir + '/../../data/kbs/' + runId;

async function copyDraftToKB(draftDir: string, kbRoot: string): Promise<void> {
  const neuronsDir = join(kbRoot, 'neurons');
  await mkdir(neuronsDir, { recursive: true });

  async function walkAndCopy(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndCopy(fullPath, prefix + entry.name + '/');
      } else if (entry.name.endsWith('.md')) {
        const destDir = join(kbRoot, 'neurons', prefix);
        await mkdir(destDir, { recursive: true });
        const content = await readFile(fullPath, 'utf-8');
        await writeFile(join(destDir, entry.name), content);
      }
    }
  }

  await walkAndCopy(join(draftDir, 'neurons'), '');
  console.log('[two-pass] Copied draft Neurons to KB');
}

async function main() {
  console.log(`[two-pass] Run ${runId}: expand ${MODEL} on GLM-5.1 draft`);
  
  // Copy GLM draft output into simulated KB
  await mkdir(join(kbRoot, '/sources'), { recursive: true });
  const sourceContent = await readFile(import.meta.dir + '/../../data/test-sources/zoneterapibogen-2026.md', 'utf-8');
  await writeFile(join(kbRoot, '/sources', sourceFile), sourceContent);
  
  await copyDraftToKB(DRAFT_DIR, kbRoot);

  // Count existing files
  const existingFiles = await countFiles(join(kbRoot, 'neurons'));
  console.log(`[two-pass] KB has ${existingFiles} existing Neurons from GLM draft`);

  insertRun({
    id: runId,
    model: MODEL + ' (2nd pass on GLM)',
    source_file: sourceFile,
    source_size_bytes: Buffer.byteLength(sourceContent),
    status: 'running',
    started_at: new Date().toISOString(),
    max_turns: MAX_TURNS,
    temperature: 0.3,
  });

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = `You are the wiki compiler for a knowledge base. You have access to three tools: read, list_files, and write. Your job is to EXPAND and IMPROVE an existing wiki that was created by a previous pass.

IMPORTANT RULES:
- For large source files, use the read tool's offset and limit parameters to read in chunks.
- ADD TYPED EDGES to wiki links wherever the relation is load-bearing. Use these edge types:
  * \`[[target|is-a]]\` — hierarchical specialisation
  * \`[[target|part-of]]\` — composition
  * \`[[target|contradicts]]\` — explicit disagreement
  * \`[[target|supersedes]]\` — versioning
  * \`[[target|example-of]]\` — concrete instance of abstract concept
  * \`[[target|caused-by]]\` — causal dependency
- Be thorough but concise. Every claim should reference its source.
- Use [[page-name]] for internal wiki cross-references.
- ALL pages MUST have a \`sources: [...]\` field in YAML frontmatter.
- Required frontmatter fields: title, tags, date, sources.
- Write in Danish — this is a Danish knowledge base.`;

  const userPrompt = `You are expanding an existing wiki for knowledge base "ZoneterapiBogen" (slug: zoneterapibogen).

A source has been added: "${sourceFile}" at path "/sources/${sourceFile}". A PREVIOUS PASS has already created some Neurons from this source.

Your job is to EXPAND and IMPROVE the existing wiki. Follow these steps:

1. Call \`list_files\` with mode="list" and kind="wiki" to see ALL existing wiki pages.

2. Call \`read\` with path="/neurons/overview.md" to understand the current state.

3. Call \`read\` with path="/neurons/sources/zoneterapibogen-2026.md" to see the current source summary.

4. READ the source in chunks to understand the FULL content:
   Call \`read\` with path="/sources/${sourceFile}", offset=0, limit=40000. Continue reading all chunks.

5. COMPARE the source content with existing Neurons. Identify:
   a. KEY CONCEPTS in the source that are NOT yet in the wiki — create new concept pages for them
   b. KEY ENTITIES (persons, organizations) NOT yet in the wiki — create new entity pages
   c. EXISTING pages that are MISSING important information from the source — update them with str_replace
   d. EXISTING pages that lack TYPED EDGES — add typed edges like [[target|is-a]], [[target|part-of]], etc.
   e. The GLOSSARY — are there domain-specific terms missing?

6. For each MISSING concept (aim for 5-10 new concepts):
   - \`write\` with command="create", path="/neurons/concepts/", with full content in DANISH including frontmatter and typed edges.

7. For each MISSING entity:
   - Same pattern under /neurons/entities/.

8. For each EXISTING page that needs improvement:
   - \`read\` it, then \`write\` with command="str_replace" to add missing information and typed edges.

9. Update the source summary with a complete overview if it's incomplete.

10. Update the glossary with any missing domain terms.

11. Update the overview page to reflect all new and improved pages.

12. Log the expansion:
    \`write\` with command="append", title="/neurons/log.md", content:

    ## [${today}] expand | ${sourceFile}
    - New pages created: (list)
    - Pages updated: (list)
    - Typed edges added: (count)`;

  const kb = createSimulatedKB(kbRoot, '/sources/' + sourceFile, sourceContent);
  const executeTool = createToolExecutor(kb);
  let turnCounter = 0;

  const result = await runAgenticLoop(
    { model: MODEL, systemPrompt, userPrompt, tools: buildToolDefinitions(), maxTurns: MAX_TURNS, temperature: 0.3 },
    executeTool,
    (turn: TurnResult) => {
      turnCounter++;
      insertTurnLog({
        run_id: runId,
        turn_number: turnCounter,
        role: turn.role,
        content: turn.content?.slice(0, 100000) ?? null,
        tool_calls: turn.tool_calls ? JSON.stringify(turn.tool_calls) : null,
        tool_call_id: turn.tool_call_id ?? null,
        tokens_in: turn.tokensIn,
        tokens_out: turn.tokensOut,
        cost_usd: turn.costUsd,
        latency_ms: turn.latencyMs,
      });
      const toolInfo = turn.tool_calls ? ' tools=' + turn.tool_calls.map((t) => t.function.name).join(',') : '';
      console.log(`[turn ${turnCounter}] ${turn.role}${toolInfo} ${turn.tokensIn}/${turn.tokensOut}tok ${turn.latencyMs}ms`);
    },
  );

  const kbOutput = await collectKBOutput(kb);
  updateRunCompleted(runId, {
    status: result.error ? 'failed' : 'done',
    completed_at: new Date().toISOString(),
    error: result.error,
    total_tokens_in: result.totalTokensIn,
    total_tokens_out: result.totalTokensOut,
    total_cost_usd: result.totalCostUsd,
    total_turns: result.totalTurns,
    duration_ms: result.durationMs,
    final_content: result.finalContent?.slice(0, 50000) ?? null,
    kb_output: JSON.stringify(kbOutput),
  });

  const run = getRun(runId);
  if (run) {
    const scores = scoreRun(run);
    for (const s of scores) insertQualityScore({ run_id: runId, scorer: s.scorer, score: s.score, details: s.details });
    console.log('\n[scores]');
    for (const s of scores) console.log(`  ${s.scorer}: ${(s.score * 100).toFixed(0)}% — ${s.details}`);
  }

  // Export to disk
  const exportDir = import.meta.dir + '/../../data/output/two-pass-glm-flash-' + runId;
  for (const [path, content] of Object.entries(kbOutput)) {
    const filePath = join(exportDir, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  console.log(`\nExported to: ${exportDir}`);

  await cleanupKB(kb);

  console.log(`\n[two-pass] DONE: ${runId}`);
  console.log(`  Turns: ${result.totalTurns}`);
  console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Files: ${Object.keys(kbOutput).length}`);
  if (result.error) console.log(`  Error: ${result.error}`);
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
    else if (entry.name.endsWith('.md')) count++;
  }
  return count;
}

main().catch(console.error);
