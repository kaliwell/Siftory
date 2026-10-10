const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { findExactDuplicateGroups } = loadTsModule('electron/libraryDuplicateGroups.ts')

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 确定性伪随机内容（mulberry32），避免测试依赖随机源。 */
function pseudoRandomBuffer(size, seed) {
  const buffer = Buffer.alloc(size)
  let state = seed >>> 0
  for (let i = 0; i < size; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    buffer[i] = (t ^ (t >>> 14)) & 0xff
  }
  return buffer
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

test('library duplicates: identical content across directories forms one group', async () => {
  const root = makeTempRoot('floating-clock-libdup-cross-')
  try {
    const dirA = path.join(root, 'dir-a')
    const dirB = path.join(root, 'dir-b')
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    const content = Buffer.from('shared-asset-content')
    const pathA = path.join(dirA, 'asset-a.bin')
    const pathB = path.join(dirB, 'asset-b.bin')
    const pathUniqueSize = path.join(dirA, 'unique-size.bin')
    const pathUniqueContent = path.join(dirB, 'unique-content.bin')
    fs.writeFileSync(pathA, content)
    fs.writeFileSync(pathB, content)
    fs.writeFileSync(pathUniqueSize, Buffer.from('different length payload'))
    // 与重复组同大小但内容不同：进入哈希阶段但不进任何组。
    fs.writeFileSync(pathUniqueContent, Buffer.from('XXXXXXXXXXXXXXXXXXXX'))

    const result = await findExactDuplicateGroups([pathA, pathB, pathUniqueSize, pathUniqueContent])
    assert.equal(result.cancelled, false)
    assert.equal(result.scannedFiles, 4)
    assert.equal(result.skippedMissing, 0)
    // 同大小候选共 3 个（两个重复 + 一个同大小不同内容），唯一大小文件不进哈希阶段。
    assert.equal(result.hashedFiles, 3)
    assert.equal(result.groups.length, 1)
    assert.deepEqual(result.groups[0].paths, [pathA, pathB].sort())
    assert.equal(result.groups[0].hash, sha256Hex(content))
    assert.equal(result.groups[0].sizeBytes, content.length)
    assert.equal(result.totalBytes, content.length)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: zero-byte and below-min-size files count as skipped', async () => {
  const root = makeTempRoot('floating-clock-libdup-minsize-')
  try {
    const emptyA = path.join(root, 'empty-a.bin')
    const emptyB = path.join(root, 'empty-b.bin')
    const real = path.join(root, 'real.bin')
    fs.writeFileSync(emptyA, Buffer.alloc(0))
    fs.writeFileSync(emptyB, Buffer.alloc(0))
    fs.writeFileSync(real, Buffer.from('x'))

    const result = await findExactDuplicateGroups([emptyA, emptyB, real])
    assert.equal(result.scannedFiles, 1)
    assert.equal(result.skippedMissing, 2)
    assert.equal(result.hashedFiles, 0)
    assert.deepEqual(result.groups, [])

    // minSizeBytes 为 0 时两个空文件成为一组。
    const withEmpty = await findExactDuplicateGroups([emptyA, emptyB, real], { minSizeBytes: 0 })
    assert.equal(withEmpty.groups.length, 1)
    assert.equal(withEmpty.groups[0].sizeBytes, 0)
    assert.equal(withEmpty.totalBytes, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: missing paths and directory paths are skipped without throwing', async () => {
  const root = makeTempRoot('floating-clock-libdup-skip-')
  try {
    const dir = path.join(root, 'a-directory')
    fs.mkdirSync(dir)
    const missing = path.join(root, 'does-not-exist.bin')
    const realA = path.join(root, 'real-a.bin')
    const realB = path.join(root, 'real-b.bin')
    fs.writeFileSync(realA, 'same')
    fs.writeFileSync(realB, 'same')

    const result = await findExactDuplicateGroups([missing, dir, realA, realB])
    assert.equal(result.scannedFiles, 2)
    assert.equal(result.skippedMissing, 2)
    assert.equal(result.groups.length, 1)
    assert.deepEqual(result.groups[0].paths, [realA, realB].sort())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: three groups and redundant-byte accounting', async () => {
  const root = makeTempRoot('floating-clock-libdup-groups-')
  try {
    const inputs = []
    // 组 1：3 份 100 字节；组 2：2 份 40 字节；组 3：2 份 10 字节。
    const specs = [
      { copies: 3, size: 100, seed: 11 },
      { copies: 2, size: 40, seed: 22 },
      { copies: 2, size: 10, seed: 33 },
    ]
    for (const [groupIndex, spec] of specs.entries()) {
      const content = pseudoRandomBuffer(spec.size, spec.seed)
      for (let copy = 0; copy < spec.copies; copy += 1) {
        const filePath = path.join(root, `g${groupIndex}-copy${copy}.bin`)
        fs.writeFileSync(filePath, content)
        inputs.push(filePath)
      }
    }
    // 干扰项：唯一大小。
    const loner = path.join(root, 'loner.bin')
    fs.writeFileSync(loner, pseudoRandomBuffer(55, 44))
    inputs.push(loner)

    const result = await findExactDuplicateGroups(inputs)
    assert.equal(result.groups.length, 3)
    assert.equal(result.totalBytes, (3 - 1) * 100 + (2 - 1) * 40 + (2 - 1) * 10)
    // 排序：sizeBytes 降序。
    assert.deepEqual(
      result.groups.map((group) => group.sizeBytes),
      [100, 40, 10],
    )
    assert.deepEqual(
      result.groups.map((group) => group.paths.length),
      [3, 2, 2],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: output is deterministic across runs', async () => {
  const root = makeTempRoot('floating-clock-libdup-determinism-')
  try {
    const inputs = []
    for (let i = 0; i < 12; i += 1) {
      const content = pseudoRandomBuffer(64 + (i % 4), i + 1)
      const copies = i % 3 === 0 ? 1 : 2
      for (let copy = 0; copy < copies; copy += 1) {
        const filePath = path.join(root, `f${i}-${copy}.bin`)
        fs.writeFileSync(filePath, content)
        inputs.push(filePath)
      }
    }
    // 打乱输入顺序不影响输出。
    const shuffled = [...inputs].reverse()

    const first = await findExactDuplicateGroups(inputs)
    const second = await findExactDuplicateGroups(shuffled)
    assert.deepEqual(first, second)
    // 组内路径升序。
    for (const group of first.groups) {
      assert.deepEqual(group.paths, [...group.paths].sort())
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: cancellation returns partial snapshot without throwing', async () => {
  const root = makeTempRoot('floating-clock-libdup-cancel-')
  try {
    const inputs = []
    for (let i = 0; i < 8; i += 1) {
      const filePath = path.join(root, `cancel-${i}.bin`)
      fs.writeFileSync(filePath, pseudoRandomBuffer(32, i + 7))
      inputs.push(filePath)
    }

    const immediate = await findExactDuplicateGroups(inputs, { isCancelled: () => true })
    assert.equal(immediate.cancelled, true)
    assert.equal(immediate.scannedFiles, 0)
    assert.deepEqual(immediate.groups, [])

    // 中途取消：第一个文件 stat 完成后翻转标志，已扫部分正常汇总不抛错。
    let seen = 0
    const midway = await findExactDuplicateGroups(inputs, {
      concurrency: 1,
      isCancelled: () => seen > 0,
      onProgress: () => {
        seen += 1
      },
    })
    assert.equal(midway.cancelled, true)
    assert.ok(midway.scannedFiles >= 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: streaming hash of a ~5MB file matches one-shot crypto hash', async () => {
  const root = makeTempRoot('floating-clock-libdup-bigfile-')
  try {
    const content = pseudoRandomBuffer(5 * 1024 * 1024, 99)
    const pathA = path.join(root, 'big-a.bin')
    const pathB = path.join(root, 'big-b.bin')
    fs.writeFileSync(pathA, content)
    fs.writeFileSync(pathB, content)

    const result = await findExactDuplicateGroups([pathA, pathB])
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].hash, sha256Hex(content))
    assert.equal(result.groups[0].sizeBytes, content.length)
    assert.equal(result.totalBytes, content.length)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('library duplicates: duplicate input paths are de-duplicated before grouping', async () => {
  const root = makeTempRoot('floating-clock-libdup-dupeinput-')
  try {
    const filePath = path.join(root, 'only.bin')
    fs.writeFileSync(filePath, 'content')

    const result = await findExactDuplicateGroups([filePath, filePath])
    assert.equal(result.scannedFiles, 1)
    assert.deepEqual(result.groups, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
