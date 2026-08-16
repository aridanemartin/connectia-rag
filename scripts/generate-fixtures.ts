import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import type {
  CorpusManifest,
  FixtureInstitution,
  FixtureSource,
  GeneratedPdfInfo,
  GenerateOptions,
  GenerationSummary,
} from "./fixtures.types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXED_TIMESTAMP = new Date("2026-08-16T00:00:00.000Z");

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT; // 495
const CONTENT_TOP = PAGE_HEIGHT - MARGIN_TOP; // 778
const CONTENT_BOTTOM = MARGIN_BOTTOM + 8; // 72 (leave 8px for footer guard)

const HEADING_SIZE = 14;
const HEADING_LINE_HEIGHT = 20;
const BODY_SIZE = 10.5;
const BODY_LINE_HEIGHT = 15;
const PARAGRAPH_GAP = 8;
const FOOTER_Y = 50;
const FOOTER_SIZE = 8;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class FixtureLayoutError extends Error {
  code = "FIXTURE_LAYOUT_EXCEEDED";
  constructor(reason: string) {
    super(reason);
    this.name = "FixtureLayoutError";
  }
}

export class FixtureValidationError extends Error {
  code = "FIXTURE_VALIDATION_FAILED";
  constructor(reason: string) {
    super(reason);
    this.name = "FixtureValidationError";
  }
}

// ---------------------------------------------------------------------------
// Text wrapping (deterministic)
// ---------------------------------------------------------------------------

function wrapText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/u);

  let currentLine: string[] = [];
  let currentWidth = 0;

  for (const word of words) {
    if (word.length === 0) continue;

    const wordWidth = font.widthOfTextAtSize(word, size);
    const spaceWidth =
      currentLine.length > 0 ? font.widthOfTextAtSize(" ", size) : 0;

    if (currentLine.length === 0) {
      currentLine.push(word);
      currentWidth = wordWidth;
    } else if (currentWidth + spaceWidth + wordWidth <= maxWidth) {
      currentLine.push(word);
      currentWidth += spaceWidth + wordWidth;
    } else {
      if (currentLine.length === 0) {
        // Single word wider than maxWidth — split at char level
        lines.push(word);
      } else {
        lines.push(currentLine.join(" "));
        currentLine = [word];
        currentWidth = wordWidth;
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine.join(" "));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// PDF generation per source
// ---------------------------------------------------------------------------

async function generateVersionPdf(
  pdfDoc: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont,
  source: FixtureSource,
  institution: FixtureInstitution,
  _academicYear: string,
  totalPages: number,
  pageIndex: number,
  versionTitle: string,
): Promise<void> {
  const sourcePage = source.pages[pageIndex];
  if (!sourcePage) {
    throw new FixtureLayoutError(
      `Source page index ${pageIndex} does not exist`,
    );
  }

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = CONTENT_TOP;

  // --- Heading ---
  const headingLines = wrapText(
    boldFont,
    sourcePage.heading,
    HEADING_SIZE,
    CONTENT_WIDTH,
  );
  for (const line of headingLines) {
    page.drawText(line, {
      x: MARGIN_LEFT,
      y,
      size: HEADING_SIZE,
      font: boldFont,
    });
    y -= HEADING_LINE_HEIGHT;
  }
  y -= 4; // small gap after heading

  // --- Paragraphs ---
  for (const paragraph of sourcePage.paragraphs) {
    const lines = wrapText(font, paragraph, BODY_SIZE, CONTENT_WIDTH);

    for (const line of lines) {
      if (y < CONTENT_BOTTOM) {
        throw new FixtureLayoutError(
          `Content exceeds page height on page ${pageIndex + 1} of "${versionTitle}"`,
        );
      }
      page.drawText(line, {
        x: MARGIN_LEFT,
        y,
        size: BODY_SIZE,
        font,
      });
      y -= BODY_LINE_HEIGHT;
    }
    y -= PARAGRAPH_GAP;
  }

  // --- Footer (page number) ---
  const footerText = `Página ${pageIndex + 1} de ${totalPages} — ${institution.name} · documento ficticio`;
  const footerWidth = font.widthOfTextAtSize(footerText, FOOTER_SIZE);
  page.drawText(footerText, {
    x: (PAGE_WIDTH - footerWidth) / 2,
    y: FOOTER_Y,
    size: FOOTER_SIZE,
    font,
  });
}

// ---------------------------------------------------------------------------
// Source data
// ---------------------------------------------------------------------------

async function readSource(
  sourcesDir: string,
  sourceFile: string,
): Promise<FixtureSource> {
  const path = join(sourcesDir, sourceFile);
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as FixtureSource;
}

// ---------------------------------------------------------------------------
// Fictional data scanner
// ---------------------------------------------------------------------------

// Regexes that match within running text and are stripped of trailing
// punctuation before validation.
const RAW_EMAIL =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/gu;
// Strict Spanish phone format: +34 XX XXX XX XX
const RAW_PHONE = /\+34 \d{2} \d{3} \d{2} \d{2}/gu;
const RAW_URL =
  /https?:\/\/[a-zA-Z0-9.-]+(?:\.[a-zA-Z0-9.-]+)+(?:\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=-]*)?/gu;
const ACCEPTABLE_EMAIL_DOMAIN = /\.example\.invalid$/u;
const FICTIONAL_PHONE = /^\+34 91 000 00 \d{2}$/u;

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?"')\]}\]>]+$/u, "");
}

/**
 * Scans a text for potential violations of the fictional-data policy.
 * Returns a list of human-readable violation descriptions (empty if clean).
 */
export function scanFictionalViolations(text: string): string[] {
  const violations: string[] = [];

  // Check emails
  const emailMatches = text.match(RAW_EMAIL) ?? [];
  for (const rawMatch of emailMatches) {
    const match = stripTrailingPunctuation(rawMatch);
    if (!ACCEPTABLE_EMAIL_DOMAIN.test(match)) {
      violations.push(`Email "${match}" does not use example.invalid domain`);
    }
  }

  // Check phone numbers
  const phoneMatches = text.match(RAW_PHONE) ?? [];
  for (const rawMatch of phoneMatches) {
    const match = stripTrailingPunctuation(rawMatch).trim();
    if (!FICTIONAL_PHONE.test(match)) {
      violations.push(
        `Phone number "${match}" does not match the fictional pattern`,
      );
    }
  }

  // Check URLs
  const urlMatches = text.match(RAW_URL) ?? [];
  for (const rawMatch of urlMatches) {
    const match = stripTrailingPunctuation(rawMatch);
    try {
      const url = new URL(match);
      if (
        !url.hostname.endsWith(".example.invalid") &&
        url.hostname !== "localhost"
      ) {
        violations.push(`URL "${match}" does not use example.invalid domain`);
      }
    } catch {
      violations.push(`Invalid URL found: "${match}"`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Institution validator
// ---------------------------------------------------------------------------

function validateInstitution(
  source: FixtureSource,
  manifestInstitution: FixtureInstitution,
  sourceFile: string,
): void {
  const { institution } = source;
  if (institution.name !== manifestInstitution.name) {
    throw new FixtureValidationError(
      `Source "${sourceFile}": institution name "${institution.name}" does not match manifest "${manifestInstitution.name}"`,
    );
  }
  if (institution.email !== manifestInstitution.email) {
    throw new FixtureValidationError(
      `Source "${sourceFile}": institution email mismatch`,
    );
  }
  if (institution.phone !== manifestInstitution.phone) {
    throw new FixtureValidationError(
      `Source "${sourceFile}": institution phone mismatch`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest validator
// ---------------------------------------------------------------------------

function validateManifest(manifest: CorpusManifest): void {
  if (manifest.schema !== "connectia-corpus-manifest/v1") {
    throw new FixtureValidationError(
      `Unknown manifest schema: "${manifest.schema}"`,
    );
  }

  if (manifest.documents.length !== 10) {
    throw new FixtureValidationError(
      `Expected 10 documents, got ${manifest.documents.length}`,
    );
  }

  const multiVersionDocs = manifest.documents.filter(
    (d) => d.versions.length > 1,
  );
  if (multiVersionDocs.length !== 1) {
    throw new FixtureValidationError(
      `Expected exactly one multi-version document, got ${multiVersionDocs.length}`,
    );
  }

  const allVersionIds = new Set<string>();
  const allFiles = new Set<string>();
  const allSources = new Set<string>();
  const allIdempotencyKeys = new Set<string>();

  for (const doc of manifest.documents) {
    for (const version of doc.versions) {
      if (allVersionIds.has(version.versionId)) {
        throw new FixtureValidationError(
          `Duplicate versionId: ${version.versionId}`,
        );
      }
      allVersionIds.add(version.versionId);

      if (allFiles.has(version.file)) {
        throw new FixtureValidationError(`Duplicate file: ${version.file}`);
      }
      allFiles.add(version.file);

      if (allSources.has(version.source)) {
        // OK if same source used for different versions (unlikely but allowed if same content)
        // Actually jornada has two different source files, so check
        if (version.source !== doc.versions[0]?.source) {
          throw new FixtureValidationError(
            `Duplicate source: ${version.source}`,
          );
        }
      }
      allSources.add(version.source);

      // Validate idempotency key format
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(version.idempotencyKey)
      ) {
        throw new FixtureValidationError(
          `Invalid idempotencyKey format: "${version.idempotencyKey}"`,
        );
      }
      if (allIdempotencyKeys.has(version.idempotencyKey)) {
        throw new FixtureValidationError(
          `Duplicate idempotencyKey: ${version.idempotencyKey}`,
        );
      }
      allIdempotencyKeys.add(version.idempotencyKey);
    }
  }

  // Validate replacement
  const { replacement } = manifest;
  const repDoc = manifest.documents.find(
    (d) => d.documentId === replacement.documentId,
  );
  if (!repDoc) {
    throw new FixtureValidationError(
      `Replacement documentId ${replacement.documentId} not found in documents`,
    );
  }
  const repVersionIds = new Set(repDoc.versions.map((v) => v.versionId));
  if (!repVersionIds.has(replacement.previous.versionId)) {
    throw new FixtureValidationError(
      `Replacement previous.versionId ${replacement.previous.versionId} not in document versions`,
    );
  }
  if (!repVersionIds.has(replacement.current.versionId)) {
    throw new FixtureValidationError(
      `Replacement current.versionId ${replacement.current.versionId} not in document versions`,
    );
  }
  if (replacement.previous.versionId === replacement.current.versionId) {
    throw new FixtureValidationError(
      "Replacement previous and current versionId must differ",
    );
  }
  if (!replacement.current.activate) {
    throw new FixtureValidationError(
      "Replacement current version must have activate=true",
    );
  }

  // Validate conflicts
  if (manifest.conflicts.length < 1) {
    throw new FixtureValidationError("At least one conflict must be defined");
  }
  for (const conflict of manifest.conflicts) {
    if (conflict.claims.length !== 2) {
      throw new FixtureValidationError(
        `Conflict "${conflict.id}" must have exactly 2 claims`,
      );
    }
    if (conflict.claims[0].documentId === conflict.claims[1].documentId) {
      throw new FixtureValidationError(
        `Conflict "${conflict.id}" claims must reference different documents`,
      );
    }
    for (const claim of conflict.claims) {
      const doc = manifest.documents.find(
        (d) => d.documentId === claim.documentId,
      );
      if (!doc) {
        throw new FixtureValidationError(
          `Conflict "${conflict.id}" references unknown document ${claim.documentId}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Core generation function
// ---------------------------------------------------------------------------

export async function generateCorpusFixtures(
  options: GenerateOptions,
): Promise<GenerationSummary> {
  const { manifest, sourcesDir, outputDir } = options;

  validateManifest(manifest);

  await mkdir(outputDir, { recursive: true });

  const generatedFiles: GeneratedPdfInfo[] = [];

  for (const doc of manifest.documents) {
    for (const version of doc.versions) {
      const source = await readSource(sourcesDir, version.source);

      // Validate institution consistency
      validateInstitution(source, manifest.institution, version.source);

      // Validate fictional data
      const fullText = [
        source.pages
          .map((p) => [p.heading, ...p.paragraphs].join("\n"))
          .join("\n"),
        JSON.stringify(source),
      ].join("\n");
      const violations = scanFictionalViolations(fullText);
      if (violations.length > 0) {
        throw new FixtureValidationError(
          `Source "${version.source}" contains fictional data violations:\n  ${violations.join("\n  ")}`,
        );
      }

      // Create a fresh PDF document per version
      const pdfDoc = await PDFDocument.create();
      pdfDoc.setTitle(version.title);
      pdfDoc.setAuthor(manifest.institution.name);
      pdfDoc.setCreator("connectia-rag-demo");
      pdfDoc.setProducer("connectia-rag-demo");
      pdfDoc.setCreationDate(FIXED_TIMESTAMP);
      pdfDoc.setModificationDate(FIXED_TIMESTAMP);

      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // Generate pages
      const totalPages = source.pages.length;
      for (let i = 0; i < totalPages; i++) {
        await generateVersionPdf(
          pdfDoc,
          font,
          boldFont,
          source,
          manifest.institution,
          version.academicYear,
          totalPages,
          i,
          version.title,
        );
      }

      // Save individual PDF
      const bytes = await pdfDoc.save({ useObjectStreams: false });
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      const outputPath = join(outputDir, version.file);
      await writeFile(outputPath, bytes);

      generatedFiles.push({
        file: version.file,
        bytes: bytes.length,
        sha256,
        pages: totalPages,
      });
    }
  }

  return { files: generatedFiles };
}

// ---------------------------------------------------------------------------
// CLI entry point (only runs when executed directly)
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);

if (process.argv[1] === thisFile) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const manifestPath = join(repoRoot, "fixtures", "corpus.manifest.json");
  const sourcesDir = join(repoRoot, "fixtures", "sources");
  const outputDir = join(repoRoot, "fixtures", "pdfs");

  const manifestContent = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestContent) as CorpusManifest;

  console.log(`Generador de corpus sintético de Connectia`);
  console.log(`Productor: ${manifest.producer}`);
  console.log(`Curso: ${manifest.academicYear}`);
  console.log(`Documentos: ${manifest.documents.length}`);
  console.log(`Directorios: ${outputDir}`);
  console.log();

  const summary = await generateCorpusFixtures({
    manifest,
    sourcesDir,
    outputDir,
  });

  console.log("Resumen de archivos generados:");
  console.log();
  for (const file of summary.files) {
    console.log(
      `  ${file.file.padEnd(35)} ${String(file.pages).padStart(2)} páginas  ${file.sha256.slice(0, 16)}…  ${(file.bytes / 1024).toFixed(1)} KB`,
    );
  }
  console.log();
  console.log(
    `Total: ${summary.files.length} archivos, ${summary.files.reduce((s, f) => s + f.bytes, 0)} bytes`,
  );
}
