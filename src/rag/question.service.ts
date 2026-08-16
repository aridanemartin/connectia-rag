import type { ModelProvider } from "../models/model-provider.js";
import { type AnswerDecision, answerDecisionSchema } from "./answer.schema.js";
import {
  buildCitations,
  type Citation,
  deduplicateHits,
} from "./citation.service.js";
import { GROUNDING_SYSTEM_PROMPT } from "./prompt.js";
import type { VectorStore } from "./vector-store.js";

export interface DiagnosticsRecorder {
  record(entry: {
    requestId: string;
    question: string;
    answer: string | null;
    retrievedChunkIds: string[];
  }): Promise<void>;
}

export interface QuestionResponse {
  status: "found" | "not_found" | "ambiguous";
  answer: string | null;
  citations: Citation[];
}

export interface QuestionServiceDependencies {
  model: Pick<ModelProvider, "embedQuery" | "decide">;
  vectorStore: Pick<VectorStore, "search">;
  gate: {
    run<T>(operation: () => Promise<T>): Promise<T>;
  };
  topK: number;
  scoreThreshold: number;
  diagnostics?: DiagnosticsRecorder;
}

function validateQuestion(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > 1000) {
    throw Object.assign(
      new Error("La pregunta debe tener entre 1 y 1000 caracteres."),
      { code: "QUESTION_INVALID" },
    );
  }
  return trimmed;
}

function parseAndValidate(
  raw: unknown,
  retrievedIds: Set<string>,
): AnswerDecision {
  const parsed = answerDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(
      new Error("La respuesta del modelo no tiene el formato esperado."),
      { code: "MODEL_OUTPUT_INVALID" },
    );
  }

  const decision = parsed.data;

  if (decision.status === "found") {
    for (const chunkId of decision.citedChunkIds) {
      if (!retrievedIds.has(chunkId)) {
        throw Object.assign(
          new Error(`El modelo citó un chunk no recuperado: ${chunkId}`),
          { code: "MODEL_OUTPUT_INVALID" },
        );
      }
    }
  }

  return decision;
}

function mapGateError(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: string }).code;
    if (code === "QUEUE_TIMEOUT") {
      throw Object.assign(new Error("La cola de generación ha expirado."), {
        code: "QUESTION_QUEUE_TIMEOUT",
      });
    }
    if (code === "QUEUE_SATURATED") {
      throw Object.assign(new Error("La cola de generación está saturada."), {
        code: "QUESTION_QUEUE_SATURATED",
        retryAfterSeconds:
          (error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 1,
      });
    }
  }
  throw error;
}

export class QuestionService {
  private readonly model: QuestionServiceDependencies["model"];
  private readonly vectorStore: QuestionServiceDependencies["vectorStore"];
  private readonly gate: QuestionServiceDependencies["gate"];
  private readonly topK: number;
  private readonly scoreThreshold: number;
  private readonly diagnostics: QuestionServiceDependencies["diagnostics"];

  constructor(deps: QuestionServiceDependencies) {
    this.model = deps.model;
    this.vectorStore = deps.vectorStore;
    this.gate = deps.gate;
    this.topK = deps.topK;
    this.scoreThreshold = deps.scoreThreshold;
    this.diagnostics = deps.diagnostics;
  }

  async ask(
    question: string,
    allowedVersionIds: string[],
    requestId?: string,
  ): Promise<QuestionResponse> {
    const validatedQuestion = validateQuestion(question);

    const vector = await this.model.embedQuery(validatedQuestion);

    const hits = await this.vectorStore.search(
      vector,
      allowedVersionIds,
      this.topK,
      this.scoreThreshold,
    );

    const uniqueHits = hits.length === 0 ? [] : deduplicateHits(hits);
    const retrievedChunkIds = uniqueHits.map((hit) => hit.id);

    let result: QuestionResponse;
    if (hits.length === 0) {
      result = { status: "not_found", answer: null, citations: [] };
    } else {
      const context = uniqueHits.map((hit) => ({
        chunkId: hit.id,
        text: hit.payload.text,
        documentTitle: hit.payload.documentTitle,
        page: hit.payload.page,
        section: hit.payload.section,
      }));

      let rawDecision: unknown;
      try {
        rawDecision = await this.gate.run(async () => {
          return this.model.decide({
            system: GROUNDING_SYSTEM_PROMPT,
            question: validatedQuestion,
            context,
          });
        });
      } catch (error) {
        mapGateError(error);
      }

      const retrievedIds = new Set(uniqueHits.map((h) => h.id));
      let decision: AnswerDecision;
      try {
        decision = parseAndValidate(rawDecision, retrievedIds);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === "MODEL_OUTPUT_INVALID"
        ) {
          // One repair attempt
          let retryDecision: unknown;
          try {
            retryDecision = await this.gate.run(async () => {
              return this.model.decide({
                system: GROUNDING_SYSTEM_PROMPT,
                question: validatedQuestion,
                context,
              });
            });
          } catch (gateError) {
            mapGateError(gateError);
          }
          decision = parseAndValidate(retryDecision, retrievedIds);
        } else {
          throw error;
        }
      }

      if (decision.status === "found") {
        result = {
          status: "found",
          answer: decision.answer,
          citations: buildCitations(decision.citedChunkIds, uniqueHits),
        };
      } else {
        result = {
          status: decision.status,
          answer: null,
          citations: [],
        };
      }
    }

    await this.diagnostics
      ?.record({
        requestId: requestId ?? "auto",
        question: validatedQuestion,
        answer: result.answer,
        retrievedChunkIds,
      })
      .catch(() => {
        // Diagnostics must never break question answering
      });

    return result;
  }
}
