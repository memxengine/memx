/**
 * F92 — LLM tag-suggester for chat-save candidates.
 *
 * When a curator saves a chat answer as a Neuron, the resulting
 * queue candidate has a drafted title + body but no tags — the chat
 * UI doesn't ask the curator to type them. This service runs a
 * short LLM pass to propose 0-5 tags drawn from the existing KB
 * vocabulary (to encourage consolidation) + new tags when the topic
 * genuinely isn't covered yet.
 *
 * Disabled by setting TRAIL_AUTO_TAG_CHAT_SAVES=0. Default on.
 *
 * The suggested tags are written into the candidate's `metadata.tags`
 * (as a comma-separated string) so approveCreate / approveUpdate
 * commit them to documents.tags via the same path a curator-authored
 * tag list uses.
 */

import type { TrailDatabase } from '@trail/db';
import { canonicaliseTagString, parseTags } from '@trail/shared';
import { spawnClaude, extractAssistantText } from './claude.js';
import { listKbTags } from './tag-aggregate.js';

const MODEL = process.env.TAG_SUGGEST_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.TAG_SUGGEST_TIMEOUT_MS ?? 20_000);
const MAX_TAGS = 5;

export function isAutoTagEnabled(): boolean {
  return (process.env.TRAIL_AUTO_TAG_CHAT_SAVES ?? '1') !== '0';
}

/**
 * Ask the LLM for up to 5 tags that would help a curator find this
 * Neuron later. Returns a canonicalised comma-separated string
 * suitable for `documents.tags` / `metadata.tags`, or null if no
 * useful tag was produced or the LLM call failed.
 */
export async function suggestTagsForNeuron(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  input: { title: string; content: string },
): Promise<string | null> {
  if (!isAutoTagEnabled()) return null;
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title && !content) return null;

  let existingTags: string[] = [];
  try {
    const aggregate = await listKbTags(trail, tenantId, kbId);
    existingTags = aggregate.slice(0, 40).map((t) => t.tag);
  } catch {
    // Aggregate failure isn't fatal — the LLM can still propose
    // fresh tags without the existing vocabulary hint. Log-and-continue.
  }

  const prompt = buildPrompt(title, content, existingTags);
  try {
    const raw = await spawnClaude(
      [
        '-p',
        prompt,
        '--model',
        MODEL,
        '--output-format',
        'json',
        '--max-turns',
        '1',
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    const text = extractAssistantText(raw).trim();
    return parseSuggestion(text);
  } catch (err) {
    console.error('[tag-suggester] LLM call failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function buildPrompt(title: string, content: string, existing: string[]): string {
  const existingBlock = existing.length > 0
    ? `\n\n## Existing tags in this knowledge base\n(Prefer reusing these when they fit; propose new ones only when the topic genuinely isn't covered.)\n${existing.map((t) => `- ${t}`).join('\n')}`
    : "\n\n## Existing tags in this knowledge base\n(No tags in the KB yet — you're establishing the vocabulary.)";

  const contentExcerpt = content.length > 4000 ? content.slice(0, 4000) + '\n\n[truncated]' : content;

  return `You are helping a curator tag a Neuron in a Trail knowledge base.

## Neuron
**Title:** ${title || '(untitled)'}

${contentExcerpt}${existingBlock}

## Your task
Return 0-5 tags (existing or new) that would help a curator find this Neuron later. Format rules:
- comma-separated, lowercase, kebab-case
- only [a-z0-9-], no punctuation, no unicode, max 20 chars each
- return an empty string if no tag is obviously useful

Reply with ONLY the comma-separated tags — no prose, no quotes, no explanation. Empty output means "no tags".`;
}

/**
 * Pull a comma-separated tag string out of the LLM's reply and run
 * it through the canonicaliser. Null when nothing usable came back.
 */
function parseSuggestion(text: string): string | null {
  if (!text) return null;
  // Strip common LLM boilerplate / markdown. The prompt asks for raw
  // CSV but LLMs sometimes wrap in code fences or bullet points.
  const cleaned = text
    .replace(/^```[a-z]*\n?/gi, '')
    .replace(/\n?```$/g, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();

  // If the response came back as bullet-list-per-line, flatten to CSV.
  const csv = cleaned.includes(',') ? cleaned : cleaned.split(/\r?\n/).join(',');

  const canonical = canonicaliseTagString(csv);
  if (!canonical) return null;
  // Hard cap on count — the LLM sometimes ignores the max.
  const tags = parseTags(canonical).slice(0, MAX_TAGS);
  return tags.length === 0 ? null : tags.join(', ');
}
