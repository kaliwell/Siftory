const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const recovery = loadTsModule('electron/jpegDecodeRecovery.ts')
const projectRoot = path.join(__dirname, '..')

test('JPEG recovery is limited to known recoverable decoder warnings', () => {
  assert.equal(
    recovery.isRecoverableJpegDecodeWarning('sample.jpg', 'VipsJpeg: premature end of JPEG image'),
    true,
  )
  assert.equal(
    recovery.isRecoverableJpegDecodeWarning(
      'sample.jpeg',
      new Error('VipsJpeg: Invalid SOS parameters for sequential JPEG'),
    ),
    true,
  )
  assert.equal(
    recovery.isRecoverableJpegDecodeWarning(
      'sample.jpg',
      'Warning treated as error due to failOn setting',
    ),
    true,
  )
  assert.equal(
    recovery.isRecoverableJpegDecodeWarning('sample.png', 'premature end of JPEG image'),
    false,
  )
  assert.equal(recovery.isRecoverableJpegDecodeWarning('sample.jpg', 'unsupported image'), false)
})

test('DINO and CLIP retry recoverable JPEG warnings without removing decode limits', () => {
  const dinoChild = fs.readFileSync(
    path.join(projectRoot, 'electron', 'dinoEmbeddingChild.ts'),
    'utf8',
  )
  const dino = fs.readFileSync(path.join(projectRoot, 'electron', 'dinoImageDecode.ts'), 'utf8')
  const clip = fs.readFileSync(path.join(projectRoot, 'electron', 'clipImageDecode.ts'), 'utf8')

  assert.match(dinoChild, /readDinoImage as readDinoImageBounded/)
  assert.match(dinoChild, /readDinoImageBounded\(imagePath, RawImage\)/)
  assert.match(dinoChild, /REASONIX_DINO_FUSED_SHADOW === '1'/)
  assert.match(
    dinoChild,
    /dinoFusedShadowEnabled\s*\?\s*readDinoTensorPrefetchImage\(imagePath, RawImage\)\s*:\s*readDinoImageBounded\(imagePath, RawImage\)/,
  )
  assert.doesNotMatch(dinoChild, /const dinoFusedShadowEnabled\s*=\s*true/)
  assert.match(dino, /decodeDinoRgb\(imagePath, 'warning'\)/)
  assert.match(dino, /isRecoverableJpegDecodeWarning\(imagePath, error\)/)
  assert.match(dino, /decodeDinoRgb\(imagePath, 'none'\)/)
  assert.match(dino, /limitInputPixels: MAX_DINO_INPUT_PIXELS/)
  assert.match(dino, /data\.length !== info\.width \* info\.height \* 3/)

  assert.match(clip, /recoverableJpegWarning = isRecoverableJpegDecodeWarning/)
  assert.match(clip, /failOn: tolerateJpegWarnings \? 'none' : 'warning'/)
  assert.match(clip, /limitInputPixels: MAX_CLIP_FALLBACK_PIXELS/)
})
