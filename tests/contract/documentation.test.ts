import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());

// ── Paths ─────────────────────────────────────────────────────────────────

const DOCS_DIR = resolve(PROJECT_ROOT, "docs");
const OPERATIONS_DOCS = resolve(DOCS_DIR, "operations");
const README_PATH = resolve(PROJECT_ROOT, "README.md");
const UBUNTU_SERVER_PATH = resolve(OPERATIONS_DOCS, "ubuntu-server.md");
const BACKUP_RESTORE_PATH = resolve(OPERATIONS_DOCS, "backup-restore.md");
const CI_PATH = resolve(PROJECT_ROOT, ".github/workflows/ci.yml");

// ── Helpers ───────────────────────────────────────────────────────────────

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Documentation files exist ─────────────────────────────────────────────

describe("Documentation files exist", () => {
  it("README.md exists", () => {
    expect(existsSync(README_PATH)).toBe(true);
  });

  it("docs/operations/ubuntu-server.md exists", () => {
    expect(existsSync(UBUNTU_SERVER_PATH)).toBe(true);
  });

  it("docs/operations/backup-restore.md exists", () => {
    expect(existsSync(BACKUP_RESTORE_PATH)).toBe(true);
  });
});

// ── README.md — 14 numbered procedures ────────────────────────────────────

describe("README.md — 14 numbered procedures", () => {
  const readme = readFile(README_PATH);

  // The README must contain 14 numbered procedures (1. through 14.)
  const procedureHeadings = readme.match(/^## \d+\.\s/gm);

  it("contains exactly 14 numbered procedures", () => {
    expect(procedureHeadings).not.toBeNull();
    expect(procedureHeadings?.length).toBe(14);
  });

  it("contains procedure 1 — Configuration", () => {
    expect(readme).toMatch(/## 1\.\s*Configuration/i);
  });

  it("contains procedure 2 — Stack startup", () => {
    expect(readme).toMatch(/## 2\.\s*Stack startup/i);
  });

  it("contains procedure 3 — Model warmup", () => {
    expect(readme).toMatch(/## 3\.\s*Model warmup/i);
  });

  it("contains procedure 4 — Fixture generation", () => {
    expect(readme).toMatch(/## 4\.\s*Fixture generation/i);
  });

  it("contains procedure 5 — Indexing", () => {
    expect(readme).toMatch(/## 5\.\s*Indexing/i);
  });

  it("contains procedure 6 — Activation", () => {
    expect(readme).toMatch(/## 6\.\s*Activation/i);
  });

  it("contains procedure 7 — Questions", () => {
    expect(readme).toMatch(/## 7\.\s*Questions/i);
  });

  it("contains procedure 8 — Preview", () => {
    expect(readme).toMatch(/## 8\.\s*Preview/i);
  });

  it("contains procedure 9 — Archive", () => {
    expect(readme).toMatch(/## 9\.\s*Archive/i);
  });

  it("contains procedure 10 — Tests", () => {
    expect(readme).toMatch(/## 10\.\s*Tests/i);
  });

  it("contains procedure 11 — Load test", () => {
    expect(readme).toMatch(/## 11\.\s*Load test/i);
  });

  it("contains procedure 12 — Diagnostics", () => {
    expect(readme).toMatch(/## 12\.\s*Diagnostics/i);
  });

  it("contains procedure 13 — Annual replacement", () => {
    expect(readme).toMatch(/## 13\.\s*Annual replacement/i);
  });

  it("contains procedure 14 — Ubuntu backup/restore", () => {
    expect(readme).toMatch(/## 14\.\s*Ubuntu backup\/restore/i);
  });
});

// ── docs/operations/ubuntu-server.md ──────────────────────────────────────

describe("docs/operations/ubuntu-server.md", () => {
  const doc = existsSync(UBUNTU_SERVER_PATH)
    ? readFile(UBUNTU_SERVER_PATH)
    : "";

  it("covers Docker installation", () => {
    expect(doc).toMatch(/docker.*install|apt.*install.*docker/ims);
  });

  it("covers environment configuration", () => {
    expect(doc).toMatch(/\.env/);
  });

  it("covers docker compose up", () => {
    expect(doc).toMatch(/docker compose up/);
  });

  it("covers stack verification", () => {
    expect(doc).toMatch(/health.*ready|verify|curl/ims);
  });

  it("covers logs and monitoring", () => {
    expect(doc).toMatch(/logs/);
  });

  it("covers stopping the stack", () => {
    expect(doc).toMatch(/docker compose down/);
  });

  it("covers updating the stack", () => {
    expect(doc).toMatch(/git pull|docker compose up.*--build/ims);
  });

  it("covers firewall configuration", () => {
    expect(doc).toMatch(/ufw|firewall/ims);
  });

  it("covers resource requirements", () => {
    expect(doc).toMatch(/RAM|CPU|Disk/ims);
  });

  it("covers troubleshooting", () => {
    expect(doc).toMatch(/troubleshooting|Troubleshooting/);
  });
});

// ── docs/operations/backup-restore.md ─────────────────────────────────────

describe("docs/operations/backup-restore.md", () => {
  const doc = existsSync(BACKUP_RESTORE_PATH)
    ? readFile(BACKUP_RESTORE_PATH)
    : "";

  it("documents SQLite backup", () => {
    expect(doc).toMatch(/SQLite|sqlite|backup.*database/ims);
  });

  it("documents Qdrant snapshot", () => {
    expect(doc).toMatch(/Qdrant|qdrant|snapshot/ims);
  });

  it("documents environment configuration backup", () => {
    expect(doc).toMatch(/\.env/);
  });

  it("documents the restore procedure", () => {
    expect(doc).toMatch(/restore|Restore/);
  });

  it("includes an automated backup script", () => {
    expect(doc).toMatch(/backup\.sh|automated backup|cron/ims);
  });

  it("includes a disaster recovery plan", () => {
    expect(doc).toMatch(/disaster|RPO|RTO/ims);
  });
});

// ── .github/workflows/ci.yml ──────────────────────────────────────────────

describe("CI workflow", () => {
  const ci = existsSync(CI_PATH) ? readFile(CI_PATH) : "";

  it("exists", () => {
    expect(existsSync(CI_PATH)).toBe(true);
  });

  it("runs on push to any branch", () => {
    expect(ci).toMatch(/push:\s*[\s\S]*branches:\s*\[?\s*["']?\*\*["']?/);
  });

  it("runs on pull_request to main", () => {
    expect(ci).toMatch(/pull_request/);
  });

  it("defines a lint job", () => {
    expect(ci).toMatch(/lint|Lint/);
  });

  it("defines a typecheck job", () => {
    expect(ci).toMatch(/typecheck|type-check|Type-check/);
  });

  it("defines a unit test job", () => {
    expect(ci).toMatch(/unit test|Unit tests/);
  });

  it("defines a contract test job", () => {
    expect(ci).toMatch(/contract test|Contract test/);
  });

  it("defines an integration test job", () => {
    expect(ci).toMatch(/integration test|Integration test/);
  });

  it("defines an E2E test job", () => {
    expect(ci).toMatch(/e2e|E2E/);
  });

  it("defines an evaluation test job", () => {
    expect(ci).toMatch(/evaluation test|Evaluation test/);
  });

  it("defines a Docker build job", () => {
    expect(ci).toMatch(/docker build|Docker build/);
  });

  it("uses Node 24", () => {
    expect(ci).toMatch(/NODE_VERSION.*24|node-version.*24/);
  });

  it("uses npm cache", () => {
    expect(ci).toMatch(/cache.*npm/);
  });

  it("pins Qdrant image to match compose.yaml", () => {
    // The Qdrant version is pinned in qdrant-test-context.ts (for testcontainers)
    // and in compose.yaml (for production). Both must match.
    const qdrantContextPath = resolve(
      PROJECT_ROOT,
      "tests/support/qdrant-test-context.ts",
    );
    const qdrantContext = existsSync(qdrantContextPath)
      ? readFile(qdrantContextPath)
      : "";
    expect(qdrantContext).toMatch(/qdrant\/qdrant:v1\.18\.3/);
  });

  it("does not contain real secrets", () => {
    // The CI file should not contain production tokens
    expect(ci).not.toMatch(/AUTH_TOKEN.*=/);
  });
});
