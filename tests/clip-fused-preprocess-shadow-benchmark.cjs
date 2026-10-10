const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const sharp = require('sharp')
const { AutoProcessor, RawImage, env } = require('@huggingface/transformers')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const MAX_INPUT_PIXELS = 64 * 1024 * 1024
const TARGET_SIZE = 224

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function datasetIdentity(images) {
  const digest = crypto.createHash('sha256')
  let totalBytes = 0
  for (const filePath of images) {
    const stat = fs.statSync(filePath)
    totalBytes += stat.size
    digest.update(path.basename(filePath), 'utf8')
    digest.update('\0', 'utf8')
    digest.update(String(stat.size), 'utf8')
    digest.update('\0', 'utf8')
    digest.update(String(Math.trunc(stat.mtimeMs)), 'utf8')
    digest.update('\n', 'utf8')
  }
  return {
    fileCount: images.length,
    totalBytes,
    sha256: digest.digest('hex'),
  }
}

function collectImages(root, start, limit) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(start, start + limit)
}

function resizedDimensions(width, height) {
  const factor = Math.max(TARGET_SIZE / width, TARGET_SIZE / height)
  return {
    width: Math.floor(Number((width * factor).toFixed(2))),
    height: Math.floor(Number((height * factor).toFixed(2))),
  }
}

async function readFusedClipImage(filePath) {
  const pipeline = sharp(filePath, {
    animated: false,
    limitInputPixels: MAX_INPUT_PIXELS,
  })
  const metadata = await pipeline.metadata()
  const sourceWidth = metadata.autoOrient?.width ?? metadata.width
  const sourceHeight = metadata.autoOrient?.height ?? metadata.height
  if (
    !Number.isSafeInteger(sourceWidth) ||
    !Number.isSafeInteger(sourceHeight) ||
    !sourceWidth ||
    !sourceHeight ||
    sourceWidth * sourceHeight > MAX_INPUT_PIXELS
  ) {
    throw new Error('Invalid or oversized source image dimensions')
  }
  if (metadata.channels !== 3) return RawImage.read(filePath)
  const resized = resizedDimensions(sourceWidth, sourceHeight)
  const { data, info } = await pipeline
    .rotate()
    .affine([resized.width / sourceWidth, 0, 0, resized.height / sourceHeight], {
      interpolator: 'bicubic',
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.equal(info.width, resized.width)
  assert.equal(info.height, resized.height)
  assert.equal(info.channels, metadata.channels)
  return new RawImage(new Uint8ClampedArray(data), info.width, info.height, metadata.channels)
}

function compareTensors(baseline, candidate) {
  const a = baseline.pixel_values
  const b = candidate.pixel_values
  assert.deepEqual(b.dims, a.dims)
  assert.equal(b.type, a.type)
  assert.equal(b.data.length, a.data.length)
  let mismatches = 0
  let maxAbsDiff = 0
  let sumAbsDiff = 0
  for (let index = 0; index < a.data.length; index += 1) {
    const diff = Math.abs(a.data[index] - b.data[index])
    if (diff !== 0) mismatches += 1
    if (diff > maxAbsDiff) maxAbsDiff = diff
    sumAbsDiff += diff
  }
  return {
    values: a.data.length,
    mismatches,
    mismatchRate: mismatches / a.data.length,
    maxAbsDiff,
    meanAbsDiff: sumAbsDiff / a.data.length,
    baselineHash: crypto.createHash('sha256').update(Buffer.from(a.data.buffer)).digest('hex'),
    candidateHash: crypto.createHash('sha256').update(Buffer.from(b.data.buffer)).digest('hex'),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const dataset = path.resolve(argv.find((value) => !value.startsWith('--')) || '')
  const sample = Math.max(1, Math.min(256, Number(option(argv, 'sample', '16')) || 16))
  const start = Math.max(0, Number(option(argv, 'start', '0')) || 0)
  const appData = process.env.APPDATA || ''
  const modelsRoot = path.resolve(
    option(argv, 'models-root', path.join(appData, 'floating-clock-electron', 'models')),
  )
  const modelId = 'Xenova/clip-vit-base-patch32'
  const modelRoot = path.join(modelsRoot, 'clip_vit_base_patch32')
  const jsonOut = option(argv, 'json-out', '')
  assert.equal(fs.statSync(dataset).isDirectory(), true, 'Dataset directory is required')
  const images = collectImages(dataset, start, sample)
  assert.equal(images.length, sample, 'Dataset does not contain enough supported images')

  env.localModelPath = modelRoot
  env.cacheDir = path.join(modelRoot, '.transformers-cache')
  env.allowLocalModels = true
  env.allowRemoteModels = false
  const processor = await AutoProcessor.from_pretrained(modelId)
  const sourceSnapshots = images.map((filePath) => {
    const stat = fs.statSync(filePath)
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs }
  })

  const rows = []
  for (const [index, filePath] of images.entries()) {
    let startedAt = performance.now()
    const baselineImage = await RawImage.read(filePath)
    const baselineDecodeMs = performance.now() - startedAt
    startedAt = performance.now()
    const baselineInputs = await processor(baselineImage)
    const baselinePreprocessMs = performance.now() - startedAt

    startedAt = performance.now()
    const candidateImage = await readFusedClipImage(filePath)
    const candidateDecodeResizeCropMs = performance.now() - startedAt
    startedAt = performance.now()
    const candidateInputs = await processor(candidateImage)
    const candidateNormalizeMs = performance.now() - startedAt
    const comparison = compareTensors(baselineInputs, candidateInputs)
    const row = {
      index,
      file: path.basename(filePath),
      source: { width: baselineImage.width, height: baselineImage.height },
      baselineDecodeMs: round(baselineDecodeMs),
      baselinePreprocessMs: round(baselinePreprocessMs),
      candidateDecodeResizeCropMs: round(candidateDecodeResizeCropMs),
      candidateNormalizeMs: round(candidateNormalizeMs),
      ...comparison,
      mismatchRate: round(comparison.mismatchRate, 9),
      maxAbsDiff: round(comparison.maxAbsDiff, 9),
      meanAbsDiff: round(comparison.meanAbsDiff, 9),
    }
    rows.push(row)
    process.stdout.write(`${JSON.stringify({ event: 'image-complete', ...row })}\n`)
  }

  for (const snapshot of sourceSnapshots) {
    const stat = fs.statSync(snapshot.filePath)
    assert.equal(stat.size, snapshot.size, `Source size changed: ${snapshot.filePath}`)
    assert.equal(stat.mtimeMs, snapshot.mtimeMs, `Source timestamp changed: ${snapshot.filePath}`)
  }
  const totals = rows.reduce(
    (result, row) => {
      result.baselineMs += row.baselineDecodeMs + row.baselinePreprocessMs
      result.candidateMs += row.candidateDecodeResizeCropMs + row.candidateNormalizeMs
      result.mismatches += row.mismatches
      result.values += row.values
      result.maxAbsDiff = Math.max(result.maxAbsDiff, row.maxAbsDiff)
      return result
    },
    { baselineMs: 0, candidateMs: 0, mismatches: 0, values: 0, maxAbsDiff: 0 },
  )
  const report = {
    schemaVersion: 1,
    dataset: path.basename(dataset),
    datasetIdentity: datasetIdentity(images),
    start,
    sample,
    candidate: 'sharp-encoded-affine-then-existing-center-crop',
    verdict: totals.mismatches === 0 ? 'tensor-parity-pass' : 'tensor-parity-fail',
    totals: {
      baselineMs: round(totals.baselineMs),
      candidateMs: round(totals.candidateMs),
      deltaPercent: round(((totals.candidateMs - totals.baselineMs) / totals.baselineMs) * 100),
      mismatches: totals.mismatches,
      values: totals.values,
      mismatchRate: round(totals.mismatches / totals.values, 9),
      maxAbsDiff: totals.maxAbsDiff,
    },
    sourceUnchanged: true,
    rows,
  }
  if (jsonOut) {
    const resolved = path.resolve(jsonOut)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(
    `${JSON.stringify({ event: 'summary', ...report.totals, verdict: report.verdict })}\n`,
  )
  if (report.verdict !== 'tensor-parity-pass') process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`)
  process.exitCode = 1
})
