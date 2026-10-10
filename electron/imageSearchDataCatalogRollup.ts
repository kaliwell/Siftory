import { DatabaseSync } from 'node:sqlite'
import type { ImageSearchDataCatalogProgress } from '../shared/ipc-contract'
import { normalizedImageDataPathKey } from './imageSearchDataPathUtils'
import {
  catalogFolderChain,
  catalogFolderName,
  cleanCatalogDisplayPath,
} from './imageSearchDataCatalogPaths'

const INSERT_BATCH_SIZE = 20_000
const PROGRESS_RECORD_INTERVAL = 1_000

interface FolderAggregate {
  folderKey: string
  parentKey: string | null
  displayPath: string
  name: string
  depth: number
  childCount: number
  nativeCount: number
  dinoCount: number
  clipCount: number
  nativeOnly: number
  dinoOnly: number
  clipOnly: number
  missingDino: number
  missingClip: number
  vectorOnly: number
  duplicateRows: number
  malformedRows: number
  matchedBytes: number
}

interface CatalogPathRow {
  display_path: string
  native_count: number
  native_bytes: number
  dino_rows: number
  clip_rows: number
  duplicate_rows: number
}

type ProgressCallback = (progress: Partial<ImageSearchDataCatalogProgress>) => void

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined
  return numberValue(row ? Object.values(row)[0] : 0)
}

function beginBatch(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
}

function commitBatch(database: DatabaseSync): void {
  database.exec('COMMIT')
}

function rollbackBatch(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // A prior SQLite failure may already have closed the transaction.
  }
}

function configuredRoots(rootsInput: string[]) {
  return [...new Set(rootsInput.map(cleanCatalogDisplayPath).filter(Boolean))]
    .map((display) => ({ display, key: normalizedImageDataPathKey(display) }))
    .filter((item) => item.key)
}

function emptyFolder(folder: {
  key: string
  display: string
  parentKey: string | null
  depth: number
}): FolderAggregate {
  return {
    folderKey: folder.key,
    parentKey: folder.parentKey,
    displayPath: folder.display,
    name: catalogFolderName(folder.display),
    depth: folder.depth,
    childCount: 0,
    nativeCount: 0,
    dinoCount: 0,
    clipCount: 0,
    nativeOnly: 0,
    dinoOnly: 0,
    clipOnly: 0,
    missingDino: 0,
    missingClip: 0,
    vectorOnly: 0,
    duplicateRows: 0,
    malformedRows: 0,
    matchedBytes: 0,
  }
}

function addPathContribution(
  folders: Map<string, FolderAggregate>,
  roots: Array<{ key: string; display: string }>,
  row: CatalogPathRow,
  direction: -1 | 1,
): void {
  const native = numberValue(row.native_count) > 0
  const dino = numberValue(row.dino_rows) > 0
  const clip = numberValue(row.clip_rows) > 0
  const nativeOnly = native && !dino && !clip ? 1 : 0
  const dinoOnly = !native && dino && !clip ? 1 : 0
  const clipOnly = !native && !dino && clip ? 1 : 0
  const missingDino = native && !dino ? 1 : 0
  const missingClip = native && !clip ? 1 : 0
  const vectorOnly = !native && (dino || clip) ? 1 : 0
  for (const folder of catalogFolderChain(row.display_path, roots)) {
    const aggregate = folders.get(folder.key) || emptyFolder(folder)
    aggregate.nativeCount += direction * (native ? 1 : 0)
    aggregate.dinoCount += direction * (dino ? 1 : 0)
    aggregate.clipCount += direction * (clip ? 1 : 0)
    aggregate.nativeOnly += direction * nativeOnly
    aggregate.dinoOnly += direction * dinoOnly
    aggregate.clipOnly += direction * clipOnly
    aggregate.missingDino += direction * missingDino
    aggregate.missingClip += direction * missingClip
    aggregate.vectorOnly += direction * vectorOnly
    aggregate.duplicateRows += direction * numberValue(row.duplicate_rows)
    aggregate.matchedBytes += direction * numberValue(row.native_bytes)
    folders.set(folder.key, aggregate)
  }
}

function insertFolderStatement(database: DatabaseSync) {
  return database.prepare(`
    INSERT INTO folder_rollups (
      folder_key, parent_key, display_path, name, depth, child_count,
      native_count, dino_count, clip_count, native_only, dino_only, clip_only,
      missing_dino, missing_clip, vector_only, duplicate_rows, malformed_rows, matched_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
}

function runFolderInsert(
  statement: ReturnType<DatabaseSync['prepare']>,
  folder: FolderAggregate,
): void {
  statement.run(
    folder.folderKey,
    folder.parentKey,
    folder.displayPath,
    folder.name,
    folder.depth,
    folder.childCount,
    folder.nativeCount,
    folder.dinoCount,
    folder.clipCount,
    folder.nativeOnly,
    folder.dinoOnly,
    folder.clipOnly,
    folder.missingDino,
    folder.missingClip,
    folder.vectorOnly,
    folder.duplicateRows,
    folder.malformedRows,
    folder.matchedBytes,
  )
}

export function buildImageSearchFolderRollups(
  database: DatabaseSync,
  rootsInput: string[],
  checkCancelled: () => void,
  onProgress: ProgressCallback,
): number {
  const roots = configuredRoots(rootsInput)
  const rowCount = scalarCount(database, 'SELECT COUNT(*) FROM indexed_paths')
  const rows = database.prepare(
    `SELECT display_path, native_count, native_bytes, dino_rows, clip_rows, duplicate_rows
       FROM indexed_paths`,
  )
  const folders = new Map<string, FolderAggregate>()
  let index = 0
  for (const value of rows.iterate()) {
    if (index % PROGRESS_RECORD_INTERVAL === 0) {
      checkCancelled()
      onProgress({
        stage: 'folders',
        processedRecords: index,
        message: `Aggregating folders ${index.toLocaleString()}/${rowCount.toLocaleString()}`,
      })
    }
    addPathContribution(folders, roots, value as unknown as CatalogPathRow, 1)
    index++
  }
  for (const folder of folders.values()) {
    if (!folder.parentKey) continue
    const parent = folders.get(folder.parentKey)
    if (parent) parent.childCount++
  }

  const insert = insertFolderStatement(database)
  let batchCount = 0
  beginBatch(database)
  try {
    for (const folder of folders.values()) {
      checkCancelled()
      runFolderInsert(insert, folder)
      batchCount++
      if (batchCount >= INSERT_BATCH_SIZE) {
        commitBatch(database)
        beginBatch(database)
        batchCount = 0
      }
    }
    commitBatch(database)
  } catch (error) {
    rollbackBatch(database)
    throw error
  }
  return folders.size
}

export function updateAffectedImageSearchFolderRollups(
  database: DatabaseSync,
  rootsInput: string[],
  checkCancelled: () => void,
  onProgress: ProgressCallback,
): number {
  const roots = configuredRoots(rootsInput)
  const changedCount = scalarCount(database, 'SELECT COUNT(*) FROM changed_paths')
  const changedRows = database.prepare(`
    SELECT c.normalized_path,
           c.old_present, c.old_display_path, c.old_native_count,
           c.old_native_bytes, c.old_dino_rows, c.old_clip_rows,
           c.old_duplicate_rows,
           CASE WHEN p.path_id IS NULL THEN 0 ELSE 1 END AS new_present,
           COALESCE(p.display_path, c.old_display_path) AS new_display_path,
           COALESCE(p.native_count, 0) AS new_native_count,
           COALESCE(p.native_bytes, 0) AS new_native_bytes,
           COALESCE(p.dino_rows, 0) AS new_dino_rows,
           COALESCE(p.clip_rows, 0) AS new_clip_rows,
           COALESCE(p.duplicate_rows, 0) AS new_duplicate_rows
      FROM changed_paths c
      LEFT JOIN indexed_paths p ON p.normalized_path = c.normalized_path
     ORDER BY c.normalized_path
  `)
  const deltas = new Map<string, FolderAggregate>()
  let changedIndex = 0
  for (const value of changedRows.iterate()) {
    if (changedIndex % PROGRESS_RECORD_INTERVAL === 0) {
      checkCancelled()
      onProgress({
        stage: 'folders',
        processedRecords: changedIndex,
        message: `Updating affected folders ${changedIndex.toLocaleString()}/${changedCount.toLocaleString()}`,
      })
    }
    const row = value as Record<string, unknown>
    if (numberValue(row.old_present) > 0) {
      addPathContribution(
        deltas,
        roots,
        {
          display_path: String(row.old_display_path || ''),
          native_count: numberValue(row.old_native_count),
          native_bytes: numberValue(row.old_native_bytes),
          dino_rows: numberValue(row.old_dino_rows),
          clip_rows: numberValue(row.old_clip_rows),
          duplicate_rows: numberValue(row.old_duplicate_rows),
        },
        -1,
      )
    }
    if (numberValue(row.new_present) > 0) {
      addPathContribution(
        deltas,
        roots,
        {
          display_path: String(row.new_display_path || ''),
          native_count: numberValue(row.new_native_count),
          native_bytes: numberValue(row.new_native_bytes),
          dino_rows: numberValue(row.new_dino_rows),
          clip_rows: numberValue(row.new_clip_rows),
          duplicate_rows: numberValue(row.new_duplicate_rows),
        },
        1,
      )
    }
    changedIndex++
  }

  const upsert = database.prepare(`
    INSERT INTO folder_rollups (
      folder_key, parent_key, display_path, name, depth, child_count,
      native_count, dino_count, clip_count, native_only, dino_only, clip_only,
      missing_dino, missing_clip, vector_only, duplicate_rows, malformed_rows, matched_bytes
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(folder_key) DO UPDATE SET
      native_count = folder_rollups.native_count + excluded.native_count,
      dino_count = folder_rollups.dino_count + excluded.dino_count,
      clip_count = folder_rollups.clip_count + excluded.clip_count,
      native_only = folder_rollups.native_only + excluded.native_only,
      dino_only = folder_rollups.dino_only + excluded.dino_only,
      clip_only = folder_rollups.clip_only + excluded.clip_only,
      missing_dino = folder_rollups.missing_dino + excluded.missing_dino,
      missing_clip = folder_rollups.missing_clip + excluded.missing_clip,
      vector_only = folder_rollups.vector_only + excluded.vector_only,
      duplicate_rows = folder_rollups.duplicate_rows + excluded.duplicate_rows,
      malformed_rows = folder_rollups.malformed_rows + excluded.malformed_rows,
      matched_bytes = folder_rollups.matched_bytes + excluded.matched_bytes
  `)
  beginBatch(database)
  try {
    for (const delta of deltas.values()) {
      checkCancelled()
      upsert.run(
        delta.folderKey,
        delta.parentKey,
        delta.displayPath,
        delta.name,
        delta.depth,
        delta.nativeCount,
        delta.dinoCount,
        delta.clipCount,
        delta.nativeOnly,
        delta.dinoOnly,
        delta.clipOnly,
        delta.missingDino,
        delta.missingClip,
        delta.vectorOnly,
        delta.duplicateRows,
        delta.malformedRows,
        delta.matchedBytes,
      )
    }
    const childCount = database.prepare(
      'SELECT COUNT(*) AS count FROM folder_rollups WHERE parent_key = ?',
    )
    const getFolder = database.prepare(
      `SELECT parent_key, native_count, dino_count, clip_count
         FROM folder_rollups WHERE folder_key = ?`,
    )
    const deleteFolder = database.prepare('DELETE FROM folder_rollups WHERE folder_key = ?')
    const affectedKeys = new Set(deltas.keys())
    for (const delta of [...deltas.values()].sort((left, right) => right.depth - left.depth)) {
      const folder = getFolder.get(delta.folderKey) as Record<string, unknown> | undefined
      if (!folder) continue
      const children = numberValue(
        (childCount.get(delta.folderKey) as Record<string, unknown> | undefined)?.count,
      )
      if (
        children === 0 &&
        numberValue(folder.native_count) === 0 &&
        numberValue(folder.dino_count) === 0 &&
        numberValue(folder.clip_count) === 0
      ) {
        deleteFolder.run(delta.folderKey)
        if (folder.parent_key) affectedKeys.add(String(folder.parent_key))
      }
    }
    const updateChildren = database.prepare(
      `UPDATE folder_rollups
          SET child_count = (SELECT COUNT(*) FROM folder_rollups child
                              WHERE child.parent_key = folder_rollups.folder_key)
        WHERE folder_key = ?`,
    )
    for (const folderKey of affectedKeys) updateChildren.run(folderKey)
    const invalid = scalarCount(
      database,
      `SELECT COUNT(*) FROM folder_rollups
        WHERE native_count < 0 OR dino_count < 0 OR clip_count < 0
           OR native_only < 0 OR dino_only < 0 OR clip_only < 0
           OR missing_dino < 0 OR missing_clip < 0 OR vector_only < 0
           OR duplicate_rows < 0 OR matched_bytes < 0`,
    )
    if (invalid > 0) throw new Error('Incremental folder rollup invariant failed')
    commitBatch(database)
  } catch (error) {
    rollbackBatch(database)
    throw error
  }
  return scalarCount(database, 'SELECT COUNT(*) FROM folder_rollups')
}
