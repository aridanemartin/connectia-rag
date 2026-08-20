# ConnectIA — Bruno collection

Full collection of calls against the Connectia RAG API (Express, port 3000).

## How to use

1. Open [Bruno](https://www.usebruno.com/) → **Open Collection** → select this folder
   (`bruno/`).
2. On the top-right, activate the **Local** environment (File → Environments, or the
   environment selector).
3. The collection uses two variables — `baseUrl` (default
   `http://localhost:3000`) and `authToken`. Set `authToken` to the `AUTH_TOKEN`
   value in the project's `.env` (min 32 characters).
4. Requests that need identifiers reuse `{{documentId}}`, `{{versionId}}` and
   `{{jobId}}` — edit them in the environment or collection variables as needed.

## Endpoints covered

| Folder | Request | Method / Path |
|---|---|---|
| **Health** | Liveness | `GET /health/live` (no auth) |
| | Readiness | `GET /health/ready` (no auth) |
| **Questions** | Ask a question | `POST /api/v1/questions` |
| | Ask without coverage | `POST /api/v1/questions` (returns `not_found`) |
| **Indexing** | Upload a PDF (new document) | `POST /api/v1/indexing/jobs` (multipart, dynamic UUIDs) |
| | Upload a PDF (existing fixture) | `POST /api/v1/indexing/jobs` (idempotency demo) |
| | Get job status | `GET /api/v1/indexing/jobs/:jobId` |
| **Documents** | Activate version | `POST /api/v1/documents/:documentId/versions/:versionId/activate` |
| | Archive version | `POST /api/v1/documents/:documentId/versions/:versionId/archive` |
| | Preview version | `POST /api/v1/documents/:documentId/versions/:versionId/preview` |
| **Tools** | OpenAPI document | `GET /openapi.json` |
| | Swagger UI | `GET /docs` |
| | Internal metrics | `GET /internal/metrics` (only when `ENABLE_INTERNAL_METRICS=true`) |

The multipart uploads reference the generated fixture PDFs under `fixtures/pdfs/`
(relative to this collection). Replace the `@file(...)` path to upload any other
PDF.

All endpoints except the health checks require `Authorization: Bearer <AUTH_TOKEN>`
even when `AUTH_DISABLED=true`.