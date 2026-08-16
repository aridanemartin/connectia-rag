# Task 8 brief: Implement activation, archive, preview sets, and vector cleanup

Source: `docs/superpowers/plans/2026-08-15-connectia-rag-demo.md`, Task 8.
Spec authority: `docs/superpowers/specs/2026-08-15-connectia-rag-demo-design.md`
(sections 5.4, 7, 9, 13 are directly binding on this task).

## Required TDD discipline

Follow strict RED → GREEN → refactor. Write the test(s), run them, confirm
the exact expected failure, then implement, then re-run to green. Do not
write production code before an observed red. Capture the RED and GREEN
command output for the report.

## Files

- Create: `src/documents/lifecycle.service.ts`
- Create: `src/workers/cleanup.worker.ts`
- Create: `src/api/routes/documents.ts`
- Modify: `src/api/app.ts` (wire lifecycle service through `AppDependencies`)
- Modify: `src/server.ts` (start cleanup worker loop, same pattern as indexing)
- Create: `tests/integration/document-lifecycle.test.ts`

Do not touch any other file. In particular do not modify
`src/persistence/repositories/document.repository.ts`,
`src/persistence/repositories/cleanup.repository.ts`, or
`src/workers/indexing.worker.ts` — Task 8 consumes these as-is.

## 1. `src/documents/lifecycle.service.ts` (new)

Thin, well-tested wrapper over the existing `DocumentRepository` methods.
DocumentRepository already implements the actual state-machine/transaction
logic from Task 3. Do not duplicate it.

```typescript
export interface LifecycleServiceReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  activeVersionIds(): string[];
  previewVersionIds(documentId: string, versionId: string): string[];
}

export interface LifecycleReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  allowedActiveVersions(): string[];
  allowedPreviewVersions(documentId: string, versionId: string): string[];
}

export class LifecycleService implements LifecycleReader {
  constructor(private readonly documents: LifecycleServiceReader) {}

  activate(documentId: string, versionId: string): DocumentVersion {
    return this.documents.activate(documentId, versionId);
  }

  archive(documentId: string, versionId: string): DocumentVersion {
    return this.documents.archive(documentId, versionId);
  }

  allowedActiveVersions(): string[] {
    return this.documents.activeVersionIds();
  }

  allowedPreviewVersions(documentId: string, versionId: string): string[] {
    return this.documents.previewVersionIds(documentId, versionId);
  }
}
```

`LifecycleServiceReader` is a structural `Pick<DocumentRepository,
'activate' | 'archive' | 'activeVersionIds' | 'previewVersionIds'>`-style
interface — define it in this file against the real `DocumentRepository`
class, importing `DocumentVersion` from `document.types.ts`.

## 2. `src/workers/cleanup.worker.ts` (new)

Follow the exact same shutdown-integration pattern Task 7's IndexingWorker
used: share the same `ActivityTracker`/`AbortSignal`, register any process
signal handling BEFORE starting worker loops (Task 7 hit and fixed a real
SIGTERM-registration race by getting this ordering wrong the first time —
read that ledger entry carefully), recover/reconcile expired leases before
starting the loop, and release cleanly on shutdown.

### Dependencies

```typescript
export interface CleanupJobLeaseRepository {
  leaseNext(owner: string, leaseMs: number): CleanupJob | undefined;
  retry(
    jobId: string,
    owner: string,
    code: string,
    message: string,
    delayMs: number,
  ): CleanupJob;
  complete(jobId: string, owner: string): boolean;
  recoverExpired(): number;
}

export interface CleanupVectorStore {
  deleteVersion(versionId: string): Promise<void>;
}

export interface CleanupWorkerDependencies {
  jobs: CleanupJobLeaseRepository;
  vectorStore: CleanupVectorStore;
  clock: Clock;
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}
```

### Transient error classifier

Re-use the same `isTransientDependencyError` from
`src/workers/indexing.worker.ts` — import it directly rather than
duplicating.

### Retry budget

**Ruling:** The plan's "limited exponential backoff" language for cleanup is
satisfied by the same budget already established for Task 7's indexing worker:
1 initial attempt + up to 3 retries (4 calls total), with delays of 250 ms,
500 ms, and 1000 ms between attempts. This matches the spec's "recoverable
Ollama and Qdrant failures use limited exponential backoff" language and is
consistent with the precedent set in the progress ledger for Task 7. Cost if
wrong: the cleanup worker would need different retry semantics than the
indexing worker for no clear domain reason.

Use the same `RETRY_DELAYS_MS = [250, 500, 1000]` and `withRetry` pattern
from `indexing.worker.ts`.

### `runOnce()` behavior

1. Call `this.deps.jobs.leaseNext(this.deps.owner, this.deps.leaseMs)`.
   If `undefined`, return `"idle"`.
2. Try to call `this.deps.vectorStore.deleteVersion(job.versionId)`.
3. On success: call `this.deps.jobs.complete(job.jobId, this.deps.owner)`.
   Return `"processed"`.
4. On transient failure (per `isTransientDependencyError`):
   - `this.deps.jobs.retry(job.jobId, this.deps.owner, errorCode,
     errorMessage, delayMs)` using the same bounded exponential delay from
     `RETRY_DELAYS_MS[attempt]`.
   - If retry throws `LeaseLostError` (another owner reclaimed), swallow it
     and return `"processed"`.
   - Return `"processed"`.
5. On non-transient failure:
   - `this.deps.jobs.retry(job.jobId, this.deps.owner, errorCode,
     errorMessage, 0)` — immediate retry with a safe error code.
   - If retry throws `LeaseLostError`, swallow it.
   - Return `"processed"`.
6. On any other error: swallow (defensive, same as IndexingWorker's `catch`
   in `start()`).

### Error codes for cleanup failures

| Condition | Code | Message |
|---|---|---|
| Transient (retryable) | `VECTOR_CLEANUP_RETRYABLE` | `No se han podido eliminar los vectores. Reintentando.` |
| Non-transient (immediate retry) | `VECTOR_CLEANUP_FAILED` | `No se han podido eliminar los vectores.` |

### `start(signal)` loop

```typescript
async start(signal: AbortSignal): Promise<void> {
  this.signal = signal;
  while (!signal.aborted) {
    let outcome: "processed" | "idle";
    try {
      outcome = await this.runOnce();
    } catch {
      outcome = "idle";
    }
    if (signal.aborted) return;
    if (outcome === "idle") {
      await this.abortAwareSleep(this.deps.pollIntervalMs, signal);
    }
  }
}
```

`abortAwareSleep` uses `setTimeout(ms, undefined, { signal })` from
`node:timers/promises` and catches/resolves on early cancellation, same
as IndexingWorker.

## 3. `src/api/routes/documents.ts` (new)

### Endpoints

- `POST /api/v1/documents/:documentId/versions/:versionId/activate`
- `POST /api/v1/documents/:documentId/versions/:versionId/archive`

### Schema

```typescript
const paramsSchema = z
  .object({
    documentId: z.uuid().transform((v) => v.toLowerCase()),
    versionId: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict();
```

### Router factory

```typescript
export function createDocumentsRouter(
  lifecycle: LifecycleReader,
  activity?: ActivityTracker,
): Router;
```

### Route handlers

**Activate:**
- Validate params.
- Call `lifecycle.activate(documentId, versionId)`.
- Return `200 { documentId, versionId, state: "ACTIVE" }`.
- On `InvalidStateTransitionError`: `409 VERSION_NOT_READY` ("La versión del
  documento no está lista para activar.").
- On `PersistenceNotFoundError`: `404 VERSION_NOT_FOUND` ("No se ha encontrado
  la versión del documento.").

**Archive:**
- Validate params.
- Call `lifecycle.archive(documentId, versionId)`.
- Return `200 { documentId, versionId, state: "ARCHIVED" }`.
- On `PersistenceNotFoundError`: `404 VERSION_NOT_FOUND`.

Both routes must use `activity.run(...)` for graceful shutdown, same as the
indexing route.

## 4. `src/api/app.ts` — wire the lifecycle service

Add to `AppDependencies`:

```typescript
lifecycle: LifecycleReader;
```

Add a safe default (mirroring the existing pattern):

```typescript
function unavailableLifecycle(): LifecycleReader {
  return {
    activate: () => {
      throw new AppError(503, "LIFECYCLE_UNAVAILABLE", "El servicio de ciclo de vida no está disponible.");
    },
    archive: () => {
      throw new AppError(503, "LIFECYCLE_UNAVAILABLE", "El servicio de ciclo de vida no está disponible.");
    },
    allowedActiveVersions: () => [],
    allowedPreviewVersions: () => [],
  };
}
```

Mount the documents router:

```typescript
app.use(
  "/api/v1/documents",
  createDocumentsRouter(
    deps.lifecycle ?? unavailableLifecycle(),
    activity,
  ),
);
```

The router must be mounted AFTER `authenticate(config)` (it's a protected
endpoint) and BEFORE the 404 catch-all.

## 5. `src/server.ts` — start cleanup worker

Follow the same pattern as the indexing worker in Task 7. The cleanup worker
shares the same `ActivityTracker` and uses the same `AbortSignal.any(...)`
construction.

Extend `IndexingComposition` (or create a new shared composition type) to
include the cleanup worker. The cleanup worker needs:
- `CleanupRepository` (already exists in the composition's database)
- `VectorStore.deleteVersion` (same `QdrantVectorStore` instance)
- A stable owner ID (new `randomUUID()`)
- Lease/poll config

The recommended approach is to extend the existing `IndexingComposition` in
`src/documents/indexing.service.ts` to also include `lifecycle` and
`cleanupWorker` (broadening the existing composition to cover the full
document lifecycle), rather than creating a separate composition factory.

```typescript
// In src/documents/indexing.service.ts, extend IndexingComposition:
export interface IndexingComposition {
  // ... existing fields ...
  lifecycle: LifecycleService;
  cleanupWorker: CleanupWorker;
  recoverExpiredCleanupJobs(): number;
}

// In src/server.ts:
// Same pattern as indexing worker:
// 1. composition.recoverExpiredCleanupJobs() before starting loop
// 2. cleanupTeardown = new AbortController()
// 3. cleanupSignal = AbortSignal.any([activity.signal, cleanupTeardown.signal])
// 4. cleanupLoop = composition.cleanupWorker.start(cleanupSignal).catch(...)
// 5. In shutdown(): cleanupTeardown?.abort(); await settlesWithin(cleanupLoop, abortGraceMs);
```

**Critical ordering (from Task 7's fix rounds):** Signal-handler
registration happens immediately after `listen()` succeeds, BEFORE the
"escucha en el puerto" log line, and BEFORE any worker loop setup. The
cleanup worker's teardown/loop are assigned as `let` bindings after the
log line (same as the indexing worker). shutdown() guards both workers
being possibly undefined.

## 6. `tests/integration/document-lifecycle.test.ts` (new)

Use real SQLite (`openDatabase(":memory:")` + `migrate`) and fake vector
store (no real network). Follow the existing patterns in
`tests/integration/indexing-worker.test.ts` and `tests/unit/persistence.test.ts`.

### LifecycleService tests

1. **Activates a READY version and returns it**: upsertIndexing + markReady +
   activate, assert state is ACTIVE and allowedActiveVersions contains it.
2. **Switches active versions**: activate v1, then v2 — v1 is ARCHIVED,
   v2 is ACTIVE, allowedActiveVersions returns only v2.
3. **Archive is idempotent**: archive same version twice, only one cleanup job.
4. **AllowedActiveVersions returns empty when nothing is active**.
5. **AllowedPreviewVersions builds the correct set**: activate doc A v1 and
   doc B v1, then preview doc A v2 → returns [doc A v2, doc B v1] (sorted).
6. **Archived versions are excluded from allowedActiveVersions**.

### CleanupWorker tests

7. **Processes a queued cleanup job**: enqueue via CleanupRepository, run
   worker.runOnce(), assert vectorStore.deleteVersion was called and the
   cleanup job is deleted.
8. **Returns idle when no cleanup jobs exist**.
9. **Retries a transient vector store failure**: mock deleteVersion to reject
   with ECONNRESET, assert retry is called with delay from RETRY_DELAYS_MS.
10. **Retries a non-transient failure immediately**: mock deleteVersion to
    reject with a plain Error, assert retry is called with delay 0.
11. **Recovery**: lease a cleanup job with a short lease, advance clock past
    it, recoverExpired(), then worker.runOnce() completes it.
12. **Does not crash when lease expires mid-processing**: short lease, clock
    advance in the mock, assert no throw.

### Stale vector invariant test

13. **A stale vector is never searchable**: This test confirms the structural
    invariant that every search path takes its allowed-version-id list from
    SQLite (DocumentRepository), never from Qdrant directly. Set up a fake
    vector store that records every `search()` call and verify the
    `allowedVersionIds` parameter always comes from
    `lifecycle.allowedActiveVersions()` or `lifecycle.allowedPreviewVersions()`.
    Specifically:
    - Create two versions (v1 active, v2 ready).
    - Call `lifecycle.allowedActiveVersions()` → [v1].
    - Archive v1.
    - Call `lifecycle.allowedActiveVersions()` → [].
    - Verify that any consumer of this service would pass only the SQLite-
      derived list to the vector store — since the LifecycleService owns
      the version-set derivation and VectorStore.search requires an
      explicit `allowedVersionIds` parameter, stale versions can never
      enter the search path through this API.

### Helper pattern

```typescript
class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
```

Use `createTestDatabase()` (same as `tests/unit/persistence.test.ts`).

## Ruling: cleanup worker retry budget

**Ruling:** Cleanup worker uses the same retry budget as the indexing worker:
1 initial attempt + 3 retries (4 total), delays [250, 500, 1000] ms, using
the existing `CleanupRepository.retry()`'s `delayMs` parameter. This matches
Task 7's precedent and the spec's "limited exponential backoff" language.
Cost if wrong: cleanup retries could be more or less aggressive than
indexing, but the domain (vector deletion from Qdrant) faces the same
transient failure modes and warrants the same bounded patience.

## Verification (run after GREEN, before reporting)

```bash
npm test -- tests/integration/document-lifecycle.test.ts
npm test -- tests/integration/document-lifecycle.test.ts tests/unit/persistence.test.ts
npm run typecheck
npm run lint
npm run build
npm test
npm ls --depth=0
npm ci --dry-run
git diff --check
```

The full `npm test` run must stay green, including every already-merged
test file. If any of those break, that is a signal the change touched
something out of scope.

## Report contract

Write the full report to
`.superpowers/sdd/2026-08-15-connectia-rag-demo/task-8-report.md`,
including: the RED output, the GREEN output for the full targeted command
above, the full `npm test` summary line, and any concerns.
