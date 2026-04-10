#!/usr/bin/env bash
set -euo pipefail

# Sonar — Build skeleton.json from source files using grep
# Pure bash + grep + node. No LLM. No Python. Runs in seconds.
# Usage: bash build-skeleton.sh [project-root] [sonar-dir]

PROJECT_ROOT="${1:-.}"
SONAR_DIR="${2:-.sonar}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "${SONAR_DIR}"

if [ -f "${SONAR_DIR}/skeleton.json" ]; then
  cp "${SONAR_DIR}/skeleton.json" "${SONAR_DIR}/previous-skeleton.json"
fi

# --- Collect source files and discovery metadata into a temp manifest ---
SOURCE_MANIFEST=$(mktemp)
trap "rm -f '$SOURCE_MANIFEST'" EXIT

node "${SCRIPT_DIR}/source-config.mjs" manifest "$PROJECT_ROOT" > "$SOURCE_MANIFEST"

SOURCE_COUNT=$(node -e 'const fs = require("fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String((manifest.files || []).length));' "$SOURCE_MANIFEST")

if [ "${SOURCE_COUNT}" = "0" ]; then
  echo '{"files": {}, "modules": {}, "edges": [], "stats": {"total_files": 0, "total_modules": 0, "total_edges": 0, "total_lines": 0}}' > "${SONAR_DIR}/skeleton.json"
  echo "No source files found."
  exit 0
fi

# --- Run the Node.js assembler ---
node "${SCRIPT_DIR}/build-skeleton-worker.mjs" "$PROJECT_ROOT" "$SONAR_DIR" "$SOURCE_MANIFEST"

# --- Compute graph-based importance scores ---
node "${SCRIPT_DIR}/rank-files.mjs" "${SONAR_DIR}/skeleton.json"
