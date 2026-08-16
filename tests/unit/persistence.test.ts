import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidStateTransitionError } from "../../src/documents/document.types.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { type Migration, migrate } from "../../src/persistence/migrate.js";
import { CleanupRepository } from "../../src/persistence/repositories/cleanup.repository.js";
import { DiagnosticsRepository } from "../../src/persistence/repositories/diagnostics.repository.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { IndexingJobRepository } from "../../src/persistence/repositories/indexing-job.repository.js";
import type { Clock } from "../../src/shared/clock.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const databaseDirectories: string[] = [];

afterEach(() => {
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTestDatabase() {
  const database = openDatabase(":memory:");
  migrate(database);
  return database;
}

function indexingVersion(documentId = randomUUID(), versionId = randomUUID()) {
  return {
    documentId,
    versionId,
    title: "Normativa de matrícula",
    academicYear: "2026-2027",
    description: "Procedimiento académico vigente",
    contentHash: `content-${versionId}`,
  };
}

function indexingJob(documentId = randomUUID(), versionId = randomUUID()) {
  return {
    id: randomUUID(),
    documentId,
    versionId,
    idempotencyKey: `request-${versionId}`,
    requestHash: `request-hash-${versionId}`,
    contentHash: `content-hash-${versionId}`,
    tempFilePath: `/tmp/${versionId}.pdf`,
  };
}

function runConcurrentMigration(
  databasePath: string,
  barrier: SharedArrayBuffer,
): Promise<{ ok: boolean; error?: string }> {
  const databaseModuleUrl = new URL(
    "../../src/persistence/database.ts",
    import.meta.url,
  ).href;
  const migrateModuleUrl = new URL(
    "../../src/persistence/migrate.ts",
    import.meta.url,
  ).href;
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { closeDatabase, openDatabase } from ${JSON.stringify(databaseModuleUrl)};
    import { migrate } from ${JSON.stringify(migrateModuleUrl)};

    const barrier = new Int32Array(workerData.barrier);
    let reads = 0;
    const sql = "CREATE TABLE IF NOT EXISTS concurrent_probe (id TEXT PRIMARY KEY);";
    const migration = {
      id: "concurrent_migration",
      get sql() {
        reads += 1;
        if (reads === 2) {
          const arrivals = Atomics.add(barrier, 0, 1) + 1;
          if (arrivals < 2) {
            Atomics.wait(barrier, 0, arrivals, 5_000);
          } else {
            Atomics.notify(barrier, 0);
          }
        }
        return sql;
      },
    };
    const database = openDatabase(workerData.databasePath);
    try {
      migrate(database, [migration]);
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error) });
    } finally {
      closeDatabase(database);
    }
  `;

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`data:text/javascript,${encodeURIComponent(source)}`),
      {
        execArgv: ["--import", "tsx"],
        workerData: { databasePath, barrier },
      },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

describe("SQLite migrations", () => {
  it("is idempotent and rejects a changed checksum", () => {
    const database = openDatabase(":memory:");
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const first: Migration = {
      id: "test_migration",
      sql: "CREATE TABLE migration_probe (id TEXT PRIMARY KEY);",
    };

    migrate(database, [first], clock);
    migrate(database, [first], clock);

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count, applied_at AS appliedAt FROM schema_migrations",
        )
        .get(),
    ).toEqual({ count: 1, appliedAt: "2026-08-16T10:00:00.000Z" });
    expect(() =>
      migrate(database, [
        { ...first, sql: "CREATE TABLE changed_probe (id TEXT PRIMARY KEY);" },
      ]),
    ).toThrow(/checksum/i);

    closeDatabase(database);
  });

  it("rolls back an entire failed migration", () => {
    const database = openDatabase(":memory:");

    expect(() =>
      migrate(database, [
        {
          id: "broken_migration",
          sql: "CREATE TABLE should_rollback (id TEXT); INVALID SQL;",
        },
      ]),
    ).toThrow();

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT id FROM schema_migrations WHERE id = 'broken_migration'",
        )
        .get(),
    ).toBeUndefined();

    closeDatabase(database);
  });

  it("opens file databases with durable connection safeguards", () => {
    const directory = mkdtempSync(join(tmpdir(), "connectia-sqlite-"));
    databaseDirectories.push(directory);
    const database = openDatabase(join(directory, "persistence.sqlite"));

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);

    closeDatabase(database);
  });

  it("serializes concurrent migration lookup and application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connectia-migrations-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "concurrent.sqlite");
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

    const results = await Promise.all([
      runConcurrentMigration(databasePath, barrier),
      runConcurrentMigration(databasePath, barrier),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const database = openDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'concurrent_migration'",
        )
        .get(),
    ).toEqual({ count: 1 });
    closeDatabase(database);
  });
});

describe("DocumentRepository", () => {
  it("activates exactly one version and queues cleanup in the same transition", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const documentId = randomUUID();
    const versionA = indexingVersion(documentId);
    const versionB = indexingVersion(documentId);

    documents.upsertIndexing(versionA);
    documents.markReady(versionA.versionId);
    documents.activate(documentId, versionA.versionId);
    documents.upsertIndexing(versionB);
    documents.markReady(versionB.versionId);
    documents.activate(documentId, versionB.versionId);

    expect(documents.activeVersionIds()).toEqual([versionB.versionId]);
    expect(documents.findVersion(versionA.versionId)?.state).toBe("ARCHIVED");
    expect(cleanups.findByVersion(versionA.versionId)?.status).toBe("queued");

    closeDatabase(database);
  });

  it("rejects activating a non-ready version without changing the active set", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const active = indexingVersion();
    const indexing = indexingVersion(active.documentId);
    documents.upsertIndexing(active);
    documents.markReady(active.versionId);
    documents.activate(active.documentId, active.versionId);
    documents.upsertIndexing(indexing);

    expect(() =>
      documents.activate(indexing.documentId, indexing.versionId),
    ).toThrow(/READY/);
    expect(documents.activeVersionIds()).toEqual([active.versionId]);

    closeDatabase(database);
  });

  it("archives idempotently and enqueues only one cleanup row", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    documents.markReady(version.versionId);
    documents.activate(version.documentId, version.versionId);

    const archived = documents.archive(version.documentId, version.versionId);
    const archivedAgain = documents.archive(
      version.documentId,
      version.versionId,
    );

    expect(archived.state).toBe("ARCHIVED");
    expect(archivedAgain).toEqual(archived);
    expect(cleanups.list()).toHaveLength(1);

    closeDatabase(database);
  });

  it("builds preview IDs by replacing only the active sibling", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const documentId = randomUUID();
    const current = indexingVersion(documentId);
    const candidate = indexingVersion(documentId);
    const other = indexingVersion();

    for (const version of [current, candidate, other]) {
      documents.upsertIndexing(version);
      documents.markReady(version.versionId);
    }
    documents.activate(current.documentId, current.versionId);
    documents.activate(other.documentId, other.versionId);

    expect(
      documents.previewVersionIds(candidate.documentId, candidate.versionId),
    ).toEqual([candidate.versionId, other.versionId].sort());

    closeDatabase(database);
  });

  it("rejects markReady when another transition wins the guarded update", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const version = indexingVersion();
    new DocumentRepository(database, clock).upsertIndexing(version);
    const racingClock: Clock = {
      now: () => {
        database
          .prepare(
            "UPDATE document_versions SET state = 'ARCHIVED' WHERE id = ?",
          )
          .run(version.versionId);
        return new Date("2026-08-16T10:00:01.000Z");
      },
    };

    expect(() =>
      new DocumentRepository(database, racingClock).markReady(
        version.versionId,
      ),
    ).toThrow(InvalidStateTransitionError);

    closeDatabase(database);
  });

  it("rejects markFailed when another transition wins the guarded update", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const version = indexingVersion();
    new DocumentRepository(database, clock).upsertIndexing(version);
    const racingClock: Clock = {
      now: () => {
        database
          .prepare("UPDATE document_versions SET state = 'READY' WHERE id = ?")
          .run(version.versionId);
        return new Date("2026-08-16T10:00:01.000Z");
      },
    };

    expect(() =>
      new DocumentRepository(database, racingClock).markFailed(
        version.versionId,
      ),
    ).toThrow(InvalidStateTransitionError);

    closeDatabase(database);
  });
});

describe("IndexingJobRepository", () => {
  it("persists restart-critical upload fields and returns domain names", () => {
    const directory = mkdtempSync(join(tmpdir(), "connectia-jobs-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "jobs.sqlite");
    const database = openDatabase(databasePath);
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    new DocumentRepository(database, clock).upsertIndexing(version);
    const input = indexingJob(version.documentId, version.versionId);

    jobs.enqueue(input);
    closeDatabase(database);

    const reopenedDatabase = openDatabase(databasePath);
    migrate(reopenedDatabase);
    const enqueued = new IndexingJobRepository(reopenedDatabase, clock).find(
      input.id,
    );

    expect(enqueued).toMatchObject({
      ...input,
      status: "queued",
      stage: "queued",
      progress: 0,
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      errorCode: null,
      errorMessage: null,
    });
    expect(Object.keys(enqueued ?? {})).not.toContain("temp_file_path");

    closeDatabase(reopenedDatabase);
  });

  it("returns the original job for a matching idempotency replay and rejects conflicts", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const first = indexingJob(version.documentId, version.versionId);

    expect(jobs.enqueue(first).id).toBe(first.id);
    expect(jobs.enqueue({ ...first, id: randomUUID() }).id).toBe(first.id);
    expect(() =>
      jobs.enqueue({
        ...first,
        id: randomUUID(),
        requestHash: "different-request-hash",
      }),
    ).toThrow(/idempotency/i);

    closeDatabase(database);
  });

  it("rejects a job whose version belongs to another document", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const first = indexingVersion();
    const second = indexingVersion();
    documents.upsertIndexing(first);
    documents.upsertIndexing(second);

    expect(() =>
      jobs.enqueue(indexingJob(first.documentId, second.versionId)),
    ).toThrow(/another document/i);
    expect(
      database.prepare("SELECT id FROM indexing_jobs").get(),
    ).toBeUndefined();

    closeDatabase(database);
  });

  it("leases queued jobs in order and updates progress through completion", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const firstVersion = indexingVersion();
    const secondVersion = indexingVersion();
    documents.upsertIndexing(firstVersion);
    documents.upsertIndexing(secondVersion);
    const first = jobs.enqueue(
      indexingJob(firstVersion.documentId, firstVersion.versionId),
    );
    clock.advance(1);
    jobs.enqueue(
      indexingJob(secondVersion.documentId, secondVersion.versionId),
    );

    expect(jobs.leaseNext("worker-a", 30_000)?.id).toBe(first.id);
    jobs.progress(first.id, "worker-a", "embedding", 55);
    jobs.complete(first.id, "worker-a");

    expect(jobs.find(first.id)).toMatchObject({
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
      leaseOwner: null,
      leaseUntil: null,
      completedAt: "2026-08-16T10:00:00.001Z",
    });

    closeDatabase(database);
  });

  it("reclaims expired leases but fails jobs at the attempt bound", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock, 2);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const job = jobs.enqueue(
      indexingJob(version.documentId, version.versionId),
    );

    jobs.leaseNext("worker-a", 30_000);
    clock.advance(30_001);
    expect(jobs.recoverExpired()).toBe(1);
    expect(jobs.find(job.id)?.status).toBe("queued");

    jobs.leaseNext("worker-b", 30_000);
    clock.advance(30_001);
    expect(jobs.recoverExpired()).toBe(1);
    expect(jobs.find(job.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      errorCode: "ATTEMPT_LIMIT_EXCEEDED",
      leaseOwner: null,
      leaseUntil: null,
    });

    closeDatabase(database);
  });

  it("stores only bounded sanitized failure details", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const job = jobs.enqueue(
      indexingJob(version.documentId, version.versionId),
    );

    jobs.leaseNext("worker-a", 1_000);
    const failed = jobs.fail(
      job.id,
      "worker-a",
      "VECTOR STORE\nUNAVAILABLE",
      `Mensaje seguro\n${"x".repeat(600)}`,
    );

    expect(failed.errorCode).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(failed.errorMessage).not.toContain("\n");
    expect(failed.errorMessage).toHaveLength(500);

    closeDatabase(database);
  });

  it("rejects indexing progress from a non-owner", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const job = jobs.enqueue(
      indexingJob(version.documentId, version.versionId),
    );
    jobs.leaseNext("worker-a", 1_000);

    expect(() => jobs.progress(job.id, "worker-b", "embedding", 55)).toThrow(
      /lease/i,
    );
    expect(jobs.find(job.id)).toMatchObject({
      status: "processing",
      stage: "queued",
      progress: 0,
      leaseOwner: "worker-a",
    });

    closeDatabase(database);
  });

  it("treats the exact indexing lease deadline as expired", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const job = jobs.enqueue(
      indexingJob(version.documentId, version.versionId),
    );
    jobs.leaseNext("worker-a", 1_000);
    clock.advance(1_000);

    expect(() => jobs.complete(job.id, "worker-a")).toThrow(/lease/i);
    expect(jobs.find(job.id)?.status).toBe("processing");

    closeDatabase(database);
  });

  it("fences the previous indexing owner after lease reassignment", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const jobs = new IndexingJobRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const job = jobs.enqueue(
      indexingJob(version.documentId, version.versionId),
    );
    jobs.leaseNext("worker-a", 1_000);
    clock.advance(1_001);
    jobs.recoverExpired();
    jobs.leaseNext("worker-b", 1_000);

    expect(() => jobs.complete(job.id, "worker-a")).toThrow(/lease/i);
    expect(jobs.complete(job.id, "worker-b")?.status).toBe("completed");

    closeDatabase(database);
  });
});

describe("CleanupRepository", () => {
  it("leases, reschedules, and completes durable cleanup work", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);

    expect(cleanups.enqueue(version.versionId).id).toBe(cleanup.id);
    expect(cleanups.leaseNext("cleanup-a", 5_000)?.status).toBe("processing");
    cleanups.retry(
      cleanup.id,
      "cleanup-a",
      "VECTOR_STORE_UNAVAILABLE",
      "Reintento seguro",
      2_000,
    );
    expect(cleanups.leaseNext("cleanup-b", 5_000)).toBeUndefined();
    clock.advance(2_001);
    expect(cleanups.leaseNext("cleanup-b", 5_000)?.attempts).toBe(2);
    expect(cleanups.complete(cleanup.id, "cleanup-b")).toBe(true);
    expect(cleanups.findByVersion(version.versionId)).toBeUndefined();

    closeDatabase(database);
  });

  it("recovers an expired cleanup lease", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);
    cleanups.leaseNext("cleanup-a", 5_000);
    clock.advance(5_001);

    expect(cleanups.recoverExpired()).toBe(1);
    expect(cleanups.find(cleanup.id)?.status).toBe("queued");

    closeDatabase(database);
  });

  it("rejects cleanup retry from a non-owner", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);
    cleanups.leaseNext("cleanup-a", 1_000);

    expect(() =>
      cleanups.retry(
        cleanup.id,
        "cleanup-b",
        "VECTOR_STORE_UNAVAILABLE",
        "Reintento seguro",
        10,
      ),
    ).toThrow(/lease/i);
    expect(cleanups.find(cleanup.id)).toMatchObject({
      status: "processing",
      leaseOwner: "cleanup-a",
      attempts: 1,
    });

    closeDatabase(database);
  });

  it("treats the exact cleanup lease deadline as expired", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);
    cleanups.leaseNext("cleanup-a", 1_000);
    clock.advance(1_000);

    expect(() => cleanups.complete(cleanup.id, "cleanup-a")).toThrow(/lease/i);
    expect(cleanups.find(cleanup.id)?.status).toBe("processing");

    closeDatabase(database);
  });

  it("fences the previous cleanup owner after lease reassignment", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);
    cleanups.leaseNext("cleanup-a", 1_000);
    clock.advance(1_001);
    cleanups.recoverExpired();
    cleanups.leaseNext("cleanup-b", 1_000);

    expect(() =>
      cleanups.retry(
        cleanup.id,
        "cleanup-a",
        "VECTOR_STORE_UNAVAILABLE",
        "Reintento seguro",
        10,
      ),
    ).toThrow(/lease/i);
    expect(cleanups.complete(cleanup.id, "cleanup-b")).toBe(true);

    closeDatabase(database);
  });
});

describe("DiagnosticsRepository", () => {
  it("returns domain entries and purges them exactly at expiry", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const diagnostics = new DiagnosticsRepository(database, clock);
    const entry = diagnostics.insert({
      id: randomUUID(),
      requestId: randomUUID(),
      question: "¿Cuál es el plazo de matrícula?",
      answer: null,
      retrievedChunkIds: ["chunk-2", "chunk-1"],
      expiresAt: "2026-08-17T10:00:00.000Z",
    });

    expect(entry.retrievedChunkIds).toEqual(["chunk-2", "chunk-1"]);
    expect(Object.keys(entry)).not.toContain("retrieved_chunk_ids");
    clock.advance(24 * 60 * 60 * 1000 - 1);
    expect(diagnostics.purgeExpired()).toBe(0);
    clock.advance(1);
    expect(diagnostics.purgeExpired()).toBe(1);
    expect(diagnostics.count()).toBe(0);

    closeDatabase(database);
  });
});
