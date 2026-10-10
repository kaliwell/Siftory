// Integration tests for the Phase 2 face pipeline
// (electron/faceMatchService.ts): YOLOv8n-face detection → pseudo-landmark
// alignment → AdaFace embedding → cosine similarity.
//
// The service resolves models from user Model Platform slots; the fixture
// installer copies the legacy models/yolov8n-face and models/adaface files
// into an isolated temporary userData root and skips cleanly when those
// fixture sources are not available.
// Fixtures: public-domain US government portraits (White House photos).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { loadTsModule } = require('./guard-utils.cjs')
const { installModelPlatformFixtures } = require('./model-fixture-utils.cjs')

const modelFixture = installModelPlatformFixtures([
  { slotId: 'face-detector', source: 'models/yolov8n-face/model.onnx' },
  { slotId: 'face-embedder', source: 'models/adaface/model.onnx' },
])

const fm = loadTsModule('electron/faceMatchService.ts')

const fixture = (name) => path.resolve(__dirname, 'fixtures/faces', name)

test('face pipeline requires models', { skip: !modelFixture.present }, async (t) => {
  await t.test('detectFaces finds the face in a portrait', async () => {
    const det = await fm.detectFaces(fixture('obama.jpg'))
    assert.equal(det.ok, true)
    assert.ok(det.faces.length >= 1)
    const f = det.faces[0]
    assert.ok(f.bbox.w > 20 && f.bbox.h > 20)
    assert.equal(f.bbox.label, 'face')
  })

  await t.test('getFaceEmbedding returns a 512-d unit vector', async () => {
    const emb = await fm.getFaceEmbedding(fixture('obama.jpg'))
    assert.equal(emb.ok, true, emb.error)
    assert.equal(emb.vector.length, 512)
    const norm = Math.sqrt(emb.vector.reduce((s, v) => s + v * v, 0))
    assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit vector, got norm ${norm}`)
  })

  await t.test('same person scores high, different person scores low', async () => {
    const [a, av, b] = await Promise.all([
      fm.getFaceEmbedding(fixture('obama.jpg')),
      fm.getFaceEmbedding(fixture('obama-variant.jpg')),
      fm.getFaceEmbedding(fixture('trump.jpg')),
    ])
    assert.ok(a.ok && av.ok && b.ok)
    const same = fm.faceSimilarity(a.vector, av.vector)
    const diff = fm.faceSimilarity(a.vector, b.vector)
    assert.ok(same > 0.6, `same-person similarity too low: ${same}`)
    assert.ok(diff < 0.3, `different-person similarity too high: ${diff}`)
    assert.ok(same > diff)
  })

  await t.test('missing image degrades to ok:false instead of throwing', async () => {
    const emb = await fm.getFaceEmbedding(fixture('does-not-exist.jpg'))
    assert.equal(emb.ok, false)
  })

  await t.test('unsupported image content degrades to ok:false instead of throwing', async () => {
    const tmp = path.join(os.tmpdir(), `fc-not-image-${Date.now()}.jpg`)
    fs.writeFileSync(tmp, 'this is not an image')
    try {
      const det = await fm.detectFaces(tmp)
      assert.equal(det.ok, false)
      const emb = await fm.getFaceEmbedding(tmp)
      assert.equal(emb.ok, false)
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})

test.after(() => modelFixture.cleanup())
