/**
 * F151 — locale-aware cost display.
 *
 * Trail stores cost as USD cents on ingest_jobs (OpenRouter bills in
 * USD; Anthropic in USD; Max Plan emits 0). The cost dashboard shows
 * those numbers to the curator — but for a Danish-locale curator, USD
 * cents are cognitively expensive ("how much is 3¢? is that cheap?")
 * while DKK is second-nature.
 *
 * Rule: when the active locale is 'da', display DKK; otherwise USD.
 * Rate comes from ECB/Frankfurter via `getFxRate('USD','DKK')`, cached
 * at the backend for 4h. `stale:true` rate (fallback when live-fetch
 * fails) renders with `~` prefix so the curator knows it's approximate.
 *
 * Zero-cost cases keep a separate label so "gratis (Max)" isn't shown
 * as "0 kr" — makes the Max Plan benefit obvious at a glance.
 */

import type { Locale } from './i18n';
import type { FxRate } from '../api';

/**
 * Format USD cents as a locale-appropriate string. When fxRate is
 * null OR locale isn't 'da', falls back to the USD cents / dollars
 * formatter.
 */
export function formatCostForLocale(
  cents: number,
  locale: Locale,
  fxRate: FxRate | null,
): string {
  // Locale === 'da' AND we have a DKK rate → render in DKK.
  if (locale === 'da' && fxRate && fxRate.to === 'DKK') {
    return formatDkk(cents, fxRate);
  }
  // Default: USD cents / dollars.
  return formatUsd(cents);
}

// Currency symbols placed BEFORE the number per Christian's convention
// (2026-04-24): `$ 3.50`, `¢ 3`, `kr 0,21`. Matches Danish + most
// European conventions and keeps the eye on the currency first.
function formatUsd(cents: number): string {
  if (cents === 0) return '¢ 0';
  // Fractional cents (e.g. avg-per-Neuron = 0.09): keep up to 2 decimals.
  if (cents < 1) return `¢ ${cents.toFixed(2)}`;
  if (cents < 100) {
    return cents % 1 === 0 ? `¢ ${cents}` : `¢ ${cents.toFixed(1)}`;
  }
  return `$ ${(cents / 100).toFixed(2)}`;
}

function formatDkk(cents: number, fx: FxRate): string {
  if (cents === 0) return 'kr 0';
  // cents are USD cents → convert to DKK (cents / 100 × rate).
  const dkk = (cents / 100) * fx.rate;
  const prefix = fx.stale ? '~' : '';
  if (dkk < 0.01) {
    // Sub-øre — show 4 decimals so avg-per-Neuron (e.g. 0.09¢ ≈ 0.006 kr)
    // doesn't collapse to "kr 0.00".
    return `${prefix}kr ${dkk.toFixed(4)}`;
  }
  if (dkk < 100) {
    // 1 øre–99 kr → 2 decimals so 3¢ reads "≈kr 0.21" not "kr 0"
    return `${prefix}kr ${dkk.toFixed(2)}`;
  }
  // 100+ kr → whole kroner
  return `${prefix}kr ${Math.round(dkk)}`;
}

/**
 * Dedicated "free (Max Plan)" label. Used when backend='claude-cli'
 * && cents=0 to distinguish "we paid 0" from "we don't know cost".
 */
export function maxPlanLabel(locale: Locale): string {
  return locale === 'da' ? 'gratis (Max)' : 'free (Max)';
}
