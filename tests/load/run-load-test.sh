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
#   - autocannon (npm install -g autocannon or npx autocannon)
#   - The API server must be running at the target URL
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

TARGET="${1:-http://localhost:3000}"
REPORT_DIR="${REPORT_DIR:-reports/load}"

if [ ! -d "$REPORT_DIR" ]; then
  mkdir -p "$REPORT_DIR"
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="${REPORT_DIR}/load-test-${TIMESTAMP}.json"
SUMMARY_FILE="${REPORT_DIR}/load-test-${TIMESTAMP}.txt"

echo "============================================"
echo "  Connectia RAG API — Load Test"
echo "============================================"
echo "  Target:      $TARGET"
echo "  Duration:    30s"
echo "  Connections:  100"
echo "  Pipelines:     1"
echo "  Report:       $REPORT_FILE"
echo "============================================"
echo ""

set -x
npx autocannon \
  --harness ./tests/load/questions.mjs \
  --connections 100 \
  --duration 30 \
  --pipeline 1 \
  --renderStatusCodes \
  --json \
  "$TARGET" > "$REPORT_FILE"
set +x

# Extract summary
echo ""
echo "============================================"
echo "  Summary"
echo "============================================"
npx autocannon \
  --harness ./tests/load/questions.mjs \
  --connections 100 \
  --duration 30 \
  --pipeline 1 \
  --renderStatusCodes \
  "$TARGET" 2>&1 | tee "$SUMMARY_FILE"

echo ""
echo "Report saved to: $REPORT_FILE"
echo "Summary saved to: $SUMMARY_FILE"