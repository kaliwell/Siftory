const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { EmbeddingPreparationSpool } = loadTsModule('electron/embeddingPreparationSpool.ts')

test('embedding preparation spool bounds existing lookup and candidate ACK windows on disk', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-prep-spool-'))
  const filePath = path.join(root, 'queue.sqlite')
  const spool = new EmbeddingPreparationSpool(filePath)
  t.after(() => {
    spool.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })

  spool.beginExistingLoad()
  for (let index = 0; index < 20_000; index++) spool.add(`existing-${index}`)
  spool.add('existing-0')
  spool.delete('existing-10')
  spool.endExistingLoad()
  assert.equal(spool.size, 19_999)
  assert.equal(spool.hasExisting('existing-0'), true)
  assert.equal(spool.hasExisting('existing-10'), false)

  for (let index = 0; index < 20_000; index++) {
    assert.equal(
      spool.addCandidate(`candidate-${index}`, {
        imageId: `C:/images/${index}.jpg`,
        imagePath: `C:/images/${index}.jpg`,
      }),
      true,
    )
  }
  assert.equal(
    spool.addCandidate('candidate-0', {
      imageId: 'duplicate',
      imagePath: 'duplicate',
    }),
    false,
  )
  const window = spool.peekCandidates(999)
  assert.equal(window.items.length, 256)
  assert.equal(window.ids.length, 256)
  assert.equal(window.items[0].imageId, 'C:/images/0.jpg')
  spool.acknowledgeCandidates(window.ids)
  assert.equal(spool.candidateCount(), 19_744)
})

test('embedding preparation source uses ACK backpressure without a full candidate array', () => {
  const childSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingPreparationChild.ts'),
    'utf8',
  )
  const serviceSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingService.ts'),
    'utf8',
  )
  assert.match(childSource, /EmbeddingPreparationSpool/)
  assert.match(childSource, /await acknowledged/)
  assert.doesNotMatch(childSource, /const candidates:\s*PreparedInput\[\]\s*=\s*\[\]/)
  assert.match(serviceSource, /preparationProducerOpen/)
  assert.match(serviceSource, /queueHighWater = producerChunkSize \* 2/)
  assert.match(serviceSource, /preparation-child:chunk-ack/)
})
