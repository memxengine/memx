/**
 * Glossary data + hooks for the admin.
 *
 * Fetched once per app boot (small, stable, bilingual), memoised in a
 * module singleton so every component that calls `useGlossary()` shares
 * the same fetch. The singleton also survives Vite HMR via globalThis,
 * same pattern the event-stream bus uses.
 */
import { useEffect, useState } from 'preact/hooks';
import type { BilingualText } from '@trail/shared';
import { api } from '../api';

export interface GlossaryTerm {
  id: string;
  label: BilingualText;
  definition: BilingualText;
  relatedTerms?: string[];
}

export interface Glossary {
  version: number;
  terms: GlossaryTerm[];
}

interface Cache {
  data: Glossary | null;
  inFlight: Promise<Glossary> | null;
}

const globalKey = '__trailGlossary__' as const;
const globalAny = globalThis as unknown as { [globalKey]?: Cache };
const cache: Cache = globalAny[globalKey] ?? (globalAny[globalKey] = { data: null, inFlight: null });

function fetchGlossary(): Promise<Glossary> {
  if (cache.data) return Promise.resolve(cache.data);
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = api<Glossary>('/api/v1/glossary')
    .then((g) => {
      cache.data = g;
      cache.inFlight = null;
      return g;
    })
    .catch((err) => {
      cache.inFlight = null;
      throw err;
    });
  return cache.inFlight;
}

/**
 * Returns the glossary (all terms) once fetched. Null during the initial
 * fetch so callers can render a skeleton; errors surface as null too —
 * the consumer sees "no tooltip" rather than a toast, which is the
 * right degradation for a definitional aid.
 */
export function useGlossary(): Glossary | null {
  const [g, setG] = useState<Glossary | null>(cache.data);
  useEffect(() => {
    if (g) return;
    let cancelled = false;
    fetchGlossary()
      .then((data) => {
        if (!cancelled) setG(data);
      })
      .catch(() => {
        // Silent — consumers treat null as "no glossary" and fall back.
      });
    return () => {
      cancelled = true;
    };
  }, [g]);
  return g;
}
