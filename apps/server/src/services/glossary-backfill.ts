/**
 * F102 retroactive backfill — one-shot per-KB glossary population.
 *
 * The F102 compile-prompt step 7 only fires during ingest of NEW Sources.
 * KBs with 75+ existing Sources (Sanne, trail-dev, …) would never see
 * their glossary filled in until someone uploaded a fresh PDF. Users
 * (correctly) expect the feature to work RIGHT NOW against what's
 * already there.
 *
 * This service fills that gap: for a KB whose glossary.md is still the
 * empty template, read the corpus once and ask Haiku to produce up to
 * 20 DOMAIN-SPECIFIC fagtermer drawn from the Neuron content. One LLM
 * call per KB. Result lands as an `ingest-page-update` candidate that
 * auto-approves via the system actor (same path step-7 uses for the
 * live glossary-update flow, so subscribers fire correctly).
 *
 * Fire-and-forget from the F102 bootstrap so a slow LLM call on 4 KBs
 * doesn't add 40s to engine boot.
 */
import { documents, type TrailDatabase } from '@trail/db';
import { and, asc, eq } from 'drizzle-orm';
import { createCandidate } from '@trail/core';
import { spawnClaude, extractAssistantText } from './claude.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const BACKEND = process.env.TRAIL_GLOSSARY_BACKFILL_BACKEND ?? (ANTHROPIC_API_KEY ? 'api' : 'cli');
const MODEL = process.env.TRAIL_GLOSSARY_BACKFILL_MODEL ?? 'claude-haiku-4-5-20251001';
const CLI_TIMEOUT_MS = Number(process.env.TRAIL_GLOSSARY_BACKFILL_CLI_TIMEOUT_MS ?? 90_000);
const MAX_NEURON_EXCERPT_CHARS = 600;
const MAX_NEURONS_PER_PROMPT = 80;

const GLOSSARY_FILENAME = 'glossary.md';
const GLOSSARY_PATH = '/neurons/';

export interface BackfillKb {
  id: string;
  tenantId: string;
  createdBy: string;
  name: string;
  language: string | null;
}

/**
 * Generate and commit a populated glossary for a single KB. Returns
 * the number of term entries written (0 if the LLM produced nothing
 * or the KB had no Neurons to read from).
 */
export async function backfillGlossaryForKb(
  trail: TrailDatabase,
  kb: BackfillKb,
): Promise<number> {
  // Find the glossary Neuron we'll update. If it doesn't exist yet, the
  // caller hasn't run the seed-or-cleanup pass — bail so we don't
  // create a duplicate write path.
  const glossaryDoc = await trail.db
    .select({ id: documents.id, version: documents.version })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kb.id),
        eq(documents.tenantId, kb.tenantId),
        eq(documents.filename, GLOSSARY_FILENAME),
        eq(documents.path, GLOSSARY_PATH),
        eq(documents.archived, false),
      ),
    )
    .get();

  if (!glossaryDoc) {
    console.warn(`[F102 backfill] KB "${kb.name}" has no glossary.md yet — skipping`);
    return 0;
  }

  // Pull every non-archived, non-hub wiki Neuron as input material. Skip
  // the glossary itself (feeding it back in would be a confusing echo)
  // and the structural hub pages (overview.md, log.md).
  const neurons = await trail.db
    .select({
      filename: documents.filename,
      title: documents.title,
      content: documents.content,
    })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kb.id),
        eq(documents.tenantId, kb.tenantId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
      ),
    )
    .orderBy(asc(documents.filename))
    .all();

  const eligible = neurons
    .filter((n) => n.filename !== GLOSSARY_FILENAME)
    .filter((n) => n.filename !== 'overview.md' && n.filename !== 'log.md');

  if (eligible.length === 0) {
    console.log(`[F102 backfill] KB "${kb.name}" has no content Neurons — leaving glossary empty`);
    return 0;
  }

  const batch = eligible.slice(0, MAX_NEURONS_PER_PROMPT);
  const lang = kb.language === 'da' ? 'da' : 'en';
  const prompt = buildPrompt(kb.name, batch, lang);

  let rawResponse: string;
  try {
    rawResponse = await callLlm(prompt);
  } catch (err) {
    console.error(
      `[F102 backfill] LLM call failed for KB "${kb.name}":`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  const entries = parseEntries(rawResponse);
  if (entries.length === 0) {
    console.log(`[F102 backfill] LLM produced no entries for KB "${kb.name}"`);
    return 0;
  }

  const newContent = buildGlossaryContent(entries, lang);
  await writeGlossaryUpdate(trail, kb, glossaryDoc.id, newContent);
  console.log(`[F102 backfill] KB "${kb.name}": wrote ${entries.length} term entries`);
  return entries.length;
}

interface NeuronExcerpt {
  filename: string;
  title: string | null;
  content: string | null;
}

function buildPrompt(kbName: string, neurons: NeuronExcerpt[], lang: 'en' | 'da'): string {
  const body = neurons
    .map((n) => {
      const heading = n.title || n.filename;
      const snippet = stripFrontmatter(n.content ?? '').slice(0, MAX_NEURON_EXCERPT_CHARS);
      return `### ${heading}\n\n${snippet}`;
    })
    .join('\n\n---\n\n');

  const instruction =
    lang === 'da'
      ? `Du får indholdet af en vidensbase ved navn "${kbName}". Find op til 20 DOMÆNE-SPECIFIKKE fagtermer der optræder i materialet — termer med en defineret betydning som en læser ville slå op i en ordliste. Skriv hver som en markdown-sektion.

Udelad:
- App-terminologi (Neuron, Kilde, Kurator, Trail, Lint, Curation Queue, etc.) — ikke relevant her
- Almindelige ord (patient, behandling, etc. — medmindre de har en meget specifik definition i dette domæne)
- Personnavne og organisationer
- Forbigående omtaler uden definition

Returner UDELUKKENDE gyldig JSON i formatet:

{"entries": [{"term": "Fagterm", "definition": "1-3 sætninger der definerer termen baseret på hvordan den bruges i materialet."}]}

Ingen kommentarer, ingen markdown-fences, ingen andre nøgler.`
      : `You are given the content of a knowledge base called "${kbName}". Find up to 20 DOMAIN-SPECIFIC terms that appear in the material — terms with a defined meaning a reader would look up in a glossary. Write each as a markdown section.

Exclude:
- App-terminology (Neuron, Source, Curator, Trail, Lint, Curation Queue, etc.) — not relevant here
- Common words (patient, treatment, etc. — unless they have a highly specific definition in this domain)
- Person names and organizations
- Passing mentions without a definition

Return ONLY valid JSON in this format:

{"entries": [{"term": "Term", "definition": "1-3 sentences defining the term based on how it is used in the material."}]}

No comments, no markdown fences, no other keys.`;

  return `${instruction}\n\n# Material\n\n${body}`;
}

function stripFrontmatter(s: string): string {
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  if (end === -1) return s;
  return s.slice(end + 4).replace(/^\n+/, '');
}

interface LlmEntry {
  term: string;
  definition: string;
}

function parseEntries(raw: string): LlmEntry[] {
  const text = extractAssistantText(raw).trim();
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(json) as { entries?: LlmEntry[] };
    if (!parsed.entries || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter((e): e is LlmEntry => typeof e?.term === 'string' && typeof e?.definition === 'string')
      .map((e) => ({ term: e.term.trim(), definition: e.definition.trim() }))
      .filter((e) => e.term.length > 0 && e.definition.length > 0);
  } catch {
    return [];
  }
}

function buildGlossaryContent(entries: LlmEntry[], lang: 'en' | 'da'): string {
  const today = new Date().toISOString().slice(0, 10);
  const header =
    lang === 'da'
      ? [
          '---',
          'title: Ordliste',
          'type: glossary',
          'tags: [ordliste, terminologi]',
          `date: ${today}`,
          'sources: []',
          '---',
          '',
          '# Ordliste',
          '',
          'Domæne-specifikke fagtermer fra denne vidensbase. Genereret retroaktivt fra eksisterende Neuroner; udvides løbende efterhånden som nye Kilder compile\'s.',
          '',
        ].join('\n')
      : [
          '---',
          'title: Glossary',
          'type: glossary',
          'tags: [glossary, terminology]',
          `date: ${today}`,
          'sources: []',
          '---',
          '',
          '# Glossary',
          '',
          'Domain-specific terms from this knowledge base. Generated retroactively from existing Neurons; extended as new Sources are ingested.',
          '',
        ].join('\n');

  const sorted = [...entries].sort((a, b) => a.term.localeCompare(b.term));
  const sections = sorted.map((e) => `## ${e.term}\n\n${e.definition}\n`).join('\n');
  return `${header}\n${sections}`;
}

async function callLlm(prompt: string): Promise<string> {
  if (BACKEND === 'api') {
    return callAnthropicApi(prompt);
  }
  return callCli(prompt);
}

async function callCli(prompt: string): Promise<string> {
  // `--tools ""` is the correct flag to disable every tool (vs.
  // --allowedTools/--disallowedTools which operate on a whitelist/
  // blacklist of allowed tools the CLI still enumerates in its
  // system prompt). Combined with --system-prompt we strip the entire
  // default harness: Haiku sees only our instruction + material, no
  // tool definitions, no CLAUDE.md, no env info. Otherwise --max-turns
  // 1 immediately trips on tool_use because the default system prompt
  // invites the model to Read/Bash its way around the data.
  const args = [
    '-p',
    prompt,
    '--tools',
    '',
    '--system-prompt',
    'You generate JSON responses for an API. Never call tools. Respond with only the requested JSON object.',
    '--max-turns',
    '1',
    '--output-format',
    'json',
    '--model',
    MODEL,
  ];
  return spawnClaude(args, { timeoutMs: CLI_TIMEOUT_MS });
}

async function callAnthropicApi(prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  // extractAssistantText expects CLI-shape JSON; wrap the API text so
  // the shared parser downstream reads it uniformly.
  return JSON.stringify({ result: text });
}

async function writeGlossaryUpdate(
  trail: TrailDatabase,
  kb: BackfillKb,
  targetDocumentId: string,
  content: string,
): Promise<void> {
  const title = kb.language === 'da' ? 'Ordliste' : 'Glossary';
  await createCandidate(
    trail,
    kb.tenantId,
    {
      knowledgeBaseId: kb.id,
      kind: 'ingest-page-update',
      title,
      content,
      metadata: JSON.stringify({
        op: 'update',
        targetDocumentId,
        filename: GLOSSARY_FILENAME,
        path: GLOSSARY_PATH,
        source: 'bootstrap:F102-backfill',
      }),
      confidence: 1,
    },
    { id: kb.createdBy, kind: 'system' },
  );
}
