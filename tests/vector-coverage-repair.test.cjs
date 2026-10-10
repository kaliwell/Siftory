const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const {
  assertRepairablePreview,
  collectClipChannelFailures,
  collectCurrentVectorState,
  embeddingPathKey,
  parseArgs,
  previewToken,
  summarizePreview,
  validateOptions,
  verifyPreviewInputs,
} = require('../scripts/repair-vector-coverage.cjs')

const { classifyEmbeddingVector } = loadTsModule('electron/embeddingVectorValidation.ts')

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-coverage-repair-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function row(imageId, vector, dim = vector.length) {
  return {
    imageId,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim,
    vector,
  }
}

test('coverage repair is preview-only unless an exact confirmation token is supplied', () => {
  const parsed = parseArgs([])
  assert.equal(parsed.execute, false)
  assert.equal(parsed.backend, 'gpu')
  assert.throws(
    () => validateOptions({ ...parsed, execute: true, confirm: '' }),
    /requires --confirm/,
  )
})

test('current-state scan applies canonical latest-wins validity and repair semantics', async (t) => {
  const root = fixtureRoot(t)
  const legacy = path.join(root, 'legacy.jsonl')
  const current = path.join(root, 'current.jsonl')
  writeJsonl(legacy, [row('C:\\Images\\A.png', [1, 0, 0]), row('C:\\Images\\B.png', [0, 1, 0])])
  writeJsonl(current, [
    row('c:/images/a.png', [0, 0, 0]),
    row('C:\\Images\\B.png', [0, 0], 2),
    row('C:\\Images\\B.png', [0, 0, 1]),
  ])
  const result = await collectCurrentVectorState(
    [legacy, current],
    'dinov2_vitb14',
    3,
    classifyEmbeddingVector,
  )
  assert.equal(result.latest.size, 2)
  assert.equal(result.latest.get(embeddingPathKey('C:\\Images\\A.png')).issue, 'zero-norm')
  assert.equal(result.latest.get(embeddingPathKey('C:\\Images\\B.png')).issue, undefined)
  assert.equal(result.invalidPhysicalRows, 2)
})

test('CLIP retry candidates only include the exact historical channel conversion failure', async (t) => {
  const root = fixtureRoot(t)
  const failures = path.join(root, 'embedding_failures.jsonl')
  writeJsonl(failures, [
    {
      modelName: 'clip_vit_base_patch32',
      imageId: 'C:\\Images\\alpha.png',
      error: 'Conversion failed due to unsupported number of channels: 4',
    },
    {
      modelName: 'clip_vit_base_patch32',
      imageId: 'C:\\Images\\broken.jpg',
      error: 'Input buffer contains unsupported image format',
    },
    {
      modelName: 'dinov2_vitb14',
      imageId: 'C:\\Images\\other.png',
      error: 'Conversion failed due to unsupported number of channels: 4',
    },
  ])
  const result = await collectClipChannelFailures(failures)
  assert.deepEqual([...result.failures.values()], ['C:\\Images\\alpha.png'])
})

test('preview token binds source and candidate file snapshots and summary omits paths', (t) => {
  const root = fixtureRoot(t)
  const source = path.join(root, 'source.jsonl')
  const image = path.join(root, 'image.png')
  fs.writeFileSync(source, '{}\n')
  fs.writeFileSync(image, 'fixture')
  const sourceStat = fs.statSync(source)
  const imageStat = fs.statSync(image)
  const preview = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sources: [{ path: source, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs }],
    failureLog: null,
    models: {
      dinov2_vitb14: {
        candidates: [{ imageId: image, size: imageStat.size, mtimeMs: imageStat.mtimeMs }],
      },
      clip_vit_base_patch32: { candidates: [] },
    },
  }
  preview.token = previewToken(preview)
  assert.match(preview.token, /^[a-f0-9]{64}$/)
  assert.equal(summarizePreview(preview).models.dinov2_vitb14.candidates, 1)
  assert.doesNotThrow(() => verifyPreviewInputs(preview))
  fs.appendFileSync(image, '!')
  assert.throws(() => verifyPreviewInputs(preview), /Candidate image changed/)
})

test('execution rejects damage outside the bounded DINO-zero and CLIP-channel sets', () => {
  const valid = {
    models: {
      dinov2_vitb14: {
        malformedRows: 0,
        missingFiles: 0,
        zeroNormCurrent: 1,
        nonFiniteCurrent: 0,
        dimensionMismatchCurrent: 0,
        candidates: [{}],
      },
      clip_vit_base_patch32: {
        malformedRows: 0,
        failureLogMalformedRows: 0,
        missingFiles: 0,
        zeroNormCurrent: 0,
        nonFiniteCurrent: 0,
        dimensionMismatchCurrent: 0,
        channelFailureRecords: 1,
        alreadyValid: 0,
        candidates: [{}],
      },
    },
  }
  assert.doesNotThrow(() => assertRepairablePreview(valid))
  assert.throws(
    () =>
      assertRepairablePreview({
        models: {
          ...valid.models,
          dinov2_vitb14: { ...valid.models.dinov2_vitb14, nonFiniteCurrent: 1 },
        },
      }),
    /outside the authorized zero-vector/,
  )
  assert.throws(
    () =>
      assertRepairablePreview({
        models: {
          ...valid.models,
          clip_vit_base_patch32: { ...valid.models.clip_vit_base_patch32, missingFiles: 1 },
        },
      }),
    /outside the authorized channel-failure/,
  )
})
