/**
 * F94 — Subscribes to engine SSE events and fires a thinking cue when the
 * engine is doing meaningful work. Renders nothing — pure side-effects.
 *
 * Event selection:
 *  - `ingest_started` / `ingest_completed` / `ingest_failed` — pipeline
 *    work (PDF extract, vision, markdown, etc.)
 *  - `candidate_created` — engine produced a new queue candidate
 *    (chat-save, lint, ingest-summary)
 *  - `candidate_resolved` — curator OR auto-policy committed an action
 *    (covers approve, retire, flag, auto-link, etc.). Emitted alone for
 *    rich effects; emitted alongside `candidate_approved` for plain
 *    approves — we only listen to `candidate_resolved` so a bulk approve
 *    doesn't double-fire.
 *  - `kb_created` — a new Trail was provisioned (rare event, satisfying
 *    audible cue for a "real" milestone)
 *
 * The throttle inside `playThinking()` (800 ms) absorbs bulk-bursts so
 * 22 candidate_resolved frames in 100 ms still produce a single cue.
 */
import { useEffect } from 'preact/hooks';
import { useEvents } from '../lib/event-stream';
import { initThinking, playThinking } from '../lib/thinking-player';

export function ThinkingSubscriber() {
  useEffect(() => initThinking(), []);

  useEvents((e) => {
    switch (e.type) {
      case 'ingest_started':
      case 'ingest_completed':
      case 'ingest_failed':
      case 'candidate_created':
      case 'candidate_resolved':
      case 'kb_created':
        playThinking();
        return;
      default:
        // candidate_approved is intentionally excluded — see file header.
        return;
    }
  });

  return null;
}
