const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { createF16DotProduct } = loadTsModule('electron/f16DotProduct.ts')
const { float16ToFloat32 } = loadTsModule('electron/embeddingF16Cache.ts')

test('lookup preserves scalar dot products for all 65536 half encodings', () => {
  const query = Float32Array.of(1)
  const lookup = createF16DotProduct(query, 'lookup')
  const scalar = createF16DotProduct(query, 'scalar')
  const buffer = Buffer.alloc(3)
  for (let bits = 0; bits < 0x10000; bits++) {
    buffer.writeUInt16LE(bits, 1)
    assert.ok(Object.is(lookup(buffer, 1), scalar(buffer, 1)), `half ${bits.toString(16)}`)
    assert.ok(Object.is(scalar(buffer, 1), 0 + float16ToFloat32(bits)))
  }
})

test('odd buffer slices and row offsets preserve accumulation order and bounds', () => {
  const query = Float32Array.of(0.1, -0.3, 0.7, -0.2, 0.4)
  const storage = Buffer.alloc(32, 0xff)
  const buffer = storage.subarray(1, 22)
  const bits = [0x0001, 0x8001, 0x3c00, 0xbc00, 0x0400]
  bits.forEach((value, index) => buffer.writeUInt16LE(value, 3 + index * 2))
  for (const mode of ['scalar', 'lookup']) {
    const dot = createF16DotProduct(query, mode)
    const expected = bits.reduce(
      (sum, value, index) => sum + query[index] * float16ToFloat32(value),
      0,
    )
    assert.equal(dot(buffer, 3), expected)
    for (const offset of [-1, 0.5, NaN, Infinity, 12]) {
      assert.throws(() => dot(buffer, offset), /outside the buffer/)
    }
  }
})

test('diagnostic scalar override is sampled once per query', () => {
  const previous = process.env.SIFTORY_F16_RERANK_SCALAR
  try {
    process.env.SIFTORY_F16_RERANK_SCALAR = '1'
    const scalar = createF16DotProduct(Float32Array.of(1))
    delete process.env.SIFTORY_F16_RERANK_SCALAR
    const lookup = createF16DotProduct(Float32Array.of(1))
    const buffer = Buffer.from([0, 0x3c])
    assert.equal(scalar(buffer, 0), 1)
    assert.equal(lookup(buffer, 0), 1)
  } finally {
    if (previous === undefined) delete process.env.SIFTORY_F16_RERANK_SCALAR
    else process.env.SIFTORY_F16_RERANK_SCALAR = previous
  }
})
