#!/usr/bin/env node

/**
 * Sonar Wiki Builder — renders markdown pages from the canonical knowledge snapshot.
 *
 * Usage: node build-wiki.mjs [sonar-dir]
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  buildGraphView,
  buildKnowledgeSnapshot,
  writeKnowledgeSnapshot
} from "../lib/knowledge-snapshot.mjs";

const SONAR_DIR = resolve(process.argv[2] || ".sonar");
const WIKI_DIR = join(SONAR_DIR, "wiki");

function ensureDir(pathValue) {
  mkdirSync(pathValue, { recursive: true });
}

function writeWiki(relPath, content) {
  const fullPath = join(WIKI_DIR, relPath);
  ensureDir(dirname(fullPath));
  writeFileSync(fullPath, content.trimEnd() + "\n", "utf8");
}

function fmtDate(value) {
  return value ? String(value).slice(0, 10) : "unknown";
}

function trimText(value, max = 160) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function code(value) {
  return `\`${String(value || "")}\``;
}

function mdLink(label, href) {
  return `[${label}](${href})`;
}

function moduleWikiLink(key, label = null) {
  return `[[modules/${key}|${label || key}]]`;
}

function flowWikiLink(name, label = null) {
  return `[[flows/${name}|${label || name}]]`;
}

function submoduleWikiLink(key, label = null) {
  return `[[submodules/${key}|${label || key}]]`;
}

function factWikiLink(fact) {
  return `[[facts/${fact.slug}|${fact.title}]]`;
}

function domainWikiLink(domain) {
  return `[[domains/${domain.id.split(":").pop()}|${domain.name}]]`;
}

function layerWikiLink(layer) {
  return `[[layers/${layer.id.split(":").pop()}|${layer.name}]]`;
}

function statusLabel(status) {
  const normalized = String(status || "unknown").toLowerCase();
  if (normalized === "fresh") return "fresh";
  if (normalized === "stale") return "stale";
  if (normalized === "queued") return "queued";
  return normalized || "unknown";
}

function graphLink(label, searchParams) {
  return mdLink(label, `/graph?${new URLSearchParams(searchParams).toString()}`);
}

function evidenceLink(entityId, label = "evidence") {
  return mdLink(label, `/evidence?entity=${encodeURIComponent(entityId)}`);
}

function formatEvidenceList(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map(item => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return null;
      const file = item.file || item.source || item.path;
      const line = item.line != null ? `:${item.line}` : "";
      return file ? `${file}${line}` : null;
    })
    .filter(Boolean);
}

function narrativeText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return item.text || item.rule || item.description || "";
}

function narrativeConfidence(item, fallback = null) {
  if (item && typeof item === "object" && typeof item.confidence === "number") {
    return item.confidence;
  }
  return fallback;
}

function narrativeEvidence(item) {
  if (!item || typeof item !== "object") return [];
  return formatEvidenceList(item.evidence || []);
}

function evidenceItemsFor(snapshot, entityId) {
  return snapshot.evidence?.byEntityId?.[entityId] || [];
}

function formatEvidenceSource(record) {
  if (record.file) {
    return `${record.file}${record.line != null ? `:${record.line}` : ""}`;
  }
  return record.artifact_path || "artifact";
}

function pushTable(lines, headers, rows) {
  if (!rows.length) return;
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
}

function renderIndex(snapshot) {
  const lines = [];
  const staleModules = snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).slice(0, 12);
  const loadBearing = snapshot.modules.items.filter(module => module.load_bearing).slice(0, 12);
  const topFlows = snapshot.flows.items.slice(0, 12);
  const topFacts = snapshot.system.facts.slice(0, 12);

  lines.push("# Sonar Control Center");
  lines.push("");
  lines.push(`Built ${fmtDate(snapshot.generated_at)} from ${code(snapshot.source.sonar_dir)}`);
  lines.push("");
  lines.push(`- Modules: ${snapshot.modules.items.length}`);
  lines.push(`- Flows: ${snapshot.flows.items.length}`);
  lines.push(`- System facts: ${snapshot.system.facts.length}`);
  lines.push(`- Search documents: ${snapshot.search.documents.length}`);
  lines.push(`- Graph edges: ${snapshot.graph.edges.length}`);
  lines.push("");
  lines.push("## Start Here");
  lines.push("");
  lines.push(`- ${graphLink("Architecture overview", { mode: "overview" })}`);
  lines.push(`- ${graphLink("Full module graph", { mode: "module" })}`);
  lines.push(`- ${mdLink("Search the map", "/search")}`);
  lines.push(`- ${mdLink("Audit evidence", "/evidence")}`);
  lines.push(`- ${mdLink("System overview", "/overview")}`);
  lines.push("");

  lines.push("## Load-Bearing Modules");
  lines.push("");
  pushTable(lines, ["Module", "Freshness", "Fan in", "Purpose"], loadBearing.map(module => [
    moduleWikiLink(module.key, module.name),
    statusLabel(module.freshness.status),
    String(module.stats.fan_in),
    trimText(module.purpose || module.description, 100)
  ]));

  lines.push("## Attention Queue");
  lines.push("");
  if (staleModules.length === 0) {
    lines.push("All known modules are fresh.");
    lines.push("");
  } else {
    pushTable(lines, ["Module", "Status", "Reason"], staleModules.map(module => [
      moduleWikiLink(module.key, module.name),
      statusLabel(module.freshness.status),
      trimText(module.freshness.reason, 120)
    ]));
  }

  lines.push("## Flows");
  lines.push("");
  pushTable(lines, ["Flow", "Modules", "Confidence", "Graph"], topFlows.map(flow => [
    flowWikiLink(flow.name, flow.title),
    String(flow.module_keys.length),
    String(flow.confidence ?? ""),
    graphLink("flow", { mode: "flow", flow: flow.name })
  ]));

  lines.push("## System Surfaces");
  lines.push("");
  if (snapshot.system.collections.domains.length > 0) {
    lines.push(`- Domains: ${snapshot.system.collections.domains.slice(0, 12).map(domainWikiLink).join(", ")}`);
  }
  if (snapshot.system.collections.layers.length > 0) {
    lines.push(`- Layers: ${snapshot.system.collections.layers.slice(0, 12).map(layerWikiLink).join(", ")}`);
  }
  if (topFacts.length > 0) {
    lines.push(`- Facts: ${topFacts.map(factWikiLink).join(", ")}`);
  }
  lines.push("");

  lines.push("## Search Prompts");
  lines.push("");
  lines.push(`- ${mdLink("what breaks if checkout changes", "/search?q=what+breaks+if+checkout+changes")}`);
  lines.push(`- ${mdLink("where is rate limiting enforced", "/search?q=where+is+rate+limiting+enforced")}`);
  lines.push(`- ${mdLink("show auth middleware", "/search?q=auth+middleware")}`);
  lines.push("");

  return lines.join("\n");
}

function renderOverview(snapshot) {
  const lines = [];
  const { collections } = snapshot.system;

  lines.push("# System Overview");
  lines.push("");
  lines.push(`Generated ${fmtDate(snapshot.generated_at)}. This page is the synthesis surface for the current Sonar snapshot.`);
  lines.push("");

  if (collections.domains.length > 0) {
    lines.push("## Domains");
    lines.push("");
    pushTable(lines, ["Domain", "Description", "Modules"], collections.domains.map(domain => [
      domainWikiLink(domain),
      trimText(domain.description, 120),
      String(domain.module_keys.length)
    ]));
  }

  if (collections.concepts.length > 0) {
    lines.push("## Domain Concepts");
    lines.push("");
    pushTable(lines, ["Concept", "Description", "Modules"], collections.concepts.map(concept => [
      concept.name,
      trimText(concept.description, 120),
      concept.module_keys.slice(0, 6).map(key => moduleWikiLink(key)).join(", ")
    ]));
  }

  if (collections.layers.length > 0) {
    lines.push("## Architecture Layers");
    lines.push("");
    pushTable(lines, ["Layer", "Role", "Modules"], collections.layers.map(layer => [
      layerWikiLink(layer),
      trimText(layer.role, 120),
      String(layer.module_keys.length)
    ]));
  }

  if (snapshot.system.facts.length > 0) {
    lines.push("## System Facts");
    lines.push("");
    pushTable(lines, ["Fact", "Kind", "Modules"], snapshot.system.facts.slice(0, 32).map(fact => [
      factWikiLink(fact),
      fact.kind,
      String((fact.module_keys || []).length)
    ]));
  }

  if (collections.tensions.length > 0) {
    lines.push("## Tensions");
    lines.push("");
    for (const tension of collections.tensions) {
      lines.push(`- **${tension.title}**: ${tension.text}`);
    }
    lines.push("");
  }

  if (collections.overlaps.length > 0) {
    lines.push("## Overlaps");
    lines.push("");
    for (const overlap of collections.overlaps) {
      lines.push(`- **${overlap.concept}**: ${overlap.concern} (${overlap.module_keys.map(key => moduleWikiLink(key)).join(", ")})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderEvidenceIndex(snapshot) {
  const lines = [];
  const topEntities = (snapshot.evidence?.entities || []).slice(0, 24);
  const topArtifacts = (snapshot.evidence?.artifacts || []).slice(0, 24);

  lines.push("# Evidence Explorer");
  lines.push("");
  lines.push("This surface exposes where Sonar's claims come from: module cards, flow cards, system synthesis, and source-linked references.");
  lines.push("");
  lines.push(`- Evidence records: ${(snapshot.evidence?.items || []).length}`);
  lines.push(`- Evidence-backed entities: ${(snapshot.evidence?.entities || []).length}`);
  lines.push(`- Source artifacts: ${(snapshot.evidence?.artifacts || []).length}`);
  lines.push("");

  if (topEntities.length > 0) {
    lines.push("## Evidence-Rich Entities");
    lines.push("");
    pushTable(lines, ["Entity", "Type", "Records", "Artifacts"], topEntities.map(item => [
      mdLink(item.entity_title, item.entity_url),
      item.entity_type,
      String(item.count),
      item.artifact_paths.slice(0, 3).map(code).join(", ")
    ]));
  }

  if (topArtifacts.length > 0) {
    lines.push("## Source Artifacts");
    lines.push("");
    pushTable(lines, ["Artifact", "Records", "Entities"], topArtifacts.map(item => [
      code(item.artifact_path),
      String(item.count),
      String(item.entity_ids.length)
    ]));
  }

  return lines.join("\n");
}

function renderModulePage(module, snapshot) {
  const lines = [];
  const evidenceItems = evidenceItemsFor(snapshot, `module:${module.key}`);
  lines.push(`# ${module.name}`);
  lines.push("");
  if (module.purpose || module.description) {
    lines.push(`> ${module.purpose || module.description}`);
    lines.push("");
  }
  lines.push(`- Key: ${code(module.key)}`);
  lines.push(`- Kind: ${module.kind}`);
  lines.push(`- Layer: ${module.layer ? layerWikiLink(module.layer) : "unmapped"}`);
  lines.push(`- Freshness: ${statusLabel(module.freshness.status)}`);
  lines.push(`- Stats: fan-in ${module.stats.fan_in}, fan-out ${module.stats.fan_out}, files ${module.stats.file_count}, functions ${module.stats.function_count}`);
  lines.push(`- Risk views: ${graphLink("focus", { mode: "focus", module: module.key })}, ${graphLink("impact", { mode: "impact", module: module.key })}`);
  lines.push("");

  if (module.load_bearing || module.second_order_dependents.length > 0) {
    lines.push("## Change Risk");
    lines.push("");
    if (module.load_bearing) {
      lines.push("- This is a load-bearing module.");
    }
    if (module.second_order_dependents.length > 0) {
      lines.push(`- Second-order dependents: ${module.second_order_dependents.slice(0, 12).map(key => moduleWikiLink(key)).join(", ")}`);
    }
    if (module.related_flows.length > 0) {
      lines.push(`- Touched flows: ${module.related_flows.slice(0, 12).map(flow => flowWikiLink(flow.name, flow.title)).join(", ")}`);
    }
    lines.push("");
  }

  if (module.submodules.length > 0 || module.child_module_keys.length > 0) {
    lines.push("## Internal Structure");
    lines.push("");
    if (module.submodules.length > 0) {
      lines.push(`- Submodules: ${module.submodules.map(item => submoduleWikiLink(item.key, item.cluster_name)).join(", ")}`);
    }
    if (module.child_module_keys.length > 0) {
      lines.push(`- Child modules: ${module.child_module_keys.map(key => moduleWikiLink(key)).join(", ")}`);
    }
    lines.push("");
  }

  if ((module.responsibilities || []).length > 0) {
    lines.push("## Responsibilities");
    lines.push("");
    for (const responsibility of module.responsibilities) {
      lines.push(`- ${responsibility}`);
    }
    lines.push("");
  }

  if ((module.business_rules || []).length > 0) {
    lines.push("## Business Rules");
    lines.push("");
    for (const item of module.business_rules) {
      const rule = typeof item === "string" ? item : item.rule || item.text || "";
      const evidence = typeof item === "object" ? item.source || formatEvidenceList(item.evidence || []).join(", ") : "";
      lines.push(`- **${rule}**${evidence ? ` -- ${code(evidence)}` : ""}`);
    }
    lines.push("");
  }

  if ((module.conventions || []).length > 0) {
    lines.push("## Conventions");
    lines.push("");
    for (const item of module.conventions) {
      const rule = typeof item === "string" ? item : item.rule || item.text || "";
      const scope = typeof item === "object" && item.scope ? ` (${item.scope})` : "";
      const check = typeof item === "object" && item.check ? ` check: ${code(item.check)}` : "";
      lines.push(`- **${rule}**${scope}${check}`);
    }
    lines.push("");
  }

  if (evidenceItems.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    pushTable(lines, ["Claim", "Source", "Artifact"], evidenceItems.slice(0, 20).map(item => [
      trimText(item.claim, 90),
      code(formatEvidenceSource(item)),
      code(item.artifact_path)
    ]));
  }

  if (module.analyzed_at || module.source_artifact || module.freshness.reason || evidenceItems.length > 0) {
    lines.push("## Provenance");
    lines.push("");
    if (module.source_artifact) {
      lines.push(`- Source artifact: ${code(module.source_artifact)}`);
    }
    if (module.analyzed_at) {
      lines.push(`- Analyzed at: ${code(module.analyzed_at)}`);
    }
    if (module.freshness.reason) {
      lines.push(`- Freshness reason: ${code(module.freshness.reason)}`);
    }
    if (evidenceItems.length > 0) {
      lines.push(`- Audit trail: ${evidenceLink(`module:${module.key}`, `${evidenceItems.length} evidence records`)}`);
    }
    lines.push("");
  }

  lines.push("## Dependencies");
  lines.push("");
  if (module.dependencies.length === 0) {
    lines.push("(none)");
    lines.push("");
  } else {
    pushTable(lines, ["Target", "Kinds"], module.dependencies.map(item => [
      moduleWikiLink(item.target),
      (item.kinds || []).join(", ")
    ]));
  }

  lines.push("## Dependents");
  lines.push("");
  if (module.dependents.length === 0) {
    lines.push("(none)");
    lines.push("");
  } else {
    pushTable(lines, ["Source", "Kinds"], module.dependents.map(item => [
      moduleWikiLink(item.source),
      (item.kinds || []).join(", ")
    ]));
  }

  if (module.related_flows.length > 0) {
    lines.push("## Related Flows");
    lines.push("");
    pushTable(lines, ["Flow", "Modules", "Graph"], module.related_flows.map(flow => [
      flowWikiLink(flow.name, flow.title),
      String(flow.module_keys.length),
      graphLink("open", { mode: "flow", flow: flow.name })
    ]));
  }

  if (module.system_facts.length > 0) {
    lines.push("## System Facts");
    lines.push("");
    pushTable(lines, ["Fact", "Kind", "Detail"], module.system_facts.map(fact => [
      factWikiLink(fact),
      fact.kind,
      trimText(fact.detail, 100)
    ]));
  }

  if ((module.public_api || []).length > 0) {
    lines.push("## Public API");
    lines.push("");
    pushTable(lines, ["Function", "File", "Line"], module.public_api.map(item => [
      code(item.name || item.function || ""),
      code(item.file || ""),
      String(item.line ?? "")
    ]));
  }

  if ((module.function_cards || []).length > 0) {
    lines.push("## Function Cards");
    lines.push("");
    for (const fn of module.function_cards.slice(0, 40)) {
      lines.push(`### ${code(fn.name || fn.function || "")}`);
      if (fn.file || fn.line != null) {
        lines.push(`${code(fn.file || "")}${fn.line != null ? ` line ${fn.line}` : ""}`);
        lines.push("");
      }
      if (fn.purpose) {
        lines.push(`- Purpose: ${fn.purpose}`);
      }
      if ((fn.side_effects || []).length > 0) {
        lines.push(`- Side effects: ${fn.side_effects.join(", ")}`);
      }
      if ((fn.calls || []).length > 0) {
        lines.push(`- Calls: ${fn.calls.join(", ")}`);
      }
      if ((fn.called_by || []).length > 0) {
        lines.push(`- Called by: ${fn.called_by.join(", ")}`);
      }
      if (fn.error_behavior) {
        lines.push(`- Error behavior: ${fn.error_behavior}`);
      }
      lines.push("");
    }
  }

  if ((module.files || []).length > 0) {
    lines.push("## Files");
    lines.push("");
    for (const file of module.files) {
      lines.push(`- ${code(file)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderSubmodulePage(submodule, snapshot) {
  const parent = snapshot.modules.byKey[submodule.parent_module_key];
  const lines = [];
  lines.push(`# ${submodule.cluster_name}`);
  lines.push("");
  if (submodule.purpose || submodule.description) {
    lines.push(`> ${submodule.purpose || submodule.description}`);
    lines.push("");
  }
  lines.push(`- Key: ${code(submodule.key)}`);
  lines.push(`- Parent: ${parent ? moduleWikiLink(parent.key, parent.name) : code(submodule.parent_module_key)}`);
  lines.push(`- Graph: ${graphLink("parent impact view", { mode: "impact", module: submodule.parent_module_key })}`);
  lines.push("");

  if ((submodule.business_rules || []).length > 0) {
    lines.push("## Business Rules");
    lines.push("");
    for (const item of submodule.business_rules) {
      const rule = typeof item === "string" ? item : item.rule || item.text || "";
      lines.push(`- ${rule}`);
    }
    lines.push("");
  }

  if ((submodule.conventions || []).length > 0) {
    lines.push("## Conventions");
    lines.push("");
    for (const item of submodule.conventions) {
      const rule = typeof item === "string" ? item : item.rule || item.text || "";
      lines.push(`- ${rule}`);
    }
    lines.push("");
  }

  if ((submodule.public_api || []).length > 0) {
    lines.push("## Public API");
    lines.push("");
    pushTable(lines, ["Function", "File", "Line"], submodule.public_api.map(item => [
      code(item.name || item.function || ""),
      code(item.file || ""),
      String(item.line ?? "")
    ]));
  }

  if ((submodule.files || []).length > 0) {
    lines.push("## Files");
    lines.push("");
    for (const file of submodule.files) {
      lines.push(`- ${code(file)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderFlowPage(flow, snapshot) {
  const lines = [];
  const evidenceItems = evidenceItemsFor(snapshot, `flow:${flow.name}`);
  lines.push(`# ${flow.title}`);
  lines.push("");
  if (flow.summary) {
    lines.push(`> ${flow.summary}`);
    lines.push("");
  }
  lines.push(`- Name: ${code(flow.name)}`);
  lines.push(`- Freshness: ${statusLabel(flow.freshness.status)}`);
  lines.push(`- Confidence: ${flow.confidence}`);
  lines.push(`- Graph: ${graphLink("flow view", { mode: "flow", flow: flow.name })}`);
  lines.push("");

  if (flow.entry?.file || flow.entry?.function) {
    lines.push(`- Entry: ${code(flow.entry.file || "")}${flow.entry.function ? ` -> ${code(flow.entry.function)}` : ""}`);
  }
  if (flow.exit?.file || flow.exit?.function) {
    lines.push(`- Exit: ${code(flow.exit.file || "")}${flow.exit.function ? ` -> ${code(flow.exit.function)}` : ""}`);
  }
  if (flow.module_keys.length > 0) {
    lines.push(`- Modules: ${flow.module_keys.map(key => moduleWikiLink(key)).join(", ")}`);
  }
  lines.push("");

  if (flow.steps.length > 0) {
    lines.push("## Narrative");
    lines.push("");
    for (const step of flow.steps) {
      const evidence = formatEvidenceList(step.evidence || []);
      const confidence = typeof step.confidence === "number" ? ` confidence ${step.confidence}` : "";
      const location = step.file ? ` @ ${code(step.file)}${step.line != null ? `:${step.line}` : ""}` : "";
      const evidenceText = evidence.length > 0 ? ` -- evidence: ${evidence.map(code).join(", ")}` : "";
      lines.push(`1. **${moduleWikiLink(step.module)}** ${step.function ? `${code(step.function)} ` : ""}${step.what || "performs work"}${step.data ? ` -- ${step.data}` : ""}${location}${confidence ? ` -- ${confidence}` : ""}${evidenceText}`);
    }
    lines.push("");
  }

  if ((flow.invariant_items || flow.invariants || []).length > 0) {
    lines.push("## Invariants");
    lines.push("");
    for (const invariant of flow.invariant_items || flow.invariants || []) {
      const text = narrativeText(invariant);
      const confidence = narrativeConfidence(invariant, flow.confidence);
      const evidence = narrativeEvidence(invariant);
      lines.push(`- ${text}${confidence != null ? ` -- confidence ${confidence}` : ""}${evidence.length > 0 ? ` -- evidence: ${evidence.map(code).join(", ")}` : ""}`);
    }
    lines.push("");
  }

  if ((flow.failure_mode_items || flow.failure_modes || []).length > 0) {
    lines.push("## Failure Modes");
    lines.push("");
    for (const mode of flow.failure_mode_items || flow.failure_modes || []) {
      const text = narrativeText(mode);
      const confidence = narrativeConfidence(mode, flow.confidence);
      const evidence = narrativeEvidence(mode);
      lines.push(`- ${text}${confidence != null ? ` -- confidence ${confidence}` : ""}${evidence.length > 0 ? ` -- evidence: ${evidence.map(code).join(", ")}` : ""}`);
    }
    lines.push("");
  }

  if (evidenceItems.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    pushTable(lines, ["Claim", "Source", "Artifact"], evidenceItems.slice(0, 20).map(item => [
      trimText(item.claim, 90),
      code(formatEvidenceSource(item)),
      code(item.artifact_path)
    ]));
  }

  if (flow.source_artifact || flow.freshness.reason || evidenceItems.length > 0) {
    lines.push("## Provenance");
    lines.push("");
    if (flow.source_artifact) {
      lines.push(`- Source artifact: ${code(flow.source_artifact)}`);
    }
    if (flow.freshness.reason) {
      lines.push(`- Freshness reason: ${code(flow.freshness.reason)}`);
    }
    if (evidenceItems.length > 0) {
      lines.push(`- Audit trail: ${evidenceLink(`flow:${flow.name}`, `${evidenceItems.length} evidence records`)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderFactPage(fact, snapshot) {
  const lines = [];
  const evidenceItems = evidenceItemsFor(snapshot, `fact:${fact.id}`);
  lines.push(`# ${fact.title}`);
  lines.push("");
  lines.push(`- Kind: ${fact.kind}`);
  lines.push(`- Scope: ${fact.scope || "system"}`);
  lines.push(`- Confidence: ${fact.confidence}`);
  if (fact.check_cmd) {
    lines.push(`- Check: ${code(fact.check_cmd)}`);
  }
  if (fact.detail) {
    lines.push("");
    lines.push(`> ${fact.detail}`);
  }
  if ((fact.module_keys || []).length > 0) {
    lines.push("");
    lines.push("## Related Modules");
    lines.push("");
    lines.push((fact.module_keys || []).map(key => moduleWikiLink(key)).join(", "));
    lines.push("");
  }
  if (evidenceItems.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const item of evidenceItems.slice(0, 20)) {
      lines.push(`- ${code(formatEvidenceSource(item))} via ${code(item.artifact_path)}`);
    }
    lines.push("");
  }
  if (fact.check_cmd || evidenceItems.length > 0) {
    lines.push("## Provenance");
    lines.push("");
    if (fact.check_cmd) {
      lines.push(`- Verification command: ${code(fact.check_cmd)}`);
    }
    if (evidenceItems.length > 0) {
      lines.push(`- Audit trail: ${evidenceLink(`fact:${fact.id}`, `${evidenceItems.length} evidence records`)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderDomainPage(domain) {
  const lines = [];
  lines.push(`# ${domain.name}`);
  lines.push("");
  if (domain.description) {
    lines.push(`> ${domain.description}`);
    lines.push("");
  }
  if (domain.module_keys.length > 0) {
    lines.push("## Modules");
    lines.push("");
    lines.push(domain.module_keys.map(key => moduleWikiLink(key)).join(", "));
    lines.push("");
  }
  if ((domain.bounded_by || []).length > 0) {
    lines.push("## Boundaries");
    lines.push("");
    for (const item of domain.bounded_by) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderLayerPage(layer, snapshot) {
  const modules = layer.module_keys.map(key => snapshot.modules.byKey[key]).filter(Boolean);
  const lines = [];
  lines.push(`# ${layer.name}`);
  lines.push("");
  if (layer.role) {
    lines.push(`> ${layer.role}`);
    lines.push("");
  }
  lines.push(`- Graph: ${graphLink("overview", { mode: "overview" })}`);
  lines.push("");
  if (modules.length > 0) {
    lines.push("## Modules");
    lines.push("");
    pushTable(lines, ["Module", "Freshness", "Purpose"], modules.map(module => [
      moduleWikiLink(module.key, module.name),
      statusLabel(module.freshness.status),
      trimText(module.purpose || module.description, 110)
    ]));
  }
  return lines.join("\n");
}

function main() {
  const snapshot = buildKnowledgeSnapshot(SONAR_DIR);
  writeKnowledgeSnapshot(SONAR_DIR, snapshot);

  rmSync(WIKI_DIR, { recursive: true, force: true });
  ensureDir(WIKI_DIR);

  writeWiki("index.md", renderIndex(snapshot));
  writeWiki("overview.md", renderOverview(snapshot));
  writeWiki("evidence.md", renderEvidenceIndex(snapshot));

  for (const module of snapshot.modules.items) {
    writeWiki(`modules/${module.key}.md`, renderModulePage(module, snapshot));
  }

  for (const submodule of snapshot.submodules.items) {
    writeWiki(`submodules/${submodule.key}.md`, renderSubmodulePage(submodule, snapshot));
  }

  for (const flow of snapshot.flows.items) {
    writeWiki(`flows/${flow.name}.md`, renderFlowPage(flow, snapshot));
  }

  for (const fact of snapshot.system.facts) {
    writeWiki(`facts/${fact.slug}.md`, renderFactPage(fact, snapshot));
  }

  for (const domain of snapshot.system.collections.domains) {
    writeWiki(`domains/${domain.id.split(":").pop()}.md`, renderDomainPage(domain));
  }

  for (const layer of snapshot.system.collections.layers) {
    writeWiki(`layers/${layer.id.split(":").pop()}.md`, renderLayerPage(layer, snapshot));
  }

  writeWiki("graph-data.json", JSON.stringify(buildGraphView(snapshot, { mode: "module" }), null, 2));
  writeWiki("graph-overview.json", JSON.stringify(buildGraphView(snapshot, { mode: "overview" }), null, 2));

  console.log(`Wiki built from snapshot: ${snapshot.modules.items.length} modules, ${snapshot.flows.items.length} flows, ${snapshot.system.facts.length} facts -> ${WIKI_DIR}`);
}

main();
