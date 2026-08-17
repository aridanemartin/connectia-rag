import type { Citation, SearchHit } from "./rag.types.js";

export type { Citation } from "./rag.types.js";

const EXCERPT_MAX_LENGTH = 300;

function trimExcerpt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function deduplicateByScore(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of hits) {
    const existing = seen.get(hit.id);
    if (!existing || hit.score > existing.score) {
      seen.set(hit.id, hit);
    }
  }
  return Array.from(seen.values());
}

export function buildCitations(
  citedChunkIds: readonly string[],
  retrievedHits: readonly SearchHit[],
): Citation[] {
  const hitsById = new Map<string, SearchHit>();
  for (const hit of retrievedHits) {
    hitsById.set(hit.id, hit);
  }

  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const chunkId of citedChunkIds) {
    if (seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);

    const hit = hitsById.get(chunkId);
    if (!hit) {
      continue;
    }

    citations.push({
      documentId: hit.payload.documentId,
      versionId: hit.payload.versionId,
      documentTitle: hit.payload.documentTitle,
      page: hit.payload.page,
      section: hit.payload.section,
      academicYear: hit.payload.academicYear,
      excerpt: trimExcerpt(hit.payload.text, EXCERPT_MAX_LENGTH),
    });
  }

  return citations;
}

export function deduplicateHits(hits: readonly SearchHit[]): SearchHit[] {
  return deduplicateByScore(hits);
}
