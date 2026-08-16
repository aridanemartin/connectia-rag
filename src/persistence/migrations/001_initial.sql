CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  academic_year TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('INDEXING', 'READY', 'ACTIVE', 'FAILED', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  activated_at TEXT,
  archived_at TEXT,
  failed_at TEXT
);

CREATE UNIQUE INDEX one_active_version_per_document
ON document_versions(document_id)
WHERE state = 'ACTIVE';

CREATE INDEX document_versions_by_state
ON document_versions(state, document_id, id);

CREATE TABLE indexing_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  temp_file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX leasable_indexing_jobs
ON indexing_jobs(status, lease_until, created_at);

CREATE TABLE vector_cleanup_jobs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX leasable_vector_cleanup_jobs
ON vector_cleanup_jobs(status, available_at, lease_until, created_at);

CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  retrieved_chunk_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX diagnostics_by_expiry
ON diagnostics(expires_at);

CREATE INDEX diagnostics_recent
ON diagnostics(created_at DESC);
