#!/usr/bin/env node

import { resolve } from "path";
import { buildKnowledgeSnapshot, writeKnowledgeSnapshot } from "../lib/knowledge-snapshot.mjs";

const sonarDir = resolve(process.argv[2] || ".sonar");
const snapshot = buildKnowledgeSnapshot(sonarDir);
const outputPath = writeKnowledgeSnapshot(sonarDir, snapshot);

console.log(
  `Knowledge snapshot built: ${snapshot.modules.items.length} modules, ${snapshot.flows.items.length} flows, ${snapshot.system.facts.length} facts, ${snapshot.graph.edges.length} edges -> ${outputPath}`
);
