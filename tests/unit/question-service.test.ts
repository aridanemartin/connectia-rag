import { describe, expect, it, vi } from "vitest";
import { QuestionService } from "../../src/rag/question.service.js";
import type { SearchHit } from "../../src/rag/vector-store.js";

function fakeModel() {
  return {
    embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    decide: vi.fn(async () => ({
      status: "found",
      answer: "El plazo es el 15 de julio.",
      citedChunkIds: ["chunk-1"],
    })),
    embedDocuments: vi.fn(async () => []),
    health: vi.fn(async () => ({
      ollama: true,
      chat: true,
      embeddings: true,
      dimensions: 3,
    })),
  };
}

function fakeVectorStore(hits: SearchHit[] = []) {
  return {
    search: vi.fn(async () => hits),
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    deleteVersion: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      qdrant: true,
      collection: true,
      dimensions: 3,
    })),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeGate(): {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  stats: () => { active: number; queued: number; capacity: number };
  _mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (fn: () => Promise<any>) => fn());
  return {
    run: mock as any,
    stats: () => ({ active: 0, queued: 0, capacity: 2 }),
    _mock: mock,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeHit(id: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    score: 0.8,
    payload: {
      documentId: "doc-1",
      versionId: "v1",
      documentTitle: "Normativa de matrícula",
      academicYear: "2026-2027",
      page: 2,
      section: "Plazos",
      chunkIndex: 0,
      contentHash: "hash-1",
      text: "El plazo de matrícula termina el 15 de julio de 2026.",
      ...overrides,
    },
    ...overrides,
  };
}

describe("QuestionService", () => {
  it("returns not_found without chat generation when retrieval is empty", async () => {
    const model = fakeModel();
    const vectorStore = fakeVectorStore([]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("¿Cuál es el plazo?", ["v1"]);

    expect(result).toEqual({
      status: "not_found",
      answer: null,
      citations: [],
    });
    expect(model.embedQuery).toHaveBeenCalledWith("¿Cuál es el plazo?");
    expect(model.decide).not.toHaveBeenCalled();
  });

  it("passes context to the model and returns found with citations", async () => {
    const hit = makeHit("chunk-1");
    const model = fakeModel();
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("¿Cuál es el plazo?", ["v1"]);

    expect(result.status).toBe("found");
    expect(result.answer).toBe("El plazo es el 15 de julio.");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      documentId: "doc-1",
      versionId: "v1",
      documentTitle: "Normativa de matrícula",
      page: 2,
      section: "Plazos",
      academicYear: "2026-2027",
    });
    expect(result.citations[0].excerpt).toContain("plazo");
    expect(model.decide).toHaveBeenCalled();
  });

  it("returns not_found when the model says not_found", async () => {
    const hit = makeHit("chunk-1");
    const model = fakeModel();
    (model.decide as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "not_found",
      answer: null,
      citedChunkIds: [],
    });
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("¿Cuál es el horario?", ["v1"]);

    expect(result).toEqual({
      status: "not_found",
      answer: null,
      citations: [],
    });
  });

  it("returns ambiguous when the model says ambiguous", async () => {
    const hit = makeHit("chunk-1");
    const model = fakeModel();
    (model.decide as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "ambiguous",
      answer: null,
      citedChunkIds: [],
    });
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("¿Cuál es la normativa?", ["v1"]);

    expect(result).toEqual({
      status: "ambiguous",
      answer: null,
      citations: [],
    });
  });

  it("rejects a model citation that was not retrieved", async () => {
    const hit = makeHit("chunk-1");
    const model = fakeModel();
    // First call: cites a chunk that wasn't retrieved
    model.decide.mockResolvedValueOnce({
      status: "found",
      answer: "Texto",
      citedChunkIds: ["invented"],
    });
    // Repair call: also cites invalid chunk
    model.decide.mockResolvedValueOnce({
      status: "found",
      answer: "Texto again",
      citedChunkIds: ["invented"],
    });
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    await expect(service.ask("Pregunta", ["v1"])).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(model.decide).toHaveBeenCalledTimes(2);
  });

  it("retries once on invalid output then fails", async () => {
    const hit = makeHit("chunk-1");
    const model = fakeModel();
    // First call: invalid output (empty citedChunkIds for found)
    model.decide
      .mockResolvedValueOnce({
        status: "found",
        answer: "Texto",
        citedChunkIds: [],
      })
      .mockResolvedValueOnce({
        status: "found",
        answer: "Texto again",
        citedChunkIds: ["invented"],
      });
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    await expect(service.ask("Pregunta", ["v1"])).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(model.decide).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates chunk IDs while preserving score order", async () => {
    const hit1 = makeHit("chunk-1", { score: 0.9 });
    const hit2 = makeHit("chunk-1", { score: 0.7 }); // duplicate
    const hit3 = makeHit("chunk-2", { score: 0.6 });
    const model = fakeModel();
    model.decide.mockResolvedValueOnce({
      status: "found",
      answer: "Respuesta",
      citedChunkIds: ["chunk-1", "chunk-2"],
    });
    const vectorStore = fakeVectorStore([hit1, hit2, hit3]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("Pregunta", ["v1"]);

    expect(result.status).toBe("found");
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].excerpt).toBeDefined();
  });

  it("trims excerpts to approximately 300 characters", async () => {
    const longText = "a".repeat(500);
    const hit = makeHit("chunk-1", {
      payload: { ...makeHit("chunk-1").payload, text: longText },
    });
    const model = fakeModel();
    model.decide.mockResolvedValueOnce({
      status: "found",
      answer: "Respuesta",
      citedChunkIds: ["chunk-1"],
    });
    const vectorStore = fakeVectorStore([hit]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("Pregunta", ["v1"]);

    expect(result.citations[0].excerpt).toBe("a".repeat(300));
  });

  it("throws QUESTION_QUEUE_TIMEOUT when the gate times out", async () => {
    const model = fakeModel();
    const vectorStore = fakeVectorStore([makeHit("chunk-1")]);
    const gate = fakeGate();
    gate._mock.mockRejectedValueOnce(
      Object.assign(new Error("queue timeout"), { code: "QUEUE_TIMEOUT" }),
    );
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    await expect(service.ask("Pregunta", ["v1"])).rejects.toMatchObject({
      code: "QUESTION_QUEUE_TIMEOUT",
    });
  });

  it("throws QUESTION_QUEUE_SATURATED when the gate rejects with 429", async () => {
    const model = fakeModel();
    const vectorStore = fakeVectorStore([makeHit("chunk-1")]);
    const gate = fakeGate();
    gate._mock.mockRejectedValueOnce(
      Object.assign(new Error("saturated"), {
        code: "QUEUE_SATURATED",
        retryAfterSeconds: 1,
      }),
    );
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    await expect(service.ask("Pregunta", ["v1"])).rejects.toMatchObject({
      code: "QUESTION_QUEUE_SATURATED",
      retryAfterSeconds: 1,
    });
  });

  it("rejects empty or too-long questions", async () => {
    const model = fakeModel();
    const vectorStore = fakeVectorStore([]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    await expect(service.ask("", ["v1"])).rejects.toMatchObject({
      code: "QUESTION_INVALID",
    });
    await expect(service.ask("a".repeat(1001), ["v1"])).rejects.toMatchObject({
      code: "QUESTION_INVALID",
    });
  });

  it("uses empty version list for not_found when no versions are allowed", async () => {
    const model = fakeModel();
    const vectorStore = fakeVectorStore([]);
    const gate = fakeGate();
    const service = new QuestionService({
      model,
      vectorStore,
      gate,
      topK: 6,
      scoreThreshold: 0.35,
    });

    const result = await service.ask("Pregunta", []);

    expect(result).toEqual({
      status: "not_found",
      answer: null,
      citations: [],
    });
    expect(vectorStore.search).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      6,
      0.35,
    );
  });
});
