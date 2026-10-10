// Integration tests for the Phase 3 person re-identification pipeline
// (electron/personReidService.ts): person crop → OSNet-AIN embedding.
//
// The service resolves the model from the user Model Platform slot; the
// fixture installer copies models/osnet/model.onnx into an isolated
// temporary userData root and skips cleanly when the fixture source is
// not available.
// Note: accuracy on formal portraits is a known weak spot (attire
// dominates reid features), so these tests assert pipeline mechanics,
// not portrait identity separation.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const { installModelPlatformFixtures } = require('./model-fixture-utils.cjs')

const modelFixture = installModelPlatformFixtures([
  { slotId: 'person-reid', source: 'models/osnet/model.onnx' },
])

const reid = loadTsModule('electron/personReidService.ts')

const fixture = (name) => path.resolve(__dirname, 'fixtures/faces', name)

test('person reid pipeline requires models', { skip: !modelFixture.present }, async (t) => {
  await t.test('embedPersonCrops returns one 512-d unit vector per input', async () => {
    const inputs = [
      { imagePath: fixture('obama.jpg') },
      { imagePath: fixture('obama-variant.jpg') },
      { imagePath: fixture('trump.jpg') },
    ]
    const out = await reid.embedPersonCrops(inputs)
    assert.equal(out.length, 3)
    for (const vec of out) {
      assert.ok(vec, 'expected a vector')
      assert.equal(vec.length, 512)
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
      assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit vector, got ${norm}`)
    }
  })

  await t.test('unreadable image yields null entry without failing the batch', async () => {
    const out = await reid.embedPersonCrops([
      { imagePath: fixture('obama.jpg') },
      { imagePath: fixture('does-not-exist.jpg') },
    ])
    assert.ok(out[0])
    assert.equal(out[1], null)
  })

  await t.test('bbox crop path works', async () => {
    const whole = await reid.getPersonEmbedding(fixture('obama.jpg'))
    const cropped = await reid.getPersonEmbedding(fixture('obama.jpg'), {
      x: 300,
      y: 60,
      w: 400,
      h: 700,
      confidence: 0.9,
      label: 'person',
    })
    assert.ok(whole.ok && cropped.ok)
    const sim = reid.personSimilarity(whole.vector, cropped.vector)
    assert.ok(sim > 0.3, `whole-vs-crop similarity unexpectedly low: ${sim}`)
  })

  await t.test('same identity across photos outranks a clear non-person input', async () => {
    const [a, a2, b] = await reid.embedPersonCrops([
      { imagePath: fixture('obama.jpg') },
      { imagePath: fixture('obama-variant.jpg') },
      { imagePath: fixture('does-not-exist.jpg') },
    ])
    assert.ok(a && a2 && b === null)
    const same = reid.personSimilarity(a, a2)
    assert.ok(same > 0.5, `same-photo-variant similarity too low: ${same}`)
  })
})

test.after(() => modelFixture.cleanup())
