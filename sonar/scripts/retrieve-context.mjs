#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { loadKnowledgeSnapshot, searchKnowledge } from "../lib/knowledge-snapshot.mjs";
import { getModuleState, loadSonarState, moduleFreshnessStatus } from "../lib/state.mjs";
import {
  loadJsonIfExists,
  scoreKeywordText,
  tokenizeQuery
} from "./retrieval-utils.mjs";

function sortByScore(rows) {
  return [...rows].sort((left, right) => right.score - left.score || (left.key || left.name || left.id || "").localeCompare(right.key || right.name || right.id || ""));
}

function includeImpactTerms(keywords) {
  return keywords.some(keyword => ["impact", "change", "changes", "break", "breaks", "update", "updates"].includes(keyword));
}

export function legacyRetrieve(sonarDir, query) {
  const startedAt = performance.now();
  const keywords = tokenizeQuery(query);
  const summaries = loadJsonIfExists(join(sonarDir, "summaries.json"), {});
  const state = loadSonarState(sonarDir);
  const flowsDir = join(sonarDir, "flows");

  const modules = [];
  for (const [key, summary] of Object.entries(summaries)) {
    const searchText = `${key} ${summary.purpose || ""} ${(summary.conventions || []).join(" ")} ${(summary.business_rules || []).join(" ")}`.toLowerCase();
    const score = scoreKeywordText(searchText, keywords);
    if (score === 0) continue;
    const moduleState = getModuleState(state, key);
    modules.push({
      key,
      score,
      purpose: summary.purpose || "",
      freshness: moduleState
        ? moduleFreshnessStatus(moduleState)
        : "unknown"
    });
  }

  const flows = [];
  if (existsSync(flowsDir)) {
    for (const file of readdirSync(flowsDir).filter(entry => entry.endsWith(".json"))) {
      const flow = loadJsonIfExists(join(flowsDir, file), null);
      if (!flow) continue;
      const score = scoreKeywordText(`${flow.name || ""} ${flow.title || ""}`, keywords);
      if (score === 0) continue;
      flows.push({
        name: flow.name,
        title: flow.title,
        score
      });
    }
  }

  return {
    mode: "legacy",
    query,
    duration_ms: Number((performance.now() - startedAt).toFixed(3)),
    modules: sortByScore(modules).slice(0, 5),
    flows: sortByScore(flows).slice(0, 5),
    system_facts: [],
    briefs: []
  };
}

export function enhancedRetrieve(sonarDir, query) {
  const startedAt = performance.now();
  const snapshot = loadKnowledgeSnapshot(sonarDir);
  if (snapshot) {
    const searchResults = searchKnowledge(snapshot, query, { limit: 15 });
    const modules = searchResults
      .filter(entry => ["module", "parent-module"].includes(entry.type))
      .slice(0, 5)
      .map(entry => {
        const module = snapshot.modules.byKey[entry.key];
        return {
          key: module.key,
          title: module.name,
          purpose: module.purpose || module.description || "",
          freshness: module.freshness.status,
          load_bearing: module.load_bearing,
          dependencies: module.dependencies.map(item => item.target),
          dependents: module.dependents.map(item => item.source),
          related_flows: module.related_flows.map(flow => flow.name),
          system_fact_ids: module.system_facts.map(fact => fact.id),
          search_text: entry.search_text,
          score: entry.score
        };
      });
    const flows = searchResults
      .filter(entry => entry.type === "flow")
      .slice(0, 5)
      .map(entry => {
        const flow = snapshot.flows.byName[entry.key];
        return {
          name: flow.name,
          title: flow.title,
          confidence: flow.confidence,
          freshness: flow.freshness.status,
          modules: flow.module_keys,
          search_text: entry.search_text,
          score: entry.score
        };
      });
    const systemFacts = searchResults
      .filter(entry => ["system-fact", "domain", "layer"].includes(entry.type))
      .slice(0, 5)
      .map(entry => ({
        id: entry.key,
        kind: entry.type,
        title: entry.title,
        detail: entry.summary,
        scope: "system",
        module_keys: entry.module_keys,
        confidence: entry.type === "layer" ? 0.8 : 0.85,
        search_text: entry.search_text,
        score: entry.score
      }));
    const briefs = modules
      .slice(0, 3)
      .map(entry => snapshot.modules.byKey[entry.key])
      .filter(Boolean)
      .map(module => ({
        module: {
          key: module.key,
          name: module.name,
          path: module.path,
          purpose: module.purpose || module.description || ""
        },
        freshness: {
          artifact_type: "module",
          artifact_key: module.key,
          status: module.freshness.status,
          reason: module.freshness.reason || "No freshness reasons recorded."
        },
        public_api: module.public_api || [],
        top_symbols: (module.function_cards || []).slice(0, 8).map(fn => ({
          name: fn.name || fn.function || "",
          kind: "function",
          file: fn.file || null,
          line: fn.line ?? null
        })),
        dependencies: module.dependencies.map(item => item.target),
        dependents: module.dependents.map(item => item.source),
        business_rules: (module.business_rules || []).slice(0, 3),
        conventions: (module.conventions || []).slice(0, 3),
        related_flows: module.related_flows.slice(0, 5),
        system_facts: module.system_facts.slice(0, 8)
      }));

    return {
      mode: "snapshot",
      query,
      duration_ms: Number((performance.now() - startedAt).toFixed(3)),
      modules,
      flows,
      system_facts: systemFacts,
      briefs
    };
  }

  const keywords = tokenizeQuery(query);
  const impactMode = includeImpactTerms(keywords);
  const briefDir = join(sonarDir, "partials", "agent-briefs");
  const index = loadJsonIfExists(join(briefDir, "index.json"), { modules: [], flows: [], system_facts: [] });
  const moduleIndex = new Map((index.modules || []).map(entry => [entry.key, entry]));
  const systemFactIndex = new Map((index.system_facts || []).map(entry => [entry.id, entry]));

  const moduleScores = new Map();
  const flowScores = new Map();
  const systemScores = new Map();

  for (const moduleEntry of index.modules || []) {
    const score = scoreKeywordText(moduleEntry.search_text, keywords);
    if (score === 0) continue;
    moduleScores.set(moduleEntry.key, {
      ...moduleEntry,
      score: moduleEntry.load_bearing && impactMode ? score + 1.5 : score
    });
  }

  for (const flowEntry of index.flows || []) {
    const baseScore = scoreKeywordText(flowEntry.search_text, keywords);
    if (baseScore === 0) continue;
    flowScores.set(flowEntry.name, {
      ...flowEntry,
      score: Number((baseScore + (flowEntry.confidence || 0)).toFixed(3))
    });
  }

  for (const factEntry of index.system_facts || []) {
    const score = scoreKeywordText(factEntry.search_text, keywords);
    if (score === 0) continue;
    systemScores.set(factEntry.id, {
      ...factEntry,
      score
    });
  }

  const topFlows = sortByScore(flowScores.values()).slice(0, 5);
  for (const flow of topFlows) {
    for (const moduleKey of flow.modules || []) {
      const current = moduleScores.get(moduleKey) || {
        key: moduleKey,
        title: moduleKey,
        purpose: "",
        freshness: "unknown",
        load_bearing: false,
        dependencies: [],
        dependents: [],
        related_flows: [],
        system_fact_ids: [],
        search_text: "",
        score: 0
      };
      current.score += 1.25;
      moduleScores.set(moduleKey, current);
    }
  }

  const topFacts = sortByScore(systemScores.values()).slice(0, 5);
  for (const fact of topFacts) {
    for (const moduleKey of fact.module_keys || []) {
      const current = moduleScores.get(moduleKey) || {
        key: moduleKey,
        title: moduleKey,
        purpose: "",
        freshness: "unknown",
        load_bearing: false,
        dependencies: [],
        dependents: [],
        related_flows: [],
        system_fact_ids: [],
        search_text: "",
        score: 0
      };
      current.score += 1;
      moduleScores.set(moduleKey, current);
    }
  }

  for (const moduleEntry of sortByScore(moduleScores.values()).slice(0, 5)) {
    const linkedModule = moduleIndex.get(moduleEntry.key) || moduleEntry;
    for (const factId of linkedModule.system_fact_ids || []) {
      const factEntry = systemFactIndex.get(factId);
      if (!factEntry) continue;

      const isDirectModuleFact = (factEntry.module_keys || []).includes(moduleEntry.key);
      const isGlobalConventionLike =
        (factEntry.module_keys || []).length === 0 &&
        ["convention", "pattern"].includes(factEntry.kind);
      if (!isDirectModuleFact && factEntry.kind !== "load_bearing" && !isGlobalConventionLike) continue;

      const current = systemScores.get(factEntry.id) || {
        ...factEntry,
        score: 0
      };
      current.score += impactMode && factEntry.kind === "load_bearing"
        ? 2
        : isGlobalConventionLike
          ? 0.5
          : 0.75;
      systemScores.set(factEntry.id, current);
    }
  }

  const initialModules = sortByScore(moduleScores.values()).slice(0, 5);
  for (const moduleEntry of initialModules) {
    for (const neighbor of [...(moduleEntry.dependencies || []), ...(moduleEntry.dependents || [])]) {
      const current = moduleScores.get(neighbor) || {
        key: neighbor,
        title: neighbor,
        purpose: "",
        freshness: "unknown",
        load_bearing: false,
        dependencies: [],
        dependents: [],
        related_flows: [],
        system_fact_ids: [],
        search_text: "",
        score: 0
      };
      current.score += 0.5;
      moduleScores.set(neighbor, current);
    }
  }

  const modules = sortByScore(moduleScores.values()).slice(0, 5);
  const flows = sortByScore(flowScores.values()).slice(0, 5);
  const systemFacts = sortByScore(systemScores.values()).slice(0, 5);
  const briefs = modules
    .slice(0, 3)
    .map(moduleEntry => loadJsonIfExists(join(briefDir, `${moduleEntry.key}.json`), null))
    .filter(Boolean);

  return {
    mode: "enhanced",
    query,
    duration_ms: Number((performance.now() - startedAt).toFixed(3)),
    modules,
    flows,
    system_facts: systemFacts,
    briefs
  };
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function main() {
  const [sonarDir = ".sonar", mode = "enhanced", ...queryParts] = process.argv.slice(2);
  const query = queryParts.join(" ").trim();

  if (!query) {
    console.error("Usage: node retrieve-context.mjs <sonar-dir> <legacy|enhanced> <query>");
    process.exit(1);
  }

  const result = mode === "legacy"
    ? legacyRetrieve(sonarDir, query)
    : enhancedRetrieve(sonarDir, query);

  printResult(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
