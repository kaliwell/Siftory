const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  decodeEmbeddingChildVector,
  EmbeddingChildBinaryFrameDecoder,
  encodeEmbeddingChildFrame,
  MAX_EMBEDDING_CHILD_HEADER_BYTES,
} = loadTsModule('electron/embeddingChildBinaryProtocol.ts')

test('embedding child binary frames preserve vector numbers across arbitrary pipe chunks', () => {
  const vector = [0.125, -0.25, Math.PI, Number.MIN_VALUE]
  const encoded = encodeEmbeddingChildFrame(
    { id: 7, ok: true, vectorEncoding: 'float64le' },
    vector,
  )
  const decoder = new EmbeddingChildBinaryFrameDecoder()
  const frames = []
  for (let offset = 0; offset < encoded.length; offset += 3) {
    const result = decoder.push(encoded.subarray(offset, Math.min(encoded.length, offset + 3)))
    assert.equal(result.overflow, false)
    frames.push(...result.frames)
  }
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].header, { id: 7, ok: true, vectorEncoding: 'float64le' })
  assert.deepEqual(decodeEmbeddingChildVector(frames[0], vector.length), vector)
})

test('embedding child decoder accepts consecutive control and vector frames', () => {
  const ready = encodeEmbeddingChildFrame({ type: 'ready' })
  const result = encodeEmbeddingChildFrame(
    { id: 2, ok: true, vectorEncoding: 'float64le' },
    [1, 2],
  )
  const decoder = new EmbeddingChildBinaryFrameDecoder()
  const decoded = decoder.push(Buffer.concat([ready, result]))
  assert.equal(decoded.overflow, false)
  assert.equal(decoded.frames.length, 2)
  assert.deepEqual(decoded.frames[0].header, { type: 'ready' })
  assert.deepEqual(decodeEmbeddingChildVector(decoded.frames[1], 2), [1, 2])
})

test('embedding child decoder fails closed for corrupt and oversized frames', () => {
  const invalidMagic = Buffer.alloc(12)
  invalidMagic.write('BAD!', 0, 'ascii')
  invalidMagic.writeUInt32LE(1, 4)
  const corruptDecoder = new EmbeddingChildBinaryFrameDecoder()
  assert.equal(corruptDecoder.push(invalidMagic).overflow, true)
  assert.equal(corruptDecoder.push(encodeEmbeddingChildFrame({ type: 'ready' })).overflow, true)

  const oversized = Buffer.alloc(12)
  oversized.write('EMB1', 0, 'ascii')
  oversized.writeUInt32LE(MAX_EMBEDDING_CHILD_HEADER_BYTES + 1, 4)
  const oversizedDecoder = new EmbeddingChildBinaryFrameDecoder()
  assert.equal(oversizedDecoder.push(oversized).overflow, true)
})

test('embedding child vector metadata rejects dimension and encoding mismatches', () => {
  const encoded = encodeEmbeddingChildFrame(
    { id: 3, ok: true, vectorEncoding: 'float64le' },
    [1, 2],
  )
  const decoder = new EmbeddingChildBinaryFrameDecoder()
  const frame = decoder.push(encoded).frames[0]
  assert.throws(() => decodeEmbeddingChildVector(frame, 3), /metadata is invalid/)
  frame.header.vectorEncoding = 'base64'
  assert.throws(() => decodeEmbeddingChildVector(frame, 2), /metadata is invalid/)
})
