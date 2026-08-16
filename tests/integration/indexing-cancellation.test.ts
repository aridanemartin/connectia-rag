import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createIndexingComposition } from "../../src/documents/indexing.service.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

describe("IndexingService cancellation", () => {
  it("rejects an already-aborted operation before hashing or persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-indexing-abort-"));
    const composition = createIndexingComposition(
      loadConfig({
        AUTH_TOKEN,
        DATABASE_PATH: join(root, "connectia.sqlite"),
        TEMP_DIR: join(root, "uploads"),
      }),
    );
    try {
      const pdfPath = await createTestPdf(root, [
        ["MATRÍCULA", "Contenido que no debe persistirse."],
      ]);
      const controller = new AbortController();
      controller.abort();

      await expect(
        composition.indexingService.enqueue(
          {
            idempotencyKey: "index-aborted-before-hash",
            documentId: randomUUID(),
            versionId: randomUUID(),
            title: "Matrícula 2026-2027",
            academicYear: "2026-2027",
            description: null,
            tempFilePath: pdfPath,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "INDEXING_ABORTED",
      });
      expect(
        composition.database
          .prepare(
            "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM document_versions) AS versions, (SELECT COUNT(*) FROM indexing_jobs) AS jobs",
          )
          .get(),
      ).toEqual({ documents: 0, versions: 0, jobs: 0 });
    } finally {
      composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
