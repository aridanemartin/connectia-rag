import { randomUUID } from "node:crypto";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import {
  InvalidStateTransitionError,
  PersistenceNotFoundError,
} from "../../src/documents/document.types.js";
import { LifecycleService } from "../../src/documents/lifecycle.service.js";
import {
  closeDatabase,
  type DatabaseConnection,
  openDatabase,
} from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { CleanupRepository } from "../../src/persistence/repositories/cleanup.repository.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import type { Clock } from "../../src/shared/clock.js";
import { CleanupWorker } from "../../src/workers/cleanup.worker.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function createTestDatabase(): DatabaseConnection {
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

describe("LifecycleService", () => {
  it("activates a READY version and returns it as ACTIVE", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();

    documents.upsertIndexing(version);
    documents.markReady(version.versionId);

    const activated = lifecycle.activate(version.documentId, version.versionId);

    expect(activated.state).toBe("ACTIVE");
    expect(lifecycle.allowedActiveVersions()).toEqual([version.versionId]);
    closeDatabase(database);
  });

  it("switches active versions and archives the previous", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const documentId = randomUUID();
    const v1 = indexingVersion(documentId);
    const v2 = indexingVersion(documentId);

    documents.upsertIndexing(v1);
    documents.markReady(v1.versionId);
    lifecycle.activate(documentId, v1.versionId);

    documents.upsertIndexing(v2);
    documents.markReady(v2.versionId);
    lifecycle.activate(documentId, v2.versionId);

    expect(lifecycle.allowedActiveVersions()).toEqual([v2.versionId]);
    expect(documents.findVersion(v1.versionId)?.state).toBe("ARCHIVED");
    expect(cleanups.findByVersion(v1.versionId)).toBeDefined();
    closeDatabase(database);
  });

  it("archive is idempotent and enqueues only one cleanup row", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();

    documents.upsertIndexing(version);
    documents.markReady(version.versionId);
    lifecycle.activate(version.documentId, version.versionId);

    lifecycle.archive(version.documentId, version.versionId);
    lifecycle.archive(version.documentId, version.versionId);

    expect(documents.findVersion(version.versionId)?.state).toBe("ARCHIVED");
    expect(cleanups.list()).toHaveLength(1);
    closeDatabase(database);
  });

  it("returns empty allowedActiveVersions when nothing is active", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);

    expect(lifecycle.allowedActiveVersions()).toEqual([]);
    closeDatabase(database);
  });

  it("builds preview IDs by replacing only the active sibling", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
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
      lifecycle.allowedPreviewVersions(
        candidate.documentId,
        candidate.versionId,
      ),
    ).toEqual([candidate.versionId, other.versionId].sort());
    closeDatabase(database);
  });

  it("excludes archived versions from allowedActiveVersions", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();

    documents.upsertIndexing(version);
    documents.markReady(version.versionId);
    lifecycle.activate(version.documentId, version.versionId);

    expect(lifecycle.allowedActiveVersions()).toEqual([version.versionId]);

    lifecycle.archive(version.documentId, version.versionId);

    expect(lifecycle.allowedActiveVersions()).toEqual([]);
    closeDatabase(database);
  });

  it("throws InvalidStateTransitionError when activating a non-READY version", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();

    documents.upsertIndexing(version);

    expect(() =>
      lifecycle.activate(version.documentId, version.versionId),
    ).toThrow(InvalidStateTransitionError);
    closeDatabase(database);
  });

  it("throws PersistenceNotFoundError when archiving a non-existent version", () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);

    expect(() => lifecycle.archive(randomUUID(), randomUUID())).toThrow(
      PersistenceNotFoundError,
    );
    closeDatabase(database);
  });
});

describe("CleanupWorker", () => {
  function fakeVectorStore() {
    return {
      deleteVersion: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("processes a queued cleanup job and deletes vectors", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const vectorStore = fakeVectorStore();
    const version = indexingVersion();
    documents.upsertIndexing(version);
    cleanups.enqueue(version.versionId);

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("processed");
    expect(vectorStore.deleteVersion).toHaveBeenCalledWith(version.versionId);
    expect(cleanups.findByVersion(version.versionId)).toBeUndefined();
    closeDatabase(database);
  });

  it("returns idle when no cleanup jobs exist", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const cleanups = new CleanupRepository(database, clock);
    const vectorStore = fakeVectorStore();

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
    });

    expect(await worker.runOnce()).toBe("idle");
    expect(vectorStore.deleteVersion).not.toHaveBeenCalled();
    closeDatabase(database);
  });

  it("retries a transient vector store failure with exponential delay", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    cleanups.enqueue(version.versionId);

    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    let deleteCalls = 0;
    const vectorStore = {
      deleteVersion: vi.fn(async () => {
        deleteCalls += 1;
        if (deleteCalls < 3) {
          throw Object.assign(new Error("ECONNRESET"), {
            code: "ECONNRESET",
          });
        }
      }),
    };

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
      sleep,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("processed");
    expect(vectorStore.deleteVersion).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([250, 500]);
    // The job should eventually be completed after the retry succeeds
    expect(cleanups.findByVersion(version.versionId)).toBeUndefined();
    closeDatabase(database);
  });

  it("retries a non-transient failure immediately with delay 0", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    cleanups.enqueue(version.versionId);

    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const vectorStore = {
      deleteVersion: vi.fn(async () => {
        throw new Error("non-transient Qdrant error");
      }),
    };

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
      sleep,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("processed");
    expect(vectorStore.deleteVersion).toHaveBeenCalledTimes(1);
    // Non-transient: retry with delay 0
    expect(sleepCalls).toEqual([]);
    // Job should be retried (back to queued with available_at = now + 0)
    const cleanup = cleanups.findByVersion(version.versionId);
    expect(cleanup).toBeDefined();
    expect(cleanup?.status).toBe("queued");
    closeDatabase(database);
  });

  it("recovers from expired lease and processes the reclaimed job", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const vectorStore = fakeVectorStore();
    const version = indexingVersion();
    documents.upsertIndexing(version);
    const cleanup = cleanups.enqueue(version.versionId);

    // Lease, expire, and recover
    cleanups.leaseNext("stale-owner", 5_000);
    clock.advance(5_001);
    expect(cleanups.recoverExpired()).toBe(1);
    expect(cleanups.find(cleanup.id)?.status).toBe("queued");

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 60_000,
      pollIntervalMs: 1_000,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("processed");
    expect(vectorStore.deleteVersion).toHaveBeenCalledWith(version.versionId);
    expect(cleanups.findByVersion(version.versionId)).toBeUndefined();
    closeDatabase(database);
  });

  it("does not crash when its lease expires mid-processing", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    cleanups.enqueue(version.versionId);

    const vectorStore = {
      deleteVersion: vi.fn(async () => {
        // Simulate lease expiry during vector deletion
        clock.advance(1_000);
        const otherCleanups = new CleanupRepository(database, clock);
        otherCleanups.recoverExpired();
        otherCleanups.leaseNext("other-owner", 60_000);
      }),
    };

    const worker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: "cleanup-1",
      leaseMs: 1,
      pollIntervalMs: 1_000,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("processed");
    // The other owner took over; our worker didn't crash
    expect(cleanups.findByVersion(version.versionId)).toBeDefined();
    closeDatabase(database);
  });
});

describe("Stale vector invariant", () => {
  it("allowedActiveVersions never includes archived versions", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const v1 = indexingVersion();
    const v2 = indexingVersion(v1.documentId);

    documents.upsertIndexing(v1);
    documents.markReady(v1.versionId);
    lifecycle.activate(v1.documentId, v1.versionId);

    // v1 is active: search would include v1
    expect(lifecycle.allowedActiveVersions()).toEqual([v1.versionId]);

    // Activate v2: v1 is archived, search must NOT include v1
    documents.upsertIndexing(v2);
    documents.markReady(v2.versionId);
    lifecycle.activate(v2.documentId, v2.versionId);

    const allowed = lifecycle.allowedActiveVersions();
    expect(allowed).toEqual([v2.versionId]);
    expect(allowed).not.toContain(v1.versionId);

    // Confirm the vector store would only receive the SQLite-derived list
    const fakeSearchCalls: string[][] = [];
    const fakeVectorStore = {
      search: vi.fn(async (...args: unknown[]) => {
        fakeSearchCalls.push(args[1] as string[]);
        return [];
      }),
    };

    // Simulate how QuestionService would call the vector store:
    // it always passes the allowed version IDs from the lifecycle service
    await fakeVectorStore.search(
      [0.1],
      lifecycle.allowedActiveVersions(),
      6,
      0.35,
    );

    expect(fakeSearchCalls).toEqual([[v2.versionId]]);
    expect(fakeSearchCalls[0]).not.toContain(v1.versionId);

    closeDatabase(database);
  });
});

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

function testConfig() {
  return {
    PORT: 3000,
    LOG_LEVEL: "silent" as const,
    AUTH_TOKEN,
    AUTH_DISABLED: false,
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_CHAT_MODEL: "gemma3:12b",
    OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
    QDRANT_URL: "http://localhost:6333",
    QDRANT_COLLECTION: "test",
    EMBEDDING_DIMENSIONS: 1024,
    DEPENDENCY_TIMEOUT_MS: 10_000,
    MAX_PDF_BYTES: 25 * 1024 * 1024,
    MAX_ACTIVE_GENERATIONS: 2,
    MAX_QUEUED_GENERATIONS: 20,
    QUESTION_QUEUE_TIMEOUT_MS: 30_000,
    RAG_TOP_K: 6,
    RAG_SCORE_THRESHOLD: 0.35,
    DIAGNOSTICS_ENABLED: false,
    DIAGNOSTICS_TTL_HOURS: 24,
    ENABLE_INTERNAL_METRICS: false,
    INDEXING_EMBED_BATCH_SIZE: 16,
    INDEXING_LEASE_MS: 60_000,
    INDEXING_POLL_INTERVAL_MS: 1_000,
  };
}

describe("Document lifecycle HTTP routes", () => {
  it("activates a READY version via POST and returns the new state", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    documents.markReady(version.versionId);

    const app = createApp({
      config: testConfig(),
      logger: pino({ level: "silent" }),
      lifecycle,
    });

    const response = await request(app)
      .post(
        `/api/v1/documents/${version.documentId}/versions/${version.versionId}/activate`,
      )
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      documentId: version.documentId,
      versionId: version.versionId,
      state: "ACTIVE",
    });
    closeDatabase(database);
  });

  it("returns 401 without authentication", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);
    const version = indexingVersion();
    documents.upsertIndexing(version);
    documents.markReady(version.versionId);

    const app = createApp({
      config: testConfig(),
      logger: pino({ level: "silent" }),
      lifecycle,
    });

    const response = await request(app).post(
      `/api/v1/documents/${version.documentId}/versions/${version.versionId}/activate`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    closeDatabase(database);
  });

  it("returns 400 for malformed UUID params", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const lifecycle = new LifecycleService(
      new DocumentRepository(
        database,
        new MutableClock(new Date("2026-08-16T10:00:00.000Z")),
      ),
    );

    const app = createApp({
      config: testConfig(),
      logger: pino({ level: "silent" }),
      lifecycle,
    });

    const response = await request(app)
      .post("/api/v1/documents/not-a-uuid/versions/not-a-uuid/activate")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("DOCUMENT_PARAMS_INVALID");
    closeDatabase(database);
  });
});
