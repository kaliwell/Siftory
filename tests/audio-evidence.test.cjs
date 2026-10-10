const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { extractAudioEvidencePcm16, planAudioEvidenceChunks } = loadTsModule(
  'electron/audioEvidenceService.ts',
)

test('audio evidence planner creates deterministic chunks no longer than 30 seconds', () => {
  assert.deepEqual(planAudioEvidenceChunks(65_000), [
    { startMs: 0, endMs: 30_000 },
    { startMs: 30_000, endMs: 60_000 },
    { startMs: 60_000, endMs: 65_000 },
  ])
  assert.throws(() => planAudioEvidenceChunks(999), /duration/)
})

test('audio extraction uses argument arrays and returns bounded 16 kHz mono PCM', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-evidence-'))
  const videoPath = path.join(root, 'video with spaces.mp4')
  fs.writeFileSync(videoPath, 'fixture')
  let captured
  try {
    const result = extractAudioEvidencePcm16(
      { videoPath, startMs: 1_000, endMs: 2_000 },
      {
        ffmpegCommand: 'ffmpeg-fixture',
        spawn: (command, args, options) => {
          captured = { command, args, options }
          return {
            pid: 1,
            output: [],
            stdout: Buffer.alloc(32_000),
            stderr: Buffer.alloc(0),
            status: 0,
            signal: null,
          }
        },
      },
    )
    assert.equal(result.sampleRate, 16_000)
    assert.equal(result.channels, 1)
    assert.equal(Buffer.from(result.pcm16Base64, 'base64').length, 32_000)
    assert.equal(captured.command, 'ffmpeg-fixture')
    assert.equal(captured.args[captured.args.indexOf('-i') + 1], videoPath)
    assert.equal(captured.options.windowsHide, true)
    assert.equal(captured.options.timeout, 60_000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('audio extraction trims decoder tail samples to the authoritative duration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-evidence-tail-'))
  const videoPath = path.join(root, 'tail.mp4')
  fs.writeFileSync(videoPath, 'fixture')
  try {
    const result = extractAudioEvidencePcm16(
      { videoPath, startMs: 1_000, endMs: 2_000 },
      {
        ffmpegCommand: 'ffmpeg-fixture',
        spawn: () => ({
          pid: 1,
          output: [],
          stdout: Buffer.alloc(33_024),
          stderr: Buffer.alloc(0),
          status: 0,
          signal: null,
        }),
      },
    )
    assert.equal(Buffer.from(result.pcm16Base64, 'base64').length, 32_000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
