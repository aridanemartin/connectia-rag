# Task 11 brief: Expose canonical question, preview, and compatibility APIs

Source: `docs/superpowers/plans/2026-08-15-connectia-rag-demo.md`, Task 11.
Spec authority: `docs/superpowers/specs/2026-08-15-connectia-rag-demo-design.md`
(sections 5.3, 6, 9, 10, 12 are directly binding on this task).

## Required TDD discipline

Follow strict RED → GREEN → refactor. Write the failing contract tests,
run them, confirm the exact expected failure (missing routes), then
implement, then re-run to green.

## Files

- Create: `src/api/routes/questions.ts` (canonical `POST /api/v1/questions`)
- Create: `src/api/routes/compatibility.ts` (`GET /health`, `POST /ask`,
  `GET /api/v1/admin/jobs/:id/status`)
- Modify: `src/api/routes/documents.ts` (add preview route; fix missing
  error mapping for activate/archive — see Ruling 1)
- Modify: `src/api/app.ts` (wire `questionService` dependency; mount new
  routes)
- Modify: `src/api/openapi.ts` (register new paths)
- Modify: `src/documents/indexing.service.ts` (add `questionService` to the
  composition — see Ruling 2)
- Modify: `src/documents/lifecycle.service.ts` and
  `src/persistence/repositories/document.repository.ts` (add
  `allowedActiveVersionsByDocumentIds` — see Ruling 3)
- Create: `tests/contract/canonical-api.test.ts`
- Create: `tests/contract/compatibility-api.test.ts`

## Ruling 1: activate/archive error mapping was dropped in Task 8

Task 8's brief specified mapping `InvalidStateTransitionError` → `409
VERSION_NOT_READY` and `PersistenceNotFoundError` → `404 VERSION_NOT_FOUND`
in the activate/archive routes, but the shipped implementation let these
errors bubble to the error handler as `500 INTERNAL_ERROR` (the imports
became unused and were removed during the review round, silently dropping
the mapping). Task 11 fixes this while adding the preview route: a shared
error-mapping helper in `routes/documents.ts` maps lifecycle errors for
activate, archive, and preview consistently. Cost if wrong: the fix could
have waited for a later task, but it belongs with the route work here.

## Ruling 2: questionService joins the composition

The plan's Task 11 file list does not name `indexing.service.ts`, but the
production composition root must own the `QuestionService` (it already owns
the `OllamaProvider`, `QdrantVectorStore`, and `LifecycleService`). This is
the same manifest-list-omission pattern already ruled on for Tasks 3–5/7/9.
The composition gains `questionService` built from:
- `models` (existing `OllamaProvider`)
- `vectorStore` (existing `QdrantVectorStore`)
- `new GenerationGate({ concurrency: config.MAX_ACTIVE_GENERATIONS,
  maxQueued: config.MAX_QUEUED_GENERATIONS, timeoutMs:
  config.QUESTION_QUEUE_TIMEOUT_MS })`
- `topK: config.RAG_TOP_K`, `scoreThreshold: config.RAG_SCORE_THRESHOLD`

`server.ts` also threads `composition.questionService` into the
`AppDependencies` object.

## Ruling 3: legacy documentIds intersection needs a repository method

The compatibility `/ask` adapter must intersect legacy `documentIds` with
active logical documents (spec §6: "supplied IDs are intersected with
active documents and never bypass lifecycle filtering"). The existing
`allowedActiveVersions()` returns only version IDs, which cannot be
intersected by document ID. Add `activeVersionIdsByDocumentIds(documentIds:
readonly string[]): string[]` to `DocumentRepository` (a small SELECT over
active versions filtered in JS — the corpus is ~10 active documents) and
expose it as `allowedActiveVersionsByDocumentIds` on `LifecycleService`/
`LifecycleReader`.

## 1. `src/api/routes/questions.ts` — canonical endpoint

`POST /api/v1/questions`:

- Strict Zod body schema: `{ question: string }`, trimmed, 1–1000
  characters, `.strict()` (rejects `documentIds` and any unknown field).
- Calls `lifecycle.allowedActiveVersions()` then
  `questionService.ask(question, allowedVersionIds)`.
- Response 200: `{ status, answer, citations, requestId }`.
- Error mapping (shared helper used by preview too):
  - `QUESTION_INVALID` → `400 QUESTION_INVALID` (safe Spanish message)
  - `QUESTION_QUEUE_SATURATED` → `429 QUEUE_SATURATED` with
    `Retry-After` header set to `retryAfterSeconds`
  - `QUESTION_QUEUE_TIMEOUT` → `503 QUESTION_QUEUE_TIMEOUT`
  - `MODEL_OUTPUT_INVALID` → `502 MODEL_OUTPUT_INVALID`
- Wrapped in `activity.run(...)` for graceful shutdown, same pattern as
  the indexing route.

## 2. Preview route in `src/api/routes/documents.ts`

`POST /api/v1/documents/:documentId/versions/:versionId/preview`:

- Params validated as UUIDs; body validated like the canonical question.
- Calls `lifecycle.allowedPreviewVersions(documentId, versionId)` then
  `questionService.ask(question, previewVersionIds)`.
- Same response shape and error mapping as the canonical route.
- `InvalidStateTransitionError` (target not READY/ACTIVE) → `409
  VERSION_NOT_PREVIEWABLE`; `PersistenceNotFoundError` → `404
  VERSION_NOT_FOUND`.
- Wrapped in `activity.run(...)`.

## 3. `src/api/routes/compatibility.ts`

### `GET /health` (public)

Compact `{ "status": "ok" }`. Mounted before authentication.

### `POST /ask` (authenticated)

- Accepts `{ question: string, documentIds?: string[] }` (loose Zod
  schema — legacy clients may send extra fields, so `strip` unknown keys
  rather than reject).
- If `documentIds` supplied: `lifecycle.allowedActiveVersionsByDocumentIds(
  documentIds)`; otherwise `lifecycle.allowedActiveVersions()`.
- If the intersected version list is empty → the compatibility fallback
  (no lifecycle bypass; no retrieval possible).
- Calls `questionService.ask(...)`.
- Response 200: `{ answer: string, citations: [{ documentId, title,
  excerpt }], status? }`.
- When canonical answer is `null`: `answer` becomes
  `"No se encontró información suficiente en los documentos activos."` and
  `citations: []`.
- Legacy citations map from trusted canonical citations: `documentId`,
  `title` (from `documentTitle`), `excerpt`.
- `status` is included only when it differs from `found` (legacy clients
  tolerate it).

### `GET /api/v1/admin/jobs/:id/status` (authenticated)

Maps canonical job status to the external Week 13 shape:

| canonical | external |
|---|---|
| `queued` | `queued` |
| `processing` | `processing` |
| `completed` | `completed` |
| `failed` | `error` |

Response:
```json
{
  "id": "job-uuid",
  "status": "error",
  "progressDescription": "Extrayendo el texto del PDF",
  "errorCode": "VECTOR_STORE_UNAVAILABLE",
  "errorMessage": "No se ha podido almacenar el contenido indexado.",
  "completedAt": "2026-08-16T10:00:00.000Z"
}
```

`progressDescription` maps from canonical stage:
- `queued` → "En cola"
- `extracting` → "Extrayendo el texto del PDF"
- `chunking` → "Dividiendo el documento en fragmentos"
- `embedding` → "Generando los embeddings del documento"
- `storing` → "Almacenando los fragmentos en el índice"
- `finalizing` → "Finalizando la indexación"
- `completed` → "Completado"
- unknown/other → "Procesando"

Unknown job → `404 JOB_NOT_FOUND`; malformed id → `400 JOB_ID_INVALID`.

## 4. `src/api/app.ts` wiring

- Add `questionService: QuestionService` to `AppDependencies` with an
  `unavailableQuestionService()` default that throws `503
  QUESTION_UNAVAILABLE`.
- Mount `app.use("/api/v1/questions",
  createQuestionsRouter(questionService, lifecycle, activity))` after auth.
- Mount the preview-aware documents router (already mounted at
  `/api/v1/documents` — extend the existing router with the preview route).
- Mount compatibility: `app.use("/health",
  createHealthCompatibilityRouter())` before auth (public), and
  `app.use(createCompatibilityRouter(lifecycle, questionService, jobs,
  activity))` after auth (the router defines `/ask` and
  `/api/v1/admin/jobs/:id/status`).

## 5. `src/api/openapi.ts`

Register paths for `POST /api/v1/questions`, the preview path, `GET
/health`, `POST /ask`, and `GET /api/v1/admin/jobs/:id/status` with the
bearer security default.

## 6. Contract tests

Both test files build a full app with:
- Real SQLite (`openDatabase(":memory:")` + `migrate`) and real
  `DocumentRepository`/`LifecycleService`
- Fake model (`embedQuery`, `decide`), fake vector store (`search`), fake
  gate — no network
- `QuestionService` built from the fakes
- `createApp` with all dependencies wired

### `tests/contract/canonical-api.test.ts`

1. Rich canonical citation contract — active version indexed in SQLite,
   fake search returns a hit, fake decide returns found → assert 200 with
   full citation shape.
2. Rejects `documentIds` on the canonical route → 400.
3. `not_found` short-circuit → `{ status: "not_found", answer: null,
   citations: [] }`.
4. Preview route: READY candidate + active other document → preview version
   set used; 200 with citation.
5. Preview rejects a non-READY/ACTIVE target → 409 VERSION_NOT_PREVIEWABLE.
6. Unauthenticated canonical route → 401.
7. `QUEUE_SATURATED` → 429 with `Retry-After` header.
8. Malformed question body → 400.

### `tests/contract/compatibility-api.test.ts`

1. `/health` returns `{ status: "ok" }` without auth.
2. Authenticated `/ask` returns `{ answer, citations: [{ documentId,
   title, excerpt }] }`.
3. Unauthenticated `/ask` → 401.
4. `/ask` with `documentIds` intersects with active documents (documents
   not active are excluded).
5. `/ask` with null canonical answer → compatibility Spanish fallback
   string with `citations: []`.
6. Legacy status maps `failed` → `error` with `progressDescription`,
   `errorCode`, `errorMessage`, `completedAt`.
7. Legacy status maps `completed` → `completed`.
8. Unknown job → 404; malformed id → 400.

## Verification

```bash
npm test -- tests/contract/canonical-api.test.ts tests/contract/compatibility-api.test.ts
npm run typecheck
npm run lint
npm test
```

The full `npm test` run must stay green, including every already-merged
test file.

## Report contract

Write the full report to
`.superpowers/sdd/2026-08-15-connectia-rag-demo/task-11-report.md`,
including the RED output, GREEN output, full `npm test` summary, and
concerns.
