#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "for",
  "in",
  "on",
  "with",
  "by",
  "from",
  "using",
  "use",
  "what",
  "how",
  "if",
  "is",
  "are",
  "be",
  "it",
  "this",
  "that"
]);

export function loadJsonIfExists(pathValue, fallback = null) {
  if (!existsSync(pathValue)) return fallback;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch {
    return fallback;
  }
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function tokenizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.filter(token => token.length > 1 && !STOP_WORDS.has(token)) || [];
}

export function normalizeSearchComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function buildFtsQuery(value) {
  const tokens = tokenizeQuery(value);
  if (tokens.length === 0) return "";
  return tokens.map(token => `"${token}"`).join(" OR ");
}

export function scoreKeywordText(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 1;
  }
  return score;
}

export function normalizeEvidenceList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (typeof item === "string") {
        return { file: item, line: null, kind: "reference" };
      }
      if (!item || typeof item !== "object") return null;
      return {
        file: item.file || item.source || null,
        line: item.line ?? null,
        kind: item.kind || "source"
      };
    })
    .filter(Boolean);
}

export function normalizeNarrativeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (typeof item === "string") {
        return { text: item, confidence: 0.75, evidence: [] };
      }
      if (!item || typeof item !== "object") return null;
      return {
        text: item.text || item.rule || item.description || item.concern || "",
        confidence: typeof item.confidence === "number" ? item.confidence : 0.75,
        evidence: normalizeEvidenceList(item.evidence)
      };
    })
    .filter(item => item && item.text);
}

export function normalizeFlow(flow) {
  const rawSteps = flow.steps || flow.path || [];
  const steps = rawSteps
    .map(step => ({
      order: step.order,
      module: step.module,
      function: step.function || step.function_name || "",
      file: step.file || step.file_path || "",
      line: step.line ?? null,
      what: step.what || step.action || step.description || "",
      data: step.data || "",
      confidence: typeof step.confidence === "number" ? step.confidence : 0.8,
      evidence: normalizeEvidenceList(step.evidence)
    }))
    .filter(step => step.module);

  const derivedConfidence = steps.length > 0
    ? Number((steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length).toFixed(3))
    : 0.75;

  const summary = flow.summary ||
    [flow.title, ...steps.map(step => step.what).filter(Boolean)].join(" ").trim();

  return {
    name: flow.name,
    title: flow.title || flow.name,
    summary,
    confidence: typeof flow.confidence === "number" ? flow.confidence : derivedConfidence,
    entry: flow.entry || {},
    exit: flow.exit || {},
    steps,
    invariants: normalizeNarrativeItems(flow.invariants),
    failure_modes: normalizeNarrativeItems(flow.failure_modes)
  };
}

function pushFact(facts, fact) {
  if (!fact.title && !fact.detail) return;
  facts.push({
    id: fact.id,
    kind: fact.kind,
    title: fact.title || fact.id,
    detail: fact.detail || "",
    scope: fact.scope || "system",
    confidence: typeof fact.confidence === "number" ? fact.confidence : 0.8,
    check_cmd: fact.check_cmd || "",
    evidence_json: JSON.stringify(normalizeEvidenceList(fact.evidence)),
    module_keys: [...new Set((fact.module_keys || []).filter(Boolean))]
  });
}

function summarizeFactTitle(text, fallback) {
  const value = String(text || "").trim();
  if (!value) return fallback;
  const firstChunk = value.split(/[.:;]/)[0].trim();
  const words = firstChunk.split(/\s+/).slice(0, 8).join(" ");
  return words || fallback;
}

// Normalize system.json fields that agents sometimes produce as objects instead of arrays.
function normalizeSystem(system) {
  if (!system) return system;

  // domain_model: {core_entities: [...], key_relationships: [...]} → [{concept, definition, modules}]
  if (system.domain_model && !Array.isArray(system.domain_model)) {
    const entities = system.domain_model.core_entities || [];
    system = {
      ...system,
      domain_model: entities.map(e => ({
        concept: e.name || e.concept || "",
        definition: e.description || e.definition || "",
        modules: e.modules || []
      }))
    };
  }

  // conventions: {language, frameworks, testing, ...} → [{rule, description, scope}]
  if (system.conventions && !Array.isArray(system.conventions)) {
    const conv = system.conventions;
    const items = [];
    if (conv.language) items.push({ rule: `Language: ${conv.language}`, scope: "global" });
    if (conv.testing) items.push({ rule: conv.testing, scope: "global" });
    if (conv.configuration) items.push({ rule: conv.configuration, scope: "global" });
    if (conv.ipc) items.push({ rule: conv.ipc, scope: "global" });
    (conv.frameworks || []).forEach(f => items.push({ rule: f, scope: "global" }));
    system = { ...system, conventions: items };
  }

  return system;
}

export function buildSystemFacts(rawSystem) {
  const system = normalizeSystem(rawSystem);
  const facts = [];

  for (const domain of system?.domains || []) {
    pushFact(facts, {
      id: domain.id || `domain:${slugify(domain.name)}`,
      kind: "domain",
      title: domain.name,
      detail: domain.description || "",
      module_keys: domain.key_modules || domain.modules || [],
      confidence: domain.confidence,
      evidence: domain.evidence
    });
  }

  for (const concept of system?.domain_model || []) {
    pushFact(facts, {
      id: concept.id || `concept:${slugify(concept.concept)}`,
      kind: "domain_concept",
      title: concept.concept,
      detail: concept.definition || "",
      module_keys: concept.modules || [],
      confidence: concept.confidence,
      evidence: concept.evidence
    });
  }

  for (const pattern of system?.patterns || []) {
    pushFact(facts, {
      id: pattern.id || `pattern:${slugify(pattern.name)}`,
      kind: "pattern",
      title: pattern.name,
      detail: pattern.description || "",
      module_keys: pattern.modules || [],
      confidence: pattern.confidence,
      evidence: pattern.evidence
    });
  }

  (system?.architecture?.key_patterns || []).forEach((text, index) => {
    pushFact(facts, {
      id: `pattern:${index + 1}`,
      kind: "pattern",
      title: summarizeFactTitle(text, `Pattern ${index + 1}`),
      detail: text,
      module_keys: [],
      confidence: 0.75
    });
  });

  for (const convention of system?.conventions || []) {
    pushFact(facts, {
      id: convention.id || `convention:${slugify(convention.rule)}`,
      kind: "convention",
      title: convention.rule,
      detail: convention.description || convention.rule || "",
      scope: convention.scope || "global",
      module_keys: convention.modules || [],
      confidence: convention.confidence,
      check_cmd: convention.check || "",
      evidence: convention.evidence
    });
  }

  (system?.security_notes || []).forEach((text, index) => {
    pushFact(facts, {
      id: `security-note:${index + 1}`,
      kind: "security_note",
      title: summarizeFactTitle(text, `Security note ${index + 1}`),
      detail: text,
      module_keys: [],
      confidence: 0.8
    });
  });

  for (const layer of system?.architecture?.layers || []) {
    pushFact(facts, {
      id: layer.id || `layer:${slugify(layer.name)}`,
      kind: "architecture_layer",
      title: layer.name,
      detail: layer.role || "",
      module_keys: layer.modules || [],
      confidence: layer.confidence,
      evidence: layer.evidence
    });
  }

  (system?.architecture?.notable_decisions || []).forEach((text, index) => {
    pushFact(facts, {
      id: `decision:${index + 1}`,
      kind: "architecture_decision",
      title: summarizeFactTitle(text, `Decision ${index + 1}`),
      detail: text,
      module_keys: [],
      confidence: 0.75
    });
  });

  for (const overlap of system?.domain_overlaps || []) {
    pushFact(facts, {
      id: overlap.id || `overlap:${slugify(overlap.concept)}`,
      kind: "domain_overlap",
      title: overlap.concept,
      detail: overlap.concern || "",
      module_keys: overlap.modules || [],
      confidence: overlap.confidence,
      evidence: overlap.evidence
    });
  }

  for (const moduleKey of system?.load_bearing || []) {
    pushFact(facts, {
      id: `load-bearing:${moduleKey}`,
      kind: "load_bearing",
      title: moduleKey,
      detail: "Failure in this module cascades across multiple flows.",
      module_keys: [moduleKey],
      confidence: 0.95
    });
  }

  (system?.tensions || []).forEach((tension, index) => {
    if (typeof tension === "string") {
      pushFact(facts, {
        id: `tension:${index + 1}`,
        kind: "tension",
        title: `Tension ${index + 1}`,
        detail: tension,
        module_keys: [],
        confidence: 0.7
      });
      return;
    }

    pushFact(facts, {
      id: tension.id || `tension:${index + 1}`,
      kind: "tension",
      title: tension.title || `Tension ${index + 1}`,
      detail: tension.text || tension.description || "",
      module_keys: tension.modules || [],
      confidence: tension.confidence,
      evidence: tension.evidence
    });
  });

  (system?.critical_paths || []).forEach((pathName, index) => {
    pushFact(facts, {
      id: `critical-path:${slugify(pathName) || index + 1}`,
      kind: "critical_path",
      title: pathName,
      detail: "A system-critical execution path that should remain easy to inspect and protect.",
      module_keys: [],
      confidence: 0.8
    });
  });

  (system?.integration_points || []).forEach((name, index) => {
    pushFact(facts, {
      id: `integration:${index + 1}`,
      kind: "integration_point",
      title: name,
      detail: "",
      module_keys: [],
      confidence: 0.75
    });
  });

  return facts;
}

// ─── Shared path-resolution utilities ────────────────────────────────────────
// Used by rank-files.mjs and any other script that needs to resolve imports.

export const EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|py)$/;

export function buildPathIndex(fileMap) {
  const index = {};
  for (const filePath of Object.keys(fileMap)) {
    if (!index[filePath]) index[filePath] = [];
    index[filePath].push(filePath);

    const withoutExt = filePath.replace(EXTENSION_PATTERN, "");
    if (!index[withoutExt]) index[withoutExt] = [];
    index[withoutExt].push(filePath);

    if (withoutExt.endsWith("/index")) {
      const dirPath = withoutExt.replace(/\/index$/, "");
      if (!index[dirPath]) index[dirPath] = [];
      index[dirPath].push(filePath);
    }
  }
  return index;
}

export function resolveImportPath(source, fromFile, pathIndex) {
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

// Extract plain text strings from a rules/conventions array (handles both string items
// and object items with a .rule field). Used for FTS indexing.
export function extractRuleTexts(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => typeof item === "string" ? item : item.rule || "").filter(Boolean);
}
