/**
 * F20 — line-level diff shared between any surface that needs to show
 * "what will change if this candidate is approved?" Pure function, no
 * DOM / Preact / anything — the admin's DiffView component handles
 * rendering on top.
 *
 * Algorithm: classic LCS dynamic-programming. Good enough for Neuron
 * bodies under ~2000 lines (which is every real Neuron). Worst-case
 * O(m*n) time / O(m*n) memory — a 500-line diff takes ~250KB of int
 * scratch and <10ms on M1. For larger inputs (imported books,
 * generated transcripts), switch to Myers later — the function shape
 * stays identical.
 */

export type DiffLineKind = 'unchanged' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number on the side this line belongs to (before or after).
   *  For 'removed', this is the before-side number; for 'added', after-side. */
  lineNumber: number;
}

export interface DiffResult {
  /** Inline sequence — removed and added lines interleaved at their diff
   *  positions. Render this for unified/inline views. */
  inline: DiffLine[];
  /** Before-side rows: unchanged + removed, aligned with `after`. */
  before: DiffLine[];
  /** After-side rows: unchanged + added, aligned with `before`. */
  after: DiffLine[];
  stats: {
    added: number;
    removed: number;
    unchanged: number;
  };
}

/**
 * Compute line-by-line diff between two strings. Empty input on either
 * side is valid (all-added or all-removed).
 *
 * The line-alignment logic inserts blank placeholders on the opposite
 * side so a caller rendering a two-column view can just render
 * `before[i]` and `after[i]` side-by-side without computing alignment.
 * `{ kind: 'unchanged', text: '', lineNumber: 0 }` means "nothing here
 * on this side for this row" and admin's DiffView styles it as a
 * muted gap.
 */
export function computeLineDiff(beforeText: string, afterText: string): DiffResult {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');

  const ops = lcsDiff(beforeLines, afterLines);

  const inline: DiffLine[] = [];
  const before: DiffLine[] = [];
  const after: DiffLine[] = [];
  const GAP: DiffLine = { kind: 'unchanged', text: '', lineNumber: 0 };

  let bNum = 0;
  let aNum = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const op of ops) {
    if (op.kind === 'unchanged') {
      bNum++;
      aNum++;
      const row: DiffLine = { kind: 'unchanged', text: op.text, lineNumber: bNum };
      inline.push(row);
      before.push({ ...row, lineNumber: bNum });
      after.push({ ...row, lineNumber: aNum });
      unchanged++;
    } else if (op.kind === 'removed') {
      bNum++;
      const row: DiffLine = { kind: 'removed', text: op.text, lineNumber: bNum };
      inline.push(row);
      before.push(row);
      after.push(GAP);
      removed++;
    } else {
      aNum++;
      const row: DiffLine = { kind: 'added', text: op.text, lineNumber: aNum };
      inline.push(row);
      before.push(GAP);
      after.push(row);
      added++;
    }
  }

  return { inline, before, after, stats: { added, removed, unchanged } };
}

// ── internal ────────────────────────────────────────────────────────────

interface DiffOp {
  kind: DiffLineKind;
  text: string;
}

/**
 * LCS-based diff returning ordered operations. Same algorithm as the
 * classic "diff" utility with the tie-break rule: when both a removal
 * and an addition are equally optimal, emit the removal first so
 * "replace" shows the deletion on the before-side above the addition
 * on the after-side (matches curator intuition).
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (ai === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack from (m, n) to (0, 0).
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'unchanged', text: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ kind: 'added', text: b[j - 1]! });
      j--;
    } else {
      ops.push({ kind: 'removed', text: a[i - 1]! });
      i--;
    }
  }
  return ops.reverse();
}
