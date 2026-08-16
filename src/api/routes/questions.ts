import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { LifecycleReader } from "../../documents/lifecycle.service.js";
import type { QuestionService } from "../../rag/question.service.js";
import {
  ActivityNotAcceptedError,
  type ActivityTracker,
} from "../../shared/activity-tracker.js";
import { AppError } from "../errors.js";

const questionBodySchema = z
  .object({
    question: z
      .string()
      .transform((value) => value.trim().normalize("NFC"))
      .pipe(
        z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
      ),
  })
  .strict();

export function mapQuestionError(error: unknown): never {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    throw error;
  }
  const code = (error as { code: string }).code;
  switch (code) {
    case "QUESTION_INVALID":
      throw new AppError(
        400,
        "QUESTION_INVALID",
        "La pregunta debe tener entre 1 y 1000 caracteres.",
      );
    case "QUESTION_QUEUE_SATURATED":
      throw new AppError(
        429,
        "QUEUE_SATURATED",
        "La cola de generación está saturada. Inténtelo de nuevo.",
      );
    case "QUESTION_QUEUE_TIMEOUT":
      throw new AppError(
        503,
        "QUESTION_QUEUE_TIMEOUT",
        "La pregunta tardó demasiado en procesarse.",
      );
    case "MODEL_OUTPUT_INVALID":
      throw new AppError(
        502,
        "MODEL_OUTPUT_INVALID",
        "El modelo no devolvió una respuesta válida.",
      );
    default:
      throw error;
  }
}

interface QuestionRouteDependencies {
  questionService: Pick<QuestionService, "ask">;
  lifecycle: LifecycleReader;
  activity?: ActivityTracker;
}

export function setRetryAfterIfSaturated(
  error: unknown,
  response: Response,
): void {
  if (
    error instanceof AppError &&
    error.status === 429 &&
    error.code === "QUEUE_SATURATED"
  ) {
    response.setHeader("Retry-After", "1");
  }
}

function canonicalHandler(deps: QuestionRouteDependencies): RequestHandler {
  return (request: Request, response: Response, next) => {
    const execute = async () => {
      try {
        const parsed = questionBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError(
            400,
            "QUESTION_INVALID",
            "La pregunta debe tener entre 1 y 1000 caracteres.",
          );
        }
        const allowedVersionIds = deps.lifecycle.allowedActiveVersions();
        const result = await deps.questionService.ask(
          parsed.data.question,
          allowedVersionIds,
        );
        response.status(200).json({ ...result, requestId: request.requestId });
      } catch (error) {
        throw mapQuestionError(error);
      }
    };

    if (!deps.activity) {
      void execute().catch(next);
      return;
    }
    void deps.activity
      .run(async () => {
        try {
          await execute();
        } catch (error) {
          setRetryAfterIfSaturated(error, response);
          next(error);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ActivityNotAcceptedError) {
          next(
            new AppError(
              503,
              "SERVER_SHUTTING_DOWN",
              "El servidor se está apagando.",
            ),
          );
          return;
        }
        next(error);
      });
  };
}

export function createQuestionsRouter(
  questionService: Pick<QuestionService, "ask">,
  lifecycle: LifecycleReader,
  activity?: ActivityTracker,
): Router {
  const router = Router();
  router.post("/", canonicalHandler({ questionService, lifecycle, activity }));
  return router;
}
