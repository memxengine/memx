import type { RunRow } from './db';

export interface QualityReport {
  scorer: string;
  score: number;
  details: string;
}

export function scoreRun(run: RunRow): QualityReport[] {
  const scores: QualityReport[] = [];

  if (run.status !== 'done') {
    scores.push({ scorer: 'completion', score: 0, details: 'Run did not complete successfully' });
    return scores;
  }

  scores.push({ scorer: 'completion', score: 1, details: 'Run completed successfully' });

  const kbOutput: Record<string, string> = run.kb_output ? JSON.parse(run.kb_output) : {};

  const allFiles = Object.keys(kbOutput);
  const sourceFiles = allFiles.filter((f) => f.includes('/sources/'));
  const conceptFiles = allFiles.filter((f) => f.includes('/concepts/'));
  const entityFiles = allFiles.filter((f) => f.includes('/entities/'));
  const hasOverview = allFiles.some((f) => f.endsWith('/overview.md'));
  const hasLog = allFiles.some((f) => f.endsWith('/log.md'));
  const hasGlossary = allFiles.some((f) => f.endsWith('/glossary.md'));

  const structureScore = (
    (sourceFiles.length > 0 ? 0.3 : 0) +
    (conceptFiles.length >= 2 ? 0.3 : conceptFiles.length * 0.15) +
    (hasOverview ? 0.2 : 0) +
    (hasLog ? 0.1 : 0) +
    (hasGlossary ? 0.1 : 0)
  );
  scores.push({
    scorer: 'structure',
    score: Math.min(structureScore, 1),
    details: `Sources: ${sourceFiles.length}, Concepts: ${conceptFiles.length}, Entities: ${entityFiles.length}, Overview: ${hasOverview}, Log: ${hasLog}, Glossary: ${hasGlossary}`,
  });

  let frontmatterScore = 0;
  let filesChecked = 0;
  let missingSources = 0;
  let missingTags = 0;
  for (const [path, content] of Object.entries(kbOutput)) {
    if (path.includes('/neurons/concepts/') || path.includes('/neurons/entities/') || path.includes('/neurons/sources/')) {
      filesChecked++;
      if (!content.includes('sources:')) missingSources++;
      if (!content.includes('tags:')) missingTags++;
    }
  }
  if (filesChecked > 0) {
    frontmatterScore = 1 - ((missingSources + missingTags) / (filesChecked * 2));
  }
  scores.push({
    scorer: 'frontmatter',
    score: Math.max(frontmatterScore, 0),
    details: `Checked ${filesChecked} files, missing sources: ${missingSources}, missing tags: ${missingTags}`,
  });

  const totalContent = Object.values(kbOutput).reduce((sum, c) => sum + c.length, 0);
  const contentRichness = Math.min(totalContent / 5000, 1);
  scores.push({
    scorer: 'content_richness',
    score: contentRichness,
    details: `Total output: ${totalContent} chars across ${allFiles.length} files`,
  });

  const hasWikilinks = Object.values(kbOutput).some((c) => /\[\[.*?\]\]/.test(c));
  const hasTypedEdges = Object.values(kbOutput).some((c) => /\[\[.*?\|(is-a|part-of|contradicts|supersedes|example-of|caused-by)\]\]/.test(c));
  let linkScore = 0;
  if (hasWikilinks) linkScore += 0.6;
  if (hasTypedEdges) linkScore += 0.4;
  scores.push({
    scorer: 'cross_references',
    score: linkScore,
    details: `Wiki links: ${hasWikilinks}, Typed edges: ${hasTypedEdges}`,
  });

  if (run.total_turns > 0) {
    const avgLatency = run.duration_ms / run.total_turns;
    const speedScore = avgLatency < 5000 ? 1 : avgLatency < 15000 ? 0.7 : avgLatency < 30000 ? 0.4 : 0.2;
    scores.push({
      scorer: 'speed',
      score: speedScore,
      details: `Avg ${Math.round(avgLatency)}ms per turn, ${run.total_turns} turns total`,
    });
  }

  const costEfficiency = run.total_cost_usd < 0.5 ? 1 : run.total_cost_usd < 2 ? 0.7 : run.total_cost_usd < 5 ? 0.4 : 0.2;
  scores.push({
    scorer: 'cost_efficiency',
    score: costEfficiency,
    details: `$${run.total_cost_usd.toFixed(4)} total cost`,
  });

  return scores;
}
