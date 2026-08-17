# connectia-rag-demo

Teacher-owned, Spanish-only RAG service for the Connectia course project. The
service is designed for Node.js and TypeScript with LangChain, Ollama, Qdrant,
SQLite, and Docker Compose on Ubuntu Server.

---

## 1. Prerequisites

- **Docker Engine** 27.x and **Docker Compose** plugin v2.x
- **Node.js** 24.x (for local development without Docker)
- **Git**
- At least **8 GB RAM** and **4 CPU cores** (for Ollama `gemma3:12b`)
- Ubuntu Server 24.04 LTS or compatible Linux

Quick check:

```bash
docker --version
docker compose version
node --version   # 24.x required
```

---

## 2. Clone the repository

```bash
git clone https://github.com/your-org/connectia-rag-demo.git
cd connectia-rag-demo
```

---

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```ini
# Required: a strong secret token (at least 32 characters)
AUTH_TOKEN=replace-with-a-secret-token-of-at-least-32-characters

# Optional: Caddy site address (":80" for local, or a domain for TLS)
SITE_ADDRESS=:80
```

The `.env` file is excluded from version control by `.gitignore`.

---

## 4. Start the stack

```bash
docker compose up -d --build
```

This starts five services:

| Service | Purpose |
|---|---|
| `api` | RAG API (Express, port 3000) |
| `ollama` | LLM inference server |
| `model-init` | One-shot model downloader |
| `qdrant` | Vector database |
| `caddy` | Reverse proxy (ports 80/443) |

Monitor the startup:

```bash
docker compose logs -f api
```

The first start downloads Ollama models (`gemma3:12b` and `qwen3-embedding:0.6b`)
which can take several minutes. The API will not accept requests until all
dependencies are healthy.

---

## 5. Index documents

Index a PDF document via the API:

```bash
curl -X POST http://localhost/api/v1/indexing/jobs \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F "file=@path/to/document.pdf" \
  -F "documentId=$(uuidgen)" \
  -F "versionId=$(uuidgen)" \
  -F "title=Normativa de matrícula" \
  -F "academicYear=2026-2027"
```

The response includes a `jobId`:

```json
{"jobId": "uuid", "status": "queued", "requestId": "uuid"}
```

Poll the job status:

```bash
curl -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  http://localhost/api/v1/indexing/jobs/<jobId>
```

When the job reaches `status: "completed"`, the document is ready for
activation.

### Seed the corpus

For a quick start, seed the entire course corpus:

```bash
tsx scripts/seed-corpus.ts
```

This indexes all 11 PDFs from `fixtures/pdfs/` and activates them.

---

## 6. Activate a version

Activate a version so it becomes available for question answering:

```bash
curl -X POST "http://localhost/api/v1/documents/<documentId>/versions/<versionId>/activate" \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)"
```

Response:

```json
{"documentId": "uuid", "versionId": "uuid", "state": "ACTIVE"}
```

Activating a new version for a document that already has an active version
automatically archives the previous one.

---

## 7. Ask questions

Ask a question against all active documents:

```bash
curl http://localhost/api/v1/questions \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es el plazo de matrícula?"}'
```

Response:

```json
{
  "status": "found",
  "answer": "El plazo de matrícula termina el 15 de julio de 2026.",
  "citations": [
    {
      "documentTitle": "Normativa de matrícula",
      "page": 3,
      "academicYear": "2026-2027",
      "excerpt": "El plazo de matrícula termina el 15 de julio de 2026."
    }
  ],
  "requestId": "uuid"
}
```

### Legacy compatibility API

Legacy clients can use the `/ask` endpoint (see
[docs/api/compatibility.md](docs/api/compatibility.md) for the full migration
guide):

```bash
curl http://localhost/ask \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es el plazo de matrícula?"}'
```

---

## 8. Preview a candidate version

Before activating, preview a READY version alongside the currently active
documents:

```bash
curl -X POST "http://localhost/api/v1/documents/<documentId>/versions/<versionId>/preview" \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es el horario?"}'
```

The response shape is the same as `POST /api/v1/questions`. The candidate
version is included in the search scope alongside all other active documents.

---

## 9. Archive a version

Archive a version to remove it from the active set:

```bash
curl -X POST "http://localhost/api/v1/documents/<documentId>/versions/<versionId>/archive" \
  -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)"
```

Response:

```json
{"documentId": "uuid", "versionId": "uuid", "state": "ARCHIVED"}
```

Archived versions are cleaned up from the vector store by a background worker.

---

## 10. Run tests

The project includes five test suites:

```bash
# Unit tests (fast, no external dependencies)
npx vitest run tests/unit/

# Contract tests (API contract, compose config, documentation)
npx vitest run tests/contract/

# Integration tests (Qdrant testcontainers, fake Ollama)
npx vitest run tests/integration/

# E2E tests (full stack with testcontainers)
npx vitest run tests/e2e/

# Evaluation tests (Spanish RAG quality against a labelled set)
npx vitest run tests/evaluations/

# All tests except evaluations and Docker-dependent integration
npm test
```

---

## 11. Load testing

Run the load test suite against a running server:

```bash
# Ensure the API is running (docker compose up -d) and has seeded data
npm run test:load
```

The test uses [autocannon](https://github.com/mcollina/autocannon) with
100 connections for 30 seconds, hitting a mix of question and health endpoints.
It asserts:

- Zero connection errors
- Only 200/429 HTTP status codes
- API stays healthy after the burst
- RSS within 20% tolerance

---

## 12. Diagnostics

Diagnostics are opt-in. Enable them in `.env`:

```ini
DIAGNOSTICS_ENABLED=true
```

Use the CLI to inspect recent question-answer pairs:

```bash
# List the last 20 diagnostics entries
tsx src/diagnostics/diagnostics.cli.ts list

# List with a custom limit
tsx src/diagnostics/diagnostics.cli.ts list --limit 50

# Purge expired entries
tsx src/diagnostics/diagnostics.cli.ts purge
```

Diagnostics automatically expire after `DIAGNOSTICS_TTL_HOURS` (default: 24).

---

## 13. Backup and restore

See [docs/operations/backup-restore.md](docs/operations/backup-restore.md) for
detailed backup and restore procedures covering:

- SQLite database backup (online via better-sqlite3)
- Qdrant vector index snapshots
- Environment configuration backup
- Automated backup script with cron
- Point-in-time restore
- Disaster recovery plan

---

## 14. Production deployment

See [docs/operations/ubuntu-server.md](docs/operations/ubuntu-server.md) for
a complete deployment guide covering:

- Docker installation on Ubuntu Server 24.04
- Environment configuration
- Firewall setup and security
- Resource requirements
- Troubleshooting
- Stack updates

---

## Architecture

```
                    ┌──────────┐
                    │  Caddy   │  ports 80/443
                    │  Proxy   │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   API    │  Express, port 3000
                    │ (Node.js)│
                    └┬────┬───┬┘
                     │    │   │
              ┌──────▼┐ ┌─▼──▼┐ ┌──────────┐
              │Qdrant │ │SQLite│ │  Ollama  │
              │Vector │ │Meta- │ │  LLM +   │
              │  DB   │ │data  │ │Embeddings│
              └───────┘ └──────┘ └──────────┘
```

- **API**: Express.js server with canonical (`/api/v1/`) and legacy
  compatibility routes
- **Qdrant**: Vector database for semantic search over document chunks
- **SQLite**: Application state — documents, versions, jobs, diagnostics
- **Ollama**: Local LLM inference (`gemma3:12b`) and embeddings
  (`qwen3-embedding:0.6b`)
- **Caddy**: Reverse proxy with automatic TLS via Let's Encrypt

---

## API overview

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health/live` | No | Liveness check |
| `GET` | `/health/ready` | No | Readiness check (dependencies) |
| `POST` | `/api/v1/indexing/jobs` | Yes | Enqueue a PDF for indexing |
| `GET` | `/api/v1/indexing/jobs/:jobId` | Yes | Poll indexing job status |
| `POST` | `/api/v1/documents/:id/versions/:vid/activate` | Yes | Activate a version |
| `POST` | `/api/v1/documents/:id/versions/:vid/archive` | Yes | Archive a version |
| `POST` | `/api/v1/documents/:id/versions/:vid/preview` | Yes | Preview a candidate |
| `POST` | `/api/v1/questions` | Yes | Ask a question |
| `GET` | `/openapi.json` | Yes | OpenAPI specification |
| `GET` | `/docs` | Yes | Swagger UI |

### Legacy compatibility endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Simple liveness (legacy) |
| `POST` | `/ask` | Yes | Legacy question answering |
| `GET` | `/api/v1/admin/jobs/:id/status` | Yes | Legacy job status |

See [docs/api/compatibility.md](docs/api/compatibility.md) for the migration
guide.

---

## Project structure

```
├── compose.yaml              # Production Docker Compose
├── compose.dev.yaml          # Development overrides
├── Dockerfile                # Multi-stage build
├── Caddyfile                 # Reverse proxy config
├── .env.example              # Environment template
├── src/
│   ├── server.ts             # Application entry point
│   ├── api/                  # Express routes, middleware, OpenAPI
│   ├── config/               # Environment configuration
│   ├── diagnostics/          # Opt-in question diagnostics
│   ├── documents/            # PDF extraction, chunking, lifecycle
│   ├── health/               # Liveness/readiness checks
│   ├── models/               # Ollama provider
│   ├── persistence/          # SQLite schema, migrations, repositories
│   ├── rag/                  # Question answering, vector store, citations
│   ├── shared/               # Clock, activity tracker
│   └── workers/              # Background indexing and cleanup workers
├── scripts/
│   ├── generate-fixtures.ts  # Generate test fixture PDFs
│   ├── seed-corpus.ts        # Seed the entire corpus
│   └── wait-for-models.ts    # Wait for Ollama models
├── tests/
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests (testcontainers)
│   ├── contract/             # Contract tests
│   ├── e2e/                  # End-to-end tests
│   ├── evaluations/          # Spanish RAG evaluation
│   ├── load/                 # Load testing (autocannon)
│   └── support/              # Test helpers
├── docs/
│   ├── api/compatibility.md  # Legacy API documentation
│   ├── operations/
│   │   ├── ubuntu-server.md  # Production deployment guide
│   │   └── backup-restore.md # Backup and restore procedures
│   └── superpowers/          # Design specifications
├── fixtures/                 # Test data (PDFs, sources, corpus manifest)
└── .github/workflows/ci.yml  # CI pipeline
```

---

## License

ISC