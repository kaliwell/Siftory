// Unit tests for the dual text-encoder routing primitives (Chinese semantic
// search plan): CJK detection, encoder selection, mean pooling, Dense
// projection and the safetensors parser. Pure functions — no models needed.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  containsCjk,
  normalizeTextEncoderSetting,
  resolveTextEncoderChoice,
  l2Normalize,
  meanPoolLastHiddenState,
  applyDenseProjection,
  parseSafetensorsFloat32,
} = loadTsModule('electron/textEncoderRouting.ts')

test('containsCjk detects CJK scripts and ignores plain ASCII', () => {
  assert.equal(containsCjk('穿红裙子的女孩'), true)
  assert.equal(containsCjk('ねこ'), true) // Japanese kana
  assert.equal(containsCjk('고양이'), true) // Korean hangul
  assert.equal(containsCjk('cat in 雪'), true) // mixed
  assert.equal(containsCjk('a photo of a cat'), false)
  assert.equal(containsCjk('12345 !@#$%'), false)
  assert.equal(containsCjk(''), false)
})

test('resolveTextEncoderChoice honors setting overrides and auto routing', () => {
  assert.equal(resolveTextEncoderChoice('猫', 'auto'), 'multilingual')
  assert.equal(resolveTextEncoderChoice('cat', 'auto'), 'english')
  assert.equal(resolveTextEncoderChoice('cat 猫', 'auto'), 'multilingual')
  assert.equal(resolveTextEncoderChoice('猫', 'english'), 'english') // forced
  assert.equal(resolveTextEncoderChoice('cat', 'multilingual'), 'multilingual') // forced
})

test('normalizeTextEncoderSetting whitelists values with auto fallback', () => {
  assert.equal(normalizeTextEncoderSetting('english'), 'english')
  assert.equal(normalizeTextEncoderSetting('multilingual'), 'multilingual')
  assert.equal(normalizeTextEncoderSetting('auto'), 'auto')
  assert.equal(normalizeTextEncoderSetting('german'), 'auto')
  assert.equal(normalizeTextEncoderSetting(undefined), 'auto')
  assert.equal(normalizeTextEncoderSetting(42), 'auto')
})

test('l2Normalize produces unit vectors and survives zero input', () => {
  const normalized = l2Normalize(Float32Array.from([3, 4]))
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-6)
  assert.ok(Math.abs(normalized[1] - 0.8) < 1e-6)
  const zero = l2Normalize(new Float32Array(4))
  assert.deepEqual(Array.from(zero), [0, 0, 0, 0])
})

test('meanPoolLastHiddenState pools unmasked tokens only', () => {
  // seq=3, hidden=2; token 2 masked out
  const hidden = Float32Array.from([1, 3, 2, 4, 100, 300])
  const mask = [1, 1, 0]
  const pooled = meanPoolLastHiddenState(hidden, 0, mask, 0, 3, 2)
  assert.ok(Math.abs(pooled[0] - 1.5) < 1e-6)
  assert.ok(Math.abs(pooled[1] - 3.5) < 1e-6)
})

test('meanPoolLastHiddenState honors row offsets and BigInt masks', () => {
  // batch of 2 rows, seq=2, hidden=2; read the second row
  const hidden = Float32Array.from([9, 9, 9, 9, 1, 2, 3, 4])
  const mask = BigInt64Array.from([0n, 0n, 1n, 1n]) // first row fully masked
  const pooled = meanPoolLastHiddenState(hidden, 4, mask, 2, 2, 2)
  assert.ok(Math.abs(pooled[0] - 2) < 1e-6)
  assert.ok(Math.abs(pooled[1] - 3) < 1e-6)
})

test('applyDenseProjection supports [out,in] and [in,out] layouts identically', () => {
  const input = Float32Array.from([1, 2, 3])
  const outIn = Float32Array.from([1, 0, 0, 0, 1, 0]) // [2,3] → out = [1, 2]
  const inOut = Float32Array.from([1, 0, 0, 1, 0, 0]) // [3,2] → out = [1, 2]
  const a = applyDenseProjection(input, outIn, [2, 3], 3, 2)
  const b = applyDenseProjection(input, inOut, [3, 2], 3, 2)
  assert.deepEqual(Array.from(a), [1, 2])
  assert.deepEqual(Array.from(b), [1, 2])
  assert.throws(() => applyDenseProjection(input, outIn, [4, 4], 3, 2), /does not match/)
})

test('parseSafetensorsFloat32 round-trips F32 tensors', () => {
  const header = Buffer.from(
    JSON.stringify({
      'linear.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
      __metadata__: { format: 'pt' },
    }),
    'utf8',
  )
  const data = Buffer.alloc(16)
  data.writeFloatLE(1.5, 0)
  data.writeFloatLE(-2.5, 4)
  data.writeFloatLE(3.25, 8)
  data.writeFloatLE(0, 12)
  const headerLen = Buffer.alloc(8)
  headerLen.writeBigUInt64LE(BigInt(header.length))
  const buffer = Buffer.concat([headerLen, header, data])
  const tensors = parseSafetensorsFloat32(buffer)
  const tensor = tensors.get('linear.weight')
  assert.deepEqual(tensor.shape, [2, 2])
  assert.deepEqual(Array.from(tensor.data), [1.5, -2.5, 3.25, 0])
})

test('parseSafetensorsFloat32 rejects non-F32 tensors and truncated buffers', () => {
  const header = Buffer.from(
    JSON.stringify({ w: { dtype: 'F16', shape: [1], data_offsets: [0, 2] } }),
    'utf8',
  )
  const headerLen = Buffer.alloc(8)
  headerLen.writeBigUInt64LE(BigInt(header.length))
  assert.throws(() => parseSafetensorsFloat32(Buffer.concat([headerLen, header, Buffer.alloc(2)])), /dtype/)
  assert.throws(() => parseSafetensorsFloat32(Buffer.alloc(4)), /too small/)
})
