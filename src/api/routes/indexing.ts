import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
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
import { AppError } from "../errors.js";

const metadataSchema = z
  .object({
    documentId: z.uuid(),
    versionId: z.uuid(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
    academicYear: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{4}$/u),
    description: z
      .string()
      .trim()
      .max(1_000)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
      .optional(),
  })
  .strict();

function uploadMiddleware(config: AppConfig): RequestHandler {
  mkdirSync(config.TEMP_DIR, { recursive: true, mode: 0o700 });
  const storage = multer.diskStorage({
    destination: config.TEMP_DIR,
    filename: (_request, _file, callback) => {
      callback(null, randomUUID());
    },
  });
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
      headerPairs: 16,
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

async function removeUpload(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Cleanup is best-effort and must never replace the primary safe outcome.
  }
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
): Router {
  const router = Router();
  const upload = uploadMiddleware(config);

  router.post("/", (request, response, next) => {
    upload(request, response, (uploadError) => {
      if (uploadError) {
        next(mapUploadError(uploadError));
        return;
      }

      void (async () => {
        let retainUpload = false;
        try {
          const input = indexingInput(request);
          const job = await indexingService.enqueue(input);
          retainUpload = job.tempFilePath === input.tempFilePath;
          response.status(202).json({
            jobId: job.id,
            status: "queued",
            requestId: request.requestId,
          });
        } finally {
          if (request.file && !retainUpload) {
            await removeUpload(request.file.path);
          }
        }
      })().catch(next);
    });
  });

  return router;
}
