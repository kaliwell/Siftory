// Read-only location resolution for maintenance CLIs. Never adopts an unmarked
// directory, repairs bootstrap state, or silently falls back from an offline disk.
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { StorageLocationService, localStorageDirectory, readLibraryId, readStoragePathAliases } =
  loadTsModule('electron/storageLocationService.ts')
const resolver = loadTsModule('electron/storagePathResolver.ts')

function locationService() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return new StorageLocationService(appData, path.join(appData, 'floating-clock-electron'))
}

function defaultMaintenanceRoot() {
  const service = locationService()
  if (service.read()?.pending) throw new Error('Finish or cancel the pending data migration first')
  return service.resolveRoot()
}

function validateMaintenanceRoot(directory) {
  const root = localStorageDirectory(directory)
  const libraryId = readLibraryId(root)
  readStoragePathAliases(root)
  const service = locationService()
  const state = service.read()
  if (state?.libraryId === libraryId) {
    if (state.pending) throw new Error('Finish or cancel the pending data migration first')
    if (root !== service.resolveRoot())
      throw new Error('This is a retained copy; select the active library data directory')
  }
  return root
}

function bindMaintenanceStorageRoot(directory) {
  const root = validateMaintenanceRoot(directory)
  const previousRoot = resolver.getConfiguredStorageRoot()
  const previousAliases = previousRoot ? readStoragePathAliases(previousRoot) : []
  resolver.configureStoragePathResolver(root, readStoragePathAliases(root))
  return () => resolver.configureStoragePathResolver(previousRoot || '', previousAliases)
}

module.exports = { defaultMaintenanceRoot, validateMaintenanceRoot, bindMaintenanceStorageRoot }
