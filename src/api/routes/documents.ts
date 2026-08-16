import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import {
  InvalidStateTransitionError,
  PersistenceNotFoundError,
} from "../../documents/document.types.js";
import type { LifecycleReader } from "../../documents/lifecycle.service.js";
import type { QuestionService } from "../../rag/question.service.js";
import {
  ActivityNotAcceptedError,
  type ActivityTracker,
} from "../../shared/activity-tracker.js";
import { AppError } from "../errors.js";
import { mapQuestionError, setRetryAfterIfSaturated } from "./questions.js";

const paramsSchema = z
  .object({
    documentId: z.uuid().transform((value) => value.toLowerCase()),
    versionId: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();

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

function mapLifecycleError(error: unknown): never {
  if (error instanceof InvalidStateTransitionError) {
    throw new AppError(
      409,
      "VERSION_NOT_READY",
      "La versión del documento no está lista para activar.",
    );
  }
  if (error instanceof PersistenceNotFoundError) {
    throw new AppError(
      404,
      "VERSION_NOT_FOUND",
      "No se ha encontrado la versión del documento.",
    );
  }
  throw error;
}

function runWithActivity(
  activity: ActivityTracker | undefined,
  execute: () => Promise<void>,
  next: NextFunction,
  response?: Response,
): void {
  if (!activity) {
    void execute().catch(next);
    return;
  }
  void activity
    .run(async () => {
      try {
        await execute();
      } catch (error) {
        if (response) {
          setRetryAfterIfSaturated(error, response);
        }
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
}

function lifecycleAction(
  lifecycle: LifecycleReader,
  action: "activate" | "archive",
  activity?: ActivityTracker,
): RequestHandler {
  const handler = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    const execute = async () => {
      try {
        const parsed = paramsSchema.safeParse(request.params);
        if (!parsed.success) {
          throw new AppError(
            400,
            "DOCUMENT_PARAMS_INVALID",
            "Los identificadores del documento no son válidos.",
          );
        }
        const { documentId, versionId } = parsed.data;
        const result = lifecycle[action](documentId, versionId);
        response
          .status(200)
          .json({ documentId, versionId, state: result.state });
      } catch (error) {
        throw mapLifecycleError(error);
      }
    };

    runWithActivity(activity, execute, next, response);
  };
  return handler;
}

function previewAction(
  lifecycle: LifecycleReader,
  questionService: Pick<QuestionService, "ask">,
  activity?: ActivityTracker,
): RequestHandler {
  const handler = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    const execute = async () => {
      try {
        const parsed = paramsSchema.safeParse(request.params);
        if (!parsed.success) {
          throw new AppError(
            400,
            "DOCUMENT_PARAMS_INVALID",
            "Los identificadores del documento no son válidos.",
          );
        }
        const body = questionBodySchema.safeParse(request.body);
        if (!body.success) {
          throw new AppError(
            400,
            "QUESTION_INVALID",
            "La pregunta debe tener entre 1 y 1000 caracteres.",
          );
        }
        let previewVersionIds: string[];
        try {
          previewVersionIds = lifecycle.allowedPreviewVersions(
            parsed.data.documentId,
            parsed.data.versionId,
          );
        } catch (error) {
          if (error instanceof InvalidStateTransitionError) {
            throw new AppError(
              409,
              "VERSION_NOT_PREVIEWABLE",
              "La versión del documento no se puede previsualizar.",
            );
          }
          if (error instanceof PersistenceNotFoundError) {
            throw new AppError(
              404,
              "VERSION_NOT_FOUND",
              "No se ha encontrado la versión del documento.",
            );
          }
          throw error;
        }
        const result = await questionService.ask(
          body.data.question,
          previewVersionIds,
        );
        response.status(200).json({ ...result, requestId: request.requestId });
      } catch (error) {
        throw mapQuestionError(error);
      }
    };

    runWithActivity(activity, execute, next, response);
  };
  return handler;
}

export function createDocumentsRouter(
  lifecycle: LifecycleReader,
  activity?: ActivityTracker,
  questionService?: Pick<QuestionService, "ask">,
): Router {
  const router = Router();

  router.post(
    "/:documentId/versions/:versionId/activate",
    lifecycleAction(lifecycle, "activate", activity),
  );

  router.post(
    "/:documentId/versions/:versionId/archive",
    lifecycleAction(lifecycle, "archive", activity),
  );

  if (questionService) {
    router.post(
      "/:documentId/versions/:versionId/preview",
      previewAction(lifecycle, questionService, activity),
    );
  }

  return router;
}
