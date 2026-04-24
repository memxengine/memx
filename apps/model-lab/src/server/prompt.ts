import { buildToolDefinitions, type SimulatedKB } from './tools';

export interface IngestPromptConfig {
  kb: SimulatedKB;
  sourceFilename: string;
  sourcePath: string;
  existingTags?: string[];
}

export function buildIngestPrompt(config: IngestPromptConfig): {
  systemPrompt: string;
  userPrompt: string;
  tools: ReturnType<typeof buildToolDefinitions>;
} {
  const { kb, sourceFilename, sourcePath, existingTags = [] } = config;
  const today = new Date().toISOString().slice(0, 10);
  const sFilename = JSON.stringify(sourceFilename);
  const sSourcePath = JSON.stringify(sourcePath);
  const sKbName = JSON.stringify('Model Lab Test KB');
  const sKbSlug = JSON.stringify('model-lab-test');
  const sSummaryTitle = JSON.stringify(sourceFilename.replace(/\.\w+$/, ''));

  const tagBlock = existingTags.length > 0
    ? `\n\nEXISTING TAG VOCABULARY IN THIS KB (prefer reusing over inventing new ones — exact spelling required):\n${existingTags.map((t) => `  - ${t}`).join('\n')}\n\nOnly propose a new tag when nothing in the list fits the concept.`
    : '\n\n(This KB has no tags yet — you are establishing the vocabulary. Keep tags short, lowercase, and specific.)';

  const systemPrompt = `You are the wiki compiler for a knowledge base. You have access to three tools: read, list_files, and write. Use them to ingest source material into a structured wiki.

IMPORTANT RULES:
- For large source files, use the read tool's offset and limit parameters to read in chunks (each chunk is ~40000 chars). Read the first chunk, process it into Neurons, then read the next chunk. This incremental approach keeps your context manageable.
- Be thorough but concise. Every claim should reference its source.
- Use [[page-name]] for internal wiki cross-references.
- ALL pages you create or update MUST have a \`sources: [...]\` field in their YAML frontmatter.
- Required frontmatter fields on every page: title, tags, date, sources.
- Do NOT create pages for trivial concepts. Focus on the 2-5 most important ones per chunk.
- If the source is very short or trivial, just create the summary and update overview/log.`;

  const userPrompt = `You are the wiki compiler for knowledge base ${sKbName} (slug: ${sKbSlug}).${tagBlock}

A new source has been added: ${sFilename} at path ${sSourcePath}.

Your job is to ingest this source into the wiki. Follow these steps:

1. Call \`read\` with path=${sSourcePath}, offset=0, limit=40000 to read the first chunk. Also call \`list_files\` with mode="list" and kind="wiki" to see the current wiki structure. Also call \`read\` with path="/neurons/overview.md" to understand the current wiki state.

2. Create a source summary page based on what you've read so far:
   Call \`write\` with command="create", path="/neurons/sources/", title=${sSummaryTitle}, and content that includes:
   - YAML frontmatter with title, tags (array), date (${today}), sources ([${sFilename}])
   - Key takeaways and findings from this chunk
   - A note at the end: "[Source reading in progress — more chunks to process]" if the source was TRUNCATED

3. For each KEY CONCEPT found in the current chunk (aim for 2-5 concepts):
   - Check if a concept page already exists (you saw the wiki listing in step 1).
   - If it exists: \`read\` it, then \`write\` with command="str_replace" to integrate new information. CRITICAL: preserve existing frontmatter but ADD ${sFilename} to its \`sources: [...]\` array.
   - If it doesn't exist: \`write\` with command="create", path="/neurons/concepts/", and full content INCLUDING frontmatter with \`sources: [${sFilename}]\`.

4. For each KEY ENTITY (person, organization, tool) found in the current chunk:
   - Same pattern under /neurons/entities/. Same \`sources\` frontmatter rule applies.

5. If the source was TRUNCATED (you haven't read all of it yet), call \`read\` again with the next offset to read the next chunk. Then process new concepts/entities from this chunk (go back to step 3). Repeat until you have read the entire source.

6. Once you have read ALL chunks, update the source summary page with a complete overview:
   \`write\` with command="str_replace" on the source page — remove the "reading in progress" note and add a complete summary.

7. Maintain the glossary:
   - Call \`read\` with path="/neurons/glossary.md" to see the current vocabulary.
   - If this source INTRODUCES or clearly REFINES 1-3 domain-specific terms, add or update them.

8. Update the overview page:
   \`write\` with command="str_replace", title="/neurons/overview.md" — reflect the new knowledge and link to the new pages.

9. Log the ingest:
   \`write\` with command="append", title="/neurons/log.md", content:

   ## [${today}] ingest | ${sFilename}
   - Summary: (1-2 sentences)
   - Pages created: (list)
   - Pages updated: (list)
   - Contradictions: (any found, or "None")`;

  return {
    systemPrompt,
    userPrompt,
    tools: buildToolDefinitions(),
  };
}
