const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repo = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(repo, relativePath), 'utf8')
}

test('imageSearch:deleteDataFolder channel constant is registered', () => {
  const channels = source('shared/ipc/image-search.ts')
  assert.match(channels, /DELETE_DATA_FOLDER:\s*'imageSearch:deleteDataFolder'/)
})

test('ipc contract exposes deleteDataFolder returning an edit result', () => {
  const contract = source('shared/ipc/electron-api.ts')
  assert.match(
    contract,
    /deleteDataFolder:\s*\(folder:\s*string\)\s*=>\s*Promise<ImageSearchDataEditResult>/,
  )
  const editResult = source('shared/ipc/image-search.ts')
  assert.match(editResult, /interface ImageSearchDataEditResult \{[^}]*removedCount\?: number/)
})

test('preload exposes deleteDataFolder through the new channel', () => {
  const preload = source('electron/preload.ts')
  assert.match(
    preload,
    /deleteDataFolder:\s*\(folder\)\s*=>\s*ipcRenderer\.invoke\('imageSearch:deleteDataFolder', folder\)/,
  )
})

test('renderer bridge wraps deleteDataFolder with safe fallback', () => {
  const bridge = source('src/services/imageSearchBridge.ts')
  assert.match(
    bridge,
    /async deleteDataFolder\(folder: string\): Promise<ImageSearchDataEditResult>/,
  )
  assert.match(
    bridge,
    /if \(!a\?\.deleteDataFolder\) throw new Error\('electronAPI not available'\)/,
  )
  assert.match(bridge, /return await a\.deleteDataFolder\(folder\)/)
})

test('service validates the folder against scan-path roots before purging', () => {
  const service = source('electron/imageSearchService.ts')
  const implementation = source('electron/imageSearchDataService.ts')
  assert.match(
    service,
    /export async function deleteImageSearchDataFolder\(\s*folder: string,\s*allowedRoots: string\[\],\s*options: ImageSearchFolderDeleteOptions = \{\},?\s*\)/,
  )
  assert.match(service, /imageSearchDataService\.deleteImageSearchDataFolder/)
  const fnIndex = implementation.indexOf('async function deleteImageSearchDataFolder')
  const body = implementation.slice(fnIndex, fnIndex + 6500)
  // Root containment check must happen before the native purge call.
  assert.match(body, /path\.resolve\(folder\)/)
  assert.match(body, /allowedRoots\.some/)
  // H1: containment uses path.relative so drive roots ('D:\') and UNC roots,
  // whose resolved form keeps a trailing separator, still match their children.
  assert.match(body, /path\.relative\(normalizedRoot, normalizedFolder\)/)
  assert.match(body, /rel === '' \|\| \(!rel\.startsWith\('\.\.'\) && !path\.isAbsolute\(rel\)\)/)
  assert.doesNotMatch(body, /startsWith\(normalizedRoot \+ path\.sep\)/)
  assert.match(body, /Folder is outside the configured scan paths/)
  const guardIndex = body.indexOf('Folder is outside the configured scan paths')
  const purgeIndex = body.indexOf('addon.purgeIndexPathPrefix(path.resolve(folder))')
  assert.ok(guardIndex > -1 && purgeIndex > -1 && guardIndex < purgeIndex)
  // Purged edits are persisted to disk and the removed count is reported,
  // including project preview records removed by source-path matching (H2).
  assert.match(body, /await persistImageIndexEdits\(\)/)
  assert.match(body, /removedCount: \(Number\(purged\.removedCount\) \|\| 0\) \+ previewRemoved/)
  assert.match(body, /options\.compactAfterDelete/)
  assert.match(body, /physical compaction failed/)
  // Safe degradation when the native addon lacks the purge primitive.
  assert.match(body, /typeof addon\.purgeIndexPathPrefix !== 'function'/)
})

test('ipc handler normalizes the folder and reads scan paths from settings', () => {
  const ipc = source('electron/imageSearchIpc.ts')
  const helperIndex = ipc.indexOf('function configuredImageSearchRoots')
  assert.ok(helperIndex > -1)
  const helper = ipc.slice(helperIndex, helperIndex + 900)
  assert.match(helper, /floating_clock_settings\.json/)
  assert.match(helper, /imageSearchScanPaths/)
  assert.match(ipc, /secureIpcMain\.handle\('imageSearch:deleteDataFolder'/)
  const fnIndex = ipc.indexOf("secureIpcMain.handle('imageSearch:deleteDataFolder'")
  const body = ipc.slice(fnIndex, fnIndex + 1200)
  assert.match(body, /safeShellPath\(rawFolder\)/)
  assert.match(body, /deleteImageSearchDataFolder\(folder, configuredImageSearchRoots\(\)\)/)
  assert.match(
    ipc,
    /import \{[^}]*deleteImageSearchDataFolder[^}]*\} from '\.\/imageSearchService'/,
  )
})

test('data editor UI offers folder browsing, paging, and preview-token folder delete', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // Folder bar renders scan paths as toggle buttons.
  assert.match(ui, /t\('Source Folders'\)/)
  assert.match(ui, /scanPaths\.map\(\(folder\) =>/)
  assert.match(ui, /selectedFolder === folder/)
  // Selecting a folder sets the query term and runs the query.
  assert.match(ui, /setQuery\(folder\)/)
  assert.match(ui, /void runQuery\(folder\)/)
  // Paged loading appends records with a 200-row page size.
  assert.match(ui, /imageSearchBridge\.queryData\(term, 0, 200\)/)
  assert.match(ui, /imageSearchBridge\.queryData\(query\.trim\(\), records\.length, 200\)/)
  assert.match(ui, /setHasMore\(Boolean\(result\.hasMore\)\)/)
  assert.match(ui, /t\('Load More'\)/)
  // Folder deletion is a two-step, token-bound preview/execute flow.
  assert.match(ui, /if \(!folderDeleteArmed \|\| !folderEditPreview\?\.token\) \{/)
  assert.match(ui, /imageSearchBridge\.previewFolderDataEdit\(selectedFolder, layers\)/)
  assert.match(ui, /imageSearchBridge\.executeFolderDataEdit\(folderEditPreview\.token!\)/)
  assert.match(ui, /t\('Analyze Selected Index Layers'\)/)
  assert.match(ui, /t\('Confirm Delete Selected Index Data'\)/)
  assert.match(ui, /\['native', 'dino', 'clip'\]/)
})

test('new visible strings have Chinese translations', () => {
  const i18n = source('src/i18n/core.ts')
  for (const key of [
    'Source Folders',
    'Load More',
    'Manage Folder Indexes',
    'Analyze Selected Index Layers',
    'Confirm Delete Selected Index Data',
    'Folder index data deleted: Native {native}, DINO {dino}, CLIP {clip}',
    'Deletes selected index data under this folder only. Source images are never deleted.',
    'Filter indexed path (empty shows first 200)',
  ]) {
    assert.ok(i18n.includes(`'${key}':`), `missing translation for ${key}`)
  }
})

test('imageSearch:getDataStats channel constant is registered', () => {
  const channels = source('shared/ipc/image-search.ts')
  assert.match(channels, /GET_DATA_STATS:\s*'imageSearch:getDataStats'/)
  assert.match(
    channels,
    /interface ImageSearchDataStatsResult \{[^}]*count\?: number[^}]*totalBytes\?: number/,
  )
})

test('ipc contract exposes getDataStats returning a stats result', () => {
  const contract = source('shared/ipc/electron-api.ts')
  assert.match(
    contract,
    /getDataStats:\s*\(prefix:\s*string\)\s*=>\s*Promise<ImageSearchDataStatsResult>/,
  )
})

test('preload exposes getDataStats through the new channel', () => {
  const preload = source('electron/preload.ts')
  assert.match(
    preload,
    /getDataStats:\s*\(prefix\)\s*=>\s*ipcRenderer\.invoke\('imageSearch:getDataStats', prefix\)/,
  )
})

test('renderer bridge wraps getDataStats with safe fallback', () => {
  const bridge = source('src/services/imageSearchBridge.ts')
  assert.match(bridge, /async getDataStats\(prefix: string\): Promise<ImageSearchDataStatsResult>/)
  assert.match(bridge, /if \(!a\?\.getDataStats\) throw new Error\('electronAPI not available'\)/)
  assert.match(bridge, /return await a\.getDataStats\(prefix\)/)
})

test('service delegates stats to the native aggregate primitive', () => {
  const service = source('electron/imageSearchService.ts')
  const implementation = source('electron/imageSearchDataService.ts')
  assert.match(service, /export function getImageSearchDataStats\(prefix: string\)/)
  assert.match(service, /imageSearchDataService\.getImageSearchDataStats\(prefix\)/)
  const fnIndex = implementation.indexOf('function getImageSearchDataStats')
  const body = implementation.slice(fnIndex, fnIndex + 900)
  // Read-only aggregate: no scan-path root validation, straight delegation.
  assert.match(body, /addon\.getIndexPathStats\(String\(prefix \|\| ''\)\)/)
  assert.doesNotMatch(body, /allowedRoots/)
  // Safe degradation when the native addon lacks the stats primitive.
  assert.match(body, /typeof addon\.getIndexPathStats !== 'function'/)
  assert.match(body, /count: Number\(stats\.count\) \|\| 0/)
  assert.match(body, /totalBytes: Number\(stats\.totalBytes\) \|\| 0/)
})

test('ipc handler bounds the stats prefix like the query term', () => {
  const ipc = source('electron/imageSearchIpc.ts')
  assert.match(ipc, /secureIpcMain\.handle\('imageSearch:getDataStats'/)
  const fnIndex = ipc.indexOf("secureIpcMain.handle('imageSearch:getDataStats'")
  const body = ipc.slice(fnIndex, fnIndex + 600)
  assert.match(body, /rawPrefix === 'string' \? rawPrefix\.slice\(0, 1024\) : ''/)
  assert.match(body, /getImageSearchDataStats\(prefix\)/)
  assert.match(ipc, /import \{[^}]*getImageSearchDataStats[^}]*\} from '\.\/imageSearchService'/)
})

test('native addon exports the getIndexPathStats aggregate primitive', () => {
  const native = source('native/fast_scanner.cc')
  assert.match(native, /static napi_value GetIndexPathStats\(/)
  assert.match(native, /xfn\("getIndexPathStats",GetIndexPathStats\)/)
  assert.match(native, /"Unsafe index prefix"/)
})

test('data editor UI shows Native/DINO/CLIP aggregates in the confirmation preview', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // Folder buttons load and render per-folder aggregates.
  assert.match(ui, /imageSearchBridge\.getDataStats\(folder\)/)
  assert.match(ui, /folderStats\[folder\]/)
  assert.match(ui, /t\('\{count\} records · \{size\}'/)
  // Path-like queries refresh a totals bar above the results list.
  assert.match(ui, /term\.includes\(':\\\\'\) \|\| term\.startsWith\('\\\\'\)/)
  assert.match(ui, /imageSearchBridge\.getDataStats\(prefix\)/)
  assert.match(ui, /t\('Total: \{count\} records · \{size\}'/)
  // The confirmation preview renders each independent index layer.
  assert.match(ui, /folderEditPreview\[layer\]/)
  assert.match(ui, /t\('\{count\} images · \{records\} rows · \{size\}'/)
  assert.match(ui, /folderEditPreview\.temporaryBytes/)
})

test('new aggregate strings have Chinese translations', () => {
  const i18n = source('src/i18n/core.ts')
  for (const key of [
    '{count} records · {size}',
    'Total: {count} records · {size}',
    'Removes {count} index records ({size}); source files are not deleted',
  ]) {
    assert.ok(i18n.includes(`'${key}':`), `missing translation for ${key}`)
  }
})

test('data editor stats walk an ancestor-folder fallback chain for path queries', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // The chain starts from the term itself and climbs parents, capped at 8
  // levels, never shorter than the drive root.
  assert.match(ui, /function statsPrefixChain\(term: string\): string\[\]/)
  const fnMatch = ui.match(/function statsPrefixChain\(term: string\): string\[\] \{[\s\S]*?\n\}/)
  assert.ok(fnMatch, 'statsPrefixChain function not found')
  const statsPrefixChain = new Function(
    `${fnMatch[0].replace('(term: string): string[]', '(term)').replace('const chain: string[]', 'const chain')}\nreturn statsPrefixChain`,
  )()
  // File paths (extension included) start from the term itself and climb up.
  assert.deepEqual(statsPrefixChain('C:\\Users\\me\\xwechat_files\\RWTemp\\a1b2.png'), [
    'C:\\Users\\me\\xwechat_files\\RWTemp\\a1b2.png',
    'C:\\Users\\me\\xwechat_files\\RWTemp',
    'C:\\Users\\me\\xwechat_files',
    'C:\\Users\\me',
    'C:\\Users',
  ])
  // Trailing separators are stripped; the bare drive root 'C:\' is never a candidate.
  assert.deepEqual(statsPrefixChain('C:\\Users\\'), ['C:\\Users'])
  // The climb is capped at 8 candidates.
  assert.equal(statsPrefixChain('C:\\1\\2\\3\\4\\5\\6\\7\\8\\9\\f.png').length, 8)
})

test('data editor stats keep the first non-empty ancestor prefix and annotate it', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // Serial walk over the chain; failed levels are skipped silently.
  assert.match(ui, /for \(const prefix of statsPrefixChain\(term\)\)/)
  assert.match(ui, /if \(!stats\.ok\) continue/)
  assert.match(ui, /if \(entry\.count > 0\)/)
  // When the effective prefix differs from the term, the bar names the source folder.
  assert.match(ui, /queryStats\.prefix !== queryStats\.term/)
  assert.match(ui, /t\('\{prefix\} · Total: \{count\} records · \{size\}'/)
})

test('ancestor-fallback annotation string has a Chinese translation', () => {
  const i18n = source('src/i18n/core.ts')
  assert.ok(
    i18n.includes(`'{prefix} · Total: {count} records · {size}':`),
    'missing translation for the ancestor-prefix annotation',
  )
})

test('service narrows path-like list queries to the stats/purge boundary prefix (M1)', () => {
  const service = source('electron/imageSearchDataService.ts')
  const pathUtils = source('electron/imageSearchDataPathUtils.ts')
  // M1: native QueryIndexRecords is a substring match; the service re-filters
  // path-like queries with the same boundary-prefix predicate used by
  // getIndexPathStats/purgeIndexPathPrefix so list/stats/delete agree.
  assert.match(
    pathUtils,
    /function normalizedImageDataQueryPrefix\(query: string\): string \| null/,
  )
  assert.match(
    pathUtils,
    /function isImageDataQueryPathWithin\(recordPath: string, prefix: string\): boolean/,
  )
  // The predicate is exactly "equal to prefix, or under prefix + '\\'".
  assert.match(
    pathUtils,
    /normalizedPath === prefix \|\| normalizedPath\.startsWith\(`\$\{prefix\}\\\\`\)/,
  )
  // M2: both the query prefix and record paths collapse forward slashes and
  // trailing separators and compare lowercase.
  assert.match(pathUtils, /\.replace\(\/\\\/\+\/g, '\\\\'\)/)
  assert.match(pathUtils, /\.replace\(\/\\\\\+\$\/, ''\)\s*\.toLowerCase\(\)/)
  const fnIndex = service.indexOf('function queryImageSearchData')
  const body = service.slice(fnIndex, fnIndex + 1800)
  assert.match(body, /addon\.queryIndexRecords\(String\(query \|\| ''\), offset, limit\)/)
  assert.match(body, /normalizedImageDataQueryPrefix\(query\)/)
  assert.match(body, /\.filter\(\(record\) => isImageDataQueryPathWithin\(record\.path, prefix\)\)/)
})

test('data editor normalizes forward slashes before path-like detection and stats (M2)', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // M2: pasted 'D:/foo/bar' terms are normalized to backslashes up front so the
  // path-like check, the stats prefix chain, and the native query all agree.
  assert.match(
    ui,
    /const term = \(overrideQuery \?\? query\)\.trim\(\)\.replace\(\/\\\/\+\/g, '\\\\'\)/,
  )
  assert.match(ui, /term\.includes\(':\\\\'\) \|\| term\.startsWith\('\\\\'\)/)
  assert.match(ui, /statsPrefixChain\(term\)/)
  assert.match(ui, /imageSearchBridge\.queryData\(term, 0, 200\)/)
  assert.match(ui, /const normalizedQueryPath = query\.trim\(\)\.replace\(\/\\\/\+\/g, '\\\\'\)/)
})

test('data editor clears stale query stats after a folder purge (M3)', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  const fnIndex = ui.indexOf('const deleteSelectedFolder = async')
  assert.ok(fnIndex > -1)
  const body = ui.slice(fnIndex, fnIndex + 2600)
  assert.match(body, /imageSearchBridge\.executeFolderDataEdit\(folderEditPreview\.token!\)/)
  assert.match(body, /setQueryStats\(null\)/)
  assert.match(body, /void loadFolderStats\(\)/)
})

test('data editor refreshes folder aggregates after single-record edits (M3)', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  for (const handler of [
    'const updateSelected = async',
    'const deleteSelected = async',
    'const repairSelectedPath = async',
  ]) {
    const fnIndex = ui.indexOf(handler)
    assert.ok(fnIndex > -1, handler)
    const body = ui.slice(fnIndex, fnIndex + 1200)
    assert.match(body, /await runQuery\(\)/, `${handler} must re-run the current query`)
    assert.match(body, /void loadFolderStats\(\)/, `${handler} must refresh folder stats`)
  }
})

test('data editor folder-delete confirm gets a fresh multi-layer preview when arming (M3)', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  const fnIndex = ui.indexOf('const deleteSelectedFolder = async')
  assert.ok(fnIndex > -1)
  const body = ui.slice(fnIndex, fnIndex + 1800)
  const armIndex = body.indexOf('setFolderDeleteArmed(true)')
  assert.ok(armIndex > -1, 'arming branch not found')
  const previewBody = body.slice(0, armIndex)
  // The confirm label is armed only after a fresh Native/DINO/CLIP preview.
  assert.match(previewBody, /imageSearchBridge\.previewFolderDataEdit\(selectedFolder, layers\)/)
  assert.match(previewBody, /setFolderEditPreview\(preview\)/)
  // A consumed/expired token must return the UI to analysis rather than loop.
  const executeBody = body.slice(armIndex)
  assert.match(executeBody, /if \(!result\.ok\)[\s\S]*setFolderDeleteArmed\(false\)/)
  assert.match(executeBody, /if \(!result\.ok\)[\s\S]*setFolderEditPreview\(null\)/)
})

test('folder data edit IPC, preload, bridge, and progress/cancel contracts are wired', () => {
  const channels = source('shared/ipc/image-search.ts')
  const contract = source('shared/ipc/electron-api.ts')
  const preload = source('electron/preload.ts')
  const bridge = source('src/services/imageSearchBridge.ts')
  const ipc = source('electron/imageSearchIpc.ts')
  for (const channel of [
    'imageSearch:previewFolderDataEdit',
    'imageSearch:executeFolderDataEdit',
    'imageSearch:getFolderDataEditProgress',
    'imageSearch:cancelFolderDataEdit',
  ]) {
    assert.ok(channels.includes(channel), `missing channel constant ${channel}`)
    assert.ok(ipc.includes(channel), `missing IPC handler ${channel}`)
    assert.ok(preload.includes(channel), `missing preload channel ${channel}`)
  }
  assert.match(contract, /previewFolderDataEdit:[\s\S]*ImageSearchFolderDataEditPreview/)
  assert.match(contract, /executeFolderDataEdit:[\s\S]*ImageSearchFolderDataEditResult/)
  assert.match(bridge, /async previewFolderDataEdit\(/)
  assert.match(bridge, /async executeFolderDataEdit\(/)
  assert.match(bridge, /async cancelFolderDataEdit\(/)
  for (const handler of ['search', 'clearIndex', 'saveIndex', 'loadIndex', 'loadManifest']) {
    const start = ipc.indexOf(`secureIpcMain.handle('imageSearch:${handler}'`)
    assert.ok(start > -1, `missing ${handler} handler`)
    assert.match(
      ipc.slice(start, start + 700),
      /isImageSearchFolderDataEditRunning\(\)|imageSearchEditBusyError\(\)/,
      `${handler} must not race a folder edit`,
    )
  }
  const editBusy = ipc.slice(
    ipc.indexOf('function imageSearchEditBusyError'),
    ipc.indexOf('function configuredImageSearchRoots'),
  )
  assert.match(editBusy, /isImageSearchFolderDataEditRunning\(\)/)
  assert.match(
    source('electron/vectorIpc.ts'),
    /secureIpcMain\.handle\('vector:compactVectorJobs'[\s\S]{0,240}isImageSearchFolderDataEditRunning\(\)/,
  )
})

test('service executable: drive-root purge and path-like boundary filtering', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-folders-'))
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    const insert = (recordPath) =>
      addon.upsertIndexRecord(recordPath, 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210')
    assert.equal(insert('D:\\PxHereDataset\\a.png').ok, true)
    assert.equal(insert('D:\\PxHereDataset2\\b.png').ok, true)
    assert.equal(insert('D:\\Other\\keep.png').ok, true)

    // M1/M2: a path-like query (forward slashes included) matches only the exact
    // subtree, not sibling prefixes like PxHereDataset2.
    const queried = svc.queryImageSearchData('D:/PxHereDataset', 0, 50)
    assert.equal(queried.ok, true)
    assert.deepEqual(
      queried.records.map((record) => record.path),
      ['D:\\PxHereDataset\\a.png'],
    )
    // Non-path-like queries keep the native substring behavior.
    const substring = svc.queryImageSearchData('pxhere', 0, 50)
    assert.equal(substring.ok, true)
    assert.equal(substring.records.length, 2)

    // H1: a scan path that is a drive root must allow purging its children.
    const purged = await svc.deleteImageSearchDataFolder('D:\\PxHereDataset', ['D:\\'])
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 1)
    assert.equal(addon.hasIndexPath('D:\\PxHereDataset\\a.png'), false)
    assert.equal(addon.hasIndexPath('D:\\PxHereDataset2\\b.png'), true)
    assert.equal(addon.hasIndexPath('D:\\Other\\keep.png'), true)

    // Containment still rejects folders outside every configured root.
    const rejected = await svc.deleteImageSearchDataFolder('C:\\Windows', ['D:\\'])
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /outside the configured scan paths/)
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('service persists an explicitly empty manifest when an edit purges the last records (H3)', () => {
  const service = source('electron/imageSearchDataService.ts')
  assert.match(service, /function persistEmptyImageIndex\(rootDir: string\)/)
  assert.match(service, /function isImageIndexEffectivelyEmpty\(\)/)
  // Emptiness uses the same visibility rules as the save snapshot.
  const emptyIndex = service.indexOf('function isImageIndexEffectivelyEmpty')
  const emptyBody = service.slice(emptyIndex, emptyIndex + 500)
  assert.match(emptyBody, /getIndexPathStats\(''\)/)
  const fnIndex = service.indexOf('async function persistImageIndexEdits')
  const body = service.slice(fnIndex, fnIndex + 1600)
  assert.match(body, /'No records to save'/)
  assert.match(body, /isImageIndexEffectivelyEmpty\(\)/)
  assert.match(body, /persistEmptyImageIndexAndCapture\(rootDir\)/)
  // The empty manifest keeps schemaVersion 2 with zero segments; orphaned
  // segments and the overlay are dropped best-effort so repair cannot revive.
  const fnIndex2 = service.indexOf('function persistEmptyImageIndex')
  const body2 = service.slice(fnIndex2, fnIndex2 + 1800)
  assert.match(body2, /schemaVersion: 2/)
  assert.match(body2, /segments: \[\]/)
  assert.match(body2, /overlay\.json/)
})

test('service folder purge also removes project preview records under the folder (H2)', () => {
  const service = source('electron/imageSearchDataService.ts')
  assert.match(
    service,
    /import \{[^}]*getProjectSearchEntriesInFolder[^}]*\} from '\.\/projectSearchIndexService'/,
  )
  const fnIndex = service.indexOf('async function deleteImageSearchDataFolder')
  const body = service.slice(fnIndex, fnIndex + 2500)
  assert.match(body, /getProjectSearchEntriesInFolder\(folder\)/)
  assert.match(body, /addon\.deleteIndexPath\(entry\.previewPath\)/)
  assert.match(body, /removeImageData\(entry\.sourcePath\)/)
  const projectIndex = source('electron/projectSearchIndexService.ts')
  assert.match(
    projectIndex,
    /export function getProjectSearchEntriesInFolder\(folder: string\): ProjectPreviewManifestEntry\[\]/,
  )
  assert.match(projectIndex, /path\.relative\(normalizedFolder, normalizedSource\)/)
})

test('service executable: purging the last records persists an empty index (H3)', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-empty-'))
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    assert.equal(
      addon.upsertIndexRecord('D:\\Solo\\a.png', 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210')
        .ok,
      true,
    )
    const result = await svc.deleteImageSearchDataFolder('D:\\Solo', ['D:\\'])
    assert.equal(result.ok, true)
    assert.equal(result.recordCount, 0)
    assert.equal(addon.hasIndexPath('D:\\Solo\\a.png'), false)
    // The empty state is persisted: manifest exists with zero segments. The
    // index root comes from the service status because the module-level status
    // is shared with earlier executable tests in this file.
    const indexRoot = svc.getImageSearchStatus().segmentPath
    assert.ok(indexRoot, 'segmentPath should be set after persist')
    const manifest = JSON.parse(fs.readFileSync(path.join(indexRoot, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.segments, [])
    // Restart: the index must not revive. Native loadManifest refuses an empty
    // manifest ("No segments in manifest") and the in-memory index stays empty.
    addon.clearIndex()
    addon.loadManifest(indexRoot)
    assert.equal(addon.getIndexStats().indexedCount, 0)
    assert.equal(addon.hasIndexPath('D:\\Solo\\a.png'), false)
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('service executable: source purge physically retires the last mmap segment', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-empty-segment-'))
  const sourceRoot = path.join(tmp, 'source')
  const indexRoot = path.join(tmp, 'index')
  fs.mkdirSync(sourceRoot, { recursive: true })
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    const imagePath = path.join(sourceRoot, 'only.png')
    assert.equal(
      addon.upsertIndexRecord(imagePath, 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210').ok,
      true,
    )
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)
    assert.equal(addon.getIndexMode().segmentCount, 1)

    const result = await svc.deleteImageSearchDataFolder(sourceRoot, [sourceRoot], {
      compactAfterDelete: true,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.recordCount, 0)
    const manifest = JSON.parse(fs.readFileSync(path.join(indexRoot, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.segments, [])
    assert.deepEqual(
      fs.readdirSync(path.join(indexRoot, 'segments')).filter((name) => name.endsWith('.idx')),
      [],
    )
  } finally {
    addon.clearIndex()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('service executable: folder purge removes project preview records too (H2)', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  let sharp
  let AdmZip
  try {
    sharp = require('sharp')
    AdmZip = require('adm-zip')
  } catch {
    t.skip('sharp/adm-zip unavailable')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const projectIndex = loadTsModule('electron/projectSearchIndexService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-project-'))
  const scanDir = path.join(tmp, 'scanned')
  fs.mkdirSync(scanDir, { recursive: true })
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    await projectIndex.initProjectSearchIndex(tmp)
    // Build a real Krita project file inside the scanned folder.
    const merged = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 20, b: 20 } },
    })
      .png()
      .toBuffer()
    const archive = new AdmZip()
    archive.addFile('mergedimage.png', merged)
    const sourcePath = path.join(scanDir, 'art.kra')
    archive.writeZip(sourcePath)

    addon.clearIndex()
    const indexed = await projectIndex.indexProjectPreviews([scanDir], {
      hashImageAsync: (filePath) => addon.hashImageAsync(filePath),
      upsertIndexRecord: (...args) => addon.upsertIndexRecord(...args),
      deleteIndexPath: (filePath) => addon.deleteIndexPath(filePath),
      removeSourceVectorData: () => {},
    })
    assert.equal(indexed.indexed, 1)
    // The indexed record lives at the preview path but displays as the source.
    const metadata = projectIndex.getProjectSearchMetadata(sourcePath)
    assert.ok(metadata && metadata.previewPath, 'project preview metadata missing')
    const previewPath = metadata.previewPath
    assert.equal(addon.hasIndexPath(previewPath), true)
    const listed = svc.queryImageSearchData('', 0, 50)
    assert.ok(
      listed.records.some((record) => record.path === sourcePath),
      'project record should be listed under its source path',
    )

    const purged = await svc.deleteImageSearchDataFolder(scanDir, [scanDir])
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 1)
    assert.equal(addon.hasIndexPath(previewPath), false)
    const after = svc.queryImageSearchData('', 0, 50)
    assert.ok(
      !after.records.some((record) => record.path === sourcePath),
      'purged project record must not linger in the list',
    )
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('service bulk source deletion prefers async Native and preserves sync and legacy fallbacks', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-async-bulk-delete-'))
  const asyncPath = path.join(tmp, 'async.png')
  const syncPath = path.join(tmp, 'sync.png')
  const legacyPath = path.join(tmp, 'legacy.png')
  const keepPath = path.join(tmp, 'keep.png')
  const realPaged = addon.deleteIndexPathsPagedAsync
  addon.deleteIndexPathsPagedAsync = undefined
  const realAsync = addon.deleteIndexPathsAsync
  const realSync = addon.deleteIndexPaths
  const realSingle = addon.deleteIndexPath
  let asyncCalls = 0
  let syncCalls = 0
  let legacyCalls = 0
  try {
    vectorDb.initVectorDatabase(tmp)
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    for (const [index, recordPath] of [asyncPath, syncPath, legacyPath, keepPath].entries()) {
      assert.equal(
        addon.upsertIndexRecord(
          recordPath,
          1,
          1,
          1,
          index + 1,
          (index + 1).toString(16).padStart(16, '0'),
          (index + 101).toString(16).padStart(16, '0'),
        ).ok,
        true,
      )
    }
    const indexRoot = path.join(tmp, 'index')
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)
    await svc.captureImageSearchLoadedIndexIdentity(indexRoot)

    addon.deleteIndexPathsAsync = async (paths) => {
      asyncCalls += 1
      return realAsync.call(addon, paths)
    }
    addon.deleteIndexPaths = () => {
      syncCalls += 1
      throw new Error('sync bulk delete must not run while async is available')
    }
    const asyncDeleted = await svc.deleteImageSearchDataPaths([asyncPath])
    assert.equal(asyncDeleted.ok, true, JSON.stringify(asyncDeleted))
    assert.equal(asyncDeleted.removedCount, 1)
    assert.equal(asyncCalls, 1)
    assert.equal(syncCalls, 0)

    addon.deleteIndexPathsAsync = undefined
    addon.deleteIndexPaths = (paths) => {
      syncCalls += 1
      return realSync.call(addon, paths)
    }
    const syncDeleted = await svc.deleteImageSearchDataPaths([syncPath])
    assert.equal(syncDeleted.ok, true, JSON.stringify(syncDeleted))
    assert.equal(syncDeleted.removedCount, 1)
    assert.equal(syncCalls, 1)

    addon.deleteIndexPaths = undefined
    addon.deleteIndexPath = (recordPath) => {
      legacyCalls += 1
      return realSingle.call(addon, recordPath)
    }
    const legacyDeleted = await svc.deleteImageSearchDataPaths([legacyPath])
    assert.equal(legacyDeleted.ok, true, JSON.stringify(legacyDeleted))
    assert.equal(legacyDeleted.removedCount, 1)
    assert.equal(legacyCalls, 1)
    assert.equal(addon.hasIndexPath(keepPath), true)
  } finally {
    addon.deleteIndexPathsPagedAsync = realPaged
    addon.deleteIndexPathsAsync = realAsync
    addon.deleteIndexPaths = realSync
    addon.deleteIndexPath = realSingle
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('direct image-index edits register vector writers and source sync uses its exclusive owner', async (t) => {
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const maintenance = loadTsModule('electron/vectorMaintenanceService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-vector-writer-'))
  let releaseSearch
  let releaseExclusive
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }

    releaseSearch = maintenance.tryAcquireVectorSearchReservation()
    assert.equal(typeof releaseSearch, 'function')
    const blocked = await svc.deleteImageSearchData(path.join(tmp, 'missing.png'))
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /Vector search or exclusive maintenance/)
    assert.equal(svc.isImageSearchIndexMutationRunning(), false)
    releaseSearch()
    releaseSearch = undefined

    releaseExclusive = maintenance.tryAcquireVectorExclusiveMaintenance()
    assert.equal(typeof releaseExclusive, 'function')
    const unowned = await svc.deleteImageSearchDataPaths([], undefined, {
      sourceVectorIntentPrepared: true,
    })
    assert.equal(unowned.ok, false)
    assert.match(unowned.error, /Vector search or exclusive maintenance/)

    const owned = await svc.deleteImageSearchDataPaths([], undefined, {
      sourceVectorIntentPrepared: true,
      vectorMaintenanceLease: releaseExclusive,
    })
    assert.deepEqual(owned, {
      ok: true,
      removedCount: 0,
      vectorRecordsRemoved: 0,
      warnings: [],
    })
    assert.equal(svc.isImageSearchIndexMutationRunning(), false)
  } finally {
    releaseSearch?.()
    releaseExclusive?.()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('service marks failed edit persists for automatic retry (M4)', () => {
  const service = source('electron/imageSearchService.ts')
  const implementation = source('electron/imageSearchDataService.ts')
  assert.match(service, /let editPersistRetryPending = false/)
  const fnIndex = implementation.indexOf('async function persistImageIndexEdits')
  const body = implementation.slice(fnIndex, fnIndex + 2200)
  assert.match(body, /setEditPersistRetryPending\(true\)/)
  assert.match(body, /will retry saving automatically/)
  // The retry fires on the next autosave opportunity (scan completion chain).
  const autosaveIndex = service.indexOf('function autosaveDirtyIndex')
  const autosaveBody = service.slice(autosaveIndex, autosaveIndex + 1400)
  assert.match(autosaveBody, /editPersistRetryPending/)
  assert.match(autosaveBody, /persistImageIndexEdits\(\)/)
})

test('edit IPC handlers refuse edits while vector GC or storage cleanup is active (M6)', () => {
  const ipc = source('electron/imageSearchIpc.ts')
  const guardIndex = ipc.indexOf('function imageSearchEditBusyError')
  assert.ok(guardIndex > -1, 'imageSearchEditBusyError helper missing')
  const guardEnd = ipc.indexOf('\nfunction configuredImageSearchRoots', guardIndex)
  assert.ok(guardEnd > guardIndex, 'imageSearchEditBusyError helper boundary missing')
  const guardBody = ipc.slice(guardIndex, guardEnd)
  assert.match(guardBody, /isVectorGcRunning\(\)/)
  assert.match(guardBody, /isStorageCleanupActiveFor\('image-search'\)/)
  assert.match(guardBody, /Vector GC is using the active Image Search index/)
  assert.match(guardBody, /Image Search storage cleanup is running/)
  for (const channel of [
    'imageSearch:updateData',
    'imageSearch:deleteData',
    'imageSearch:deleteDataFolder',
    'imageSearch:repairDataPath',
  ]) {
    const fnIndex = ipc.indexOf(`'${channel}'`)
    assert.ok(fnIndex > -1, channel)
    const body = ipc.slice(fnIndex, fnIndex + 900)
    assert.match(body, /imageSearchEditBusyError\(\)/, `${channel} must check the busy guard`)
  }
})

test('clearImageIndex persists the empty index so it does not revive on restart', () => {
  const service = source('electron/imageSearchService.ts')
  const fnIndex = service.indexOf('export function clearImageIndex')
  assert.ok(fnIndex > -1)
  const body = service.slice(fnIndex, fnIndex + 900)
  assert.match(body, /nativeAddon\.clearIndex\(\)/)
  assert.match(body, /manifest\.json/)
  assert.match(body, /persistEmptyImageIndex\(/)
})

test('manual manifest load persists generated-thumbnail cleanup before identity capture', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-manual-load-'))
  const indexRoot = path.join(tmp, 'index')
  const generatedPath = path.join(tmp, 'thumbcache', 'generated.jpg')
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    assert.equal(
      addon.upsertIndexRecord(generatedPath, 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210').ok,
      true,
    )
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)
    addon.clearIndex()

    const loaded = svc.loadManifest(indexRoot)
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    assert.equal(loaded.recordCount, 0)

    addon.clearIndex()
    const reloaded = addon.loadManifest(indexRoot)
    assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
    assert.equal(reloaded.recordCount, 0)
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('manifest repair does not clear the identity of the currently loaded Native index', () => {
  const service = source('electron/imageSearchService.ts')
  const fnIndex = service.indexOf('export function repairManifest')
  assert.ok(fnIndex > -1)
  const body = service.slice(fnIndex, fnIndex + 650)
  assert.doesNotMatch(body, /clearLoadedIndexIdentity/)
  assert.match(body, /repairManifestFromSegments/)
})

test('service executable: clearImageIndex writes the empty manifest to disk', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-clear-'))
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    addon.clearIndex()
    const insert = (recordPath) =>
      addon.upsertIndexRecord(recordPath, 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210')
    assert.equal(insert('D:\\ClearMe\\a.png').ok, true)
    assert.equal(insert('D:\\Keep\\b.png').ok, true)
    // Land a manifest on disk first so there is something to revive from.
    const firstPurge = await svc.deleteImageSearchDataFolder('D:\\ClearMe', ['D:\\'])
    assert.equal(firstPurge.ok, true)
    const indexRoot = svc.getImageSearchStatus().segmentPath
    assert.ok(indexRoot, 'segmentPath should be set after persist')

    const cleared = svc.clearImageIndex()
    assert.equal(cleared.ok, true)
    const manifest = JSON.parse(fs.readFileSync(path.join(indexRoot, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.segments, [])
    // Restart: nothing revives.
    addon.loadManifest(indexRoot)
    assert.equal(addon.getIndexStats().indexedCount, 0)
    assert.equal(addon.hasIndexPath('D:\\Keep\\b.png'), false)
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('imageSearch:getDirNameStats and imageSearch:deleteDirName channel constants are registered', () => {
  const channels = source('shared/ipc/image-search.ts')
  assert.match(channels, /GET_DIR_NAME_STATS:\s*'imageSearch:getDirNameStats'/)
  assert.match(channels, /DELETE_DIR_NAME:\s*'imageSearch:deleteDirName'/)
})

test('ipc contract exposes directory-name stats and delete', () => {
  const contract = source('shared/ipc/electron-api.ts')
  assert.match(
    contract,
    /getDirNameStats:\s*\(name:\s*string\)\s*=>\s*Promise<ImageSearchDataStatsResult>/,
  )
  assert.match(
    contract,
    /deleteDirName:\s*\(name:\s*string\)\s*=>\s*Promise<ImageSearchDataEditResult>/,
  )
})

test('preload exposes directory-name channels', () => {
  const preload = source('electron/preload.ts')
  assert.match(
    preload,
    /getDirNameStats:\s*\(name\)\s*=>\s*ipcRenderer\.invoke\('imageSearch:getDirNameStats', name\)/,
  )
  assert.match(
    preload,
    /deleteDirName:\s*\(name\)\s*=>\s*ipcRenderer\.invoke\('imageSearch:deleteDirName', name\)/,
  )
})

test('renderer bridge wraps directory-name calls with safe fallback', () => {
  const bridge = source('src/services/imageSearchBridge.ts')
  assert.match(bridge, /async getDirNameStats\(name: string\): Promise<ImageSearchDataStatsResult>/)
  assert.match(
    bridge,
    /if \(!a\?\.getDirNameStats\) throw new Error\('electronAPI not available'\)/,
  )
  assert.match(bridge, /return await a\.getDirNameStats\(name\)/)
  assert.match(bridge, /async deleteDirName\(name: string\): Promise<ImageSearchDataEditResult>/)
  assert.match(bridge, /if \(!a\?\.deleteDirName\) throw new Error\('electronAPI not available'\)/)
  assert.match(bridge, /return await a\.deleteDirName\(name\)/)
})

test('service validates the directory name and delegates to the segment primitives', () => {
  const service = source('electron/imageSearchDataService.ts')
  // Name rule mirrors native normalize_segment_name: trim, fold slashes,
  // lowercase, reject empty/nested/shorter-than-2 names.
  const normIndex = service.indexOf('function normalizeDirNameArg')
  assert.ok(normIndex > -1)
  const normBody = service.slice(normIndex, normIndex + 500)
  assert.match(normBody, /\.trim\(\)/)
  assert.match(normBody, /\.toLowerCase\(\)/)
  assert.match(normBody, /normalized\.length < 2 \|\| normalized\.includes\('\\\\'\)/)

  const statsIndex = service.indexOf('function getImageSearchDirNameStats')
  assert.ok(statsIndex > -1)
  const statsBody = service.slice(statsIndex, statsIndex + 900)
  assert.match(statsBody, /typeof addon\.getIndexPathSegmentStats !== 'function'/)
  assert.match(statsBody, /addon\.getIndexPathSegmentStats\(normalized\)/)
  assert.match(statsBody, /Invalid directory name/)

  const purgeIndex = service.indexOf('async function deleteImageSearchDirName')
  assert.ok(purgeIndex > -1)
  const purgeBody = service.slice(purgeIndex, purgeIndex + 1200)
  assert.match(purgeBody, /typeof addon\.purgeIndexPathSegment !== 'function'/)
  assert.match(purgeBody, /addon\.purgeIndexPathSegment\(normalized\)/)
  // Directory-name purge is location-agnostic: no scan-path root validation,
  // but edits are persisted like the folder purge.
  assert.doesNotMatch(purgeBody, /allowedRoots/)
  assert.match(purgeBody, /await persistImageIndexEdits\(\)/)
  assert.match(purgeBody, /removedCount: Number\(purged\.removedCount\) \|\| 0/)
})

test('ipc handlers bound the directory name and guard the delete like other edits', () => {
  const ipc = source('electron/imageSearchIpc.ts')
  assert.match(ipc, /secureIpcMain\.handle\('imageSearch:getDirNameStats'/)
  assert.match(ipc, /secureIpcMain\.handle\('imageSearch:deleteDirName'/)
  const delIndex = ipc.indexOf("secureIpcMain.handle('imageSearch:deleteDirName'")
  const delBody = ipc.slice(delIndex, delIndex + 800)
  assert.match(delBody, /imageSearchEditBusyError\(\)/)
  assert.match(delBody, /rawName === 'string' \? rawName\.slice\(0, 256\) : ''/)
  assert.match(delBody, /deleteImageSearchDirName\(name\)/)
  // Location-agnostic by design: no settings scan-path lookup.
  assert.doesNotMatch(delBody, /imageSearchScanPaths/)
  assert.match(ipc, /import \{[^}]*getImageSearchDirNameStats[^}]*\} from '\.\/imageSearchService'/)
  assert.match(ipc, /import \{[^}]*deleteImageSearchDirName[^}]*\} from '\.\/imageSearchService'/)
})

test('native addon exports the segment-name stats and purge primitives', () => {
  const native = source('native/fast_scanner.cc')
  assert.match(native, /static napi_value GetIndexPathSegmentStats\(/)
  assert.match(native, /static napi_value PurgeIndexPathSegment\(/)
  assert.match(native, /xfn\("getIndexPathSegmentStats",GetIndexPathSegmentStats\)/)
  assert.match(native, /xfn\("purgeIndexPathSegment",PurgeIndexPathSegment\)/)
  assert.match(native, /"Invalid directory name"/)
  // Segment predicate: normalized path contains the '\<name>\' segment.
  assert.match(native, /const std::string needle="\\\\"\+name\+"\\\\";/)
})

test('data editor UI offers directory-name stats and a two-step directory-name delete', () => {
  const ui = source('src/components/ImageSearchDataManager.tsx')
  // Bare-name queries (no separator) enter directory-name mode.
  assert.match(ui, /!term\.includes\('\\\\'\)/)
  assert.match(ui, /imageSearchBridge\.getDirNameStats\(term\)/)
  assert.match(ui, /t\("Directory name '\{name\}': Total: \{count\} records · \{size\}"/)
  // The delete button only appears with hits and confirms with live numbers.
  assert.match(ui, /dirNameStats\.count > 0/)
  assert.match(ui, /if \(!dirNameDeleteArmed\) \{/)
  assert.match(ui, /imageSearchBridge\.deleteDirName\(dirNameStats\.name\)/)
  assert.match(ui, /t\('Delete By Directory Name'\)/)
  assert.match(
    ui,
    /t\(\s*"Removes \{count\} index records \(\{size\}\) from every folder named '\{name\}'; source files are not deleted"/,
  )
  assert.match(ui, /result\.removedCount \|\| 0/)
  // Success clears the list and both stats views, then refreshes folder stats.
  const fnIndex = ui.indexOf('const deleteDirNameRecords = async')
  assert.ok(fnIndex > -1)
  const body = ui.slice(fnIndex, fnIndex + 1600)
  assert.match(body, /setDirNameStats\(null\)/)
  assert.match(body, /setRecords\(\[\]\)/)
  assert.match(body, /setQueryStats\(null\)/)
  assert.match(body, /void loadFolderStats\(\)/)
  assert.match(body, /onChanged\(\)/)
})

test('new directory-name strings have Chinese translations', () => {
  const i18n = source('src/i18n/core.ts')
  for (const key of [
    "Directory name '{name}': Total: {count} records · {size}",
    'Delete By Directory Name',
    "Removes {count} index records ({size}) from every folder named '{name}'; source files are not deleted",
    "Deleted {count} index records for directory name '{name}'; rebuild DINO/CLIP embeddings manually if needed",
    'Deletes index records under every folder with this name, at any location. Source images are never deleted.',
  ]) {
    assert.ok(
      i18n.includes(`'${key}':`) || i18n.includes(`"${key}":`),
      `missing translation for ${key}`,
    )
  }
})

test('service paged snapshot yields between pages and closes on cancellation or invalid pages', async () => {
  const { loadTsModule } = require('./guard-utils.cjs')
  const { createImageSearchDataService } = loadTsModule('electron/imageSearchDataService.ts')
  const records = Array.from({ length: 600 }, (_, i) => ({
    path: path.resolve(`fixture-${i}.png`),
    width: 1,
    height: 1,
    fileSize: 1,
    modifiedTime: 1,
  }))
  let closed = 0
  let reads = 0
  let invalid = false
  let turns = 0
  const addon = {
    snapshotIndexRecordsAsync: async () => ({
      ok: true,
      cursor: 'test-cursor',
      recordCount: records.length,
      scanned: records.length,
    }),
    readIndexExportPage: (_cursor, offset, limit) => {
      reads += 1
      assert.ok(turns >= reads, 'consumer must yield before every page')
      const page = records.slice(offset, offset + limit)
      return {
        ok: !invalid,
        records: page,
        nextOffset: offset + page.length,
        hasMore: offset + page.length < records.length,
        error: invalid ? 'injected page failure' : undefined,
      }
    },
    closeIndexExport: async () => {
      closed += 1
      return { ok: true }
    },
    snapshotIndexRecords: () => {
      throw new Error('synchronous snapshot must not run')
    },
  }
  const service = createImageSearchDataService({ getNativeAddon: () => addon })
  let ticking = true
  const tick = () => {
    turns += 1
    if (ticking) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    const result = await service.snapshotImageSearchData()
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.records,
      records.map((record) => ({ ...record, exists: undefined })),
    )
    assert.equal(reads, 3)
    assert.equal(closed, 1)
    let checks = 0
    const cancelled = await service.snapshotImageSearchData(() => ++checks > 2)
    assert.equal(cancelled.ok, false)
    assert.match(cancelled.error, /cancelled/)
    assert.equal(closed, 2)
    invalid = true
    const failed = await service.snapshotImageSearchData()
    assert.equal(failed.ok, false)
    assert.match(failed.error, /injected page failure/)
    assert.equal(closed, 3)
  } finally {
    ticking = false
  }
})

test('service preserves committed deletion count and closes cursor when a result page fails', async () => {
  const { loadTsModule } = require('./guard-utils.cjs')
  const { createImageSearchDataService } = loadTsModule('electron/imageSearchDataService.ts')
  let closed = 0
  let legacyCalled = false
  const addon = {
    deleteIndexPathsPagedAsync: async () => ({
      ok: true,
      cursor: 'committed',
      removedCount: 300,
      missingCount: 0,
      remainingCount: 0,
    }),
    deleteIndexPathsAsync: async () => {
      legacyCalled = true
      throw new Error('unbounded result')
    },
    readIndexExportPage: () => ({ ok: false, error: 'injected read failure after commit' }),
    closeIndexExport: async () => {
      closed += 1
      return { ok: true }
    },
  }
  const service = createImageSearchDataService({ getNativeAddon: () => addon })
  const result = await service.deleteImageSearchDataPaths(
    Array.from({ length: 300 }, (_, i) => path.resolve(`fixture-${i}.png`)),
    undefined,
    { sourceVectorIntentPrepared: true },
  )
  assert.equal(result.ok, false)
  assert.equal(result.removedCount, 300)
  assert.equal(result.vectorRecordsRemoved, 0)
  assert.match(result.error, /after commit/)
  assert.equal(closed, 1)
  assert.equal(legacyCalled, false)
})

test('legacy Native large snapshots and delete batches fail before synchronous work', async () => {
  const { loadTsModule } = require('./guard-utils.cjs')
  const { createImageSearchDataService } = loadTsModule('electron/imageSearchDataService.ts')
  const addon = {
    getIndexMode: () => ({ recordCount: 300 }),
    snapshotIndexRecords: () => {
      throw new Error('unsafe full snapshot')
    },
    deleteIndexPathsAsync: async () => {
      throw new Error('unsafe full result')
    },
  }
  const service = createImageSearchDataService({ getNativeAddon: () => addon })
  assert.match((await service.snapshotImageSearchData()).error, /Update the Native scanner/)
  const result = await service.deleteImageSearchDataPaths(
    Array.from({ length: 300 }, (_, i) => path.resolve(`fixture-${i}.png`)),
  )
  assert.equal(result.removedCount, 0)
  assert.match(result.error, /Update the Native scanner/)
})
