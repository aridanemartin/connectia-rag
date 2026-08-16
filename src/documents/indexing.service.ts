import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppError } from "../api/errors.js";
import type { AppConfig } from "../config/env.js";
import {
  closeDatabase,
  type DatabaseConnection,
  openDatabase,
} from "../persistence/database.js";
import { migrate } from "../persistence/migrate.js";
import { DocumentRepository } from "../persistence/repositories/document.repository.js";
import {
  type IndexingJob,
  IndexingJobRepository,
} from "../persistence/repositories/indexing-job.repository.js";
import { type Clock, systemClock } from "../shared/clock.js";
import {
  type IndexingDocumentInput,
  PersistenceConflictError,
} from "./document.types.js";

export interface IndexingRequest {
  idempotencyKey: string;
  documentId: string;
  versionId: string;
  title: string;
  academicYear: string;
  description: string | null;
  tempFilePath: string;
}

export interface IndexingEnqueuer {
  enqueue(input: IndexingRequest): Promise<IndexingJob>;
}

type DocumentWriter = Pick<DocumentRepository, "upsertIndexing">;
type JobWriter = Pick<
  IndexingJobRepository,
  "enqueue" | "findByIdempotencyKey"
>;

function canonicalMetadata(input: IndexingRequest): string {
  return JSON.stringify({
    documentId: input.documentId,
    versionId: input.versionId,
    title: input.title,
    academicYear: input.academicYear,
    description: input.description,
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const header = Buffer.alloc(5);
  let headerBytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (headerBytes < header.length) {
        const copied = bytes.copy(
          header,
          headerBytes,
          0,
          Math.min(bytes.length, header.length - headerBytes),
        );
        headerBytes += copied;
      }
      hash.update(bytes);
    }
  } catch {
    throw new AppError(
      500,
      "UPLOAD_PROCESSING_FAILED",
      "No se ha podido preparar el PDF.",
    );
  }
  if (headerBytes !== header.length || header.toString("ascii") !== "%PDF-") {
    throw new AppError(
      400,
      "PDF_SIGNATURE_INVALID",
      "El archivo no tiene una firma PDF válida.",
    );
  }
  return hash.digest("hex");
}

export class IndexingService implements IndexingEnqueuer {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly documents: DocumentWriter,
    private readonly jobs: JobWriter,
  ) {}

  async enqueue(input: IndexingRequest): Promise<IndexingJob> {
    const contentHash = await hashFile(input.tempFilePath);
    const requestHash = createHash("sha256")
      .update(contentHash + canonicalMetadata(input), "utf8")
      .digest("hex");

    const persist = this.database.transaction(() => {
      const existing = this.jobs.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otra solicitud.",
          );
        }
        return existing;
      }

      const document: IndexingDocumentInput = {
        documentId: input.documentId,
        versionId: input.versionId,
        title: input.title,
        academicYear: input.academicYear,
        description: input.description,
        contentHash,
      };
      this.documents.upsertIndexing(document);
      return this.jobs.enqueue({
        id: randomUUID(),
        documentId: input.documentId,
        versionId: input.versionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        contentHash,
        tempFilePath: input.tempFilePath,
      });
    }).immediate;

    try {
      return persist();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof PersistenceConflictError) {
        throw new AppError(
          409,
          "INDEXING_CONFLICT",
          "Los identificadores ya pertenecen a otro contenido.",
        );
      }
      throw error;
    }
  }
}

export interface IndexingComposition {
  indexingService: IndexingService;
  database: DatabaseConnection;
  close(): void;
}

export function createIndexingComposition(
  config: AppConfig,
  clock: Clock = systemClock,
): IndexingComposition {
  if (config.DATABASE_PATH !== ":memory:") {
    mkdirSync(dirname(resolve(config.DATABASE_PATH)), {
      recursive: true,
      mode: 0o700,
    });
  }
  const database = openDatabase(config.DATABASE_PATH);
  try {
    migrate(database);
    const indexingService = new IndexingService(
      database,
      new DocumentRepository(database, clock),
      new IndexingJobRepository(database, clock),
    );
    return {
      indexingService,
      database,
      close: () => closeDatabase(database),
    };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}
