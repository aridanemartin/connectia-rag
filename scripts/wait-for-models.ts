// ──────────────────────────────────────────────────────────────────────────
// wait-for-models.ts  —  Poll Ollama until both chat and embedding models
//                         are registered (Compose model-readiness helper)
//
// Usage
// ──────────────────────────────────────────────────────────────────────────
//   node scripts/wait-for-models.ts
//
// Environment variables read
// ──────────────────────────────────────────────────────────────────────────
//   OLLAMA_BASE_URL          defaults to http://localhost:11434
//   OLLAMA_CHAT_MODEL        required (e.g. gemma3:12b)
//   OLLAMA_EMBEDDING_MODEL   required (e.g. qwen3-embedding:0.6b)
// ──────────────────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL;
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL;

const POLL_INTERVAL_MS = 2_000;
const MAX_RETRIES = 90; // 3 minutes total

async function fetchTags(): Promise<{ name: string }[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }
  const body = (await response.json()) as { models?: { name: string }[] };
  return body.models ?? [];
}

function isModelPresent(
  models: { name: string }[],
  name: string | undefined,
): boolean {
  if (!name) return true; // nothing to wait for
  return models.some((m) => m.name === name);
}

async function waitForModels(): Promise<void> {
  if (!CHAT_MODEL && !EMBEDDING_MODEL) {
    console.log(
      "[wait-for-models] Neither OLLAMA_CHAT_MODEL nor OLLAMA_EMBEDDING_MODEL is set — nothing to wait for.",
    );
    return;
  }

  console.log(
    `[wait-for-models] Waiting for chat model "${CHAT_MODEL ?? "(none)"}" and embedding model "${EMBEDDING_MODEL ?? "(none)"}" ...`,
  );

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const models = await fetchTags();
      const chatReady = isModelPresent(models, CHAT_MODEL);
      const embeddingReady = isModelPresent(models, EMBEDDING_MODEL);

      if (chatReady && embeddingReady) {
        console.log("[wait-for-models] Todos los modelos están disponibles.");
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `[wait-for-models] Attempt ${attempt}/${MAX_RETRIES} — ${message}`,
      );
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.error(
    `[wait-for-models] Timed out after ${(MAX_RETRIES * POLL_INTERVAL_MS) / 1_000} seconds.`,
  );
  process.exit(1);
}

void waitForModels();
