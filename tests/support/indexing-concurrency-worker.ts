import { parentPort, workerData } from "node:worker_threads";
import type { AppConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingRequest,
} from "../../src/documents/indexing.service.js";

interface ConcurrencyWorkerData {
  config: AppConfig;
  input: IndexingRequest;
}

const port = parentPort;
if (!port) {
  throw new Error("The indexing concurrency helper requires a parent port");
}

const data = workerData as ConcurrencyWorkerData;
const composition = createIndexingComposition(data.config);
port.postMessage({ type: "ready" });

await new Promise<void>((resolveReady) => {
  port.once("message", (message) => {
    if (message === "go") {
      resolveReady();
    }
  });
});

let result:
  | { type: "result"; status: 202; jobId: string }
  | { type: "result"; status: number; code: string };
try {
  const job = await composition.indexingService.enqueue(data.input);
  result = { type: "result", status: 202, jobId: job.id };
} catch (error) {
  result = {
    type: "result",
    status:
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500,
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "INTERNAL_ERROR",
  };
} finally {
  composition.close();
}
port.postMessage(result);
