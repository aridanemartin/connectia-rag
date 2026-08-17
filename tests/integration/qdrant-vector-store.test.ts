/**
 * Integration tests for QdrantVectorStore against a real Qdrant instance
 * running via Testcontainers.
 *
 * These tests require Docker to be available on the host.
 * They are tagged with `--test integration` in the test runner config.
 *
 * NOTE: Qdrant only accepts point IDs that are unsigned integers or UUIDs.
 * All fixture point IDs below are therefore fixed, deterministic UUIDs.
 */

import { describe, expect, it, onTestFinished } from "vitest";
import { QdrantVectorStore } from "../../src/rag/qdrant-vector-store.js";
import type { VectorPoint } from "../../src/rag/vector-store.js";
import {
  type QdrantTestContext,
  startQdrantTestContext,
} from "../support/qdrant-test-context.js";

const DIMENSIONS = 128;

// Fixed, deterministic UUID point IDs (Qdrant rejects non-UUID/unsigned-int IDs)
const POINT_ID_SEARCH = "00000000-0000-4000-8000-0000000000a1";
const POINT_ID_V1 = "00000000-0000-4000-8000-0000000000a2";
const POINT_ID_V2 = "00000000-0000-4000-8000-0000000000a3";
const POINT_ID_P1 = "00000000-0000-4000-8000-0000000000a4";
const POINT_ID_DELETE_1 = "00000000-0000-4000-8000-0000000000a5";
const POINT_ID_DELETE_2 = "00000000-0000-4000-8000-0000000000a6";
const POINT_ID_CLOSE = "00000000-0000-4000-8000-0000000000a7";
const POINT_ID_FAR = "00000000-0000-4000-8000-0000000000a8";

function testConfig(
  qdrantUrl: string,
  collection: string,
  dimensions: number = DIMENSIONS,
) {
  return {
    PORT: 3000,
    LOG_LEVEL: "silent" as const,
    AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
    AUTH_DISABLED: false,
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_CHAT_MODEL: "gemma3:12b",
    OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
    QDRANT_URL: qdrantUrl,
    QDRANT_COLLECTION: collection,
    EMBEDDING_DIMENSIONS: dimensions,
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

function makePoint(
  id: string,
  versionId: string,
  text: string,
  overrides: Partial<VectorPoint["payload"]> = {},
): VectorPoint {
  const seed = id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const vector: number[] = [];
  for (let i = 0; i < DIMENSIONS; i++) {
    vector.push(Math.sin(i * 0.1 + seed) * 0.5);
  }
  return {
    id,
    vector,
    payload: {
      documentId: "doc-integration",
      versionId,
      documentTitle: "Documento de integración",
      academicYear: "2026-2027",
      page: 1,
      section: null,
      chunkIndex: 0,
      contentHash: `hash-${id}`,
      text,
      ...overrides,
    },
  };
}

// These tests require Docker to be running and are skipped by default.
// Run with: npm run test:integration
// Docker must be available on the host.
const describeMaybe = describe; // change to describe.skip to disable

describeMaybe("QdrantVectorStore (real Qdrant via Testcontainers)", () => {
  let ctx: QdrantTestContext;

  it("connects, creates a collection, and reports healthy", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );

    await store.ensureCollection(DIMENSIONS);

    const health = await store.health();
    expect(health.qdrant).toBe(true);
    expect(health.collection).toBe(true);
    expect(health.dimensions).toBe(DIMENSIONS);
  }, 60_000);

  it("upserts points and searches them back", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );
    await store.ensureCollection(DIMENSIONS);

    const vId = "integration-version-1";
    const point = makePoint(
      POINT_ID_SEARCH,
      vId,
      "Texto sobre matrícula escolar.",
    );
    await store.upsert([point]);

    // Search with the same vector should find the point
    const results = await store.search(point.vector, [vId], 10, 0.0);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(POINT_ID_SEARCH);
    expect(results[0].payload.text).toBe("Texto sobre matrícula escolar.");
  }, 60_000);

  it("filters by allowed version IDs", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );
    await store.ensureCollection(DIMENSIONS);

    const v1 = "version-allowed";
    const v2 = "version-blocked";
    await store.upsert([
      makePoint(POINT_ID_V1, v1, "Texto permitido.", {
        documentId: "doc-allowed",
      }),
      makePoint(POINT_ID_V2, v2, "Texto bloqueado.", {
        documentId: "doc-blocked",
      }),
    ]);

    // Search only in v1
    const results = await store.search(
      new Array(DIMENSIONS).fill(0.01),
      [v1],
      10,
      0.0,
    );

    const ids = results.map((r) => r.id);
    expect(ids).toContain(POINT_ID_V1);
    expect(ids).not.toContain(POINT_ID_V2);
  }, 60_000);

  it("returns empty results for version filter with no matches", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );
    await store.ensureCollection(DIMENSIONS);

    await store.upsert([
      makePoint(POINT_ID_P1, "v-present", "Texto presente."),
    ]);

    const results = await store.search(
      new Array(DIMENSIONS).fill(0.01),
      ["v-nonexistent"],
      10,
      0.0,
    );

    expect(results).toEqual([]);
  }, 60_000);

  it("deletes all points for a version", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );
    await store.ensureCollection(DIMENSIONS);

    const vId = "version-to-delete";
    await store.upsert([
      makePoint(POINT_ID_DELETE_1, vId, "Texto a eliminar 1."),
      makePoint(POINT_ID_DELETE_2, vId, "Texto a eliminar 2."),
    ]);

    await store.deleteVersion(vId);

    const results = await store.search(
      new Array(DIMENSIONS).fill(0.01),
      [vId],
      10,
      0.0,
    );
    expect(results).toEqual([]);
  }, 60_000);

  it("returns scores sorted descending by relevance", async () => {
    ctx = await startQdrantTestContext();
    onTestFinished(async () => {
      await ctx?.stop();
    });

    const store = new QdrantVectorStore(
      testConfig(ctx.clientUrl, ctx.collection),
    );
    await store.ensureCollection(DIMENSIONS);

    const vId = "version-scores";
    const closeVector: number[] = [];
    const farVector: number[] = [];
    for (let i = 0; i < DIMENSIONS; i++) {
      closeVector.push(0.1);
      farVector.push(0.1);
    }
    // Point the far vector in a slightly different direction (but still the
    // same side of the origin) so it is returned with a lower score instead of
    // being filtered out by the 0.0 score threshold (a fully opposite vector
    // would have cosine -1.0 and never appear in results).
    farVector[farVector.length - 1] = -0.1;

    await store.upsert([
      {
        id: POINT_ID_CLOSE,
        vector: closeVector,
        payload: {
          documentId: "doc-scores",
          versionId: vId,
          documentTitle: "Cercano",
          academicYear: "2026-2027",
          page: 1,
          section: null,
          chunkIndex: 0,
          contentHash: "hash-close",
          text: "Texto cercano a la consulta.",
        },
      },
      {
        id: POINT_ID_FAR,
        vector: farVector,
        payload: {
          documentId: "doc-scores",
          versionId: vId,
          documentTitle: "Lejano",
          academicYear: "2026-2027",
          page: 1,
          section: null,
          chunkIndex: 0,
          contentHash: "hash-far",
          text: "Texto lejano a la consulta.",
        },
      },
    ]);

    // Search with a query vector close to closeVector
    const query = new Array(DIMENSIONS).fill(0.09);
    const results = await store.search(query, [vId], 10, 0.0);

    expect(results.length).toBe(2);
    // The close point should have a higher score
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].id).toBe(POINT_ID_CLOSE);
  }, 60_000);
});
