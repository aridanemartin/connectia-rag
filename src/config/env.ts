import { z } from "zod";
import type { AppConfig } from "./config.types.js";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  AUTH_TOKEN: z.string().min(32),
  AUTH_DISABLED: booleanFromEnvironment,
  DATABASE_PATH: z.string().min(1).default("data/connectia.sqlite"),
  TEMP_DIR: z.string().min(1).default("tmp"),
  OLLAMA_BASE_URL: z.url().default("http://ollama:11434"),
  OLLAMA_CHAT_MODEL: z.string().min(1).default("gemma3:12b"),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default("qwen3-embedding:0.6b"),
  QDRANT_URL: z.url().default("http://qdrant:6333"),
  QDRANT_COLLECTION: z.string().min(1).default("connectia_documents"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  MAX_ACTIVE_GENERATIONS: z.coerce.number().int().positive().default(2),
  MAX_QUEUED_GENERATIONS: z.coerce.number().int().positive().default(20),
  QUESTION_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RAG_TOP_K: z.coerce.number().int().positive().default(6),
  RAG_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  DIAGNOSTICS_ENABLED: booleanFromEnvironment,
  DIAGNOSTICS_TTL_HOURS: z.coerce.number().int().positive().default(24),
  ENABLE_INTERNAL_METRICS: booleanFromEnvironment,
  INDEXING_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(16),
  INDEXING_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  INDEXING_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
});

export type { AppConfig };

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return envSchema.parse(env);
}
