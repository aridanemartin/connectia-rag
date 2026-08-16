import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CorpusManifest,
  SeedSummary,
  SeedVersionResult,
} from "./fixtures.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeedOptions {
  apiUrl: string;
  authToken: string;
  manifest: CorpusManifest;
  pdfsDir: string;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxPollAttempts?: number;
  maxTransientErrors?: number;
}

export class SeedError extends Error {
  code = "SEED_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

// ---------------------------------------------------------------------------
// HTTP client wrapper
// ---------------------------------------------------------------------------

async function apiFetch(
  apiUrl: string,
  authToken: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${authToken}`);
  headers.set("User-Agent", "connectia-rag-demo-seed/1.0");

  const response = await fetch(new URL(url, apiUrl), {
    ...init,
    headers,
  });

  return response;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function parseApiError(response: Response): Promise<string> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // ignore parse failure
  }
  const code = body?.error?.code ?? `HTTP_${response.status}`;
  const message = body?.error?.message ?? response.statusText;
  return `Error ${code}: ${message}`;
}

// ---------------------------------------------------------------------------
// Polling with bounded backoff
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PollResult {
  jobId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

async function pollUntilTerminal(
  apiUrl: string,
  authToken: string,
  jobId: string,
  options: SeedOptions,
): Promise<PollResult> {
  const initialBackoff = options.initialBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 8_000;
  const maxAttempts = options.maxPollAttempts ?? 240;
  const maxTransient = options.maxTransientErrors ?? 5;

  let delay = initialBackoff;
  let consecutiveTransient = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await apiFetch(
        apiUrl,
        authToken,
        `/api/v1/indexing/jobs/${jobId}`,
      );

      if (response.ok) {
        consecutiveTransient = 0;
        const body = (await response.json()) as {
          status: string;
          errorCode?: string | null;
          errorMessage?: string | null;
        };

        if (body.status === "completed") {
          return {
            jobId,
            status: "completed",
            errorCode: null,
            errorMessage: null,
          };
        }

        if (body.status === "failed") {
          return {
            jobId,
            status: "failed",
            errorCode: body.errorCode ?? null,
            errorMessage: body.errorMessage ?? null,
          };
        }

        // Still processing — continue polling
      } else if (response.status >= 500) {
        // Server error — transient, retry
        consecutiveTransient++;
        if (consecutiveTransient > maxTransient) {
          const detail = await parseApiError(response);
          throw new SeedError(
            `Demasiados errores transitorios al consultar el trabajo ${jobId}. Último: ${detail}`,
          );
        }
      } else if (response.status === 404) {
        throw new SeedError(`Trabajo de indexación no encontrado: ${jobId}.`);
      } else {
        // 4xx not 404 — fail
        const detail = await parseApiError(response);
        throw new SeedError(
          `Error al consultar el trabajo ${jobId}: ${detail}`,
        );
      }
    } catch (error) {
      if (error instanceof SeedError) throw error;
      // Network error — transient, retry
      consecutiveTransient++;
      if (consecutiveTransient > maxTransient) {
        throw new SeedError(
          `Demasiados errores de red al consultar el trabajo ${jobId}.`,
        );
      }
    }

    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), maxBackoff);
  }

  throw new SeedError(
    `El trabajo de indexación ${jobId} no se completó tras ${maxAttempts} intentos.`,
  );
}

// ---------------------------------------------------------------------------
// Version upload
// ---------------------------------------------------------------------------

async function uploadVersion(
  apiUrl: string,
  authToken: string,
  documentId: string,
  version: {
    versionId: string;
    title: string;
    academicYear: string;
    idempotencyKey: string;
    file: string;
  },
  description: string | null,
  pdfBytes: Uint8Array,
): Promise<string> {
  const form = new FormData();
  form.append("documentId", documentId);
  form.append("versionId", version.versionId);
  form.append("title", version.title);
  form.append("academicYear", version.academicYear);
  if (description) {
    form.append("description", description);
  }
  form.append(
    "file",
    new Blob([pdfBytes], { type: "application/pdf" }),
    version.file,
  );

  const response = await apiFetch(apiUrl, authToken, "/api/v1/indexing/jobs", {
    method: "POST",
    headers: {
      "Idempotency-Key": version.idempotencyKey,
    },
    body: form,
  });

  if (!response.ok) {
    const detail = await parseApiError(response);
    throw new SeedError(
      `No se pudo indexar "${version.title}" (${version.versionId}): ${detail}`,
    );
  }

  const body = (await response.json()) as { jobId: string };
  return body.jobId;
}

// ---------------------------------------------------------------------------
// Version activation
// ---------------------------------------------------------------------------

async function activateVersion(
  apiUrl: string,
  authToken: string,
  documentId: string,
  versionId: string,
): Promise<string> {
  const response = await apiFetch(
    apiUrl,
    authToken,
    `/api/v1/documents/${documentId}/versions/${versionId}/activate`,
    { method: "POST" },
  );

  if (response.ok) {
    const body = (await response.json()) as { state: string };
    return body.state;
  }

  if (response.status === 409) {
    const body = (await response.json()) as { error?: { code?: string } };
    if (body?.error?.code === "VERSION_NOT_READY") {
      throw new SeedError(
        `La versión ${versionId} no está lista para activarse. Verifique que la indexación se haya completado.`,
      );
    }
  }

  const detail = await parseApiError(response);
  throw new SeedError(`No se pudo activar la versión ${versionId}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Core seed function
// ---------------------------------------------------------------------------

export async function seedCorpus(options: SeedOptions): Promise<SeedSummary> {
  const { manifest, pdfsDir, apiUrl, authToken } = options;
  const results: SeedVersionResult[] = [];

  for (const doc of manifest.documents) {
    console.log(`\n📄 Documento: ${doc.title}`);
    console.log(`   Identificador: ${doc.documentId}`);

    for (const version of doc.versions) {
      const pdfPath = join(pdfsDir, version.file);
      let pdfBytes: Uint8Array;

      try {
        pdfBytes = await readFile(pdfPath);
      } catch {
        throw new SeedError(
          `No se encuentra el archivo PDF "${version.file}" en ${pdfsDir}.`,
        );
      }

      // Verificar firma PDF
      const header = pdfBytes.subarray(0, 5).toString("ascii");
      if (header !== "%PDF-") {
        throw new SeedError(
          `El archivo "${version.file}" no tiene una firma PDF válida.`,
        );
      }

      // Subir e indexar
      console.log(`   → Indexando: ${version.title}...`);

      const jobId = await uploadVersion(
        apiUrl,
        authToken,
        doc.documentId,
        version,
        doc.description,
        pdfBytes,
      );

      console.log(`     Trabajo: ${jobId}`);

      // Pollear hasta completar
      const pollResult = await pollUntilTerminal(
        apiUrl,
        authToken,
        jobId,
        options,
      );

      if (pollResult.status === "failed") {
        const diagnostic = [pollResult.errorCode, pollResult.errorMessage]
          .filter(Boolean)
          .join(": ");
        throw new SeedError(
          `La indexación de "${version.title}" ha fallado. Diagnóstico: ${diagnostic}`,
        );
      }

      console.log(`     ✅ Indexación completada.`);

      // Activar si está marcado
      let activationState: string | null = null;
      if (version.activate) {
        console.log(`   → Activando: ${version.title}...`);

        activationState = await activateVersion(
          apiUrl,
          authToken,
          doc.documentId,
          version.versionId,
        );

        console.log(`     Estado: ${activationState}`);
      }

      results.push({
        documentId: doc.documentId,
        versionId: version.versionId,
        file: version.file,
        jobId,
        jobStatus: pollResult.status,
        activated: version.activate,
        activationState,
      });
    }
  }

  return { seededVersions: results };
}

// ---------------------------------------------------------------------------
// Seed summary printer
// ---------------------------------------------------------------------------

function printSummary(summary: SeedSummary): void {
  console.log("\n═══════════════════════════════════");
  console.log("  RESUMEN DE LA SIEMBRA DEL CORPUS");
  console.log("═══════════════════════════════════\n");

  for (const result of summary.seededVersions) {
    const statusIcon = result.jobStatus === "completed" ? "✅" : "❌";
    const activationText = result.activated
      ? ` · ${result.activationState}`
      : " · sin activar";
    console.log(
      `  ${statusIcon} ${result.file.padEnd(30)} ${result.jobStatus}${activationText}`,
    );
  }

  const total = summary.seededVersions.length;
  const completed = summary.seededVersions.filter(
    (r) => r.jobStatus === "completed",
  ).length;
  console.log(
    `\n  Total: ${completed}/${total} versiones indexadas correctamente.`,
  );
}

// ---------------------------------------------------------------------------
// Default environment values
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_TOKEN =
  "replace-with-a-secret-token-of-at-least-32-characters";

function loadEnv(): { apiUrl: string; authToken: string } {
  const apiUrl = process.env.CONNECTIA_API_URL ?? "http://localhost:3000";
  const authToken =
    process.env.CONNECTIA_AUTH_TOKEN ??
    process.env.AUTH_TOKEN ??
    DEFAULT_AUTH_TOKEN;
  return { apiUrl, authToken };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);

if (process.argv[1] === thisFile) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Error: ${message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const manifestPath = join(repoRoot, "fixtures", "corpus.manifest.json");
  const pdfsDir = join(repoRoot, "fixtures", "pdfs");
  const { apiUrl, authToken } = loadEnv();

  console.log(`🌱 Sembrador del corpus sintético de Connectia`);
  console.log(`   API: ${apiUrl}`);
  console.log();
  console.log(
    `   Este script utiliza exclusivamente los endpoints HTTP canónicos.`,
  );
  console.log(`   No accede directamente a SQLite ni a Qdrant.`);
  console.log();

  const manifestContent = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestContent) as CorpusManifest;

  console.log(`   Curso: ${manifest.academicYear}`);
  console.log(`   Documentos: ${manifest.documents.length}`);
  console.log(
    `   Versiones: ${manifest.documents.reduce((s, d) => s + d.versions.length, 0)}`,
  );

  const summary = await seedCorpus({ apiUrl, authToken, manifest, pdfsDir });
  printSummary(summary);

  const allCompleted = summary.seededVersions.every(
    (r) => r.jobStatus === "completed",
  );
  if (!allCompleted) {
    console.error("\nAlguna versión no se completó correctamente.");
    process.exit(1);
  }

  console.log("\n🌱 Siembra completada con éxito.");
}
