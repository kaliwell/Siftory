const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { AudioSemanticJobService } = loadTsModule('electron/audioSemanticJobService.ts')

const model = {
  modelId: 'FunAudioLLM/SenseVoiceSmall',
  modelRevision: 'fixture-revision',
  runtime: 'funasr',
  quantization: 'fp32',
}

function video(root, videoId, durationMs) {
  return {
    videoId,
    assetId: videoId,
    videoPath: path.join(root, `${videoId}.mp4`),
    durationMs,
    sourceFingerprint: `source-${videoId}`,
  }
}

test('audio semantic job persists bounded deterministic cursors and resumes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-job-'))
  try {
    const service = new AudioSemanticJobService(root)
    const job = service.create([video(root, 'video-1', 65_000), video(root, 'video-2', 10_000)], model, 100)
    assert.equal(job.totalVideos, 2)
    assert.equal(job.totalSegments, 4)
    assert.equal(job.currentVideoId, 'video-1')
    assert.equal(job.currentStartMs, 0)
    service.markRunning(job.jobId)
    service.advanceSegment(job.jobId)
    const resumed = new AudioSemanticJobService(root).load()
    assert.equal(resumed.state, 'running')
    assert.equal(resumed.segmentCursor, 1)
    assert.equal(resumed.completedSegments, 1)
    assert.equal(resumed.currentStartMs, 30_000)
    service.markStopped(job.jobId)
    assert.equal(service.markRunning(job.jobId).state, 'running')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('staged records deduplicate replayed segment ids and failures advance independently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-stage-'))
  try {
    const service = new AudioSemanticJobService(root)
    const job = service.create([video(root, 'video-1', 31_000)], model, 200)
    const record = {
      schemaVersion: 1,
      segmentId: 'segment-1',
      generationId: job.generationId,
      assetId: 'video-1',
      videoId: 'video-1',
      startMs: 0,
      endMs: 30_000,
      text: 'fixture',
      language: 'zh',
      emotion: 'neutral',
      audioEvents: [],
      transcriptRef: 'asr:segment-1',
      modelId: model.modelId,
      modelRevision: model.modelRevision,
      runtime: 'funasr',
      quantization: 'fp32',
      sourceFingerprint: 'source-video-1',
      createdAt: 200,
    }
    service.stageRecord(job.jobId, record)
    service.stageRecord(job.jobId, { ...record, text: 'latest' })
    assert.equal(service.recordsForVideo(job.jobId, 'video-1').length, 1)
    assert.equal(service.recordsForVideo(job.jobId, 'video-1')[0].text, 'latest')
    service.advanceSegment(job.jobId, new Error('fixture failure'))
    const failed = service.load()
    assert.equal(failed.failedSegments, 1)
    assert.equal(failed.completedSegments, 0)
    assert.equal(failed.segmentCursor, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable video is skipped once while preserving the remaining resumable cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-skip-'))
  try {
    const service = new AudioSemanticJobService(root)
    const job = service.create(
      [video(root, 'broken-video', 65_000), video(root, 'ready-video', 10_000)],
      model,
      300,
    )
    const skipped = service.skipCurrentVideo(job.jobId, new Error('ffmpeg fixture failure'))
    assert.equal(skipped.videoCursor, 1)
    assert.equal(skipped.segmentCursor, 0)
    assert.equal(skipped.completedVideos, 1)
    assert.equal(skipped.failedSegments, 3)
    assert.equal(skipped.currentVideoId, 'ready-video')
    assert.equal(skipped.currentStartMs, 0)
    assert.match(skipped.lastError, /ffmpeg fixture failure/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a tampered persisted chunk plan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-tamper-'))
  try {
    const service = new AudioSemanticJobService(root)
    service.create([video(root, 'video-1', 31_000)], model, 400)
    const persisted = JSON.parse(fs.readFileSync(service.jobPath, 'utf8'))
    persisted.videos[0].chunks[0].endMs = 300_000
    fs.writeFileSync(service.jobPath, JSON.stringify(persisted), 'utf8')
    assert.equal(new AudioSemanticJobService(root).load(), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
