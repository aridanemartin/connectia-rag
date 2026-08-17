/**
 * Fake Ollama server for deterministic testing.
 *
 * Provides:
 * - SHA-256 based deterministic embeddings (same text → same vector)
 * - Structured chat decisions via keyword matching against context
 * - Trigger endpoints for malformed JSON, timeouts, and 503 responses
 *
 * Usage:
 *   const server = await startFakeOllamaServer();
 *   // point your provider at server.url
 *   await server.stop();
 */

import { createHash } from "node:crypto";
import { type AddressInfo, createServer } from "node:net";

// ── Helpers ──────────────────────────────────────────────────────────────

const _encoder = new TextEncoder();

/**
 * Deterministic embedding from SHA-256 hash of the text.
 * The hash bytes are normalised to unit length so cosine similarity works.
 */
function deterministicEmbedding(text: string, dimensions: number): number[] {
  const hash = createHash("sha256").update(text).digest();
  const values: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    values.push(hash[i % hash.length] / 255);
  }
  const magnitude = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return magnitude > 0 ? values.map((v) => v / magnitude) : values;
}

/**
 * Decide whether the question can be answered from context.
 *
 * Uses whole-word token overlap (not substring): the question's content words
 * are matched against the token set of each chunk's text. This avoids false
 * positives from substrings (e.g. "fin" matching "finaliza").
 *
 * Classification rules:
 *   - No matches at all → not_found
 *   - Best match covers < 50 % of content words → not_found (too weak)
 *   - Top chunks tie, or a runner-up from a different text is close enough
 *     (≥ 2/3 of the best count) and the best doesn't cover every word → ambiguous
 *   - Otherwise → found, citing the best-matching chunk(s)
 */
export function decideResponse(
  question: string,
  context: ReadonlyArray<{ chunkId: string; text: string }>,
): unknown {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "de",
    "del",
    "en",
    "y",
    "e",
    "o",
    "u",
    "a",
    "ante",
    "bajo",
    "con",
    "contra",
    "para",
    "por",
    "que",
    "cual",
    "como",
    "cuando",
    "donde",
    "es",
    "se",
    "su",
    "lo",
    "qué",
    "cuál",
    "cómo",
    "cuándo",
    "dónde",
    "al",
    "no",
  ]);

  const tokenize = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[\s,¿?¡!.;:()]+/)
      .filter((w) => w.length > 0);

  const words = tokenize(question).filter(
    (w) => w.length > 2 && !stopWords.has(w),
  );

  if (words.length === 0) {
    return { status: "ambiguous", answer: null, citedChunkIds: [] };
  }

  // Tokenise each chunk text into a Set for fast word-boundary lookup
  const chunkTokens = context.map((c) => ({
    chunkId: c.chunkId,
    text: c.text,
    tokens: new Set(tokenize(c.text)),
  }));

  const hits: { chunkId: string; count: number }[] = [];

  for (const c of chunkTokens) {
    const matchCount = words.filter((w) => c.tokens.has(w)).length;
    if (matchCount > 0) {
      hits.push({ chunkId: c.chunkId, count: matchCount });
    }
  }

  if (hits.length === 0) {
    return { status: "not_found", answer: null, citedChunkIds: [] };
  }

  hits.sort((a, b) => b.count - a.count);
  const maxCount = hits[0].count;
  const best = hits.filter((h) => h.count === maxCount);

  // Minimum overlap: the best chunk must cover at least half of the
  // question's content words to be considered answerable.
  if (maxCount < words.length * 0.5) {
    return { status: "not_found", answer: null, citedChunkIds: [] };
  }

  // Ambiguous if the top chunks tie.
  if (best.length > 1) {
    return { status: "ambiguous", answer: null, citedChunkIds: [] };
  }

  // Ambiguous if a runner-up is close enough (≥ 2/3 of the best count)
  // and the best chunk doesn't cover every content word.
  const runnerUp = hits[1]?.count ?? 0;
  if (maxCount < words.length && runnerUp >= (2 / 3) * maxCount) {
    return { status: "ambiguous", answer: null, citedChunkIds: [] };
  }

  const bestChunk = context.find((c) => c.chunkId === best[0].chunkId);
  const text = bestChunk?.text ?? "Información no disponible.";

  return {
    status: "found",
    answer: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    citedChunkIds: best.map((h) => h.chunkId),
  };
}

function parseJsonBody(
  buffer: Buffer,
): { system?: string; question?: string; context?: unknown } | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf-8"));
    return parsed;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, body: unknown): string {
  return `HTTP/1.1 ${status} ${status === 200 ? "OK" : status === 400 ? "Bad Request" : "Service Unavailable"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON.stringify(body))}\r\nConnection: close\r\n\r\n${JSON.stringify(body)}`;
}

function htmlResponse(status: number, body: string): string {
  return `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

// ── Routes ───────────────────────────────────────────────────────────────

interface RouteConfig {
  timeoutMs: number | null; // null = normal, number = delay before response
  status503: boolean;
  malformed: boolean;
}

const routeConfig: RouteConfig = {
  timeoutMs: null,
  status503: false,
  malformed: false,
};

function resetRouteConfig(): void {
  routeConfig.timeoutMs = null;
  routeConfig.status503 = false;
  routeConfig.malformed = false;
}

// ── Server ───────────────────────────────────────────────────────────────

export interface FakeOllamaServer {
  url: string;
  stop(): Promise<void>;
  /** Reset all trigger flags */
  reset(): void;
  /** Make the next /api/chat response malformed */
  triggerMalformed(): void;
  /** Make the next /api/chat response hang for `ms` milliseconds */
  triggerTimeout(ms: number): void;
  /** Make the next /api/chat response return 503 */
  trigger503(): void;
}

export function startFakeOllamaServer(): Promise<FakeOllamaServer> {
  return new Promise<FakeOllamaServer>((resolveStart, rejectStart) => {
    resetRouteConfig();

    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);

      const handleData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Check if we have a complete HTTP request
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headerSection = buffer.subarray(0, headerEnd).toString("utf-8");
        const bodyStart = headerEnd + 4;
        const contentLengthMatch = headerSection.match(
          /content-length:\s*(\d+)/i,
        );
        if (contentLengthMatch) {
          const contentLength = Number.parseInt(contentLengthMatch[1], 10);
          if (buffer.length < bodyStart + contentLength) return;
        }

        const method = headerSection.split(" ")[0];
        const url = headerSection.split(" ")[1];
        const contentBody = buffer.subarray(bodyStart);

        // ────────────────────────────────────────────────────────────
        // POST /api/chat
        // ────────────────────────────────────────────────────────────
        if (method === "POST" && url === "/api/chat") {
          if (routeConfig.status503) {
            resetRouteConfig();
            socket.write(jsonResponse(503, { error: "Service Unavailable" }));
            socket.end();
            return;
          }

          if (routeConfig.malformed) {
            resetRouteConfig();
            socket.write(htmlResponse(200, "Esto no es JSON válido { broken"));
            socket.end();
            return;
          }

          if (routeConfig.timeoutMs !== null) {
            // Hang without responding
            const delay = routeConfig.timeoutMs;
            resetRouteConfig();
            setTimeout(() => {
              socket.end(); // close without response
            }, delay);
            return;
          }

          const parsed = parseJsonBody(contentBody);

          if (!parsed || !Array.isArray(parsed)) {
            // The Ollama chat API sends: { model, messages: [...] }
            // but we get the full JSON body
            let messages: unknown[] = [];
            try {
              const full = JSON.parse(contentBody.toString("utf-8"));
              messages = full.messages ?? [];
            } catch {
              messages = [];
            }

            // Extract context from the last human message
            const humanMsg = messages.findLast(
              (m: unknown) =>
                typeof m === "object" &&
                m !== null &&
                (m as { role?: string }).role === "user",
            ) as { content?: string } | undefined;

            // Parse the user message content, which the test client sends as a
            // JSON string: { question, context }. Extract the actual question
            // text (not the raw JSON) so the decision heuristic sees real words.
            let question =
              typeof humanMsg?.content === "string"
                ? humanMsg.content
                : "pregunta desconocida";
            let context: Array<{ chunkId: string; text: string }> = [];
            try {
              const contentData = JSON.parse(humanMsg?.content ?? "{}");
              if (typeof contentData.question === "string") {
                question = contentData.question;
              }
              if (Array.isArray(contentData.context)) {
                context = contentData.context;
              }
            } catch {
              // Plain-text user content: fall back to the raw string as question.
            }

            const decision = decideResponse(question, context);
            const responseBody = {
              model: "fake-model",
              message: { role: "assistant", content: JSON.stringify(decision) },
              done: true,
            };

            socket.write(jsonResponse(200, responseBody));
            socket.end();
            return;
          }

          socket.write(jsonResponse(200, { message: { content: "ok" } }));
          socket.end();
          return;
        }

        // ────────────────────────────────────────────────────────────
        // POST /api/embed
        // ────────────────────────────────────────────────────────────
        if (method === "POST" && url === "/api/embed") {
          let input: string | string[] = "";
          try {
            const full = JSON.parse(contentBody.toString("utf-8"));
            input = full.input ?? "";
          } catch {
            input = "";
          }

          const inputs = Array.isArray(input) ? input : [input];

          const embedding =
            inputs.length > 0
              ? deterministicEmbedding(inputs[0], 1024)
              : deterministicEmbedding("", 1024);

          socket.write(jsonResponse(200, { embedding }));
          socket.end();
          return;
        }

        // ────────────────────────────────────────────────────────────

        // ────────────────────────────────────────────────────────────
        // GET /api/tags
        // ────────────────────────────────────────────────────────────
        if (method === "GET" && url === "/api/tags") {
          socket.write(
            jsonResponse(200, {
              models: [
                { name: "fake-chat-model" },
                { name: "fake-embed-model" },
              ],
            }),
          );
          socket.end();
          return;
        }

        // ────────────────────────────────────────────────────────────
        // Fallback
        // ────────────────────────────────────────────────────────────
        socket.write(jsonResponse(404, { error: "Not Found" }));
        socket.end();
      };

      socket.on("data", handleData);
      socket.on("error", () => {
        // Ignore client-side errors (e.g., request aborted for timeout test)
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;

      resolveStart({
        url,
        stop: () =>
          new Promise<void>((resolveStop) => {
            server.close(() => resolveStop());
          }),
        reset: resetRouteConfig,
        triggerMalformed: () => {
          routeConfig.malformed = true;
        },
        triggerTimeout: (ms: number) => {
          routeConfig.timeoutMs = ms;
        },
        trigger503: () => {
          routeConfig.status503 = true;
        },
      });
    });

    server.on("error", rejectStart);
  });
}
