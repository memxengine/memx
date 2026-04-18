/**
 * F19 axis 3 / F32.2 — contradiction detection.
 *
 * Pure LLM-agnostic checker. Takes a newly-committed Neuron + a handful of
 * candidates it might contradict, plus a caller-supplied LLM function, and
 * returns LintFindings the caller can emit via createCandidate.
 *
 * Why the pure split: core stays dependency-free. The engine (apps/server)
 * wires the real Anthropic API. A CLI or test can wire a stub LLM that
 * returns deterministic results. Same contradiction logic, different LLM.
 */
import type { CandidateAction } from '@trail/shared';
import type { LintFinding } from './types.js';

export interface ContradictionCandidate {
  documentId: string;
  filename: string;
  title: string | null;
  content: string;
  version: number;
}

export interface LlmContradictionResult {
  contradicts: boolean;
  /** Short quote from the new Neuron that clashes with the existing one. */
  newQuote?: string;
  /** Short quote from the existing Neuron that clashes. */
  existingQuote?: string;
  /** Plain-English one-sentence summary of the conflict. */
  summary?: string;
}

export type ContradictionChecker = (
  newContent: string,
  existingContent: string,
) => Promise<LlmContradictionResult>;

export interface NewNeuron {
  documentId: string;
  filename: string;
  title: string | null;
  content: string;
  version: number;
}

/**
 * Run the checker against each candidate. Returns a finding per positive
 * hit. Confidence is fixed at 0.75 — below the F19 auto-approve threshold
 * of 0.8, so contradiction-alert candidates always land pending for a
 * human to decide which side is correct.
 */
export async function detectContradictions(
  neuron: NewNeuron,
  candidates: ContradictionCandidate[],
  check: ContradictionChecker,
): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  for (const cand of candidates) {
    // Skip self — a Neuron can't contradict itself.
    if (cand.documentId === neuron.documentId) continue;

    let result: LlmContradictionResult;
    try {
      result = await check(neuron.content, cand.content);
    } catch {
      // An LLM error here means "we don't know" — keep silent. The next
      // candidate_approved on this Neuron (if anyone re-edits it) will
      // retry. We don't want transient API failures to spam the queue
      // with "maybe contradiction?" noise.
      continue;
    }

    if (!result.contradicts) continue;

    // Version-aware fingerprint: both Neurons' versions go in, so any
    // rewrite of either page creates a fresh fingerprint. A curator who
    // dismissed last week's contradiction still gets re-prompted if
    // either side was edited since — the premise may have changed.
    // Sort by docId so the pair (A, B) and (B, A) produce the same id.
    const [firstId, secondId] = [neuron.documentId, cand.documentId].sort();
    const firstVersion = firstId === neuron.documentId ? neuron.version : cand.version;
    const secondVersion = firstId === neuron.documentId ? cand.version : neuron.version;
    findings.push({
      kind: 'contradiction-alert',
      title: `Contradiction: ${labelOf(neuron)} vs. ${labelOf(cand)}`,
      content: buildContent(neuron, cand, result),
      fingerprint: `lint:contradiction:${firstId}:v${firstVersion}:${secondId}:v${secondVersion}`,
      confidence: 0.75,
      details: {
        newDocumentId: neuron.documentId,
        existingDocumentId: cand.documentId,
        summary: result.summary ?? null,
        newQuote: result.newQuote ?? null,
        existingQuote: result.existingQuote ?? null,
      },
      actions: buildContradictionActions(neuron, cand),
    });
  }

  return findings;
}

/**
 * Build the four curator actions offered on a contradiction-alert:
 *
 *   - retire-a — archive the newly-committed Neuron (it's the one that's
 *     wrong). Semantics: the existing Neuron was correct; this new one
 *     contradicts it without new evidence.
 *   - retire-b — archive the existing Neuron. Semantics: the new Neuron's
 *     claim supersedes; the old one was outdated or wrong.
 *   - reconcile — "I'll edit both manually to not conflict." No mutation
 *     — just marks the candidate as handled. Effect: acknowledge.
 *   - dismiss — false positive, this isn't actually a contradiction.
 *     Effect: reject.
 *
 * Labels and explanations are in English; the admin's translation service
 * lazy-fills Danish (and other locales) on first view and persists the
 * translations back onto the candidate. The strings read as lay language —
 * no jargon like "Neuron" where "page" conveys the same meaning to a
 * first-time user, but we keep "Neuron" here because the admin is aimed
 * at curators who've internalised the term.
 */
function buildContradictionActions(
  neuron: NewNeuron,
  cand: ContradictionCandidate,
): CandidateAction[] {
  const labelNew = labelOf(neuron);
  const labelExisting = labelOf(cand);
  // [[filename|Display]] — the admin's explanation renderer turns this
  // into a real clickable anchor pointing at the Neuron reader, so the
  // curator can jump to the page without leaving the queue.
  const linkNew = `[[${stripExt(neuron.filename)}|${labelNew}]]`;
  const linkExisting = `[[${stripExt(cand.filename)}|${labelExisting}]]`;
  return [
    {
      id: 'retire-a',
      effect: 'retire-neuron',
      args: { documentId: neuron.documentId },
      label: { en: 'Retire new' },
      explanation: {
        en:
          `Archive ${linkNew} and keep ${linkExisting}. Pick this if the existing page was ` +
          `already correct and the new one introduced a wrong claim. The page will disappear ` +
          `from the Neurons list; every link pointing to it becomes a broken link until you ` +
          `clean them up. Nothing else changes.`,
      },
    },
    {
      id: 'retire-b',
      effect: 'retire-neuron',
      args: { documentId: cand.documentId },
      label: { en: 'Retire existing' },
      explanation: {
        en:
          `Archive ${linkExisting} and keep ${linkNew}. Pick this if the new claim supersedes ` +
          `the existing one — a better source, a correction, a newer version. The existing ` +
          `page disappears from the Neurons list; any link pointing to it becomes a broken ` +
          `link until you clean them up.`,
      },
    },
    {
      id: 'reconcile',
      effect: 'acknowledge',
      label: { en: 'Reconcile manually' },
      explanation: {
        en:
          `Close this alert and fix the conflict yourself. Neither page is archived — open ` +
          `${linkNew} and ${linkExisting}, then edit them so they agree. Pick this when the ` +
          `truth is somewhere in between and both pages need nuance.`,
      },
    },
    {
      id: 'dismiss',
      effect: 'reject',
      label: { en: 'Dismiss as false positive' },
      explanation: {
        en:
          `Discard this alert. Pick this when the two passages don't actually contradict — ` +
          `the detector was confused by different phrasing or a narrower/wider focus. ` +
          `Nothing changes in your Trail. The alert won't re-appear unless the pages are ` +
          `rewritten.`,
      },
    },
  ];
}

function stripExt(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function labelOf(n: { title: string | null; filename: string }): string {
  return n.title ?? n.filename;
}

function buildContent(
  neuron: NewNeuron,
  cand: ContradictionCandidate,
  r: LlmContradictionResult,
): string {
  const parts: string[] = [];
  parts.push(`# Contradiction: ${labelOf(neuron)} vs. ${labelOf(cand)}`);
  parts.push('');
  if (r.summary) {
    parts.push(r.summary);
    parts.push('');
  }
  parts.push(`A claim in **${labelOf(neuron)}** appears to conflict with a claim in **${labelOf(cand)}**. A curator should read both passages and either (a) reconcile the two Neurons, (b) retire one, or (c) flag the source that gave us the conflicting claim.`);
  parts.push('');
  if (r.newQuote) {
    parts.push(`> From \`${neuron.filename}\`:\n>`);
    parts.push(quoteBlock(r.newQuote));
    parts.push('');
  }
  if (r.existingQuote) {
    parts.push(`> From \`${cand.filename}\`:\n>`);
    parts.push(quoteBlock(r.existingQuote));
  }
  return parts.join('\n');
}

function quoteBlock(s: string): string {
  return s
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
