const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { DEFAULT_SPEAKER_COSINE_THRESHOLD, PersistentAudioSpeakerClusterer } = loadTsModule(
  'electron/audioSpeakerClusteringService.ts',
)

const model = { modelId: 'campplus-speaker', modelRevision: 'modelscope-v2.0.2' }

function vector(first, second = 0) {
  const value = Array(192).fill(0)
  value[0] = first
  value[1] = second
  return value
}

test('CAM++ observations form stable anonymous video-local speakers across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-speakers-'))
  try {
    const first = new PersistentAudioSpeakerClusterer(root, 'job-1', 'video-1', model)
    assert.equal(first.assign('turn-1', vector(1)), 'speaker-1')
    assert.equal(first.assign('turn-2', vector(0.9, 0.1)), 'speaker-1')
    assert.equal(first.assign('turn-3', vector(0, 1)), 'speaker-2')
    assert.equal(first.speakerCount, 2)

    const resumed = new PersistentAudioSpeakerClusterer(root, 'job-1', 'video-1', model)
    assert.equal(resumed.assign('turn-1', vector(0, 1)), 'speaker-1')
    assert.equal(resumed.assign('turn-4', vector(0.1, 0.9)), 'speaker-2')
    assert.equal(resumed.speakerCount, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('speaker clustering rejects malformed embeddings and mismatched model identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-speakers-guards-'))
  try {
    const clusterer = new PersistentAudioSpeakerClusterer(root, 'job-1', 'video-1', model)
    assert.throws(() => clusterer.assign('turn-1', [1, 2]), /embedding/)
    clusterer.assign('turn-1', vector(1))
    assert.throws(
      () =>
        new PersistentAudioSpeakerClusterer(root, 'job-1', 'video-1', {
          ...model,
          modelRevision: 'forged',
        }),
      /identity mismatch/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real-sample calibrated default keeps the 0.30 cosine decision boundary stable', () => {
  assert.equal(DEFAULT_SPEAKER_COSINE_THRESHOLD, 0.3)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-speakers-threshold-'))
  try {
    const merged = new PersistentAudioSpeakerClusterer(root, 'job-merge', 'video-1', model)
    merged.assign('turn-1', vector(1))
    assert.equal(
      merged.assign('turn-2', vector(0.31, Math.sqrt(1 - 0.31 ** 2))),
      'speaker-1',
    )

    const split = new PersistentAudioSpeakerClusterer(root, 'job-split', 'video-1', model)
    split.assign('turn-1', vector(1))
    assert.equal(
      split.assign('turn-2', vector(0.29, Math.sqrt(1 - 0.29 ** 2))),
      'speaker-2',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
