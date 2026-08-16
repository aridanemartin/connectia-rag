import express, { type Express, type Request, type Response } from "express";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { type AppConfig, loadConfig } from "../config/env.js";
import {
  createDefaultReadiness,
  type Readiness,
} from "../health/readiness.service.js";
import { AppError } from "./errors.js";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { createOpenApiDocument, createSwaggerUiHtml } from "./openapi.js";
import { createHealthRouter } from "./routes/health.js";

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readiness: Readiness;
}

export function createApp(deps: Partial<AppDependencies> = {}): Express {
  const config = deps.config ?? loadConfig(process.env);
  const logger = deps.logger ?? pino({ level: config.LOG_LEVEL });
  const readiness = deps.readiness ?? createDefaultReadiness(config);
  const app = express();
  const openApiDocument = createOpenApiDocument();
  const swaggerUiHtml = createSwaggerUiHtml(openApiDocument);

  app.use(requestId);
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
  app.use(authenticate(config));
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
