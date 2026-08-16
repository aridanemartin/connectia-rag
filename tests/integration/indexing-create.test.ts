import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import pino from "pino";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
  type IndexingRequest,
} from "../../src/documents/indexing.service.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const temporaryDirectories: string[] = [];
const compositions: IndexingComposition[] = [];

async function createTestContext(
  overrides: NodeJS.ProcessEnv = {},
  prepare?: (root: string, uploadDirectory: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "connectia-indexing-test-"));
  temporaryDirectories.push(root);
  const uploadDirectory = join(root, "uploads");
  await prepare?.(root, uploadDirectory);
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
    config,
    root,
    uploadDirectory,
  };
}

type UploadUnlink = (path: string) => Promise<void>;

function appWithUploadUnlink(
  context: Awaited<ReturnType<typeof createTestContext>>,
  uploadUnlink: UploadUnlink,
) {
  return createApp({
    config: context.config,
    logger: pino({ level: "silent" }),
    indexingService: context.composition.indexingService,
    uploadUnlink,
  });
}

function rawMultipartBody(
  boundary: string,
  parts: readonly {
    headers: readonly string[];
    body: string;
  }[],
): Buffer {
  return Buffer.from(
    `${parts
      .map(
        (part) =>
          `--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n${part.body}\r\n`,
      )
      .join("")}--${boundary}--\r\n`,
    "utf8",
  );
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

type ConcurrencyResult =
  | { type: "result"; status: 202; jobId: string }
  | { type: "result"; status: number; code: string };

async function runConcurrentIndexingWorkers(
  workersData: readonly {
    config: ReturnType<typeof loadConfig>;
    input: IndexingRequest;
  }[],
): Promise<ConcurrencyResult[]> {
  const workers = workersData.map(
    (workerData) =>
      new Worker(
        new URL("../support/indexing-concurrency-worker.ts", import.meta.url),
        {
          execArgv: ["--import", "tsx"],
          workerData,
        },
      ),
  );
  return await new Promise<ConcurrencyResult[]>((resolveWorkers, reject) => {
    const results: ConcurrencyResult[] = [];
    let ready = 0;
    let exited = 0;
    let settled = false;
    const finish = () => {
      if (
        !settled &&
        exited === workers.length &&
        results.length === workers.length
      ) {
        settled = true;
        clearTimeout(timeout);
        resolveWorkers(results);
      }
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      void Promise.all(workers.map((worker) => worker.terminate()));
      reject(error);
    };
    const timeout = setTimeout(
      () => fail(new Error("Indexing worker barrier timed out")),
      10_000,
    );

    for (const worker of workers) {
      worker.on("message", (message: { type?: string } | ConcurrencyResult) => {
        if (message.type === "ready") {
          ready += 1;
          if (ready === workers.length) {
            for (const readyWorker of workers) {
              readyWorker.postMessage("go");
            }
          }
          return;
        }
        if (message.type === "result") {
          results.push(message as ConcurrencyResult);
          finish();
        }
      });
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (code !== 0) {
          fail(new Error(`Indexing worker exited with code ${code}`));
          return;
        }
        exited += 1;
        finish();
      });
    }
  });
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
      tempFilePath: await realpath(
        join(context.uploadDirectory, uploadEntries[0] ?? ""),
      ),
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

  it("hardens a pre-existing permissive temporary directory and creates uploads as 0600", async () => {
    const context = await createTestContext(
      {},
      async (_root, uploadDirectory) => {
        await mkdir(uploadDirectory, { mode: 0o755 });
        await chmod(uploadDirectory, 0o755);
      },
    );
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido privado institucional."],
    ]);

    const response = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-private-file-mode",
    });
    const [storedFilename] = await uploadEntries(context.uploadDirectory);

    expect(response.status).toBe(202);
    expect((await stat(context.uploadDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(context.uploadDirectory, storedFilename ?? ""))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("rejects a symlinked temporary directory without writing into its target", async () => {
    const context = await createTestContext(
      {},
      async (root, uploadDirectory) => {
        const target = join(root, "symlink-target");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, uploadDirectory, "dir");
      },
    );
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido privado institucional."],
    ]);

    const response = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-symlink-storage",
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("UPLOAD_STORAGE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain(context.root);
    expect(await uploadEntries(join(context.root, "symlink-target"))).toEqual(
      [],
    );
  });

  it("rejects a non-directory temporary path through a safe storage response", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-indexing-test-"));
    temporaryDirectories.push(root);
    const uploadPath = join(root, "uploads");
    await writeFile(uploadPath, "not a directory");
    const config = loadConfig({
      AUTH_TOKEN,
      DATABASE_PATH: join(root, "connectia.sqlite"),
      TEMP_DIR: uploadPath,
    });
    const composition = createIndexingComposition(config);
    compositions.push(composition);
    let app: ReturnType<typeof createApp> | undefined;

    expect(() => {
      app = createApp({
        config,
        logger: pino({ level: "silent" }),
        indexingService: composition.indexingService,
      });
    }).not.toThrow();
    if (!app) {
      return;
    }
    const pdfPath = await createTestPdf(root, [
      ["MATRÍCULA", "Contenido privado institucional."],
    ]);
    const response = await request(app)
      .post("/api/v1/indexing/jobs")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .set("Idempotency-Key", "index-nondirectory-storage")
      .field("documentId", randomUUID())
      .field("versionId", randomUUID())
      .field("title", "Matrícula")
      .field("academicYear", "2026-2027")
      .attach("file", pdfPath, "matricula.pdf");

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("UPLOAD_STORAGE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it("safely rejects Busboy's real finite 16 KiB part-header boundary and cleans prior files", async () => {
    const context = await createTestContext();
    const boundary = "connectia-header-boundary";
    const requestBody = rawMultipartBody(boundary, [
      {
        headers: [
          'Content-Disposition: form-data; name="file"; filename="private.pdf"',
          "Content-Type: application/pdf",
        ],
        body: "%PDF-private-content",
      },
      {
        headers: [
          'Content-Disposition: form-data; name="title"',
          `X-Oversized-Header: ${"sensitive".repeat(2_100)}`,
        ],
        body: "Matrícula",
      },
    ]);

    const response = await request(context.app)
      .post("/api/v1/indexing/jobs")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .set("Idempotency-Key", "index-header-boundary")
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(requestBody);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("MULTIPART_INVALID");
    expect(JSON.stringify(response.body)).not.toContain("sensitive");
    expect(JSON.stringify(response.body)).not.toContain(context.root);
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
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

  it("canonicalizes UUID casing before replay hashing and persistence", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido de identidad canónica."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const first = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-uuid-replay",
      documentId,
      versionId,
    });

    const replay = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-uuid-replay",
      documentId: documentId.toUpperCase(),
      versionId: versionId.toUpperCase(),
    });

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.jobId).toBe(first.body.jobId);
    expect(
      context.composition.database
        .prepare("SELECT id, document_id AS documentId FROM document_versions")
        .all(),
    ).toEqual([{ id: versionId, documentId }]);
  });

  it("does not create case-distinct UUID identities under a different key", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido de identidad estable."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();

    const first = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-uuid-first",
      documentId,
      versionId,
    });
    const second = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-uuid-second",
      documentId: documentId.toUpperCase(),
      versionId: versionId.toUpperCase(),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(
      context.composition.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM document_versions) AS versions, (SELECT COUNT(*) FROM indexing_jobs) AS jobs",
        )
        .get(),
    ).toEqual({ documents: 1, versions: 1, jobs: 2 });
  });

  it("normalizes canonically equivalent Spanish metadata to NFC before hashing and persistence", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido Unicode institucional."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const decomposedTitle = "Matri\u0301cula 2026-2027";
    const decomposedDescription = "Informacio\u0301n acade\u0301mica";

    const first = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-unicode",
      documentId,
      versionId,
      title: `  ${decomposedTitle}  `,
      description: `  ${decomposedDescription}  `,
    });
    const replay = await sendPdf(context, pdfPath, {
      idempotencyKey: "index-canonical-unicode",
      documentId,
      versionId,
      title: "Matrícula 2026-2027",
      description: "Información académica",
    });

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.jobId).toBe(first.body.jobId);
    expect(
      context.composition.database
        .prepare("SELECT title, description FROM documents")
        .get(),
    ).toEqual({
      title: "Matrícula 2026-2027",
      description: "Información académica",
    });
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

  it("retries cleanup transiently and preserves the validation response after cleanup succeeds", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido para limpieza transitoria."],
    ]);
    let attempts = 0;
    const cleanupApp = appWithUploadUnlink(context, async (path) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient private cleanup failure");
      }
      await rm(path);
    });

    const response = await sendPdf({ ...context, app: cleanupApp }, pdfPath, {
      idempotencyKey: "index-cleanup-retry",
      title: "   ",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INDEXING_METADATA_INVALID");
    expect(attempts).toBe(3);
    expect(await uploadEntries(context.uploadDirectory)).toEqual([]);
  });

  it.each([
    { branch: "validation", expectedPrimary: 400 },
    { branch: "replay", expectedPrimary: 202 },
    { branch: "conflict", expectedPrimary: 409 },
    { branch: "persistence", expectedPrimary: 500 },
  ])(
    "returns a safe observable 5xx when $branch cleanup exhausts retries",
    async ({ branch, expectedPrimary }) => {
      const context = await createTestContext();
      const firstPdf = await createTestPdf(context.root, [
        ["MATRÍCULA", "Primer contenido para fallo de limpieza."],
      ]);
      const secondPdf = await createTestPdf(context.root, [
        ["MATRÍCULA", "Segundo contenido para fallo de limpieza."],
      ]);
      const documentId = randomUUID();
      const versionId = randomUUID();
      const idempotencyKey = `index-cleanup-failure-${branch}`;
      if (branch === "replay" || branch === "conflict") {
        const accepted = await sendPdf(context, firstPdf, {
          idempotencyKey,
          documentId,
          versionId,
        });
        expect(accepted.status).toBe(202);
      }
      if (branch === "persistence") {
        context.composition.database.exec(`
          CREATE TRIGGER reject_cleanup_test_job
          BEFORE INSERT ON indexing_jobs
          BEGIN
            SELECT RAISE(ABORT, 'private persistence error');
          END;
        `);
      }
      let attempts = 0;
      const cleanupApp = appWithUploadUnlink(context, async () => {
        attempts += 1;
        throw new Error("private cleanup path and details");
      });
      const requestPdf = branch === "conflict" ? secondPdf : firstPdf;
      const response = await sendPdf(
        { ...context, app: cleanupApp },
        requestPdf,
        {
          idempotencyKey,
          documentId,
          versionId,
          ...(branch === "validation" ? { title: "   " } : {}),
        },
      );

      expect(expectedPrimary).not.toBe(503);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("UPLOAD_CLEANUP_FAILED");
      expect(attempts).toBe(3);
      expect(JSON.stringify(response.body)).not.toContain("private");
      expect(JSON.stringify(response.body)).not.toContain(context.root);
      expect(await uploadEntries(context.uploadDirectory)).toHaveLength(
        branch === "replay" || branch === "conflict" ? 2 : 1,
      );
    },
  );

  it("promotes Multer automatic cleanup failure to a safe storage 5xx", async () => {
    const context = await createTestContext({ MAX_PDF_BYTES: "512" });
    const oversized = join(context.root, "oversized-cleanup.pdf");
    await writeFile(
      oversized,
      Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(508)]),
    );
    let attempts = 0;
    const cleanupApp = appWithUploadUnlink(context, async () => {
      attempts += 1;
      throw new Error("private Multer cleanup failure");
    });

    const response = await sendPdf({ ...context, app: cleanupApp }, oversized, {
      idempotencyKey: "index-multer-cleanup-failure",
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("UPLOAD_CLEANUP_FAILED");
    expect(attempts).toBe(3);
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(await uploadEntries(context.uploadDirectory)).toHaveLength(1);
  });

  it("sweeps only unreferenced server-owned upload files and preserves live/unrelated entries", async () => {
    const context = await createTestContext();
    const acceptedPdf = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido referenciado por un trabajo vivo."],
    ]);
    const accepted = await sendPdf(context, acceptedPdf, {
      idempotencyKey: "index-live-upload",
    });
    expect(accepted.status).toBe(202);
    const orphan = join(
      context.uploadDirectory,
      `connectia-upload-${randomUUID()}.pdf`,
    );
    const unrelated = join(context.uploadDirectory, "operator-note.txt");
    await writeFile(orphan, "%PDF-orphan");
    await writeFile(unrelated, "preserve this file");

    expect(context.composition.sweepOrphans).toBeTypeOf("function");
    if (typeof context.composition.sweepOrphans !== "function") {
      return;
    }
    const removed = await context.composition.sweepOrphans();
    const entries = await uploadEntries(context.uploadDirectory);

    expect(removed).toBe(1);
    expect(entries).toContain("operator-note.txt");
    expect(entries).not.toContain(orphan.split("/").at(-1));
    expect(
      entries.filter((entry) => entry.startsWith("connectia-upload-")),
    ).toHaveLength(1);
  });

  it("serializes identical same-key requests across two worker connections", async () => {
    const context = await createTestContext();
    const pdfPath = await createTestPdf(context.root, [
      ["MATRÍCULA", "Contenido concurrente institucional."],
    ]);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const input: IndexingRequest = {
      idempotencyKey: "index-concurrent-request",
      documentId,
      versionId,
      title: "Matrícula 2026-2027",
      academicYear: "2026-2027",
      description: null,
      tempFilePath: pdfPath,
    };

    const results = await runConcurrentIndexingWorkers([
      { config: context.config, input },
      { config: context.config, input },
    ]);
    const jobIds = results.flatMap((result) =>
      "jobId" in result ? [result.jobId] : [],
    );

    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(jobIds).toHaveLength(2);
    expect(new Set(jobIds).size).toBe(1);
    expect(
      context.composition.database
        .prepare("SELECT COUNT(*) AS count FROM indexing_jobs")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("returns one conflict for different same-key bytes across two worker connections", async () => {
    const context = await createTestContext();
    const firstPdf = await createTestPdf(context.root, [
      ["MATRÍCULA", "Primer contenido concurrente."],
    ]);
    const secondPdf = await createTestPdf(context.root, [
      ["MATRÍCULA", "Segundo contenido concurrente."],
    ]);
    const common = {
      idempotencyKey: "index-concurrent-conflict",
      documentId: randomUUID(),
      versionId: randomUUID(),
      title: "Matrícula 2026-2027",
      academicYear: "2026-2027",
      description: null,
    };

    const results = await runConcurrentIndexingWorkers([
      {
        config: context.config,
        input: { ...common, tempFilePath: firstPdf },
      },
      {
        config: context.config,
        input: { ...common, tempFilePath: secondPdf },
      },
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(results).toContainEqual({
      type: "result",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(
      context.composition.database
        .prepare("SELECT COUNT(*) AS count FROM indexing_jobs")
        .get(),
    ).toEqual({ count: 1 });
  });
});
