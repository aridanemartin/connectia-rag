#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Load test runner for the Connectia RAG API
#
# Usage:
#   ./tests/load/run-load-test.sh [target_url]
#
# Default target: http://localhost:3000
#
# Requires:
#   - autocannon (npm install -D autocannon)
#   - The API server must be running at the target URL
#
# The test runs autocannon with 100 connections for 30 seconds against
# a mix of question and health endpoints, then asserts:
#   1. Zero connection errors
#   2. Only 200/429 HTTP status codes
#   3. API healthy after burst
#   4. RSS within 20% tolerance (via /internal/metrics)
#
# Exit code 0 = all assertions pass.
# Exit code 1 = any assertion fails or runtime error.
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

TARGET="${1:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo "  Connectia RAG API — Load Test"
echo "============================================"
echo "  Target:      $TARGET"
echo "  Duration:    30s"
echo "  Connections:  100"
echo "  Pipelines:     1"
echo "============================================"
echo ""

# Delegate to the Node.js assertion wrapper
exec node "${SCRIPT_DIR}/run-load-test.mjs" "$TARGET"