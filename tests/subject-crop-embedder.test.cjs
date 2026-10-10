// Integration test for SubjectCropEmbedder (persistent DINOv2 child).
// Skips when the DINO model or the built child bundle is unavailable.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const userDataDir = path.join(process.env.APPDATA || '', 'floating-clock-electron')
const projectRoot = path.resolve(__dirname, '..')
const electronStub = {
  app: {
    isPackaged: false,
    getAppPath: () => projectRoot,
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
  },
}
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

const { loadTsModule } = require('./guard-utils.cjs')

const CHILD_PRESENT = fs.existsSync(
  path.join(projectRoot, 'dist-electron', 'dinoEmbeddingChild.js'),
)
const MODEL_PRESENT = fs.existsSync(
  path.join(
    projectRoot,
    'ai-models',
    'dinov2_vitb14',
    'Xenova',
    'dinov2-base',
    'onnx',
    'model_q4.onnx',
  ),
)
const READY = CHILD_PRESENT && MODEL_PRESENT && Boolean(process.env.APPDATA)

const { SubjectCropEmbedder } = loadTsModule('electron/subjectCropEmbedder.ts')
const { cosineSimilarity } = loadTsModule('electron/faceAlign.ts')
const modelService = loadTsModule('electron/modelService.ts')

const fixture = (name) => path.join(projectRoot, 'tests', 'fixtures', 'faces', name)

test('subject crop embedder requires DINO model + built child', { skip: !READY }, async (t) => {
  await t.test('embeds multiple images through one persistent child', async () => {
    modelService.initModelService()
    const embedder = await SubjectCropEmbedder.create()
    assert.ok(embedder, 'embedder should be created when model is installed')
    try {
      const [a, b, av] = await Promise.all([
        embedder.embed(fixture('obama.jpg')),
        embedder.embed(fixture('trump.jpg')),
        embedder.embed(fixture('obama-variant.jpg')),
      ])
      for (const v of [a, b, av]) {
        assert.ok(v, 'expected an embedding')
        assert.equal(v.length, 768)
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
        assert.ok(Math.abs(norm - 1) < 1e-3)
      }
      // same photo (variant) must outrank a different photo
      assert.ok(cosineSimilarity(a, av) > cosineSimilarity(a, b))
    } finally {
      await embedder.dispose()
    }
  })

  await t.test('missing image resolves null without killing the child', async () => {
    modelService.initModelService()
    const embedder = await SubjectCropEmbedder.create()
    assert.ok(embedder)
    try {
      const bad = await embedder.embed(fixture('does-not-exist.jpg'))
      assert.equal(bad, null)
      const good = await embedder.embed(fixture('obama.jpg'))
      assert.ok(good)
    } finally {
      await embedder.dispose()
    }
  })
})
