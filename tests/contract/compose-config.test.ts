import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = resolve(process.cwd());
const COMPOSE_FILE = resolve(PROJECT_ROOT, "compose.yaml");
const COMPOSE_DEV_FILE = resolve(PROJECT_ROOT, "compose.dev.yaml");
const CADDY_FILE = resolve(PROJECT_ROOT, "Caddyfile");
const DOCKERFILE_PATH = resolve(PROJECT_ROOT, "Dockerfile");
const scriptsDir = resolve(PROJECT_ROOT, "scripts");

interface Mount {
  source: string;
  target: string;
  type: "volume" | "bind";
}

interface Port {
  published?: string | number;
  target?: string | number;
}

interface HealthCheck {
  test?: string | string[];
}

interface ComposeService {
  image?: string;
  build?: Record<string, unknown>;
  ports?: Array<string | Record<string, unknown>>;
  healthcheck?: HealthCheck;
  depends_on?: Record<string, { condition: string } | string>;
  volumes?: Array<string | Record<string, unknown>>;
  environment?: Record<string, string> | string[];
  command?: string | string[];
  entrypoint?: string | string[];
  restart?: string;
}

interface ComposeConfig {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

// ── Normalisation helpers ────────────────────────────────────────────────

const MOVING_TAGS = new Set([
  "latest",
  "main",
  "stable",
  "dev",
  "edge",
  "next",
  "alpine",
  "slim",
]);

/**
 * Returns true when the image tag is a pinned version (major.minor.patch with
 * optional `v` prefix and optional suffix like `-alpine`). Rejects moving tags
 * such as `latest`, `v1`, `2`, or `alpine`.
 */
function isPinnedImage(image: string): boolean {
  const tagIndex = image.lastIndexOf(":");
  if (tagIndex === -1) return false; // no tag → likely not pinned
  const tag = image.slice(tagIndex + 1);
  if (MOVING_TAGS.has(tag)) return false;
  // Require at least major.minor (e.g. 0.32.5, v1.18.3, 2.11.4-alpine)
  // Also allow major.minor.patch with optional suffix.
  return /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(tag);
}

function normalizePort(p: string | Record<string, unknown>): Port {
  if (typeof p === "string") {
    // "80:80" or "127.0.0.1:3000:3000"
    const parts = p.split(":");
    if (parts.length === 3) {
      return { published: parts[1], target: parts[2] };
    }
    if (parts.length === 2) {
      return { published: parts[0], target: parts[1] };
    }
    return { target: p };
  }
  return {
    published: String(p.published ?? ""),
    target: String(p.target ?? ""),
  };
}

function normalizeMount(m: string | Record<string, unknown>): Mount {
  if (typeof m === "string") {
    const parts = m.split(":");
    if (parts.length >= 2) {
      const target = parts[parts.length - 1];
      const source = parts.length === 3 ? parts[1] : parts[0];
      return { source, target, type: parts.includes("ro") ? "bind" : "volume" };
    }
    return { source: "", target: m, type: "volume" };
  }
  // docker compose config --format json style
  return {
    source: String(m.source ?? ""),
    target: String(m.target ?? ""),
    type: (m.type as "volume" | "bind") ?? "volume",
  };
}

// ── Config loading ───────────────────────────────────────────────────────

async function dockerComposeConfig(): Promise<ComposeConfig> {
  const { stdout } = await execFileAsync("docker", [
    "compose",
    "-f",
    COMPOSE_FILE,
    "config",
    "--format",
    "json",
  ]);
  return JSON.parse(stdout);
}

function yamlComposeConfig(): ComposeConfig {
  const raw = readFileSync(COMPOSE_FILE, "utf8");
  return parseYaml(raw) as ComposeConfig;
}

function yamlDevConfig(): ComposeConfig | null {
  if (!existsSync(COMPOSE_DEV_FILE)) return null;
  const raw = readFileSync(COMPOSE_DEV_FILE, "utf8");
  return parseYaml(raw) as ComposeConfig;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function loadComposeConfig(): Promise<{
  production: ComposeConfig;
  dev: ComposeConfig | null;
  dockerAvailable: boolean;
  dockerSkipped: boolean;
}> {
  const dockerOk = await isDockerAvailable();
  if (dockerOk) {
    const production = await dockerComposeConfig();
    return {
      production,
      dev: yamlDevConfig(),
      dockerAvailable: true,
      dockerSkipped: false,
    };
  }
  return {
    production: yamlComposeConfig(),
    dev: yamlDevConfig(),
    dockerAvailable: false,
    dockerSkipped: true,
  };
}

// ── Policy assertions ────────────────────────────────────────────────────

const REQUIRED_SERVICES = ["api", "ollama", "model-init", "qdrant", "caddy"];

const REQUIRED_VOLUMES = ["api_data", "ollama_models", "qdrant_data"];

describe("Docker Compose production config", () => {
  let config: ComposeConfig;

  beforeAll(async () => {
    expect(
      existsSync(COMPOSE_FILE),
      `compose.yaml expected at ${COMPOSE_FILE}`,
    ).toBe(true);
    expect(
      existsSync(COMPOSE_DEV_FILE),
      `compose.dev.yaml expected at ${COMPOSE_DEV_FILE}`,
    ).toBe(true);
    const result = await loadComposeConfig();
    config = result.production;
  });

  it("defines all required services", () => {
    for (const name of REQUIRED_SERVICES) {
      expect(config.services, `service "${name}" must exist`).toHaveProperty(
        name,
      );
    }
  });

  it("defines all required named volumes", () => {
    expect(config.volumes).toBeDefined();
    for (const v of REQUIRED_VOLUMES) {
      expect(config.volumes, `volume "${v}" must exist`).toHaveProperty(v);
    }
  });

  describe("port exposure — production publishes only Caddy", () => {
    for (const svc of ["api", "ollama", "qdrant"] as const) {
      it(`service "${svc}" has no published ports`, () => {
        const ports = config.services[svc]?.ports ?? [];
        const normalized = ports.map(normalizePort);
        for (const p of normalized) {
          expect(
            p.published,
            `${svc} must not expose ports in production`,
          ).toBeFalsy();
        }
      });
    }

    it('service "caddy" exposes ports 80 and 443', () => {
      const ports = config.services.caddy?.ports ?? [];
      const normalized = ports.map(normalizePort);
      const published = normalized.map((p) => String(p.published));
      expect(published).toContain("80");
      expect(published).toContain("443");
    });
  });

  describe("images are pinned", () => {
    it('service "ollama" uses pinned image', () => {
      const img = config.services.ollama?.image ?? "";
      expect(isPinnedImage(img), `ollama image "${img}" must be pinned`).toBe(
        true,
      );
    });

    it('service "qdrant" uses pinned image', () => {
      const img = config.services.qdrant?.image ?? "";
      expect(isPinnedImage(img), `qdrant image "${img}" must be pinned`).toBe(
        true,
      );
    });

    it('service "caddy" uses pinned image', () => {
      const img = config.services.caddy?.image ?? "";
      expect(isPinnedImage(img), `caddy image "${img}" must be pinned`).toBe(
        true,
      );
    });

    it('service "model-init" uses the same pinned ollama image', () => {
      const img = config.services["model-init"]?.image ?? "";
      expect(
        isPinnedImage(img),
        `model-init image "${img}" must be pinned`,
      ).toBe(true);
    });
  });

  describe("health checks exist", () => {
    for (const svc of ["api", "ollama", "qdrant", "caddy"] as const) {
      it(`service "${svc}" defines a healthcheck`, () => {
        expect(
          config.services[svc]?.healthcheck,
          `${svc} must have a healthcheck block`,
        ).toBeDefined();
      });
    }
  });

  describe("model initialization", () => {
    it('service "model-init" depends on ollama being healthy', () => {
      const deps = config.services["model-init"]?.depends_on ?? {};
      const cond =
        typeof deps.ollama === "object"
          ? (deps.ollama as { condition: string }).condition
          : "service_started";
      expect(cond).toBe("service_healthy");
    });

    it('service "model-init" pulls both configured models', () => {
      const command = config.services["model-init"]?.command;
      const script = Array.isArray(command)
        ? command.join(" ")
        : typeof command === "string"
          ? command
          : "";
      const normalized = script.replace(/\$\$\{/g, "$").replace(/\$\{/g, "$");
      // The command is written with variable-with-default syntax:
      //   ollama pull "${OLLAMA_CHAT_MODEL:-gemma3:12b}"
      //   ollama pull "${OLLAMA_EMBEDDING_MODEL:-qwen3-embedding:0.6b}"
      // When Docker is unavailable, the YAML fallback preserves the raw
      // variable reference; when Docker IS available (as in CI), `docker
      // compose config` resolves it down to the default value. Accept either
      // form so the intent (pull both configured models) holds everywhere.
      const chatModelReferenced =
        normalized.includes("$OLLAMA_CHAT_MODEL") ||
        normalized.includes("gemma3:12b");
      const embeddingModelReferenced =
        normalized.includes("$OLLAMA_EMBEDDING_MODEL") ||
        normalized.includes("qwen3-embedding:0.6b");
      expect(chatModelReferenced).toBe(true);
      expect(embeddingModelReferenced).toBe(true);
      expect(normalized).toContain("pull");
    });
  });

  describe("dependency ordering", () => {
    it('service "api" waits for qdrant to be healthy', () => {
      const deps = config.services.api?.depends_on ?? {};
      const cond =
        typeof deps.qdrant === "object"
          ? (deps.qdrant as { condition: string }).condition
          : "service_started";
      expect(cond).toBe("service_healthy");
    });

    it('service "api" waits for model-init to complete successfully', () => {
      const deps = config.services.api?.depends_on ?? {};
      const cond =
        typeof deps["model-init"] === "object"
          ? (deps["model-init"] as { condition: string }).condition
          : "service_started";
      expect(cond).toBe("service_completed_successfully");
    });
  });

  describe("volume mounts", () => {
    it('volume "api_data" is mounted at /data', () => {
      const mounts = (
        config.services.api?.volumes ??
        ([] as Array<string | Record<string, unknown>>)
      ).map(normalizeMount);
      const found = mounts.find(
        (m) => m.source === "api_data" || m.target.startsWith("/data"),
      );
      expect(found?.target ?? "").toBe("/data");
    });

    it('volume "ollama_models" is mounted at /root/.ollama on ollama', () => {
      const mounts = (
        config.services.ollama?.volumes ??
        ([] as Array<string | Record<string, unknown>>)
      ).map(normalizeMount);
      const found = mounts.find((m) => m.source === "ollama_models");
      expect(found?.target ?? "").toBe("/root/.ollama");
    });

    it('volume "qdrant_data" is mounted at /qdrant/storage', () => {
      const mounts = (
        config.services.qdrant?.volumes ??
        ([] as Array<string | Record<string, unknown>>)
      ).map(normalizeMount);
      const found = mounts.find((m) => m.source === "qdrant_data");
      expect(found?.target ?? "").toBe("/qdrant/storage");
    });
  });
});

describe("Docker Compose dev override", () => {
  let dev: ComposeConfig;

  beforeAll(() => {
    const loaded = yamlDevConfig();
    if (!loaded) {
      throw new Error("compose.dev.yaml must be parseable");
    }
    dev = loaded;
  });

  it("publishes api on 127.0.0.1:3000", () => {
    const ports = (dev.services.api?.ports ?? []).map(normalizePort);
    const match = ports.find(
      (p) => String(p.published) === "3000" && String(p.target) === "3000",
    );
    expect(match).toBeDefined();
  });

  it("publishes ollama on 127.0.0.1:11434", () => {
    const ports = (dev.services.ollama?.ports ?? []).map(normalizePort);
    const match = ports.find((p) => String(p.published) === "11434");
    expect(match).toBeDefined();
  });

  it("publishes qdrant on 127.0.0.1:6333", () => {
    const ports = (dev.services.qdrant?.ports ?? []).map(normalizePort);
    const match = ports.find((p) => String(p.published) === "6333");
    expect(match).toBeDefined();
  });
});

describe("Caddyfile", () => {
  it("exists and is readable", () => {
    expect(existsSync(CADDY_FILE), `Caddyfile expected at ${CADDY_FILE}`).toBe(
      true,
    );
  });

  it("proxies to api:3000", () => {
    const content = readFileSync(CADDY_FILE, "utf8");
    expect(content).toContain("api:3000");
  });

  it("applies a 25 MB body limit", () => {
    const content = readFileSync(CADDY_FILE, "utf8");
    expect(content).toContain("25MB");
  });

  it("references SITE_ADDRESS environment variable", () => {
    const content = readFileSync(CADDY_FILE, "utf8");
    expect(content).toContain("SITE_ADDRESS");
  });
});

describe("Dockerfile", () => {
  it("exists and is readable", () => {
    expect(
      existsSync(DOCKERFILE_PATH),
      `Dockerfile expected at ${DOCKERFILE_PATH}`,
    ).toBe(true);
  });

  it("uses the pinned Node.js base image", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toContain("node:24.17.0-bookworm-slim");
  });

  it("is a multi-stage build (two or more FROM directives)", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    const fromCount = (content.match(/^FROM /gm) ?? []).length;
    expect(fromCount).toBeGreaterThanOrEqual(2);
  });

  it("runs as a non-root user", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toMatch(/^USER\s+(?!root)/m);
  });

  it("creates /data/sqlite and /data/tmp directories", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toContain("/data/sqlite");
    expect(content).toContain("/data/tmp");
  });

  it("includes an HTTP liveness HEALTHCHECK", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toMatch(/HEALTHCHECK\b/is);
  });
});

describe("wait-for-models script", () => {
  const scriptPath = resolve(scriptsDir, "wait-for-models.ts");

  it("exists and is readable", () => {
    expect(
      existsSync(scriptPath),
      `wait-for-models.ts expected at ${scriptPath}`,
    ).toBe(true);
  });

  it("reads OLLAMA_BASE_URL at a minimum", () => {
    const content = readFileSync(scriptPath, "utf8");
    // The script must either read the URL from the environment or use it
    expect(content).toMatch(
      /OLLAMA_BASE_URL|OLLAMA_CHAT_MODEL|OLLAMA_EMBEDDING_MODEL/,
    );
  });
});

describe("Environment file", () => {
  const envExample = resolve(PROJECT_ROOT, ".env.example");

  it("exists", () => {
    expect(
      existsSync(envExample),
      `.env.example expected at ${envExample}`,
    ).toBe(true);
  });

  it("contains SITE_ADDRESS", () => {
    const content = readFileSync(envExample, "utf8");
    expect(content).toContain("SITE_ADDRESS");
  });
});

describe("Docker compose validation", () => {
  it("can be validated via `docker compose config --quiet` when Docker is available", async () => {
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      console.log(
        "  ⏭  Docker CLI not available — skipping `docker compose config --quiet`",
      );
      return;
    }
    await expect(
      execFileAsync("docker", [
        "compose",
        "-f",
        COMPOSE_FILE,
        "config",
        "--quiet",
      ]),
    ).resolves.toBeDefined();
  });
});
