import express, { type Express, type Request, type Response } from "express";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { type AppConfig, loadConfig } from "../config/env.js";
import type { IndexingEnqueuer } from "../documents/indexing.service.js";
import type { LifecycleReader } from "../documents/lifecycle.service.js";
import type {
  UploadFailureReporter,
  UploadUnlink,
} from "../documents/upload-storage.js";
import {
  createDefaultReadiness,
  type Readiness,
} from "../health/readiness.service.js";
import type { QuestionService } from "../rag/question.service.js";
import { ActivityTracker } from "../shared/activity-tracker.js";
import { AppError } from "./errors.js";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { createOpenApiDocument, createSwaggerUiHtml } from "./openapi.js";
import {
  createCompatibilityRouter,
  createHealthCompatibilityRouter,
} from "./routes/compatibility.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createHealthRouter } from "./routes/health.js";
import {
  createIndexingRouter,
  type IndexingJobStatusReader,
} from "./routes/indexing.js";
import { createQuestionsRouter } from "./routes/questions.js";

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readiness: Readiness;
  indexingService: IndexingEnqueuer;
  indexingJobs: IndexingJobStatusReader;
  lifecycle: LifecycleReader;
  questionService: Pick<QuestionService, "ask">;
  uploadUnlink: UploadUnlink;
  uploadFailureReporter: UploadFailureReporter;
  activity: ActivityTracker;
}

function unavailableIndexingService(): IndexingEnqueuer {
  return {
    enqueue: async () => {
      throw new AppError(
        503,
        "INDEXING_UNAVAILABLE",
        "El servicio de indexación no está disponible.",
      );
    },
  };
}

function unavailableIndexingJobs(): IndexingJobStatusReader {
  return { find: () => undefined };
}

function unavailableLifecycle(): LifecycleReader {
  return {
    activate: () => {
      throw new AppError(
        503,
        "LIFECYCLE_UNAVAILABLE",
        "El servicio de ciclo de vida no está disponible.",
      );
    },
    archive: () => {
      throw new AppError(
        503,
        "LIFECYCLE_UNAVAILABLE",
        "El servicio de ciclo de vida no está disponible.",
      );
    },
    allowedActiveVersions: () => [],
    allowedActiveVersionsByDocumentIds: () => [],
    allowedPreviewVersions: () => [],
  };
}

function unavailableQuestionService(): Pick<QuestionService, "ask"> {
  return {
    ask: async () => {
      throw new AppError(
        503,
        "QUESTION_UNAVAILABLE",
        "El servicio de preguntas no está disponible.",
      );
    },
  };
}

export function createApp(deps: Partial<AppDependencies> = {}): Express {
  const config = deps.config ?? loadConfig(process.env);
  const logger = deps.logger ?? pino({ level: config.LOG_LEVEL });
  const readiness = deps.readiness ?? createDefaultReadiness(config);
  const indexingService = deps.indexingService ?? unavailableIndexingService();
  const indexingJobs = deps.indexingJobs ?? unavailableIndexingJobs();
  const lifecycle = deps.lifecycle ?? unavailableLifecycle();
  const questionService = deps.questionService ?? unavailableQuestionService();
  const activity = deps.activity ?? new ActivityTracker();
  const uploadFailureReporter: UploadFailureReporter =
    deps.uploadFailureReporter ??
    ((report) => {
      logger.error(
        { uploadFailure: report },
        "No se ha podido limpiar una carga temporal.",
      );
    });
  const app = express();
  const openApiDocument = createOpenApiDocument();
  const swaggerUiHtml = createSwaggerUiHtml(openApiDocument);

  app.use(requestId);
  app.use(express.json());
  app.use(
    pinoHttp<Request, Response>({
      logger,
      genReqId: (request) => request.requestId,
      serializers: {
        req: (request) => ({
          id: request.id,
          method: request.method,
          url: request.url.split("?", 1)[0],
        }),
      },
    }),
  );
  app.use("/health", createHealthRouter(readiness));
  app.use("/health", createHealthCompatibilityRouter());
  app.use(authenticate(config));
  app.use(
    "/api/v1/indexing/jobs",
    createIndexingRouter(
      config,
      indexingService,
      indexingJobs,
      deps.uploadUnlink,
      activity,
      uploadFailureReporter,
    ),
  );
  app.use(
    "/api/v1/documents",
    createDocumentsRouter(lifecycle, activity, questionService),
  );
  app.use(
    "/api/v1/questions",
    createQuestionsRouter(questionService, lifecycle, activity),
  );
  app.use(
    createCompatibilityRouter(
      lifecycle,
      questionService,
      indexingJobs,
      activity,
    ),
  );
  app.get("/openapi.json", (_request, response) => {
    response.status(200).json(openApiDocument);
  });
  app.get(["/docs", "/docs/"], (_request, response) => {
    response.status(200).type("html").send(swaggerUiHtml);
  });
  app.use((_request, _response, next) => {
    next(new AppError(404, "NOT_FOUND", "Recurso no encontrado."));
  });
  app.use(errorHandler);

  return app;
}
