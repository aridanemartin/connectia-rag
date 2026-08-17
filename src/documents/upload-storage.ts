import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  fchmodSync,
  lstatSync,
  mkdirSync,
  open,
  realpathSync,
} from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Request } from "express";
import type multer from "multer";
import type { ActivityTracker } from "../shared/activity-tracker.js";
import type { UploadFailureReporter, UploadUnlink } from "./document.types.js";

export type {
  UploadFailureReport,
  UploadFailureReporter,
  UploadUnlink,
} from "./document.types.js";

export const SERVER_UPLOAD_FILENAME_PATTERN =
  /^connectia-upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/u;

/**
 * Thrown when the secure upload directory cannot be prepared or verified.
 */
export class UploadStorageError extends Error {
  constructor() {
    super("Upload storage is unavailable");
    this.name = "UploadStorageError";
  }
}

/**
 * Thrown when a temporary upload file cannot be cleaned up after failures
 * or terminal request outcomes.
 */
export class UploadCleanupError extends Error {
  constructor() {
    super("Upload cleanup failed");
    this.name = "UploadCleanupError";
  }
}

export function secureUploadDirectory(path: string): string {
  const absolutePath = resolve(path);
  try {
    mkdirSync(absolutePath, { recursive: true, mode: 0o700 });
    const initial = lstatSync(absolutePath);
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw new UploadStorageError();
    }
    const realPath = realpathSync.native(absolutePath);
    chmodSync(absolutePath, 0o700);
    const verified = lstatSync(absolutePath);
    if (
      verified.isSymbolicLink() ||
      !verified.isDirectory() ||
      (verified.mode & 0o777) !== 0o700 ||
      realpathSync.native(absolutePath) !== realPath
    ) {
      throw new UploadStorageError();
    }
    return realPath;
  } catch (error) {
    if (error instanceof UploadStorageError) {
      throw error;
    }
    throw new UploadStorageError();
  }
}

/**
 * Retries file deletion up to a configurable number of attempts with
 * exponential back-off. Used to clean up temporary upload files.
 */
export class RetryingUploadCleaner {
  constructor(
    private readonly unlinkFile: UploadUnlink = unlink,
    private readonly attempts = 3,
  ) {}

  async remove(path: string): Promise<void> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        await this.unlinkFile(path);
        return;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        if (attempt === this.attempts) {
          throw new UploadCleanupError();
        }
        await delay(attempt * 10);
      }
    }
  }
}

/**
 * Multer storage engine that writes uploaded files to a hardened directory,
 * guards against symlink attacks, and cleans up partial files on request
 * abort or error. Key methods: _handleFile, _removeFile.
 */
export class SecureUploadStorage implements multer.StorageEngine {
  constructor(
    private readonly directory: string,
    private readonly cleaner: RetryingUploadCleaner,
    private readonly activity?: ActivityTracker,
    private readonly reportFailure?: UploadFailureReporter,
  ) {}

  private reportCleanupFailure(): void {
    if (!this.reportFailure) {
      return;
    }
    try {
      const result = this.reportFailure(
        Object.freeze({
          code: "UPLOAD_CLEANUP_FAILED",
          phase: "terminal_cleanup",
        }),
      );
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Reporting is a contained observation boundary and never owns settlement.
    }
  }

  _handleFile(
    request: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    let finishActivity: () => void = () => undefined;
    try {
      finishActivity = this.activity?.begin() ?? finishActivity;
    } catch {
      callback(new UploadStorageError());
      return;
    }
    let destination: string;
    try {
      destination = secureUploadDirectory(this.directory);
    } catch {
      finishActivity();
      callback(new UploadStorageError());
      return;
    }

    const filename = `connectia-upload-${randomUUID()}.pdf`;
    const path = join(destination, filename);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let settled = false;
    let terminal = false;
    let resourceReady = false;
    let cleanupStarted = false;
    let output: ReturnType<typeof createWriteStream> | undefined;
    const onTerminal = () => {
      terminal = true;
      if (resourceReady) {
        cleanupCreatedFile();
      }
    };
    const onRequestClose = () => {
      if (!request.readableEnded) {
        onTerminal();
      }
    };
    const onFileClose = () => {
      if (!file.stream.readableEnded) {
        onTerminal();
      }
    };
    const removeTerminalListeners = () => {
      request.off("aborted", onTerminal);
      request.off("error", onTerminal);
      request.off("close", onRequestClose);
      file.stream.off("error", onTerminal);
      file.stream.off("close", onFileClose);
    };
    const finish = (error?: unknown, info?: Partial<Express.Multer.File>) => {
      if (settled) {
        return;
      }
      settled = true;
      removeTerminalListeners();
      finishActivity();
      callback(error, info);
    };
    const cleanupCreatedFile = () => {
      if (settled || cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      const outputClosed = new Promise<void>((resolveClosed) => {
        if (!output || output.closed) {
          resolveClosed();
          return;
        }
        output.once("close", resolveClosed);
        output.destroy();
      });
      const fileRemoved = this.cleaner.remove(path);
      void Promise.all([outputClosed, fileRemoved]).then(
        () => finish(new UploadStorageError()),
        () => {
          this.reportCleanupFailure();
          finish(new UploadCleanupError());
        },
      );
    };

    request.once("aborted", onTerminal);
    request.once("error", onTerminal);
    request.once("close", onRequestClose);
    file.stream.once("error", onTerminal);
    file.stream.once("close", onFileClose);
    open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
      (openError, fileDescriptor) => {
        if (openError) {
          finish(new UploadStorageError());
          return;
        }
        if (
          terminal ||
          request.aborted ||
          (request.destroyed && !request.readableEnded) ||
          (file.stream.destroyed && !file.stream.readableEnded)
        ) {
          try {
            closeSync(fileDescriptor);
          } catch {
            // The typed storage result below remains safe and observable.
          }
          resourceReady = true;
          cleanupCreatedFile();
          return;
        }
        try {
          fchmodSync(fileDescriptor, 0o600);
          output = createWriteStream(path, {
            fd: fileDescriptor,
            autoClose: true,
          });
        } catch {
          try {
            closeSync(fileDescriptor);
          } catch {
            // The unlink retry below is the authoritative recovery path.
          }
          resourceReady = true;
          cleanupCreatedFile();
          return;
        }
        const activeOutput = output;
        activeOutput.once("error", onTerminal);
        resourceReady = true;
        if (terminal) {
          cleanupCreatedFile();
          return;
        }
        activeOutput.once("finish", () => {
          if (terminal || cleanupStarted) {
            return;
          }
          finish(undefined, {
            destination,
            filename,
            path,
            size: activeOutput.bytesWritten,
          });
        });
        file.stream.pipe(activeOutput);
      },
    );
  }

  _removeFile(
    _request: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    void this.cleaner.remove(file.path).then(
      () => {
        Reflect.deleteProperty(file, "destination");
        Reflect.deleteProperty(file, "filename");
        Reflect.deleteProperty(file, "path");
        callback(null);
      },
      () => callback(new UploadCleanupError()),
    );
  }
}

export async function sweepOrphanUploads(
  directory: string,
  livePaths: ReadonlySet<string>,
  cleaner: RetryingUploadCleaner,
): Promise<number> {
  const root = secureUploadDirectory(directory);
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !SERVER_UPLOAD_FILENAME_PATTERN.test(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    if (livePaths.has(path)) {
      continue;
    }
    await cleaner.remove(path);
    removed += 1;
  }
  return removed;
}
