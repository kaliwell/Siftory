export const SCHEMA_VERSION = 2

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  parent_id INTEGER, color TEXT NOT NULL, icon TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, reference_threshold REAL,
  source_cluster_group_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS asset_categories (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, category_id INTEGER NOT NULL,
  suggestion_id INTEGER, confidence REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL, status TEXT NOT NULL,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(asset_id, category_id));
CREATE INDEX IF NOT EXISTS idx_asset_categories_category_status ON asset_categories(category_id, status, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_categories_status_asset ON asset_categories(status, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_categories_suggestion ON asset_categories(suggestion_id);
CREATE TABLE IF NOT EXISTS asset_tags (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
  suggestion_id INTEGER, confidence REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL, status TEXT NOT NULL,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(asset_id, tag_id));
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_status ON asset_tags(tag_id, status, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_tags_suggestion ON asset_tags(suggestion_id);
CREATE TABLE IF NOT EXISTS category_references (
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, asset_id INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  UNIQUE(category_id, asset_id));
CREATE INDEX IF NOT EXISTS idx_category_references_asset ON category_references(asset_id);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, category_id INTEGER, tag_id INTEGER,
  confidence REAL NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
  evidence_asset_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((category_id IS NULL) <> (tag_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_suggestions_status_source ON suggestions(status, source, confidence DESC, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_suggestions_category ON suggestions(category_id, source, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_tag ON suggestions(tag_id, source, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_asset ON suggestions(asset_id);
CREATE TABLE IF NOT EXISTS cluster_groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, algorithm TEXT NOT NULL, status TEXT NOT NULL,
  asset_count INTEGER NOT NULL DEFAULT 0, avg_similarity REAL NOT NULL DEFAULT 0,
  representative_asset_id INTEGER NOT NULL DEFAULT 0, source_category_id INTEGER,
  labels TEXT, origin TEXT NOT NULL DEFAULT 'auto', lineage_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cluster_groups_status ON cluster_groups(status, algorithm);
CREATE TABLE IF NOT EXISTS cluster_lineage (
  id INTEGER PRIMARY KEY, event TEXT NOT NULL, group_ids TEXT NOT NULL DEFAULT '[]',
  from_group_ids TEXT NOT NULL DEFAULT '[]', to_group_id INTEGER,
  member_asset_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cluster_lineage_created ON cluster_lineage(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS cluster_members (
  id INTEGER PRIMARY KEY, cluster_group_id INTEGER NOT NULL, asset_id INTEGER NOT NULL,
  similarity REAL NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(cluster_group_id, asset_id));
CREATE INDEX IF NOT EXISTS idx_cluster_members_asset ON cluster_members(asset_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_group_similarity ON cluster_members(cluster_group_id, similarity DESC, asset_id);
CREATE TABLE IF NOT EXISTS metadata_deletion_trash (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL, relation_count INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL, restored_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_trash_retention ON metadata_deletion_trash(restored_at, deleted_at DESC, id DESC);
PRAGMA user_version = ${SCHEMA_VERSION};
`
