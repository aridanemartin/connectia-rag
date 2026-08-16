/**
 * Load test runner with assertions.
 *
 * Runs autocannon against the target URL, then asserts:
 * 1. Zero connection errors
 * 2. No unexpected status codes (only 200 or 429 allowed for POST /api/v1/questions)
 * 3. API ready after burst (re-checks /health/live)
 * 4. RSS before/after comparison within 20% tolerance via /internal/metrics
 *
 * Usage: node tests/load/run-load-test.mjs [target_url]
 *
 * Requires: autocannon (installed), target server running with seeded corpus.
 */

import autocannon from "autocannon";

const TARGET = process.argv[2] ?? "http://localhost:3000";
const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const RSS_TOLERANCE = 0.2; // 20%

/** The request mix for the load test — questions + health checks */
const REQUEST_MIX = [
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      question: "¿Cuál es el plazo de matrícula ordinaria?",
    }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ question: "¿Cuál es el horario del comedor?" }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ question: "¿Cuándo empiezan las clases?" }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      question: "¿Cuál es el precio del abono de transporte?",
    }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ question: "¿Qué días se imparte ajedrez?" }),
  },
  {
    method: "GET",
    path: "/health",
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  },
  { method: "GET", path: "/health/live" },
];

/**
 * Fetch /internal/metrics (authenticated) to get a metrics snapshot.
 */
async function fetchMetricsSnapshot(url) {
  try {
    const response = await fetch(`${url}/internal/metrics`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Check /health/live returns 200.
 */
async function checkHealth(url) {
  try {
    const response = await fetch(`${url}/health/live`);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  console.log("============================================");
  console.log("  Connectia RAG API — Load Test (assertive)");
  console.log("============================================");
  console.log(`  Target: ${TARGET}`);
  console.log("");

  // ── Phase 0: Check pre-conditions ──
  console.log("› Checking API health before burst...");
  const healthyBefore = await checkHealth(TARGET);
  if (!healthyBefore) {
    console.error("✗ API is not healthy before burst. Aborting.");
    process.exit(1);
  }
  console.log("✓ API is healthy.");

  // ── Phase 1: Snapshot metrics before ──
  console.log("› Collecting pre-burst metrics...");
  const preMetrics = await fetchMetricsSnapshot(TARGET);
  if (preMetrics) {
    console.log(`  RSS before: ${preMetrics.rssMb.toFixed(2)} MB`);
    console.log(`  Heap used:  ${preMetrics.heapUsedMb.toFixed(2)} MB`);
  } else {
    console.log("  (internal metrics unavailable — skipping RSS comparison)");
  }

  // ── Phase 2: Run autocannon ──
  console.log("› Running autocannon burst (100 connections, 30s)...");
  const result = await autocannon({
    url: TARGET,
    connections: 100,
    duration: 30,
    pipelining: 1,
    requests: REQUEST_MIX,
    renderProgressBar: true,
    renderResultsTable: true,
    renderStatusCodes: true,
  });

  // ── Phase 3: Assertions ──
  console.log("");
  console.log("=== Assertions ===");

  let failures = 0;

  // Assert 1: zero connection errors
  if (result.errors === 0) {
    console.log(
      `✓ 0 connection errors (timeouts: ${result.timeouts}, mismatches: ${result.mismatches})`,
    );
  } else {
    console.error(`✗ ${result.errors} connection errors (expected 0)`);
    failures++;
  }

  // Assert 2: no unexpected status codes (only 200 and 429 allowed)
  const statusCodes = result.statusCodeStats ?? {};
  const unexpectedCodes = Object.keys(statusCodes).filter(
    (code) => code !== "200" && code !== "429",
  );
  if (unexpectedCodes.length === 0) {
    console.log("✓ No unexpected HTTP status codes");
  } else {
    console.error(
      `✗ Unexpected status codes: ${unexpectedCodes.join(", ")} (counts: ${unexpectedCodes.map((c) => `${c}:${statusCodes[c].count}`).join(", ")})`,
    );
    failures++;
  }

  // Assert 3: API is healthy after burst
  console.log("› Checking API health after burst...");
  const healthyAfter = await checkHealth(TARGET);
  if (healthyAfter) {
    console.log("✓ API is healthy after burst");
  } else {
    console.error("✗ API is not healthy after burst");
    failures++;
  }

  // Assert 4: RSS within 20% tolerance (comparing pre vs post metrics)
  const postMetrics = await fetchMetricsSnapshot(TARGET);
  if (preMetrics && postMetrics) {
    const rssBefore = preMetrics.rssMb;
    const rssAfter = postMetrics.rssMb;
    const rssDelta = Math.abs(rssAfter - rssBefore) / rssBefore;
    console.log(
      `  RSS before: ${rssBefore.toFixed(2)} MB, after: ${rssAfter.toFixed(2)} MB, Δ: ${(rssDelta * 100).toFixed(1)}%`,
    );
    console.log(`  Tolerance: ${(RSS_TOLERANCE * 100).toFixed(0)}%`);
    if (rssDelta <= RSS_TOLERANCE) {
      console.log("✓ RSS within tolerance");
    } else {
      console.error(
        `✗ RSS delta ${(rssDelta * 100).toFixed(1)}% exceeds ${(RSS_TOLERANCE * 100).toFixed(0)}%`,
      );
      failures++;
    }
  } else {
    console.log("  (skipping RSS comparison — metrics unavailable)");
  }

  // ── Summary ──
  console.log("");
  console.log("=== Load Test Summary ===");
  console.log(`  Duration: ${result.duration}s`);
  console.log(
    `  Total requests: ${result.requests.total ?? result.totalRequests}`,
  );
  console.log(
    `  Total bytes: ${result.throughput?.total ?? result.totalBytes}`,
  );
  console.log(`  Avg latency: ${(result.latency?.average ?? 0).toFixed(1)} ms`);
  console.log(`  p99 latency: ${(result.latency?.p99 ?? 0).toFixed(1)} ms`);
  console.log(`  Errors: ${result.errors}`);
  console.log(
    `  2xx: ${result["2xx"] ?? 0}, 4xx: ${result["4xx"] ?? 0}, 5xx: ${result["5xx"] ?? 0}`,
  );

  if (failures > 0) {
    console.error(`\n✗ ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\n✓ All load-test assertions passed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
