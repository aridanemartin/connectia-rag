import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CorpusManifest,
  EvaluationSet,
} from "../../scripts/fixtures.types.js";
import {
  generateCorpusFixtures,
  scanFictionalViolations,
} from "../../scripts/generate-fixtures.js";

const __dirname = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");
const SOURCES_DIR = join(FIXTURES_DIR, "sources");
const MANIFEST_PATH = join(FIXTURES_DIR, "corpus.manifest.json");
const EVALUATIONS_PATH = join(FIXTURES_DIR, "evaluations", "questions.json");

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "conectia-fixture-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function readManifest(): Promise<CorpusManifest> {
  const content = await readFile(MANIFEST_PATH, "utf-8");
  return JSON.parse(content) as CorpusManifest;
}

async function readEvaluations(): Promise<EvaluationSet> {
  const content = await readFile(EVALUATIONS_PATH, "utf-8");
  return JSON.parse(content) as EvaluationSet;
}

describe("fixture generation determinism", () => {
  it("produces byte-identical PDFs from two separate runs", async () => {
    const manifest = await readManifest();
    const firstDir = await createTemporaryDirectory();
    const secondDir = await createTemporaryDirectory();

    const first = await generateCorpusFixtures({
      manifest,
      sourcesDir: SOURCES_DIR,
      outputDir: firstDir,
    });
    const second = await generateCorpusFixtures({
      manifest,
      sourcesDir: SOURCES_DIR,
      outputDir: secondDir,
    });

    expect(first.files.map((f) => f.file).sort()).toEqual(
      second.files.map((f) => f.file).sort(),
    );

    for (const file of first.files) {
      const firstSha = file.sha256;
      const secondFile = second.files.find((f) => f.file === file.file);
      expect(secondFile, `missing file ${file.file}`).toBeDefined();
      expect(secondFile?.sha256).toBe(firstSha);
      expect(secondFile?.bytes).toBe(file.bytes);
      expect(secondFile?.pages).toBe(file.pages);
    }
  });

  it("generates files with valid PDF signatures", async () => {
    const manifest = await readManifest();
    const outputDir = await createTemporaryDirectory();

    const summary = await generateCorpusFixtures({
      manifest,
      sourcesDir: SOURCES_DIR,
      outputDir,
    });

    for (const { file } of summary.files) {
      const pdfPath = join(outputDir, file);
      const allBytes = await readFile(pdfPath);
      const header = allBytes.subarray(0, 5).toString("ascii");
      expect(header).toBe("%PDF-");
    }
  });

  it("does not leak real institute names, emails, or phone numbers", async () => {
    const manifest = await readManifest();
    const outputDir = await createTemporaryDirectory();

    const summary = await generateCorpusFixtures({
      manifest,
      sourcesDir: SOURCES_DIR,
      outputDir,
    });

    for (const { file } of summary.files) {
      const pdfPath = join(outputDir, file);
      const pdfBytes = await readFile(pdfPath);
      const pdfText = pdfBytes.toString("latin1");
      const violations = scanFictionalViolations(pdfText);
      expect(violations, `${file}: fictional data violations`).toEqual([]);
    }
  });
});

describe("manifest validation", () => {
  it("contains exactly ten logical topic documents", async () => {
    const manifest = await readManifest();
    expect(manifest.documents).toHaveLength(10);
  });

  it("has exactly one document with a replaced version and the rest have one version", async () => {
    const manifest = await readManifest();
    const multiVersion = manifest.documents.filter(
      (doc) => doc.versions.length > 1,
    );
    expect(multiVersion).toHaveLength(1);

    const replacementDoc = multiVersion[0]!;
    expect(replacementDoc.versions).toHaveLength(2);

    const [previous, current] = replacementDoc.versions;
    expect(previous.replaced).toBe(true);
    expect(previous.activate).toBe(false);
    expect(current.activate).toBe(true);

    const singleVersion = manifest.documents.filter(
      (doc) => doc.versions.length === 1,
    );
    expect(singleVersion).toHaveLength(9);
  });

  it("references the replacement document and versions correctly", async () => {
    const manifest = await readManifest();
    const { replacement } = manifest;

    const doc = manifest.documents.find(
      (d) => d.documentId === replacement.documentId,
    );
    expect(doc, "replacement documentId must exist in documents").toBeDefined();

    const versionIds = new Set(doc?.versions.map((v) => v.versionId));
    expect(versionIds.has(replacement.previous.versionId)).toBe(true);
    expect(versionIds.has(replacement.current.versionId)).toBe(true);
    expect(replacement.previous.versionId).not.toBe(
      replacement.current.versionId,
    );
  });

  it("defines exactly one controlled cross-document conflict", async () => {
    const manifest = await readManifest();
    expect(manifest.conflicts).toHaveLength(1);

    const conflict = manifest.conflicts[0]!;
    expect(conflict.claims).toHaveLength(2);
    expect(conflict.claims[0].documentId).not.toBe(
      conflict.claims[1].documentId,
    );

    for (const claim of manifest.conflicts.flatMap((c) => c.claims)) {
      const doc = manifest.documents.find(
        (d) => d.documentId === claim.documentId,
      );
      expect(
        doc,
        `conflict references non-existent document ${claim.documentId}`,
      ).toBeDefined();
    }
  });
});

describe("evaluation questions", () => {
  it("meets minimum counts per status", async () => {
    const manifest = await readManifest();
    const evaluations = await readEvaluations();

    const documentIds = new Set(manifest.documents.map((d) => d.documentId));

    const versionPageCounts = new Map<string, number>();
    for (const doc of manifest.documents) {
      for (const version of doc.versions) {
        const sourcePath = join(SOURCES_DIR, version.source);
        const sourceContent = JSON.parse(await readFile(sourcePath, "utf-8"));
        versionPageCounts.set(version.versionId, sourceContent.pages.length);
      }
    }

    const found = evaluations.questions.filter(
      (q) => q.expectedStatus === "found",
    );
    const notFound = evaluations.questions.filter(
      (q) => q.expectedStatus === "not_found",
    );
    const ambiguous = evaluations.questions.filter(
      (q) => q.expectedStatus === "ambiguous",
    );

    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(notFound.length).toBeGreaterThanOrEqual(3);
    expect(ambiguous.length).toBeGreaterThanOrEqual(2);

    for (const q of [...found, ...ambiguous]) {
      for (const docId of q.expectedDocumentIds) {
        expect(
          documentIds.has(docId),
          `question "${q.id}": documentId ${docId} not in manifest`,
        ).toBe(true);
      }
      for (const page of q.expectedPages) {
        expect(page).toBeGreaterThanOrEqual(1);
      }
    }

    for (const q of notFound) {
      expect(q.expectedDocumentIds).toHaveLength(0);
      expect(q.expectedPages).toHaveLength(0);
    }
  });

  it("contains only valid evaluation statuses", async () => {
    const evaluations = await readEvaluations();
    const valid = new Set(["found", "not_found", "ambiguous"]);

    for (const q of evaluations.questions) {
      expect(
        valid.has(q.expectedStatus),
        `question "${q.id}" has invalid status ${q.expectedStatus}`,
      ).toBe(true);
    }
  });

  it("has questions in final-NFC Spanish without control characters", async () => {
    const evaluations = await readEvaluations();

    for (const q of evaluations.questions) {
      expect(q.question.normalize("NFC")).toBe(q.question);
      expect(/\p{C}/u.test(q.question)).toBe(false);
    }
  });
});
