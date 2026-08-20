# Remove the Legacy Compatibility API — Cross-Repo Design

**Date:** 2026-08-20
**Status:** Approved in chat

## 1. Purpose

`connectia-rag` currently exposes two parallel API surfaces: a canonical one
(`/api/v1/...`) and a "compatibility" one (`GET /health`, `POST /ask`,
`GET /api/v1/admin/jobs/:id/status`) that exists solely to preserve the
contract shape hard-coded into `connectia-teachers`' week-11 teaching
material. There is no other real consumer of the legacy shape.

Since `connectia-teachers` and `connectia-students` are sibling repos this
project also controls, the legacy surface is unnecessary duplication rather
than a genuine backward-compatibility need. This change collapses
`connectia-rag` down to one API — the canonical one — and updates the
teaching material that depended on the old shape to match it, so
`connectia-rag` becomes the single source of truth for the AI-service HTTP
contract across all three repos.

## 2. Goals

- `connectia-rag` exposes exactly one API surface. No "canonical" vs.
  "compatibility" distinction survives anywhere in its code, tests, docs, or
  Bruno collection — there's nothing left to contrast it with.
- The full document lifecycle (index → poll → activate → ask, with grounded
  citations) keeps working end-to-end, unchanged, via the canonical routes.
- `connectia-teachers` week-11 (`ai-service-contract-client`) — the only
  written week that talks to this contract — is rewritten to teach the real
  canonical shape instead of the removed legacy one.
- `connectia-teachers` and `connectia-students` each get an `AGENTS.md`
  stating that `connectia-rag` is the single source of truth for this
  contract: teaching material must mirror it, never fork it.

## 3. Non-goals

- No behavior change to canonical routes, `QuestionService`,
  `LifecycleService`, the indexing pipeline, or auth middleware.
- No changes to weeks 13/18+ in `connectia-teachers` — still unwritten
  placeholders; nothing to un-teach there.
- No changes to already-released `connectia-students` weeks 01–02 — they
  don't touch the AI service contract.

## 4. connectia-rag changes

Delete, don't deprecate:

- `src/api/routes/compatibility.ts` (both `createHealthCompatibilityRouter`
  and `createCompatibilityRouter`).
- Its two mount points and import in `src/api/app.ts`.
- The `/ask`, compact `/health`, and `/api/v1/admin/jobs/{id}/status` path
  entries in `src/api/openapi.ts`.
- `tests/contract/compatibility-api.test.ts`.
- The compatibility-specific assertions in `tests/contract/documentation.test.ts`
  (existence of `docs/api/compatibility.md`, README compatibility mentions,
  `/ask` and legacy admin-jobs documentation checks) — removed, not just
  their target.
- `docs/api/compatibility.md`.
- `bruno/Compatibility/` (3 requests) and `bruno/Health/03 - Legacy liveness.bru`.

Edit:

- `README.md` — remove the "Legacy compatibility API" section, the "Legacy
  compatibility endpoints" table, and the "canonical ... and legacy
  compatibility routes" phrasing in the architecture bullet (becomes just
  "Express.js server exposing `/api/v1/` routes").

Resulting API surface: `GET /health/live`, `GET /health/ready`,
`POST /api/v1/indexing/jobs`, `GET /api/v1/indexing/jobs/:jobId`,
`POST /api/v1/documents/:id/versions/:vid/{activate,archive,preview}`,
`POST /api/v1/questions`, `GET /openapi.json`, `GET /docs`.

## 5. connectia-teachers changes

### 5.1 Week 11 rewrite (`weeks/week-11-ai-service-contract-client/`,
`specs/011-week-11-ai-service-contract-client/contracts/`)

Replace every reference to the legacy shape with the canonical one:

| Legacy (removed) | Canonical (taught instead) |
|---|---|
| `GET /health` | `GET /health/live` |
| `POST /ask` | `POST /api/v1/questions` |
| Response: `{ answer, citations: [{documentId, title, excerpt}] }` | Response: `{ status, answer, citations: [{documentTitle, page, section, academicYear, excerpt}], requestId }` |
| Errors: `INVALID_QUESTION`, `INVALID_DOCUMENT_IDS`, `UNPROCESSABLE_QUESTION`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE` | Errors: `QUESTION_INVALID` (400), `QUEUE_SATURATED` (429, `Retry-After`), `QUESTION_QUEUE_TIMEOUT` (503), `MODEL_OUTPUT_INVALID` (502) |

Files touched:

- `code/mock-ai-server/src/server.ts` — route path, response envelope,
  citation shape, error codes above.
- `code/backend/src/services/ai-service.types.ts` and
  `ai-service.client.ts` — request/response types and parsing updated to
  match; internal type names (`AskRequest`/`AskResponse`/etc.) may stay as
  the student-facing vocabulary for this week's exercises, only the wire
  shape changes.
- `specs/011-.../contracts/ai-service-api.md`,
  `contracts/mock-server-endpoints.md`, `contracts/client-interface.md`.
- `exercises/01-ai-contract-types.md`.
- `README.md`, `TEACHER_NOTES.md` (curl examples, walkthrough script).
- `tests/manual-verification-checklist.md`.
- `specs/011-.../{spec,plan,data-model,quickstart,tasks,research}.md` — swept
  for any remaining `/ask` or legacy-shape mentions and corrected.

Auth is intentionally left out of the mock server (unchanged from today) —
week 21 (`admin-auth-security`) is where authentication is taught; adding it
to the week-11 mock now would be scope creep unrelated to this change.

### 5.2 `AGENTS.md` (new, repo root)

States: `connectia-rag` is the single source of truth for the AI-service
HTTP contract. This repo's mock servers, contract docs, exercises, and
reference client code must mirror `connectia-rag`'s actual routes and
schemas — never define or preserve a separate/legacy shape of their own. If
the two diverge, `connectia-rag` wins and this repo is updated to match.

## 6. connectia-students changes

`AGENTS.md` (new, repo root) — same source-of-truth statement as
`connectia-teachers`' `AGENTS.md`. No other changes: no released week here
touches the AI-service contract yet.

## 7. Testing / verification

- `connectia-rag`: `npm test` (unit + contract + integration suites) must
  pass with the compatibility test file removed and `documentation.test.ts`
  trimmed. `npm run build` / typecheck must pass with no dangling imports of
  the deleted router.
- `connectia-teachers` week-11: `npm run typecheck` and the week's own test
  suite (`AI_SERVICE_URL=http://localhost:4000 npm test` per its README)
  must pass against the rewritten mock server.
- Manual spot check: run the four-step flow (index → poll → activate → ask)
  against a running `connectia-rag` instance using only canonical routes, to
  confirm the end-to-end flow described in chat still works unchanged.

## 8. Out of scope

- Any change to canonical route behavior, response shapes, or business
  logic in `connectia-rag`.
- Weeks 13, 18+ in `connectia-teachers`.
- `connectia-students` weeks 01–02.
