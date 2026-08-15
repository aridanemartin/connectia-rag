# Connectia RAG Demo Design

**Date:** 2026-08-15  
**Status:** Approved in chat; awaiting review of this written specification

## 1. Purpose

`connectia-rag-demo` is the teacher-owned, contract-compatible RAG service used by
the `connectia-teachers` project. Student backends consume it as an internal HTTP
service and do not need to implement extraction, chunking, embeddings, vector
search, prompting, or model inference.

The repository is public and educational, but its first responsibility is to be
a runnable service with stable contracts. It is Spanish-only, fully self-hosted,
uses free local tooling, and runs as one Docker Compose stack on Ubuntu Server.

### Goals

- Support the complete Connectia lifecycle: index, poll, activate, archive,
  preview, and ask with grounded citations.
- Preserve compatibility aliases used by existing `connectia-teachers` examples.
- Run without paid APIs or cloud services after models and images are downloaded.
- Handle a small corpus of about ten active institutional PDFs and remain stable
  during bursts of 100 simultaneous question requests.
- Be understandable, testable, and operationally reproducible by teachers.

### Non-goals

- OCR or scanned-PDF support in the MVP.
- General-purpose agents, tools, chat memory, or LangGraph workflows.
- Distributed workers, Redis, BullMQ, Kubernetes, or multi-node Qdrant.
- Permanent storage of public questions or answers.
- Public access directly to Ollama, Qdrant, SQLite, or internal metrics.

## 2. Approved decisions

| Area | Decision |
|---|---|
| Runtime | Node.js and TypeScript |
| HTTP API | Express, Zod validation, generated OpenAPI documentation |
| RAG framework | LangChain TypeScript primitives; no LangGraph in the MVP |
| Chat model | Configurable Ollama model; initial default `gemma3:12b` |
| Embeddings | Configurable Ollama model; initial default `qwen3-embedding:0.6b` |
| Vector database | Self-hosted Qdrant |
| Durable metadata | SQLite in WAL mode |
| Ingestion | Multipart PDF upload with document-version metadata |
| Language | Spanish only |
| PDF scope | Text-based PDFs only; explicit failure for unusable extracted text |
| Deployment | One Docker Compose stack on Ubuntu Server |
| Authentication | Shared bearer token on every non-health endpoint |
| Archived vectors | Delete them; reactivation requires re-indexing |
| Diagnostics | Disabled by default; when enabled, content expires after 24 hours |
| Corpus | Ten synthetic Spanish institutional PDFs committed as fixtures |
| Scale | Small corpus, one indexing worker, burst-safe question API |

Model identifiers, dimensions, concurrency, thresholds, and limits are
configuration rather than hard-coded assumptions. Moving to a larger model on a
future 96 GB server must not require application-code changes.

## 3. Runtime architecture

The Docker Compose stack contains:

| Service | Responsibility | Exposure |
|---|---|---|
| `api` | HTTP contracts, authentication, lifecycle rules, LangChain pipeline, queueing, and indexing worker | Through Caddy only in production |
| `ollama` | Local chat and embedding inference | Compose network only |
| `qdrant` | Chunk vectors and retrieval payloads | Compose network only |
| `caddy` | TLS termination and production ingress limits | Public or institutional network |

SQLite is embedded in the `api` container and stored on a dedicated persistent
volume. Separate volumes retain SQLite data, Qdrant data, and Ollama models.

The API remains one deployable service, but code is divided into focused modules:

- HTTP routes and middleware
- application services
- document ingestion and chunking
- retrieval and answer generation
- model, vector-store, and persistence adapters
- indexing and cleanup workers
- contract types and OpenAPI schemas

LangChain is limited to document loading, splitting, embeddings, retrieval, and
model calls. Authentication, state machines, idempotency, citations, thresholds,
queueing, and error mapping remain ordinary TypeScript and can be tested without
a model.

## 4. HTTP conventions

- JSON endpoints use `Content-Type: application/json`.
- Index creation uses `multipart/form-data`.
- Every non-health request requires `Authorization: Bearer <token>`.
- Every response includes or echoes a request identifier.
- Canonical endpoints live under `/api/v1`.
- Dates use ISO 8601 UTC strings.
- Identifiers are UUIDs.
- Validation rejects unknown JSON fields.
- User-visible messages are Spanish; machine-readable codes are English.

Error responses use one envelope:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Mensaje seguro en español",
    "requestId": "00000000-0000-4000-8000-000000000000",
    "details": []
  }
}
```

`details` is optional and is only present for safe validation details.

## 5. Canonical API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | SQLite, Qdrant, Ollama, and model readiness |
| `POST` | `/api/v1/indexing/jobs` | Start asynchronous PDF indexing |
| `GET` | `/api/v1/indexing/jobs/:jobId` | Read indexing progress and outcome |
| `POST` | `/api/v1/documents/:documentId/versions/:versionId/activate` | Activate a `READY` version |
| `POST` | `/api/v1/documents/:documentId/versions/:versionId/archive` | Archive a version and schedule vector deletion |
| `POST` | `/api/v1/documents/:documentId/versions/:versionId/preview` | Ask using a candidate version plus other active documents |
| `POST` | `/api/v1/questions` | Ask using all active versions |

### 5.1 Start indexing

`POST /api/v1/indexing/jobs` requires an `Idempotency-Key` header and these
multipart fields:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `file` | PDF | Yes | Defaults to a 25 MB limit |
| `documentId` | UUID | Yes | Stable logical document ID owned by Connectia |
| `versionId` | UUID | Yes | Stable document-version ID owned by Connectia |
| `title` | string | Yes | Human-readable Spanish title |
| `academicYear` | string | Yes | For example `2026-2027` |
| `description` | string | No | Safe descriptive metadata |

It returns `202 Accepted`:

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "status": "queued",
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

Reusing an idempotency key with the same payload returns the original job.
Reusing it with different content returns `409 IDEMPOTENCY_CONFLICT`.

### 5.2 Read job status

`GET /api/v1/indexing/jobs/:jobId` returns:

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "documentId": "00000000-0000-4000-8000-000000000000",
  "versionId": "00000000-0000-4000-8000-000000000000",
  "status": "processing",
  "progress": 55,
  "stage": "embedding",
  "errorCode": null,
  "errorMessage": null,
  "completedAt": null
}
```

Canonical job statuses are `queued`, `processing`, `completed`, and `failed`.

### 5.3 Ask and preview

`POST /api/v1/questions` accepts:

```json
{
  "question": "¿Cuál es el plazo de matrícula?"
}
```

Questions contain 1 to 1,000 characters after trimming. The public question
contract never accepts document IDs; it always searches the active corpus.

Preview uses the same body at
`POST /api/v1/documents/:documentId/versions/:versionId/preview`. The target
version must be `READY` or `ACTIVE`.

Successful canonical responses use:

```json
{
  "status": "found",
  "answer": "El plazo indicado es...",
  "citations": [
    {
      "documentId": "00000000-0000-4000-8000-000000000000",
      "versionId": "00000000-0000-4000-8000-000000000000",
      "documentTitle": "Matrícula 2026-2027",
      "page": 3,
      "section": "Plazos",
      "academicYear": "2026-2027",
      "excerpt": "El periodo de matrícula..."
    }
  ],
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

`status` is `found`, `not_found`, or `ambiguous`. `not_found` and `ambiguous`
return `answer: null` and `citations: []`, allowing `connectia-teachers` to apply
its institutional Secretary fallback.

### 5.4 Activate and archive

Activation requires an indexed `READY` version. It makes that version the only
active version of its logical document. The previous active version becomes
unsearchable immediately and its Qdrant points are scheduled for deletion.

Archiving makes a version unsearchable immediately and schedules vector deletion.
Repeating the requested final state is idempotent. An archived version cannot be
reactivated without a new indexing job.

## 6. Compatibility API

Compatibility adapters preserve the existing teaching examples while the
canonical client evolves:

| Method | Path | Adapter behavior |
|---|---|---|
| `GET` | `/health` | Compact `{ "status": "ok" }` response |
| `POST` | `/ask` | Accepts the older question contract and maps the rich response to `answer` plus legacy citations |
| `GET` | `/api/v1/admin/jobs/:id/status` | Maps canonical job status to the external Week 13 shape |

`/ask` may accept legacy `documentIds`; supplied IDs are intersected with active
documents and never bypass lifecycle filtering. When a canonical answer is null,
the adapter supplies a safe Spanish compatibility string because old clients
require `answer` to be a string.

The status adapter maps canonical `completed` to external `completed` and
canonical `failed` to external `error`.

## 7. Persistence model

SQLite is the authority for document lifecycle and active-version selection.
Qdrant is the authority only for vector search data.

Core SQLite records:

- `documents`: logical document identity and safe metadata.
- `document_versions`: version identity, academic year, content hash, lifecycle
  state, timestamps, and source metadata.
- `indexing_jobs`: idempotency key, job state, progress, stage, attempts, lease,
  safe error data, and timestamps.
- `vector_cleanup_jobs`: versions whose Qdrant points must be deleted.
- `diagnostics`: optional expiring request, answer, and retrieval content.
- `schema_migrations`: applied database migrations.

Document-version states are `INDEXING`, `READY`, `ACTIVE`, `FAILED`, and
`ARCHIVED`.

Each Qdrant point uses a deterministic ID derived from version ID and chunk index.
Its payload contains:

- `documentId`
- `versionId`
- `documentTitle`
- `academicYear`
- `page`
- `section`
- `chunkIndex`
- `contentHash`
- the source text needed to build a verified excerpt

Active version IDs are read from SQLite for every normal question and passed to
Qdrant as a filter. Therefore an archived version cannot be retrieved even if a
cleanup retry is still pending.

## 8. Numbered indexing lifecycle

This exact flow must also appear as a numbered README procedure:

1. Authenticate and validate the multipart request, UUIDs, PDF signature, size,
   and idempotency key.
2. Save the PDF to bounded temporary storage and insert a `queued` SQLite job.
3. Lease the job to the single in-process worker and mark it `processing`.
4. Extract text page by page.
5. Reject encrypted, corrupt, scanned, or effectively empty PDFs with explicit
   safe error codes.
6. Split text into overlapping chunks while preserving page and section metadata.
7. Generate embeddings in bounded batches through Ollama.
8. Upsert deterministic chunk IDs and payloads into Qdrant.
9. Mark the document version `READY` and the job `completed`.
10. Delete the temporary PDF.
11. On failure, mark the version and job failed, delete partial vectors where
    possible, and persist a sanitized failure reason.

## 9. Version lifecycle

| State | Publicly searchable | Previewable | Vectors retained |
|---|---:|---:|---:|
| `INDEXING` | No | No | Possibly partial |
| `READY` | No | Yes | Yes |
| `ACTIVE` | Yes | Yes | Yes |
| `FAILED` | No | No | Cleaned up |
| `ARCHIVED` | No | No | Deleted asynchronously |

Preview reads all active version IDs, removes the active version belonging to the
same logical document, and adds the selected candidate version. It cannot mutate
lifecycle state.

Activation changes the authoritative active-version selection in one SQLite
transaction. Vector deletion of the previous version happens afterward through a
durable cleanup job. This avoids cross-database atomicity claims while ensuring
the old version becomes unsearchable immediately.

## 10. Numbered question flow

This exact flow must also appear as a numbered README procedure:

1. Authenticate, validate the Spanish question, and acquire bounded queue capacity.
2. Read active version IDs from SQLite, or construct the preview version set.
3. Embed the question with Ollama.
4. Retrieve the top matching Qdrant chunks using the allowed version IDs as a
   mandatory filter.
5. Return `not_found` without generation when no chunk passes the configured
   relevance threshold.
6. Pass only retrieved context to the chat model and request structured output
   containing status, answer, and cited chunk IDs.
7. Use `ambiguous` when evidence is relevant but conflicting or insufficient for
   a single supported answer.
8. Verify that every cited chunk ID belongs to the retrieved set.
9. Build citation metadata and excerpts from Qdrant source payloads, never from
   model-generated metadata.
10. Return the validated response and release queue capacity.

The system prompt requires Spanish-only output, treats PDF text as untrusted data,
rejects instructions embedded in documents, and prohibits unsupported claims.

The model receives one structured-output repair attempt. A second invalid output
returns `MODEL_OUTPUT_INVALID`; the system never converts invalid output into an
uncited answer.

## 11. Relevance and evaluation

Similarity thresholds are model-specific configuration. They are calibrated using
the committed Spanish evaluation set rather than copied from another embedding
model. `found` requires validated citations. `not_found` means no sufficiently
relevant evidence was retrieved. `ambiguous` means relevant evidence exists but
does not support one unambiguous answer.

Changing the embedding model or vector dimension requires an explicit collection
migration and full re-index. The service refuses to start ready when configured
embedding dimensions do not match the Qdrant collection.

## 12. Concurrency and backpressure

- The API must remain stable during 100 simultaneous question connections.
- Ollama generation concurrency defaults to `2` and is configurable.
- Waiting capacity is bounded and configurable; no unbounded promise queue is
  allowed.
- Requests beyond capacity receive `429` with `Retry-After`.
- Queued requests have a finite wait timeout.
- Dependency calls and total requests have separate timeouts.
- Indexing uses one worker by default so embedding batches cannot starve questions.
- Readiness reports queue and model availability without exposing secrets.

The 100-connection goal is a stability and backpressure target, not a promise that
100 model generations execute simultaneously. Load tests determine production
queue and timeout defaults for the actual server.

## 13. Reliability and recovery

- SQLite uses WAL mode, transactions, migrations, a busy timeout, and a persistent
  Docker volume.
- Indexing jobs use leases. On startup, expired `processing` leases return to
  `queued` with bounded attempt counts.
- Deterministic point IDs make Qdrant upserts retry-safe.
- Recoverable Ollama and Qdrant failures use limited exponential backoff.
- Invalid PDFs and validation errors do not retry.
- Failed cleanup operations persist and retry until vectors are deleted.
- Readiness is unhealthy when SQLite, Qdrant, Ollama, required models, or collection
  configuration are unavailable.
- Liveness only reports whether the API process is alive.
- Graceful shutdown stops new traffic, drains active questions for a bounded time,
  releases worker leases, and closes persistence clients.

## 14. Security and privacy

- Caddy terminates TLS for traffic that leaves the host.
- Qdrant and Ollama have no public host ports.
- Bearer tokens come from Docker secrets or environment configuration and are
  compared safely.
- Secrets, authorization headers, questions, answers, excerpts, and PDF text are
  excluded from ordinary logs.
- Logs are structured JSON containing request ID, status, duration, safe job stage,
  and sanitized errors.
- PDF MIME type, signature, parser output, and size are validated.
- Questions default to a 1,000-character maximum and PDFs to 25 MB.
- Temporary uploads are bounded and deleted after success or failure.
- Diagnostic content retention is disabled by default.
- When explicitly enabled, diagnostics are available only through an authenticated
  operator CLI, not an HTTP endpoint, and are deleted after 24 hours by startup
  and scheduled cleanup tasks.

## 15. Testing strategy

1. Unit tests cover schemas, authentication, state transitions, idempotency,
   chunk metadata, filters, relevance decisions, citation validation, queue limits,
   and error mapping.
2. Integration tests use real SQLite and Qdrant with a deterministic fake Ollama
   HTTP server.
3. Contract tests cover every canonical endpoint and the `/ask`, `/health`, and
   job-status compatibility adapters.
4. Spanish RAG evaluations assert expected `found`, `not_found`, or `ambiguous`
   outcomes and expected document pages.
5. Optional real-model tests run against containerized Ollama and remain outside
   normal CI.
6. Load tests issue 100 simultaneous requests and verify bounded memory, correct
   `429` backpressure, valid response shapes, and recovery after the burst.
7. End-to-end tests cover index, poll, activate, ask, preview, archive, and vector
   deletion.

CI is deterministic, downloads no large models, calls no external APIs, and does
not require secrets.

## 16. Synthetic corpus

The repository contains editable source files and deterministically generated PDFs
for approximately ten fictional Spanish institutional documents. Together they
exercise:

- matrícula and deadlines
- academic calendar
- scholarships and financial assistance
- convivencia rules
- cafeteria information
- transport information
- extracurricular activities
- assessment rules
- institutional contact information
- yearly versions of one document for preview and replacement tests
- a controlled conflict between two independent documents for ambiguity tests

Synthetic names, emails, phone numbers, and dates must be unmistakably fictional.
The generator makes annual replacement easy and keeps binary fixtures reproducible.

## 17. README requirements

The root README is an operational guide, not only a project description. It must
include numbered, copyable procedures for:

1. Configuring environment variables and Docker secrets.
2. Starting the complete Compose stack.
3. Downloading and warming Ollama models.
4. Generating and loading the synthetic corpus.
5. Indexing and polling a document.
6. Activating a version.
7. Asking questions and interpreting citations.
8. Previewing a candidate version.
9. Archiving a version and verifying vector deletion.
10. Running unit, integration, contract, evaluation, and end-to-end tests.
11. Running the 100-connection load test.
12. Diagnosing health, queue saturation, jobs, and model failures.
13. Replacing the corpus for a new academic year.
14. Deploying, updating, backing up, and restoring the Ubuntu Server installation.

The approved numbered indexing and question flows in this specification must also
appear in the README. OpenAPI examples and `curl` commands must use the same payloads
and response shapes.

## 18. Proposed repository structure

```text
connectia-rag-demo/
├── docs/
│   ├── api/
│   ├── operations/
│   └── superpowers/specs/
├── fixtures/
│   ├── sources/
│   ├── pdfs/
│   └── evaluations/
├── scripts/
├── src/
│   ├── api/
│   ├── application/
│   ├── config/
│   ├── documents/
│   ├── persistence/
│   ├── rag/
│   └── workers/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── e2e/
│   └── load/
├── Caddyfile
├── compose.yaml
├── Dockerfile
├── README.md
└── package.json
```

Folder boundaries may be refined in the implementation plan, but each module must
retain one clear responsibility and an independently testable interface.

## 19. Acceptance criteria

- A clean Ubuntu Server can start the stack using documented Docker Compose steps.
- No paid or hosted runtime service is required.
- A teacher can execute the complete lifecycle using only README commands.
- All canonical and compatibility contract tests pass.
- A text-based Spanish PDF reaches `READY`, can be previewed, activated, cited, and
  archived.
- Normal questions retrieve only active versions.
- Preview substitutes only the candidate version of the same logical document.
- Archived versions become immediately unsearchable and their vectors are deleted.
- `not_found` and `ambiguous` are returned without fabricated answers or citations.
- Every `found` answer has citations built from retrieved source metadata.
- The service remains healthy under a 100-connection burst and applies bounded
  backpressure.
- CI passes without external network access, model downloads, or API credentials.
- Diagnostic content is absent by default and expires within 24 hours when enabled.

## 20. Deferred evolution

The following are allowed future changes behind existing interfaces, not MVP work:

- larger Ollama chat or embedding models on the 96 GB server
- an external worker queue if ingestion volume grows
- LangGraph if workflows gain genuine branching, durable human approval, or agent
  tool use
- OCR as a separate ingestion adapter
- multiple API replicas with a server database replacing SQLite
- hybrid dense and lexical retrieval after evaluation proves a need
