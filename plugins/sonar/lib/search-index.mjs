#!/usr/bin/env node

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { loadSonarConfig, resolveProjectRootFromSonarDir } from "./config.mjs";
import { loadKnowledgeSnapshot, rankSearchDocuments, searchKnowledge } from "./knowledge-snapshot.mjs";
import { buildFtsQuery, normalizeSearchComparable } from "../scripts/retrieval-utils.mjs";

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeSearchDocRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key || "",
    type: row.type || "unknown",
    title: row.title || row.key || row.id,
    summary: row.summary || "",
    freshness: row.freshness || "unknown",
    url: row.url || "",
    module_keys: parseJsonArray(row.module_keys_json),
    load_bearing: Boolean(row.load_bearing),
    tags: parseJsonArray(row.tags_json),
    search_text: row.search_text || "",
    entity_id: row.entity_id || null,
    entity_title: row.entity_title || null,
    claim_type: row.claim_type || null,
    artifact_path: row.artifact_path || null,
    evidence_kind: row.evidence_kind || null,
    related_flow_keys: parseJsonArray(row.related_flow_keys_json),
    system_fact_ids: parseJsonArray(row.system_fact_ids_json),
    domain_ids: parseJsonArray(row.domain_ids_json)
  };
}

function getSearchBackendPreference(sonarDir, override = null) {
  if (override) return override;
  const projectRoot = resolveProjectRootFromSonarDir(sonarDir);
  const config = loadSonarConfig(projectRoot);
  return config.retrieval?.search_backend || "auto";
}

function sqlQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

const normalizeKeyText = normalizeSearchComparable;

function normalizedSqlText(column) {
  return `trim(replace(replace(replace(replace(replace(lower(${column}), '-', ' '), '_', ' '), '/', ' '), ':', ' '), '.', ' '))`;
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

function fallbackSnapshotSearch(sonarDir, query, options = {}) {
  const snapshot = options.snapshot || loadKnowledgeSnapshot(sonarDir);
  if (!snapshot) return null;
  return {
    backend: "snapshot",
    results: searchKnowledge(snapshot, query, { limit: options.limit || 20 })
  };
}

function tableExists(dbPath, tableName) {
  const rows = runSqliteJson(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ${sqlQuote(tableName)} LIMIT 1`,
    []
  );
  return rows.length > 0;
}

function fetchDocsByIds(dbPath, ids) {
  if (!ids.length) return [];
  const rows = runSqliteJson(
    dbPath,
    `SELECT * FROM search_docs WHERE id IN (${ids.map(sqlQuote).join(", ")})`,
    []
  );
  return rows.map(normalizeSearchDocRow).filter(Boolean);
}

function fetchModuleDocsByKeys(dbPath, moduleKeys) {
  if (!moduleKeys.length) return [];
  const rows = runSqliteJson(
    dbPath,
    `
    SELECT * FROM search_docs
    WHERE type IN ('module', 'parent-module') AND key IN (${moduleKeys.map(sqlQuote).join(", ")})
  `,
    []
  );
  return rows.map(normalizeSearchDocRow).filter(Boolean);
}

function queryDbCandidates(dbPath, query, limit) {
  const queryLower = String(query || "").trim().toLowerCase();
  const normalizedQuery = normalizeKeyText(query);
  const ftsQuery = buildFtsQuery(query);
  const candidates = new Map();
  const normalizedKey = normalizedSqlText("key");
  const normalizedTitle = normalizedSqlText("title");

  const exactRows = runSqliteJson(
    dbPath,
    `
    SELECT * FROM search_docs
    WHERE lower(key) = ${sqlQuote(queryLower)}
      OR lower(title) = ${sqlQuote(queryLower)}
      OR ${normalizedKey} = ${sqlQuote(normalizedQuery)}
      OR ${normalizedTitle} = ${sqlQuote(normalizedQuery)}
    ORDER BY CASE
      WHEN lower(key) = ${sqlQuote(queryLower)} THEN 0
      WHEN lower(title) = ${sqlQuote(queryLower)} THEN 1
      WHEN ${normalizedKey} = ${sqlQuote(normalizedQuery)} THEN 2
      WHEN ${normalizedTitle} = ${sqlQuote(normalizedQuery)} THEN 3
      ELSE 4
    END, title
    LIMIT 12
  `,
    []
  );
  for (const row of exactRows) {
    const normalized = normalizeSearchDocRow(row);
    if (normalized) candidates.set(normalized.id, normalized);
  }

  if (ftsQuery) {
    // Ensure modules and flows are represented in candidates so BM25's
    // bias toward short evidence docs doesn't crowd them out.
    // Use LIKE on key/title/summary (not FTS) so we match navigational fields directly.
    const escapedNav = queryLower.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const navLike = `%${escapedNav}%`;
    const navRows = runSqliteJson(
      dbPath,
      `
      SELECT * FROM search_docs
      WHERE type IN ('module', 'parent-module', 'flow')
        AND (lower(key) LIKE ${sqlQuote(navLike)} ESCAPE '\\'
          OR lower(title) LIKE ${sqlQuote(navLike)} ESCAPE '\\'
          OR lower(summary) LIKE ${sqlQuote(navLike)} ESCAPE '\\')
      ORDER BY title
      LIMIT 15
    `,
      []
    );
    for (const row of navRows) {
      const normalized = normalizeSearchDocRow(row);
      if (normalized) candidates.set(normalized.id, normalized);
    }

    const ftsRows = runSqliteJson(
      dbPath,
      `
      SELECT d.*
      FROM search_docs_fts
      JOIN search_docs d ON d.id = search_docs_fts.id
      WHERE search_docs_fts MATCH ${sqlQuote(ftsQuery)}
      ORDER BY bm25(search_docs_fts), d.title
      LIMIT ${Number(limit)}
    `,
      []
    );
    for (const row of ftsRows) {
      const normalized = normalizeSearchDocRow(row);
      if (normalized) candidates.set(normalized.id, normalized);
    }
  } else if (queryLower) {
    const escapedQuery = queryLower.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const likeQuery = `%${escapedQuery}%`;
    const likeRows = runSqliteJson(
      dbPath,
      `
      SELECT * FROM search_docs
      WHERE lower(key) LIKE ${sqlQuote(likeQuery)} ESCAPE '\\'
        OR lower(title) LIKE ${sqlQuote(likeQuery)} ESCAPE '\\'
        OR lower(summary) LIKE ${sqlQuote(likeQuery)} ESCAPE '\\'
      ORDER BY title
      LIMIT ${Number(limit)}
    `,
      []
    );
    for (const row of likeRows) {
      const normalized = normalizeSearchDocRow(row);
      if (normalized) candidates.set(normalized.id, normalized);
    }
  }

  return [...candidates.values()];
}

function expandRelatedDocs(dbPath, topResults, topModuleKeys) {
  if (!topResults.length || !topModuleKeys.length) return topResults;

  const boosted = new Map(topResults.map(doc => [doc.id, doc]));
  const moduleDocs = fetchModuleDocsByKeys(dbPath, topModuleKeys);
  if (!moduleDocs.length) return topResults;

  const relatedDocIds = [];
  for (const moduleDoc of moduleDocs) {
    relatedDocIds.push(
      ...moduleDoc.related_flow_keys.slice(0, 4).map(name => `flow:${name}`),
      ...moduleDoc.system_fact_ids.slice(0, 4).map(id => `fact:${id}`),
      ...moduleDoc.domain_ids.slice(0, 3)
    );
  }

  const relatedDocs = new Map(
    fetchDocsByIds(dbPath, [...new Set(relatedDocIds)])
      .map(doc => [doc.id, doc])
  );

  for (const moduleDoc of moduleDocs) {
    for (const flowName of moduleDoc.related_flow_keys.slice(0, 4)) {
      const docId = `flow:${flowName}`;
      if (boosted.has(docId)) continue;
      const doc = relatedDocs.get(docId);
      if (!doc) continue;
      boosted.set(docId, { ...doc, score: 0.75, why: ["related flow"] });
    }

    for (const factId of moduleDoc.system_fact_ids.slice(0, 4)) {
      const docId = `fact:${factId}`;
      if (boosted.has(docId)) continue;
      const doc = relatedDocs.get(docId);
      if (!doc) continue;
      boosted.set(docId, { ...doc, score: 0.6, why: ["related system fact"] });
    }

    for (const domainId of moduleDoc.domain_ids.slice(0, 3)) {
      if (boosted.has(domainId)) continue;
      const doc = relatedDocs.get(domainId);
      if (!doc) continue;
      boosted.set(domainId, { ...doc, score: 2, why: ["related domain"] });
    }
  }

  return [...boosted.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

function searchKnowledgeFromDb(sonarDir, query, options = {}) {
  const dbPath = join(sonarDir, "graph.db");
  if (!existsSync(dbPath)) return null;

  try {
    if (!tableExists(dbPath, "search_docs") || !tableExists(dbPath, "search_docs_fts")) {
      return null;
    }

    const candidateLimit = Math.max(options.candidateLimit || 80, (options.limit || 20) * 4);
    const candidates = queryDbCandidates(dbPath, query, candidateLimit);
    if (!candidates.length) {
      return null;
    }

    const limit = options.limit || 20;
    // Rank with a larger window so we can ensure navigational diversity.
    const { top: allScored } = rankSearchDocuments(candidates, query, { limit: limit * 3 });
    const navDocs = allScored.filter(d => ["module", "parent-module", "flow"].includes(d.type));

    // Reserve up to 5 slots for modules/flows so evidence doesn't drown them out.
    const navSlots = Math.min(5, navDocs.length);
    const reserved = navDocs.slice(0, navSlots);
    const reservedIds = new Set(reserved.map(d => d.id));
    const rest = allScored.filter(d => !reservedIds.has(d.id)).slice(0, limit - navSlots);
    const merged = [...reserved, ...rest]
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);

    const topModuleKeys = [...new Set(merged.flatMap(d => d.module_keys || []).slice(0, 12))];
    return expandRelatedDocs(dbPath, merged, topModuleKeys).slice(0, limit);
  } catch {
    return null;
  }
}

export function searchSonarKnowledge(sonarDir, query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { backend: "none", results: [] };
  }

  const backend = getSearchBackendPreference(sonarDir, options.backend);
  if (backend === "snapshot") {
    return fallbackSnapshotSearch(sonarDir, trimmed, options) || { backend: "snapshot", results: [] };
  }

  const sqliteResults = searchKnowledgeFromDb(sonarDir, trimmed, options);
  if (sqliteResults) {
    return {
      backend: "sqlite",
      results: sqliteResults
    };
  }

  if (backend === "sqlite") {
    if (options.fallbackToSnapshot === false) {
      return { backend: "none", results: [] };
    }
    return fallbackSnapshotSearch(sonarDir, trimmed, options) || { backend: "sqlite", results: [] };
  }

  if (options.fallbackToSnapshot === false) {
    return { backend: "none", results: [] };
  }

  return fallbackSnapshotSearch(sonarDir, trimmed, options) || { backend: "none", results: [] };
}
