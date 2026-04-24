/**
 * F151 shadow-estimat — one-shot backfill of ingest_jobs.cost_cents_estimated
 * for pre-F149 ingests where cost wasn't tracked.
 *
 * HEURISTIC (wide uncertainty — ±30-50%):
 *   output_tokens ≈ SUM(LENGTH(wiki.content)) / 4
 *                  ┌ wiki docs produced by the job, via F111.2
 *                  └ ingest_job_id-stamp
 *   input_tokens  ≈ output_tokens × 15
 *                  ┌ cumulative tool-call context per turn
 *                  └ observed ratio from F149 Phase 2d live data
 *   cost ≈ (input × 3 + output × 15) / 1_000_000 USD
 *                  └ Sonnet-4-6 API pricing (default pre-F149 model)
 *   cost_cents_estimated = round(cost × 100)
 *
 * We backfill ONLY rows where:
 *   - status = 'done' (failed jobs have no meaningful cost)
 *   - cost_cents = 0 (don't overwrite real billing)
 *   - cost_cents_estimated IS NULL (idempotent re-runs skip done rows)
 *   - There's at least one wiki doc with ingest_job_id = job.id
 *
 * Every filled row is a SHADOW estimate. UI must render with:
 *   - Distinctive "~" or "est." prefix
 *   - Separate total from real cost_cents
 *   - Tooltip noting "estimated at Sonnet-API rates, ±30-50%"
 *
 * Christian's ACTUAL cost for these jobs was 0 (Max Plan flat subscription).
 * The shadow tells us what it WOULD have cost via API — useful for F43
 * Stripe pricing-tier design, not for billing.
 *
 * Dry-run default. Pass --apply to mutate.
 * Pass --verbose to see per-row details.
 *
 * Usage:
 *   cd apps/server && bun run scripts/backfill-cost-estimates.ts           # dry-run
 *   cd apps/server && bun run scripts/backfill-cost-estimates.ts --apply   # execute
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase, ingestJobs } from '@trail/db';
import { eq, sql, and, isNull } from 'drizzle-orm';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

// Sonnet-4-6 API pricing as of 2026-04-24 (USD per 1M tokens).
// If the price ever changes, re-run after updating these constants —
// estimates will update for any non-persisted rows.
const SONNET_INPUT_USD_PER_M = 3.0;
const SONNET_OUTPUT_USD_PER_M = 15.0;

// Chars-to-tokens heuristic. English averages ~4 chars/token; Danish
// runs slightly higher due to æøå Unicode-pair-encoding in tokenizers
// but 4 is close enough for our ±30% target.
const CHARS_PER_TOKEN = 4;

// Input-to-output token ratio observed on F149 Phase 2d live ingest
// (Gemini Flash, ~8KB source → 11 turns, ~20:1 input:output). Claude
// tends similar; conservative multiplier.
const INPUT_TO_OUTPUT_RATIO = 15;

const trail = await createLibsqlDatabase({ path: join(homedir(), 'Apps/broberg/trail/data/trail.db') });

// ── 1. Find candidates ─────────────────────────────────────────────────

const candidates = (await trail.execute(
  `SELECT
     j.id AS job_id,
     j.document_id,
     j.tenant_id,
     j.knowledge_base_id,
     j.started_at,
     j.cost_cents,
     COALESCE(SUM(LENGTH(d.content)), 0) AS output_chars,
     COUNT(d.id) AS neuron_count
   FROM ingest_jobs j
   LEFT JOIN documents d
     ON d.ingest_job_id = j.id
        AND d.kind = 'wiki'
        AND d.archived = 0
   WHERE j.status = 'done'
     AND j.cost_cents = 0
     AND j.cost_cents_estimated IS NULL
   GROUP BY j.id
   HAVING output_chars > 0`,
)).rows as Array<{
  job_id: string;
  document_id: string;
  tenant_id: string;
  knowledge_base_id: string;
  started_at: string;
  cost_cents: number;
  output_chars: number;
  neuron_count: number;
}>;

console.log(`\n=== Shadow-estimat backfill (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`Candidate rows: ${candidates.length}`);
console.log(`(status='done', cost_cents=0, estimated IS NULL, produced ≥1 wiki doc)\n`);

if (candidates.length === 0) {
  console.log('Nothing to backfill.');
  process.exit(0);
}

// ── 2. Compute estimates ───────────────────────────────────────────────

interface Plan {
  jobId: string;
  neuronCount: number;
  outputChars: number;
  outputTokens: number;
  inputTokensEstimate: number;
  costCentsEstimated: number;
}

const plan: Plan[] = candidates.map((c) => {
  const outputTokens = Math.round(c.output_chars / CHARS_PER_TOKEN);
  const inputTokensEstimate = outputTokens * INPUT_TO_OUTPUT_RATIO;
  const costUsd =
    (inputTokensEstimate / 1_000_000) * SONNET_INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * SONNET_OUTPUT_USD_PER_M;
  const costCentsEstimated = Math.round(costUsd * 100);
  return {
    jobId: c.job_id,
    neuronCount: c.neuron_count,
    outputChars: c.output_chars,
    outputTokens,
    inputTokensEstimate,
    costCentsEstimated,
  };
});

// ── 3. Report ──────────────────────────────────────────────────────────

const totalEstimated = plan.reduce((acc, p) => acc + p.costCentsEstimated, 0);
const totalNeurons = plan.reduce((acc, p) => acc + p.neuronCount, 0);
const maxCost = plan.reduce((acc, p) => Math.max(acc, p.costCentsEstimated), 0);

console.log(`Total estimated across ${plan.length} jobs:`);
console.log(`  ${totalNeurons} neurons produced`);
console.log(`  Cumulative estimate: $${(totalEstimated / 100).toFixed(2)} (${totalEstimated}¢)`);
console.log(`  Single most-expensive job: ${maxCost}¢`);
console.log(`  Avg per job: ${Math.round(totalEstimated / plan.length)}¢`);
console.log(`  Avg per Neuron: ${totalNeurons > 0 ? (totalEstimated / totalNeurons).toFixed(2) : 0}¢\n`);

if (VERBOSE) {
  console.log('Per-row breakdown:');
  for (const p of plan.slice(0, 20)) {
    console.log(
      `  ${p.jobId.slice(-10)} — ${p.neuronCount} neurons · ${Math.round(p.outputChars / 1024)}KB out · ~${p.outputTokens}t out → ~${p.costCentsEstimated}¢`,
    );
  }
  if (plan.length > 20) console.log(`  … + ${plan.length - 20} more rows`);
  console.log('');
}

// ── 4. Apply ───────────────────────────────────────────────────────────

if (!APPLY) {
  console.log('Dry run — no DB writes. Re-run with --apply to persist.\n');
  process.exit(0);
}

console.log('Applying to DB…');
let updated = 0;
for (const p of plan) {
  const res = await trail.db
    .update(ingestJobs)
    .set({ costCentsEstimated: p.costCentsEstimated })
    .where(and(eq(ingestJobs.id, p.jobId), isNull(ingestJobs.costCentsEstimated)))
    .run();
  if (res.rowsAffected > 0) updated += 1;
}

console.log(`\n✓ Wrote cost_cents_estimated on ${updated} rows.`);
console.log(`  Total shadow estimate: $${(totalEstimated / 100).toFixed(2)}`);
console.log(`  (Real out-of-pocket cost for these jobs was $0 — Max Plan subscription)`);
