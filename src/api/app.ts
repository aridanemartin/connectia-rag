import express, { type Express } from "express";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { type AppConfig, loadConfig } from "../config/env.js";
import { createHealthRouter } from "./routes/health.js";

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
}

export function createApp(deps: Partial<AppDependencies> = {}): Express {
  const config = deps.config ?? loadConfig(process.env);
  const logger = deps.logger ?? pino({ level: config.LOG_LEVEL });
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use("/health", createHealthRouter());

  return app;
}
