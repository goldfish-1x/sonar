#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import {
  buildSystemFacts,
  loadJsonIfExists,
  normalizeEvidenceList,
  normalizeFlow,
  normalizeSearchComparable,
  slugify,
  tokenizeQuery
} from "../scripts/retrieval-utils.mjs";
import { freshnessRowsFromState, loadSonarState } from "./state.mjs";

const SNAPSHOT_VERSION = 1;
const IMPACT_INTENT_TOKENS = new Set(["impact", "break", "breaks", "change", "changes", "risk", "blast", "radius"]);
const RULE_INTENT_TOKENS = new Set(["rule", "rules", "convention", "invariant", "enforced", "enforce", "why"]);
const EVIDENCE_INTENT_TOKENS = new Set(["evidence", "audit", "source", "sources", "provenance", "prove", "proof"]);

function readJson(pathValue, fallback = null) {
  if (!existsSync(pathValue)) return fallback;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch {
    return fallback;
  }
}

function listJson(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => ({
      name,
      path: join(dirPath, name),
      data: readJson(join(dirPath, name), null)
    }))
    .filter(entry => entry.data);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function parseSourceLocation(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(.*?):(\d+)$/);
  if (!match) {
    return { file: text, line: null, kind: "reference" };
  }
  return {
    file: match[1],
    line: Number.parseInt(match[2], 10),
    kind: "source"
  };
}

function summarizeLabel(text, fallback) {
  const value = String(text || "").trim();
  if (!value) return fallback;
  const firstChunk = value.split(/[.:;]/)[0].trim();
  const words = firstChunk.split(/\s+/).slice(0, 8).join(" ");
  return words || fallback;
}

function normalizeModuleKey(value) {
  return String(value || "").trim();
}

function normalizeChildModuleKeys(card) {
  return unique(card.child_module_keys || card.children || []);
}

function normalizeModuleCard(card, fallbackKey) {
  const key = normalizeModuleKey(card.key || fallbackKey);
  const childModuleKeys = normalizeChildModuleKeys(card);
  const purpose = card.purpose || card.description || card.summary || "";
  const kind = (card.is_parent || card.kind === "parent" || childModuleKeys.length > 0) ? "parent" : "module";

  return {
    ...card,
    key,
    kind,
    name: card.name || key,
    purpose,
    description: card.description || purpose,
    child_module_keys: childModuleKeys,
    files: card.files || [],
    responsibilities: card.responsibilities || [],
    business_rules: card.business_rules || card.responsibilities || [],
    conventions: card.conventions || card.patterns || [],
    public_api: card.public_api || card.exports || [],
    function_cards: card.function_cards || [],
    side_effects: card.side_effects || [],
    test_files: card.test_files || [],
    key_invariants: card.key_invariants || [],
    verification_commands: card.verification_commands || [],
    analyzed_at: card.analyzed_at || null,
    source_artifact: card.source_artifact || null
  };
}

function normalizeSubmoduleCard(card, fallbackKey) {
  return {
    ...card,
    key: normalizeModuleKey(card.key || fallbackKey),
    parent_module_key: normalizeModuleKey(card.parent_module_key),
    cluster_name: card.cluster_name || card.name || fallbackKey,
    cluster_slug: card.cluster_slug || slugify(card.cluster_name || fallbackKey),
    purpose: card.purpose || card.description || "",
    description: card.description || card.purpose || "",
    files: card.files || [],
    business_rules: card.business_rules || card.responsibilities || [],
    conventions: card.conventions || card.patterns || [],
    public_api: card.public_api || card.exports || [],
    function_cards: card.function_cards || [],
    test_files: card.test_files || [],
    key_invariants: card.key_invariants || [],
    verification_commands: card.verification_commands || [],
    analyzed_at: card.analyzed_at || null,
    source_artifact: card.source_artifact || null
  };
}

function normalizeDbModuleRow(row) {
  return {
    key: normalizeModuleKey(row.key),
    name: row.name || row.key,
    path: row.path || row.key,
    purpose: row.purpose || "",
    complexity: row.complexity || "",
    analyzed_at: row.analyzed_at || null,
    kind: row.card_kind === "parent" ? "parent" : "module",
    child_module_keys: unique(JSON.parse(row.child_module_keys || "[]"))
  };
}

function runSqliteJson(dbPath, sql, fallback = []) {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return output ? JSON.parse(output) : fallback;
  } catch (err) {
    if (err.stderr) console.error("[sonar] sqlite query error:", String(err.stderr).trim());
    return fallback;
  }
}

function loadGraphData(sonarDir) {
  const dbPath = join(sonarDir, "graph.db");
  const empty = {
    dbPath,
    available: false,
    modules: [],
    edges: [],
    fileEdgeCount: 0,
    freshnessRows: [],
    stats: {}
  };

  if (!existsSync(dbPath)) return empty;

  try {
    const moduleRows = runSqliteJson(
      dbPath,
      "SELECT key, name, path, purpose, complexity, card_kind, COALESCE(child_module_keys, '[]') AS child_module_keys, analyzed_at FROM modules",
      []
    );
    const edgeRows = runSqliteJson(
      dbPath,
      "SELECT source_module AS source, target_module AS target, kind, weight FROM edges",
      []
    );
    const freshnessRows = runSqliteJson(
      dbPath,
      "SELECT artifact_type, artifact_key, status, reason, updated_at FROM artifact_freshness",
      []
    );
    const countsRow = runSqliteJson(
      dbPath,
      `SELECT
        (SELECT count(*) FROM modules) AS modules,
        (SELECT count(*) FROM submodules) AS submodules,
        (SELECT count(*) FROM flows) AS flows,
        (SELECT count(*) FROM system_facts) AS system_facts,
        (SELECT count(*) FROM edges) AS edges,
        (SELECT count(*) FROM file_edges) AS file_edges`,
      [{}]
    )[0] || {};

    return {
      dbPath,
      available: true,
      modules: moduleRows.map(normalizeDbModuleRow),
      edges: edgeRows.map(row => ({
        source: row.source,
        target: row.target,
        kind: row.kind || "imports",
        weight: row.weight || 1
      })),
      fileEdgeCount: countsRow.file_edges || 0,
      freshnessRows,
      stats: countsRow
    };
  } catch {
    return empty;
  }
}

function loadFreshness(sonarDir, graphData) {
  const freshness = {
    module: new Map(),
    flow: new Map(),
    system: new Map()
  };

  if (graphData.freshnessRows.length > 0) {
    for (const row of graphData.freshnessRows) {
      const bucket = freshness[row.artifact_type];
      if (!bucket) continue;
      bucket.set(row.artifact_key, {
        status: row.status || "unknown",
        reason: row.reason || "",
        updated_at: row.updated_at || null
      });
    }
    return freshness;
  }

  const state = loadSonarState(sonarDir);
  const rows = freshnessRowsFromState(state);
  for (const [key, row] of rows.module) {
    freshness.module.set(key, {
      status: row.status,
      reason: row.reason,
      updated_at: row.updated_at
    });
  }
  for (const [key, row] of rows.flow) {
    freshness.flow.set(key, {
      status: row.status,
      reason: row.reason,
      updated_at: row.updated_at
    });
  }
  for (const [key, row] of rows.system) {
    freshness.system.set(key, {
      status: row.status,
      reason: row.reason,
      updated_at: row.updated_at
    });
  }
  return freshness;
}

function addEdge(edgeStore, adjacencyOut, adjacencyIn, source, target, kind = "imports", weight = 1) {
  if (!source || !target || source === target) return;
  const edgeKey = `${source}|${target}|${kind}`;
  if (edgeStore.has(edgeKey)) {
    const existing = edgeStore.get(edgeKey);
    existing.weight = Math.max(existing.weight, weight);
    return;
  }

  const edge = { id: edgeKey, source, target, kind, weight };
  edgeStore.set(edgeKey, edge);

  if (!adjacencyOut.has(source)) adjacencyOut.set(source, new Set());
  if (!adjacencyIn.has(target)) adjacencyIn.set(target, new Set());
  adjacencyOut.get(source).add(target);
  adjacencyIn.get(target).add(source);
}

function deriveLoadBearingModules(moduleKeys, fanInMap, system) {
  const explicit = unique(system.load_bearing || []);
  if (explicit.length > 0) return explicit;

  const ranked = [...moduleKeys]
    .map(key => ({ key, fanIn: fanInMap.get(key) || 0 }))
    .filter(item => item.fanIn > 0)
    .sort((left, right) => right.fanIn - left.fanIn || left.key.localeCompare(right.key));

  if (ranked.length === 0) return [];

  const cutoff = Math.max(3, ranked[Math.min(9, ranked.length - 1)].fanIn);
  return ranked.filter(item => item.fanIn >= cutoff).slice(0, 12).map(item => item.key);
}

function createSystemCollections(system) {
  const domains = (system.domains || []).map(domain => ({
    id: `domain:${slugify(domain.name)}`,
    name: domain.name,
    description: domain.description || "",
    module_keys: unique(domain.key_modules || domain.modules || []),
    bounded_by: domain.bounded_by || []
  }));

  const concepts = (system.domain_model || []).map(concept => ({
    id: concept.id || `concept:${slugify(concept.concept || concept.name)}`,
    name: concept.concept || concept.name,
    description: concept.definition || concept.description || "",
    module_keys: unique(concept.modules || [])
  }));

  const patterns = unique([
    ...(system.patterns || []).map(pattern => ({
      id: pattern.id || `pattern:${slugify(pattern.name)}`,
      name: pattern.name,
      description: pattern.description || "",
      module_keys: unique(pattern.modules || [])
    })),
    ...((system.architecture?.key_patterns || []).map((text, index) => ({
      id: `pattern:${index + 1}`,
      name: summarizeLabel(text, `Pattern ${index + 1}`),
      description: text,
      module_keys: []
    })))
  ]);

  const decisions = (system.architecture?.notable_decisions || []).map((text, index) => ({
    id: `decision:${index + 1}`,
    name: summarizeLabel(text, `Decision ${index + 1}`),
    description: text
  }));

  const layers = (system.architecture?.layers || []).map(layer => ({
    id: layer.id || `layer:${slugify(layer.name)}`,
    name: layer.name,
    role: layer.role || "",
    module_keys: unique(layer.modules || [])
  }));

  const tensions = (system.tensions || []).map((entry, index) => ({
    id: entry.id || `tension:${index + 1}`,
    title: entry.title || `Tension ${index + 1}`,
    text: entry.text || entry.description || entry
  }));

  const overlaps = (system.domain_overlaps || []).map((entry, index) => ({
    id: entry.id || `overlap:${index + 1}`,
    concept: entry.concept || `Overlap ${index + 1}`,
    concern: entry.concern || "",
    module_keys: unique(entry.modules || [])
  }));

  const criticalPaths = (system.critical_paths || []).map((entry, index) => ({
    id: `critical-path:${slugify(entry) || index + 1}`,
    name: entry
  }));

  const integrationPoints = (system.integration_points || []).map((entry, index) => ({
    id: `integration:${index + 1}`,
    name: entry
  }));

  const securityNotes = (system.security_notes || []).map((entry, index) => ({
    id: `security-note:${index + 1}`,
    name: summarizeLabel(entry, `Security note ${index + 1}`),
    text: entry
  }));

  return {
    domains,
    concepts,
    patterns,
    decisions,
    layers,
    tensions,
    overlaps,
    criticalPaths,
    integrationPoints,
    securityNotes
  };
}

function buildLayerGraph(layers, moduleGraphEdges, layerByModule) {
  const nodes = layers.map(layer => ({
    id: layer.id,
    label: layer.name,
    type: "layer",
    moduleCount: layer.module_keys.length
  }));
  const edgeMap = new Map();

  for (const edge of moduleGraphEdges) {
    const sourceLayer = layerByModule.get(edge.source);
    const targetLayer = layerByModule.get(edge.target);
    if (!sourceLayer || !targetLayer || sourceLayer === targetLayer) continue;
    const edgeKey = `${sourceLayer.id}|${targetLayer.id}|${edge.kind}`;
    const existing = edgeMap.get(edgeKey) || {
      id: edgeKey,
      source: sourceLayer.id,
      target: targetLayer.id,
      kind: edge.kind,
      weight: 0
    };
    existing.weight += edge.weight || 1;
    edgeMap.set(edgeKey, existing);
  }

  return {
    nodes,
    edges: [...edgeMap.values()].sort((left, right) => right.weight - left.weight)
  };
}

function createSearchDocuments({
  modules,
  submodules,
  flows,
  facts,
  systemCollections,
  evidence = null
}) {
  const documents = [];

  for (const module of modules) {
    documents.push({
      id: `module:${module.key}`,
      key: module.key,
      type: module.kind === "parent" ? "parent-module" : "module",
      title: module.name,
      summary: module.purpose || module.description || "",
      freshness: module.freshness.status,
      url: `/modules/${encodeURIComponent(module.key)}`,
      module_keys: [module.key],
      load_bearing: module.load_bearing,
      tags: unique([
        module.layer?.name,
        ...module.dependencies.map(entry => entry.target),
        ...module.dependents.map(entry => entry.source),
        ...module.related_flows.map(flow => flow.name)
      ]),
      search_text: [
        module.key,
        module.name,
        module.purpose,
        module.description,
        ...module.responsibilities,
        ...module.business_rules.map(item => typeof item === "string" ? item : item.rule || item.text || ""),
        ...module.conventions.map(item => typeof item === "string" ? item : item.rule || item.text || ""),
        ...module.related_flows.map(flow => `${flow.name} ${flow.title} ${(flow.invariant_items || flow.invariants || []).map(item => typeof item === "string" ? item : item.text || "").join(" ")}`),
        ...module.system_facts.map(fact => `${fact.title} ${fact.detail}`)
      ].filter(Boolean).join(" ")
    });
  }

  for (const submodule of submodules) {
    documents.push({
      id: `submodule:${submodule.key}`,
      key: submodule.key,
      type: "submodule",
      title: submodule.cluster_name,
      summary: submodule.purpose || submodule.description || "",
      freshness: "unknown",
      url: `/submodules/${encodeURIComponent(submodule.key)}`,
      module_keys: [submodule.parent_module_key],
      load_bearing: false,
      tags: [submodule.parent_module_key],
      search_text: [
        submodule.key,
        submodule.cluster_name,
        submodule.parent_module_key,
        submodule.purpose,
        ...submodule.business_rules.map(item => typeof item === "string" ? item : item.rule || ""),
        ...submodule.conventions.map(item => typeof item === "string" ? item : item.rule || "")
      ].filter(Boolean).join(" ")
    });
  }

  for (const flow of flows) {
    documents.push({
      id: `flow:${flow.name}`,
      key: flow.name,
      type: "flow",
      title: flow.title,
      summary: flow.summary || "",
      freshness: flow.freshness.status,
      url: `/flows/${encodeURIComponent(flow.name)}`,
      module_keys: flow.module_keys,
      load_bearing: false,
      tags: flow.module_keys,
      search_text: [
        flow.name,
        flow.title,
        flow.summary,
        ...flow.steps.map(step => `${step.module} ${step.function} ${step.what} ${step.data}`),
        ...(flow.invariant_items || flow.invariants || []).map(item => typeof item === "string" ? item : item.text || ""),
        ...(flow.failure_mode_items || flow.failure_modes || []).map(item => typeof item === "string" ? item : item.text || "")
      ].filter(Boolean).join(" ")
    });
  }

  for (const fact of facts) {
    documents.push({
      id: `fact:${fact.id}`,
      key: fact.id,
      type: "system-fact",
      title: fact.title,
      summary: fact.detail || "",
      freshness: "fresh",
      url: `/facts/${encodeURIComponent(fact.slug)}`,
      module_keys: fact.module_keys,
      load_bearing: fact.kind === "load_bearing",
      tags: [fact.kind, fact.scope, ...fact.module_keys],
      search_text: [fact.id, fact.kind, fact.title, fact.detail, fact.scope, ...fact.module_keys].filter(Boolean).join(" ")
    });
  }

  for (const domain of systemCollections.domains) {
    documents.push({
      id: domain.id,
      key: domain.id,
      type: "domain",
      title: domain.name,
      summary: domain.description,
      freshness: "fresh",
      url: `/domains/${encodeURIComponent(domain.id.split(":")[1])}`,
      module_keys: domain.module_keys,
      load_bearing: false,
      tags: domain.bounded_by,
      search_text: [domain.name, domain.description, ...domain.module_keys, ...domain.bounded_by].filter(Boolean).join(" ")
    });
  }

  for (const layer of systemCollections.layers) {
    documents.push({
      id: layer.id,
      key: layer.id,
      type: "layer",
      title: layer.name,
      summary: layer.role || "",
      freshness: "fresh",
      url: `/layers/${encodeURIComponent(layer.id.split(":")[1])}`,
      module_keys: layer.module_keys,
      load_bearing: false,
      tags: layer.module_keys,
      search_text: [layer.name, layer.role, ...layer.module_keys].filter(Boolean).join(" ")
    });
  }

  for (const record of evidence?.items || []) {
    if (record.claim_type === "system_fact") continue;
    documents.push({
      id: record.id,
      key: record.id,
      type: "evidence",
      title: record.claim,
      summary: [record.entity_title, record.detail].filter(Boolean).join(" · "),
      entity_id: record.entity_id,
      entity_title: record.entity_title,
      claim_type: record.claim_type,
      artifact_path: record.artifact_path,
      evidence_kind: record.evidence_kind,
      freshness: record.freshness || "unknown",
      url: evidenceRecordUrl(record),
      module_keys: record.module_keys || [],
      load_bearing: Boolean(record.load_bearing),
      tags: unique([record.claim_type, record.entity_type, ...(record.module_keys || [])]),
      search_text: [
        record.claim,
        record.entity_title,
        record.detail,
        record.claim_type,
        record.entity_type,
        record.file,
        record.line,
        record.evidence_kind,
        record.artifact_path,
        record.freshness
      ].filter(Boolean).join(" ")
    });
  }

  return documents;
}

function evidenceRecordUrl(record) {
  if (record.entity_type === "module" || record.entity_type === "parent-module") {
    if (record.claim_type === "module_rule") return `${record.entity_url}#business-rules`;
    if (record.claim_type === "module_convention") return `${record.entity_url}#conventions`;
    if (record.claim_type === "module_function") return `${record.entity_url}#function-cards`;
  }
  if (record.entity_type === "flow") {
    if (record.claim_type === "flow_step") return `${record.entity_url}#narrative`;
    if (record.claim_type === "flow_invariant") return `${record.entity_url}#invariants`;
    if (record.claim_type === "flow_failure_mode") return `${record.entity_url}#failure-modes`;
  }
  return record.entity_url;
}

function buildEvidenceItems({ modules, flows, facts }) {
  const records = [];
  const dedupe = new Set();

  function pushEvidence(base, evidenceItems = []) {
    const normalized = evidenceItems.length > 0
      ? evidenceItems
      : [{ file: null, line: null, kind: "artifact" }];

    for (const evidence of normalized) {
      const key = [
        base.entity_id,
        base.claim_type,
        base.claim,
        evidence.file || "",
        evidence.line ?? "",
        evidence.kind || ""
      ].join("|");
      if (dedupe.has(key)) continue;
      dedupe.add(key);

      records.push({
        id: `evidence:${records.length + 1}`,
        ...base,
        file: evidence.file || null,
        line: evidence.line ?? null,
        evidence_kind: evidence.kind || "artifact"
      });
    }
  }

  for (const module of modules) {
    const entityBase = {
      entity_id: `module:${module.key}`,
      entity_type: module.kind === "parent" ? "parent-module" : "module",
      entity_key: module.key,
      entity_title: module.name,
      entity_url: `/modules/${encodeURIComponent(module.key)}`,
      module_keys: [module.key],
      freshness: module.freshness.status,
      load_bearing: module.load_bearing
    };
    const artifactPath = `modules/${module.key}.json`;

    pushEvidence({
      ...entityBase,
      claim_type: "module_artifact",
      claim: module.name,
      detail: module.purpose || module.description || "Module card artifact",
      confidence: 0.7,
      artifact_path: artifactPath
    });

    pushEvidence({
      ...entityBase,
      claim_type: "graph_support",
      claim: `fan-in ${module.stats?.fan_in || 0} · fan-out ${module.stats?.fan_out || 0}`,
      detail: `${(module.dependents || []).length} dependents · ${(module.dependencies || []).length} dependencies`,
      confidence: 0.85,
      artifact_path: "graph.db"
    });

    if (module.freshness?.status && module.freshness.status !== "unknown") {
      pushEvidence({
        ...entityBase,
        claim_type: "freshness_signal",
        claim: `Freshness: ${module.freshness.status}`,
        detail: module.freshness.reason || module.freshness.updated_at || "",
        confidence: 0.8,
        artifact_path: "state.json"
      });
    }

    for (const item of module.business_rules || []) {
      const claim = typeof item === "string" ? item : item.rule || item.text || item.description || "";
      const evidence = typeof item === "object" ? normalizeEvidenceList(item.evidence || []) : [];
      const sourceLocation = typeof item === "object" ? parseSourceLocation(item.source) : null;
      pushEvidence({
        ...entityBase,
        claim_type: "module_rule",
        claim,
        detail: typeof item === "object" ? item.description || "" : "",
        confidence: typeof item === "object" && typeof item.confidence === "number" ? item.confidence : 0.75,
        artifact_path: artifactPath
      }, unique([...evidence, sourceLocation]));
    }

    for (const item of module.conventions || []) {
      const claim = typeof item === "string" ? item : item.rule || item.text || item.description || "";
      const evidence = typeof item === "object" ? normalizeEvidenceList(item.evidence || []) : [];
      const sourceLocation = typeof item === "object" ? parseSourceLocation(item.source || item.check) : null;
      pushEvidence({
        ...entityBase,
        claim_type: "module_convention",
        claim,
        detail: typeof item === "object" ? item.description || item.scope || "" : "",
        confidence: typeof item === "object" && typeof item.confidence === "number" ? item.confidence : 0.75,
        artifact_path: artifactPath
      }, unique([...evidence, sourceLocation]));
    }

    for (const item of module.function_cards || []) {
      if (!item?.name && !item?.function) continue;
      pushEvidence({
        ...entityBase,
        claim_type: "module_function",
        claim: item.name || item.function,
        detail: item.purpose || "",
        confidence: typeof item.confidence === "number" ? item.confidence : 0.8,
        artifact_path: artifactPath
      }, [{
        file: item.file || null,
        line: item.line ?? null,
        kind: "source"
      }]);
    }
  }

  for (const flow of flows) {
    const entityBase = {
      entity_id: `flow:${flow.name}`,
      entity_type: "flow",
      entity_key: flow.name,
      entity_title: flow.title,
      entity_url: `/flows/${encodeURIComponent(flow.name)}`,
      module_keys: flow.module_keys || [],
      freshness: flow.freshness.status,
      load_bearing: false
    };
    const artifactPath = `flows/${flow.name}.json`;

    pushEvidence({
      ...entityBase,
      claim_type: "flow_artifact",
      claim: flow.title,
      detail: flow.summary || "Flow artifact",
      confidence: flow.confidence,
      artifact_path: artifactPath
    });

    if (flow.freshness?.status && flow.freshness.status !== "unknown") {
      pushEvidence({
        ...entityBase,
        claim_type: "freshness_signal",
        claim: `Freshness: ${flow.freshness.status}`,
        detail: flow.freshness.reason || flow.freshness.updated_at || "",
        confidence: flow.confidence,
        artifact_path: "state.json"
      });
    }

    for (const step of flow.steps || []) {
      pushEvidence({
        ...entityBase,
        claim_type: "flow_step",
        claim: step.what || `${step.module} ${step.function || ""}`.trim(),
        detail: [step.module, step.function].filter(Boolean).join(" :: "),
        confidence: typeof step.confidence === "number" ? step.confidence : flow.confidence,
        artifact_path: artifactPath
      }, step.evidence?.length > 0 ? step.evidence : [{
        file: step.file || null,
        line: step.line ?? null,
        kind: "source"
      }]);
    }

    for (const invariant of flow.invariant_items || flow.invariants || []) {
      const claim = typeof invariant === "string" ? invariant : invariant.text || "";
      if (!claim) continue;
      pushEvidence({
        ...entityBase,
        claim_type: "flow_invariant",
        claim,
        detail: "",
        confidence: typeof invariant === "object" && typeof invariant.confidence === "number" ? invariant.confidence : flow.confidence,
        artifact_path: artifactPath
      }, typeof invariant === "object" ? normalizeEvidenceList(invariant.evidence || []) : []);
    }

    for (const failureMode of flow.failure_mode_items || flow.failure_modes || []) {
      const claim = typeof failureMode === "string" ? failureMode : failureMode.text || "";
      if (!claim) continue;
      pushEvidence({
        ...entityBase,
        claim_type: "flow_failure_mode",
        claim,
        detail: "",
        confidence: typeof failureMode === "object" && typeof failureMode.confidence === "number" ? failureMode.confidence : flow.confidence,
        artifact_path: artifactPath
      }, typeof failureMode === "object" ? normalizeEvidenceList(failureMode.evidence || []) : []);
    }
  }

  for (const fact of facts) {
    const evidence = normalizeEvidenceList(JSON.parse(fact.evidence_json || "[]"));
    pushEvidence({
      entity_id: `fact:${fact.id}`,
      entity_type: "system-fact",
      entity_key: fact.id,
      entity_title: fact.title,
      entity_url: `/facts/${encodeURIComponent(slugify(fact.id.replace(/[:/]+/g, "-")))}`,
      module_keys: fact.module_keys || [],
      freshness: "fresh",
      load_bearing: fact.kind === "load_bearing",
      claim_type: "system_fact",
      claim: fact.title,
      detail: fact.detail || "",
      confidence: typeof fact.confidence === "number" ? fact.confidence : 0.8,
      artifact_path: "system.json"
    }, evidence);

    if (fact.check_cmd) {
      pushEvidence({
        entity_id: `fact:${fact.id}`,
        entity_type: "system-fact",
        entity_key: fact.id,
        entity_title: fact.title,
        entity_url: `/facts/${encodeURIComponent(slugify(fact.id.replace(/[:/]+/g, "-")))}`,
        module_keys: fact.module_keys || [],
        claim_type: "fact_check",
        claim: fact.title,
        detail: fact.check_cmd,
        confidence: typeof fact.confidence === "number" ? fact.confidence : 0.8,
        artifact_path: "system.json"
      });
    }
  }

  const byEntityId = {};
  const byArtifactPath = {};
  for (const record of records) {
    if (!byEntityId[record.entity_id]) byEntityId[record.entity_id] = [];
    byEntityId[record.entity_id].push(record);
    if (!byArtifactPath[record.artifact_path]) byArtifactPath[record.artifact_path] = [];
    byArtifactPath[record.artifact_path].push(record);
  }

  const entities = Object.entries(byEntityId)
    .map(([entityId, items]) => ({
      entity_id: entityId,
      entity_title: items[0]?.entity_title || entityId,
      entity_type: items[0]?.entity_type || "unknown",
      entity_url: items[0]?.entity_url || "",
      count: items.length,
      artifact_paths: unique(items.map(item => item.artifact_path)),
      files: unique(items.map(item => item.file))
    }))
    .sort((left, right) => right.count - left.count || left.entity_title.localeCompare(right.entity_title));

  const artifacts = Object.entries(byArtifactPath)
    .map(([artifactPath, items]) => ({
      artifact_path: artifactPath,
      count: items.length,
      entity_ids: unique(items.map(item => item.entity_id)),
      files: unique(items.map(item => item.file))
    }))
    .sort((left, right) => right.count - left.count || left.artifact_path.localeCompare(right.artifact_path));

  return {
    items: records,
    byEntityId,
    byArtifactPath,
    entities,
    artifacts
  };
}

function scoreDocument(doc, tokens, queryLower, intent) {
  const title = doc.title.toLowerCase();
  const key = String(doc.key || "").toLowerCase();
  const summary = String(doc.summary || "").toLowerCase();
  const searchText = String(doc.search_text || "").toLowerCase();
  const normalizedQuery = normalizeSearchComparable(queryLower);
  const normalizedKey = normalizeSearchComparable(key);
  const normalizedTitle = normalizeSearchComparable(title);
  let score = 0;
  const reasons = [];

  if (queryLower && key === queryLower) {
    score += 18;
    reasons.push("exact key");
  } else if (normalizedQuery && normalizedKey === normalizedQuery) {
    score += 18;
    reasons.push("exact key");
  }
  if (queryLower && title === queryLower) {
    score += 16;
    reasons.push("exact title");
  } else if (normalizedQuery && normalizedTitle === normalizedQuery) {
    score += 16;
    reasons.push("exact title");
  } else if (queryLower && title.includes(queryLower)) {
    score += 8;
    reasons.push("title match");
  }

  let keyMatch = false;
  let titleTokenMatch = false;
  let summaryMatch = false;
  let textMatch = false;
  for (const token of tokens) {
    if (key.includes(token)) {
      score += 5;
      keyMatch = true;
    }
    if (title.includes(token)) {
      score += 4;
      titleTokenMatch = true;
    }
    if (summary.includes(token)) {
      score += 2;
      summaryMatch = true;
    }
    if (searchText.includes(token)) {
      score += 1;
      textMatch = true;
    }
  }
  if (keyMatch) reasons.push("key hit");
  if (titleTokenMatch) reasons.push("title hit");
  if (summaryMatch) reasons.push("summary hit");
  if (textMatch) reasons.push("content hit");

  if (intent.impact && doc.type === "module" && doc.load_bearing) {
    score += 3;
    reasons.push("impact + load-bearing");
  }
  if (intent.impact && doc.type === "module") {
    score += 5;
    reasons.push("impact + module");
  }
  if (intent.impact && ["flow", "system-fact"].includes(doc.type)) {
    score += 0.75;
  }
  if (intent.rules && ["system-fact", "domain", "layer"].includes(doc.type)) {
    score += 2;
  }
  if (doc.type === "evidence") {
    score += intent.evidence ? 2.5 : -3.5;
  }
  if (intent.rules && doc.type === "evidence") {
    score += 1;
    reasons.push("rules + evidence");
  }
  if (intent.evidence && doc.type === "evidence") {
    score += 4;
    reasons.push("evidence intent");
  }
  if (doc.freshness === "stale" || doc.freshness === "queued") {
    score += intent.impact ? 1.5 : 0.5;
  }
  // Navigational types are more useful for agent orientation than evidence fragments.
  if (["module", "parent-module"].includes(doc.type)) score += 3;
  if (doc.type === "flow") score += 2;

  return { score, reasons: unique(reasons) };
}

function detectSearchIntent(tokens) {
  return {
    impact: tokens.some(token => IMPACT_INTENT_TOKENS.has(token)),
    rules: tokens.some(token => RULE_INTENT_TOKENS.has(token)),
    evidence: tokens.some(token => EVIDENCE_INTENT_TOKENS.has(token))
  };
}

export function searchKnowledge(snapshot, query, options = {}) {
  const { top, topModuleKeys } = rankSearchDocuments(snapshot.search.documents, query, options);

  if (top.length === 0 || topModuleKeys.length === 0) return top;

  const boosted = new Map(top.map(doc => [doc.id, doc]));
  for (const moduleKey of topModuleKeys) {
    const module = snapshot.modules.byKey[moduleKey];
    if (!module) continue;

    for (const flow of module.related_flows.slice(0, 4)) {
      const docId = `flow:${flow.name}`;
      if (boosted.has(docId)) continue;
      const doc = snapshot.search.byId[docId];
      if (!doc) continue;
      boosted.set(docId, {
        ...doc,
        score: 0.75,
        why: ["related flow"]
      });
    }

    for (const fact of module.system_facts.slice(0, 4)) {
      const docId = `fact:${fact.id}`;
      if (boosted.has(docId)) continue;
      const doc = snapshot.search.byId[docId];
      if (!doc) continue;
      boosted.set(docId, {
        ...doc,
        score: 0.6,
        why: ["related system fact"]
      });
    }

    for (const domain of snapshot.system.collections.domains.filter(entry => (entry.module_keys || []).includes(moduleKey)).slice(0, 3)) {
      const docId = domain.id;
      if (boosted.has(docId)) continue;
      const doc = snapshot.search.byId[docId];
      if (!doc) continue;
      boosted.set(docId, {
        ...doc,
        score: 2,
        why: ["related domain"]
      });
    }
  }

  return [...boosted.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, options.limit || 20);
}

export function rankSearchDocuments(documents, query, options = {}) {
  const limit = options.limit || 20;
  const rawTokens = tokenizeQuery(query);
  const tokens = rawTokens.filter(token =>
    !IMPACT_INTENT_TOKENS.has(token)
    && !RULE_INTENT_TOKENS.has(token)
    && !EVIDENCE_INTENT_TOKENS.has(token)
  );
  const queryLower = String(query || "").trim().toLowerCase();
  const intent = detectSearchIntent(rawTokens);
  const scoringTokens = tokens.length > 0 ? tokens : rawTokens;

  if (!queryLower) {
    return {
      top: [],
      topModuleKeys: []
    };
  }

  const scored = documents
    .map(doc => {
      const { score, reasons } = scoreDocument(doc, scoringTokens, queryLower, intent);
      return {
        ...doc,
        score: Number(score.toFixed(3)),
        why: reasons
      };
    })
    .filter(doc => doc.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));

  const top = scored.slice(0, limit);
  const topModuleKeys = unique(top.flatMap(doc => doc.module_keys || []).slice(0, 12));
  return { top, topModuleKeys };
}

export function findShortestPath(snapshot, sourceKey, targetKey) {
  if (!sourceKey || !targetKey || !snapshot.modules.byKey[sourceKey] || !snapshot.modules.byKey[targetKey]) {
    return null;
  }
  if (sourceKey === targetKey) {
    return {
      nodes: [sourceKey],
      edges: []
    };
  }

  const queue = [[sourceKey]];
  const visited = new Set([sourceKey]);

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];
    const neighbors = snapshot.graph.adjacency.out[current] || [];

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      const nextPath = [...path, neighbor];
      if (neighbor === targetKey) {
        const edges = [];
        for (let index = 0; index < nextPath.length - 1; index++) {
          const source = nextPath[index];
          const target = nextPath[index + 1];
          const edge = snapshot.graph.edgeLookup[`${source}|${target}`] || null;
          if (edge) edges.push(edge);
        }
        return {
          nodes: nextPath,
          edges
        };
      }
      visited.add(neighbor);
      queue.push(nextPath);
    }
  }

  return null;
}

export function buildGraphView(snapshot, options = {}) {
  const mode = options.mode || "overview";
  const moduleKey = options.module || null;
  const flowName = options.flow || null;
  const from = options.from || null;
  const to = options.to || null;

  if (mode === "focus" && moduleKey && snapshot.modules.byKey[moduleKey]) {
    const center = snapshot.modules.byKey[moduleKey];
    const neighborhoodKeys = unique([
      moduleKey,
      ...center.dependencies.map(entry => entry.target),
      ...center.dependents.map(entry => entry.source),
      ...center.related_flows.flatMap(flow => flow.module_keys || [])
    ]);
    return {
      mode,
      title: `Neighborhood: ${center.name}`,
      nodes: neighborhoodKeys.map(key => snapshot.graph.nodesById[key]).filter(Boolean),
      edges: snapshot.graph.edges.filter(edge => neighborhoodKeys.includes(edge.source) && neighborhoodKeys.includes(edge.target))
    };
  }

  if (mode === "impact" && moduleKey && snapshot.modules.byKey[moduleKey]) {
    const center = snapshot.modules.byKey[moduleKey];
    const impactKeys = unique([
      moduleKey,
      ...center.dependents.map(entry => entry.source),
      ...center.dependencies.map(entry => entry.target),
      ...center.related_flows.flatMap(flow => flow.module_keys || []),
      ...center.second_order_dependents
    ]);
    return {
      mode,
      title: `Impact: ${center.name}`,
      nodes: impactKeys.map(key => snapshot.graph.nodesById[key]).filter(Boolean),
      edges: snapshot.graph.edges.filter(edge => impactKeys.includes(edge.source) && impactKeys.includes(edge.target))
    };
  }

  if (mode === "flow" && flowName) {
    const flow = snapshot.flows.byName[flowName];
    if (!flow) return { mode, title: "Flow not found", nodes: [], edges: [] };
    const flowKeys = unique(flow.module_keys);
    return {
      mode,
      title: `Flow: ${flow.title}`,
      nodes: flowKeys.map(key => snapshot.graph.nodesById[key]).filter(Boolean),
      edges: snapshot.graph.edges.filter(edge => flowKeys.includes(edge.source) && flowKeys.includes(edge.target))
    };
  }

  if (mode === "path" && from && to) {
    const result = findShortestPath(snapshot, from, to);
    if (!result) return { mode, title: "No path found", nodes: [], edges: [] };
    return {
      mode,
      title: `Path: ${from} → ${to}`,
      nodes: result.nodes.map(key => snapshot.graph.nodesById[key]).filter(Boolean),
      edges: result.edges
    };
  }

  if (mode === "module") {
    return {
      mode,
      title: "Module Graph",
      nodes: snapshot.graph.nodes,
      edges: snapshot.graph.edges
    };
  }

  return {
    mode: "overview",
    title: "Architecture Overview",
    nodes: snapshot.graph.overview.nodes,
    edges: snapshot.graph.overview.edges
  };
}

export function buildKnowledgeSnapshot(sonarDir) {
  const graphData = loadGraphData(sonarDir);
  const freshness = loadFreshness(sonarDir, graphData);
  const meta = loadJsonIfExists(join(sonarDir, "meta.json"), {});
  const system = loadJsonIfExists(join(sonarDir, "system.json"), {});
  const skeleton = loadJsonIfExists(join(sonarDir, "skeleton.json"), { modules: {} });

  const moduleCards = listJson(join(sonarDir, "modules")).map(entry => normalizeModuleCard({
    ...entry.data,
    source_artifact: entry.path
  }, entry.name.replace(/\.json$/, "")));
  const submoduleCards = listJson(join(sonarDir, "submodules")).map(entry => normalizeSubmoduleCard({
    ...entry.data,
    source_artifact: entry.path
  }, entry.name.replace(/\.json$/, "")));
  const flows = listJson(join(sonarDir, "flows")).map(entry => {
    const normalized = normalizeFlow(entry.data);
    const moduleKeys = unique([
      ...normalized.steps.map(step => step.module),
      ...(entry.data.modules_involved || [])
    ].filter(Boolean));
    return {
      ...normalized,
      source_artifact: entry.path,
      module_keys: moduleKeys,
      invariant_items: normalized.invariants,
      failure_mode_items: normalized.failure_modes,
      invariants: normalized.invariants.map(item => item.text),
      failure_modes: normalized.failure_modes.map(item => item.text),
      freshness: freshness.flow.get(normalized.name) || {
        status: "unknown",
        reason: "",
        updated_at: null
      }
    };
  });

  const moduleMap = new Map();
  for (const row of graphData.modules) {
    moduleMap.set(row.key, {
      ...row,
      responsibilities: [],
      business_rules: [],
      conventions: [],
      public_api: [],
      function_cards: [],
      side_effects: [],
      files: [],
      responsibilities_count: 0,
      child_module_keys: row.child_module_keys || []
    });
  }

  for (const card of moduleCards) {
    const existing = moduleMap.get(card.key) || {};
    moduleMap.set(card.key, {
      ...existing,
      ...card,
      kind: card.kind || existing.kind || "module",
      child_module_keys: unique([...(existing.child_module_keys || []), ...(card.child_module_keys || [])])
    });
  }

  for (const [moduleKey, moduleInfo] of Object.entries(skeleton.modules || {})) {
    if (moduleMap.has(moduleKey)) continue;
    moduleMap.set(moduleKey, {
      key: moduleKey,
      name: moduleKey,
      purpose: "",
      description: "",
      kind: "module",
      path: moduleInfo.path || moduleKey,
      files: moduleInfo.files || [],
      responsibilities: [],
      business_rules: [],
      conventions: [],
      public_api: [],
      function_cards: [],
      side_effects: [],
      child_module_keys: [],
      analyzed_at: null
    });
  }

  // Derive test files from skeleton file lists
  const TEST_FILE_RE = /\.(spec|test)\.[jt]sx?$|__tests__\//;
  for (const [key, module] of moduleMap.entries()) {
    const files = module.files || [];
    module.test_files = module.test_files || files.filter(f => TEST_FILE_RE.test(f));
    module.key_invariants = module.key_invariants || [];
    module.verification_commands = module.verification_commands || [];
  }

  const edgeStore = new Map();
  const adjacencyOut = new Map();
  const adjacencyIn = new Map();

  for (const edge of graphData.edges) {
    addEdge(edgeStore, adjacencyOut, adjacencyIn, edge.source, edge.target, edge.kind, edge.weight);
  }

  if (edgeStore.size === 0) {
    for (const module of moduleMap.values()) {
      for (const dependency of unique(module.dependencies || [])) {
        const target = typeof dependency === "string" ? dependency : dependency.key || dependency.module || dependency.name;
        addEdge(edgeStore, adjacencyOut, adjacencyIn, module.key, target, "imports", 1);
      }
    }
  }

  const systemCollections = createSystemCollections(system);
  const layerByModule = new Map();
  for (const layer of systemCollections.layers) {
    for (const moduleKey of layer.module_keys) {
      layerByModule.set(moduleKey, layer);
    }
  }

  const fanInMap = new Map();
  const fanOutMap = new Map();
  for (const moduleKey of moduleMap.keys()) {
    fanInMap.set(moduleKey, (adjacencyIn.get(moduleKey) || new Set()).size);
    fanOutMap.set(moduleKey, (adjacencyOut.get(moduleKey) || new Set()).size);
  }
  const loadBearingSet = new Set(deriveLoadBearingModules([...moduleMap.keys()], fanInMap, system));

  const factsRaw = buildSystemFacts(system);
  const facts = factsRaw.map(fact => ({
    ...fact,
    slug: slugify(fact.id.replace(/[:/]+/g, "-"))
  }));

  const factsByModule = new Map();
  for (const fact of facts) {
    for (const moduleKey of fact.module_keys || []) {
      if (!factsByModule.has(moduleKey)) factsByModule.set(moduleKey, []);
      factsByModule.get(moduleKey).push(fact);
    }
  }

  const flowsByModule = new Map();
  for (const flow of flows) {
    for (const moduleKey of flow.module_keys) {
      if (!flowsByModule.has(moduleKey)) flowsByModule.set(moduleKey, []);
      flowsByModule.get(moduleKey).push(flow);
    }
  }

  const submodulesByParent = new Map();
  for (const card of submoduleCards) {
    if (!submodulesByParent.has(card.parent_module_key)) submodulesByParent.set(card.parent_module_key, []);
    submodulesByParent.get(card.parent_module_key).push(card);
  }

  const modules = [...moduleMap.values()]
    .map(module => {
      const graphRoots = unique([module.key, ...(module.child_module_keys || [])]);
      const childModules = graphRoots
        .filter(key => key !== module.key)
        .map(key => moduleMap.get(key))
        .filter(Boolean);

      const dependencyTargets = unique(
        graphRoots.flatMap(rootKey => [...(adjacencyOut.get(rootKey) || new Set())])
      ).filter(target => !graphRoots.includes(target));
      const dependentSources = unique(
        graphRoots.flatMap(rootKey => [...(adjacencyIn.get(rootKey) || new Set())])
      ).filter(source => !graphRoots.includes(source));

      const dependencies = dependencyTargets
        .map(target => ({
          target,
          kinds: unique(graphData.edges
            .filter(edge => graphRoots.includes(edge.source) && edge.target === target)
            .map(edge => edge.kind))
        }))
        .sort((left, right) => left.target.localeCompare(right.target));
      const dependents = dependentSources
        .map(source => ({
          source,
          kinds: unique(graphData.edges
            .filter(edge => edge.source === source && graphRoots.includes(edge.target))
            .map(edge => edge.kind))
        }))
        .sort((left, right) => left.source.localeCompare(right.source));
      const relatedFlows = unique(
        graphRoots.flatMap(rootKey => (flowsByModule.get(rootKey) || []).map(flow => flow.name))
      )
        .map(name => flows.find(flow => flow.name === name))
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name));
      const systemFacts = unique(
        graphRoots.flatMap(rootKey => (factsByModule.get(rootKey) || []).map(fact => fact.id))
      )
        .map(id => facts.find(fact => fact.id === id))
        .filter(Boolean)
        .sort((left, right) => left.title.localeCompare(right.title));
      const moduleFreshness = freshness.module.get(module.key) || {
        status: "unknown",
        reason: "",
        updated_at: null
      };
      const effectiveLayer = layerByModule.get(module.key)
        || childModules
          .map(child => layerByModule.get(child.key))
          .find(Boolean)
        || null;
      const fileCount = module.kind === "parent"
        ? childModules.reduce((sum, child) => sum + ((child.files || []).length), 0)
        : (module.files || []).length;
      const functionCount = module.kind === "parent"
        ? childModules.reduce((sum, child) => sum + ((child.function_cards || []).length), 0)
        : (module.function_cards || []).length;
      const publicApiCount = module.kind === "parent"
        ? childModules.reduce((sum, child) => sum + ((child.public_api || []).length), 0)
        : (module.public_api || []).length;
      const secondOrderDependents = unique(
        dependentSources.flatMap(source => [...(adjacencyIn.get(source) || new Set())])
      ).filter(source => !graphRoots.includes(source));
      const loadBearing = graphRoots.some(rootKey => loadBearingSet.has(rootKey));

      return {
        ...module,
        layer: effectiveLayer,
        freshness: moduleFreshness,
        dependencies,
        dependents,
        related_flows: relatedFlows.map(flow => ({
          name: flow.name,
          title: flow.title,
          module_keys: flow.module_keys,
          invariants: flow.invariants
        })),
        system_facts: systemFacts,
        submodules: submodulesByParent.get(module.key) || [],
        load_bearing: loadBearing,
        stats: {
          fan_in: dependentSources.length,
          fan_out: dependencyTargets.length,
          file_count: fileCount,
          function_count: functionCount,
          public_api_count: publicApiCount
        },
        second_order_dependents: secondOrderDependents
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const modulesByKey = Object.fromEntries(modules.map(module => [module.key, module]));
  const moduleGraphNodes = modules.map(module => ({
    id: module.key,
    label: module.name || module.key,
    type: "module",
    layer: module.layer?.name || null,
    loadBearing: module.load_bearing,
    freshness: module.freshness.status,
    purpose: (module.purpose || module.description || "").slice(0, 240),
    fileCount: module.stats.file_count,
    fanIn: module.stats.fan_in,
    fanOut: module.stats.fan_out
  }));
  const moduleGraphEdges = [...edgeStore.values()]
    .map(edge => ({
      ...edge,
      impactWeight: (edge.weight || 1) + (loadBearingSet.has(edge.target) ? 1 : 0)
    }))
    .sort((left, right) => right.weight - left.weight || left.source.localeCompare(right.source));
  const graphNodesById = Object.fromEntries(moduleGraphNodes.map(node => [node.id, node]));
  const graphEdgeLookup = Object.fromEntries(moduleGraphEdges.map(edge => [`${edge.source}|${edge.target}`, edge]));

  const overview = buildLayerGraph(systemCollections.layers, moduleGraphEdges, layerByModule);
  const evidence = buildEvidenceItems({ modules, flows, facts });

  const searchDocuments = createSearchDocuments({
    modules,
    submodules: submoduleCards,
    flows,
    facts,
    systemCollections,
    evidence
  });
  const searchById = Object.fromEntries(searchDocuments.map(doc => [doc.id, doc]));

  return {
    version: SNAPSHOT_VERSION,
    generated_at: new Date().toISOString(),
    source: {
      sonar_dir: sonarDir,
      meta,
      db: graphData.stats
    },
    system: {
      ...system,
      collections: systemCollections,
      facts
    },
    modules: {
      items: modules,
      byKey: modulesByKey
    },
    submodules: {
      items: submoduleCards,
      byKey: Object.fromEntries(submoduleCards.map(item => [item.key, item]))
    },
    flows: {
      items: flows,
      byName: Object.fromEntries(flows.map(flow => [flow.name, flow]))
    },
    search: {
      documents: searchDocuments,
      byId: searchById
    },
    evidence,
    freshness: {
      module: Object.fromEntries([...freshness.module.entries()]),
      flow: Object.fromEntries([...freshness.flow.entries()]),
      system: Object.fromEntries([...freshness.system.entries()])
    },
    graph: {
      nodes: moduleGraphNodes,
      nodesById: graphNodesById,
      edges: moduleGraphEdges,
      edgeLookup: graphEdgeLookup,
      adjacency: {
        out: Object.fromEntries([...adjacencyOut.entries()].map(([key, value]) => [key, [...value].sort()])),
        in: Object.fromEntries([...adjacencyIn.entries()].map(([key, value]) => [key, [...value].sort()]))
      },
      overview
    }
  };
}

export function writeKnowledgeSnapshot(sonarDir, snapshot) {
  const outDir = join(sonarDir, "wiki-data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "knowledge.json");
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  return outPath;
}

export function loadKnowledgeSnapshot(sonarDir) {
  const snapshotPath = join(sonarDir, "wiki-data", "knowledge.json");
  return readJson(snapshotPath, null);
}
