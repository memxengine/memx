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
- Be thorough but concise. Every claim should reference its source.
- Use [[page-name]] for internal wiki cross-references.
- ALL pages you create or update MUST have a \`sources: [...]\` field in their YAML frontmatter.
- Required frontmatter fields on every page: title, tags, date, sources.
- Do NOT create pages for trivial concepts. Focus on the 2-5 most important ones.
- If the source is very short or trivial, just create the summary and update overview/log.`;

  const userPrompt = `You are the wiki compiler for knowledge base ${sKbName} (slug: ${sKbSlug}).${tagBlock}

A new source has been added: ${sFilename} at path ${sSourcePath}.

Your job is to ingest this source into the wiki. Follow these steps exactly:

1. Call \`read\` with path=${sSourcePath} to read the new source.

2. Call \`list_files\` with mode="list" and kind="wiki" to see the current wiki structure.

3. Call \`read\` with path="/neurons/overview.md" to understand the current wiki state.

4. Create a source summary page:
   Call \`write\` with command="create", path="/neurons/sources/", title=${sSummaryTitle}, and content that includes:
   - YAML frontmatter with title, tags (array), date (${today}), sources ([${sFilename}])
   - Key takeaways and findings
   - Important quotes or data points

5. For each KEY CONCEPT found in the source (aim for 2-5 concepts):
   - Check if a concept page already exists (you saw the wiki listing in step 2).
   - If it exists: \`read\` it, then \`write\` with command="str_replace" to integrate new information. Use the full path (e.g. "/neurons/concepts/concept-name.md") as the title parameter. CRITICAL: preserve existing frontmatter but ADD ${sFilename} to its \`sources: [...]\` array.
   - If it doesn't exist: \`write\` with command="create", path="/neurons/concepts/", and full content INCLUDING frontmatter with \`sources: [${sFilename}]\`.

6. For each KEY ENTITY (person, organization, tool) found:
   - Same pattern under /neurons/entities/. Same \`sources\` frontmatter rule applies.

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
