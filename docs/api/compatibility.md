# Compatibility API

The Connectia RAG service exposes a **compatibility API** alongside the canonical
`/api/v1/` routes. The compatibility layer preserves the contract expected by
legacy clients that have not yet migrated to the canonical API.

> **Migration note:** New integrations should use the canonical API at
> `/api/v1/`. The compatibility API is maintained for the lifetime of the
> current major version but will not receive new features.

---

## Endpoints

### `GET /health`

Returns a simple liveness indicator. This endpoint is **unauthenticated** and
provides no dependency health information.

**Response `200 OK`**

```json
{
  "status": "ok"
}
```

---

### `POST /ask`

The legacy question-answering endpoint. This mirrors the canonical
`POST /api/v1/questions` but with a simpler response shape.

**Request**

```json
{
  "question": "¿Cuál es el plazo de matrícula?",
  "documentIds": ["uuid-optional"]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | 1–1000 characters, trimmed, NFC-normalised |
| `documentIds` | string[] | no | UUIDs to restrict the search scope |

**Authentication:** Bearer token via `Authorization` header.

**Response `200 OK`**

```json
{
  "answer": "El plazo de matrícula termina el 15 de julio de 2026.",
  "citations": [
    {
      "documentId": "uuid",
      "title": "Normativa de matrícula",
      "excerpt": "El plazo de matrícula termina el 15 de julio de 2026."
    }
  ]
}
```

When no information is found or the model cannot answer:

```json
{
  "answer": "No se encontró información suficiente en los documentos activos.",
  "citations": []
}
```

**Error responses**

| HTTP status | Code | Description |
|---|---|---|
| 400 | `QUESTION_INVALID` | Invalid question format |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication |
| 429 | `QUEUE_SATURATED` | Generation queue full (includes `Retry-After: 1`) |
| 503 | `QUESTION_QUEUE_TIMEOUT` | Question took too long to process |
| 503 | `SERVER_SHUTTING_DOWN` | Server is shutting down |

---

### `GET /api/v1/admin/jobs/:id/status`

Retrieves the status of an indexing job using the legacy admin path.

**Authentication:** Bearer token via `Authorization` header.

**Parameters**

| Param | Type | Description |
|---|---|---|
| `id` | UUID path param | Job identifier |

**Response `200 OK`**

```json
{
  "id": "uuid",
  "status": "completed",
  "progressDescription": "Completado",
  "errorCode": null,
  "errorMessage": null,
  "completedAt": "2026-08-16T10:00:02.000Z"
}
```

Status values: `queued`, `processing`, `completed`, `error` (maps from
`failed`).

Progress descriptions are in Spanish:

| Stage | Description |
|---|---|
| `queued` | En cola |
| `extracting` | Extrayendo el texto del PDF |
| `chunking` | Dividiendo el documento en fragmentos |
| `embedding` | Generando los embeddings del documento |
| `storing` | Almacenando los fragmentos en el índice |
| `finalizing` | Finalizando la indexación |
| `completed` | Completado |

**Error responses**

| HTTP status | Code | Description |
|---|---|---|
| 400 | `JOB_ID_INVALID` | Not a valid UUID |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication |
| 404 | `JOB_NOT_FOUND` | No job with that ID |

---

## Migration guide

| Legacy | Canonical |
|---|---|
| `GET /health` | `GET /health/live` |
| `POST /ask` | `POST /api/v1/questions` |
| `GET /api/v1/admin/jobs/:id/status` | `GET /api/v1/indexing/jobs/:jobId` |

The canonical API returns richer citation metadata including `documentTitle`,
`page`, `academicYear`, and `requestId`.