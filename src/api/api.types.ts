import type { Logger } from "pino";
import type { AppConfig } from "../config/config.types.js";
import type {
  IndexingEnqueuer,
  LifecycleReader,
  UploadFailureReporter,
  UploadUnlink,
} from "../documents/document.types.js";
import type { Readiness } from "../health/health.types.js";
import type {
  IndexingJob,
  IndexingJobStatus,
} from "../persistence/persistence.types.js";
import type { QuestionService } from "../rag/question.service.js";
import type { ActivityTracker } from "../shared/activity-tracker.js";

// ── app.ts ──────────────────────────────────────────────────────────

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

// ── middleware/error-handler.ts ─────────────────────────────────────

export interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

// ── middleware/request-id.ts ────────────────────────────────────────

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

// ── routes/questions.ts ─────────────────────────────────────────────

export interface QuestionRouteDependencies {
  questionService: Pick<QuestionService, "ask">;
  lifecycle: LifecycleReader;
  activity?: ActivityTracker;
}

// ── routes/indexing.ts ──────────────────────────────────────────────

export interface IndexingJobStatusReader {
  find(jobId: string): IndexingJob | undefined;
}

export interface IndexingJobStatusResponse {
  jobId: string;
  documentId: string;
  versionId: string;
  status: IndexingJobStatus;
  progress: number;
  stage: string;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string | null;
}
