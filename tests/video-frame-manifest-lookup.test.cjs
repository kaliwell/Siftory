const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { VideoFrameManifestLookup } = loadTsModule('electron/videoFrameManifestLookup.ts')

function record(index, status = 'done') {
  return {
    frameId: index.toString(16).padStart(40, '0'),
    videoId: 'a'.repeat(40),
    videoPath: `D:\\videos\\${index}.mp4`,
    timestampMs: index * 1000,
    imagePath: `D:\\frames\\${index}.jpg`,
    width: 640,
    status,
    createdAt: index,
    updatedAt: index,
  }
}

test('frame manifest lookup migrates JSONL with bounded count, preview, and point lookup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-manifest-db-'))
  try {
    const manifest = path.join(root, 'video_frames.jsonl')
    const database = path.join(root, 'video_frames.lookup.sqlite')
    const records = Array.from({ length: 10_000 }, (_, index) =>
      record(index, index % 5 ? 'done' : 'error'),
    )
    const descriptor = fs.openSync(manifest, 'w')
    try {
      for (const value of records) fs.writeSync(descriptor, `${JSON.stringify(value)}\n`)
    } finally {
      fs.closeSync(descriptor)
    }
    const lookup = new VideoFrameManifestLookup(manifest, database)
    assert.equal(lookup.countDone(), 8000)
    const preview = lookup.preview(5)
    assert.equal(preview.total, 10_000)
    assert.deepEqual(
      preview.frames.map((value) => value.timestampMs),
      [9_999_000, 9_998_000, 9_997_000, 9_996_000, 9_995_000],
    )
    assert.equal(lookup.findReady(record(9999).frameId).timestampMs, 9_999_000)
    assert.equal(lookup.findReady(record(0).frameId), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('frame manifest lookup atomically replaces and repairs stale derived state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-manifest-db-'))
  try {
    const manifest = path.join(root, 'video_frames.jsonl')
    const database = path.join(root, 'video_frames.lookup.sqlite')
    fs.writeFileSync(manifest, `${JSON.stringify(record(1))}\n`)
    const lookup = new VideoFrameManifestLookup(manifest, database)
    assert.equal(lookup.countDone(), 1)
    fs.writeFileSync(manifest, `${JSON.stringify(record(2, 'error'))}\n`)
    assert.equal(lookup.countDone(), 0)
    fs.writeFileSync(manifest, `${JSON.stringify(record(3))}\n`)
    lookup.replace([record(3)])
    assert.equal(lookup.findReady(record(3).frameId).timestampMs, 3000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('frame manifest lookup rebuilds a corrupt derived database from the authoritative stream', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-manifest-corrupt-'))
  try {
    const manifest = path.join(root, 'video_frames.jsonl')
    const database = path.join(root, 'video_frames.lookup.sqlite')
    fs.writeFileSync(
      manifest,
      `${JSON.stringify(record(7))}\n${JSON.stringify(record(8, 'error'))}\n`,
    )
    const lookup = new VideoFrameManifestLookup(manifest, database)
    assert.equal(lookup.countDone(), 1)
    fs.writeFileSync(database, 'not-a-sqlite-database')
    assert.equal(lookup.countDone(), 1)
    assert.equal(lookup.preview(10).total, 2)
    assert.equal(lookup.findReady(record(7).frameId).timestampMs, 7000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
