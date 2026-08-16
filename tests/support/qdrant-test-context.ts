/**
 * Qdrant test context for integration testing with a real Qdrant
 * instance via Testcontainers.
 *
 * Usage:
 *   const ctx = await startQdrantTestContext();
 *   // use ctx.clientUrl, ctx.collection in your tests
 *   await ctx.stop();
 */

import { GenericContainer, type StartedTestContainer } from "testcontainers";

export interface QdrantTestContext {
  /** The Qdrant gRPC + HTTP URL (e.g. http://localhost:6333) */
  clientUrl: string;
  /** Default test collection name */
  collection: string;
  /** Stop and remove the container */
  stop(): Promise<void>;
  /** The started container (for advanced usage) */
  container: StartedTestContainer;
}

const QDRANT_IMAGE = "qdrant/qdrant:v1.13.7";
const QDRANT_HTTP_PORT = 6333;

let contextCount = 0;
let dockerAvailable: boolean | undefined;

/**
 * Check if Docker is available by running `docker info`.
 * Caches the result.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== undefined) return dockerAvailable;
  try {
    const proc = await import("node:child_process");
    const result = proc.execSync("docker info", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: "pipe",
    });
    dockerAvailable = result.length > 0;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/**
 * Start a Qdrant test container.
 *
 * By default uses `qdrant/qdrant:v1.13.7`. Callers should wrap in
 * a describe with a long timeout (60s+) since pulling the image
 * can be slow on the first run.
 *
 * Throws if Docker is not available. Check with `isDockerAvailable()` first.
 */
export async function startQdrantTestContext(): Promise<QdrantTestContext> {
  contextCount += 1;
  const collection = `test_collection_${contextCount}_${Date.now()}`;

  const container = await new GenericContainer(QDRANT_IMAGE)
    .withExposedPorts(QDRANT_HTTP_PORT)
    .withStartupTimeout(60_000)
    .start();

  const httpPort = container.getMappedPort(QDRANT_HTTP_PORT);
  const host = container.getHost();
  const clientUrl = `http://${host}:${httpPort}`;

  return {
    clientUrl,
    collection,
    stop: async () => {
      try {
        await container.stop();
      } catch {
        // Ignore stop errors
      }
    },
    container,
  };
}