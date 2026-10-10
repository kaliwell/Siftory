// Unit tests for color-identity helpers used by subject reranking
// (electron/colorFeatureService.ts computeImageColorHist + colorSimilarity).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { colorSimilarity, colorIdentitySimilarity, computeImageColorHist } = loadTsModule(
  'electron/colorFeatureService.ts',
)
const sharp = require('sharp')

const fixture = (name) => path.resolve(__dirname, 'fixtures/faces', name)

async function makeSolidImage(r, g, b) {
  const file = path.join(os.tmpdir(), `fc-solid-${r}-${g}-${b}-${Date.now()}.png`)
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r, g, b } } })
    .png()
    .toFile(file)
  return file
}

test('identical image yields color similarity 1', async () => {
  const h1 = await computeImageColorHist(fixture('obama.jpg'))
  const h2 = await computeImageColorHist(fixture('obama.jpg'))
  assert.ok(h1 && h2)
  assert.ok(Math.abs(colorSimilarity(h1, h2) - 1) < 1e-9)
  assert.ok(Math.abs(colorIdentitySimilarity(h1, h2) - 1) < 1e-9)
})

test('identity similarity separates different hues; flat similarity does not', async () => {
  const red = await makeSolidImage(255, 0, 0)
  const blue = await makeSolidImage(0, 0, 255)
  try {
    const hr = await computeImageColorHist(red)
    const hb = await computeImageColorHist(blue)
    // flat marginal similarity keeps sat/val overlap → ~0.67 floor
    assert.ok(colorSimilarity(hr, hb) > 0.5)
    // identity similarity is hue-dominated → far lower
    const diff = colorIdentitySimilarity(hr, hb)
    assert.ok(diff < 0.45, `red vs blue identity similarity too high: ${diff}`)
    assert.ok(Math.abs(colorIdentitySimilarity(hr, hr) - 1) < 1e-9)
  } finally {
    fs.unlinkSync(red)
    fs.unlinkSync(blue)
  }
})

test('region histogram reflects the cropped area, not the whole image', async () => {
  // build a 64x32 image: left half red, right half blue
  const file = path.join(os.tmpdir(), `fc-halves-${Date.now()}.png`)
  const left = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  const right = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: 32, top: 0 },
    ])
    .png()
    .toFile(file)
  try {
    const redRef = await makeSolidImage(255, 0, 0)
    const blueRef = await makeSolidImage(0, 0, 255)
    try {
      const leftHist = await computeImageColorHist(file, { left: 0, top: 0, width: 32, height: 32 })
      const rightHist = await computeImageColorHist(file, {
        left: 32,
        top: 0,
        width: 32,
        height: 32,
      })
      const redHist = await computeImageColorHist(redRef)
      const blueHist = await computeImageColorHist(blueRef)
      assert.ok(
        colorIdentitySimilarity(leftHist, redHist) > colorIdentitySimilarity(leftHist, blueHist),
      )
      assert.ok(
        colorIdentitySimilarity(rightHist, blueHist) > colorIdentitySimilarity(rightHist, redHist),
      )
    } finally {
      fs.unlinkSync(redRef)
      fs.unlinkSync(blueRef)
    }
  } finally {
    fs.unlinkSync(file)
  }
})

test('missing image returns null instead of throwing', async () => {
  assert.equal(await computeImageColorHist(fixture('does-not-exist.jpg')), null)
})
