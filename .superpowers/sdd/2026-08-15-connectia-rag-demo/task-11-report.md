# Task 11 report: Expose canonical question, preview, and compatibility APIs

Base commit: `63e61e33b4698d59a3b599da80a484b9adc51d9b`

## TDD evidence

### RED — the new contract test files fail because the routes don't exist

```
$ npm test -- tests/contract/canonical-api.test.ts tests/contract/compatibility-api.test.ts

 ❯ tests/contract/canonical-api.test.ts (8 tests | 7 failed)
 ❯ tests/contract/compatibility-api.test.ts (9 tests | 7 failed)

 FAIL  ... > returns the rich canonical citation contract
 AssertionError: expected 404 to be 200
```

This is the expected RED: the canonical questions route, preview route,
and compatibility routes do not exist yet, so all requests return 404.

### GREEN — all contract tests pass

```
$ npm test -- tests/contract/canonical-api.test.ts tests/contract/compatibility-api.test.ts

 Test Files  2 passed (2)
      Tests  17 passed (17)
```

After the review round (6 new regression tests):

```
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

### Full suite

```
$ npm test

 Test Files  22 passed (22)
      Tests  262 passed (262)
```

```
$ npm run typecheck   # clean, no output
$ npm run lint        # Checked 67 files. No fixes applied. (2 pre-existing warnings)
$ npm run build       # clean
$ npm ci --dry-run    # up to date
$ git diff --check    # clean
```

## What was implemented

### `src/api/routes/questions.ts` (new)

`POST /api/v1/questions` — canonical endpoint. Strict Zod body schema
(trimmed, 1–1000 chars, `.strict()` rejects `documentIds`). Calls
`lifecycle.allowedActiveVersions()` then `questionService.ask()`. Maps
`QUESTION_INVALID` → 400, `QUESTION_QUEUE_SATURATED` → 429 with
`Retry-After`, `QUESTION_QUEUE_TIMEOUT` → 503, `MODEL_OUTPUT_INVALID` →
502. Wrapped in `activity.run()`.

### `src/api/routes/documents.ts` (modified)

- Added `POST /:documentId/versions/:versionId/preview` — validates params
  and body, builds the preview version set via
  `lifecycle.allowedPreviewVersions()`, maps `VERSION_NOT_PREVIEWABLE` →
  409 and `VERSION_NOT_FOUND` → 404, maps question errors, wrapped in
  `activity.run()`.
- Fixed Task 8's missing activate/archive error mapping: now maps
  `InvalidStateTransitionError` → 409 `VERSION_NOT_READY` and
  `PersistenceNotFoundError` → 404 `VERSION_NOT_FOUND` (previously these
  bubbled to 500 INTERNAL_ERROR).

### `src/api/routes/compatibility.ts` (new)

- `GET /health` — public, `{ status: "ok" }`.
- `POST /ask` — legacy contract. Accepts `{ question, documentIds? }`
  (loose schema, strips unknown fields). `documentIds` are intersected
  with active documents via
  `lifecycle.allowedActiveVersionsByDocumentIds()`. Null/not_found/
  ambiguous canonical answers map to
  `"No se encontró información suficiente en los documentos activos."`
  with `citations: []`. Legacy citations map from trusted canonical
  payloads (`documentId`, `title`, `excerpt`).
- `GET /api/v1/admin/jobs/:id/status` — maps canonical status to the
  external shape: `failed` → `error`, `progressDescription` from stage,
  plus `errorCode`, `errorMessage`, `completedAt`. 404 unknown, 400
  malformed.

### `src/api/app.ts` (modified)

- Added `app.use(express.json())` (JSON body parsing was missing entirely).
- Added `questionService` dependency with `unavailableQuestionService()`
  default.
- Mounted `/health` compatibility router (public, before auth).
- Mounted questions router and compatibility router (after auth).
- Threaded `questionService` into the documents router for preview.

### `src/api/middleware/error-handler.ts` (modified)

Maps body-parser errors: `entity.parse.failed` → 400 `BODY_INVALID`,
`entity.too.large` → 413 `BODY_TOO_LARGE` (previously 500 INTERNAL_ERROR).

### `src/api/openapi.ts` (modified)

Registered paths for `/api/v1/questions`, preview, `/health`, `/ask`,
`/api/v1/admin/jobs/:id/status`.

### `src/documents/indexing.service.ts` (modified)

Composition gains `questionService` built from the existing
`OllamaProvider`, `QdrantVectorStore`, a `GenerationGate` from config
(`MAX_ACTIVE_GENERATIONS`, `MAX_QUEUED_GENERATIONS`,
`QUESTION_QUEUE_TIMEOUT_MS`), `RAG_TOP_K`, and `RAG_SCORE_THRESHOLD`.

### `src/persistence/repositories/document.repository.ts` (modified)

Added `activeVersionIdsByDocumentIds()` — active version IDs filtered by
document ID (needed for the legacy documentIds intersection).

### `src/documents/lifecycle.service.ts` (modified)

Added `allowedActiveVersionsByDocumentIds()` to `LifecycleReader`.

### `src/server.ts` (modified)

Threads `composition.questionService` into `AppDependencies`.

## Rulings applied

1. **Activate/archive error mapping dropped in Task 8** — fixed in this
   task while adding the preview route (shared error-mapping helper).
2. **questionService joins the composition** — the production composition
   root owns the QuestionService (manifest-list-omission ruling).
3. **Legacy documentIds intersection needs a repository method** — added
   `activeVersionIdsByDocumentIds`.

## Review outcome

Independent code review (code-reviewer subagent): 0 Critical, 4 Important,
3 Minor.

- Important #1 (addressed): preview of a non-existent version returned 500
  instead of 404 VERSION_NOT_FOUND — added `PersistenceNotFoundError` → 404
  mapping in the preview route.
- Important #2 (addressed): `/ask` 429 responses omitted `Retry-After` —
  restructured so error mapping happens inside `execute()` and the header is
  set on the mapped AppError.
- Important #3 (addressed): malformed JSON bodies returned 500 instead of
  400 — error handler now maps body-parser errors to 400/413.
- Important #4 (not changed, deliberate): `/docs` and `/openapi.json`
  require bearer auth. This matches the Task 2 ledger ruling ("protect
  `/docs` and `/openapi.json`; only health routes are public") and the spec
  §4 ("Every non-health request requires Authorization"). The reviewer's
  suggestion contradicts a settled ruling; no change made.
- Minor (addressed): `/ask` non-activity path skipped error mapping — now
  maps inside `execute()` for both paths.
- 6 new regression tests added (preview 404, malformed JSON 400, queue
  timeout 503, /ask positive intersection, /ask ambiguous fallback, /ask
  429 Retry-After).

## Concerns

- The `/docs` + `/openapi.json` auth decision is a deliberate continuation
  of the Task 2 ruling, not an oversight — flagged here because the reviewer
  raised it.
- No other concerns.

## Files changed

- `src/api/routes/questions.ts` (new)
- `src/api/routes/compatibility.ts` (new)
- `src/api/routes/documents.ts`
- `src/api/app.ts`
- `src/api/openapi.ts`
- `src/api/middleware/error-handler.ts`
- `src/documents/indexing.service.ts`
- `src/documents/lifecycle.service.ts`
- `src/persistence/repositories/document.repository.ts`
- `src/server.ts`
- `tests/contract/canonical-api.test.ts` (new)
- `tests/contract/compatibility-api.test.ts` (new)
- `.superpowers/sdd/2026-08-15-connectia-rag-demo/task-11-brief.md` (new)
