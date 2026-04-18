/**
 * F94 — Pathname → ambient RouteKey. Each top-level admin tab gets its own
 * loop. Root `/` and anything outside the named tabs (glossary, not-found,
 * etc.) falls back to `idle` — Christian's call: a single neutral wash for
 * everything that isn't a working surface.
 *
 * `landing.opus` stays on disk for a possible future landing-site mount
 * (F34) but no admin path currently routes to it.
 *
 * The Neuron editor lives at /kb/<id>/neurons/<slug>?edit=1 — same path as
 * the reader, only `?edit=1` differs. Editor and reader therefore share the
 * `neurons` loop; the editor session confirmed this is desired.
 */
import type { RouteKey } from './ambient-store';

export function routeFromPath(pathname: string): RouteKey {
  if (/^\/kb\/[^/]+\/neurons/.test(pathname)) return 'neurons';
  if (/^\/kb\/[^/]+\/queue/.test(pathname)) return 'queue';
  if (/^\/kb\/[^/]+\/chat/.test(pathname)) return 'chat';
  if (/^\/kb\/[^/]+\/search/.test(pathname)) return 'search';
  if (/^\/kb\/[^/]+\/sources/.test(pathname)) return 'sources';
  return 'idle';
}
