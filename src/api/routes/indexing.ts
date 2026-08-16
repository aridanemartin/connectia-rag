import { extname } from "node:path";
import type { Request, RequestHandler } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type {
  IndexingEnqueuer,
  IndexingRequest,
} from "../../documents/indexing.service.js";
import {
  RetryingUploadCleaner,
  SecureUploadStorage,
  UploadCleanupError,
  type UploadFailureReporter,
  UploadStorageError,
  type UploadUnlink,
} from "../../documents/upload-storage.js";
import {
  ActivityNotAcceptedError,
  type ActivityTracker,
} from "../../shared/activity-tracker.js";
import { AppError } from "../errors.js";

const safeCanonicalText = (minimum: number, maximum: number) =>
  z
    .string()
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(
      z
        .string()
        .min(minimum)
        .max(maximum)
        .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
    );

const metadataSchema = z
  .object({
    documentId: z.uuid().transform((value) => value.toLowerCase()),
    versionId: z.uuid().transform((value) => value.toLowerCase()),
    title: safeCanonicalText(1, 200),
    academicYear: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{4}$/u),
    description: safeCanonicalText(0, 1_000).optional(),
  })
  .strict();

function uploadMiddleware(
  config: AppConfig,
  cleaner: RetryingUploadCleaner,
  activity?: ActivityTracker,
  reportFailure?: UploadFailureReporter,
): RequestHandler {
  const storage = new SecureUploadStorage(
    config.TEMP_DIR,
    cleaner,
    activity,
    reportFailure,
  );
  // The lockfile pins Multer 2.2.0 to Busboy 1.6.0. Busboy itself enforces a
  // finite 16 KiB/2,000-pair part-header boundary; it has no configurable
  // headerPairs option. The raw-wire integration test guards that real limit.
  return multer({
    storage,
    preservePath: false,
    limits: {
      fileSize: config.MAX_PDF_BYTES,
      files: 1,
      fields: 5,
      // Busboy emits its limit event when the counter reaches this value, so
      // seven enforces an effective maximum of six accepted parts.
      parts: 7,
      fieldNameSize: 64,
      fieldSize: 8 * 1024,
      fieldNestingDepth: 0,
    },
  }).single("file");
}

function idempotencyKey(request: Request): string {
  const header = request.get("Idempotency-Key");
  const value = header?.trim();
  if (!value) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Debe indicar una clave de idempotencia.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "La clave de idempotencia no es válida.",
    );
  }
  return value;
}

function indexingInput(request: Request): IndexingRequest {
  const key = idempotencyKey(request);
  const parsed = metadataSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new AppError(
      400,
      "INDEXING_METADATA_INVALID",
      "Los metadatos de indexación no son válidos.",
    );
  }
  if (!request.file) {
    throw new AppError(400, "PDF_REQUIRED", "Debe adjuntar un archivo PDF.");
  }
  if (extname(request.file.originalname).toLowerCase() !== ".pdf") {
    throw new AppError(
      400,
      "PDF_EXTENSION_INVALID",
      "El archivo debe tener extensión PDF.",
    );
  }
  if (request.file.mimetype !== "application/pdf") {
    throw new AppError(
      415,
      "PDF_MIME_INVALID",
      "El tipo de archivo debe ser application/pdf.",
    );
  }
  const academicYears = parsed.data.academicYear.split("-").map(Number);
  if (academicYears[1] !== academicYears[0] + 1) {
    throw new AppError(
      400,
      "INDEXING_METADATA_INVALID",
      "Los metadatos de indexación no son válidos.",
    );
  }
  return {
    idempotencyKey: key,
    documentId: parsed.data.documentId,
    versionId: parsed.data.versionId,
    title: parsed.data.title,
    academicYear: parsed.data.academicYear,
    description: parsed.data.description || null,
    tempFilePath: request.file.path,
  };
}

function mapUploadError(error: unknown): AppError {
  if (
    error instanceof UploadCleanupError ||
    (typeof error === "object" &&
      error !== null &&
      "storageErrors" in error &&
      Array.isArray(error.storageErrors) &&
      error.storageErrors.length > 0)
  ) {
    return new AppError(
      503,
      "UPLOAD_CLEANUP_FAILED",
      "No se ha podido limpiar el archivo temporal.",
    );
  }
  if (error instanceof UploadStorageError) {
    return new AppError(
      503,
      "UPLOAD_STORAGE_UNAVAILABLE",
      "El almacenamiento temporal no está disponible.",
    );
  }
  if (!(error instanceof multer.MulterError)) {
    return new AppError(
      400,
      "MULTIPART_INVALID",
      "La solicitud multipart no es válida.",
    );
  }

  switch (String(error.code)) {
    case "LIMIT_FILE_SIZE":
      return new AppError(
        413,
        "PDF_TOO_LARGE",
        "El PDF supera el tamaño máximo permitido.",
      );
    case "LIMIT_FILE_COUNT":
    case "LIMIT_UNEXPECTED_FILE":
      return new AppError(
        400,
        "MULTIPART_FILE_INVALID",
        "Debe adjuntar exactamente un archivo en el campo file.",
      );
    case "LIMIT_FIELD_COUNT":
      return new AppError(
        400,
        "MULTIPART_FIELD_LIMIT",
        "La solicitud contiene demasiados campos de texto.",
      );
    case "LIMIT_PART_COUNT":
      return new AppError(
        400,
        "MULTIPART_PART_LIMIT",
        "La solicitud contiene demasiadas partes.",
      );
    case "LIMIT_FIELD_VALUE":
      return new AppError(
        400,
        "MULTIPART_FIELD_VALUE_INVALID",
        "Un campo de texto supera el tamaño permitido.",
      );
    case "LIMIT_FIELD_KEY":
    case "LIMIT_FIELD_NESTING":
    case "MISSING_FIELD_NAME":
      return new AppError(
        400,
        "MULTIPART_FIELD_NAME_INVALID",
        "El nombre de un campo multipart no es válido.",
      );
    default:
      return new AppError(
        400,
        "MULTIPART_INVALID",
        "La solicitud multipart no es válida.",
      );
  }
}

export function createIndexingRouter(
  config: AppConfig,
  indexingService: IndexingEnqueuer,
  uploadUnlink?: UploadUnlink,
  activity?: ActivityTracker,
  reportFailure?: UploadFailureReporter,
): Router {
  const router = Router();
  const cleaner = new RetryingUploadCleaner(uploadUnlink);
  const upload = uploadMiddleware(config, cleaner, activity, reportFailure);

  router.post("/", (request, response, next) => {
    const execute = async (signal?: AbortSignal) => {
      const uploadError = await new Promise<unknown>((resolveUpload) => {
        upload(request, response, resolveUpload);
      });
      if (uploadError) {
        throw mapUploadError(uploadError);
      }

      await (async () => {
        let retainUpload = false;
        let primaryError: unknown;
        let responseBody:
          | { jobId: string; status: "queued"; requestId: string }
          | undefined;
        try {
          const input = indexingInput(request);
          const job = await indexingService.enqueue(input, signal);
          retainUpload = job.tempFilePath === input.tempFilePath;
          responseBody = {
            jobId: job.id,
            status: "queued",
            requestId: request.requestId,
          };
        } catch (error) {
          primaryError = error;
        }
        if (request.file && !retainUpload) {
          try {
            await cleaner.remove(request.file.path);
          } catch {
            throw new AppError(
              503,
              "UPLOAD_CLEANUP_FAILED",
              "No se ha podido limpiar el archivo temporal.",
            );
          }
        }
        if (primaryError !== undefined) {
          throw primaryError;
        }
        if (!responseBody) {
          throw new AppError(
            500,
            "INTERNAL_ERROR",
            "Ha ocurrido un error interno.",
          );
        }
        response.status(202).json(responseBody);
      })();
    };
    if (!activity) {
      void execute().catch(next);
      return;
    }
    void activity
      .run(async (signal) => {
        try {
          await execute(signal);
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
  });

  return router;
}
