import { open } from "node:fs/promises";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const BYTE_ORDER_MARK = "\uFEFF";
const UNICODE_WHITE_SPACE_CHARACTER = /\p{White_Space}/u;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/**
 * A deliberately low guard that rejects parser noise while retaining concise
 * institutional notices. It counts semantic Unicode code points after
 * deterministic normalization, excluding White_Space, controls, and formats.
 */
export const MIN_EXTRACTED_CHARACTERS = 20;

export interface ExtractedPage {
  page: number;
  text: string;
}

interface LoadedPdfDocument {
  pageContent: unknown;
  metadata: unknown;
}

export interface PdfDocumentLoader {
  load(): Promise<readonly LoadedPdfDocument[]>;
}

export type PdfLoaderFactory = (path: string) => PdfDocumentLoader;

export type PdfProcessingErrorCode =
  | "PDF_SIGNATURE_INVALID"
  | "PDF_CORRUPT"
  | "PDF_ENCRYPTED"
  | "PDF_PARSE_FAILED"
  | "PDF_METADATA_INVALID"
  | "PDF_TEXT_NOT_FOUND";

const SAFE_ERROR_MESSAGES: Record<PdfProcessingErrorCode, string> = {
  PDF_SIGNATURE_INVALID: "El archivo no tiene una firma PDF válida.",
  PDF_CORRUPT: "El PDF está dañado y no se puede procesar.",
  PDF_ENCRYPTED: "El PDF está cifrado y no se puede procesar.",
  PDF_PARSE_FAILED: "No se ha podido procesar el PDF.",
  PDF_METADATA_INVALID: "El PDF no contiene metadatos de página válidos.",
  PDF_TEXT_NOT_FOUND: "El PDF no contiene suficiente texto extraíble.",
};

export class PdfProcessingError extends Error {
  constructor(readonly code: PdfProcessingErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "PdfProcessingError";
  }
}

/**
 * Normalize parser text without flattening document structure. Unicode line
 * separators become line breaks, paragraph separators become paragraph breaks,
 * and other Unicode White_Space is collapsed horizontally. U+FEFF is always
 * removed as parser/encoding noise; remaining control and format code points are
 * also discarded after structural line separators have been preserved. NFC is
 * applied last so eligibility, chunking, and hashing share one idempotent form.
 */
export function normalizeExtractedText(value: string): string {
  return value
    .split(BYTE_ORDER_MARK)
    .join("")
    .replace(/\r\n?/gu, "\n")
    .split("\u0085")
    .join("\n")
    .split("\u2028")
    .join("\n")
    .split("\u2029")
    .join("\n\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/\p{White_Space}+/gu, " ")
        .replace(/[\p{Cc}\p{Cf}]+/gu, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .normalize("NFC");
}

function isExtractableCharacter(character: string): boolean {
  return (
    character !== BYTE_ORDER_MARK &&
    !UNICODE_WHITE_SPACE_CHARACTER.test(character) &&
    !CONTROL_OR_FORMAT_CHARACTER.test(character)
  );
}

export function hasExtractableText(value: string): boolean {
  return Array.from(value).some(isExtractableCharacter);
}

function defaultLoaderFactory(path: string): PdfDocumentLoader {
  return new PDFLoader(path, { splitPages: true });
}

async function hasPdfMagic(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(PDF_MAGIC.length);
    const { bytesRead } = await file.read(header, 0, PDF_MAGIC.length, 0);
    return bytesRead === PDF_MAGIC.length && header.equals(PDF_MAGIC);
  } finally {
    await file.close();
  }
}

function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return "";
  }
  return typeof error.name === "string" ? error.name : "";
}

function parserError(error: unknown): PdfProcessingError {
  const name = errorName(error);
  if (name === "PasswordException" || name === "EncryptedPDFError") {
    return new PdfProcessingError("PDF_ENCRYPTED");
  }
  if (
    name === "InvalidPDFException" ||
    name === "FormatError" ||
    name === "MissingPDFException"
  ) {
    return new PdfProcessingError("PDF_CORRUPT");
  }
  return new PdfProcessingError("PDF_PARSE_FAILED");
}

function pageNumberFromMetadata(metadata: unknown): number | null {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("loc" in metadata) ||
    typeof metadata.loc !== "object" ||
    metadata.loc === null ||
    !("pageNumber" in metadata.loc) ||
    typeof metadata.loc.pageNumber !== "number" ||
    !Number.isInteger(metadata.loc.pageNumber) ||
    metadata.loc.pageNumber < 1
  ) {
    return null;
  }
  return metadata.loc.pageNumber;
}

function countExtractableCodePoints(pages: readonly ExtractedPage[]): number {
  return Array.from(pages.map(({ text }) => text).join("")).filter(
    isExtractableCharacter,
  ).length;
}

export class PdfExtractor {
  constructor(private readonly loaderFactory = defaultLoaderFactory) {}

  async extract(path: string): Promise<ExtractedPage[]> {
    let validMagic: boolean;
    try {
      validMagic = await hasPdfMagic(path);
    } catch {
      throw new PdfProcessingError("PDF_PARSE_FAILED");
    }

    if (!validMagic) {
      throw new PdfProcessingError("PDF_SIGNATURE_INVALID");
    }

    let documents: readonly LoadedPdfDocument[];
    try {
      documents = await this.loaderFactory(path).load();
    } catch (error) {
      throw parserError(error);
    }

    if (!Array.isArray(documents)) {
      throw new PdfProcessingError("PDF_PARSE_FAILED");
    }

    const seenPages = new Set<number>();
    const pages: ExtractedPage[] = [];
    for (const document of documents) {
      if (
        typeof document !== "object" ||
        document === null ||
        !("metadata" in document) ||
        !("pageContent" in document)
      ) {
        throw new PdfProcessingError("PDF_PARSE_FAILED");
      }
      const page = pageNumberFromMetadata(document.metadata);
      if (page === null || seenPages.has(page)) {
        throw new PdfProcessingError("PDF_METADATA_INVALID");
      }
      seenPages.add(page);

      if (typeof document.pageContent !== "string") {
        throw new PdfProcessingError("PDF_PARSE_FAILED");
      }
      const text = normalizeExtractedText(document.pageContent);
      if (text.length > 0) {
        pages.push({ page, text });
      }
    }

    pages.sort((left, right) => left.page - right.page);
    if (countExtractableCodePoints(pages) < MIN_EXTRACTED_CHARACTERS) {
      throw new PdfProcessingError("PDF_TEXT_NOT_FOUND");
    }

    return pages;
  }
}
