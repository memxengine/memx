/**
 * F151 — FX rate service for UI-side currency conversion.
 *
 * Exposes USD→DKK (and other pairs if needed later) via a cached
 * fetch from Frankfurter, which serves the ECB daily reference rate.
 * No API key, CC-BY licensed data, rate-refreshed once per working
 * day at 16:00 CET.
 *
 * Cache: 4h TTL in-process. ECB updates daily so 4h is tight enough
 * that curators see ≤0.1% drift vs. spot. On fetch failure we fall
 * back to a hardcoded ballpark (6.85 DKK/USD 2026-04-24) AND flag
 * `stale: true` in the response so the UI can warn.
 *
 * Only ingest-cost-display uses this today; the number of requests
 * is tiny (one per Cost-tab mount).
 */

interface RateEntry {
  rate: number;
  fetchedAt: string;
  stale: boolean;
  expiresAt: number;
}

const TTL_MS = 4 * 60 * 60 * 1000;
const cache = new Map<string, RateEntry>();

// Ballpark USD→DKK rate as of 2026-04-24 — used when Frankfurter is
// unreachable. Accurate to ~5% which is fine for a cost-display where
// a curator wants an order-of-magnitude sense, not an accounting
// figure. The `stale: true` flag tells the UI to show "~" prefix.
const FALLBACK_RATES: Record<string, Record<string, number>> = {
  USD: { DKK: 6.85, EUR: 0.92, SEK: 10.5, NOK: 10.8 },
};

export interface FxRate {
  from: string;
  to: string;
  rate: number;
  fetchedAt: string;
  stale: boolean;
}

export async function getFxRate(from: string, to: string): Promise<FxRate> {
  const key = `${from}:${to}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { from, to, rate: hit.rate, fetchedAt: hit.fetchedAt, stale: hit.stale };
  }

  // Frankfurter API — ECB reference rate, free, no key required.
  const url = `https://api.frankfurter.dev/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'trail-ingest-fx/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`frankfurter ${response.status}`);
    const data = (await response.json()) as {
      amount: number;
      base: string;
      date: string;
      rates: Record<string, number>;
    };
    const rate = data.rates[to];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`unexpected rate payload`);
    }
    const entry: RateEntry = {
      rate,
      fetchedAt: data.date,
      stale: false,
      expiresAt: Date.now() + TTL_MS,
    };
    cache.set(key, entry);
    return { from, to, rate: entry.rate, fetchedAt: entry.fetchedAt, stale: false };
  } catch (err) {
    // Fall back to ballpark rate. Cache with a SHORT TTL so we retry
    // live-fetch sooner rather than serving stale forever.
    const fallback = FALLBACK_RATES[from]?.[to];
    if (!fallback) {
      throw new Error(
        `FX rate ${from}→${to} unavailable (live fetch failed: ${err instanceof Error ? err.message : String(err)}; no fallback configured)`,
      );
    }
    const entry: RateEntry = {
      rate: fallback,
      fetchedAt: new Date().toISOString().slice(0, 10),
      stale: true,
      expiresAt: Date.now() + 15 * 60 * 1000, // retry live in 15 min
    };
    cache.set(key, entry);
    return { from, to, rate: fallback, fetchedAt: entry.fetchedAt, stale: true };
  }
}
