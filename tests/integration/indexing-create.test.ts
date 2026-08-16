import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
} from "../../src/documents/indexing.service.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const temporaryDirectories: string[] = [];
const compositions: IndexingComposition[] = [];

async function createTestContext(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "connectia-indexing-test-"));
  temporaryDirectories.push(root);
  const uploadDirectory = join(root, "uploads");
  const config = loadConfig({
    AUTH_TOKEN,
    DATABASE_PATH: join(root, "connectia.sqlite"),
    TEMP_DIR: uploadDirectory,
    ...overrides,
  });
  const composition = createIndexingComposition(config);
  compositions.push(composition);
  return {
    app: createApp({
      config,
      logger: pino({ level: "silent" }),
      indexingService: composition.indexingService,
    }),
    composition,
    root,
    uploadDirectory,
  };
}

async function uploadEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

interface SendPdfOptions {
  idempotencyKey?: string;
  documentId?: string;
  versionId?: string;
  title?: string;
  academicYear?: string;
  description?: string | null;
  filename?: string;
  contentType?: string;
}

function sendPdf(
  context: Awaited<ReturnType<typeof createTestContext>>,
  pdfPath: string,
  options: SendPdfOptions = {},
) {
  const pending = request(context.app)
    .post("/api/v1/indexing/jobs")
    .set("Authorization", `Bearer ${AUTH_TOKEN}`);
  if (options.idempotencyKey !== undefined) {
    pending.set("Idempotency-Key", options.idempotencyKey);
  }
  pending
    .field("documentId", options.documentId ?? randomUUID())
    .field("versionId", options.versionId ?? randomUUID())
    .field("title", options.title ?? "Matrícula 2026-2027")
    .field("academicYear", options.academicYear ?? "2026-2027");
  if (options.description !== undefined && options.description !== null) {
    pending.field("description", options.description);
  }
  return pending.attach("file", pdfPath, {
    filename: options.filename ?? "matricula.pdf",
    contentType: options.contentType ?? "application/pdf",
  });
}

afterEach(async () => {
  for (const composition of compositions.splice(0)) {
    composition.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("POST /api/v1/indexing/jobs", () => {
  it("accepts one authenticated PDF and returns the exact queued contract", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "El plazo termina el 15 de julio."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();

    const response = await request(context.app)
      .post("/api/v1/indexing/jobs")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .set("Idempotency-Key", "index-matricula-2026")
      .field("documentId", documentId)
      .field("versionId", versionId)
      .field("title", "Matrícula 2026-2027")
      .field("academicYear", "2026-2027")
      .attach("file", pdfPath, {
        filename: "matricula.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      jobId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      status: "queued",
      requestId: response.headers["x-request-id"],
    });

    const database = openDatabase(join(context.root, "connectia.sqlite"));
    const persisted = database
      .prepare(
        `
          SELECT indexing_jobs.id AS jobId, indexing_jobs.status,
                 indexing_jobs.temp_file_path AS tempFilePath,
                 indexing_jobs.content_hash AS contentHash,
                 indexing_jobs.request_hash AS requestHash,
                 document_versions.state, documents.title,
                 document_versions.academic_year AS academicYear
          FROM indexing_jobs
          JOIN document_versions ON document_versions.id = indexing_jobs.version_id
          JOIN documents ON documents.id = indexing_jobs.document_id
          WHERE indexing_jobs.id = ?
        `,
      )
      .get(response.body.jobId);
    closeDatabase(database);
    const expectedContentHash = createHash("sha256")
      .update(await readFile(pdfPath))
      .digest("hex");
    const canonicalMetadata =
      `{"documentId":"${documentId}","versionId":"${versionId}",` +
      '"title":"Matrícula 2026-2027","academicYear":"2026-2027",' +
      '"description":null}';
    const expectedRequestHash = createHash("sha256")
      .update(expectedContentHash + canonicalMetadata)
      .digest("hex");
    const uploadEntries = await readdir(context.uploadDirectory);

    expect(persisted).toEqual({
      jobId: response.body.jobId,
      status: "queued",
      tempFilePath: join(context.uploadDirectory, uploadEntries[0] ?? ""),
      contentHash: expectedContentHash,
      requestHash: expectedRequestHash,
      state: "INDEXING",
      title: "Matrícula 2026-2027",
      academicYear: "2026-2027",
    });
    expect(uploadEntries).toHaveLength(1);
    expect(uploadEntries[0]).not.toContain("matricula");
    expect((await stat(context.uploadDirectory)).mode & 0o077).toBe(0);
  });

  it("requires authentication before creating temporary files", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["TÍTULO", "Contenido suficiente."],
    ]);

    const response = await request(context.app)
      .post("/api/v1/indexing/jobs")
      .field("documentId", randomUUID())
      .field("versionId", randomUUID())
      .field("title", "Matrícula")
      .field("academicYear", "2026-2027")
      .attach("file", pdfPath, "matricula.pdf");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it("returns the original job for the same normalized request and removes the replay upload", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido de la matrícula."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const common = {
      idempotencyKey: "index-replay-2026",
      documentId,
      versionId,
    };

    const first = await sendPdf(context, pdfPath, {
      ...common,
      title: "  Matrícula 2026-2027  ",
    });
    const replay = await sendPdf(context, pdfPath, {
      ...common,
      title: "Matrícula 2026-2027",
      description: "   ",
    });

    const counts = context.composition.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM indexing_jobs) AS jobs, (SELECT COUNT(*) FROM document_versions) AS versions",
      )
      .get();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.jobId).toBe(first.body.jobId);
    expect(replay.body.status).toBe("queued");
    expect(counts).toEqual({ jobs: 1, versions: 1 });
    expect(await uploadEntries(context.uploadDirectory)).toHaveLength(1);
  });

  it.each([
    { change: "bytes", metadata: {} },
    { change: "metadata", metadata: { title: "Calendario 2026-2027" } },
  ])(
    "returns a safe conflict for changed $change with the same key",
    async ({ change, metadata }) => {
      const context = await createTestContext();
      const firstPdf = await createTestPdf(context.root, [
        ["MATRÍCULA", "Primer contenido institucional."],
      ]);
      const secondPdf =
        change === "bytes"
          ? await createTestPdf(context.root, [
              ["MATRÍCULA", "Segundo contenido institucional."],
            ])
          : firstPdf;
      const documentId = randomUUID();
      const versionId = randomUUID();
      const common = {
        idempotencyKey: `index-conflict-${change}`,
        documentId,
        versionId,
      };
      await sendPdf(context, firstPdf, common);

      const response = await sendPdf(context, secondPdf, {
        ...common,
        ...metadata,
      });

      expect(response.status).toBe(409);
      expect(response.body.error).toEqual({
        code: "IDEMPOTENCY_CONFLICT",
        message: "La clave de idempotencia ya se utilizó con otra solicitud.",
        requestId: response.headers["x-request-id"],
      });
      expect(JSON.stringify(response.body)).not.toContain(context.root);
      expect(JSON.stringify(response.body)).not.toContain("matricula.pdf");
      expect(await uploadEntries(context.uploadDirectory)).toHaveLength(1);
    },
  );

  it.each([
    { label: "missing", key: undefined },
    { label: "blank", key: "   " },
    { label: "spaces", key: "index matricula" },
    { label: "too long", key: `i${"x".repeat(128)}` },
  ])(
    "rejects a $label idempotency key without retaining a file",
    async ({ key }) => {
      const context = await createTestContext();
      const pdfPath = await createTestPdf(context.root, [
        ["MATRÍCULA", "Contenido institucional."],
      ]);

      const response = await sendPdf(context, pdfPath, {
        idempotencyKey: key,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toMatch(/^IDEMPOTENCY_KEY_/u);
      expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
    },
  );

  it.each([
    { label: "document UUID", field: "documentId", value: "not-a-uuid" },
    { label: "version UUID", field: "versionId", value: "not-a-uuid" },
    {
      label: "academic year format",
      field: "academicYear",
      value: "2026/2027",
    },
    {
      label: "nonconsecutive academic year",
      field: "academicYear",
      value: "2026-2028",
    },
    { label: "empty title", field: "title", value: "   " },
    { label: "oversized title", field: "title", value: "t".repeat(201) },
    {
      label: "control characters in title",
      field: "title",
      value: "Matrícula\u0007",
    },
    {
      label: "oversized description",
      field: "description",
      value: "d".repeat(1_001),
    },
  ])(
    "rejects invalid $label metadata and cleans the upload",
    async ({ field, value }) => {
      const context = await createTestContext();
      const pdfPath = await createTestPdf(context.root, [
        ["MATRÍCULA", "Contenido institucional."],
      ]);
      const fields: Record<string, string> = {
        documentId: randomUUID(),
        versionId: randomUUID(),
        title: "Matrícula 2026-2027",
        academicYear: "2026-2027",
        description: "Descripción",
        [field]: value,
      };
      const pending = request(context.app)
        .post("/api/v1/indexing/jobs")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Idempotency-Key", "index-invalid-metadata");
      for (const [name, fieldValue] of Object.entries(fields)) {
        pending.field(name, fieldValue);
      }

      const response = await pending.attach("file", pdfPath, {
        filename: "matricula.pdf",
        contentType: "application/pdf",
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INDEXING_METADATA_INVALID");
      expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
    },
  );

  it("rejects unknown and repeated metadata fields", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido institucional."],
    ]);
    const base = () =>
      request(context.app)
        .post("/api/v1/indexing/jobs")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Idempotency-Key", "index-metadata-shape")
        .field("documentId", randomUUID())
        .field("versionId", randomUUID())
        .field("academicYear", "2026-2027");

    const unknown = await base()
      .field("title", "Matrícula")
      .field("unexpected", "contenido privado")
      .attach("file", pdfPath, "matricula.pdf");
    const repeated = await base()
      .field("title", "Matrícula")
      .field("title", "Otro título")
      .attach("file", pdfPath, "matricula.pdf");

    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("INDEXING_METADATA_INVALID");
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.code).toBe("INDEXING_METADATA_INVALID");
    expect(JSON.stringify([unknown.body, repeated.body])).not.toContain(
      "contenido privado",
    );
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it.each(["documentId", "versionId", "title", "academicYear"])(
    "rejects a missing required %s field",
    async (missingField) => {
      const context = await createTestContext();
      const pdfPath = await createTestPdf(context.root, [
        ["MATRÍCULA", "Contenido institucional."],
      ]);
      const fields: Record<string, string> = {
        documentId: randomUUID(),
        versionId: randomUUID(),
        title: "Matrícula",
        academicYear: "2026-2027",
      };
      delete fields[missingField];
      const pending = request(context.app)
        .post("/api/v1/indexing/jobs")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Idempotency-Key", `index-missing-${missingField}`);
      for (const [name, value] of Object.entries(fields)) {
        pending.field(name, value);
      }

      const response = await pending.attach("file", pdfPath, "matricula.pdf");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INDEXING_METADATA_INVALID");
      expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
    },
  );

  it("accepts the PDF extension case-insensitively", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido institucional."],
    ]);

    const response = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-uppercase-extension",
      filename: "MATRICULA.PDF",
    });

    expect(response.status).toBe(202);
  });

  it.each([
    {
      label: "extension",
      filename: "matricula.txt",
      contentType: "application/pdf",
      code: "PDF_EXTENSION_INVALID",
      status: 400,
    },
    {
      label: "MIME type",
      filename: "matricula.PDF",
      contentType: "application/octet-stream",
      code: "PDF_MIME_INVALID",
      status: 415,
    },
  ])(
    "rejects the untrusted $label gate",
    async ({ filename, contentType, code, status }) => {
      const context = await createTestContext();
      const pdfPath = await createTestPdf(context.root, [
        ["MATRÍCULA", "Contenido institucional."],
      ]);

      const response = await sendPdf(context, pdfPath, {
        idempotencyKey: `index-gate-${code}`,
        filename,
        contentType,
      });

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
    },
  );

  it("treats the stored %PDF- signature as authoritative", async () => {
    const context = await createTestContext();
    const fakePdf = join(context.root, "secret-original.pdf");
    await writeFile(fakePdf, "not really a PDF despite its extension");

    const response = await sendPdf(context, fakePdf, {
      idempotencyKey: "index-invalid-magic",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PDF_SIGNATURE_INVALID");
    expect(JSON.stringify(response.body)).not.toContain("secret-original.pdf");
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
    expect(
      context.composition.database
        .prepare("SELECT COUNT(*) AS count FROM indexing_jobs")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("returns 413 for an oversized PDF and leaves no partial file", async () => {
    const context = await createTestContext({ MAX_PDF_BYTES: "512" });
    const oversized = join(context.root, "oversized.pdf");
    await writeFile(
      oversized,
      Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(508)]),
    );

    const response = await sendPdf(context, oversized, {
      idempotencyKey: "index-too-large",
    });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PDF_TOO_LARGE");
    expect(JSON.stringify(response.body)).not.toContain("File too large");
    expect(JSON.stringify(response.body)).not.toContain(oversized);
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it("rejects missing, extra, and unexpected file fields safely", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido institucional."],
    ]);
    const fields = (key: string) =>
      request(context.app)
        .post("/api/v1/indexing/jobs")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Idempotency-Key", key)
        .field("documentId", randomUUID())
        .field("versionId", randomUUID())
        .field("title", "Matrícula")
        .field("academicYear", "2026-2027");

    const missing = await fields("index-missing-file");
    const extra = await fields("index-extra-file")
      .attach("file", pdfPath, "one.pdf")
      .attach("file", pdfPath, "two.pdf");
    const unexpected = await fields("index-unexpected-file").attach(
      "private-document",
      pdfPath,
      "secret.pdf",
    );

    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("PDF_REQUIRED");
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("MULTIPART_FILE_INVALID");
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.error.code).toBe("MULTIPART_FILE_INVALID");
    expect(JSON.stringify([extra.body, unexpected.body])).not.toContain(
      "secret",
    );
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it("maps field-count, field-name, field-value, and malformed multipart failures safely", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido institucional."],
    ]);
    const base = (key: string) =>
      request(context.app)
        .post("/api/v1/indexing/jobs")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Idempotency-Key", key)
        .field("documentId", randomUUID())
        .field("versionId", randomUUID())
        .field("title", "Matrícula")
        .field("academicYear", "2026-2027");

    const tooManyFields = await base("index-field-count")
      .field("description", "Descripción")
      .field("extra", "no debe aparecer")
      .attach("file", pdfPath, "matricula.pdf");
    const longFieldName = await base("index-field-name")
      .field("x".repeat(65), "valor")
      .attach("file", pdfPath, "matricula.pdf");
    const longFieldValue = await base("index-field-value")
      .field("description", "x".repeat(8 * 1024 + 1))
      .attach("file", pdfPath, "matricula.pdf");
    const malformed = await request(context.app)
      .post("/api/v1/indexing/jobs")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .set("Idempotency-Key", "index-malformed")
      .set("Content-Type", "multipart/form-data")
      .send("private malformed body");

    expect(tooManyFields.status).toBe(400);
    expect(tooManyFields.body.error.code).toBe("MULTIPART_FIELD_LIMIT");
    expect(longFieldName.status).toBe(400);
    expect(longFieldName.body.error.code).toBe("MULTIPART_FIELD_NAME_INVALID");
    expect(longFieldValue.status).toBe(400);
    expect(longFieldValue.body.error.code).toBe(
      "MULTIPART_FIELD_VALUE_INVALID",
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("MULTIPART_INVALID");
    expect(JSON.stringify([tooManyFields.body, malformed.body])).not.toContain(
      "private",
    );
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it("rolls back the document/version when the job insert fails and removes the upload", async () => {
    const context = await createTestContext();
    context.composition.database.exec(`
      CREATE TRIGGER reject_indexing_job
      BEFORE INSERT ON indexing_jobs
      BEGIN
        SELECT RAISE(ABORT, 'sensitive database failure');
      END;
    `);
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido institucional."],
    ]);

    const response = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-rollback",
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("sensitive database");
    expect(
      context.composition.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM document_versions) AS versions, (SELECT COUNT(*) FROM indexing_jobs) AS jobs",
        )
        .get(),
    ).toEqual({ documents: 0, versions: 0, jobs: 0 });
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it("serializes concurrent same-key requests to one durable job", async () => {
    const context = await createTestContext();
    const secondComposition = createIndexingComposition(
      loadConfig({
        AUTH_TOKEN,
        DATABASE_PATH: join(context.root, "connectia.sqlite"),
        TEMP_DIR: context.uploadDirectory,
      }),
    );
    compositions.push(secondComposition);
    const secondApp = createApp({
      config: loadConfig({
        AUTH_TOKEN,
        DATABASE_PATH: join(context.root, "connectia.sqlite"),
        TEMP_DIR: context.uploadDirectory,
      }),
      logger: pino({ level: "silent" }),
      indexingService: secondComposition.indexingService,
    });
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido concurrente institucional."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const options = {
      idempotencyKey: "index-concurrent-request",
      documentId,
      versionId,
    };

    const [first, second] = await Promise.all([
      sendPdf(context, pdfPath, options),
      sendPdf({ ...context, app: secondApp }, pdfPath, options),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(
      context.composition.database
        .prepare("SELECT COUNT(*) AS count FROM indexing_jobs")
        .get(),
    ).toEqual({ count: 1 });
    expect(await uploadEntries(context.uploadDirectory)).toHaveLength(1);
  });
});
