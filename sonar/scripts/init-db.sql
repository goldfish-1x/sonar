-- Sonar graph database schema
-- Rebuilt from .sonar/ JSON files by build-db.mjs

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT,
  lines INTEGER,
  module_key TEXT,
  content_hash TEXT,
  analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS modules (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  purpose TEXT,
  complexity TEXT,
  card_kind TEXT DEFAULT 'module',      -- 'module' | 'parent'
  child_module_keys TEXT,               -- JSON array, non-null for parent cards
  analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS submodules (
  key TEXT PRIMARY KEY,
  parent_module_key TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  cluster_slug TEXT NOT NULL,
  purpose TEXT,
  analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,  -- function|class|method|type
  line INTEGER,
  end_line INTEGER,
  signature TEXT,
  purpose TEXT,
  is_exported INTEGER DEFAULT 0,
  module_key TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  source_module TEXT,
  target_module TEXT,
  kind TEXT,  -- imports|calls|extends
  weight INTEGER DEFAULT 1,
  PRIMARY KEY (source_module, target_module, kind)
);

CREATE TABLE IF NOT EXISTS file_edges (
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'imports',
  weight INTEGER DEFAULT 1,
  PRIMARY KEY (source_file, target_file, kind)
);

CREATE TABLE IF NOT EXISTS flows (
  name TEXT PRIMARY KEY,
  title TEXT,
  summary TEXT,
  entry_file TEXT,
  entry_function TEXT,
  step_count INTEGER,
  confidence REAL,
  analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS flow_steps (
  flow_name TEXT REFERENCES flows(name),
  step_order INTEGER,
  module_key TEXT,
  function_name TEXT,
  file_path TEXT,
  description TEXT,
  data TEXT,
  confidence REAL,
  evidence_json TEXT,
  PRIMARY KEY (flow_name, step_order)
);

CREATE TABLE IF NOT EXISTS system_facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  scope TEXT,
  confidence REAL,
  check_cmd TEXT,
  evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS system_fact_modules (
  fact_id TEXT REFERENCES system_facts(id),
  module_key TEXT,
  PRIMARY KEY (fact_id, module_key)
);

CREATE TABLE IF NOT EXISTS artifact_freshness (
  artifact_type TEXT,
  artifact_key TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT,
  PRIMARY KEY (artifact_type, artifact_key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS submodules_fts USING fts5(
  key,
  cluster_name,
  purpose,
  business_rules,
  conventions,
  public_api
);

-- Full-text search indexes
CREATE VIRTUAL TABLE IF NOT EXISTS modules_fts USING fts5(
  key,
  name,
  purpose,
  conventions,
  business_rules,
  public_api,
  side_effects
);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, purpose, signature, module_key);
CREATE VIRTUAL TABLE IF NOT EXISTS flows_fts USING fts5(
  name,
  title,
  summary,
  steps_text,
  invariants,
  failure_modes,
  module_keys
);
CREATE VIRTUAL TABLE IF NOT EXISTS system_facts_fts USING fts5(
  id,
  kind,
  title,
  detail,
  scope,
  module_keys
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_symbols_module ON symbols(module_key);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported) WHERE is_exported = 1;
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_module);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_module);
CREATE INDEX IF NOT EXISTS idx_files_module ON files(module_key);
CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_name);
CREATE INDEX IF NOT EXISTS idx_flow_steps_module ON flow_steps(module_key);
CREATE INDEX IF NOT EXISTS idx_system_fact_modules_module ON system_fact_modules(module_key);
CREATE INDEX IF NOT EXISTS idx_artifact_freshness_type ON artifact_freshness(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifact_freshness_status ON artifact_freshness(status);
CREATE INDEX IF NOT EXISTS idx_file_edges_source ON file_edges(source_file);
CREATE INDEX IF NOT EXISTS idx_file_edges_target ON file_edges(target_file);
CREATE INDEX IF NOT EXISTS idx_submodules_parent ON submodules(parent_module_key);
