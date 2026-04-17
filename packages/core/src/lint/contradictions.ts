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
import type { LintFinding } from './types.js';

export interface ContradictionCandidate {
  documentId: string;
  filename: string;
  title: string | null;
  content: string;
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

    findings.push({
      kind: 'contradiction-alert',
      title: `Contradiction: ${labelOf(neuron)} vs. ${labelOf(cand)}`,
      content: buildContent(neuron, cand, result),
      fingerprint: `lint:contradiction:${[neuron.documentId, cand.documentId].sort().join(':')}`,
      confidence: 0.75,
      details: {
        newDocumentId: neuron.documentId,
        existingDocumentId: cand.documentId,
        summary: result.summary ?? null,
        newQuote: result.newQuote ?? null,
        existingQuote: result.existingQuote ?? null,
      },
    });
  }

  return findings;
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
