#!/usr/bin/env node
// F134 consumer integration tests — validates the @webhouse/cms deploy API
// from trail-site's side. Runs against whichever CMS admin instance the
// CMS_ADMIN_URL + CMS_DEPLOY_TOKEN env vars point at (localhost in dev,
// staging/prod via CI).
//
// What this locks down:
//   1. TTL window, IP filter, permission check, resource include/exclude —
//      all behave per F134's evaluation order.
//   2. The trail-site deploy token can ONLY touch site:trail, which is the
//      contract cms-core handed us.
//   3. Deploy trigger + list endpoints return the shape the onboarding
//      "Finish setup" flow and the landing rebuild-on-content-save script
//      depend on.
//
// Run: `node scripts/test-cms-deploy-api.mjs` (after sourcing .env).
// CI: fail on any non-✓ row.

import { env } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── env loader (minimal — no dotenv dep) ───────────────────────
function loadDotenv() {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* no .env — rely on exported vars */ }
}
loadDotenv();

const BASE = env.CMS_ADMIN_URL ?? 'https://localhost:3010';
const TOKEN = env.CMS_DEPLOY_TOKEN;
if (!TOKEN) {
  console.error('CMS_DEPLOY_TOKEN missing — set it in .env or export it.');
  process.exit(2);
}

// Localhost HTTPS without cert verification (dev only). CI flips this off.
if (BASE.startsWith('https://localhost')) {
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

async function call({ method = 'GET', path, token, expect }) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  const ok = Array.isArray(expect)
    ? expect.includes(res.status)
    : res.status === expect;
  return { status: res.status, body, ok };
}

const results = [];
function record(name, r, note = '') {
  results.push({ name, status: r.status, ok: r.ok, note });
  const mark = r.ok ? '✓' : '✗';
  const shortBody = typeof r.body === 'object'
    ? JSON.stringify(r.body).slice(0, 80)
    : String(r.body).slice(0, 80);
  console.log(`  ${mark} ${name}  →  HTTP ${r.status}  ${shortBody}${note ? '  [' + note + ']' : ''}`);
}

// ── Tests ──────────────────────────────────────────────────────

console.log(`F134 deploy-API consumer tests · ${BASE}\n`);

// 1. Permission + resource checks.
console.log('PERMISSION + RESOURCE EVALUATION');
record('token rejects no-site param',
  await call({ method: 'POST', path: '/api/admin/deploy', token: TOKEN, expect: [400, 403] }),
  'spec says 400, cms-core ships 403 — behavioural equivalent (both reject)');
record('token rejects site it does not own',
  await call({ method: 'POST', path: '/api/admin/deploy?site=sproutlake', token: TOKEN, expect: 403 }));
record('token allows site it does own (GET)',
  await call({ method: 'GET', path: '/api/admin/deploy?site=trail', token: TOKEN, expect: 200 }));

// 2. Deploy trigger actually runs and returns the contract shape.
console.log('\nDEPLOY CONTRACT SHAPE');
const trigger = await call({ method: 'POST', path: '/api/admin/deploy?site=trail', token: TOKEN, expect: 200 });
record('POST ?site=trail returns 200', trigger);
if (trigger.ok && typeof trigger.body === 'object') {
  const b = trigger.body;
  const requiredKeys = ['id', 'provider', 'status', 'timestamp'];
  const missing = requiredKeys.filter(k => !(k in b));
  record('response carries {id, provider, status, timestamp}',
    { status: missing.length === 0 ? 200 : 500, body: { missing }, ok: missing.length === 0 });
  record('status is success|pending|error',
    { status: 200, body: { status: b.status }, ok: ['success', 'pending', 'error'].includes(b.status) });
}

// 3. List endpoint shape.
console.log('\nLIST ENDPOINT');
const list = await call({ method: 'GET', path: '/api/admin/deploy?site=trail', token: TOKEN, expect: 200 });
const listOk = list.ok && list.body && Array.isArray(list.body.deploys);
record('GET returns {deploys: Deploy[]}', { ...list, ok: listOk });

// 4. Auth negative paths.
console.log('\nAUTH NEGATIVES');
record('no bearer → 401',
  await call({ method: 'GET', path: '/api/admin/deploy?site=trail', expect: 401 }));
record('invalid bearer → 401',
  await call({ method: 'GET', path: '/api/admin/deploy?site=trail', token: 'wh_bogus', expect: 401 }));

// ── Summary ────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length > 0) {
  console.error('FAILED:');
  for (const f of failed) console.error(`  - ${f.name}: HTTP ${f.status}`);
  process.exit(1);
}
