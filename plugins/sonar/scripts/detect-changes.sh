#!/usr/bin/env bash
set -euo pipefail

# Sonar — Detect files changed since last crawl
# Outputs categorized JSON: code_changed, dependency_only, new_modules, deleted_modules
# Usage: bash detect-changes.sh [sonar-dir]

SONAR_DIR="${1:-.sonar}"
META_PATH="${SONAR_DIR}/meta.json"
SKELETON_PATH="${SONAR_DIR}/skeleton.json"
FILE_MODULES_PATH="${SONAR_DIR}/file-modules.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REGEX=$(node "${SCRIPT_DIR}/source-config.mjs" regex)

if [ ! -f "$META_PATH" ]; then
  echo '{"error": "No meta.json found. Run /sonar crawl first."}' >&2
  exit 1
fi

# Extract git_sha from meta.json
LAST_SHA=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${META_PATH}','utf8')).git_sha || '')" 2>/dev/null)

if [ -z "$LAST_SHA" ]; then
  echo '{"error": "No git_sha in meta.json"}'
  exit 1
fi

# Get all changes: committed since last crawl + uncommitted + staged
COMMITTED=$(git diff --name-only "$LAST_SHA" HEAD 2>/dev/null || echo "")
UNCOMMITTED=$(git diff --name-only HEAD 2>/dev/null || echo "")
STAGED=$(git diff --name-only --cached 2>/dev/null || echo "")
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E "${SOURCE_REGEX}" || echo "")

# Merge and deduplicate
CHANGED_FILES=$(printf '%s\n%s\n%s\n%s' "$COMMITTED" "$UNCOMMITTED" "$STAGED" "$UNTRACKED" | sort -u | grep -v '^$' || echo "")

if [ -z "$CHANGED_FILES" ]; then
  echo '{"changed_files": [], "code_changed": [], "dependency_only": {}, "new_modules": [], "deleted_modules": [], "total_changed": 0, "message": "No changes since last crawl"}'
  exit 0
fi

# Use node for JSON processing — handles both file-modules.json AND skeleton.json
if [ -f "$FILE_MODULES_PATH" ]; then
  node -e "
    const fs = require('fs');
    const fm = JSON.parse(fs.readFileSync('${FILE_MODULES_PATH}', 'utf8'));
    const changed = \`${CHANGED_FILES}\`.split('\n').filter(Boolean);

    // Load skeleton for new-module detection
    let skeleton = { files: {}, modules: {}, edges: [] };
    try { skeleton = JSON.parse(fs.readFileSync('${SKELETON_PATH}', 'utf8')); } catch {}

    // Load existing module cards to detect what's new vs known
    // Skip parent cards — their lifecycle is managed separately from skeleton comparison
    const existingCards = new Set();
    try {
      fs.readdirSync('${SONAR_DIR}/modules').filter(f => f.endsWith('.json')).forEach(f => {
        try {
          const card = JSON.parse(fs.readFileSync('${SONAR_DIR}/modules/' + f, 'utf8'));
          if (!card.is_parent && card.kind !== 'parent') existingCards.add(card.key);
        } catch {}
      });
    } catch {}

    const codeChanged = new Set();
    const unmapped = [];

    // Map changed files to modules
    for (const f of changed) {
      const info = fm[f];
      if (info) {
        codeChanged.add(info.module);
      } else {
        unmapped.push(f);
      }
    }

    // Bug 1 fix: check skeleton for unmapped files (new files)
    const newModules = new Set();
    for (const f of unmapped) {
      const skFile = skeleton.files[f];
      if (skFile && skFile.module_key && !skFile.module_key.startsWith('_test_')) {
        if (!existingCards.has(skFile.module_key)) {
          newModules.add(skFile.module_key);
        } else {
          // File is new but belongs to a known module — mark as code changed
          codeChanged.add(skFile.module_key);
        }
      }
    }

    // Also detect brand-new modules from skeleton that have no card at all
    for (const [key] of Object.entries(skeleton.modules || {})) {
      if (!key.startsWith('_test_') && !existingCards.has(key)) {
        newModules.add(key);
      }
    }

    // Detect deleted modules (card exists but not in skeleton)
    const deletedModules = [];
    for (const key of existingCards) {
      if (!skeleton.modules[key] && !key.startsWith('_test_')) {
        deletedModules.push(key);
      }
    }

    // Content-hash verification — prune false positives if graph.db exists
    const dbPath = '${SONAR_DIR}/graph.db';
    try {
      const Database = require('${SCRIPT_DIR}/../node_modules/better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const storedHashes = new Map(
        db.prepare('SELECT path, content_hash FROM files').all().map(r => [r.path, r.content_hash])
      );
      db.close();
      const toRemove = [];
      for (const moduleKey of codeChanged) {
        const moduleFiles = Object.entries(skeleton.files || {})
          .filter(([, info]) => info.module_key === moduleKey)
          .map(([path]) => path);
        const allHashesMatch = moduleFiles.length > 0 && moduleFiles.every(filePath => {
          const newHash = skeleton.files[filePath]?.content_hash;
          return newHash && storedHashes.get(filePath) === newHash;
        });
        if (allHashesMatch) toRemove.push(moduleKey);
      }
      for (const key of toRemove) codeChanged.delete(key);
    } catch (e) { process.stderr.write('sonar: hash-check skipped: ' + (e && e.message || String(e)) + '\n'); }

    // Find dependency-only modules: upstream changed but own code didn't
    const changedSet = new Set([...codeChanged, ...newModules, ...deletedModules]);
    const dependencyOnly = {};

    for (const deletedModule of deletedModules) {
      const deletedInfo = Object.values(fm).find(info => info && info.module === deletedModule);
      for (const dependent of deletedInfo?.dependents || []) {
        if (changedSet.has(dependent) || dependent.startsWith('_test_') || !existingCards.has(dependent)) {
          continue;
        }
        if (!dependencyOnly[dependent]) dependencyOnly[dependent] = { upstream_changed: [] };
        if (!dependencyOnly[dependent].upstream_changed.includes(deletedModule)) {
          dependencyOnly[dependent].upstream_changed.push(deletedModule);
        }
      }
    }

    for (const edge of skeleton.edges || []) {
      if (changedSet.has(edge.target) && !changedSet.has(edge.source)) {
        if (!edge.source.startsWith('_test_') && existingCards.has(edge.source)) {
          if (!dependencyOnly[edge.source]) dependencyOnly[edge.source] = { upstream_changed: [] };
          if (!dependencyOnly[edge.source].upstream_changed.includes(edge.target)) {
            dependencyOnly[edge.source].upstream_changed.push(edge.target);
          }
        }
      }
    }

    console.log(JSON.stringify({
      changed_files: changed,
      code_changed: [...codeChanged].sort(),
      new_modules: [...newModules].sort(),
      deleted_modules: deletedModules.sort(),
      dependency_only: dependencyOnly,
      unmapped_files: unmapped,
      total_changed: changed.length,
      total_code_changed: codeChanged.size,
      total_new: newModules.size,
      total_deleted: deletedModules.length,
      total_dependency_only: Object.keys(dependencyOnly).length
    }, null, 2));
  "
else
  # No file-modules.json — just report changed files
  CHANGED_ARRAY=$(echo "$CHANGED_FILES" | sed 's/.*/"&"/' | paste -sd, -)
  echo "{\"changed_files\": [${CHANGED_ARRAY}], \"code_changed\": [], \"new_modules\": [], \"deleted_modules\": [], \"dependency_only\": {}, \"total_changed\": $(echo "$CHANGED_FILES" | wc -l | tr -d ' ')}"
fi
