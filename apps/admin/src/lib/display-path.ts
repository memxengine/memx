/**
 * The engine stores Neuron directories under `/wiki/...` (its MCP tools,
 * ingest prompts, and legacy data all speak that convention). Admin users
 * see the brand name "Neurons" and should never be shown the internal
 * `/wiki/` prefix.
 *
 * Display-only transform: `/wiki/concepts/` → `/neurons/concepts/`. We
 * leave storage alone because changing it would force a coordinated
 * rewrite of every engine prompt, MCP schema, and client that already
 * speaks the old namespace.
 */
export function displayPath(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/^\/wiki(\/|$)/, '/neurons$1');
}
