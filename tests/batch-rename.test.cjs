// Unit tests for the pure perceptual-hash matching helpers used by
// the batch rename recovery feature (electron/perceptualHashMatch.ts).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { combinedScore, popcount64, isImageFile } = loadTsModule('electron/perceptualHashMatch.ts')
const {
  captureBatchRenameSourceFingerprint,
  copyBatchRenameCandidate,
  selectBatchRenameCandidates,
} = loadTsModule('electron/batchRenamePolicy.ts')

function candidate(originPath, modifiedPath, score, desiredOutputPath = `${originPath}.jpg`) {
  return {
    originPath,
    originalName: path.basename(originPath),
    modifiedPath,
    desiredOutputPath,
    score,
    sourceFingerprint: captureBatchRenameSourceFingerprint(modifiedPath) ?? undefined,
  }
}

test('popcount64 counts set bits', () => {
  assert.equal(popcount64(0n), 0)
  assert.equal(popcount64(1n), 1)
  assert.equal(popcount64(0xffffffffffffffffn), 64)
  assert.equal(popcount64(0x8000000000000000n), 1)
})

test('combinedScore returns 1 for identical hash pairs', () => {
  assert.equal(combinedScore(123, 123, -456, -456), 1)
  assert.equal(combinedScore(0, 0, 0, 0), 1)
  // native addon returns 16-char hex strings
  assert.equal(
    combinedScore('abcdef0123456789', 'abcdef0123456789', '0000000000000001', '0000000000000001'),
    1,
  )
  assert.equal(combinedScore('0xabcdef0123456789', 'abcdef0123456789', '0', '0'), 1)
})

test('combinedScore accepts native hex strings and decreases with distance', () => {
  const near = combinedScore('abcdef0123456789', 'abcdef0123456788', '0', '0') // 1 bit differs
  const far = combinedScore(
    '0000000000000000',
    'ffffffffffffffff',
    '0000000000000000',
    'ffffffffffffffff',
  )
  assert.ok(near > 0.98, `expected near-identical hex hashes to score high, got ${near}`)
  assert.equal(far, 0)
  assert.ok(near > far)
})

test('combinedScore decreases with hamming distance', () => {
  const identical = combinedScore(0, 0, 0, 0)
  // JS bitwise XOR coerces to 32 bits; use values within int32 range
  const oneBitDiff = combinedScore(0, 1, 0, 0)
  const manyBitsDiff = combinedScore(0, 0x7fffffff, 0, 0x7fffffff)
  assert.ok(identical > oneBitDiff)
  assert.ok(oneBitDiff > manyBitsDiff)
  assert.ok(
    manyBitsDiff < 0.85,
    `expected far hashes to fall below default threshold, got ${manyBitsDiff}`,
  )
})

test('combinedScore weights dHash 0.7 and dct 0.3', () => {
  // One differing bit in dHash only: (63/64)*0.7 + 1*0.3
  const dhashOnly = combinedScore(0, 1, 5, 5)
  assert.ok(Math.abs(dhashOnly - ((63 / 64) * 0.7 + 0.3)) < 1e-9)
  // One differing bit in dct only: 1*0.7 + (63/64)*0.3
  const dctOnly = combinedScore(5, 5, 0, 1)
  assert.ok(Math.abs(dctOnly - (0.7 + (63 / 64) * 0.3)) < 1e-9)
})

test('isImageFile accepts known extensions case-insensitively', () => {
  assert.ok(isImageFile('a/b/photo.JPG'))
  assert.ok(isImageFile('photo.jpeg'))
  assert.ok(isImageFile('photo.png'))
  assert.ok(isImageFile('photo.webp'))
  assert.ok(isImageFile('photo.tiff'))
})

test('isImageFile rejects non-images and dotless names', () => {
  assert.ok(!isImageFile('notes.txt'))
  assert.ok(!isImageFile('archive.zip'))
  assert.ok(!isImageFile('README'))
  assert.ok(!isImageFile('jpg'))
})

test('batch rename subscribes before starting and recovers current task state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'BatchRenamePanel.tsx'),
    'utf8',
  )
  assert.ok(source.indexOf('batchRenameBridge.onProgress') < source.indexOf('const handleStart'))
  assert.match(source, /batchRenameBridge\s*\.getProgress\(\)/)
  assert.match(source, /batchRenameBridge\s*\.getResult\(\)/)
  assert.doesNotMatch(source, /unsubRef/)
  assert.match(source, /useLinkedMove\('batchRename'/)
  assert.match(source, /defaultW=\{DEFAULT_BATCH_RENAME_W\}/)
  assert.match(source, /locked=\{locked\}/)
})

test('batch rename rejects source-output aliasing and surfaces copy failures', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'batchRenameService.ts'),
    'utf8',
  )
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'batchRenameIpc.ts'), 'utf8')
  assert.match(service, /fs\.realpathSync\.native/)
  assert.match(service, /Output directory must be separate from both source directories/)
  assert.match(service, /Copy failed for/)
  assert.match(service, /publishTerminalResult\(/)
  assert.match(service, /copyBatchRenameCandidate\(/)
  assert.match(ipc, /Number\.isFinite\(req\.threshold\)/)
  assert.match(ipc, /\['keep-best', 'skip', 'keep-both'\]\.includes\(req\.conflictPolicy\)/)
})

test('batch rename selects the highest score before copying and reports rejected candidates', () => {
  const first = candidate('origin-a', 'modified-a', 0.9)
  const better = candidate('origin-a', 'modified-b', 0.95)
  const other = candidate('origin-b', 'modified-c', 0.91)

  const best = selectBatchRenameCandidates([first, better, other], 'keep-best')
  assert.deepEqual(
    best.selected.map((item) => item.modifiedPath),
    ['modified-b', 'modified-c'],
  )
  assert.deepEqual(best.rejected, [{ candidate: first, reason: 'same-origin-lower-score' }])

  const skipped = selectBatchRenameCandidates([first, better], 'skip')
  assert.deepEqual(skipped.selected, [first])
  assert.equal(skipped.rejected[0].reason, 'same-origin-conflict')

  const both = selectBatchRenameCandidates([first, better], 'keep-both')
  assert.deepEqual(both.selected, [first, better])
  assert.deepEqual(both.rejected, [])
})

test('batch rename keep-best arbitrates different origins that claim the same output', () => {
  const output = path.resolve('same-output.jpg')
  const lower = candidate('origin-a', 'modified-a', 0.8, output)
  const higher = candidate('origin-b', 'modified-b', 0.95, output)

  const selection = selectBatchRenameCandidates([lower, higher], 'keep-best')
  assert.deepEqual(selection.selected, [higher])
  assert.deepEqual(selection.rejected, [{ candidate: lower, reason: 'same-output-lower-score' }])
})

test('batch rename never overwrites a pre-existing output file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-rename-existing-'))
  try {
    const source = path.join(dir, 'source.jpg')
    const output = path.join(dir, 'original.jpg')
    fs.writeFileSync(source, 'new-image')
    fs.writeFileSync(output, 'user-image')

    const result = await copyBatchRenameCandidate(
      candidate('origin-a', source, 0.95, output),
      'keep-best',
      new Set(),
    )

    assert.deepEqual(result, {
      ok: false,
      outputPath: output,
      collision: true,
      reason: 'existing-output',
    })
    assert.equal(fs.readFileSync(output, 'utf8'), 'user-image')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('batch rename keep-both allocates a deterministic suffix without replacing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-rename-both-'))
  try {
    const source = path.join(dir, 'source.jpg')
    const output = path.join(dir, 'original.jpg')
    fs.writeFileSync(source, 'new-image')
    fs.writeFileSync(output, 'user-image')

    const result = await copyBatchRenameCandidate(
      candidate('origin-a', source, 0.95, output),
      'keep-both',
      new Set(),
    )

    assert.equal(result.ok, true)
    assert.equal(result.collision, true)
    assert.equal(result.outputPath, path.join(dir, 'original_2.jpg'))
    assert.equal(result.publishMode, 'atomic-link')
    assert.equal(fs.readFileSync(output, 'utf8'), 'user-image')
    assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'new-image')
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.part')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('batch rename safely falls back on filesystems without hard-link support', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-rename-fallback-'))
  try {
    const source = path.join(dir, 'source.jpg')
    const output = path.join(dir, 'original.jpg')
    fs.writeFileSync(source, 'new-image')
    const unsupportedLink = async () => {
      const error = new Error('hard links unavailable')
      error.code = 'ENOTSUP'
      throw error
    }

    const result = await copyBatchRenameCandidate(
      candidate('origin-a', source, 0.95, output),
      'keep-best',
      new Set(),
      unsupportedLink,
    )

    assert.equal(result.ok, true)
    assert.equal(result.publishMode, 'exclusive-copy')
    assert.equal(fs.readFileSync(output, 'utf8'), 'new-image')
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.part')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('batch rename rejects a source that changed after matching', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-rename-source-change-'))
  try {
    const source = path.join(dir, 'source.jpg')
    const output = path.join(dir, 'original.jpg')
    fs.writeFileSync(source, 'matched-image')
    const selected = candidate('origin-a', source, 0.95, output)
    fs.writeFileSync(source, 'replacement-image-with-another-size')

    const result = await copyBatchRenameCandidate(selected, 'keep-best', new Set())

    assert.deepEqual(result, {
      ok: false,
      outputPath: output,
      collision: false,
      reason: 'source-changed',
    })
    assert.equal(fs.existsSync(output), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
