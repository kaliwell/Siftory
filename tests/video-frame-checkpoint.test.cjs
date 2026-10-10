const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const checkpointStore = loadTsModule('electron/videoFrameCheckpointStore.ts')
const mediaCacheService = loadTsModule('electron/mediaCacheService.ts')
const videoFrameService = loadTsModule('electron/videoFrameService.ts')

function videoRecord(filePath) {
  const stat = fs.statSync(filePath)
  return {
    videoId: 'checkpoint-video',
    path: filePath,
    name: path.basename(filePath),
    ext: '.mp4',
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    durationMs: 3_000,
    width: 320,
    height: 180,
    metadataStatus: 'done',
    discoveredAt: 1,
    updatedAt: 1,
  }
}

function frameId(videoId, timestampMs) {
  return crypto.createHash('sha1').update(`${videoId}:${timestampMs}`).digest('hex')
}

function createCheckpointRecord(mediaDir, video, timestampMs) {
  const id = frameId(video.videoId, timestampMs)
  const imagePath = path.join(mediaDir, 'frames', video.videoId, `${id}.jpg`)
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, 'checkpoint-frame')
  return {
    frameId: id,
    videoId: video.videoId,
    videoPath: video.path,
    timestampMs,
    imagePath,
    width: 256,
    sourceFingerprint: checkpointStore.videoFrameSourceFingerprint(video),
    status: 'done',
    createdAt: 1,
    updatedAt: 2,
  }
}

test('video frame checkpoints load only bounded authorized records and clear an exact scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frame-checkpoint-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mediaDir = path.join(root, 'media')
  const sourcePath = path.join(root, 'source.mp4')
  fs.writeFileSync(sourcePath, 'source')
  const video = videoRecord(sourcePath)
  const scopeId = checkpointStore.videoFrameCheckpointScopeId([video])
  const record = createCheckpointRecord(mediaDir, video, 0)

  const checkpointPath = checkpointStore.commitVideoFrameCheckpoint(mediaDir, scopeId, 1, [record])
  assert.ok(checkpointPath && fs.existsSync(checkpointPath))
  const tamperedPath = path.join(
    path.dirname(checkpointPath),
    `checkpoint-00000002-${crypto.randomUUID()}.json`,
  )
  fs.writeFileSync(
    tamperedPath,
    `${JSON.stringify({
      version: 1,
      scopeId,
      sequence: 2,
      createdAt: Date.now(),
      records: [{ ...record, imagePath: path.join(root, 'outside.jpg'), updatedAt: 3 }],
    })}\n`,
  )

  const loaded = checkpointStore.loadVideoFrameCheckpoints(mediaDir, [video], scopeId)
  assert.equal(loaded.records.length, 1)
  assert.equal(loaded.records[0].imagePath, record.imagePath)
  assert.equal(loaded.nextSequence, 3)
  assert.equal(loaded.inspectedFiles, 2)
  assert.deepEqual(
    fs.readdirSync(path.dirname(checkpointPath)).filter((name) => name.endsWith('.tmp')),
    [],
  )

  checkpointStore.clearVideoFrameCheckpointScope(mediaDir, scopeId)
  assert.equal(fs.existsSync(path.dirname(checkpointPath)), false)
})

test('frame build resumes an atomically committed checkpoint without reopening the source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frame-checkpoint-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mediaDir = path.join(root, 'media')
  const sourcePath = path.join(root, 'source.mp4')
  fs.writeFileSync(sourcePath, 'not-a-real-video')
  const video = videoRecord(sourcePath)
  const timestampMs = videoFrameService.planVideoFrameTimestamps(video.durationMs, 1, 3_000)[0]
  const record = createCheckpointRecord(mediaDir, video, timestampMs)
  const scopeId = checkpointStore.videoFrameCheckpointScopeId([video])
  checkpointStore.commitVideoFrameCheckpoint(mediaDir, scopeId, 1, [record])
  mediaCacheService.setMediaSearchDirForTests(mediaDir)

  const result = await videoFrameService.buildVideoFrameIndex({
    videos: [video],
    maxFramesPerVideo: 1,
    intervalMs: 3_000,
    width: 256,
  })

  assert.equal(result.total, 1)
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.records[0].status, 'done')
  assert.equal(result.records[0].sourceFingerprint, record.sourceFingerprint)
  assert.equal(
    fs.existsSync(path.join(mediaDir, 'manifests', 'video-frame-checkpoints', scopeId)),
    false,
  )
})

test('checkpoint writer rejects a scope path that has been replaced by a symbolic link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frame-checkpoint-link-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mediaDir = path.join(root, 'media')
  const sourcePath = path.join(root, 'source.mp4')
  const outside = path.join(root, 'outside')
  fs.writeFileSync(sourcePath, 'source')
  fs.mkdirSync(outside)
  const video = videoRecord(sourcePath)
  const scopeId = checkpointStore.videoFrameCheckpointScopeId([video])
  const record = createCheckpointRecord(mediaDir, video, 0)
  const checkpointRoot = path.join(mediaDir, 'manifests', 'video-frame-checkpoints')
  fs.mkdirSync(checkpointRoot, { recursive: true })
  const scopePath = path.join(checkpointRoot, scopeId)
  try {
    fs.symlinkSync(outside, scopePath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`symbolic links are unavailable: ${error.message}`)
    return
  }

  assert.throws(
    () => checkpointStore.commitVideoFrameCheckpoint(mediaDir, scopeId, 1, [record]),
    /not a regular directory|escaped/,
  )
  assert.deepEqual(fs.readdirSync(outside), [])
})
