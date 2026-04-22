#!/usr/bin/env node

/**
 * Sonar — Skeleton builder worker
 * Reads source files, extracts structure via regex, writes skeleton.json.
 * Supports incremental reuse and batched worker-thread parsing.
 * Usage: node build-skeleton-worker.mjs <project-root> <sonar-dir> <source-manifest-file>
 */

import { availableParallelism } from "os";
import { performance } from "perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { languageFromPath } from "./source-config.mjs";
import { snapshotMemoryMb, toFixedNumber, writePerfSection } from "./perf-utils.mjs";
import { slugify } from "./retrieval-utils.mjs";

const EXTRACTOR_VERSION = 2;

const PY_FROM_IMPORT = /^from\s+([\w.]+)\s+import\s+(.+)/;
const PY_IMPORT = /^import\s+([\w.]+)/;
const PY_DEF = /^(async\s+)?def\s+(\w+)/;
const PY_CLASS = /^class\s+(\w+)/;
const TS_IMPORT = /^import\s+.*from\s+['"]([^'"]+)['"]/;
const TS_NAMED_IMPORT = /import\s+\{([^}]+)\}/;
const TS_DEFAULT_IMPORT = /import\s+(\w+)\s*(?:,|\s+from)/;
const TS_NAMESPACE_IMPORT = /import\s+\*\s+as\s+(\w+)/;
const TS_EXPORT = /^export\s+(?:default\s+)?(function|class|const|let|type|interface|enum)\s+(\w+)/;
const TS_DEFAULT_NAMED_DECL = /^export\s+default\s+(function|class)\s+(\w+)/;
const TS_DEFAULT_ALIAS = /^export\s+\{\s*(\w+)\s+as\s+default\s*\}/;
const TS_DEFAULT_REFERENCE = /^export\s+default\s+(\w+)\s*;?\s*$/;
const EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|py)$/;

function isTopLevel(line) {
  return !line.startsWith("    ") && !line.startsWith("\t");
}

function isTestPath(pathValue) {
  return (
    pathValue.includes("/tests/") ||
    pathValue.includes("/test/") ||
    pathValue.includes(".test.") ||
    pathValue.includes(".spec.") ||
    pathValue.includes("_test.py") ||
    pathValue.includes("test_")
  );
}

function readSourceManifest(pathValue) {
  const raw = readFileSync(pathValue, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      files: parsed.files || [],
      discovery: parsed.discovery || null
    };
  } catch {
    return {
      files: raw.split("\n").filter(Boolean),
      discovery: null
    };
  }
}

function parseSourceFile(task) {
  const { absPath, relPath, size_bytes, mtime_ms } = task;
  const lang = languageFromPath(relPath);

  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const fileEntry = {
    language: lang,
    lines: lines.length,
    size_bytes,
    mtime_ms,
    content_hash: createHash("sha1").update(content).digest("hex"),
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    has_default_export: false,
    default_export_name: null
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNum = index + 1;

    if (lang === "python") {
      const fromMatch = line.match(PY_FROM_IMPORT);
      if (fromMatch) {
        const source = fromMatch[1];
        const names = fromMatch[2]
          .split(",")
          .map(name => name.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        const kind = source.startsWith(".") ? "internal" : "unknown";
        fileEntry.imports.push({ source, names, kind, line: lineNum });
        continue;
      }

      const importMatch = line.match(PY_IMPORT);
      if (importMatch) {
        const source = importMatch[1];
        const kind = source.startsWith(".") ? "internal" : "unknown";
        fileEntry.imports.push({ source, names: [source.split(".").pop()], kind, line: lineNum });
        continue;
      }

      const funcMatch = line.match(PY_DEF);
      if (funcMatch) {
        fileEntry.functions.push({ name: funcMatch[2], line: lineNum, is_async: Boolean(funcMatch[1]) });
        if (isTopLevel(line)) {
          fileEntry.exports.push({ name: funcMatch[2], kind: "function", line: lineNum });
        }
        continue;
      }

      const classMatch = line.match(PY_CLASS);
      if (classMatch) {
        fileEntry.classes.push({ name: classMatch[1], line: lineNum });
        fileEntry.exports.push({ name: classMatch[1], kind: "class", line: lineNum });
      }
      continue;
    }

    if (lang !== "typescript" && lang !== "javascript") continue;

    const tsImport = line.match(TS_IMPORT);
    if (tsImport) {
      const source = tsImport[1];
      const kind = source.startsWith(".") || source.startsWith("@/") ? "internal" : "external";
      const names = [];
      const defaultMatch = line.match(TS_DEFAULT_IMPORT);
      if (defaultMatch) names.push(defaultMatch[1]);
      const namespaceMatch = line.match(TS_NAMESPACE_IMPORT);
      if (namespaceMatch) names.push("*");
      const namesMatch = line.match(TS_NAMED_IMPORT);
      if (namesMatch) {
        names.push(
          ...namesMatch[1]
            .split(",")
            .map(name => name.trim().split(/\s+as\s+/)[0].trim())
            .filter(Boolean)
        );
      }
      fileEntry.imports.push({ source, names, kind, line: lineNum });
      continue;
    }

    const defaultNamedDecl = line.match(TS_DEFAULT_NAMED_DECL);
    if (defaultNamedDecl) {
      fileEntry.has_default_export = true;
      fileEntry.default_export_name = defaultNamedDecl[2];
      fileEntry.exports.push({ name: defaultNamedDecl[2], kind: defaultNamedDecl[1], line: lineNum, is_default: true });
      if (defaultNamedDecl[1] === "function") {
        fileEntry.functions.push({ name: defaultNamedDecl[2], line: lineNum, is_async: line.includes("async ") });
      } else {
        fileEntry.classes.push({ name: defaultNamedDecl[2], line: lineNum });
      }
      continue;
    }

    const defaultAlias = line.match(TS_DEFAULT_ALIAS);
    if (defaultAlias) {
      fileEntry.has_default_export = true;
      fileEntry.default_export_name = defaultAlias[1];
      continue;
    }

    const defaultReference = line.match(TS_DEFAULT_REFERENCE);
    if (defaultReference) {
      fileEntry.has_default_export = true;
      fileEntry.default_export_name = defaultReference[1];
      continue;
    }

    const tsExport = line.match(TS_EXPORT);
    if (tsExport) {
      fileEntry.exports.push({ name: tsExport[2], kind: tsExport[1], line: lineNum });
      if (tsExport[1] === "function" || tsExport[1] === "const") {
        fileEntry.functions.push({ name: tsExport[2], line: lineNum, is_async: line.includes("async ") });
      } else if (tsExport[1] === "class") {
        fileEntry.classes.push({ name: tsExport[2], line: lineNum });
      }
    }
  }

  return {
    relPath,
    fileEntry,
    metrics: {
      bytes_read: Buffer.byteLength(content, "utf8"),
      lines_scanned: lines.length
    }
  };
}

function parseBatch(tasks) {
  const files = {};
  let bytesRead = 0;
  let linesScanned = 0;

  for (const task of tasks) {
    const parsed = parseSourceFile(task);
    if (!parsed) continue;
    files[parsed.relPath] = parsed.fileEntry;
    bytesRead += parsed.metrics.bytes_read;
    linesScanned += parsed.metrics.lines_scanned;
  }

  return {
    files,
    metrics: {
      bytes_read: bytesRead,
      lines_scanned: linesScanned
    }
  };
}

function detectModuleKey(relPath, files) {
  const parts = relPath.split("/");
  const lang = files[relPath]?.language;

  if (lang === "python") {
    for (let index = parts.length - 1; index >= 1; index--) {
      const dir = parts.slice(0, index).join("/");
      const initPath = `${dir}/__init__.py`;
      if (files[initPath] !== undefined) {
        return parts.slice(0, index).join("-").replace(/^src-/, "");
      }
    }
  }

  if (parts[0] === "packages" && parts.length >= 2) {
    return `packages-${parts[1]}`;
  }

  if (parts[0] === "apps" && parts.length >= 2) {
    return `apps-${parts[1]}`;
  }

  if (parts.length >= 2) {
    const start = parts[0] === "src" ? 1 : 0;
    if (parts.length > start + 1) {
      return parts[start];
    }
  }

  if (parts.length >= 2) {
    return parts[0];
  }
  return "root";
}

const LARGE_MODULE_THRESHOLD = 100;

function commonPathPrefix(paths) {
  if (paths.length === 0) return "";
  const splitPaths = paths.map(p => p.split("/"));
  const parts = splitPaths[0];
  const prefix = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i];
    if (splitPaths.every(sp => sp[i] === segment)) {
      prefix.push(segment);
    } else {
      break;
    }
  }
  return prefix.length > 0 ? prefix.join("/") + "/" : "";
}

function splitLargeModule(key, fileList, threshold = LARGE_MODULE_THRESHOLD) {
  if (fileList.length <= threshold) return { [key]: fileList };

  const prefix = commonPathPrefix(fileList);

  const groups = {};
  for (const file of fileList) {
    const rest = file.slice(prefix.length);
    const seg = rest.split("/")[0] || "_root";
    if (!groups[seg]) groups[seg] = [];
    groups[seg].push(file);
  }

  if (Object.keys(groups).length <= 1) return { [key]: fileList };

  // Flat module: all files land in individual groups (same directory) — can't meaningfully split
  if (Object.values(groups).every(g => g.length === 1)) return { [key]: fileList };

  const result = {};
  for (const [seg, files] of Object.entries(groups)) {
    let subKey = `${key}-${slugify(seg)}`;
    // Dedup collisions from distinct dirs that slugify identically (e.g. foo_bar/ and foo-bar/)
    let counter = 2;
    while (subKey in result) subKey = `${key}-${slugify(seg)}-${counter++}`;
    Object.assign(result, splitLargeModule(subKey, files, threshold));
  }
  return result;
}

function buildModuleIndex(files, includeTests = true) {
  const modules = {};
  for (const [relPath, info] of Object.entries(files)) {
    if (!includeTests && info.module_key.startsWith("_test_")) continue;
    const key = info.module_key;
    if (!modules[key]) {
      modules[key] = { files: [], total_lines: 0, total_functions: 0, total_exports: 0 };
    }
    modules[key].files.push(relPath);
    modules[key].total_lines += info.lines || 0;
    modules[key].total_functions += (info.functions || []).length;
    modules[key].total_exports += (info.exports || []).length;
  }
  return modules;
}

function buildPathIndex(files) {
  const pathIndex = {};

  for (const filePath of Object.keys(files)) {
    if (!pathIndex[filePath]) pathIndex[filePath] = [];
    pathIndex[filePath].push(filePath);

    const withoutExt = filePath.replace(EXTENSION_PATTERN, "");
    if (!pathIndex[withoutExt]) pathIndex[withoutExt] = [];
    pathIndex[withoutExt].push(filePath);

    if (withoutExt.endsWith("/index")) {
      const dirPath = withoutExt.replace(/\/index$/, "");
      if (!pathIndex[dirPath]) pathIndex[dirPath] = [];
      pathIndex[dirPath].push(filePath);
    }
  }

  return pathIndex;
}

function resolveImport(source, fromFile, pathIndex) {
  if (source.startsWith(".")) {
    const resolved = join(dirname(fromFile), source).replace(/\\/g, "/");
    const normalized = resolved.replace(EXTENSION_PATTERN, "");
    return pathIndex[resolved]?.[0] || pathIndex[normalized]?.[0] || null;
  }

  if (source.startsWith("@/")) {
    const target = "src/" + source.slice(2);
    const normalized = target.replace(EXTENSION_PATTERN, "");
    return pathIndex[target]?.[0] || pathIndex[normalized]?.[0] || null;
  }

  const pyPath = source.replace(/\./g, "/");
  return pathIndex[pyPath]?.[0] || pathIndex[`${pyPath}/__init__.py`]?.[0] || null;
}

async function parseWithWorkers(tasks) {
  if (tasks.length === 0) {
    return {
      files: {},
      metrics: { bytes_read: 0, lines_scanned: 0 },
      worker_count: 0
    };
  }

  const suggestedWorkers = Math.max(1, availableParallelism() - 1);
  const workerCount = tasks.length < 32
    ? 1
    : Math.min(8, suggestedWorkers, Math.ceil(tasks.length / 24));

  if (workerCount === 1) {
    const parsed = parseBatch(tasks);
    return { ...parsed, worker_count: 1 };
  }

  const chunkSize = Math.ceil(tasks.length / workerCount);
  const chunks = [];
  for (let index = 0; index < tasks.length; index += chunkSize) {
    chunks.push(tasks.slice(index, index + chunkSize));
  }

  const results = await Promise.all(
    chunks.map(chunk => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { tasks: chunk }
      });

      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => {
        if (code !== 0) {
          reject(new Error(`Skeleton parser worker exited with code ${code}`));
        }
      });
    }))
  );

  const mergedFiles = {};
  let bytesRead = 0;
  let linesScanned = 0;

  for (const result of results) {
    Object.assign(mergedFiles, result.files || {});
    bytesRead += result.metrics?.bytes_read || 0;
    linesScanned += result.metrics?.lines_scanned || 0;
  }

  return {
    files: mergedFiles,
    metrics: {
      bytes_read: bytesRead,
      lines_scanned: linesScanned
    },
    worker_count: chunks.length
  };
}

async function main() {
  const overallStartedAt = performance.now();
  const projectRoot = process.argv[2];
  const sonarDir = process.argv[3];
  const sourceManifestFile = process.argv[4];
  const phaseDurations = {};

  const manifestStartedAt = performance.now();
  const sourceManifest = readSourceManifest(sourceManifestFile);
  const sourceFilePaths = sourceManifest.files || [];
  const previousSkeletonPath = join(sonarDir, "previous-skeleton.json");
  const previousSkeleton = existsSync(previousSkeletonPath)
    ? JSON.parse(readFileSync(previousSkeletonPath, "utf8"))
    : { files: {}, stats: {} };
  const previousFiles = previousSkeleton.files || {};
  const canReusePrevious = previousSkeleton.stats?.extractor_version === EXTRACTOR_VERSION;
  phaseDurations.load_inputs_ms = toFixedNumber(performance.now() - manifestStartedAt);

  const files = {};
  const parseTasks = [];
  let reusedFiles = 0;

  const statStartedAt = performance.now();
  for (const absPath of sourceFilePaths) {
    const relPath = relative(projectRoot, absPath).replace(/\\/g, "/");

    let fileStat;
    try {
      fileStat = statSync(absPath);
    } catch {
      continue;
    }

    const previousEntry = previousFiles[relPath];
    if (
      canReusePrevious &&
      previousEntry &&
      previousEntry.size_bytes === fileStat.size &&
      previousEntry.mtime_ms === fileStat.mtimeMs &&
      previousEntry.content_hash
    ) {
      files[relPath] = { ...previousEntry };
      reusedFiles++;
      continue;
    }

    parseTasks.push({
      absPath,
      relPath,
      size_bytes: fileStat.size,
      mtime_ms: fileStat.mtimeMs
    });
  }
  phaseDurations.stat_reuse_ms = toFixedNumber(performance.now() - statStartedAt);

  const parseStartedAt = performance.now();
  const parsed = await parseWithWorkers(parseTasks);
  Object.assign(files, parsed.files);
  phaseDurations.parse_ms = toFixedNumber(performance.now() - parseStartedAt);

  const groupingStartedAt = performance.now();
  for (const relPath of Object.keys(files)) {
    files[relPath].module_key = detectModuleKey(relPath, files);
    delete files[relPath]._is_test;
  }

  let moduleIndex = buildModuleIndex(files, true);
  for (const [key, summary] of Object.entries(moduleIndex)) {
    if (summary.files.length < 3 && summary.total_lines < 150 && key !== "root") {
      const parts = key.split("-");
      if (parts.length <= 1) continue;
      const parent = parts.slice(0, -1).join("-");
      const parentSummary = moduleIndex[parent];
      if (!parentSummary) continue;

      for (const relPath of summary.files) {
        files[relPath].module_key = parent;
      }
    }
  }

  // Split large modules by subdirectory
  moduleIndex = buildModuleIndex(files, true);
  for (const [key, summary] of Object.entries(moduleIndex)) {
    if (summary.files.length <= LARGE_MODULE_THRESHOLD) continue;
    const splits = splitLargeModule(key, summary.files);
    if (Object.keys(splits).length <= 1) continue; // couldn't split
    for (const [subKey, subFiles] of Object.entries(splits)) {
      for (const relPath of subFiles) {
        files[relPath].module_key = subKey;
      }
    }
  }

  // Re-run merge pass: split can produce tiny sub-modules (< 3 files) that should fold back up
  moduleIndex = buildModuleIndex(files, true);
  for (const [key, summary] of Object.entries(moduleIndex)) {
    if (summary.files.length < 3 && summary.total_lines < 150 && key !== "root") {
      const parts = key.split("-");
      if (parts.length <= 1) continue;
      const parent = parts.slice(0, -1).join("-");
      const parentSummary = moduleIndex[parent];
      if (!parentSummary) continue;
      for (const relPath of summary.files) {
        files[relPath].module_key = parent;
      }
    }
  }

  moduleIndex = buildModuleIndex(files, true);
  for (const [key, summary] of Object.entries(moduleIndex)) {
    if (summary.files.length === 0) continue;
    const allTests = summary.files.every(isTestPath);
    if (!allTests) continue;

    for (const relPath of summary.files) {
      files[relPath].module_key = `_test_${key}`;
      files[relPath]._is_test = true;
    }
  }

  const modules = buildModuleIndex(files, false);
  phaseDurations.module_grouping_ms = toFixedNumber(performance.now() - groupingStartedAt);

  const edgesStartedAt = performance.now();
  const edgeWeights = new Map();
  const fileEdgeWeights = new Map();
  const pathIndex = buildPathIndex(files);

  for (const [relPath, info] of Object.entries(files)) {
    if (info._is_test) continue;
    const sourceModule = info.module_key;
    if (sourceModule.startsWith("_test_")) continue;

    for (const imp of info.imports || []) {
      const targetFile = resolveImport(imp.source, relPath, pathIndex);
      const targetModule = targetFile ? files[targetFile]?.module_key : null;
      if (!targetModule || targetModule === sourceModule || targetModule.startsWith("_test_")) continue;

      const edgeKey = `${sourceModule}|${targetModule}|imports`;
      const existing = edgeWeights.get(edgeKey);
      if (existing) {
        existing.weight += 1;
      } else {
        edgeWeights.set(edgeKey, { source: sourceModule, target: targetModule, kind: "imports", weight: 1 });
      }

      const fileEdgeKey = `${relPath}|${targetFile}|imports`;
      const existingFile = fileEdgeWeights.get(fileEdgeKey);
      if (existingFile) {
        existingFile.weight += 1;
      } else {
        fileEdgeWeights.set(fileEdgeKey, { source: relPath, target: targetFile, kind: "imports", weight: 1 });
      }
    }
  }
  const edges = Array.from(edgeWeights.values());
  const fileEdges = Array.from(fileEdgeWeights.values());
  phaseDurations.edge_resolution_ms = toFixedNumber(performance.now() - edgesStartedAt);

  const skeletonStartedAt = performance.now();
  const skeleton = {
    files,
    modules,
    edges,
    file_edges: fileEdges,
    stats: {
      extractor_version: EXTRACTOR_VERSION,
      total_files: Object.keys(files).length,
      total_modules: Object.keys(modules).length,
      total_edges: edges.length,
      total_file_edges: fileEdges.length,
      total_lines: Object.values(files).reduce((sum, info) => sum + (info.lines || 0), 0)
    }
  };

  writeFileSync(join(sonarDir, "skeleton.json"), JSON.stringify(skeleton, null, 2));
  phaseDurations.skeleton_write_ms = toFixedNumber(performance.now() - skeletonStartedAt);

  writePerfSection(sonarDir, "skeleton", {
    total_duration_ms: toFixedNumber(performance.now() - overallStartedAt),
    discovery: sourceManifest.discovery,
    phases: phaseDurations,
    files_total: skeleton.stats.total_files,
    files_reused: reusedFiles,
    files_parsed: parseTasks.length,
    parser_workers: parsed.worker_count,
    bytes_read: parsed.metrics.bytes_read,
    lines_scanned: parsed.metrics.lines_scanned,
    rss_mb: snapshotMemoryMb()
  });

  console.log(
    `Skeleton built: ${skeleton.stats.total_files} files, ${skeleton.stats.total_modules} modules, ${skeleton.stats.total_edges} edges, ${skeleton.stats.total_lines} lines`
  );
}

if (!isMainThread) {
  parentPort.postMessage(parseBatch(workerData.tasks || []));
} else {
  await main();
}
