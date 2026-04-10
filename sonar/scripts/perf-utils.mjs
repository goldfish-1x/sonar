#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function toFixedNumber(value, digits = 3) {
  return Number(value.toFixed(digits));
}

export function snapshotMemoryMb() {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

export function writePerfSection(sonarDir, section, data) {
  const partialsDir = join(sonarDir, "partials");
  const perfPath = join(partialsDir, "perf.json");
  let perf = {};

  mkdirSync(partialsDir, { recursive: true });

  if (existsSync(perfPath)) {
    try {
      perf = JSON.parse(readFileSync(perfPath, "utf8"));
    } catch {
      perf = {};
    }
  }

  perf.generated_at = new Date().toISOString();
  perf[section] = data;
  writeFileSync(perfPath, JSON.stringify(perf, null, 2));
}
