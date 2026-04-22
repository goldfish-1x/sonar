---
name: sonar-crawl
description: Use when the user wants to build or rebuild a complete `.sonar/` map for the current repository.
user-invocable: true
---

# Sonar Crawl

Build a full `.sonar/` map for the current repository.

## Workflow

1. If `.sonar/meta.json` already exists and the user did not ask for a full rebuild, recommend `@sonar sonar-update` instead.
2. Create `.sonar/{modules,flows,submodules,partials}` if needed.
3. Resolve `SONAR_PLUGIN_ROOT` from this skill path.
4. Install Sonar dependencies if they are not already present:

```bash
(cd "$SONAR_PLUGIN_ROOT" && npm install --ignore-scripts)
```

5. Run the deterministic skeleton pass first:

```bash
bash "$SONAR_PLUGIN_ROOT/scripts/build-skeleton.sh" . .sonar
```

6. Read `.sonar/skeleton.json`, enumerate non-test modules, then analyze them.
7. If subagents are available and permitted in the current runtime, parallelize module analysis, parent synthesis, flow tracing, and system synthesis. Otherwise do the same work serially.
8. Rebuild derived artifacts:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/build-state.mjs" .sonar
node "$SONAR_PLUGIN_ROOT/scripts/build-db.mjs" .sonar
node "$SONAR_PLUGIN_ROOT/scripts/build-wiki.mjs" .sonar
```

9. Finish by reporting coverage, module count, flow count, and where the map was written.

## Expectations

- Prefer maximum safe parallelism when the runtime allows it.
- Do not skip `build-db.mjs`; the map is incomplete without the query layer.
- If the crawl is too large or expensive for the current session, say so and propose a narrower first pass.
