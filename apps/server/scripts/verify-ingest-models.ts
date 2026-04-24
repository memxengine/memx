/**
 * F149 Phase 2f — CI check that every OpenRouter model ID in the
 * ingest-models whitelist still exists in OpenRouter's live registry.
 *
 * Fails the build if an ID has been renamed or retired. Catches the
 * class of bug where a provider silently renames a model (e.g.
 * `z-ai/glm-4.6` → `z-ai/glm-5.1`) and our default chain silently
 * starts hitting 404s.
 *
 * claude-cli models are NOT verified here — they're resolved by the
 * claude CLI against Anthropic's catalogue natively, which the CLI
 * handles. If Anthropic renames, the CLI's own failure mode is the
 * signal.
 *
 * No API key required — OpenRouter's /models endpoint is public.
 *
 * Exit code 0 on success, 1 on stale IDs, 2 on network failure.
 *
 * Usage:
 *   - Local: cd apps/server && bun run scripts/verify-ingest-models.ts
 *   - CI: add to pre-commit hook or GitHub Actions workflow
 *   - Offline: pass `--skip-on-offline` to exit 0 if /models unreachable
 */

import { INGEST_MODELS, openrouterModelIds } from '@trail/shared';

const OFFLINE_SAFE = process.argv.includes('--skip-on-offline');
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
}

async function fetchOpenrouterModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: {
      'User-Agent': 'trail-ingest-models-verifier/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { data: OpenRouterModel[] };
  return data.data ?? [];
}

async function main() {
  console.log('\n=== F149 Phase 2f — verify ingest-models whitelist ===\n');
  console.log(`Local whitelist has ${INGEST_MODELS.length} model(s) total:`);
  for (const m of INGEST_MODELS) {
    console.log(`  [${m.backend.padEnd(11)}] ${m.id}${m.tested ? ' ✓' : ' (untested)'}`);
  }

  const whitelistOr = openrouterModelIds();
  console.log(`\n${whitelistOr.length} OpenRouter ID(s) to verify against live registry`);

  let liveModels: OpenRouterModel[];
  try {
    liveModels = await fetchOpenrouterModels();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (OFFLINE_SAFE) {
      console.log(`\n⚠  Could not reach OpenRouter (${msg}); --skip-on-offline → exit 0`);
      process.exit(0);
    }
    console.error(`\n✗ Failed to fetch OpenRouter /models: ${msg}`);
    console.error('  (pass --skip-on-offline in offline envs to treat as warning)');
    process.exit(2);
  }

  const liveIds = new Set(liveModels.map((m) => m.id));
  console.log(`OpenRouter registry has ${liveIds.size} live model(s)\n`);

  const missing: string[] = [];
  const found: string[] = [];
  for (const id of whitelistOr) {
    if (liveIds.has(id)) {
      found.push(id);
    } else {
      missing.push(id);
    }
  }

  console.log(`=== Results ===`);
  for (const id of found) {
    console.log(`  ✓ ${id} — live`);
  }
  for (const id of missing) {
    console.log(`  ✗ ${id} — NOT FOUND in OpenRouter registry`);
  }

  if (missing.length === 0) {
    console.log(`\n✓ ALL ${whitelistOr.length} OpenRouter IDs verified live\n`);
    process.exit(0);
  }

  console.error(`\n✗ ${missing.length} whitelist ID(s) stale — provider likely renamed them.`);
  console.error(`  Check OpenRouter's /models list for the new ID and update`);
  console.error(`  packages/shared/src/ingest-models.ts + any default chains in`);
  console.error(`  apps/server/src/services/ingest/chain.ts that reference them.`);

  // Suggest replacements for each missing ID by searching for the
  // closest-matching provider-prefix in the live registry.
  console.error('\n  Closest live candidates:');
  for (const id of missing) {
    const prefix = id.split('/')[0] ?? '';
    const candidates = [...liveIds]
      .filter((lid) => lid.startsWith(prefix + '/'))
      .sort()
      .slice(0, 5);
    if (candidates.length > 0) {
      console.error(`    ${id} → maybe one of: ${candidates.join(', ')}`);
    } else {
      console.error(`    ${id} → no "${prefix}/"-prefixed models found`);
    }
  }
  process.exit(1);
}

void main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
