/**
 * F164 Phase 3 — verify the vision provider chain:
 *   Anthropic-direct primary → OpenRouter fallback on exception.
 *
 * What this proves (not infers) — without burning real API tokens:
 *   1. With both keys set + Anthropic returning OK: returns Anthropic's text.
 *   2. With both keys set + Anthropic throwing: falls through to
 *      OpenRouter and returns OpenRouter's text.
 *   3. With both keys set + Anthropic throwing + OpenRouter throwing:
 *      surfaces a combined error mentioning both.
 *   4. With only Anthropic key + Anthropic throwing: re-throws (no
 *      silent NULL pretending it's "decorative").
 *   5. With only OpenRouter key: skips Anthropic entirely, calls
 *      OpenRouter directly.
 *   6. With NO keys: createVisionBackend returns null.
 *   7. getActiveVisionModel reflects the primary: 'claude-haiku-4-5-...'
 *      when Anthropic key set, OpenRouter slug otherwise.
 *
 * Mocking strategy: monkey-patch globalThis.fetch so we never hit a real
 * provider. Each scenario installs a fetch-shim that returns the
 * scripted response; restoreFetch puts the real one back between cases.
 *
 * Run with: `cd apps/server && bun run scripts/verify-f164-vision-fallback.ts`
 * No engine restart needed — this loads vision.ts directly.
 */

import { createVisionBackend, getActiveVisionModel } from '../src/services/vision.js';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

const realFetch = globalThis.fetch;

function installFetchShim(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TINY_PNG = Buffer.from(
  // 1x1 transparent PNG
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63000100000005000156B5A6E40000000049454E44AE426082',
  'hex',
);

console.log(`\n=== F164 Phase 3 verify (vision provider chain) ===\n`);

// ── Scenario 1: both keys, Anthropic OK ─────────────────────────────────
console.log('[1] Both keys set, Anthropic returns OK → returns Anthropic text');
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-1';
process.env.OPENROUTER_API_KEY = 'sk-or-fake-1';
let anthropicCalled1 = false;
let openrouterCalled1 = false;
installFetchShim(async (url) => {
  if (url.includes('anthropic.com')) {
    anthropicCalled1 = true;
    return jsonResponse({
      content: [{ type: 'text', text: 'Anthropic primary description.' }],
    });
  }
  if (url.includes('openrouter.ai')) {
    openrouterCalled1 = true;
  }
  return jsonResponse({ error: 'unexpected' }, 500);
});

const backend1 = createVisionBackend();
assert(backend1 !== null, 'backend created');
const r1 = await backend1!(new Uint8Array(TINY_PNG), { page: 1, width: 1, height: 1, filename: 'tiny.png' });
assert(r1 === 'Anthropic primary description.', `returns Anthropic text (got "${r1}")`);
assert(anthropicCalled1 === true, 'Anthropic was called');
assert(openrouterCalled1 === false, 'OpenRouter NOT called when Anthropic OK');
restoreFetch();

// ── Scenario 2: both keys, Anthropic throws → OpenRouter fallback ──────
console.log('\n[2] Both keys, Anthropic 500 → OpenRouter fallback fires + returns');
let anthropicCalled2 = false;
let openrouterCalled2 = false;
installFetchShim(async (url) => {
  if (url.includes('anthropic.com')) {
    anthropicCalled2 = true;
    return new Response('upstream blew up', { status: 500 });
  }
  if (url.includes('openrouter.ai')) {
    openrouterCalled2 = true;
    return jsonResponse({
      choices: [{ message: { content: 'OpenRouter fallback description.' } }],
      usage: { cost: 0.0001 },
      model: 'anthropic/claude-haiku-4.5',
    });
  }
  return jsonResponse({ error: 'unexpected' }, 500);
});

const backend2 = createVisionBackend();
const r2 = await backend2!(new Uint8Array(TINY_PNG), { page: 1, width: 1, height: 1, filename: 'tiny.png' });
assert(r2 === 'OpenRouter fallback description.', `returns OpenRouter text (got "${r2}")`);
assert(anthropicCalled2, 'Anthropic was called first');
assert(openrouterCalled2, 'OpenRouter fallback fired');
restoreFetch();

// ── Scenario 3: both fail → combined error ─────────────────────────────
console.log('\n[3] Both keys, both providers throw → combined error message');
installFetchShim(async (url) => {
  if (url.includes('anthropic.com')) {
    return new Response('anthropic 4xx', { status: 400 });
  }
  if (url.includes('openrouter.ai')) {
    return new Response('openrouter 4xx', { status: 400 });
  }
  return jsonResponse({ error: 'unexpected' }, 500);
});

const backend3 = createVisionBackend();
let combinedError: Error | null = null;
try {
  await backend3!(new Uint8Array(TINY_PNG), { page: 1, width: 1, height: 1, filename: 'tiny.png' });
} catch (e) {
  combinedError = e as Error;
}
assert(combinedError !== null, 'both-fail throws');
assert(
  combinedError !== null && combinedError.message.includes('anthropic') && combinedError.message.includes('openrouter'),
  `error mentions both providers (got: ${combinedError?.message?.slice(0, 80)}…)`,
);
restoreFetch();

// ── Scenario 4: only Anthropic, throws → re-throws (no silent fallback) ─
console.log('\n[4] Only Anthropic key, throws → re-throws (no fake-decorative)');
delete process.env.OPENROUTER_API_KEY;
installFetchShim(async () => new Response('anthropic blew up', { status: 503 }));
const backend4 = createVisionBackend();
let onlyAnthError: Error | null = null;
try {
  await backend4!(new Uint8Array(TINY_PNG), { page: 1, width: 1, height: 1, filename: 'tiny.png' });
} catch (e) {
  onlyAnthError = e as Error;
}
assert(onlyAnthError !== null, 'throws when only Anthropic + Anthropic fails');
assert(
  onlyAnthError !== null && onlyAnthError.message.includes('anthropic'),
  'error message names anthropic',
);
restoreFetch();

// ── Scenario 5: only OpenRouter → skips Anthropic ──────────────────────
console.log('\n[5] Only OpenRouter key → Anthropic skipped, OpenRouter direct');
delete process.env.ANTHROPIC_API_KEY;
process.env.OPENROUTER_API_KEY = 'sk-or-fake-5';
let anthropicCalled5 = false;
let openrouterCalled5 = false;
installFetchShim(async (url) => {
  if (url.includes('anthropic.com')) {
    anthropicCalled5 = true;
    return new Response('should not call', { status: 500 });
  }
  if (url.includes('openrouter.ai')) {
    openrouterCalled5 = true;
    return jsonResponse({
      choices: [{ message: { content: 'OpenRouter only.' } }],
      usage: { cost: 0.0001 },
      model: 'anthropic/claude-haiku-4.5',
    });
  }
  return jsonResponse({ error: 'unexpected' }, 500);
});

const backend5 = createVisionBackend();
const r5 = await backend5!(new Uint8Array(TINY_PNG), { page: 1, width: 1, height: 1, filename: 'tiny.png' });
assert(r5 === 'OpenRouter only.', 'returns OpenRouter text');
assert(anthropicCalled5 === false, 'Anthropic NOT called');
assert(openrouterCalled5 === true, 'OpenRouter called');
restoreFetch();

// ── Scenario 6: no keys → null backend ─────────────────────────────────
console.log('\n[6] No keys → createVisionBackend returns null');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
const backend6 = createVisionBackend();
assert(backend6 === null, 'backend is null without keys');

// ── Scenario 7: getActiveVisionModel reflects primary ──────────────────
console.log('\n[7] getActiveVisionModel reflects primary');
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-7';
delete process.env.OPENROUTER_API_KEY;
assert(
  getActiveVisionModel() === 'claude-haiku-4-5-20251001',
  `Anthropic primary → claude-haiku-4-5-... (got ${getActiveVisionModel()})`,
);

delete process.env.ANTHROPIC_API_KEY;
process.env.OPENROUTER_API_KEY = 'sk-or-fake-7';
assert(
  getActiveVisionModel() === 'anthropic/claude-haiku-4.5',
  `OpenRouter only → openrouter slug (got ${getActiveVisionModel()})`,
);

delete process.env.OPENROUTER_API_KEY;
assert(getActiveVisionModel() === '', `no keys → empty string (got "${getActiveVisionModel()}")`);

console.log(`\n=== ${failures === 0 ? 'PASS' : `FAIL (${failures})`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
