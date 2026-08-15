# Connectia RAG Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public, Spanish-only, self-hosted RAG HTTP service consumed by `connectia-teachers`, including document indexing, lifecycle management, grounded answers, compatibility endpoints, fixtures, tests, and Ubuntu Docker operations.

**Architecture:** One Node.js/TypeScript API owns HTTP contracts, SQLite lifecycle state, a single indexing worker, bounded question concurrency, and LangChain orchestration. Ollama provides local chat and embeddings, Qdrant stores vectors, and Caddy is the only production ingress; LangGraph, Redis, OCR, and hosted services remain outside the MVP.

**Tech Stack:** Node.js 24, npm 11, TypeScript ESM, Express 5, Zod, LangChain (`@langchain/ollama`, `@langchain/community`, `@langchain/textsplitters`), Qdrant JavaScript REST client, SQLite via `better-sqlite3`, Pino, Multer, Vitest, Supertest, PDF-Lib, Docker Compose, Ollama, Qdrant, and Caddy.

**Spec:** `docs/superpowers/specs/2026-08-15-connectia-rag-demo-design.md`

## Global Constraints

- Runtime is Node.js 24 with strict TypeScript, ESM imports, and npm lockfile pinning.
- All user-visible text and model output is Spanish; machine codes and identifiers remain English.
- Runtime inference is local Ollama only: default chat model `gemma3:12b`, default embedding model `qwen3-embedding:0.6b`.
- Qdrant and Ollama remain internal to the Compose network; Caddy is the only production ingress.
- Every non-health HTTP endpoint requires the shared bearer token.
- Questions are 1–1,000 trimmed characters; PDF uploads default to 25 MB and text-based PDFs only.
- SQLite is authoritative for lifecycle state; Qdrant is authoritative only for vector search data.
- Document states are `INDEXING`, `READY`, `ACTIVE`, `FAILED`, and `ARCHIVED`.
- Canonical job statuses are `queued`, `processing`, `completed`, and `failed`.
- Archived versions are immediately excluded by SQLite filters and their vectors are deleted through durable cleanup jobs.
- Ollama generation concurrency defaults to `2`; all waiting queues and timeouts are bounded.
- Diagnostic content is disabled by default and expires after 24 hours when enabled.
- CI and deterministic tests never download a model or call a hosted API.
- LangGraph, Redis, BullMQ, OCR, chat memory, agents, Kubernetes, and multi-node Qdrant are not introduced.
- Use TDD for each task: observe the specified failure before writing production code.
- Commit only files listed by the current task; never commit `.env`, secrets, SQLite files, model data, Qdrant data, temporary PDFs, or `.DS_Store`.

## Planned file map

```text
src/
├── api/
│   ├── app.ts                       # Express composition root
│   ├── errors.ts                    # Safe HTTP error envelope
│   ├── openapi.ts                   # OpenAPI registry and document
│   ├── routes/
│   │   ├── compatibility.ts         # /health, /ask, legacy status
│   │   ├── documents.ts             # activate, archive, preview
│   │   ├── health.ts                # liveness and readiness
│   │   ├── indexing.ts              # create/read indexing jobs
│   │   ├── internal-metrics.ts       # opt-in load-test telemetry
│   │   └── questions.ts             # canonical questions endpoint
│   └── middleware/
│       ├── authenticate.ts           # bearer authentication
│       ├── error-handler.ts          # AppError to JSON
│       └── request-id.ts             # request correlation
├── config/env.ts                     # validated runtime configuration
├── diagnostics/
│   ├── diagnostics.cli.ts            # operator-only CLI
│   ├── diagnostics.service.ts        # opt-in storage and expiry
│   └── runtime-metrics.ts             # process/queue load measurements
├── documents/
│   ├── document.types.ts             # lifecycle domain types
│   ├── indexing.service.ts           # enqueue/idempotency boundary
│   ├── lifecycle.service.ts          # activate/archive/preview set
│   ├── pdf-extractor.ts              # text PDF extraction
│   └── text-chunker.ts               # chunks with page/section metadata
├── health/readiness.service.ts       # dependency readiness aggregation
├── models/
│   ├── model-provider.ts             # model abstraction
│   └── ollama-provider.ts            # LangChain Ollama adapter
├── persistence/
│   ├── migrations/001_initial.sql    # SQLite schema
│   ├── database.ts                   # connection and transaction boundary
│   ├── migrate.ts                    # migration runner
│   └── repositories/
│       ├── cleanup.repository.ts
│       ├── diagnostics.repository.ts
│       ├── document.repository.ts
│       └── indexing-job.repository.ts
├── rag/
│   ├── answer.schema.ts              # structured model output
│   ├── citation.service.ts            # trusted citation construction
│   ├── generation-gate.ts            # bounded p-queue wrapper
│   ├── prompt.ts                      # Spanish grounding prompt
│   ├── question.service.ts            # retrieval/generation pipeline
│   ├── vector-store.ts                # vector abstraction
│   └── qdrant-vector-store.ts         # direct Qdrant adapter
├── shared/clock.ts                    # deterministic time seam
├── workers/
│   ├── cleanup.worker.ts              # vector deletion retries
│   └── indexing.worker.ts             # leased indexing pipeline
└── server.ts                          # startup and graceful shutdown

scripts/
├── generate-fixtures.ts               # deterministic PDFs
├── seed-corpus.ts                      # documented API-driven seed flow
└── wait-for-models.ts                  # Compose model readiness

fixtures/
├── sources/*.json                     # editable fictional content
├── pdfs/*.pdf                          # generated text PDFs
├── corpus.manifest.json                # stable IDs and activation order
└── evaluations/questions.json          # Spanish expected outcomes

tests/
├── contract/
├── e2e/
├── integration/
├── load/
├── support/
└── unit/
```

---

### Task 1: Bootstrap the TypeScript API and liveness endpoint

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config/env.ts`
- Create: `src/api/app.ts`
- Create: `src/api/routes/health.ts`
- Create: `src/server.ts`
- Test: `tests/unit/health-live.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `createApp(deps?: Partial<AppDependencies>): Express`
- Produces: `GET /health/live -> { status: 'ok' }`

- [ ] **Step 1: Create the npm project and install the foundation dependencies**

Run:

```bash
npm init -y
npm install express zod pino pino-http
npm install -D typescript tsx vitest supertest @types/express @types/node @types/supertest @biomejs/biome
```

Set `package.json` to ESM and add these scripts:

```json
{
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "biome check .",
    "format": "biome check --write .",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Write the failing liveness test**

```typescript
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';

describe('GET /health/live', () => {
  it('returns liveness without authentication', async () => {
    const response = await request(createApp()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 3: Run the focused test and observe the missing app failure**

Run: `npm test -- tests/unit/health-live.test.ts`

Expected: FAIL because `src/api/app.ts` does not exist.

- [ ] **Step 4: Implement strict configuration, app composition, and liveness**

Define `AppConfig` with `PORT`, `LOG_LEVEL`, `AUTH_TOKEN`, `AUTH_DISABLED`, `DATABASE_PATH`, `TEMP_DIR`, `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `QDRANT_URL`, `QDRANT_COLLECTION`, `EMBEDDING_DIMENSIONS`, `MAX_PDF_BYTES`, `MAX_ACTIVE_GENERATIONS`, `MAX_QUEUED_GENERATIONS`, `QUESTION_QUEUE_TIMEOUT_MS`, `RAG_TOP_K`, `RAG_SCORE_THRESHOLD`, `DIAGNOSTICS_ENABLED`, `DIAGNOSTICS_TTL_HOURS`, and `ENABLE_INTERNAL_METRICS`. Defaults must match the spec; internal metrics default to disabled.

```typescript
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  AUTH_TOKEN: z.string().min(32),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  OLLAMA_CHAT_MODEL: z.string().default('gemma3:12b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('qwen3-embedding:0.6b'),
  MAX_PDF_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MAX_ACTIVE_GENERATIONS: z.coerce.number().int().positive().default(2),
  DIAGNOSTICS_TTL_HOURS: z.coerce.number().int().positive().default(24),
});
```

Add `.DS_Store`, `.env`, `dist/`, `coverage/`, `data/`, `tmp/`, `*.sqlite*`, and `node_modules/` to `.gitignore`.

- [ ] **Step 5: Run foundation verification**

Run each command:

```bash
npm test -- tests/unit/health-live.test.ts
npm run typecheck
npm run lint
```

Expected: one passing test, zero TypeScript errors, zero Biome errors.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts biome.json .gitignore .env.example src tests/unit/health-live.test.ts
git commit -m "feat: bootstrap RAG API"
```

### Task 2: Add request IDs, safe errors, authentication, and OpenAPI

**Files:**
- Create: `src/api/errors.ts`
- Create: `src/api/middleware/request-id.ts`
- Create: `src/api/middleware/authenticate.ts`
- Create: `src/api/middleware/error-handler.ts`
- Create: `src/api/openapi.ts`
- Modify: `src/api/app.ts`
- Test: `tests/unit/http-boundary.test.ts`

**Interfaces:**
- Produces: `AppError(status: number, code: string, message: string, details?: unknown[])`
- Produces: `authenticate(config: AppConfig): RequestHandler`
- Produces: `X-Request-Id` header and `req.requestId`
- Produces: `GET /openapi.json` and `GET /docs`

- [ ] **Step 1: Install HTTP contract dependencies**

Run:

```bash
npm install @asteasolutions/zod-to-openapi swagger-ui-express
npm install -D @types/swagger-ui-express
```

- [ ] **Step 2: Write failing boundary tests**

```typescript
it('rejects a protected route without a bearer token', async () => {
  const response = await request(app).get('/api/v1/test-protected');
  expect(response.status).toBe(401);
  expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
});

it('publishes the canonical OpenAPI document', async () => {
  const response = await request(app).get('/openapi.json');
  expect(response.status).toBe(200);
  expect(response.body.info.title).toBe('Connectia RAG API');
  expect(response.body.components.securitySchemes.bearerAuth).toBeDefined();
});
```

- [ ] **Step 3: Run the tests and observe missing middleware**

Run: `npm test -- tests/unit/http-boundary.test.ts`

Expected: FAIL because protected routing, request IDs, and OpenAPI are absent.

- [ ] **Step 4: Implement the HTTP boundary**

Use `crypto.randomUUID()` when `X-Request-Id` is absent or invalid. Compare bearer tokens with equal-length buffers and `timingSafeEqual`. Never log the header or token.

```typescript
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown[],
  ) { super(message); }
}
```

Register health and documentation before authentication; mount all `/api/v1` routes behind authentication. The error handler must always return `{ error: { code, message, requestId, details? } }` and map unknown errors to Spanish `INTERNAL_ERROR` without exposing stack traces.

- [ ] **Step 5: Verify the HTTP boundary**

Run each command:

```bash
npm test -- tests/unit/http-boundary.test.ts
npm run typecheck
npm run lint
```

Expected: all boundary tests pass.

- [ ] **Step 6: Commit the boundary**

```bash
git add src/api tests/unit/http-boundary.test.ts package.json package-lock.json
git commit -m "feat: secure HTTP boundary"
```

### Task 3: Create the SQLite schema and repositories

**Files:**
- Create: `src/shared/clock.ts`
- Create: `src/documents/document.types.ts`
- Create: `src/persistence/migrations/001_initial.sql`
- Create: `src/persistence/database.ts`
- Create: `src/persistence/migrate.ts`
- Create: `src/persistence/repositories/document.repository.ts`
- Create: `src/persistence/repositories/indexing-job.repository.ts`
- Create: `src/persistence/repositories/cleanup.repository.ts`
- Create: `src/persistence/repositories/diagnostics.repository.ts`
- Test: `tests/unit/persistence.test.ts`

**Interfaces:**
- Produces: `Clock = { now(): Date }`
- Produces: `DocumentRepository.upsertIndexing(input)`, `markReady(versionId)`, `markFailed(versionId)`, `activate(documentId, versionId)`, `archive(documentId, versionId)`, `activeVersionIds()`, `previewVersionIds(documentId, versionId)`
- Produces: `IndexingJobRepository.enqueue(input)`, `find(jobId)`, `leaseNext(owner, leaseMs)`, `progress(jobId, stage, progress)`, `complete(jobId)`, `fail(jobId, code, message)`, `recoverExpired()`
- Produces: cleanup and diagnostics repository contracts used by Tasks 8 and 12.

- [ ] **Step 1: Install SQLite**

Run:

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Write failing migration and lifecycle tests**

```typescript
it('activates exactly one version per logical document', () => {
  const db = createTestDatabase();
  const repo = new DocumentRepository(db, fixedClock);
  repo.upsertIndexing(versionA); repo.markReady(versionA.versionId); repo.activate(versionA.documentId, versionA.versionId);
  repo.upsertIndexing(versionB); repo.markReady(versionB.versionId); repo.activate(versionB.documentId, versionB.versionId);
  expect(repo.activeVersionIds()).toEqual([versionB.versionId]);
  expect(repo.findVersion(versionA.versionId)?.state).toBe('ARCHIVED');
});

it('reclaims an expired processing lease', () => {
  const job = jobs.enqueue(jobInput);
  jobs.leaseNext('worker-a', 30_000);
  clock.advance(31_000);
  expect(jobs.recoverExpired()).toBe(1);
  expect(jobs.find(job.id)?.status).toBe('queued');
});
```

- [ ] **Step 3: Run the persistence tests and observe missing repositories**

Run: `npm test -- tests/unit/persistence.test.ts`

Expected: FAIL because the database and repositories do not exist.

- [ ] **Step 4: Implement the schema and migrations**

The migration must create `schema_migrations`, `documents`, `document_versions`, `indexing_jobs`, `vector_cleanup_jobs`, and `diagnostics`. Use foreign keys, state `CHECK` constraints, a unique `idempotency_key`, indexes for active versions and leasable jobs, and an `expires_at` index for diagnostics. `indexing_jobs` must persist `temp_file_path`, content hash, stage, progress, attempts, lease owner/deadline, safe error fields, and timestamps so an accepted upload survives process restarts.

```sql
CREATE UNIQUE INDEX one_active_version_per_document
ON document_versions(document_id)
WHERE state = 'ACTIVE';

CREATE INDEX leasable_indexing_jobs
ON indexing_jobs(status, lease_until, created_at);
```

`openDatabase()` must set `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`. Migration execution must be transactional and checksum each migration.

- [ ] **Step 5: Implement repository transitions and leases**

Activation must run one SQLite transaction: verify the target is `READY`, mark any previous active version `ARCHIVED`, enqueue one cleanup record for it, and mark the target `ACTIVE`. Archive must be idempotent and enqueue cleanup. Repositories return domain objects, never raw rows.

- [ ] **Step 6: Verify persistence**

Run each command:

```bash
npm test -- tests/unit/persistence.test.ts
npm run typecheck
npm run lint
```

Expected: migration, uniqueness, transition, lease, and expiry tests pass.

- [ ] **Step 7: Commit persistence**

```bash
git add src/shared src/documents/document.types.ts src/persistence tests/unit/persistence.test.ts package.json package-lock.json
git commit -m "feat: add durable lifecycle persistence"
```

### Task 4: Add Ollama and Qdrant adapters with readiness checks

**Files:**
- Create: `src/models/model-provider.ts`
- Create: `src/models/ollama-provider.ts`
- Create: `src/rag/vector-store.ts`
- Create: `src/rag/qdrant-vector-store.ts`
- Create: `src/health/readiness.service.ts`
- Modify: `src/api/routes/health.ts`
- Modify: `src/api/app.ts`
- Test: `tests/unit/dependency-adapters.test.ts`
- Test: `tests/unit/health-ready.test.ts`

**Interfaces:**
- Produces: `ModelProvider.embedDocuments(texts: string[]): Promise<number[][]>`
- Produces: `ModelProvider.embedQuery(text: string): Promise<number[]>`
- Produces: `ModelProvider.decide(input: GroundedPrompt): Promise<unknown>` where `GroundedPrompt = { system: string; question: string; context: ReadonlyArray<{ chunkId: string; text: string; documentTitle: string; page: number; section: string | null }> }`
- Produces: `ModelProvider.health(): Promise<{ chat: boolean; embeddings: boolean; dimensions: number }>`
- Produces: `VectorStore.ensureCollection(dimensions: number): Promise<void>`, `upsert`, `search`, `deleteVersion`, and `health`.

- [ ] **Step 1: Install current LangChain and Qdrant packages**

Run:

```bash
npm install @langchain/core @langchain/ollama @langchain/community @langchain/textsplitters @qdrant/js-client-rest
```

- [ ] **Step 2: Write failing adapter tests with fake clients**

```typescript
it('filters every search to the allowed version IDs', async () => {
  await store.search([0.1, 0.2], ['version-a', 'version-b'], 6, 0.55);
  expect(qdrant.query).toHaveBeenCalledWith('connectia_chunks', expect.objectContaining({
    filter: { must: [{ key: 'versionId', match: { any: ['version-a', 'version-b'] } }] },
    score_threshold: 0.55,
  }));
});

it('reports not ready when an expected Ollama model is absent', async () => {
  fakeFetch.respondWithTags(['gemma3:12b']);
  await expect(provider.health()).resolves.toMatchObject({ chat: true, embeddings: false });
});
```

- [ ] **Step 3: Run adapter tests and observe missing implementations**

Run: `npm test -- tests/unit/dependency-adapters.test.ts tests/unit/health-ready.test.ts`

Expected: FAIL because model, vector, and readiness adapters are absent.

- [ ] **Step 4: Implement adapters using current APIs**

Use `ChatOllama` and `OllamaEmbeddings` from `@langchain/ollama`. Use `QdrantClient.createCollection`, `upsert`, `query`, and filtered `delete` directly so deterministic IDs and payload deletion remain under application control.

```typescript
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

export interface SearchHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}
```

`ensureCollection` creates cosine vectors when absent and throws `VECTOR_DIMENSION_MISMATCH` when existing dimensions differ. `health` verifies collection configuration and required Ollama tags.

- [ ] **Step 5: Implement readiness aggregation**

Return `200 { status: 'ready', dependencies }` only when SQLite, Qdrant, the collection, Ollama, both models, and embedding dimensions are valid. Otherwise return `503 { status: 'not_ready', dependencies }`. Never include URLs, tokens, or stack traces.

- [ ] **Step 6: Verify adapters and readiness**

Run each command:

```bash
npm test -- tests/unit/dependency-adapters.test.ts tests/unit/health-ready.test.ts
npm run typecheck
npm run lint
```

Expected: filtering, deletion, dimension mismatch, model presence, and readiness tests pass.

- [ ] **Step 7: Commit dependency adapters**

```bash
git add src/models src/rag/vector-store.ts src/rag/qdrant-vector-store.ts src/health src/api tests/unit package.json package-lock.json
git commit -m "feat: add local model and vector adapters"
```

### Task 5: Extract and chunk text PDFs with trusted metadata

**Files:**
- Create: `src/documents/pdf-extractor.ts`
- Create: `src/documents/text-chunker.ts`
- Create: `tests/support/create-test-pdf.ts`
- Test: `tests/unit/pdf-processing.test.ts`

**Interfaces:**
- Produces: `PdfExtractor.extract(path: string): Promise<ExtractedPage[]>`
- Produces: `TextChunker.split(input: ChunkInput): Promise<Chunk[]>`
- Produces: deterministic `pointId = uuidv5(versionId + ':' + chunkIndex, namespace)` and SHA-256 content hash.

- [ ] **Step 1: Install PDF and deterministic-ID dependencies**

Run:

```bash
npm install uuid
npm install -D pdf-lib @types/uuid
```

- [ ] **Step 2: Write failing PDF processing tests**

```typescript
it('preserves page and inferred section on every chunk', async () => {
  const path = await createTestPdf([
    ['MATRÍCULA', 'El plazo termina el 15 de julio.'],
    ['DOCUMENTACIÓN', 'Debe presentarse el formulario firmado.'],
  ]);
  const pages = await extractor.extract(path);
  const chunks = await chunker.split({ ...metadata, pages });
  expect(chunks.map(c => c.page)).toEqual([1, 2]);
  expect(chunks.map(c => c.section)).toEqual(['MATRÍCULA', 'DOCUMENTACIÓN']);
  expect(new Set(chunks.map(c => c.pointId)).size).toBe(chunks.length);
});

it('rejects a PDF without enough extractable text', async () => {
  const path = await createTestPdf([['', '']]);
  await expect(extractor.extract(path)).rejects.toMatchObject({ code: 'PDF_TEXT_NOT_FOUND' });
});
```

- [ ] **Step 3: Run PDF tests and observe missing processors**

Run: `npm test -- tests/unit/pdf-processing.test.ts`

Expected: FAIL because extractor and chunker do not exist.

- [ ] **Step 4: Implement extraction and chunking**

Validate `%PDF-` before parsing. Use `PDFLoader` from `@langchain/community/document_loaders/fs/pdf` with page splitting enabled so page numbers remain trustworthy. Reject encryption, parse errors, and fewer than `MIN_EXTRACTED_CHARACTERS` non-whitespace characters with distinct safe codes.

Use `RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 })`. Infer section from the nearest short heading on the same page; otherwise use `null`. Store normalized text, never model-generated metadata.

- [ ] **Step 5: Verify PDF behavior**

Run each command:

```bash
npm test -- tests/unit/pdf-processing.test.ts
npm run typecheck
npm run lint
```

Expected: multi-page, section, deterministic ID, corrupt PDF, and empty-text cases pass.

- [ ] **Step 6: Commit PDF processing**

```bash
git add src/documents tests/support/create-test-pdf.ts tests/unit/pdf-processing.test.ts package.json package-lock.json
git commit -m "feat: extract and chunk Spanish PDFs"
```

### Task 6: Enqueue idempotent multipart indexing jobs

**Files:**
- Create: `src/documents/indexing.service.ts`
- Create: `src/api/routes/indexing.ts`
- Modify: `src/api/app.ts`
- Test: `tests/integration/indexing-create.test.ts`

**Interfaces:**
- Produces: `IndexingService.enqueue(input: IndexingRequest): Promise<IndexingJob>`
- Produces: `POST /api/v1/indexing/jobs -> 202`
- Consumes: repositories from Task 3 and `AppConfig.MAX_PDF_BYTES`.

- [ ] **Step 1: Install multipart support**

Run:

```bash
npm install multer
npm install -D @types/multer
```

- [ ] **Step 2: Write failing endpoint tests**

```typescript
it('accepts one authenticated PDF and returns a queued job', async () => {
  const response = await authenticated(request(app).post('/api/v1/indexing/jobs'))
    .set('Idempotency-Key', 'index-matricula-2026')
    .field('documentId', documentId)
    .field('versionId', versionId)
    .field('title', 'Matrícula 2026-2027')
    .field('academicYear', '2026-2027')
    .attach('file', pdfPath, 'matricula.pdf');
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ status: 'queued' });
});

it('returns 409 when an idempotency key is reused with different bytes', async () => {
  await sendPdf(firstPdf);
  const response = await sendPdf(secondPdf);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
});
```

- [ ] **Step 3: Run endpoint tests and observe the missing route**

Run: `npm test -- tests/integration/indexing-create.test.ts`

Expected: FAIL with 404 for the indexing route.

- [ ] **Step 4: Implement bounded temporary upload and request hashing**

Multer writes to `TEMP_DIR`, permits exactly one file, and enforces `MAX_PDF_BYTES`. Validate UUIDs, academic year `^\d{4}-\d{4}$`, title length, `.pdf`, `application/pdf`, and magic bytes. Compute `requestHash = sha256(fileContentHash + canonicalMetadataJson)`.

On success, atomically upsert the document/version as `INDEXING` and enqueue the job. On any rejected request, remove the temporary file before returning.

- [ ] **Step 5: Verify enqueue behavior**

Run each command:

```bash
npm test -- tests/integration/indexing-create.test.ts
npm run typecheck
npm run lint
```

Expected: auth, accepted upload, oversize, wrong magic bytes, invalid fields, same-key replay, and conflicting-key tests pass.

- [ ] **Step 6: Commit job enqueueing**

```bash
git add src/documents/indexing.service.ts src/api tests/integration/indexing-create.test.ts package.json package-lock.json
git commit -m "feat: enqueue idempotent indexing jobs"
```

### Task 7: Process leased indexing jobs and expose status

**Files:**
- Create: `src/workers/indexing.worker.ts`
- Modify: `src/api/routes/indexing.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/indexing-worker.test.ts`
- Test: `tests/integration/indexing-status.test.ts`

**Interfaces:**
- Produces: `IndexingWorker.start(signal: AbortSignal): Promise<void>`
- Produces: `IndexingWorker.runOnce(): Promise<'processed' | 'idle'>`
- Produces: `GET /api/v1/indexing/jobs/:jobId`
- Consumes: PDF processor, model provider, vector store, and repositories.

- [ ] **Step 1: Write failing worker happy-path and cleanup tests**

```typescript
it('moves a valid PDF from queued to completed and marks its version READY', async () => {
  const job = await enqueueFixture();
  await worker.runOnce();
  expect(jobs.find(job.id)?.status).toBe('completed');
  expect(documents.findVersion(job.versionId)?.state).toBe('READY');
  expect(vectorStore.upsert).toHaveBeenCalled();
  expect(existsSync(job.tempFilePath)).toBe(false);
});

it('cleans partial vectors and marks failures safely', async () => {
  vectorStore.upsert.mockRejectedValueOnce(new Error('connection details must not leak'));
  const job = await enqueueFixture();
  await worker.runOnce();
  expect(jobs.find(job.id)).toMatchObject({ status: 'failed', errorCode: 'VECTOR_STORE_UNAVAILABLE' });
  expect(vectorStore.deleteVersion).toHaveBeenCalledWith(job.versionId);
});
```

- [ ] **Step 2: Run worker tests and observe missing processing**

Run: `npm test -- tests/integration/indexing-worker.test.ts tests/integration/indexing-status.test.ts`

Expected: FAIL because no worker or status route exists.

- [ ] **Step 3: Implement the exact indexing stages**

Stages and progress are `extracting: 15`, `chunking: 35`, `embedding: 55`, `storing: 85`, `finalizing: 95`, `completed: 100`. Embed in configurable bounded batches. Retry only typed transient Ollama/Qdrant failures, with at most three attempts and exponential delays of 250 ms, 500 ms, and 1,000 ms.

Always remove the temporary file in `finally`. On terminal failure, sanitize the message, mark job/version failed, and attempt filtered vector deletion.

- [ ] **Step 4: Implement status serialization and startup recovery**

The status route returns the exact canonical fields in the spec. At server startup call `recoverExpired()` before starting the worker loop. On shutdown abort the loop and release its current lease.

- [ ] **Step 5: Verify indexing processing**

Run each command:

```bash
npm test -- tests/integration/indexing-worker.test.ts tests/integration/indexing-status.test.ts
npm run typecheck
npm run lint
```

Expected: success, empty text, model outage, Qdrant outage, lease recovery, retry cap, safe error, temporary cleanup, and status serialization tests pass.

- [ ] **Step 6: Commit the worker**

```bash
git add src/workers/indexing.worker.ts src/api/routes/indexing.ts src/server.ts tests/integration
git commit -m "feat: process durable indexing jobs"
```

### Task 8: Implement activation, archive, preview sets, and vector cleanup

**Files:**
- Create: `src/documents/lifecycle.service.ts`
- Create: `src/workers/cleanup.worker.ts`
- Create: `src/api/routes/documents.ts`
- Modify: `src/api/app.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/document-lifecycle.test.ts`

**Interfaces:**
- Produces: `LifecycleService.activate(documentId, versionId)`
- Produces: `LifecycleService.archive(documentId, versionId)`
- Produces: `LifecycleService.allowedActiveVersions()`
- Produces: `LifecycleService.allowedPreviewVersions(documentId, versionId)`
- Produces: activate/archive HTTP routes and `CleanupWorker.runOnce()`.

- [ ] **Step 1: Write failing lifecycle tests**

```typescript
it('switches active versions before deleting old vectors', async () => {
  await lifecycle.activate(documentId, oldVersionId);
  await lifecycle.activate(documentId, newVersionId);
  expect(await lifecycle.allowedActiveVersions()).toEqual([newVersionId]);
  expect(documents.findVersion(oldVersionId)?.state).toBe('ARCHIVED');
  expect(cleanups.findByVersion(oldVersionId)).toBeDefined();
});

it('builds preview IDs by substituting only the same logical document', async () => {
  expect(await lifecycle.allowedPreviewVersions(documentId, readyVersionId))
    .toEqual(expect.arrayContaining([readyVersionId, otherActiveVersionId]));
  expect(await lifecycle.allowedPreviewVersions(documentId, readyVersionId))
    .not.toContain(currentVersionId);
});
```

- [ ] **Step 2: Run lifecycle tests and observe missing services**

Run: `npm test -- tests/integration/document-lifecycle.test.ts`

Expected: FAIL because lifecycle and cleanup services do not exist.

- [ ] **Step 3: Implement lifecycle rules and HTTP routes**

Activation accepts only `READY` targets and is idempotent for an already active target. Archive is idempotent, immediately excludes the version in SQLite, and rejects reactivation of archived versions with `409 VERSION_REINDEX_REQUIRED`.

- [ ] **Step 4: Implement durable cleanup retries**

Lease cleanup rows, call `vectorStore.deleteVersion(versionId)`, delete the cleanup row on success, and schedule bounded exponential retry on transient failure. A stale vector can never be searched because all queries require SQLite-derived version filters.

- [ ] **Step 5: Verify lifecycle and cleanup**

Run each command:

```bash
npm test -- tests/integration/document-lifecycle.test.ts
npm run typecheck
npm run lint
```

Expected: state guards, idempotency, active uniqueness, preview substitution, immediate exclusion, deletion, and retry tests pass.

- [ ] **Step 6: Commit lifecycle management**

```bash
git add src/documents/lifecycle.service.ts src/workers/cleanup.worker.ts src/api/routes/documents.ts src/api/app.ts src/server.ts tests/integration/document-lifecycle.test.ts
git commit -m "feat: manage document version lifecycle"
```

### Task 9: Add bounded generation concurrency and backpressure

**Files:**
- Create: `src/rag/generation-gate.ts`
- Test: `tests/unit/generation-gate.test.ts`

**Interfaces:**
- Produces: `GenerationGate.run<T>(operation: () => Promise<T>): Promise<T>`
- Produces: `GenerationGate.stats(): { active: number; queued: number; capacity: number }`
- Throws: `QUEUE_SATURATED` with `retryAfterSeconds` and `QUEUE_TIMEOUT`.

- [ ] **Step 1: Install the queue primitive**

Run: `npm install p-queue`

- [ ] **Step 2: Write failing concurrency tests**

```typescript
it('runs only two generations and rejects beyond bounded waiting capacity', async () => {
  const gate = new GenerationGate({ concurrency: 2, maxQueued: 2, timeoutMs: 1000 });
  const blockers = Array.from({ length: 4 }, () => gate.run(deferredOperation));
  await expect(gate.run(async () => 'extra')).rejects.toMatchObject({ code: 'QUEUE_SATURATED' });
  expect(gate.stats()).toMatchObject({ active: 2, queued: 2 });
  releaseAll(); await Promise.all(blockers);
});
```

- [ ] **Step 3: Run the focused test and observe the missing gate**

Run: `npm test -- tests/unit/generation-gate.test.ts`

Expected: FAIL because `GenerationGate` does not exist.

- [ ] **Step 4: Implement a strict `PQueue` wrapper**

Reject synchronously when `pending + size >= concurrency + maxQueued`. Apply a per-item queue timeout and always decrement observable state in `finally`. Translate saturation to HTTP `429` with `Retry-After`; translate wait timeout to `503 QUESTION_QUEUE_TIMEOUT`.

- [ ] **Step 5: Verify concurrency behavior**

Run each command:

```bash
npm test -- tests/unit/generation-gate.test.ts
npm run typecheck
npm run lint
```

Expected: concurrency, FIFO ordering, saturation, timeout, rejection cleanup, and stats tests pass.

- [ ] **Step 6: Commit backpressure**

```bash
git add src/rag/generation-gate.ts tests/unit/generation-gate.test.ts package.json package-lock.json
git commit -m "feat: bound local model concurrency"
```

### Task 10: Build grounded retrieval, structured decisions, and citations

**Files:**
- Create: `src/rag/answer.schema.ts`
- Create: `src/rag/prompt.ts`
- Create: `src/rag/citation.service.ts`
- Create: `src/rag/question.service.ts`
- Test: `tests/unit/question-service.test.ts`

**Interfaces:**
- Produces: `QuestionService.ask(question, allowedVersionIds): Promise<QuestionResponse>`
- Produces: `QuestionResponse = { status: 'found' | 'not_found' | 'ambiguous'; answer: string | null; citations: Citation[] }`
- Consumes: `ModelProvider`, `VectorStore`, and `GenerationGate`.

- [ ] **Step 1: Write failing grounding tests**

```typescript
it('returns not_found without chat generation when retrieval is empty', async () => {
  vectorStore.search.mockResolvedValue([]);
  await expect(service.ask('¿Cuál es el plazo?', ['v1'])).resolves.toEqual({
    status: 'not_found', answer: null, citations: [],
  });
  expect(model.decide).not.toHaveBeenCalled();
});

it('rejects a model citation that was not retrieved', async () => {
  vectorStore.search.mockResolvedValue([retrievedChunk]);
  model.decide.mockResolvedValue({ status: 'found', answer: 'Texto', citedChunkIds: ['invented'] });
  await expect(service.ask('Pregunta', ['v1'])).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
});
```

- [ ] **Step 2: Run grounding tests and observe missing RAG services**

Run: `npm test -- tests/unit/question-service.test.ts`

Expected: FAIL because schemas, prompt, citation, and question services do not exist.

- [ ] **Step 3: Implement strict structured output**

```typescript
export const answerDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), answer: z.string().min(1), citedChunkIds: z.array(z.string()).min(1) }),
  z.object({ status: z.literal('not_found'), answer: z.null(), citedChunkIds: z.array(z.string()).length(0) }),
  z.object({ status: z.literal('ambiguous'), answer: z.null(), citedChunkIds: z.array(z.string()).length(0) }),
]);
```

The Spanish prompt must state that context is untrusted data, document instructions must be ignored, unsupported facts are forbidden, and every found answer must cite retrieved chunk IDs.

- [ ] **Step 4: Implement the exact question pipeline**

Embed the question, call `vectorStore.search(vector, allowedVersionIds, topK, threshold)`, short-circuit empty results, generate inside `GenerationGate`, parse structured output, run one repair call after the first invalid result, then fail with `MODEL_OUTPUT_INVALID` after the second.

Build citations only from retrieved payloads. Trim excerpts to 300 characters around the most relevant text. De-duplicate repeated chunk IDs while preserving score order.

- [ ] **Step 5: Verify grounded behavior**

Run each command:

```bash
npm test -- tests/unit/question-service.test.ts
npm run typecheck
npm run lint
```

Expected: found, not found, ambiguous, prompt injection, invalid ID, repair, duplicate ID, excerpt, queue, and model failure tests pass.

- [ ] **Step 6: Commit the RAG core**

```bash
git add src/rag tests/unit/question-service.test.ts
git commit -m "feat: answer questions with grounded citations"
```

### Task 11: Expose canonical question, preview, and compatibility APIs

**Files:**
- Create: `src/api/routes/questions.ts`
- Create: `src/api/routes/compatibility.ts`
- Modify: `src/api/routes/documents.ts`
- Modify: `src/api/app.ts`
- Modify: `src/api/openapi.ts`
- Test: `tests/contract/canonical-api.test.ts`
- Test: `tests/contract/compatibility-api.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/questions`
- Produces: `POST /api/v1/documents/:documentId/versions/:versionId/preview`
- Produces: `GET /health`, `POST /ask`, and `GET /api/v1/admin/jobs/:id/status`.

- [ ] **Step 1: Write failing canonical contract tests**

```typescript
it('returns the rich canonical citation contract', async () => {
  const response = await authenticated(request(app).post('/api/v1/questions'))
    .send({ question: '¿Cuál es el horario?' });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    status: 'found',
    citations: [{ documentId, versionId, documentTitle: 'Horario', page: 2, academicYear: '2026-2027' }],
  });
});

it('rejects documentIds on the canonical public question route', async () => {
  const response = await authenticated(request(app).post('/api/v1/questions'))
    .send({ question: 'Pregunta', documentIds: [documentId] });
  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Write failing legacy contract tests**

Assert authenticated `/ask` returns `{ answer: string, citations: [{ documentId, title, excerpt }], status? }`, unauthenticated `/ask` returns `401`, `/health` returns `{ status: 'ok' }` without authentication, and legacy status maps `failed` to `error` with `progressDescription`, `errorCode`, `errorMessage`, and `completedAt`.

- [ ] **Step 3: Run contract tests and observe missing endpoints**

Run: `npm test -- tests/contract/canonical-api.test.ts tests/contract/compatibility-api.test.ts`

Expected: FAIL with missing canonical and compatibility routes.

- [ ] **Step 4: Implement canonical endpoints and preview selection**

Use strict Zod schemas. Canonical questions call `LifecycleService.allowedActiveVersions()`; previews call `LifecycleService.allowedPreviewVersions(documentId, versionId)`. Map `QUEUE_SATURATED` to `429` with `Retry-After` and keep all other safe error mappings consistent.

- [ ] **Step 5: Implement compatibility adapters without bypassing lifecycle**

Legacy `documentIds` are intersected with SQLite active logical documents. Null canonical answers map to `No se encontró información suficiente en los documentos activos.` Legacy citations use trusted canonical payloads only. Mount `/ask` behind the same bearer-token middleware as `/api/v1`; only `/health`, `/health/live`, `/health/ready`, and API documentation remain public.

- [ ] **Step 6: Register every schema in OpenAPI and verify contracts**

Run each command:

```bash
npm test -- tests/contract/canonical-api.test.ts tests/contract/compatibility-api.test.ts
npm run typecheck
npm run lint
```

Expected: all canonical, preview, auth, validation, legacy shape, status mapping, and OpenAPI path tests pass.

- [ ] **Step 7: Commit HTTP contracts**

```bash
git add src/api tests/contract
git commit -m "feat: expose canonical and compatible RAG APIs"
```

### Task 12: Add opt-in expiring diagnostics and operator CLI

**Files:**
- Create: `src/diagnostics/diagnostics.service.ts`
- Create: `src/diagnostics/diagnostics.cli.ts`
- Modify: `src/rag/question.service.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Test: `tests/unit/diagnostics.test.ts`

**Interfaces:**
- Produces: `DiagnosticsService.record(entry)`, `purgeExpired()`, and `listRecent(limit)`.
- Produces: `npm run diagnostics -- list --limit 20` and `npm run diagnostics -- purge`.
- No HTTP diagnostics endpoint is created.

- [ ] **Step 1: Write failing retention tests**

```typescript
it('stores nothing while diagnostics are disabled', async () => {
  await disabled.record(entry);
  expect(repository.count()).toBe(0);
});

it('purges content exactly after the configured 24-hour TTL', async () => {
  await enabled.record(entry);
  clock.advance(24 * 60 * 60 * 1000 + 1);
  expect(await enabled.purgeExpired()).toBe(1);
});
```

- [ ] **Step 2: Run retention tests and observe missing diagnostics service**

Run: `npm test -- tests/unit/diagnostics.test.ts`

Expected: FAIL because diagnostics service and CLI are absent.

- [ ] **Step 3: Implement opt-in recording and cleanup**

Store request ID, question, nullable answer, retrieved chunk IDs, and expiry only when `DIAGNOSTICS_ENABLED=true`. Call `purgeExpired()` at startup and hourly. Never write diagnostics through the ordinary logger.

- [ ] **Step 4: Implement the operator-only CLI**

Require local database access and `DIAGNOSTICS_ENABLED=true`; output JSON lines with no auth token. `list` caps at 100 rows. `purge` exits zero and prints the deleted count.

- [ ] **Step 5: Verify diagnostics**

Run each command:

```bash
npm test -- tests/unit/diagnostics.test.ts
npm run typecheck
npm run lint
```

Expected: disabled, enabled, TTL boundary, startup purge, CLI cap, and no-HTTP-route tests pass.

- [ ] **Step 6: Commit diagnostics**

```bash
git add src/diagnostics src/rag/question.service.ts src/server.ts tests/unit/diagnostics.test.ts package.json
git commit -m "feat: add expiring local diagnostics"
```

### Task 13: Containerize the complete Ubuntu stack

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.yaml`
- Create: `compose.dev.yaml`
- Create: `Caddyfile`
- Create: `scripts/wait-for-models.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Test: `tests/contract/compose-config.test.ts`

**Interfaces:**
- Produces: Compose services `api`, `ollama`, `model-init`, `qdrant`, and `caddy`.
- Produces: volumes `api_data`, `ollama_models`, and `qdrant_data`.
- Production publishes only Caddy; development override may publish API, Ollama, and Qdrant on loopback.

- [ ] **Step 1: Write the failing Compose policy test**

Parse `docker compose config --format json` when Docker is available and otherwise parse YAML. Assert production has no published ports for `api`, `ollama`, or `qdrant`, all images are pinned, health checks exist, and three named volumes exist.

- [ ] **Step 2: Run the policy test and observe missing deployment files**

Run: `npm test -- tests/contract/compose-config.test.ts`

Expected: FAIL because Compose and Docker files do not exist.

- [ ] **Step 3: Implement a non-root multi-stage API image**

Use `node:24.17.0-bookworm-slim`, build TypeScript in a builder stage, copy production dependencies and `dist`, create `/data/sqlite` and `/data/tmp`, run as an unprivileged user, and include an HTTP liveness health check.

- [ ] **Step 4: Implement Compose dependencies and model initialization**

Pin `ollama/ollama:0.32.5`, `qdrant/qdrant:v1.18.3`, and `caddy:2.11.4-alpine`. `model-init` uses the pinned Ollama image and pulls exactly `${OLLAMA_CHAT_MODEL}` and `${OLLAMA_EMBEDDING_MODEL}` after Ollama is healthy. `api` waits for Qdrant health and successful model initialization. The policy test rejects moving tags such as `latest`, `v1`, or `2`; document how to update and re-run verification.

- [ ] **Step 5: Configure Caddy and graceful persistence**

Caddy proxies only to `api:3000`, applies the 25 MB body limit, preserves request IDs, and uses `SITE_ADDRESS` for local or TLS deployment. Mount persistent volumes only at documented paths.

- [ ] **Step 6: Verify deployment configuration**

Run each command:

```bash
npm test -- tests/contract/compose-config.test.ts
npm run build
npm run typecheck
npm run lint
```

When Docker is installed, additionally run: `docker compose -f compose.yaml config --quiet`.

Expected: policy tests and static verification pass; Docker validation is recorded as skipped only when the Docker CLI is unavailable.

- [ ] **Step 7: Commit deployment files**

```bash
git add Dockerfile .dockerignore compose.yaml compose.dev.yaml Caddyfile scripts/wait-for-models.ts .env.example package.json tests/contract/compose-config.test.ts
git commit -m "feat: containerize the local RAG stack"
```

### Task 14: Generate and seed the synthetic Spanish corpus

**Files:**
- Create: `fixtures/sources/*.json`
- Create: `fixtures/corpus.manifest.json`
- Create: `fixtures/evaluations/questions.json`
- Create: `scripts/generate-fixtures.ts`
- Create: `scripts/seed-corpus.ts`
- Modify: `package.json`
- Test: `tests/unit/fixture-generation.test.ts`

**Interfaces:**
- Produces: `npm run fixtures:generate` with byte-stable PDFs under `fixtures/pdfs/`.
- Produces: `npm run corpus:seed` using only canonical HTTP endpoints.
- Produces: ten logical topic documents, one replacement version, and one controlled cross-document conflict.

- [ ] **Step 1: Define the manifest and Spanish evaluation cases**

Use fixed UUIDs, fixed PDF metadata timestamps, fictional contact data under `example.invalid`, and these topics: matrícula, calendario, becas, convivencia, comedor, transporte, actividades, evaluación, contacto, and annual replacement. Evaluation rows use:

```json
{
  "question": "¿Cuál es el plazo de matrícula?",
  "expectedStatus": "found",
  "expectedDocumentIds": ["fixed-uuid"],
  "expectedPages": [2]
}
```

Include at least five `found`, three `not_found`, and two `ambiguous` cases.

- [ ] **Step 2: Write the failing deterministic generation test**

Generate into two temporary directories and assert equal SHA-256 hashes, `%PDF-` signatures, ten manifest documents, replacement metadata, and no real institute names, emails, or phone numbers.

- [ ] **Step 3: Run fixture tests and observe missing generators**

Run: `npm test -- tests/unit/fixture-generation.test.ts`

Expected: FAIL because sources and generator do not exist.

- [ ] **Step 4: Implement deterministic PDF generation**

Use PDF-Lib with embedded standard fonts, fixed creation/modification dates, stable line wrapping, explicit headings, and page numbers. Source JSON is authoritative; generated PDFs must be reproducible and committed.

- [ ] **Step 5: Implement API-driven seeding**

For each manifest version: POST multipart with a stable idempotency key, poll canonical status with bounded backoff until completed/failed, activate versions marked active, and stop on the first failed job with a Spanish diagnostic message. Do not access SQLite or Qdrant directly.

- [ ] **Step 6: Generate and verify the corpus**

Run each command:

```bash
npm run fixtures:generate
npm test -- tests/unit/fixture-generation.test.ts
```

Expected: deterministic PDF hashes and corpus/evaluation validation pass.

- [ ] **Step 7: Commit fixtures and tools**

```bash
git add fixtures scripts/generate-fixtures.ts scripts/seed-corpus.ts tests/unit/fixture-generation.test.ts package.json package-lock.json
git commit -m "feat: add synthetic Spanish corpus"
```

### Task 15: Add deterministic integration, E2E, evaluation, and load suites

**Files:**
- Create: `tests/support/fake-ollama-server.ts`
- Create: `tests/support/qdrant-test-context.ts`
- Create: `src/diagnostics/runtime-metrics.ts`
- Create: `src/api/routes/internal-metrics.ts`
- Modify: `src/api/app.ts`
- Modify: `Caddyfile`
- Create: `tests/integration/qdrant-vector-store.test.ts`
- Create: `tests/e2e/document-question-flow.test.ts`
- Create: `tests/e2e/failure-recovery.test.ts`
- Create: `tests/evaluations/spanish-rag.test.ts`
- Create: `tests/load/questions.mjs`
- Create: `tests/load/run-load-test.sh`
- Modify: `package.json`

**Interfaces:**
- Produces: deterministic fake Ollama `/api/tags`, `/api/embed`, and `/api/chat` behavior.
- Produces: `npm run test:integration`, `test:e2e`, `test:evaluations`, and `test:load`.

- [ ] **Step 1: Install test and load dependencies**

Run:

```bash
npm install -D testcontainers autocannon
```

- [ ] **Step 2: Write a real-Qdrant integration test**

Start a pinned Qdrant container, create the configured collection, upsert two versions, activate only one in SQLite, query through `QuestionService`, and assert every hit belongs to the allowed active version. Archive it and assert filtered deletion removes its points.

- [ ] **Step 3: Write complete lifecycle E2E tests**

Exercise authenticated multipart index → status poll → activate → canonical ask → candidate preview → archive. Assert the canonical rich citation page and the legacy adapter shape. A separate failure flow restarts from an expired job lease and retries a failed cleanup.

- [ ] **Step 4: Implement the fake Ollama server**

Return deterministic embeddings derived from SHA-256 bytes and deterministic structured chat decisions keyed by retrieved chunk IDs. Support explicit malformed output, timeout, and 503 triggers without external network access.

- [ ] **Step 5: Implement Spanish evaluation assertions**

Run every `fixtures/evaluations/questions.json` row, compare status, document IDs, and pages, and output a compact failure table. Threshold calibration changes must update the evaluation evidence in the same commit.

- [ ] **Step 6: Implement the 100-connection load runner**

Use Autocannon against the deterministic model profile with 100 connections. Permit only `200` and expected `429`, require zero connection errors, require readiness after the burst, and compare API RSS before/after with a documented 20% tolerance. Register authenticated `GET /internal/metrics` only when `ENABLE_INTERNAL_METRICS=true`; it exposes RSS, heap use, active generations, and queued generations. Caddy must reject `/internal/*`, keeping this test-only route unreachable through the production ingress.

- [ ] **Step 7: Run all deterministic suites**

Run:

```bash
npm test
npm run test:integration
npm run test:e2e
npm run test:evaluations
npm run test:load
```

Expected: all suites pass; no hosted API or real model is contacted. If Docker is absent, record integration/E2E/load as environment-blocked and run them before claiming the implementation complete.

- [ ] **Step 8: Commit verification suites**

```bash
git add src/diagnostics/runtime-metrics.ts src/api/routes/internal-metrics.ts src/api/app.ts Caddyfile tests package.json package-lock.json
git commit -m "test: verify the complete RAG lifecycle"
```

### Task 16: Complete operations documentation and CI

**Files:**
- Modify: `README.md`
- Create: `docs/api/compatibility.md`
- Create: `docs/operations/ubuntu-server.md`
- Create: `docs/operations/backup-restore.md`
- Create: `.github/workflows/ci.yml`
- Test: `tests/contract/documentation.test.ts`

**Interfaces:**
- Produces: all 14 numbered README procedures required by the spec.
- Produces: CI jobs for lint, typecheck, unit, contract, integration, E2E, evaluation, and Docker build.

- [ ] **Step 1: Write the failing documentation contract test**

Assert README contains numbered headings for configuration, stack startup, model warmup, fixture generation, indexing, activation, questions, preview, archive, tests, load test, diagnostics, annual replacement, and Ubuntu backup/restore. Extract every documented canonical path and assert it exists in generated OpenAPI.

- [ ] **Step 2: Run the documentation test and observe missing procedures**

Run: `npm test -- tests/contract/documentation.test.ts`

Expected: FAIL because the current README only links the design.

- [ ] **Step 3: Write the operational README**

Include the exact numbered indexing and question flows from the spec, copyable `curl` commands, expected status codes, `Retry-After`, idempotency replay, model download time/space warning, and troubleshooting for readiness, queue saturation, failed jobs, invalid PDFs, model output, and cleanup retries.

- [ ] **Step 4: Document Ubuntu deployment and recovery**

Specify Ubuntu prerequisites, firewall exposure of Caddy only, Docker volume locations, secret creation, Compose startup, model updates, Qdrant snapshots, SQLite online backup, restore order, and a quarterly restore drill. State that changing embedding model or dimensions requires a new collection and full re-index.

- [ ] **Step 5: Add deterministic CI**

Use Node.js 24 and npm cache, run `npm ci`, lint, typecheck, unit/contract tests, start pinned Qdrant for integration/E2E/evaluation, use fake Ollama, and build the API image. Do not pull Ollama models or require secrets.

- [ ] **Step 6: Run final local verification**

Run:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:e2e
npm run test:evaluations
npm run test:load
```

Expected: every command exits zero. Also run `docker compose -f compose.yaml config --quiet` and the real-model smoke profile before release on a Docker-capable host.

- [ ] **Step 7: Verify the repository contains no secrets or runtime data**

Run:

```bash
git status --short
git grep -nE '(gho_|sk-[A-Za-z0-9]|Bearer [A-Za-z0-9_-]{20,})' -- . ':!docs/superpowers/plans/*'
git ls-files | rg '(\.env$|\.sqlite|qdrant_data|ollama_models|tmp/)'
```

Expected: only intentional source changes are present; both secret/runtime-data searches return no matches.

- [ ] **Step 8: Commit documentation and CI**

```bash
git add README.md docs/api docs/operations .github/workflows/ci.yml tests/contract/documentation.test.ts
git commit -m "docs: add complete RAG operations guide"
```

- [ ] **Step 9: Push and verify CI**

Run each command:

```bash
git push origin main
gh run watch --exit-status
```

Expected: the pushed `main` workflow completes successfully.
