/**
 * F94 — Pathname → ambient RouteKey. Each top-level admin tab gets its own
 * loop. Anything outside the named tabs (glossary, neuron-editor permalinks,
 * not-found) falls back to `idle`. Root `/` is `landing` per Christian:
 * home == landing.
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
  if (pathname === '/' || pathname === '') return 'landing';
  return 'idle';
}
