import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { v5 as uuidv5 } from "uuid";
import type { ChunkPayload } from "../rag/vector-store.js";
import { type ExtractedPage, normalizeExtractedText } from "./pdf-extractor.js";

export const CHUNK_POINT_NAMESPACE = "1f588a94-853c-5fd6-a703-bd57aaf65a5a";

// The version hash joins normalized pages in ascending trusted page order with
// LF + form feed + LF, so page boundaries are represented deterministically.
const CONTENT_PAGE_SEPARATOR = "\n\f\n";
const MAX_HEADING_CHARACTERS = 80;
const MAX_HEADING_WORDS = 10;

export interface ChunkInput {
  documentId: string;
  versionId: string;
  documentTitle: string;
  academicYear: string;
  pages: readonly ExtractedPage[];
}

export interface Chunk extends ChunkPayload {
  pointId: string;
}

export type TextChunkingErrorCode =
  | "PDF_PAGE_METADATA_INVALID"
  | "PDF_CHUNK_EMPTY";

const SAFE_ERROR_MESSAGES: Record<TextChunkingErrorCode, string> = {
  PDF_PAGE_METADATA_INVALID: "El PDF contiene páginas no válidas.",
  PDF_CHUNK_EMPTY: "El PDF contiene un fragmento de texto vacío.",
};

export class TextChunkingError extends Error {
  constructor(readonly code: TextChunkingErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "TextChunkingError";
  }
}

interface PageSection {
  section: string | null;
  text: string;
}

function isHeading(line: string): boolean {
  const words = line.split(/\s+/u);
  const lowercase = line.toLocaleLowerCase("es-ES");
  return (
    line.length <= MAX_HEADING_CHARACTERS &&
    words.length <= MAX_HEADING_WORDS &&
    /\p{L}/u.test(line) &&
    line !== lowercase &&
    line === line.toLocaleUpperCase("es-ES") &&
    !/[.!?;,:]$/u.test(line)
  );
}

function sectionsFromPage(text: string): PageSection[] {
  const sections: PageSection[] = [];
  let section: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    const normalized = normalizeExtractedText(lines.join("\n"));
    if (normalized.length > 0) {
      sections.push({ section, text: normalized });
    }
  };

  for (const line of text.split("\n")) {
    if (isHeading(line)) {
      flush();
      section = line;
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();

  return sections;
}

function normalizedPages(pages: readonly ExtractedPage[]): ExtractedPage[] {
  const seenPages = new Set<number>();
  const normalized = pages.map(({ page, text }) => {
    if (!Number.isInteger(page) || page < 1 || seenPages.has(page)) {
      throw new TextChunkingError("PDF_PAGE_METADATA_INVALID");
    }
    seenPages.add(page);
    const normalizedText = normalizeExtractedText(text);
    if (normalizedText.length === 0) {
      throw new TextChunkingError("PDF_CHUNK_EMPTY");
    }
    return { page, text: normalizedText };
  });
  return normalized.sort((left, right) => left.page - right.page);
}

function contentHash(pages: readonly ExtractedPage[]): string {
  const content = pages.map(({ text }) => text).join(CONTENT_PAGE_SEPARATOR);
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class TextChunker {
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1_000,
    chunkOverlap: 200,
  });

  async split(input: ChunkInput): Promise<Chunk[]> {
    const pages = normalizedPages(input.pages);
    const versionContentHash = contentHash(pages);
    const chunks: Chunk[] = [];

    for (const page of pages) {
      for (const pageSection of sectionsFromPage(page.text)) {
        const splitTexts = await this.splitter.splitText(pageSection.text);
        if (splitTexts.length === 0) {
          throw new TextChunkingError("PDF_CHUNK_EMPTY");
        }

        for (const splitText of splitTexts) {
          const text = normalizeExtractedText(splitText);
          if (text.length === 0) {
            throw new TextChunkingError("PDF_CHUNK_EMPTY");
          }
          const chunkIndex = chunks.length;
          chunks.push({
            pointId: uuidv5(
              `${input.versionId}:${chunkIndex}`,
              CHUNK_POINT_NAMESPACE,
            ),
            documentId: input.documentId,
            versionId: input.versionId,
            documentTitle: input.documentTitle,
            academicYear: input.academicYear,
            page: page.page,
            section: pageSection.section,
            chunkIndex,
            contentHash: versionContentHash,
            text,
          });
        }
      }
    }

    if (chunks.length === 0) {
      throw new TextChunkingError("PDF_CHUNK_EMPTY");
    }
    return chunks;
  }
}
