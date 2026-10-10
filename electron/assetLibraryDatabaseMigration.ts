import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_DDL, SCHEMA_VERSION } from './assetLibraryDatabaseSchema'

/** Initialize or upgrade the schema as one recoverable transaction. */
export function initializeAssetLibrarySchema(database: DatabaseSync, version: number): void {
  if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported asset library schema version: ${version}`)
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    if (version === 1) {
      // v1 → v2: cluster lineage (origin / lineage_key / cluster_lineage).
      // Older builds could leave either ALTER committed while user_version
      // was still 1. Resume those partial migrations without dropping data.
      const columns = new Set(
        database
          .prepare('PRAGMA table_info(cluster_groups)')
          .all()
          .map((row) => row.name),
      )
      if (!columns.has('origin')) {
        database.exec(`ALTER TABLE cluster_groups ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto'`)
      }
      if (!columns.has('lineage_key')) {
        database.exec(`ALTER TABLE cluster_groups ADD COLUMN lineage_key TEXT`)
      }
      database
        .prepare(
          'INSERT OR IGNORE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)',
        )
        .run(2, Date.now(), 'schema v2: cluster lineage (origin, lineage_key, cluster_lineage)')
    }
    database.exec(SCHEMA_DDL)
    database
      .prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)',
      )
      .run(SCHEMA_VERSION, Date.now(), 'schema v2: relational schema with cluster lineage')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
