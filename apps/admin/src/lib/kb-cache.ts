/**
 * Module-level cache of the KB list. Every per-KB panel needs to show the
 * current Trail's name somewhere, and hitting `/knowledge-bases` from every
 * panel mount is wasteful. The list is small, rarely changes mid-session,
 * and all panels share one cache keyed by kbId.
 */
import { useEffect, useState } from 'preact/hooks';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases } from '../api';

let inflight: Promise<KnowledgeBase[]> | null = null;
let cache: KnowledgeBase[] | null = null;

/**
 * Synchronous peek at the module-level cache. Returns null until
 * `ensureKbs()` has resolved at least once this session. Used by code
 * paths that want the cache if it's warm but can't block on a fetch
 * (e.g. markdown rendering during a synchronous render-pass).
 */
export function peekKbs(): KnowledgeBase[] | null {
  return cache;
}

/**
 * Route params from /kb/:kbId/... can carry either a UUID or a slug
 * (F135 slug-based routing). Every panel that resolves a KB from the
 * URL param should match on BOTH so settings, nav, etc. don't freeze
 * on the "no match" path when visited via slug.
 */
export function matchKb(
  list: KnowledgeBase[],
  kbIdOrSlug: string,
): KnowledgeBase | null {
  if (!kbIdOrSlug) return null;
  return list.find((k) => k.id === kbIdOrSlug || k.slug === kbIdOrSlug) ?? null;
}

export function ensureKbs(): Promise<KnowledgeBase[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = listKnowledgeBases().then((list) => {
      cache = list;
      inflight = null;
      return list;
    });
  }
  return inflight;
}

/**
 * Drop the module-level cache. Call this when a KB is created/updated so
 * the next `ensureKbs()` fetches a fresh list — otherwise `useKb(newId)`
 * would return null (id not in the old cache) until a hard refresh.
 */
export function invalidateKbs(): void {
  cache = null;
  inflight = null;
}

export function useKb(kbId: string): KnowledgeBase | null {
  const [kb, setKb] = useState<KnowledgeBase | null>(
    kbId && cache ? matchKb(cache, kbId) : null,
  );
  useEffect(() => {
    // Clear state when navigating away from any KB — otherwise the last
    // viewed Trail name would persist on /, and the App-level document
    // title effect would show "trail: <previous kb>" on the All Trails page.
    if (!kbId) {
      setKb(null);
      return;
    }
    let cancelled = false;
    ensureKbs().then((list) => {
      if (cancelled) return;
      setKb(matchKb(list, kbId));
    });
    return () => {
      cancelled = true;
    };
  }, [kbId]);
  return kb;
}
