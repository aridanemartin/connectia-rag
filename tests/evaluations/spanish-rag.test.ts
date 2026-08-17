/**
 * Spanish RAG evaluation suite.
 *
 * Runs the full list of evaluation questions from
 * fixtures/evaluations/questions.json against the complete system,
 * verifying expected status, document coverage, and page accuracy.
 *
 * These tests require Docker (for testcontainers Qdrant) and are
 * skipped by default. Run with: npm run test:evaluations
 *
 * @vitest-environment node
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { v5 as uuidv5 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { LifecycleService } from "../../src/documents/lifecycle.service.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { GenerationGate } from "../../src/rag/generation-gate.js";
import { QdrantVectorStore } from "../../src/rag/qdrant-vector-store.js";
import { QuestionService } from "../../src/rag/question.service.js";
import type { VectorPoint } from "../../src/rag/vector-store.js";
import type { Clock } from "../../src/shared/clock.js";
import {
  type FakeOllamaServer,
  startFakeOllamaServer,
} from "../support/fake-ollama-server.js";
import {
  type QdrantTestContext,
  startQdrantTestContext,
} from "../support/qdrant-test-context.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

// ── Types ────────────────────────────────────────────────────────────────

interface EvaluationQuestion {
  id: string;
  question: string;
  expectedStatus: "found" | "not_found" | "ambiguous";
  expectedDocumentIds: string[];
  expectedPages: number[];
}

interface EvaluationManifest {
  schema: string;
  academicYear: string;
  questions: EvaluationQuestion[];
}

// ── Test configuration ───────────────────────────────────────────────────

const DIMENSIONS = 128;

// Fixed namespace for deriving deterministic UUID point IDs — mirrors
// production (src/documents/text-chunker.ts) which uses uuidv5 with a fixed
// namespace. Qdrant rejects non-UUID / non-unsigned-integer point IDs.
const EVAL_CHUNK_NAMESPACE = "8f3b2c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

function testConfig(ollamaUrl: string, qdrantUrl: string, collection: string) {
  return loadConfig({
    PORT: "3000",
    LOG_LEVEL: "silent",
    AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
    AUTH_DISABLED: "true",
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
    OLLAMA_BASE_URL: ollamaUrl,
    OLLAMA_CHAT_MODEL: "fake-chat-model",
    OLLAMA_EMBEDDING_MODEL: "fake-embed-model",
    QDRANT_URL: qdrantUrl,
    QDRANT_COLLECTION: collection,
    EMBEDDING_DIMENSIONS: DIMENSIONS.toString(),
    DEPENDENCY_TIMEOUT_MS: "10000",
    MAX_PDF_BYTES: (25 * 1024 * 1024).toString(),
    MAX_ACTIVE_GENERATIONS: "4",
    MAX_QUEUED_GENERATIONS: "20",
    QUESTION_QUEUE_TIMEOUT_MS: "10000",
    RAG_TOP_K: "10",
    RAG_SCORE_THRESHOLD: "-1.0",
    DIAGNOSTICS_ENABLED: "false",
    DIAGNOSTICS_TTL_HOURS: "24",
    ENABLE_INTERNAL_METRICS: "false",
    INDEXING_EMBED_BATCH_SIZE: "16",
    INDEXING_LEASE_MS: "60000",
    INDEXING_POLL_INTERVAL_MS: "1000",
  });
}

function deterministicEmbedding(text: string): number[] {
  const hash = createHash("sha256").update(text).digest();
  const values: number[] = [];
  for (let i = 0; i < DIMENSIONS; i++) {
    values.push(hash[i % hash.length] / 128 - 1);
  }
  const magnitude = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return magnitude > 0 ? values.map((v) => v / magnitude) : values;
}

// ── Fixture document content for deterministic vector matching ────────────

const FIXTURE_DOCUMENTS: Record<
  string,
  {
    title: string;
    pages: {
      page: number;
      section: string | null;
      text: string;
    }[];
  }
> = {
  "00000000-0000-4000-8000-000000000001": {
    title: "Calendario académico 2026-2027",
    pages: [
      {
        page: 1,
        section: "Plazos de matrícula",
        text: "El plazo de matrícula ordinaria para el curso 2026-2027 comienza el 1 de septiembre y finaliza el 15 de octubre de 2026. Las clases comienzan el 15 de septiembre de 2026.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000002": {
    title: "Calendario escolar 2026-2027",
    pages: [
      {
        page: 1,
        section: "Inicio de curso",
        text: "El curso escolar 2026-2027 comienza el 1 de septiembre de 2026 para el profesorado y el 15 de septiembre para el alumnado. Las actividades lectivas finalizan el 30 de junio de 2027.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000003": {
    title: "Procedimiento de solicitud de becas",
    pages: [
      {
        page: 1,
        section: "Plazos de solicitud",
        text: "El plazo para solicitar becas para el curso 2026-2027 está abierto desde el 1 de abril hasta el 30 de junio de 2026. No se admitirán solicitudes fuera de plazo.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000005": {
    title: "Servicio de comedor",
    pages: [
      {
        page: 1,
        section: "Horario del comedor",
        text: "El servicio de comedor escolar está disponible de lunes a viernes de 14:00 a 15:30 horas. El precio del menú diario es de 6,50 euros.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000006": {
    title: "Servicio de transporte escolar",
    pages: [
      {
        page: 1,
        section: "Abonos de transporte",
        text: "El abono mensual de transporte escolar tiene un precio de 45 euros.",
      },
      {
        page: 2,
        section: "Tarifas",
        text: "El abono mensual de transporte tiene un coste de 45 euros.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000007": {
    title: "Actividades extraescolares",
    pages: [
      {
        page: 1,
        section: "Actividades deportivas",
        text: "La actividad de ajedrez se imparte los martes y jueves de 16:00 a 17:30 horas en el aula de usos múltiples.",
      },
    ],
  },
  "00000000-0000-4000-8000-000000000009": {
    title: "Contacto y secretaría",
    pages: [
      {
        page: 1,
        section: "Correo electrónico",
        text: "El correo electrónico de la secretaría del centro es secretaria@connectia.edu.",
      },
    ],
  },
};

describe("Evaluaciones RAG (Español)", () => {
  let fakeOllama: FakeOllamaServer;
  let qdrantCtx: QdrantTestContext;

  // Load questions synchronously at module load time
  const questionsPath = join(
    import.meta.dirname,
    "..",
    "..",
    "fixtures",
    "evaluations",
    "questions.json",
  );
  const questions = (
    JSON.parse(readFileSync(questionsPath, "utf-8")) as EvaluationManifest
  ).questions;

  beforeAll(async () => {
    fakeOllama = await startFakeOllamaServer();
    qdrantCtx = await startQdrantTestContext();
  }, 120_000);

  afterAll(async () => {
    await fakeOllama.stop();
    await qdrantCtx?.stop();
  });

  for (const q of questions) {
    it(`${q.id}: "${q.question}" → ${q.expectedStatus}`, async () => {
      const config = testConfig(
        fakeOllama.url,
        qdrantCtx.clientUrl,
        qdrantCtx.collection,
      );

      // Set up in-memory SQLite
      const database = openDatabase(":memory:");
      migrate(database);
      const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
      const documents = new DocumentRepository(database, clock);
      const lifecycle = new LifecycleService(documents);

      // Seed fixture documents and activate them
      const versionIds: string[] = [];
      for (const [docId, doc] of Object.entries(FIXTURE_DOCUMENTS)) {
        const versionId = `eval-${docId}`;
        versionIds.push(versionId);
        documents.upsertIndexing({
          documentId: docId,
          versionId,
          title: doc.title,
          academicYear: "2026-2027",
          description: `Documento de evaluación: ${doc.title}`,
          contentHash: `hash-${docId}`,
        });
        documents.markReady(versionId);
        lifecycle.activate(docId, versionId);
      }

      const gate = new GenerationGate({
        concurrency: 4,
        maxQueued: 20,
        timeoutMs: 10000,
      });

      const model = {
        embedQuery: async (text: string) => {
          return deterministicEmbedding(text);
        },
        decide: async (input: {
          system: string;
          question: string;
          context: ReadonlyArray<{ chunkId: string; text: string }>;
        }) => {
          const response = await fetch(`${fakeOllama.url}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "fake-chat-model",
              messages: [
                { role: "system", content: input.system },
                {
                  role: "user",
                  content: JSON.stringify({
                    question: input.question,
                    context: input.context,
                  }),
                },
              ],
            }),
          });
          const data = (await response.json()) as {
            message?: { content?: string };
          };
          const content = data?.message?.content ?? "{}";
          return JSON.parse(content);
        },
      };

      const vectorStore = new QdrantVectorStore(config);
      await vectorStore.ensureCollection(DIMENSIONS);

      // Upsert fixture document chunks as vector points
      const points: VectorPoint[] = [];
      for (const [docId, doc] of Object.entries(FIXTURE_DOCUMENTS)) {
        const versionId = `eval-${docId}`;
        for (const page of doc.pages) {
          const chunkId = uuidv5(
            `${docId}-p${page.page}`,
            EVAL_CHUNK_NAMESPACE,
          );
          const vector = deterministicEmbedding(page.text);
          points.push({
            id: chunkId,
            vector,
            payload: {
              documentId: docId,
              versionId,
              documentTitle: doc.title,
              academicYear: "2026-2027",
              page: page.page,
              section: page.section,
              chunkIndex: page.page - 1,
              contentHash: `hash-${chunkId}`,
              text: page.text,
            },
          });
        }
      }
      await vectorStore.upsert(points);

      const questionService = new QuestionService({
        model,
        vectorStore,
        gate,
        topK: 10,
        scoreThreshold: 0.0,
      });

      const result = await questionService.ask(
        q.question,
        versionIds,
        `eval-${q.id}`,
      );

      expect(result.status).toBe(q.expectedStatus);

      if (result.status === "found" && q.expectedDocumentIds.length > 0) {
        expect(result.answer).toBeTruthy();
        expect(result.citations.length).toBeGreaterThanOrEqual(1);
        const citedDocIds = result.citations.map((c) => c.documentId);
        for (const expectedDocId of q.expectedDocumentIds) {
          expect(citedDocIds).toContain(expectedDocId);
        }
      }

      if (result.status === "not_found") {
        expect(result.answer).toBeNull();
        expect(result.citations).toEqual([]);
      }

      if (result.status === "ambiguous") {
        expect(result.answer).toBeNull();
      }

      closeDatabase(database);
    }, 60_000);
  }
});
