import { db, documentChunks } from '@trail/db';

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 128;
const MIN_CHUNK_TOKENS = 32;

export interface Chunk {
  index: number;
  content: string;
  page: number | null;
  startChar: number;
  tokenCount: number;
  headerBreadcrumb: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkText(
  content: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
  page: number | null = null,
  startCharOffset = 0,
): Chunk[] {
  const paragraphs = content.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let currentParagraphs: string[] = [];
  let currentTokens = 0;
  let currentStartChar = startCharOffset;
  let charPos = startCharOffset;
  const headerStack: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      charPos += para.length + 2;
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1]!.length - 1;
      headerStack.length = level;
      headerStack[level] = headerMatch[2]!;
    }

    const paraTokens = estimateTokens(trimmed);

    if (currentTokens + paraTokens > chunkSize && currentParagraphs.length > 0) {
      const chunkContent = currentParagraphs.join('\n\n');
      if (estimateTokens(chunkContent) >= MIN_CHUNK_TOKENS) {
        chunks.push({
          index: chunks.length,
          content: chunkContent,
          page,
          startChar: currentStartChar,
          tokenCount: estimateTokens(chunkContent),
          headerBreadcrumb: headerStack.filter(Boolean).join(' > '),
        });
      }

      const overlapParagraphs: string[] = [];
      let overlapTokens = 0;
      for (let i = currentParagraphs.length - 1; i >= 0; i--) {
        const t = estimateTokens(currentParagraphs[i]!);
        if (overlapTokens + t > overlap) break;
        overlapParagraphs.unshift(currentParagraphs[i]!);
        overlapTokens += t;
      }

      currentParagraphs = overlapParagraphs;
      currentTokens = overlapTokens;
      currentStartChar = charPos;
    }

    currentParagraphs.push(trimmed);
    currentTokens += paraTokens;
    charPos += para.length + 2;
  }

  if (currentParagraphs.length > 0) {
    const chunkContent = currentParagraphs.join('\n\n');
    if (estimateTokens(chunkContent) >= MIN_CHUNK_TOKENS) {
      chunks.push({
        index: chunks.length,
        content: chunkContent,
        page,
        startChar: currentStartChar,
        tokenCount: estimateTokens(chunkContent),
        headerBreadcrumb: headerStack.filter(Boolean).join(' > '),
      });
    }
  }

  return chunks;
}

export function storeChunks(
  documentId: string,
  tenantId: string,
  kbId: string,
  chunks: Chunk[],
): void {
  for (const chunk of chunks) {
    db.insert(documentChunks)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        documentId,
        knowledgeBaseId: kbId,
        chunkIndex: chunk.index,
        content: chunk.content,
        page: chunk.page,
        startChar: chunk.startChar,
        tokenCount: chunk.tokenCount,
        headerBreadcrumb: chunk.headerBreadcrumb || null,
      })
      .run();
  }
}
