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

export const SERVER_UPLOAD_FILENAME_PATTERN =
  /^connectia-upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/u;

export type UploadUnlink = (path: string) => Promise<void>;

export class UploadStorageError extends Error {
  constructor() {
    super("Upload storage is unavailable");
    this.name = "UploadStorageError";
  }
}

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

export class SecureUploadStorage implements multer.StorageEngine {
  constructor(
    private readonly directory: string,
    private readonly cleaner: RetryingUploadCleaner,
  ) {}

  _handleFile(
    _request: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    let destination: string;
    try {
      destination = secureUploadDirectory(this.directory);
    } catch {
      callback(new UploadStorageError());
      return;
    }

    const filename = `connectia-upload-${randomUUID()}.pdf`;
    const path = join(destination, filename);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let settled = false;
    const finish = (error?: unknown, info?: Partial<Express.Multer.File>) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(error, info);
    };
    open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
      (openError, fileDescriptor) => {
        if (openError) {
          finish(new UploadStorageError());
          return;
        }
        file.path = path;
        let output: ReturnType<typeof createWriteStream> | undefined;
        let failureStarted = false;
        const failCreatedFile = () => {
          if (settled || failureStarted) {
            return;
          }
          failureStarted = true;
          output?.destroy();
          void this.cleaner.remove(path).then(
            () => finish(new UploadStorageError()),
            () => finish(new UploadCleanupError()),
          );
        };
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
          failCreatedFile();
          return;
        }
        file.stream.once("error", failCreatedFile);
        output.once("error", failCreatedFile);
        output.once("finish", () =>
          finish(undefined, {
            destination,
            filename,
            path,
            size: output.bytesWritten,
          }),
        );
        file.stream.pipe(output);
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
