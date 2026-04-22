#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

function sortByTitle(items) {
  return [...items].sort((left, right) => (left.title || left.name || "").localeCompare(right.title || right.name || ""));
}

const TEST_FILE_RE = /\.(spec|test)\.[jt]sx?$|__tests__\//;
function skeletonTestFiles(skeletonModule) {
  return (skeletonModule?.files || []).filter(f => TEST_FILE_RE.test(f));
}

export function buildAgentBriefArtifacts({
  sonarDir,
  moduleRows,
  moduleCardsByKey,
  moduleDependencies,
  moduleDependents,
  symbolsByModule,
  flows,
  systemFacts,
  freshness,
  skeletonModules = {}
}) {
  const briefDir = join(sonarDir, "partials", "agent-briefs");
  mkdirSync(briefDir, { recursive: true });

  const systemFactsByModule = new Map();
  for (const fact of systemFacts) {
    const moduleKeys = fact.module_keys || [];
    if (moduleKeys.length === 0) {
      for (const moduleKey of moduleRows.keys()) {
        if (!systemFactsByModule.has(moduleKey)) systemFactsByModule.set(moduleKey, []);
        systemFactsByModule.get(moduleKey).push(fact);
      }
      continue;
    }

    for (const moduleKey of moduleKeys) {
      if (!systemFactsByModule.has(moduleKey)) systemFactsByModule.set(moduleKey, []);
      systemFactsByModule.get(moduleKey).push(fact);
    }
  }

  const flowRowsByModule = new Map();
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (!flowRowsByModule.has(step.module)) flowRowsByModule.set(step.module, []);
      flowRowsByModule.get(step.module).push(flow);
    }
  }

  const index = {
    generated_at: new Date().toISOString(),
    modules: [],
    flows: [],
    system_facts: []
  };

  for (const [moduleKey, moduleRow] of moduleRows.entries()) {
    const card = moduleCardsByKey.get(moduleKey) || {};
    const relatedFlows = sortByTitle(flowRowsByModule.get(moduleKey) || [])
      .map(flow => ({
        name: flow.name,
        title: flow.title,
        confidence: flow.confidence,
        freshness: freshness.flow.get(flow.name)?.status || "unknown",
        steps: flow.steps
          .filter(step => step.module === moduleKey)
          .map(step => ({
            order: step.order,
            function: step.function,
            what: step.what,
            data: step.data,
            confidence: step.confidence
          })),
        invariants: flow.invariants.slice(0, 2).map(item => item.text)
      }));

    const applicableFacts = sortByTitle(systemFactsByModule.get(moduleKey) || [])
      .map(fact => ({
        id: fact.id,
        kind: fact.kind,
        title: fact.title,
        detail: fact.detail,
        scope: fact.scope,
        confidence: fact.confidence
      }));

    // Module cards use different field names depending on which version of the
    // module-analyst produced them. Normalise here so briefs always have
    // business_rules / conventions / public_api regardless.
    const businessRules = card.business_rules || card.responsibilities || [];
    const conventions   = card.conventions   || card.patterns          || [];
    const publicApi     = card.public_api    || card.exports           || [];

    // moduleRow.purpose comes from graph.db; it is often empty because the DB
    // doesn't store description. Fall back to card.description.
    const moduleRowWithPurpose = {
      ...moduleRow,
      purpose: moduleRow.purpose || card.description || ""
    };

    const brief = {
      module: moduleRowWithPurpose,
      freshness: freshness.module.get(moduleKey) || {
        artifact_type: "module",
        artifact_key: moduleKey,
        status: "unknown",
        reason: "No freshness data available."
      },
      public_api: publicApi,
      top_symbols: (symbolsByModule.get(moduleKey) || []).slice(0, 8),
      dependencies: moduleDependencies.get(moduleKey) || [],
      dependents: moduleDependents.get(moduleKey) || [],
      business_rules: businessRules.slice(0, 5),
      conventions: conventions.slice(0, 5),
      related_flows: relatedFlows.slice(0, 5),
      system_facts: applicableFacts.slice(0, 8),
      side_effects: card.side_effects || [],
      notes: card.notes || card.domain || "",
      function_cards: (card.function_cards || []).slice(0, 5).map(f => ({ name: f.name, file: f.file, line: f.line, purpose: f.purpose })),
      test_files: card.test_files || skeletonTestFiles(skeletonModules[moduleKey]),
      key_invariants: card.key_invariants || [],
      verification_commands: card.verification_commands || []
    };

    brief.search_text = [
      moduleRowWithPurpose.key,
      moduleRowWithPurpose.name,
      moduleRowWithPurpose.purpose,
      card.domain,
      ...brief.dependencies,
      ...brief.dependents,
      ...brief.business_rules.map(rule => typeof rule === "string" ? rule : rule.rule || ""),
      ...brief.conventions.map(rule => typeof rule === "string" ? rule : rule.rule || ""),
      ...brief.top_symbols.map(symbol => symbol.name),
      ...brief.related_flows.map(flow => `${flow.name} ${flow.title} ${flow.invariants.join(" ")}`),
      ...brief.system_facts.map(fact => `${fact.title} ${fact.detail}`),
      ...brief.side_effects,
      brief.notes,
      ...brief.function_cards.map(f => f.name),
      ...brief.test_files.map(f => f.split("/").pop()),
      ...brief.key_invariants
    ].filter(Boolean).join(" ");

    writeFileSync(join(briefDir, `${moduleKey}.json`), JSON.stringify(brief, null, 2));

    index.modules.push({
      key: moduleKey,
      title: moduleRow.name,
      purpose: moduleRow.purpose,
      freshness: brief.freshness.status,
      load_bearing: applicableFacts.some(fact => fact.kind === "load_bearing"),
      dependencies: brief.dependencies,
      dependents: brief.dependents,
      related_flows: brief.related_flows.map(flow => flow.name),
      system_fact_ids: brief.system_facts.map(fact => fact.id),
      search_text: brief.search_text
    });
  }

  index.flows = flows.map(flow => ({
    name: flow.name,
    title: flow.title,
    confidence: flow.confidence,
    freshness: freshness.flow.get(flow.name)?.status || "unknown",
    modules: [...new Set(flow.steps.map(step => step.module))],
    invariants: flow.invariants.slice(0, 3).map(item => item.text),
    search_text: [
      flow.name,
      flow.title,
      flow.summary,
      ...flow.steps.map(step => `${step.module} ${step.function} ${step.what} ${step.data}`),
      ...flow.invariants.map(item => item.text),
      ...flow.failure_modes.map(item => item.text)
    ].filter(Boolean).join(" ")
  }));

  index.system_facts = systemFacts.map(fact => ({
    id: fact.id,
    kind: fact.kind,
    title: fact.title,
    detail: fact.detail,
    scope: fact.scope,
    module_keys: fact.module_keys,
    confidence: fact.confidence,
    search_text: [fact.id, fact.kind, fact.title, fact.detail, fact.scope, ...(fact.module_keys || [])].filter(Boolean).join(" ")
  }));

  writeFileSync(join(briefDir, "index.json"), JSON.stringify(index, null, 2));
}
