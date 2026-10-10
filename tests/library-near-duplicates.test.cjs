// Unit tests for near-duplicate grouping pure logic
// (electron/libraryNearDuplicates.ts): banding + union-find over
// perceptual hash hex strings.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { hamming64, findNearDuplicateGroups } = loadTsModule('electron/libraryNearDuplicates.ts')

// hash with the lowest `bits` bits set (rest zero) — distance to all-zero = bits
const lowBits = (bits) => ((1n << BigInt(bits)) - 1n).toString(16).padStart(16, '0')
const ZERO = '0000000000000000'
const FULL = 'ffffffffffffffff'

test('hamming64 counts differing bits', () => {
  assert.equal(hamming64(ZERO, ZERO), 0)
  assert.equal(hamming64(ZERO, FULL), 64)
  assert.equal(hamming64(ZERO, lowBits(5)), 5)
  assert.equal(hamming64(lowBits(3), lowBits(8)), 5) // 8-3 overlapping bits
})

test('groups pairs within threshold, excludes beyond', () => {
  const { groups, cancelled } = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: lowBits(5) }, // dist 5 to #1
      { id: 3, diffHash64: FULL }, // dist 64
    ],
    { threshold: 8 },
  )
  assert.equal(cancelled, false)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].memberIds, [1, 2])
  assert.equal(groups[0].maxDistance, 5)
})

test('threshold boundary is inclusive', () => {
  const at = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: lowBits(8) },
    ],
    { threshold: 8 },
  )
  assert.equal(at.groups.length, 1)
  const beyond = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: lowBits(9) },
    ],
    { threshold: 8 },
  )
  assert.equal(beyond.groups.length, 0)
})

test('transitive chains merge into one group', () => {
  // A=0, B=lowBits(6) (dist 6), C=lowBits(12) (dist 6 to B, 12 to A)
  const { groups } = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: lowBits(6) },
      { id: 3, diffHash64: lowBits(12) },
    ],
    { threshold: 8 },
  )
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].memberIds, [1, 2, 3])
  assert.equal(groups[0].maxDistance, 12)
})

test('banding catches pairs whose differences spread across bands', () => {
  // 5 differences, one in each of 5 different bytes — at least 3 bands match
  const spread = 0x0101010101010101n.toString(16).padStart(16, '0')
  const { groups } = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: spread },
    ],
    { threshold: 8 },
  )
  assert.equal(hamming64(ZERO, spread), 8)
  assert.equal(groups.length, 1)
})

test('output is deterministic regardless of input order', () => {
  const inputs = [
    { id: 5, diffHash64: lowBits(2) },
    { id: 1, diffHash64: ZERO },
    { id: 9, diffHash64: FULL },
    { id: 3, diffHash64: lowBits(4) },
    { id: 7, diffHash64: lowBits(6) },
  ]
  const a = findNearDuplicateGroups(inputs, { threshold: 8 }).groups
  const b = findNearDuplicateGroups([...inputs].reverse(), { threshold: 8 }).groups
  assert.deepEqual(a, b)
  assert.deepEqual(a[0].memberIds, [1, 3, 5, 7])
})

test('bucket truncation stays deterministic and does not crash', () => {
  // 300 identical-hash entries → single giant bucket, truncated to maxBucketSize
  const inputs = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, diffHash64: ZERO }))
  const { groups } = findNearDuplicateGroups(inputs, { threshold: 8, maxBucketSize: 64 })
  assert.equal(groups.length, 1)
  assert.ok(groups[0].memberIds.length >= 64)
})

test('cancellation returns empty result flagged cancelled', () => {
  const { groups, cancelled } = findNearDuplicateGroups(
    [
      { id: 1, diffHash64: ZERO },
      { id: 2, diffHash64: lowBits(1) },
    ],
    { isCancelled: () => true },
  )
  assert.equal(cancelled, true)
  assert.equal(groups.length, 0)
})
