const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const integrity = loadTsModule('electron/authoritativeVectorStore.ts')

function fixture(size = 256 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-chunks-'))
  const filePath = path.join(directory, 'source.bin')
  const content = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index++) content[index] = index % 251
  fs.writeFileSync(filePath, content)
  return { directory, filePath, content }
}

test('chunk integrity covers bounded head, middle, and tail windows deterministically', (t) => {
  const { directory, filePath, content } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const anchor = integrity.createFileChunkIntegritySync(filePath, content.length)
  assert.equal(anchor.version, integrity.FILE_CHUNK_INTEGRITY_VERSION)
  assert.equal(anchor.windowBytes, 64 * 1024)
  assert.equal(anchor.anchoredSize, content.length)
  assert.equal(anchor.chunks.length, 4)
  assert.equal(anchor.chunks[0].offset, 0)
  assert.equal(anchor.chunks.at(-1).offset + anchor.chunks.at(-1).length, content.length)
  assert.equal(integrity.isValidFileChunkIntegrity(anchor, content.length), true)
  assert.equal(integrity.verifyFileChunkIntegritySync(filePath, content.length, anchor), true)
  assert.deepEqual(integrity.createFileChunkIntegritySync(filePath, content.length), anchor)
})

test('early same-size rewrite is detected while the legacy tail hash stays equal', (t) => {
  const { directory, filePath, content } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const anchor = integrity.createFileChunkIntegritySync(filePath, content.length)
  const tail = integrity.sha256FileTailSync(filePath, content.length)
  const changed = Buffer.from(content)
  changed[32] ^= 0xff
  fs.writeFileSync(filePath, changed)
  assert.equal(fs.statSync(filePath).size, content.length)
  assert.equal(integrity.sha256FileTailSync(filePath, content.length), tail)
  assert.equal(integrity.verifyFileChunkIntegritySync(filePath, content.length, anchor), false)
})

test('anchored prefix remains verifiable after append and malformed anchor geometry fails closed', (t) => {
  const { directory, filePath, content } = fixture(160 * 1024)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const anchor = integrity.createFileChunkIntegritySync(filePath, content.length)
  fs.appendFileSync(filePath, Buffer.alloc(32 * 1024, 7))
  assert.equal(integrity.verifyFileChunkIntegritySync(filePath, content.length, anchor), true)

  const malformed = structuredClone(anchor)
  malformed.chunks[0].offset += 1
  assert.equal(integrity.isValidFileChunkIntegrity(malformed, content.length), false)
  assert.equal(integrity.verifyFileChunkIntegritySync(filePath, content.length, malformed), false)
})
