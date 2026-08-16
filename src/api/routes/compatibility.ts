import { Router } from "express";
import { z } from "zod";
import type { LifecycleReader } from "../../documents/lifecycle.service.js";
import type { QuestionService } from "../../rag/question.service.js";
import {
  ActivityNotAcceptedError,
  type ActivityTracker,
} from "../../shared/activity-tracker.js";
import { AppError } from "../errors.js";
import type { IndexingJobStatusReader } from "./indexing.js";
import { mapQuestionError, setRetryAfterIfSaturated } from "./questions.js";

const NOT_FOUND_FALLBACK =
  "No se encontró información suficiente en los documentos activos.";

const askBodySchema = z.object({
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
  documentIds: z.array(z.uuid()).optional(),
});

function progressDescription(stage: string): string {
  switch (stage) {
    case "queued":
      return "En cola";
    case "extracting":
      return "Extrayendo el texto del PDF";
    case "chunking":
      return "Dividiendo el documento en fragmentos";
    case "embedding":
      return "Generando los embeddings del documento";
    case "storing":
      return "Almacenando los fragmentos en el índice";
    case "finalizing":
      return "Finalizando la indexación";
    case "completed":
      return "Completado";
    default:
      return "Procesando";
  }
}

function mapJobStatus(status: string): string {
  return status === "failed" ? "error" : status;
}

export function createHealthCompatibilityRouter(): Router {
  const router = Router();
  router.get("/", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  return router;
}

export function createCompatibilityRouter(
  lifecycle: LifecycleReader,
  questionService: Pick<QuestionService, "ask">,
  jobStatusReader: IndexingJobStatusReader,
  activity?: ActivityTracker,
): Router {
  const router = Router();

  router.post("/ask", (request, response, next) => {
    const execute = async () => {
      try {
        const parsed = askBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError(
            400,
            "QUESTION_INVALID",
            "La pregunta debe tener entre 1 y 1000 caracteres.",
          );
        }
        const allowedVersionIds = parsed.data.documentIds
          ? lifecycle.allowedActiveVersionsByDocumentIds(
              parsed.data.documentIds,
            )
          : lifecycle.allowedActiveVersions();

        if (allowedVersionIds.length === 0) {
          response.status(200).json({
            answer: NOT_FOUND_FALLBACK,
            citations: [],
            status: "not_found",
          });
          return;
        }

        const result = await questionService.ask(
          parsed.data.question,
          allowedVersionIds,
        );

        if (result.status !== "found") {
          response.status(200).json({
            answer: NOT_FOUND_FALLBACK,
            citations: [],
            status: result.status,
          });
          return;
        }

        response.status(200).json({
          answer: result.answer,
          citations: result.citations.map((citation) => ({
            documentId: citation.documentId,
            title: citation.documentTitle,
            excerpt: citation.excerpt,
          })),
        });
      } catch (error) {
        throw mapQuestionError(error);
      }
    };

    if (!activity) {
      void execute().catch(next);
      return;
    }
    void activity
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
  });

  router.get("/api/v1/admin/jobs/:id/status", (request, response, next) => {
    const parsedId = z.uuid().safeParse(request.params.id);
    if (!parsedId.success) {
      next(
        new AppError(
          400,
          "JOB_ID_INVALID",
          "El identificador del trabajo no es válido.",
        ),
      );
      return;
    }
    const job = jobStatusReader.find(parsedId.data);
    if (!job) {
      next(
        new AppError(
          404,
          "JOB_NOT_FOUND",
          "No se ha encontrado el trabajo de indexación.",
        ),
      );
      return;
    }
    response.status(200).json({
      id: job.id,
      status: mapJobStatus(job.status),
      progressDescription: progressDescription(job.stage),
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      completedAt: job.completedAt,
    });
  });

  return router;
}
