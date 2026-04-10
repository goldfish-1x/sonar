#!/usr/bin/env node

/**
 * Sonar Knowledge Workspace — serves any .sonar/wiki/ as a browsable local app.
 *
 * Usage:
 *   bun serve-wiki.mjs [sonar-dir] [port]
 *   node serve-wiki.mjs [sonar-dir] [port]
 */

import { createServer } from "http";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildGraphView,
  buildKnowledgeSnapshot,
  loadKnowledgeSnapshot,
  searchKnowledge,
  writeKnowledgeSnapshot
} from "../lib/knowledge-snapshot.mjs";

const SONAR_DIR = resolve(process.argv[2] || ".sonar");
const PORT = Number.parseInt(process.argv[3] || "3456", 10);
const WIKI_DIR = join(SONAR_DIR, "wiki");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VIS_NETWORK_ASSET_PATH = join(SCRIPT_DIR, "../node_modules/vis-network/dist/vis-network.min.js");
const VIS_NETWORK_ASSET = existsSync(VIS_NETWORK_ASSET_PATH)
  ? readFileSync(VIS_NETWORK_ASSET_PATH, "utf8")
  : null;

if (!existsSync(WIKI_DIR)) {
  console.error(`\n  Error: Wiki directory not found at ${WIKI_DIR}`);
  console.error("  Run /sonar wiki or build-wiki first.\n");
  process.exit(1);
}

let snapshot = loadKnowledgeSnapshot(SONAR_DIR);
if (!snapshot) {
  snapshot = buildKnowledgeSnapshot(SONAR_DIR);
  writeKnowledgeSnapshot(SONAR_DIR, snapshot);
}

function readMarkdown(relPath) {
  const safeRelPath = String(relPath || "").replace(/^\/+/, "");
  if (!safeRelPath || safeRelPath.includes("..")) return null;
  const fullPath = join(WIKI_DIR, safeRelPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf8");
}

function escHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodePath(value) {
  return encodeURIComponent(String(value || ""));
}

function moduleHref(key) {
  return `/modules/${encodePath(key)}`;
}

function flowHref(name) {
  return `/flows/${encodePath(name)}`;
}

function factHref(fact) {
  return `/facts/${encodePath(fact.slug)}`;
}

function domainHref(domain) {
  return `/domains/${encodePath(domain.id.split(":")[1])}`;
}

function layerHref(layer) {
  return `/layers/${encodePath(layer.id.split(":")[1])}`;
}

function submoduleHref(key) {
  return `/submodules/${encodePath(key)}`;
}

function evidenceHref(entityId = "") {
  return entityId ? `/evidence?entity=${encodePath(entityId)}` : "/evidence";
}

function prettyType(type) {
  const labels = {
    module: "Module",
    "parent-module": "Parent Module",
    submodule: "Submodule",
    flow: "Flow",
    "system-fact": "Fact",
    evidence: "Evidence",
    domain: "Domain",
    layer: "Layer"
  };
  return labels[type] || type;
}

function statusTone(status) {
  const map = {
    fresh: "ok",
    stale: "warn",
    queued: "warn",
    unknown: "muted"
  };
  return map[status] || "muted";
}

function summaryLine(parts) {
  return parts.filter(Boolean).join(" | ");
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function anchorSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBreadcrumbs(items = []) {
  const crumbs = items.filter(item => item && item.label);
  if (crumbs.length === 0) return "";
  return `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      ${crumbs.map((item, index) => {
        const body = item.href
          ? `<a href="${item.href}">${escHtml(item.label)}</a>`
          : `<span>${escHtml(item.label)}</span>`;
        return `${index > 0 ? `<span class="crumb-sep">/</span>` : ""}${body}`;
      }).join("")}
    </nav>
  `;
}

function renderPageHero({ eyebrow = "", title = "", lede = "", chips = [], actions = [], breadcrumbs = [] }) {
  return `
    ${buildBreadcrumbs(breadcrumbs)}
    <div class="page-hero">
      ${eyebrow ? `<div class="eyebrow">${escHtml(eyebrow)}</div>` : ""}
      <h1>${escHtml(title)}</h1>
      ${lede ? `<p class="lede">${escHtml(lede)}</p>` : ""}
      ${chips.length > 0 ? `<div class="chip-row">${chips.map(chip => {
        if (chip.href) {
          return `<a class="chip ${escHtml(chip.tone || "")}" href="${chip.href}">${escHtml(chip.label)}</a>`;
        }
        return `<span class="chip ${escHtml(chip.tone || "")}">${escHtml(chip.label)}</span>`;
      }).join("")}</div>` : ""}
      ${actions.length > 0 ? `<div class="button-row">${actions.map(action => `<a class="button${action.secondary ? " secondary" : ""}" href="${action.href}">${escHtml(action.label)}</a>`).join("")}</div>` : ""}
    </div>
  `;
}

function md(text) {
  let output = String(text || "");

  output = output
    .replace(/\[\[([^\]\|]+)\|([^\]]+)\]\]/g, (_, target, display) => `<a href="/${target}" class="wiki-link">${escHtml(display)}</a>`)
    .replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
      const display = String(target).split("/").pop();
      return `<a href="/${target}" class="wiki-link">${escHtml(display)}</a>`;
    });

  let mermaidIndex = 0;
  const mermaidSlots = {};
  output = output.replace(/```mermaid\n([\s\S]*?)```/g, (_, diagram) => {
    const token = `%%MERMAID${mermaidIndex++}%%`;
    mermaidSlots[token] = `<div class="mermaid">${diagram.trim()}</div>`;
    return token;
  });

  const headingIds = new Map();
  function headingHtml(level, rawText) {
    const base = anchorSlug(rawText);
    const count = headingIds.get(base) || 0;
    headingIds.set(base, count + 1);
    const id = count > 0 ? `${base}-${count + 1}` : base;
    return `<h${level} id="${id}"><a href="#${id}" class="heading-anchor" aria-label="Link to ${escHtml(rawText)}">#</a>${rawText}</h${level}>`;
  }

  output = output
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${escHtml(lang)}">${escHtml(code)}</code></pre>`)
    .replace(/^###### (.+)$/gm, (_, text) => headingHtml(6, text))
    .replace(/^##### (.+)$/gm, (_, text) => headingHtml(5, text))
    .replace(/^#### (.+)$/gm, (_, text) => headingHtml(4, text))
    .replace(/^### (.+)$/gm, (_, text) => headingHtml(3, text))
    .replace(/^## (.+)$/gm, (_, text) => headingHtml(2, text))
    .replace(/^# (.+)$/gm, (_, text) => headingHtml(1, text))
    .replace(/^\|(.+)\|$/gm, match => {
      const cells = match.split("|").filter(Boolean).map(cell => cell.trim());
      if (cells.every(cell => /^[-:]+$/.test(cell))) return "<!--table-sep-->";
      return `<tr>${cells.map(cell => `<td>${cell}</td>`).join("")}</tr>`;
    })
    .replace(/((?:<tr>.*<\/tr>\n?|<!--table-sep-->\n?)+)/g, tableRows => {
      const rows = tableRows.replace(/<!--table-sep-->\n?/g, "").match(/<tr>[\s\S]*?<\/tr>/g) || [];
      if (rows.length === 0) return "";
      const headerRow = rows[0].replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>");
      const bodyRows = rows.slice(1);
      const rowCount = rows.length;
      const collapsible = rowCount > 5;
      const inner = `<table><thead>${headerRow}</thead>${bodyRows.length ? `<tbody>${bodyRows.join("")}</tbody>` : ""}</table>`;
      if (!collapsible) return inner;
      return `<details class="table-wrap" open><summary class="table-summary">Table <span class="table-count">${bodyRows.length} row${bodyRows.length === 1 ? "" : "s"}</span></summary>${inner}</details>`;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
    .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:16px;margin:20px 0;">')
    .replace(/^---+$/gm, "<hr>")
    .replace(/^(?!<(?:h\d|ul|li|table|tr|blockquote|pre|img|hr))(?!\s*$)(.+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");

  for (const [token, html] of Object.entries(mermaidSlots)) {
    output = output.replace(new RegExp(token, "g"), html);
  }

  return output;
}

function stripLeadingTitle(markdown, title) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return String(markdown || "");
  const pattern = new RegExp(`^#\\s+${escapeRegExp(cleanTitle)}\\s*\\n+`, "i");
  return String(markdown || "").replace(pattern, "");
}

function extractHeadings(markdown) {
  const seen = new Map();
  const headings = [];
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const match = rawLine.match(/^(##+)\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    const base = anchorSlug(text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    headings.push({
      level,
      text,
      id: count > 0 ? `${base}-${count + 1}` : base
    });
  }
  return headings;
}

function buildNav(snapshot, currentPath = "/") {
  const staleModules = snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).slice(0, 8);
  const loadBearing = snapshot.modules.items.filter(module => module.load_bearing).slice(0, 8);
  const flows = snapshot.flows.items.slice(0, 8);
  const domains = snapshot.system.collections.domains.slice(0, 8);
  const layers = snapshot.system.collections.layers.slice(0, 8);

  function navLink(href, label, meta = "") {
    const current = currentPath === href || (href !== "/" && currentPath.startsWith(`${href}/`));
    return `<a href="${href}" class="nav-link${current ? " current" : ""}">
      <span>${escHtml(label)}</span>
      ${meta ? `<span class="nav-meta">${escHtml(meta)}</span>` : ""}
    </a>`;
  }

  return `
    <div class="nav-brand">
      <div class="brand-mark">S</div>
      <div>
        <div class="brand-title">Sonar Workspace</div>
        <div class="brand-subtitle">${snapshot.modules.items.length} modules · ${snapshot.graph.edges.length} edges</div>
      </div>
    </div>

    <form action="/search" method="get" class="nav-search">
      <input name="q" placeholder="Find module, flow, rule, layer..." />
      <button type="submit">Search</button>
    </form>

    <div class="nav-group" id="nav-group-core">
      <button class="nav-group-toggle" data-group="core">Core <span class="group-arrow">▾</span></button>
      <div class="nav-group-items">
        ${navLink("/", "Dashboard")}
        ${navLink("/search", "Search")}
        ${navLink("/catalog", "Catalog")}
        ${navLink("/evidence", "Evidence")}
        ${navLink("/overview", "Overview")}
        ${navLink("/graph", "Graph Workspace")}
      </div>
    </div>

    <div class="nav-group" id="nav-group-watchlist">
      <button class="nav-group-toggle" data-group="watchlist">Watchlist <span class="group-arrow">▾</span></button>
      <div class="nav-group-items">
        ${loadBearing.map(module => navLink(moduleHref(module.key), module.name, "load-bearing")).join("")}
        ${staleModules.map(module => navLink(moduleHref(module.key), module.name, module.freshness.status)).join("")}
      </div>
    </div>

    <div class="nav-group" id="nav-group-flows">
      <button class="nav-group-toggle" data-group="flows">Flows <span class="group-arrow">▾</span></button>
      <div class="nav-group-items">
        ${flows.map(flow => navLink(flowHref(flow.name), flow.title, `${flow.module_keys.length} modules`)).join("")}
      </div>
    </div>

    <div class="nav-group" id="nav-group-domains">
      <button class="nav-group-toggle" data-group="domains">Domains <span class="group-arrow">▾</span></button>
      <div class="nav-group-items">
        ${domains.map(domain => navLink(domainHref(domain), domain.name)).join("")}
      </div>
    </div>

    <div class="nav-group" id="nav-group-layers">
      <button class="nav-group-toggle" data-group="layers">Layers <span class="group-arrow">▾</span></button>
      <div class="nav-group-items">
        ${layers.map(layer => navLink(layerHref(layer), layer.name, `${layer.module_keys.length}`)).join("")}
      </div>
    </div>

    <button class="nav-collapse-btn" id="nav-toggle">‹ Collapse</button>
  `;
}

function appShell({ title, currentPath = "/", content, rail = "", fullWidth = false, extraHead = "", extraScript = "" }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800;900&family=Geist+Mono:wght@400;500&display=swap');

    :root {
      --bg: #ffffff;
      --bg-panel: #ffffff;
      --bg-muted: #f9fafb;
      --bg-strong: #f3f4f6;
      --ink: #111827;
      --ink-soft: #6b7280;
      --line: #e5e7eb;
      --accent: #0ea5e9;
      --accent-2: #f97316;
      --accent-3: #8b5cf6;
      --ok: #10b981;
      --warn: #f59e0b;
      --muted: #9ca3af;
      --shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
      --shadow-md: 0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06);
      --radius-lg: 8px;
      --radius-md: 6px;
      --radius-sm: 4px;
      --display: 'Geist', -apple-system, sans-serif;
      --sans: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
      --mono: 'Geist Mono', 'SFMono-Regular', ui-monospace, monospace;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      font-size: 0.875rem;
      color: var(--ink);
      background: var(--bg);
      min-height: 100vh;
    }
    a { color: inherit; text-decoration: none; }
    code { font-family: var(--mono); font-size: 0.92em; }
    pre {
      background: var(--ink);
      color: #f3f4f6;
      border-radius: var(--radius-md);
      padding: 14px;
      overflow-x: auto;
      font-size: 0.8rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 0.82rem;
    }
    th {
      padding: 7px 12px;
      text-align: left;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--ink-soft);
      border-bottom: 2px solid var(--line);
      white-space: nowrap;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      color: var(--ink);
    }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: var(--bg-muted); }
    .table-wrap {
      margin: 14px 0;
      border-top: 1px solid var(--line);
    }
    .table-wrap table { margin: 0; }
    .table-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--ink-soft);
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .table-summary::-webkit-details-marker { display: none; }
    .table-summary::before { content: "▾"; font-size: 0.8rem; transition: transform 0.15s; }
    .table-wrap:not([open]) .table-summary::before { transform: rotate(-90deg); }
    .table-count {
      background: var(--bg-strong);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--ink-soft);
    }
    blockquote {
      margin: 12px 0;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
      background: rgba(14,165,233,0.04);
      border-radius: 0 4px 4px 0;
      color: var(--ink-soft);
      font-size: 0.875rem;
    }
    hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
    .wiki-link { color: var(--accent); font-weight: 600; }
    .heading-anchor {
      opacity: 0;
      margin-right: 8px;
      color: var(--accent);
      font-size: 0.9rem;
    }
    h1:hover .heading-anchor,
    h2:hover .heading-anchor,
    h3:hover .heading-anchor,
    h4:hover .heading-anchor,
    h5:hover .heading-anchor,
    h6:hover .heading-anchor { opacity: 1; }

    .app {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100vh;
      transition: grid-template-columns 0.2s ease;
    }
    .app.nav-collapsed {
      grid-template-columns: 40px 1fr;
    }
    .app.nav-collapsed .nav {
      overflow: hidden;
      padding: 0;
      border-right: 1px solid var(--line);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 14px;
    }
    .app.nav-collapsed .nav-brand,
    .app.nav-collapsed .nav-search,
    .app.nav-collapsed .nav-group { display: none; }
    /* collapsed: show just the icon button */
    .app.nav-collapsed .nav-collapse-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      margin: 0;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--bg);
      font-size: 0.9rem;
      display: grid;
      place-items: center;
      position: static;
      box-shadow: var(--shadow);
    }
    .nav-collapse-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      background: none;
      border: none;
      border-top: 1px solid var(--line);
      cursor: pointer;
      padding: 9px 8px;
      margin-top: auto;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--ink-soft);
      font-family: var(--sans);
      text-align: left;
      position: sticky;
      bottom: 0;
      background: var(--bg-muted);
    }
    .nav-collapse-btn:hover { color: var(--ink); }
    .nav {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 16px 12px 20px;
      border-right: 1px solid var(--line);
      background: var(--bg-muted);
      overflow-y: auto;
    }
    .nav-brand {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--accent);
      color: white;
      display: grid;
      place-items: center;
      font-weight: 800;
      font-size: 0.75rem;
    }
    .brand-title { font-weight: 700; font-size: 0.9rem; font-family: var(--display); }
    .brand-subtitle { color: var(--ink-soft); font-size: 0.75rem; }
    .nav-search {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      margin-bottom: 14px;
    }
    .nav-search input,
    .toolbar input,
    .toolbar select {
      width: 100%;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--ink);
      font: inherit;
      font-size: 0.83rem;
    }
    .nav-search button,
    .button,
    .toolbar button {
      border: 0;
      border-radius: 6px;
      padding: 7px 12px;
      font: inherit;
      font-size: 0.83rem;
      font-weight: 600;
      cursor: pointer;
      background: var(--accent);
      color: white;
    }
    .nav-section-label {
      margin: 14px 0 4px;
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-soft);
      padding: 0 8px;
    }
    .nav-link {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 6px;
      color: var(--ink-soft);
      font-size: 0.8rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
    }
    .nav-link span:first-child { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .nav-link:hover { background: var(--bg-strong); color: var(--ink); }
    .nav-link.current {
      background: rgba(14,165,233,0.1);
      color: var(--accent);
      font-weight: 600;
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .nav-meta {
      color: var(--ink-soft);
      font-size: 0.7rem;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .nav-group { margin-bottom: 4px; }
    .nav-group-toggle {
      display: flex; justify-content: space-between; align-items: center; width: 100%;
      background: none; border: none; cursor: pointer; padding: 0 8px; margin: 12px 0 2px;
      font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--ink-soft); font-family: var(--sans);
    }
    .nav-group-toggle:hover { color: var(--ink); }
    .group-arrow { transition: transform 0.15s ease; font-size: 0.7rem; }
    .nav-group.group-collapsed .group-arrow { transform: rotate(-90deg); }
    .nav-group.group-collapsed .nav-group-items { display: none; }

    .main-wrap {
      padding: 20px 24px;
    }
    .page-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 20px;
      align-items: start;
    }
    .page-grid.full {
      grid-template-columns: minmax(0, 1fr);
    }
    .rail-surface {
      background: transparent;
    }
    .surface {
      min-width: 0;
    }
    .surface h1 {
      margin: 0 0 12px;
      font-size: clamp(1.5rem, 3vw, 2.2rem);
      line-height: 1.15;
      letter-spacing: -0.03em;
      font-family: var(--display);
      font-weight: 800;
    }
    .surface h2 {
      margin-top: 24px;
      margin-bottom: 10px;
      font-size: 0.95rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      padding-left: 10px;
      border-left: 2px solid var(--accent);
      font-family: var(--display);
    }
    .surface h3 { margin-top: 16px; margin-bottom: 8px; font-size: 0.9rem; font-weight: 600; }
    .surface p, .surface li { color: var(--ink-soft); line-height: 1.6; font-size: 0.875rem; }
    .surface ul { padding-left: 18px; }
    .breadcrumbs {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
      color: var(--ink-soft);
      font-size: 0.78rem;
      font-family: var(--mono);
    }
    .crumb-sep { opacity: 0.55; }
    .breadcrumbs a:hover { color: var(--accent); }
    .page-hero {
      margin-bottom: 18px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(14,165,233,0.1);
      color: var(--accent);
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
      font-family: var(--mono);
    }
    .lede {
      margin: 0 0 12px;
      font-size: 0.9rem;
      color: var(--ink-soft);
      line-height: 1.6;
    }
    .hero-grid,
    .card-grid,
    .stats-grid,
    .actions-grid {
      display: grid;
      gap: 10px;
    }
    .hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 14px; }
    .stats-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 14px; }
    .actions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 16px; }
    .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .rail-surface { padding: 0; }
    .hero-card { padding: 0 0 16px; }
    .card { padding: 14px; }
    .metric-label {
      color: var(--ink-soft);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 0.68rem;
      font-weight: 600;
      font-family: var(--mono);
    }
    .metric-value {
      margin-top: 4px;
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.04em;
      font-family: var(--display);
      line-height: 1;
      color: var(--ink);
    }
    .muted { color: var(--ink-soft); }
    .list { display: grid; gap: 10px; }
    .list a:hover { color: var(--accent); }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--bg-strong);
      color: var(--ink-soft);
      font-size: 0.72rem;
      font-weight: 600;
      font-family: var(--mono);
    }
    .chip.ok { background: rgba(16,185,129,0.1); color: var(--ok); }
    .chip.warn { background: rgba(245,158,11,0.12); color: var(--warn); }
    .chip.critical {
      background: var(--ink);
      color: #ffffff;
      font-weight: 700;
    }
    .chip.muted { background: var(--bg-strong); color: var(--muted); }
    .directory-item.evidence-card {
      border: none;
      border-left: 3px solid var(--line);
      border-radius: 0;
      box-shadow: none;
      background: transparent;
      padding: 12px 14px;
    }
    .directory-item.evidence-card[data-kind="module"] { border-left-color: var(--accent); }
    .directory-item.evidence-card[data-kind="flow"] { border-left-color: var(--accent-3); }
    .directory-item.evidence-card[data-kind="fact"] { border-left-color: var(--accent-2); }
    .directory-item.evidence-card[data-kind="system"] { border-left-color: var(--muted); }
    .button-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .button.secondary {
      background: var(--bg-strong);
      color: var(--ink);
      border: 1px solid var(--line);
    }

    .rail {
      position: sticky;
      top: 20px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .rail-surface {
      border: none !important;
      box-shadow: none !important;
      background: transparent !important;
      padding: 0 0 16px 0;
      border-bottom: 1px solid var(--line) !important;
      margin-bottom: 16px;
    }
    .rail-surface:last-child { border-bottom: none !important; margin-bottom: 0; }
    .rail-surface h3 {
      margin: 0 0 8px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-soft);
    }
    .rail-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .rail-list li { font-size: 0.8rem; line-height: 1.5; }
    .rail-list a { color: var(--ink-soft); }
    .rail-list a:hover { color: var(--accent); }

    .search-result {
      border-bottom: 1px solid var(--line);
      padding: 14px 0;
      margin-top: 0;
      transition: background 0.1s ease;
    }
    .search-result:first-of-type { border-top: 1px solid var(--line); }
    .search-result:hover { background: var(--bg-alt); }
    .search-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
      margin-bottom: 6px;
    }
    .search-title strong {
      font-size: 0.9rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .search-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .query-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      margin: 12px 0 16px;
    }
    .query-bar input {
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--ink);
      font: inherit;
      font-size: 0.875rem;
    }
    .directory-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }
    .directory-grid.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .directory-item {
      background: transparent;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: none;
      padding: 14px;
      transition: border-color 0.12s ease;
    }
    .directory-item:hover {
      border-color: var(--accent);
      box-shadow: none;
    }
    .directory-item h3 {
      margin: 0 0 6px;
      font-size: 0.88rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .directory-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .directory-empty {
      padding: 20px;
      border: 1px dashed var(--line);
      border-radius: var(--radius-lg);
      background: var(--bg-muted);
      color: var(--ink-soft);
      text-align: center;
    }

    .toolbar {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .toolbar .span-2 { grid-column: span 2; }
    .graph-controls {
      display: flex;
      gap: 16px;
      align-items: start;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .graph-params { flex: 0 0 220px; }
    .graph-params input {
      width: 100%;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--ink);
      font: inherit;
      font-size: 0.83rem;
    }
    .graph-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 210px;
      gap: 12px;
    }
    .graph-stage {
      background: var(--bg-muted);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      overflow: hidden;
      min-height: 72vh;
    }
    #graph {
      width: 100%;
      height: 72vh;
    }
    .graph-sidebar {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .graph-card {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: 12px;
    }

    .empty-state {
      padding: 28px;
      text-align: center;
      color: var(--ink-soft);
      border: 1px dashed var(--line);
      border-radius: var(--radius-lg);
      background: var(--bg-muted);
    }

    .mermaid {
      padding: 14px;
      background: var(--bg-muted);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow-x: auto;
    }

    .mode-tabs {
      display: flex;
      gap: 2px;
      background: var(--bg-strong);
      padding: 3px;
      border-radius: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .mode-tab {
      border: 0;
      border-radius: 5px;
      padding: 6px 12px;
      font: inherit;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      background: transparent;
      color: var(--ink-soft);
      transition: background 0.1s ease, color 0.1s ease;
    }
    .mode-tab:hover {
      background: rgba(255,255,255,0.8);
      color: var(--ink);
    }
    .mode-tab.active {
      background: var(--bg);
      color: var(--accent);
      box-shadow: var(--shadow);
    }

    .dash-stats {
      display: flex;
      gap: 32px;
      margin: 24px 0;
      padding: 20px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .dash-stat { display: flex; align-items: baseline; gap: 6px; }
    .dash-stat-num { font-size: 2rem; font-weight: 800; letter-spacing: -0.04em; font-family: var(--display); }
    .dash-stat-label { font-size: 0.78rem; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
    .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px; }
    .dash-col {}
    .dash-section-label {
      font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--ink-soft); margin-bottom: 10px; padding-bottom: 6px;
      border-bottom: 1px solid var(--line);
    }
    .dash-list-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 7px 0; border-bottom: 1px solid var(--line);
      font-size: 0.85rem; color: var(--ink); text-decoration: none;
    }
    .dash-list-row:hover .dash-list-name { color: var(--accent); }
    .dash-list-name { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-action {
      display: block; padding: 7px 0; font-size: 0.85rem; color: var(--ink-soft);
      border-bottom: 1px solid var(--line); text-decoration: none;
    }
    .rail-action:hover { color: var(--accent); }
    .rail-section-label {
      font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--ink-soft); margin-bottom: 8px;
    }
    .rail-info-row {
      display: flex; justify-content: space-between; padding: 5px 0;
      font-size: 0.82rem; border-bottom: 1px solid var(--line); color: var(--ink-soft);
    }
    .result-header {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .result-title { font-weight: 600; font-size: 0.9rem; color: var(--ink); }
    .result-title:hover { color: var(--accent); }
    .result-type-label { font-size: 0.75rem; color: var(--ink-soft); }
    .result-type-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--muted);
    }
    .result-type-dot.type-module, .result-type-dot.type-parent-module { background: var(--accent); }
    .result-type-dot.type-flow { background: var(--accent-3); }
    .result-type-dot.type-fact { background: var(--accent-2); }
    .result-type-dot.type-evidence { background: var(--ok); }
    .result-summary { margin: 4px 0 6px 16px; font-size: 0.83rem; color: var(--ink-soft); }
    .result-actions { display: flex; gap: 12px; margin-left: 16px; }
    .result-action-link { font-size: 0.8rem; color: var(--accent); font-weight: 500; }
    .result-action-link:hover { text-decoration: underline; }
    .search-suggestions { margin-top: 20px; }
    .search-suggestion-label {
      font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--ink-soft); padding-bottom: 8px; border-bottom: 1px solid var(--line); margin-bottom: 0;
    }
    .search-suggestion-row {
      display: block; padding: 10px 0; border-bottom: 1px solid var(--line);
      font-size: 0.88rem; color: var(--ink); font-weight: 500;
    }
    .search-suggestion-row:hover { color: var(--accent); }
    .query-bar { display: flex; gap: 8px; margin-bottom: 20px; }
    .query-bar input { flex: 1; padding: 10px 14px; font-size: 0.95rem; border: 1px solid var(--line); border-radius: 6px; font: inherit; background: var(--bg); color: var(--ink); }
    .query-bar input:focus { outline: none; border-color: var(--accent); }
    .query-bar button { padding: 10px 18px; }
    .module-list { border-top: 1px solid var(--line); }
    .module-list-header {
      display: grid;
      grid-template-columns: 1fr 70px 80px 60px 50px 140px;
      gap: 12px; padding: 8px 12px;
      font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--ink-soft); border-bottom: 1px solid var(--line); background: var(--bg-muted);
    }
    .module-list-row {
      display: grid;
      grid-template-columns: 1fr 70px 80px 60px 50px 140px;
      gap: 12px; padding: 10px 12px; align-items: center;
      border-bottom: 1px solid var(--line);
      font-size: 0.85rem;
    }
    .module-list-row:hover { background: var(--bg-muted); }
    .module-list-name { font-weight: 500; min-width: 0; }
    .module-list-name a:hover { color: var(--accent); }

    @media (max-width: 1180px) {
      .page-grid,
      .graph-layout { grid-template-columns: 1fr; }
      .rail { position: static; }
      .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 900px) {
      .app { grid-template-columns: 1fr; }
      .nav {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .main-wrap { padding: 14px; }
      .hero-grid,
      .card-grid,
      .actions-grid,
      .toolbar,
      .directory-grid.two,
      .query-bar { grid-template-columns: 1fr; }
      .toolbar .span-2 { grid-column: span 1; }
    }
  </style>
  ${extraHead}
</head>
<body>
  <div class="app" id="app">
    <aside class="nav">${buildNav(snapshot, currentPath)}</aside>
    <div class="main-wrap">
      <div class="page-grid${fullWidth ? " full" : ""}">
        <main class="surface">${content}</main>
        ${fullWidth ? "" : `<aside class="rail">${rail}</aside>`}
      </div>
    </div>
  </div>
  <script>
    (function() {
      const app = document.getElementById('app');
      const btn = document.getElementById('nav-toggle');
      const stored = localStorage.getItem('nav-collapsed');
      if (stored === '1') app.classList.add('nav-collapsed');
      function updateBtn() {
        const collapsed = app.classList.contains('nav-collapsed');
        btn.textContent = collapsed ? '›' : '‹ Collapse';
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      }
      updateBtn();
      btn.addEventListener('click', function() {
        app.classList.toggle('nav-collapsed');
        localStorage.setItem('nav-collapsed', app.classList.contains('nav-collapsed') ? '1' : '0');
        updateBtn();
      });
      // Collapsible nav groups
      document.querySelectorAll('.nav-group-toggle').forEach(function(toggle) {
        const groupId = toggle.dataset.group;
        const group = document.getElementById('nav-group-' + groupId);
        if (!group) return;
        const stored = localStorage.getItem('nav-group-' + groupId);
        if (stored === '0') group.classList.add('group-collapsed');
        toggle.addEventListener('click', function() {
          const collapsed = group.classList.toggle('group-collapsed');
          localStorage.setItem('nav-group-' + groupId, collapsed ? '0' : '1');
        });
      });
    })();
  </script>
  ${extraScript}
</body>
</html>`;
}

function renderHomePage() {
  const staleModules = snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).slice(0, 8);
  const loadBearing = snapshot.modules.items
    .filter(module => module.load_bearing)
    .sort((left, right) => right.stats.fan_in - left.stats.fan_in)
    .slice(0, 8);
  const tensions = snapshot.system.collections.tensions.slice(0, 6);
  const topFlows = snapshot.flows.items.slice(0, 6);
  const facts = snapshot.system.facts.slice(0, 6);
  const dbStats = snapshot.source.db || {};
  const partialSignals = [];

  if ((dbStats.flow_steps || 0) === 0) partialSignals.push("graph.db has no flow_steps rows");
  if ((dbStats.system_facts || 0) === 0) partialSignals.push("graph.db has no system_facts rows");

  const content = `
    <div class="eyebrow">Knowledge Workspace</div>
    <h1>System shape, risk, and meaning.</h1>
    <p class="lede">Start from pressure. Pivot to flows. Drop into evidence only when the map tells you it matters.</p>

    <div class="dash-stats">
      <div class="dash-stat"><span class="dash-stat-num">${snapshot.modules.items.length}</span><span class="dash-stat-label">modules</span></div>
      <div class="dash-stat"><span class="dash-stat-num">${snapshot.flows.items.length}</span><span class="dash-stat-label">flows</span></div>
      <div class="dash-stat"><span class="dash-stat-num">${snapshot.system.facts.length}</span><span class="dash-stat-label">facts</span></div>
      <div class="dash-stat"><span class="dash-stat-num">${snapshot.graph.edges.length}</span><span class="dash-stat-label">edges</span></div>
    </div>

    <div class="dash-grid">
      <div class="dash-col">
        <div class="dash-section-label">Load-bearing</div>
        ${loadBearing.length === 0
          ? `<p class="muted">No load-bearing modules found.</p>`
          : loadBearing.map(m => `<a class="dash-list-row" href="${moduleHref(m.key)}">
              <span class="dash-list-name">${escHtml(m.name)}</span>
              <span class="chip critical">fan-in ${m.stats.fan_in}</span>
            </a>`).join("")}
      </div>
      <div class="dash-col">
        <div class="dash-section-label">Stale &amp; queued</div>
        ${staleModules.length === 0
          ? `<p class="muted">No stale or queued modules.</p>`
          : staleModules.map(m => `<a class="dash-list-row" href="${moduleHref(m.key)}">
              <span class="dash-list-name">${escHtml(m.name)}</span>
              <span class="chip warn">${escHtml(m.freshness.status)}</span>
            </a>`).join("")}
      </div>
    </div>

    <div class="dash-section-label" style="margin-top:24px;">Flows</div>
    ${topFlows.map(f => `<a class="dash-list-row" href="${flowHref(f.name)}">
      <span class="dash-list-name">${escHtml(f.title)}</span>
      <span class="muted" style="font-size:0.8rem;">${escHtml(f.summary?.slice(0, 80) || "")}</span>
    </a>`).join("")}

    ${tensions.length > 0 ? `
      <div class="dash-section-label" style="margin-top:24px;">Tensions</div>
      ${tensions.map(t => `<div class="dash-list-row">
        <span class="dash-list-name">${escHtml(t.title)}</span>
        <span class="muted" style="font-size:0.8rem;max-width:340px;">${escHtml((t.text || "").slice(0, 80))}</span>
      </div>`).join("")}
    ` : ""}
  `;

  const rail = `
    <div class="rail-surface">
      <div class="rail-section-label">Quick start</div>
      <a class="rail-action" href="/search">Search the map</a>
      <a class="rail-action" href="/graph">Explore graph</a>
      <a class="rail-action" href="/catalog/watchlist">View watchlist</a>
      <a class="rail-action" href="/evidence">Audit evidence</a>
    </div>
    <div class="rail-surface" style="margin-top:16px;">
      <div class="rail-section-label">Corpus</div>
      <div class="rail-info-row"><span>Modules</span><span>${snapshot.modules.items.length}</span></div>
      <div class="rail-info-row"><span>Flows</span><span>${snapshot.flows.items.length}</span></div>
      <div class="rail-info-row"><span>Edges</span><span>${snapshot.graph.edges.length}</span></div>
      <div class="rail-info-row"><span>Facts</span><span>${snapshot.system.facts.length}</span></div>
    </div>
  `;

  return appShell({
    title: "Sonar Workspace",
    currentPath: "/",
    content,
    rail
  });
}

function renderSearchPage(query) {
  const trimmed = String(query || "").trim();
  const results = trimmed ? searchKnowledge(snapshot, trimmed, { limit: 30 }) : [];

  const content = trimmed ? `
    ${renderPageHero({
      eyebrow: "Search",
      title: trimmed,
      lede: `${results.length} ranked result${results.length === 1 ? "" : "s"} across modules, flows, facts, evidence, domains, layers, and submodules.`,
      breadcrumbs: [{ label: "Dashboard", href: "/" }, { label: "Search" }]
    })}
    <form action="/search" method="get" class="query-bar">
      <input name="q" value="${escHtml(trimmed)}" placeholder="Find module, flow, rule, layer..." />
      <button class="button" type="submit">Search</button>
    </form>
    ${results.length === 0
      ? `<div class="empty-state">No results. Try a module key, a business rule, or an impact-style query like <code>what breaks if session changes</code>.</div>`
      : results.map(result => `
        <div class="search-result">
          <div class="result-header">
            <span class="result-type-dot type-${escHtml(result.type)}"></span>
            <a href="${result.url}" class="result-title">${escHtml(result.title)}</a>
            <span class="result-type-label">${prettyType(result.type)}</span>
            <span class="chip ${statusTone(result.freshness)}" style="margin-left:auto;">${escHtml(result.freshness)}</span>
            ${result.load_bearing ? `<span class="chip critical">load-bearing</span>` : ""}
          </div>
          <p class="result-summary">${escHtml(result.summary || "")}</p>
          <div class="result-actions">
            <a href="${result.url}" class="result-action-link">Open →</a>
            ${['module','parent-module'].includes(result.type) ? `<a href="/graph?mode=focus&module=${encodePath(result.key)}" class="result-action-link">Neighborhood</a><a href="/graph?mode=impact&module=${encodePath(result.key)}" class="result-action-link">Impact</a>` : ''}
            ${result.type === 'flow' ? `<a href="/graph?mode=flow&flow=${encodePath(result.key)}" class="result-action-link">Flow overlay</a>` : ''}
            ${result.type === 'evidence' ? `<a href="${evidenceHref(result.entity_id || result.id)}" class="result-action-link">Audit evidence</a>` : ''}
          </div>
        </div>
      `).join("")}
  ` : `
    ${renderPageHero({
      eyebrow: "Search",
      title: "Query the map by task, not file path.",
      lede: "The same ranking model powers human search and agent retrieval. Search for modules, flows, conventions, domain concepts, layers, or impact questions from one surface.",
      breadcrumbs: [{ label: "Dashboard", href: "/" }, { label: "Search" }]
    })}
    <form action="/search" method="get" class="query-bar">
      <input name="q" placeholder="Find module, flow, rule, layer..." />
      <button class="button" type="submit">Search</button>
    </form>
    <div class="search-suggestions">
      <div class="search-suggestion-label">Try a query</div>
      <a href="/search?q=auth+middleware" class="search-suggestion-row">auth middleware <span class="muted">— direct lookup</span></a>
      <a href="/search?q=what+breaks+if+session+changes" class="search-suggestion-row">what breaks if session changes <span class="muted">— impact query</span></a>
      <a href="/search?q=where+is+rate+limiting+enforced" class="search-suggestion-row">where is rate limiting enforced <span class="muted">— rule discovery</span></a>
      <a href="/search?q=checkout+flow" class="search-suggestion-row">checkout flow <span class="muted">— flow lookup</span></a>
    </div>
  `;

  const rail = `
    <div class="rail-surface">
      <h3>Search modes</h3>
      <ul class="rail-list">
        <li><strong>Lookup</strong>: module or flow by name</li>
        <li><strong>Impact</strong>: blast radius and risky change queries</li>
        <li><strong>Rules</strong>: conventions, invariants, enforcement points</li>
        <li><strong>Structure</strong>: layers, domains, related facts</li>
      </ul>
    </div>
  `;

  return appShell({
    title: trimmed ? `Search · ${trimmed}` : "Search",
    currentPath: "/search",
    content,
    rail
  });
}

function buildModuleRail(module) {
  const evidenceCount = (snapshot.evidence?.byEntityId?.[`module:${module.key}`] || []).length;
  return `
    <div class="rail-surface">
      <h3>${escHtml(module.name)}</h3>
      <div class="chip-row">
        <span class="chip ${statusTone(module.freshness.status)}">${escHtml(module.freshness.status)}</span>
        ${module.load_bearing ? `<span class="chip critical">load-bearing</span>` : ""}
        ${module.layer ? `<a class="chip" href="${layerHref(module.layer)}">${escHtml(module.layer.name)}</a>` : ""}
      </div>
      <ul class="rail-list" style="margin-top:12px;">
        <li>fan-in ${module.stats.fan_in}</li>
        <li>fan-out ${module.stats.fan_out}</li>
        <li>${module.stats.file_count} files</li>
      </ul>
      <div class="button-row">
        <a class="button" href="/graph?mode=focus&module=${encodePath(module.key)}">Neighborhood</a>
        <a class="button secondary" href="/graph?mode=impact&module=${encodePath(module.key)}">Impact</a>
        ${evidenceCount > 0 ? `<a class="button secondary" href="${evidenceHref(`module:${module.key}`)}">Evidence</a>` : ""}
      </div>
    </div>
    <div class="rail-surface">
      <h3>Related flows</h3>
      <ul class="rail-list">
        ${module.related_flows.length > 0
          ? module.related_flows.slice(0, 8).map(flow => `<li><a href="${flowHref(flow.name)}">${escHtml(flow.title)}</a></li>`).join("")
          : `<li>No flows recorded.</li>`}
      </ul>
    </div>
    <div class="rail-surface">
      <h3>Provenance</h3>
      <ul class="rail-list">
        <li>${evidenceCount} evidence records</li>
        <li><code>modules/${escHtml(module.key)}.json</code></li>
      </ul>
    </div>
    <div class="rail-surface">
      <h3>System facts</h3>
      <ul class="rail-list">
        ${module.system_facts.length > 0
          ? module.system_facts.slice(0, 8).map(fact => `<li><a href="${factHref(fact)}">${escHtml(fact.title)}</a></li>`).join("")
          : `<li>No linked facts recorded.</li>`}
      </ul>
    </div>
  `;
}

function buildFlowRail(flow) {
  const evidenceCount = (snapshot.evidence?.byEntityId?.[`flow:${flow.name}`] || []).length;
  return `
    <div class="rail-surface">
      <h3>${escHtml(flow.title)}</h3>
      <div class="chip-row">
        <span class="chip ${statusTone(flow.freshness.status)}">${escHtml(flow.freshness.status)}</span>
        <span class="chip">${flow.module_keys.length} modules</span>
      </div>
      <div class="button-row">
        <a class="button" href="/graph?mode=flow&flow=${encodePath(flow.name)}">Flow overlay</a>
        ${evidenceCount > 0 ? `<a class="button secondary" href="${evidenceHref(`flow:${flow.name}`)}">Evidence</a>` : ""}
      </div>
    </div>
    <div class="rail-surface">
      <h3>Provenance</h3>
      <ul class="rail-list">
        <li>${evidenceCount} evidence records</li>
        <li><code>flows/${escHtml(flow.name)}.json</code></li>
      </ul>
    </div>
    <div class="rail-surface">
      <h3>Touched modules</h3>
      <ul class="rail-list">
        ${flow.module_keys.map(moduleKey => `<li><a href="${moduleHref(moduleKey)}">${escHtml(snapshot.modules.byKey[moduleKey]?.name || moduleKey)}</a></li>`).join("")}
      </ul>
    </div>
  `;
}

function buildFactRail(fact) {
  const evidenceCount = (snapshot.evidence?.byEntityId?.[`fact:${fact.id}`] || []).length;
  return `
    <div class="rail-surface">
      <h3>${escHtml(fact.title)}</h3>
      <div class="chip-row">
        <span class="chip">${escHtml(fact.kind)}</span>
        <span class="chip">${escHtml(fact.scope || "system")}</span>
        <span class="chip">${evidenceCount} evidence</span>
      </div>
    </div>
    <div class="rail-surface">
      <h3>Provenance</h3>
      <ul class="rail-list">
        <li><code>system.json</code></li>
        <li>${evidenceCount} evidence records</li>
      </ul>
    </div>
    <div class="rail-surface">
      <h3>Related modules</h3>
      <ul class="rail-list">
        ${fact.module_keys.length > 0
          ? fact.module_keys.map(moduleKey => `<li><a href="${moduleHref(moduleKey)}">${escHtml(snapshot.modules.byKey[moduleKey]?.name || moduleKey)}</a></li>`).join("")
          : `<li>No modules linked.</li>`}
      </ul>
    </div>
  `;
}

function buildCollectionRail(title, moduleKeys = []) {
  return `
    <div class="rail-surface">
      <h3>${escHtml(title)}</h3>
      <ul class="rail-list">
        ${moduleKeys.length > 0
          ? moduleKeys.slice(0, 12).map(moduleKey => `<li><a href="${moduleHref(moduleKey)}">${escHtml(snapshot.modules.byKey[moduleKey]?.name || moduleKey)}</a></li>`).join("")
          : `<li>No modules linked.</li>`}
      </ul>
    </div>
  `;
}

function buildTocRail(headings) {
  if (!headings || headings.length === 0) return "";
  return `
    <div class="rail-surface">
      <h3>On this page</h3>
      <ul class="rail-list">
        ${headings.map(item => `<li style="padding-left:${Math.max(0, item.level - 2) * 12}px;"><a href="#${item.id}">${escHtml(item.text)}</a></li>`).join("")}
      </ul>
    </div>
  `;
}

function mergeRails(...parts) {
  return parts.filter(Boolean).join("");
}

function renderCatalogCard({ href, title, summary, chips = [], actions = [] }) {
  return `
    <div class="directory-item">
      <h3><a href="${href}">${escHtml(title)}</a></h3>
      <p class="muted">${escHtml(summary || "No summary recorded.")}</p>
      ${chips.length > 0 ? `<div class="directory-meta">${chips.map(chip => chip.href
        ? `<a class="chip ${escHtml(chip.tone || "")}" href="${chip.href}">${escHtml(chip.label)}</a>`
        : `<span class="chip ${escHtml(chip.tone || "")}">${escHtml(chip.label)}</span>`).join("")}</div>` : ""}
      ${actions.length > 0 ? `<div class="button-row">${actions.map(action => `<a class="button${action.secondary ? " secondary" : ""}" href="${action.href}">${escHtml(action.label)}</a>`).join("")}</div>` : ""}
    </div>
  `;
}

function filterCollection(items, query, fields) {
  const trimmed = String(query || "").trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter(item => fields.some(field => String(field(item) || "").toLowerCase().includes(trimmed)));
}

function modulePressureScore(module) {
  let score = 0;
  if (module.load_bearing) score += 40;
  if (module.freshness.status === "stale") score += 14;
  if (module.freshness.status === "queued") score += 10;
  score += Math.min(30, Number(module.stats.fan_in || 0));
  score += Math.min(18, Number((module.related_flows || []).length) * 3);
  score += Math.min(14, Number((module.dependents || []).length));
  return score;
}

function renderCatalogPage(pathname, urlObj) {
  const query = urlObj.searchParams.get("q") || "";
  const baseBreadcrumbs = [
    { label: "Dashboard", href: "/" },
    { label: "Catalog", href: "/catalog" }
  ];

  if (pathname === "/catalog") {
    const content = `
      ${renderPageHero({
        eyebrow: "Catalog",
        title: "Browse the map without already knowing the right query.",
        lede: "Search is for intent. Catalog is for orientation. Browse modules, flows, facts, domains, and layers through stable navigation surfaces that still work on large maps.",
        breadcrumbs: [{ label: "Dashboard", href: "/" }, { label: "Catalog" }],
        actions: [
          { label: "Browse modules", href: "/catalog/modules" },
          { label: "Browse flows", href: "/catalog/flows", secondary: true }
        ]
      })}
      <div class="directory-grid two">
        ${renderCatalogCard({
          href: "/catalog/modules",
          title: "Modules",
          summary: `${snapshot.modules.items.length} modules and parent modules, with load-bearing and freshness cues.`,
          chips: [
            { label: `${snapshot.modules.items.filter(module => module.load_bearing).length} load-bearing`, tone: "critical" },
            { label: `${snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).length} stale or queued`, tone: "warn" }
          ],
          actions: [{ label: "Open", href: "/catalog/modules" }]
        })}
        ${renderCatalogCard({
          href: "/catalog/flows",
          title: "Flows",
          summary: `${snapshot.flows.items.length} execution narratives with overlay entry points into the graph.`,
          chips: [{ label: `${snapshot.flows.items.length} total` }],
          actions: [{ label: "Open", href: "/catalog/flows" }]
        })}
        ${renderCatalogCard({
          href: "/catalog/facts",
          title: "Facts",
          summary: `${snapshot.system.facts.length} synthesized rules, decisions, notes, and conventions.`,
          chips: [{ label: `${new Set(snapshot.system.facts.map(item => item.kind)).size} kinds` }],
          actions: [{ label: "Open", href: "/catalog/facts" }]
        })}
        ${renderCatalogCard({
          href: "/catalog/domains",
          title: "Domains",
          summary: `${snapshot.system.collections.domains.length} domain slices for concept-first exploration.`,
          chips: [{ label: `${snapshot.system.collections.domains.length} domains` }],
          actions: [{ label: "Open", href: "/catalog/domains" }]
        })}
        ${renderCatalogCard({
          href: "/catalog/layers",
          title: "Layers",
          summary: `${snapshot.system.collections.layers.length} architecture layers with mapped modules.`,
          chips: [{ label: `${snapshot.system.collections.layers.length} layers` }],
          actions: [{ label: "Open", href: "/catalog/layers" }]
        })}
        ${renderCatalogCard({
          href: "/catalog/watchlist",
          title: "Watchlist",
          summary: "High-fan-in and stale surfaces worth reviewing first.",
          chips: [
            { label: `${snapshot.modules.items.filter(module => module.load_bearing).length} critical`, tone: "critical" },
            { label: `${snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).length} stale`, tone: "warn" }
          ],
          actions: [{ label: "Open", href: "/catalog/watchlist" }]
        })}
        ${renderCatalogCard({
          href: "/evidence",
          title: "Evidence",
          summary: `${(snapshot.evidence?.items || []).length} audit records showing which artifacts and source locations support the map.`,
          chips: [
            { label: `${(snapshot.evidence?.entities || []).length} entities` },
            { label: `${(snapshot.evidence?.artifacts || []).length} artifacts` }
          ],
          actions: [{ label: "Open", href: "/evidence" }]
        })}
      </div>
    `;

    const rail = `
      <div class="rail-surface">
        <h3>Browse strategy</h3>
        <ul class="rail-list">
          <li>Use catalog when you want system shape before a narrow query.</li>
          <li>Use search when you already know the task, rule, or concept.</li>
          <li>Use graph when you need adjacency, blast radius, or paths.</li>
          <li>Use evidence when you need to audit where a claim came from.</li>
        </ul>
      </div>
    `;

    return appShell({
      title: "Catalog",
      currentPath: "/catalog",
      content,
      rail
    });
  }

  const queryBar = `
    <form action="${pathname}" method="get" class="query-bar">
      <input name="q" value="${escHtml(query)}" placeholder="Filter this catalog surface" />
      <button class="button" type="submit">Filter</button>
    </form>
  `;

  if (pathname === "/catalog/modules" || pathname === "/catalog/watchlist") {
    const sourceItems = pathname === "/catalog/watchlist"
      ? snapshot.modules.items
          .map(module => ({ ...module, pressureScore: modulePressureScore(module) }))
          .filter(module => module.pressureScore >= 20)
      : snapshot.modules.items;
    const filtered = filterCollection(sourceItems, query, [
      module => module.key,
      module => module.name,
      module => module.purpose,
      module => module.layer?.name,
      module => module.related_flows.map(flow => flow.title).join(" ")
    ]).sort((left, right) => {
      const pressureDelta = Number(right.pressureScore || 0) - Number(left.pressureScore || 0);
      if (pressureDelta !== 0) return pressureDelta;
      return right.stats.fan_in - left.stats.fan_in || left.name.localeCompare(right.name);
    });
    const visible = filtered.slice(0, 180);
    const content = `
      ${renderPageHero({
        eyebrow: pathname === "/catalog/watchlist" ? "Watchlist" : "Modules",
        title: pathname === "/catalog/watchlist" ? "Start with the modules that can hurt you." : "Browse modules by purpose, pressure, and position.",
        lede: pathname === "/catalog/watchlist"
          ? "This surface ranks modules by operational pressure so review effort lands on risky places first instead of simply listing everything marked stale."
          : "This directory is intentionally browseable, not just searchable. Use it to scan large maps by fan-in, freshness, layer, and connected flows.",
        breadcrumbs: [...baseBreadcrumbs, { label: pathname === "/catalog/watchlist" ? "Watchlist" : "Modules" }],
        chips: [
          { label: `${filtered.length} matches` },
          { label: `${snapshot.modules.items.filter(module => module.load_bearing).length} load-bearing`, tone: "warn" }
        ],
        actions: [
          { label: "Search by intent", href: "/search?q=what+breaks+if+session+changes" },
          { label: "Open graph", href: "/graph", secondary: true }
        ]
      })}
      ${queryBar}
      ${visible.length === 0 ? `<div class="directory-empty">No modules match this filter.</div>` : `<div class="module-list">
        <div class="module-list-header">
          <span>Module</span>
          <span>Kind</span>
          <span>Status</span>
          <span>Fan-in</span>
          <span>Flows</span>
          <span></span>
        </div>
        ${visible.map(module => `
          <div class="module-list-row">
            <div class="module-list-name">
              <a href="${moduleHref(module.key)}">${escHtml(module.name)}</a>
              ${module.load_bearing ? `<span class="chip critical" style="margin-left:6px;">load-bearing</span>` : ""}
              ${module.layer ? `<span class="chip" style="margin-left:4px;">${escHtml(module.layer.name)}</span>` : ""}
              ${pathname === "/catalog/watchlist" ? `<span class="chip warn" style="margin-left:4px;">pressure ${module.pressureScore}</span>` : ""}
            </div>
            <span class="muted" style="font-size:0.8rem;">${module.kind === "parent" ? "parent" : "module"}</span>
            <span class="chip ${statusTone(module.freshness.status)}">${escHtml(module.freshness.status)}</span>
            <span class="muted" style="font-size:0.82rem;">${module.stats.fan_in}</span>
            <span class="muted" style="font-size:0.82rem;">${module.related_flows.length}</span>
            <div style="display:flex;gap:6px;">
              <a class="result-action-link" href="${moduleHref(module.key)}">Open →</a>
              <a class="result-action-link" href="/graph?mode=focus&module=${encodePath(module.key)}">Graph</a>
            </div>
          </div>
        `).join("")}
      </div>`}
      ${filtered.length > visible.length ? `<p class="muted">Showing ${visible.length} of ${filtered.length} matches. Add a filter to narrow further.</p>` : ""}
    `;

    const rail = `
      <div class="rail-surface">
        <h3>Module directory</h3>
        <ul class="rail-list">
          <li>${snapshot.modules.items.length} total modules</li>
          <li>${snapshot.modules.items.filter(module => module.kind === "parent").length} parent modules</li>
          <li>${snapshot.modules.items.filter(module => ["stale", "queued"].includes(module.freshness.status)).length} stale or queued</li>
          ${pathname === "/catalog/watchlist" ? `<li>${filtered.length} pressure-ranked watchlist entries</li>` : ""}
        </ul>
      </div>
    `;

    return appShell({
      title: pathname === "/catalog/watchlist" ? "Watchlist" : "Module Catalog",
      currentPath: "/catalog",
      content,
      rail,
      fullWidth: true
    });
  }

  if (pathname === "/catalog/flows") {
    const filtered = filterCollection(snapshot.flows.items, query, [
      flow => flow.name,
      flow => flow.title,
      flow => flow.summary,
      flow => flow.module_keys.join(" ")
    ]);
    const content = `
      ${renderPageHero({
        eyebrow: "Flows",
        title: "Browse execution narratives, not just module nodes.",
        lede: "Flows are where system intent becomes visible. Use this directory to move from business behavior into touched modules and graph overlays.",
        breadcrumbs: [...baseBreadcrumbs, { label: "Flows" }],
        chips: [{ label: `${filtered.length} matches` }],
        actions: [
          { label: "Open graph overlays", href: "/graph?mode=flow" },
          { label: "Search flows", href: "/search?q=checkout+flow", secondary: true }
        ]
      })}
      ${queryBar}
      ${filtered.length === 0 ? `<div class="directory-empty">No flows match this filter.</div>` : `<div class="directory-grid">
        ${filtered.map(flow => renderCatalogCard({
          href: flowHref(flow.name),
          title: flow.title,
          summary: flow.summary,
          chips: [
            { label: flow.freshness.status, tone: statusTone(flow.freshness.status) },
            { label: `${flow.module_keys.length} modules` },
            { label: `confidence ${flow.confidence}` }
          ],
          actions: [
            { label: "Open page", href: flowHref(flow.name) },
            { label: "Flow overlay", href: `/graph?mode=flow&flow=${encodePath(flow.name)}`, secondary: true }
          ]
        })).join("")}
      </div>`}
    `;

    return appShell({
      title: "Flow Catalog",
      currentPath: "/catalog",
      content,
      fullWidth: true
    });
  }

  if (pathname === "/catalog/facts") {
    const filtered = filterCollection(snapshot.system.facts, query, [
      fact => fact.title,
      fact => fact.detail,
      fact => fact.kind,
      fact => fact.scope
    ]);
    const content = `
      ${renderPageHero({
        eyebrow: "Facts",
        title: "Browse system rules, decisions, notes, and conventions.",
        lede: "This surface is for evidence-led exploration. Start from a stated rule or architectural fact, then pivot to the modules and flows it touches.",
        breadcrumbs: [...baseBreadcrumbs, { label: "Facts" }],
        chips: [{ label: `${filtered.length} matches` }],
        actions: [{ label: "Rule search", href: "/search?q=where+is+rate+limiting+enforced" }]
      })}
      ${queryBar}
      ${filtered.length === 0 ? `<div class="directory-empty">No facts match this filter.</div>` : `<div class="directory-grid">
        ${filtered.map(fact => renderCatalogCard({
          href: factHref(fact),
          title: fact.title,
          summary: fact.detail,
          chips: [
            { label: fact.kind },
            { label: fact.scope || "system" },
            { label: `${fact.module_keys.length} modules` }
          ],
          actions: [
            { label: "Open fact", href: factHref(fact) },
            ...(fact.module_keys[0] ? [{ label: "Open module", href: moduleHref(fact.module_keys[0]), secondary: true }] : [])
          ]
        })).join("")}
      </div>`}
    `;

    return appShell({
      title: "Fact Catalog",
      currentPath: "/catalog",
      content,
      fullWidth: true
    });
  }

  if (pathname === "/catalog/domains" || pathname === "/catalog/layers") {
    const isDomain = pathname === "/catalog/domains";
    const sourceItems = isDomain ? snapshot.system.collections.domains : snapshot.system.collections.layers;
    const filtered = filterCollection(sourceItems, query, [
      item => item.name,
      item => item.description || item.role || "",
      item => item.module_keys.join(" ")
    ]);
    const content = `
      ${renderPageHero({
        eyebrow: isDomain ? "Domains" : "Layers",
        title: isDomain ? "Browse the system by bounded problem space." : "Browse the system by architecture position.",
        lede: isDomain
          ? "Domains help you reason concept-first. They are the fastest way to answer where a business capability lives."
          : "Layers help you reason structurally. They show how the system is partitioned across API, service, data, and support surfaces.",
        breadcrumbs: [...baseBreadcrumbs, { label: isDomain ? "Domains" : "Layers" }],
        chips: [{ label: `${filtered.length} matches` }],
        actions: [{ label: "Open overview", href: "/overview" }]
      })}
      ${queryBar}
      ${filtered.length === 0 ? `<div class="directory-empty">No ${isDomain ? "domains" : "layers"} match this filter.</div>` : `<div class="directory-grid">
        ${filtered.map(item => renderCatalogCard({
          href: isDomain ? domainHref(item) : layerHref(item),
          title: item.name,
          summary: item.description || item.role || "",
          chips: [{ label: `${item.module_keys.length} modules` }],
          actions: [{ label: "Open page", href: isDomain ? domainHref(item) : layerHref(item) }]
        })).join("")}
      </div>`}
    `;

    return appShell({
      title: isDomain ? "Domain Catalog" : "Layer Catalog",
      currentPath: "/catalog",
      content,
      fullWidth: true
    });
  }

  return renderNotFound(pathname);
}

function renderEvidenceRecordCard(record) {
  const location = record.file
    ? `${record.file}${record.line != null ? `:${record.line}` : ""}`
    : "";

  return `
    <div class="directory-item evidence-card" data-kind="${escHtml(record.entity_type?.replace(/-.*/, "") || "system")}">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
        ${record.freshness ? `<span class="chip ${statusTone(record.freshness)}">${escHtml(record.freshness)}</span>` : ""}
        <span class="chip">${escHtml(record.claim_type.replace(/_/g, " "))}</span>
      </div>
      <div style="font-weight:600;font-size:0.88rem;margin-bottom:4px;"><a href="${record.entity_url}">${escHtml(record.entity_title)}</a></div>
      <p class="muted" style="margin:0 0 8px;font-size:0.83rem;">${escHtml(record.claim)}</p>
      ${record.detail ? `<p class="muted" style="margin:0 0 8px;font-size:0.8rem;">${escHtml(record.detail)}</p>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${location ? `<span style="font-family:var(--mono);font-size:0.75rem;color:var(--ink-soft);">${escHtml(location)}</span>` : ""}
        <span class="chip">${escHtml(record.artifact_path)}</span>
        <a class="result-action-link" href="${record.entity_url}" style="margin-left:auto;">Open →</a>
      </div>
    </div>
  `;
}

function renderEvidencePage(urlObj) {
  const entityId = String(urlObj.searchParams.get("entity") || "").trim();
  const query = String(urlObj.searchParams.get("q") || "").trim().toLowerCase();
  const allItems = snapshot.evidence?.items || [];
  const entityItems = entityId ? (snapshot.evidence?.byEntityId?.[entityId] || []) : allItems;
  const filteredItems = query
    ? entityItems.filter(item => [item.entity_title, item.claim, item.detail, item.artifact_path, item.file, item.claim_type, item.evidence_kind]
        .some(value => String(value || "").toLowerCase().includes(query)))
    : entityItems;
  const visibleItems = filteredItems.slice(0, 120);
  let entitySummary = entityId ? (snapshot.evidence?.entities || []).find(item => item.entity_id === entityId) : null;
  if (!entitySummary && entityId.startsWith("module:")) {
    const moduleKey = entityId.slice("module:".length);
    const module = snapshot.modules.byKey[moduleKey];
    if (module) {
      entitySummary = {
        entity_id: entityId,
        entity_title: module.name,
        entity_type: module.kind === "parent" ? "parent-module" : "module",
        entity_url: moduleHref(module.key),
        artifact_paths: [`modules/${module.key}.json`],
        files: module.files || []
      };
    }
  }
  if (!entitySummary && entityId.startsWith("flow:")) {
    const flowKey = entityId.slice("flow:".length);
    const flow = snapshot.flows.byName[flowKey];
    if (flow) {
      entitySummary = {
        entity_id: entityId,
        entity_title: flow.title,
        entity_type: "flow",
        entity_url: flowHref(flow.name),
        artifact_paths: [`flows/${flow.name}.json`],
        files: unique((flow.steps || []).map(step => step.file))
      };
    }
  }
  if (!entitySummary && entityId.startsWith("fact:")) {
    const factKey = entityId.slice("fact:".length);
    const fact = snapshot.system.facts.find(item => item.id === factKey);
    if (fact) {
      entitySummary = {
        entity_id: entityId,
        entity_title: fact.title,
        entity_type: "system-fact",
        entity_url: factHref(fact),
        artifact_paths: ["system.json"],
        files: []
      };
    }
  }

  const topEntities = (snapshot.evidence?.entities || []).slice(0, 18);
  const topArtifacts = (snapshot.evidence?.artifacts || []).slice(0, 18);
  const content = entityId ? `
    ${renderPageHero({
      eyebrow: "Evidence",
      title: entitySummary?.entity_title || entityId,
      lede: "This surface shows the artifact and source references behind the current entity so claims can be audited instead of merely trusted.",
      breadcrumbs: [
        { label: "Dashboard", href: "/" },
        { label: "Evidence", href: "/evidence" },
        { label: entitySummary?.entity_title || entityId }
      ],
      chips: [
        { label: `${filteredItems.length} records` },
        { label: `${entitySummary?.artifact_paths?.length || 0} artifacts` },
        { label: `${entitySummary?.files?.length || 0} files` }
      ],
      actions: [
        entitySummary?.entity_url ? { label: "Open entity", href: entitySummary.entity_url } : null
      ].filter(Boolean)
    })}
    <form action="/evidence" method="get" class="query-bar">
      <input type="hidden" name="entity" value="${escHtml(entityId)}" />
      <input name="q" value="${escHtml(query)}" placeholder="Filter evidence by claim, file, or artifact" />
      <button class="button" type="submit">Filter</button>
    </form>
    ${visibleItems.length === 0 ? `<div class="directory-empty">No evidence matches this filter.</div>` : `<div class="directory-grid">
      ${visibleItems.map(renderEvidenceRecordCard).join("")}
    </div>`}
    ${filteredItems.length > visibleItems.length ? `<p class="muted">Showing ${visibleItems.length} of ${filteredItems.length} evidence records. Filter further to narrow the audit surface.</p>` : ""}
  ` : `
    ${renderPageHero({
      eyebrow: "Evidence Explorer",
      title: "Audit where Sonar's claims come from.",
      lede: "This is the trust surface for the workspace. It exposes which module cards, flow cards, synthesis artifacts, and source references support the current map.",
      breadcrumbs: [{ label: "Dashboard", href: "/" }, { label: "Evidence" }],
      chips: [
        { label: `${allItems.length} records` },
        { label: `${(snapshot.evidence?.entities || []).length} entities` },
        { label: `${(snapshot.evidence?.artifacts || []).length} artifacts` }
      ]
    })}
    <form action="/evidence" method="get" class="query-bar">
      <input name="q" value="${escHtml(query)}" placeholder="Search evidence by entity, claim, file, or artifact" />
      <button class="button" type="submit">Filter</button>
    </form>
    <div class="module-list">
      <div class="module-list-header" style="grid-template-columns: 1fr 100px 80px 80px 120px;">
        <span>Entity</span>
        <span>Type</span>
        <span>Records</span>
        <span>Artifacts</span>
        <span></span>
      </div>
      ${topEntities.map(item => `
        <div class="module-list-row" style="grid-template-columns: 1fr 100px 80px 80px 120px;">
          <div class="module-list-name">
            <a href="${evidenceHref(item.entity_id)}">${escHtml(item.entity_title)}</a>
          </div>
          <span class="chip">${escHtml(item.entity_type)}</span>
          <span class="muted" style="font-size:0.82rem;">${item.count}</span>
          <span class="muted" style="font-size:0.82rem;">${item.artifact_paths.length}</span>
          <div style="display:flex;gap:8px;">
            <a class="result-action-link" href="${evidenceHref(item.entity_id)}">Evidence →</a>
            <a class="result-action-link" href="${item.entity_url}">Entity</a>
          </div>
        </div>
      `).join("")}
    </div>
    <h2>Top source artifacts</h2>
    <div class="module-list" style="margin-top:12px;">
      <div class="module-list-header" style="grid-template-columns: 1fr 80px 80px;">
        <span>Artifact</span><span>Records</span><span>Entities</span>
      </div>
      ${topArtifacts.map(item => `
        <div class="module-list-row" style="grid-template-columns: 1fr 80px 80px;">
          <span style="font-family:var(--mono);font-size:0.8rem;">${escHtml(item.artifact_path)}</span>
          <span class="muted" style="font-size:0.82rem;">${item.count}</span>
          <span class="muted" style="font-size:0.82rem;">${item.entity_ids.length}</span>
        </div>
      `).join("")}
    </div>
  `;

  const rail = entityId ? `
    <div class="rail-surface">
      <h3>Audit tips</h3>
      <ul class="rail-list">
        <li>Use artifact paths to confirm which Sonar file asserted the claim.</li>
        <li>Use file locations to jump from the synthesized view back toward code.</li>
        <li>If evidence is thin, that is a content-quality problem, not a UI problem.</li>
      </ul>
    </div>
  ` : `
    <div class="rail-surface">
      <h3>Explorer scope</h3>
      <ul class="rail-list">
        <li>${allItems.length} total evidence records</li>
        <li>${(snapshot.evidence?.entities || []).length} evidence-backed entities</li>
        <li>${(snapshot.evidence?.artifacts || []).length} artifacts</li>
      </ul>
    </div>
  `;

  return appShell({
    title: entityId ? `Evidence · ${entitySummary?.entity_title || entityId}` : "Evidence Explorer",
    currentPath: "/evidence",
    content,
    rail
  });
}

function renderMarkdownPage({ relPath, title, currentPath, rail, hero = "" }) {
  const markdown = readMarkdown(relPath);
  if (!markdown) return renderNotFound(currentPath);
  const normalized = stripLeadingTitle(markdown, title);
  const headings = extractHeadings(normalized);
  return appShell({
    title,
    currentPath,
    content: `${hero}${md(normalized)}`,
    rail: mergeRails(rail, buildTocRail(headings))
  });
}

function renderGraphPage(urlObj) {
  const mode = urlObj.searchParams.get("mode") || "overview";
  const moduleKey = urlObj.searchParams.get("module") || "";
  const flowName = urlObj.searchParams.get("flow") || "";
  const from = urlObj.searchParams.get("from") || "";
  const to = urlObj.searchParams.get("to") || "";
  const initialGraph = buildGraphView(snapshot, {
    mode,
    module: moduleKey,
    flow: flowName,
    from,
    to
  });

  const moduleOptions = snapshot.modules.items.map(module => ({ key: module.key, label: module.name }));
  const flowOptions = snapshot.flows.items.map(flow => ({ key: flow.name, label: flow.title }));
  const detailLookup = {
    modules: Object.fromEntries(snapshot.modules.items.map(module => [module.key, {
      type: "module",
      title: module.name,
      summary: module.purpose || module.description || "",
      freshness: module.freshness.status,
      loadBearing: module.load_bearing,
      fanIn: module.stats.fan_in,
      fanOut: module.stats.fan_out,
      fileCount: module.stats.file_count,
      href: moduleHref(module.key),
      focusHref: `/graph?mode=focus&module=${encodePath(module.key)}`,
      impactHref: `/graph?mode=impact&module=${encodePath(module.key)}`
    }])),
    layers: Object.fromEntries(snapshot.system.collections.layers.map(layer => [layer.id, {
      type: "layer",
      title: layer.name,
      summary: layer.role || "",
      freshness: "fresh",
      loadBearing: false,
      fanIn: layer.module_keys.length,
      fanOut: 0,
      fileCount: layer.module_keys.length,
      href: layerHref(layer)
    }]))
  };

  const content = `
    <div class="eyebrow">Graph Workspace</div>
    <h1>Explore the dependency graph.</h1>

    <div class="graph-controls">
      <div class="mode-tabs">
        <button class="mode-tab ${mode === 'overview' ? 'active' : ''}" data-mode="overview">Architecture</button>
        <button class="mode-tab ${(mode === 'focus' || mode === 'impact') ? 'active' : ''}" data-mode="focus">Neighborhood</button>
        <button class="mode-tab ${mode === 'flow' ? 'active' : ''}" data-mode="flow">Flow</button>
        <button class="mode-tab ${mode === 'path' ? 'active' : ''}" data-mode="path">Path</button>
      </div>
      <div class="graph-params" id="graph-params">
        <div class="graph-param" id="param-module" style="${['focus','impact'].includes(mode) ? '' : 'display:none'}">
          <input id="module" list="module-list" placeholder="Search module…" value="${escHtml(moduleKey)}" style="width:100%">
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="mode-tab ${mode === 'focus' ? 'active' : ''}" data-submode="focus" style="flex:1;font-size:0.75rem;">Neighborhood</button>
            <button class="mode-tab ${mode === 'impact' ? 'active' : ''}" data-submode="impact" style="flex:1;font-size:0.75rem;">Impact</button>
          </div>
        </div>
        <div class="graph-param" id="param-flow" style="${mode === 'flow' ? '' : 'display:none'}">
          <input id="flow" list="flow-list" placeholder="Search flow…" value="${escHtml(flowName)}" style="width:100%">
        </div>
        <div class="graph-param" id="param-path" style="${mode === 'path' ? '' : 'display:none'}">
          <input id="from" list="module-list" placeholder="From module…" value="${escHtml(from)}" style="width:100%">
          <input id="to" list="module-list" placeholder="To module…" value="${escHtml(to)}" style="width:100%;margin-top:6px;">
        </div>
        <button id="apply-graph" type="button" class="button" style="margin-top:8px;width:100%;">Apply</button>
      </div>
    </div>

    <datalist id="module-list">
      ${moduleOptions.map(module => `<option value="${escHtml(module.key)}">${escHtml(module.label)}</option>`).join("")}
    </datalist>
    <datalist id="flow-list">
      ${flowOptions.map(flow => `<option value="${escHtml(flow.key)}">${escHtml(flow.label)}</option>`).join("")}
    </datalist>

    <div class="graph-layout">
      <div class="graph-stage"><div id="graph"></div></div>
      <div class="graph-sidebar">
        <div class="graph-card">
          <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);margin-bottom:8px;" id="graph-title">${escHtml(initialGraph.title)}</div>
          <div class="chip-row">
            <span class="chip" id="graph-node-count">${initialGraph.nodes.length} nodes</span>
            <span class="chip" id="graph-edge-count">${initialGraph.edges.length} edges</span>
          </div>
          <p class="muted" style="margin-top:10px;font-size:0.78rem;">Click a node to inspect. Double-click to open its page.</p>
        </div>
        <div class="graph-card" id="selection-card">
          <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);margin-bottom:8px;">Selection</div>
          <div id="graph-details" class="muted" style="font-size:0.82rem;">Nothing selected yet.</div>
        </div>
        <div class="graph-card">
          <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);margin-bottom:8px;">Legend</div>
          <div style="display:flex;flex-direction:column;gap:6px;font-size:0.78rem;">
            <div><span class="chip ok" style="margin-right:6px;">fresh</span>ready to trust</div>
            <div><span class="chip warn" style="margin-right:6px;">stale</span>needs review</div>
            <div><span class="chip critical" style="margin-right:6px;">load-bearing</span>high fan-in</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const extraHead = `<script src="/assets/vis-network.min.js"></script>`;
  const extraScript = `<script>
    const DETAIL_LOOKUP = ${JSON.stringify(detailLookup)};
    let graphState = ${JSON.stringify(initialGraph)};
    const graphEl = document.getElementById("graph");
    const titleEl = document.getElementById("graph-title");
    const nodeCountEl = document.getElementById("graph-node-count");
    const edgeCountEl = document.getElementById("graph-edge-count");
    const detailsEl = document.getElementById("graph-details");

    const nodes = new vis.DataSet([]);
    const edges = new vis.DataSet([]);
    const network = new vis.Network(graphEl, { nodes, edges }, {
      physics: {
        stabilization: { enabled: true, iterations: 180, fit: true },
        barnesHut: {
          gravitationalConstant: -6800,
          centralGravity: 0.2,
          springLength: 165,
          springConstant: 0.03,
          damping: 0.11
        }
      },
      edges: {
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        smooth: { type: "dynamic" }
      },
      nodes: {
        shape: "dot",
        font: { face: "ui-sans-serif, -apple-system, sans-serif", color: "#172033" },
        borderWidth: 2
      },
      interaction: { hover: true, multiselect: false }
    });

    function nodeColor(node) {
      if (node.type === "layer") {
        return { background: "#e7eefc", border: "#3659b3" };
      }
      if (node.loadBearing) {
        return { background: "#fff1e8", border: "#d36b33" };
      }
      if (node.freshness === "stale" || node.freshness === "queued") {
        return { background: "#fff5e9", border: "#b35b1f" };
      }
      return { background: "#eef8f5", border: "#0d7c66" };
    }

    function renderGraph(view) {
      graphState = view;
      nodes.clear();
      edges.clear();
      nodes.add(view.nodes.map(node => {
        const colors = nodeColor(node);
        return {
          id: node.id,
          label: node.label,
          value: node.loadBearing ? 26 : Math.max(12, (node.fanIn || 0) + 10),
          color: colors,
          title: node.purpose || node.label
        };
      }));
      edges.add(view.edges.map((edge, index) => ({
        id: edge.id || index,
        from: edge.source,
        to: edge.target,
        label: edge.kind || "",
        font: { align: "top", size: 10 },
        width: edge.kind === "calls" ? 2 : 1,
        color: edge.kind === "calls"
          ? { color: "#3659b3", opacity: 0.55 }
          : edge.kind === "extends"
            ? { color: "#d36b33", opacity: 0.55 }
            : { color: "#172033", opacity: 0.22 }
      })));
      titleEl.textContent = view.title || "Graph";
      nodeCountEl.textContent = view.nodes.length + " nodes";
      edgeCountEl.textContent = view.edges.length + " edges";
      detailsEl.innerHTML = '<div class="muted">Nothing selected yet.</div>';
      network.fit({ animation: { duration: 350, easingFunction: "easeInOutQuad" } });
    }

    function detailRecord(nodeId) {
      return DETAIL_LOOKUP.modules[nodeId] || DETAIL_LOOKUP.layers[nodeId] || null;
    }

    function renderDetails(nodeId) {
      const detail = detailRecord(nodeId);
      if (!detail) {
        detailsEl.innerHTML = '<div class="muted">No detail recorded for this node.</div>';
        return;
      }
      detailsEl.innerHTML = [
        '<strong>' + escapeHtml(detail.title) + '</strong>',
        '<p class="muted">' + escapeHtml(detail.summary || 'No summary recorded.') + '</p>',
        '<div class="chip-row">',
        '<span class="chip ' + chipTone(detail.freshness) + '">' + escapeHtml(detail.freshness) + '</span>',
        detail.loadBearing ? '<span class="chip warn">load-bearing</span>' : '',
        '</div>',
        '<ul class="rail-list" style="margin-top:12px;">',
        '<li>fan-in ' + Number(detail.fanIn || 0) + '</li>',
        '<li>fan-out ' + Number(detail.fanOut || 0) + '</li>',
        '<li>count ' + Number(detail.fileCount || 0) + '</li>',
        '</ul>',
        detail.href ? '<div class="button-row"><a class="button" href="' + detail.href + '">Open page</a>' : '',
        detail.focusHref ? '<a class="button secondary" href="' + detail.focusHref + '">Neighborhood</a>' : '',
        detail.impactHref ? '<a class="button secondary" href="' + detail.impactHref + '">Impact</a>' : '',
        detail.href ? '</div>' : ''
      ].join('');
    }

    function chipTone(freshness) {
      if (freshness === 'fresh') return 'ok';
      if (freshness === 'stale' || freshness === 'queued') return 'warn';
      return 'muted';
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    network.on('click', params => {
      if (params.nodes.length) {
        renderDetails(params.nodes[0]);
      }
    });

    network.on('doubleClick', params => {
      if (!params.nodes.length) return;
      const detail = detailRecord(params.nodes[0]);
      if (detail && detail.href) {
        window.location.href = detail.href;
      }
    });

    let currentSubmode = '${['impact'].includes(mode) ? 'impact' : 'focus'}';

    function getActiveMode() {
      const tab = document.querySelector('.mode-tab[data-mode].active');
      const m = tab?.dataset.mode || 'overview';
      if (m === 'focus') return currentSubmode;
      return m;
    }

    function showParams(mode) {
      const isNeighbourhood = (mode === 'focus' || mode === 'impact');
      document.getElementById('param-module').style.display = isNeighbourhood ? '' : 'none';
      document.getElementById('param-flow').style.display = mode === 'flow' ? '' : 'none';
      document.getElementById('param-path').style.display = mode === 'path' ? '' : 'none';
    }

    async function refreshGraph() {
      const search = new URLSearchParams();
      const mode = getActiveMode();
      const moduleVal = document.getElementById('module')?.value.trim() || '';
      const flowVal = document.getElementById('flow')?.value.trim() || '';
      const fromVal = document.getElementById('from')?.value.trim() || '';
      const toVal = document.getElementById('to')?.value.trim() || '';

      search.set('mode', mode);
      if (moduleVal) search.set('module', moduleVal);
      if (flowVal) search.set('flow', flowVal);
      if (fromVal) search.set('from', fromVal);
      if (toVal) search.set('to', toVal);

      const response = await fetch('/api/graph?' + search.toString());
      const nextGraph = await response.json();
      history.replaceState({}, '', '/graph?' + search.toString());
      renderGraph(nextGraph);
    }

    // Main mode tabs
    document.querySelectorAll('.mode-tab[data-mode]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab[data-mode]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        showParams(tab.dataset.mode);
      });
    });

    // Submode tabs (neighbourhood vs impact)
    document.querySelectorAll('.mode-tab[data-submode]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab[data-submode]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentSubmode = tab.dataset.submode;
      });
    });

    document.getElementById('apply-graph').addEventListener('click', refreshGraph);
    renderGraph(graphState);
  </script>`;

  return appShell({
    title: "Graph Workspace",
    currentPath: "/graph",
    content,
    fullWidth: true,
    extraHead,
    extraScript
  });
}

function renderNotFound(currentPath = "") {
  return appShell({
    title: "Not Found",
    currentPath,
    content: `
      <div class="eyebrow">404</div>
      <h1>That page does not exist.</h1>
      <p class="lede">The requested wiki surface was not found in the current Sonar workspace.</p>
      <div class="button-row">
        <a class="button" href="/">Back to dashboard</a>
        <a class="button secondary" href="/search">Open search</a>
      </div>
    `,
    rail: `<div class="rail-surface"><h3>Workspace</h3><p class="muted"><code>${escHtml(SONAR_DIR)}</code></p></div>`
  });
}

function routeMarkdownPage(pathname) {
  if (pathname === "/overview") {
    return renderMarkdownPage({
      relPath: "overview.md",
      title: "Overview",
      currentPath: "/overview",
      hero: renderPageHero({
        eyebrow: "Overview",
        title: "System synthesis",
        lede: "This is the synthesized reading surface for domains, layers, facts, tensions, and overlaps present in the current snapshot.",
        breadcrumbs: [{ label: "Dashboard", href: "/" }, { label: "Overview" }],
        chips: [
          { label: `${snapshot.system.collections.domains.length} domains` },
          { label: `${snapshot.system.collections.layers.length} layers` },
          { label: `${snapshot.system.facts.length} facts` }
        ],
        actions: [
          { label: "Browse catalog", href: "/catalog" },
          { label: "Open graph", href: "/graph", secondary: true },
          { label: "Open evidence", href: "/evidence", secondary: true }
        ]
      }),
      rail: `
        <div class="rail-surface">
          <h3>System surface</h3>
          <ul class="rail-list">
            <li>${snapshot.system.collections.domains.length} domains</li>
            <li>${snapshot.system.collections.layers.length} layers</li>
            <li>${snapshot.system.facts.length} fact pages</li>
          </ul>
        </div>
      `
    });
  }

  if (pathname.startsWith("/modules/")) {
    const key = decodeURIComponent(pathname.slice("/modules/".length));
    const module = snapshot.modules.byKey[key];
    if (!module) return renderNotFound(pathname);
    const evidenceCount = (snapshot.evidence?.byEntityId?.[`module:${module.key}`] || []).length;
    return renderMarkdownPage({
      relPath: `modules/${key}.md`,
      title: module.name,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: module.kind === "parent" ? "Parent Module" : "Module",
        title: module.name,
        lede: module.purpose || module.description,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Modules", href: "/catalog/modules" },
          { label: module.name }
        ],
        chips: [
          { label: module.freshness.status, tone: statusTone(module.freshness.status) },
          ...(module.load_bearing ? [{ label: "load-bearing", tone: "warn" }] : []),
          ...(module.layer ? [{ label: module.layer.name, href: layerHref(module.layer) }] : []),
          { label: `fan-in ${module.stats.fan_in}` },
          { label: `${module.related_flows.length} flows` },
          { label: `${evidenceCount} evidence` }
        ],
        actions: [
          { label: "Neighborhood", href: `/graph?mode=focus&module=${encodePath(module.key)}` },
          { label: "Impact", href: `/graph?mode=impact&module=${encodePath(module.key)}`, secondary: true },
          ...(evidenceCount > 0 ? [{ label: "Evidence", href: evidenceHref(`module:${module.key}`), secondary: true }] : [])
        ]
      }),
      rail: buildModuleRail(module)
    });
  }

  if (pathname.startsWith("/submodules/")) {
    const key = decodeURIComponent(pathname.slice("/submodules/".length));
    const submodule = snapshot.submodules.byKey[key];
    if (!submodule) return renderNotFound(pathname);
    return renderMarkdownPage({
      relPath: `submodules/${key}.md`,
      title: submodule.cluster_name,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: "Submodule",
        title: submodule.cluster_name,
        lede: submodule.purpose || submodule.description,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Modules", href: "/catalog/modules" },
          { label: parent?.name || submodule.parent_module_key, href: parent ? moduleHref(parent.key) : undefined },
          { label: submodule.cluster_name }
        ],
        chips: [
          { label: parent?.name || submodule.parent_module_key }
        ],
        actions: [
          { label: "Open parent", href: parent ? moduleHref(parent.key) : moduleHref(submodule.parent_module_key) },
          { label: "Parent impact", href: `/graph?mode=impact&module=${encodePath(submodule.parent_module_key)}`, secondary: true },
          { label: "Parent evidence", href: evidenceHref(`module:${submodule.parent_module_key}`), secondary: true }
        ]
      }),
      rail: buildCollectionRail(submodule.cluster_name, [submodule.parent_module_key])
    });
  }

  if (pathname.startsWith("/flows/")) {
    const name = decodeURIComponent(pathname.slice("/flows/".length));
    const flow = snapshot.flows.byName[name];
    if (!flow) return renderNotFound(pathname);
    const evidenceCount = (snapshot.evidence?.byEntityId?.[`flow:${flow.name}`] || []).length;
    return renderMarkdownPage({
      relPath: `flows/${name}.md`,
      title: flow.title,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: "Flow",
        title: flow.title,
        lede: flow.summary,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Flows", href: "/catalog/flows" },
          { label: flow.title }
        ],
        chips: [
          { label: flow.freshness.status, tone: statusTone(flow.freshness.status) },
          { label: `${flow.module_keys.length} modules` },
          { label: `confidence ${flow.confidence}` },
          { label: `${evidenceCount} evidence` }
        ],
        actions: [
          { label: "Flow overlay", href: `/graph?mode=flow&flow=${encodePath(flow.name)}` },
          ...(flow.module_keys[0] ? [{ label: "Open first module", href: moduleHref(flow.module_keys[0]), secondary: true }] : []),
          ...(evidenceCount > 0 ? [{ label: "Evidence", href: evidenceHref(`flow:${flow.name}`), secondary: true }] : [])
        ]
      }),
      rail: buildFlowRail(flow)
    });
  }

  if (pathname.startsWith("/facts/")) {
    const slug = decodeURIComponent(pathname.slice("/facts/".length));
    const fact = snapshot.system.facts.find(item => item.slug === slug);
    if (!fact) return renderNotFound(pathname);
    const evidenceCount = (snapshot.evidence?.byEntityId?.[`fact:${fact.id}`] || []).length;
    return renderMarkdownPage({
      relPath: `facts/${slug}.md`,
      title: fact.title,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: "Fact",
        title: fact.title,
        lede: fact.detail,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Facts", href: "/catalog/facts" },
          { label: fact.title }
        ],
        chips: [
          { label: fact.kind },
          { label: fact.scope || "system" },
          { label: `${fact.module_keys.length} modules` },
          { label: `${evidenceCount} evidence` }
        ],
        actions: [
          ...(fact.module_keys[0] ? [{ label: "Open module", href: moduleHref(fact.module_keys[0]) }] : []),
          { label: "Search related rule", href: `/search?q=${encodePath(fact.title)}`, secondary: true },
          ...(evidenceCount > 0 ? [{ label: "Evidence", href: evidenceHref(`fact:${fact.id}`), secondary: true }] : [])
        ]
      }),
      rail: buildFactRail(fact)
    });
  }

  if (pathname.startsWith("/domains/")) {
    const slug = decodeURIComponent(pathname.slice("/domains/".length));
    const domain = snapshot.system.collections.domains.find(item => item.id.split(":")[1] === slug);
    if (!domain) return renderNotFound(pathname);
    return renderMarkdownPage({
      relPath: `domains/${slug}.md`,
      title: domain.name,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: "Domain",
        title: domain.name,
        lede: domain.description,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Domains", href: "/catalog/domains" },
          { label: domain.name }
        ],
        chips: [{ label: `${domain.module_keys.length} modules` }],
        actions: [
          ...(domain.module_keys[0] ? [{ label: "Open mapped module", href: moduleHref(domain.module_keys[0]) }] : []),
          { label: "Open graph", href: "/graph?mode=overview", secondary: true }
        ]
      }),
      rail: buildCollectionRail(domain.name, domain.module_keys)
    });
  }

  if (pathname.startsWith("/layers/")) {
    const slug = decodeURIComponent(pathname.slice("/layers/".length));
    const layer = snapshot.system.collections.layers.find(item => item.id.split(":")[1] === slug);
    if (!layer) return renderNotFound(pathname);
    return renderMarkdownPage({
      relPath: `layers/${slug}.md`,
      title: layer.name,
      currentPath: pathname,
      hero: renderPageHero({
        eyebrow: "Layer",
        title: layer.name,
        lede: layer.role,
        breadcrumbs: [
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Layers", href: "/catalog/layers" },
          { label: layer.name }
        ],
        chips: [{ label: `${layer.module_keys.length} modules` }],
        actions: [
          { label: "Architecture overview", href: "/graph?mode=overview" },
          ...(layer.module_keys[0] ? [{ label: "Open mapped module", href: moduleHref(layer.module_keys[0]), secondary: true }] : [])
        ]
      }),
      rail: buildCollectionRail(layer.name, layer.module_keys)
    });
  }

  return renderNotFound(pathname);
}

const server = createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  if (pathname === "/favicon.ico") {
    res.writeHead(404);
    res.end();
    return;
  }

  if (pathname === "/assets/vis-network.min.js") {
    if (!VIS_NETWORK_ASSET) {
      res.writeHead(404);
      res.end("vis-network asset not installed");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(VIS_NETWORK_ASSET);
    return;
  }

  if (pathname === "/api/search") {
    const query = urlObj.searchParams.get("q") || "";
    const results = query ? searchKnowledge(snapshot, query, { limit: 30 }) : [];
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ query, results }));
    return;
  }

  if (pathname === "/api/graph") {
    const reqMode = urlObj.searchParams.get("mode") || "overview";
    // Refuse to render the full hairball — redirect "module" mode to overview
    const safeMode = reqMode === "module" ? "overview" : reqMode;
    const graph = buildGraphView(snapshot, {
      mode: safeMode,
      module: urlObj.searchParams.get("module") || null,
      flow: urlObj.searchParams.get("flow") || null,
      from: urlObj.searchParams.get("from") || null,
      to: urlObj.searchParams.get("to") || null
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(graph));
    return;
  }

  let html;
  if (pathname === "/") {
    html = renderHomePage();
  } else if (pathname === "/catalog" || pathname.startsWith("/catalog/")) {
    html = renderCatalogPage(pathname, urlObj);
  } else if (pathname === "/evidence") {
    html = renderEvidencePage(urlObj);
  } else if (pathname === "/search") {
    html = renderSearchPage(urlObj.searchParams.get("q") || "");
  } else if (pathname === "/graph") {
    html = renderGraphPage(urlObj);
  } else {
    html = routeMarkdownPage(pathname);
  }

  res.writeHead(html.includes("<title>Not Found</title>")
    ? 404
    : 200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n  Sonar Workspace -> http://localhost:${PORT}`);
  console.log(`  Sonar dir: ${SONAR_DIR}`);
  console.log(`  Snapshot: ${snapshot.modules.items.length} modules, ${snapshot.flows.items.length} flows, ${snapshot.search.documents.length} search docs\n`);
});
