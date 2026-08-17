import type { Server } from "node:http";
import type { Express } from "express";
import type { AppDependencies } from "./api/api.types.js";
import type { AppConfig } from "./config/config.types.js";
import type { IndexingComposition } from "./documents/document.types.js";
import type { ActivityTracker } from "./shared/activity-tracker.js";

export type CompositionFactory = (config: AppConfig) => IndexingComposition;

export type ApplicationFactory = (
  dependencies: Partial<AppDependencies>,
) => Express;

export interface StartServerOptions {
  config?: AppConfig;
  createComposition?: CompositionFactory;
  createApplication?: ApplicationFactory;
  registerSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
  shutdownAbortGraceMs?: number;
}

export interface RunningServer {
  server: Server;
  composition: IndexingComposition;
  activity: ActivityTracker;
  shutdown(): Promise<void>;
}

export interface DirectExecutionInput {
  importMetaMain: boolean | undefined;
  moduleUrl: string;
  argvEntry: string | undefined;
}
