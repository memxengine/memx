/**
 * Connector registry — one source of truth for every ingestion pathway
 * into Trail. Matches the landing-page promise (trailmem.com):
 *
 *   "Extensible Ingestion — Connectors roadmap: Slack, Discord, Notion,
 *    GitHub, Linear. Today: Markdown and PDF upload, plus native MCP
 *    for Claude Code and Cursor."
 *
 * Every candidate carries `metadata.connector: ConnectorId` that flags
 * which pathway emitted it. The admin Queue filters on it, the Neuron
 * reader shows "Created via" attribution, and F95 analytics will slice
 * on it later.
 *
 * Adding a new connector:
 *   1. Add an entry below with a live/roadmap status.
 *   2. (Optional) Add a locale label override in the admin's i18n dict.
 *   3. At the write site that actually emits candidates, set
 *      `metadata.connector` to the id. If none is set, core's
 *      `normalizeConnector()` falls back to heuristics based on `kind`.
 *
 * No schema migration is needed — connector lives inside the existing
 * `queue_candidates.metadata` JSON column. Keep ids as stable snake-or-
 * colon-separated slugs (`mcp:claude-code`, not "Claude Code MCP") so
 * SQL filters on metadata LIKE '%"connector":"<id>"%' are predictable.
 */

export type ConnectorStatus = 'live' | 'roadmap';

export interface ConnectorDef {
  label: string;
  status: ConnectorStatus;
  /**
   * One-liner for the UI tooltip. Explains where a candidate from this
   * connector came from in Christian-facing prose.
   */
  hint: string;
}

export const CONNECTORS = {
  upload: {
    label: 'Upload',
    status: 'live',
    hint: 'A file dropped on the Sources page — PDF, Markdown, DOCX, and friends. The ingest pipeline compiles Neurons from it.',
  },
  'mcp:claude-code': {
    label: 'Claude Code',
    status: 'live',
    hint: 'A cc session in the terminal used trail MCP to write a Neuron. Set TRAIL_CONNECTOR=mcp:claude-code in the session\'s .mcp.json to identify.',
  },
  'mcp:cursor': {
    label: 'Cursor',
    status: 'live',
    hint: 'A Cursor editor session used trail MCP. Set TRAIL_CONNECTOR=mcp:cursor in the Cursor MCP config.',
  },
  mcp: {
    label: 'MCP (other)',
    status: 'live',
    hint: 'An MCP client that did not identify itself via TRAIL_CONNECTOR env — generic fallback.',
  },
  buddy: {
    label: 'Buddy',
    status: 'live',
    hint: 'A cc-session artifact piped in by buddy\'s trail_save tool (F39). Session reasoning distilled into a reusable Neuron.',
  },
  chat: {
    label: 'Chat',
    status: 'live',
    hint: 'A saved chat answer — the curator asked Trail a question and pressed "save as Neuron".',
  },
  lint: {
    label: 'Lint',
    status: 'live',
    hint: 'A lint detector finding — orphan Neuron, stale page, contradiction, or gap.',
  },
  curator: {
    label: 'Curator',
    status: 'live',
    hint: 'A direct edit by a curator via the Neuron editor (F91).',
  },
  api: {
    label: 'API',
    status: 'live',
    hint: 'A bearer-authed POST to /api/v1/queue/candidates from a script, CI hook, or generic webhook.',
  },
  slack: { label: 'Slack',   status: 'roadmap', hint: 'Not yet wired — planned ingest of channel messages into Trail.' },
  discord: { label: 'Discord', status: 'roadmap', hint: 'Not yet wired — planned ingest of server messages into Trail.' },
  notion: { label: 'Notion',  status: 'roadmap', hint: 'Not yet wired — planned ingest of Notion pages into Trail.' },
  github: { label: 'GitHub',  status: 'roadmap', hint: 'Not yet wired — planned ingest of issues, PRs, and discussions.' },
  linear: { label: 'Linear',  status: 'roadmap', hint: 'Not yet wired — planned ingest of tickets and comments.' },
} as const satisfies Record<string, ConnectorDef>;

export type ConnectorId = keyof typeof CONNECTORS;

/** The ids of every connector that can currently emit a candidate. */
export const LIVE_CONNECTORS: readonly ConnectorId[] = Object.entries(CONNECTORS)
  .filter(([, def]) => def.status === 'live')
  .map(([id]) => id as ConnectorId);

/** The roadmap ids — shown greyed-out in the filter UI. */
export const ROADMAP_CONNECTORS: readonly ConnectorId[] = Object.entries(CONNECTORS)
  .filter(([, def]) => def.status === 'roadmap')
  .map(([id]) => id as ConnectorId);

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && value in CONNECTORS;
}

/**
 * F98 — connectors whose originating content lives OUTSIDE Trail's
 * Source uploads: cc sessions (buddy), MCP tool calls (Claude Code,
 * Cursor), chat-saved answers, generic bearer-POSTs.
 *
 * Neurons produced via these pathways don't cite uploaded documents by
 * design — their "source" is a session transcript, a git commit, a
 * conversation. Validation logic that expects Source-citations (most
 * notably orphan-lint) must skip them rather than treat "no
 * document_references rows" as an anomaly.
 */
export const EXTERNAL_CONNECTORS: readonly ConnectorId[] = [
  'buddy',
  'mcp',
  'mcp:claude-code',
  'mcp:cursor',
  'chat',
  'api',
];

export function isExternalConnector(id: string | null | undefined): boolean {
  return !!id && (EXTERNAL_CONNECTORS as readonly string[]).includes(id);
}
