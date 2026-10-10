// Integration check: runs buildReferenceSuggestions (worker-based) on the REAL
// library twice and asserts the generated suggestion set is deterministic and
// structurally valid (no assigned/reviewed pairs, targets only referenced
// categories, confidence within range). This is a real but routine write —
// the same operation the app performs when the user builds suggestions.
// Usage: node scripts/verify-suggestion-worker.cjs
const Module = require('node:module')
const path = require('node:path')

const userDataDir = path.join(process.env.APPDATA, 'floating-clock-electron')
const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
  },
}
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

const { loadTsModule } = require('../tests/guard-utils.cjs')

function generatedSet(db) {
  const rows = db
    .prepare(
      `SELECT asset_id, category_id, confidence, status, evidence_asset_ids
       FROM suggestions WHERE source = 'reference_image' AND status IN ('suggested', 'low_confidence')
       ORDER BY category_id, asset_id`,
    )
    .all()
  return rows.map((row) =>
    [row.asset_id, row.category_id, row.confidence.toFixed(6), row.status, row.evidence_asset_ids].join('|'),
  )
}

async function waitForTask(svc, label) {
  const deadline = Date.now() + 30 * 60 * 1000
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const progress = svc.getAssetLibraryTaskProgress()
    if (!progress || progress.state === 'done') return
    if (progress.state === 'error' || progress.state === 'stopped') {
      throw new Error(`${label} ended with state=${progress.state}: ${progress.error || progress.message}`)
    }
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
  }
}

async function main() {
  const svc = loadTsModule('electron/assetLibraryService.ts')
  svc.initAssetLibraryService(userDataDir, { storageMode: 'sqlite' })
  const { DatabaseSync } = require('node:sqlite')
  const dbPath = path.join(userDataDir, 'asset-library', 'asset-library.sqlite')

  const started = svc.buildReferenceSuggestions({})
  if (!started.ok) throw new Error(`task rejected: ${started.error}`)
  await waitForTask(svc, 'run 1')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const first = generatedSet(db)

  const second = svc.buildReferenceSuggestions({})
  if (!second.ok) throw new Error(`task 2 rejected: ${second.error}`)
  await waitForTask(svc, 'run 2')
  const secondSet = generatedSet(db)

  console.log(`[suggest] run1=${first.length} run2=${secondSet.length} generated rows`)
  if (first.length !== secondSet.length || first.some((row, index) => row !== secondSet[index])) {
    throw new Error('non-deterministic output between two identical runs')
  }
  console.log('[suggest] deterministic across two runs')

  const assigned = new Set(
    db
      .prepare('SELECT asset_id, category_id FROM asset_categories')
      .all()
      .map((row) => `${row.asset_id}:${row.category_id}`),
  )
  const reviewed = new Set(
    db
      .prepare(
        `SELECT asset_id, category_id FROM suggestions
         WHERE source = 'reference_image' AND status NOT IN ('suggested', 'low_confidence')`,
      )
      .all()
      .map((row) => `${row.asset_id}:${row.category_id}`),
  )
  let violations = 0
  for (const row of first) {
    const [assetId, categoryId, confidence] = row.split('|')
    const pair = `${assetId}:${categoryId}`
    if (assigned.has(pair) || reviewed.has(pair)) {
      console.error(`[suggest] VIOLATION: generated row for excluded pair ${pair}`)
      violations++
    }
    const value = Number(confidence)
    if (!(value >= 0 && value <= 1)) {
      console.error(`[suggest] VIOLATION: confidence out of range ${row}`)
      violations++
    }
  }
  const targets = new Set(first.map((row) => Number(row.split('|')[1])))
  console.log(
    `[suggest] targets=${[...targets].sort((a, b) => a - b).join(',')} violations=${violations}`,
  )
  db.close()
  if (violations > 0) throw new Error(`${violations} invariant violations`)
  console.log('[suggest] RESULT: worker-based generation OK on the real library')
}

main().catch((error) => {
  console.error(`[suggest] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
