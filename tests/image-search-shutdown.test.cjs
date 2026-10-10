const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repo = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(repo, relativePath), 'utf8')
}

test('imageSearchService declares and calls the native cancelAsyncWork handshake', () => {
  // The native addon surface types live in imageSearchNativeTypes.ts (VAL-033).
  const nativeTypes = source('electron/imageSearchNativeTypes.ts')
  assert.match(nativeTypes, /cancelAsyncWork\?\(\): \{/)
  assert.match(nativeTypes, /cooperativeRequested: number/)
  assert.match(nativeTypes, /nativeCancelAccepted: number/)
  assert.match(nativeTypes, /asyncWorkActiveCount\?: number/)
  assert.match(nativeTypes, /asyncWorkCancellationMode\?: string/)
  const service = source('electron/imageSearchService.ts')
  assert.match(service, /nativeAddon\.cancelAsyncWork\?\.\(\)/)
})

test('imageSearchService exports shutdownImageSearchForQuit with scan stop and autosave tracking', () => {
  const service = source('electron/imageSearchService.ts')
  assert.match(service, /export function shutdownImageSearchForQuit\(\): Promise<void>/)
  assert.match(service, /await stopImageSearchScan\(\)/)
  assert.match(service, /autosavePromise\s*=\s*Promise\.resolve\(\)/)
  assert.match(service, /resolveIndexIdentity\(savePath\)/)
  assert.match(service, /addon\.saveIndexToManifestAsync\(savePath\)/)
  assert.match(service, /await autosavePromise/)
  // Drain loop must be bounded so quit can never hang.
  assert.match(service, /drainDeadline = Date\.now\(\) \+ 5000/)
  // Idempotent re-entry guard.
  assert.match(service, /if \(imageSearchShutdownPromise\) return imageSearchShutdownPromise/)
})

test('quit shutdown stops any in-flight native thumbnail rebuild first', () => {
  const service = source('electron/imageSearchService.ts')
  // Service-level stop exists and degrades safely without the native addon.
  assert.match(service, /export function stopNativeThumbnailRebuild\(\): \{ ok: boolean \}/)
  assert.match(service, /nativeAddon\?\.stopNativeThumbnailRebuild\?\.\(\) \|\| \{ ok: false \}/)
  // The quit handshake must call it before draining native async work.
  const shutdownIndex = service.indexOf('export function shutdownImageSearchForQuit()')
  const stopIndex = service.indexOf('stopNativeThumbnailRebuild()', shutdownIndex)
  const drainIndex = service.indexOf('drainDeadline = Date.now() + 5000', shutdownIndex)
  assert.ok(shutdownIndex > -1 && stopIndex > -1 && drainIndex > -1)
  assert.ok(stopIndex < drainIndex)
})

test('main.ts will-quit prevents default, awaits shutdown, and guards re-entry', () => {
  const main = source('electron/main.ts')
  assert.match(
    main,
    /import \{[^}]*shutdownImageSearchForQuit[^}]*\} from '\.\/imageSearchService'/,
  )
  assert.match(main, /let imageSearchShutdownRequested = false/)
  assert.match(main, /app\.on\('will-quit', \(event\) => \{/)
  assert.match(main, /imageSearchShutdownRequested = true/)
  assert.match(main, /event\.preventDefault\(\)/)
  assert.match(main, /shutdownImageSearchForQuit\(\)/)
  assert.match(main, /\.finally\(\(\) => app\.quit\(\)\)/)
  // Existing cleanup lines remain after the shutdown handshake.
  assert.match(main, /disposeVectorAnnWorker\(\)/)
  assert.match(main, /disconnectAll\(\)/)
  assert.match(main, /globalShortcut\.unregisterAll\(\)/)
  // Shutdown handshake must run before the vector worker disposal.
  const shutdownIndex = main.indexOf('shutdownImageSearchForQuit()')
  const disposeIndex = main.indexOf('disposeVectorAnnWorker()', shutdownIndex)
  assert.ok(shutdownIndex > -1 && disposeIndex > -1 && shutdownIndex < disposeIndex)
})

test('catalog controller shutdown is wired into will-quit with a bounded wait', () => {
  const catalog = source('electron/imageSearchDataCatalogService.ts')
  assert.match(
    catalog,
    /export async function shutdownImageSearchDataCatalogForQuit\(\): Promise<void>/,
  )
  // Cooperative cancel of the worker-backed build must precede the wait.
  const shutdownIndex = catalog.indexOf('shutdownImageSearchDataCatalogForQuit()')
  const cancelIndex = catalog.indexOf('cancelImageSearchDataCatalogBuild()', shutdownIndex)
  const raceIndex = catalog.indexOf('Promise.race([', shutdownIndex)
  assert.ok(shutdownIndex > -1 && cancelIndex > -1 && raceIndex > -1)
  assert.ok(cancelIndex < raceIndex)
  // The wait is bounded so quit can never hang on the catalog worker.
  assert.match(catalog, /setTimeout\(resolve, 5_000\)/)
  const main = source('electron/main.ts')
  assert.match(
    main,
    /import \{[^}]*shutdownImageSearchDataCatalogForQuit[^}]*\} from '\.\/imageSearchDataCatalogService'/,
  )
  assert.match(main, /shutdownImageSearchDataCatalogForQuit\(\)/)
})

test('uiSmokeService app.exit path runs the same shutdown handshake first', () => {
  const smoke = source('electron/uiSmokeService.ts')
  // app.exit() bypasses will-quit, so the smoke-mode exit must run the
  // idempotent handshake itself before exiting.
  assert.match(
    smoke,
    /import \{[^}]*shutdownImageSearchForQuit[^}]*\} from '\.\/imageSearchService'/,
  )
  assert.match(
    smoke,
    /import \{[^}]*shutdownImageSearchDataCatalogForQuit[^}]*\} from '\.\/imageSearchDataCatalogService'/,
  )
  const handshakeIndex = smoke.indexOf(
    'Promise.all([shutdownImageSearchForQuit(), shutdownImageSearchDataCatalogForQuit()])',
  )
  const exitIndex = smoke.indexOf('app.exit(ok ? 0 : 1)', handshakeIndex)
  assert.ok(handshakeIndex > -1 && exitIndex > -1 && handshakeIndex < exitIndex)
  // Exit must be deferred until the handshake settles, even on failure.
  assert.match(smoke, /\.finally\(\(\) => app\.exit\(ok \? 0 : 1\)\)/)
})

test('no worker or child process loads the fast_scanner addon directly', () => {
  // The addon is a per-env AddonContext; only the main-process
  // imageSearchService may load it. A worker/child that starts loading it
  // would need its own shutdown handshake, so fail loudly here.
  const electronDir = path.join(repo, 'electron')
  const workers = fs.readdirSync(electronDir).filter((name) => /(?:Worker|Child)\.ts$/.test(name))
  assert.ok(workers.length > 0)
  for (const name of workers) {
    const content = fs.readFileSync(path.join(electronDir, name), 'utf8')
    assert.ok(
      !/fast_scanner|fast_scanner\.node/.test(content),
      `${name} must not load the fast_scanner addon without a shutdown handshake`,
    )
  }
  const service = source('electron/imageSearchService.ts')
  assert.match(service, /fast_scanner\.node/)
})
