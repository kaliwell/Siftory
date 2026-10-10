const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  getAssetFeedbackModelStatus,
  initAssetFeedbackModelService,
  markAssetFeedbackDirty,
  rebuildAssetFeedbackModel,
  setAssetFeedbackEnabled,
  setAssetFeedbackSourceProvider,
} = loadTsModule('electron/assetFeedbackModelService.ts')

test('feedback model persists revision and returns ready after an atomic rebuild', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-feedback-'))
  try {
    initAssetFeedbackModelService(root)
    setAssetFeedbackSourceProvider(async () => ({ targets: [] }))

    const initial = await getAssetFeedbackModelStatus()
    assert.equal(initial.state, 'missing')
    assert.equal(initial.revision, 1)
    assert.equal(initial.enabled, false)

    const enabled = await setAssetFeedbackEnabled(true)
    assert.equal(enabled.enabled, true)

    await markAssetFeedbackDirty('test review changed')
    const dirty = await getAssetFeedbackModelStatus()
    assert.equal(dirty.revision, 2)
    assert.equal(dirty.state, 'missing')

    const built = await rebuildAssetFeedbackModel()
    assert.equal(built.state, 'ready')
    assert.equal(built.revision, 2)
    assert.equal(built.builtRevision, 2)
    assert.equal(built.targetCount, 0)

    const feedbackDir = path.join(root, 'search-feedback')
    assert.ok(fs.existsSync(path.join(feedbackDir, 'state.json')))
    assert.ok(fs.existsSync(path.join(feedbackDir, 'manifest.json')))

    initAssetFeedbackModelService(root)
    const restored = await getAssetFeedbackModelStatus()
    assert.equal(restored.state, 'ready')
    assert.equal(restored.revision, 2)
    assert.equal(restored.builtRevision, 2)
    assert.equal(restored.enabled, true)
  } finally {
    setAssetFeedbackSourceProvider(null)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('feedback model rejects wrong-dimension and zero persisted prototypes', async () => {
  try {
    for (const corruption of ['wrong-dimension', 'zero-prototype']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-feedback-hostile-'))
      try {
        initAssetFeedbackModelService(root)
        setAssetFeedbackSourceProvider(async () => ({ targets: [] }))
        await rebuildAssetFeedbackModel()

        const manifestPath = path.join(root, 'search-feedback', 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        if (corruption === 'wrong-dimension') {
          manifest.dim = 1
        } else {
          manifest.targets = [
            {
              key: 'category:1',
              kind: 'category',
              id: 1,
              name: 'fixture',
              positiveSampleCount: 1,
              negativeSampleCount: 0,
              positivePrototypes: [
                {
                  path: 'C:\\fixture.jpg',
                  vector: Buffer.alloc(manifest.dim * Float32Array.BYTES_PER_ELEMENT).toString(
                    'base64',
                  ),
                },
              ],
              negativePrototypes: [],
            },
          ]
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

        initAssetFeedbackModelService(root)
        const status = await getAssetFeedbackModelStatus()
        assert.equal(status.state, 'error')
        assert.match(status.error || '', /incompatible|zero norm/i)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    setAssetFeedbackSourceProvider(null)
  }
})
