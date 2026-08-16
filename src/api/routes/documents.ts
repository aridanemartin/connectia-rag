import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { LifecycleReader } from "../../documents/lifecycle.service.js";
import {
  ActivityNotAcceptedError,
  type ActivityTracker,
} from "../../shared/activity-tracker.js";
import { AppError } from "../errors.js";

const paramsSchema = z
  .object({
    documentId: z.uuid().transform((value) => value.toLowerCase()),
    versionId: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();

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
      response.status(200).json({ documentId, versionId, state: result.state });
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
  return handler;
}

export function createDocumentsRouter(
  lifecycle: LifecycleReader,
  activity?: ActivityTracker,
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

  return router;
}
