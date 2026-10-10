// Model Platform fixture installer for integration tests.
//
// After the Model Platform migration, runtime services resolve ONNX models
// exclusively from user model slots under app.getPath('userData')/models —
// never from the repository models/ directory. Integration tests must
// therefore install their fixture models into an ISOLATED temporary
// userData root and stub the electron module BEFORE loading any service
// via guard-utils loadTsModule().
//
// Usage (order matters — call installModelPlatformFixtures first):
//
//   const { loadTsModule } = require('./guard-utils.cjs')
//   const { installModelPlatformFixtures } = require('./model-fixture-utils.cjs')
//   const modelFixture = installModelPlatformFixtures([
//     { slotId: 'face-detector', source: 'models/yolov8n-face/model.onnx' },
//   ])
//   const fm = loadTsModule('electron/faceMatchService.ts')
//   test('...', { skip: !modelFixture.present }, async () => { ... })
//
// The repository models/ files are only the fixture SOURCE; the services
// under test see them solely through the isolated Model Platform slots.
// The real user model slots are never read or written.

const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { getUserModelSlotDefinition } = loadTsModule('shared/userModelPlatform.ts')

const repoRoot = path.resolve(__dirname, '..')

/**
 * Copy fixture ONNX files into an isolated temporary userData Model
 * Platform layout and patch Module._load so require('electron') inside
 * main-process services resolves app.getPath('userData') to that root.
 *
 * @param {Array<{ slotId: string, source: string, profileId?: string }>} fixtures
 *   slotId: user model slot id (see shared/userModelPlatform.ts)
 *   source: fixture ONNX path relative to the repository root
 *   profileId: optional explicit profile; defaults to the slot default
 * @returns {{ present: boolean, userDataDir: string, cleanup: () => void }}
 *   present is false when any fixture source file is missing; in that case
 *   no electron stub is installed and callers should skip their tests.
 */
function installModelPlatformFixtures(fixtures) {
  const resolved = fixtures.map((fixture) => {
    const slot = getUserModelSlotDefinition(fixture.slotId)
    if (!slot) throw new Error(`Unknown user model slot: ${fixture.slotId}`)
    return {
      slot,
      profileId: fixture.profileId ?? slot.defaultProfileId,
      sourcePath: path.resolve(repoRoot, fixture.source),
    }
  })
  const present = resolved.every((fixture) => fs.existsSync(fixture.sourcePath))
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-model-fixture-userdata-'))
  const cleanup = () => {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
  if (!present) {
    cleanup()
    return { present, userDataDir: '', cleanup: () => {} }
  }

  for (const fixture of resolved) {
    const slotDir = path.join(userDataDir, 'models', fixture.slot.id)
    fs.mkdirSync(slotDir, { recursive: true })
    const targetPath = path.join(slotDir, fixture.slot.targetFileName)
    fs.copyFileSync(fixture.sourcePath, targetPath)
    const metadata = {
      schemaVersion: 3,
      slotId: fixture.slot.id,
      profileId: fixture.profileId,
      sourceFileName: path.basename(fixture.sourcePath),
      sizeBytes: fs.statSync(targetPath).size,
      sha256: '',
      installedAt: new Date().toISOString(),
      responsibility: 'user-supplied-unreviewed',
    }
    fs.writeFileSync(
      path.join(slotDir, 'installation.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    )
  }

  const electronStub = {
    app: {
      isPackaged: false,
      getPath: () => userDataDir,
      getAppPath: () => repoRoot,
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
  }
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, ...rest)
  }

  return { present, userDataDir, cleanup }
}

module.exports = { installModelPlatformFixtures }
