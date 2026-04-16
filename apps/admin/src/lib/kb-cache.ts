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

export function useKb(kbId: string): KnowledgeBase | null {
  const [kb, setKb] = useState<KnowledgeBase | null>(
    cache?.find((k) => k.id === kbId) ?? null,
  );
  useEffect(() => {
    if (!kbId) return;
    let cancelled = false;
    ensureKbs().then((list) => {
      if (cancelled) return;
      setKb(list.find((k) => k.id === kbId) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [kbId]);
  return kb;
}
