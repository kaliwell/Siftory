const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  AudioSemanticRuntimeRegistry,
  FakeAudioSemanticRuntime,
  FunAsrAudioSemanticRuntime,
  MissingAudioSemanticRuntime,
  parseAudioDiarizationTurns,
  parseSenseVoiceRichText,
} = loadTsModule('electron/audioSemanticRuntime.ts')
const { AudioSemanticPipelineService } = loadTsModule('electron/audioSemanticPipelineService.ts')

function authority(model) {
  return {
    generationId: 'generation-1',
    assetId: 'asset-1',
    videoId: 'video-1',
    startMs: 0,
    endMs: 1_000,
    sourceFingerprint: 'source-1',
    model,
    createdAt: 100,
  }
}

test('missing audio runtime is explicit and never pretends a model is installed', () => {
  const runtime = new MissingAudioSemanticRuntime()
  assert.deepEqual(runtime.inspect(), {
    adapterId: 'none',
    state: 'not-installed',
    reason: 'audio-model-missing',
  })
  assert.throws(() => runtime.transcribe(), /audio-model-missing/)
})

test('fake audio runtime accepts only bounded in-memory mono PCM and pipeline commits strict output', async () => {
  const runtime = new FakeAudioSemanticRuntime(() => ({
    text: 'fixture dialogue',
    language: 'zh',
    emotion: 'neutral',
    audioEvents: ['speech'],
  }))
  const model = runtime.inspect().model
  const committed = []
  const pipeline = new AudioSemanticPipelineService(runtime, (record) => committed.push(record))
  const record = await pipeline.process({
    authority: authority(model),
    pcm16Base64: Buffer.alloc(32_000).toString('base64'),
  })
  assert.equal(record.text, 'fixture dialogue')
  assert.equal(record.language, 'zh')
  assert.equal(committed.length, 1)
  assert.equal(runtime.requests.length, 1)

  await assert.rejects(
    pipeline.process({ authority: authority(model), pcm16Base64: 'not-base64' }),
    /PCM16/,
  )
})

test('pipeline records a speaker only under independently pinned speaker-model authority', async () => {
  const runtime = new FakeAudioSemanticRuntime(() => ({
    text: 'speaker fixture',
    language: 'en',
    emotion: 'neutral',
    audioEvents: ['speech'],
  }))
  const pipeline = new AudioSemanticPipelineService(runtime, () => {})
  const inputAuthority = authority(runtime.inspect().model)
  inputAuthority.speakerModel = {
    modelId: 'campplus-speaker',
    modelRevision: 'modelscope-v2.0.2',
  }
  const record = await pipeline.process({
    authority: inputAuthority,
    pcm16Base64: Buffer.alloc(32_000).toString('base64'),
    speakerId: 'speaker-1',
  })
  assert.deepEqual(record.speaker, {
    localId: 'speaker-1',
    modelId: 'campplus-speaker',
    modelRevision: 'modelscope-v2.0.2',
  })
})

test('audio runtime registry disposes replaced adapters and pipeline rejects model mismatch', async () => {
  let disposed = false
  const first = new FakeAudioSemanticRuntime()
  first.dispose = () => {
    disposed = true
  }
  const second = new FakeAudioSemanticRuntime()
  const registry = new AudioSemanticRuntimeRegistry(first)
  await registry.replace(second)
  assert.equal(registry.get(), second)
  assert.equal(disposed, true)

  const pipeline = new AudioSemanticPipelineService(second, () => {})
  await assert.rejects(
    pipeline.process({
      authority: authority({ ...second.inspect().model, modelRevision: 'forged' }),
      pcm16Base64: Buffer.alloc(32_000).toString('base64'),
    }),
    /identity-mismatch/,
  )
})

test('SenseVoice rich tags become bounded language, emotion, event, and clean text evidence', () => {
  assert.deepEqual(
    parseSenseVoiceRichText('<|zh|><|HAPPY|><|Speech|><|withitn|>大家好 <|Laughter|>'),
    {
      text: '大家好',
      language: 'zh',
      emotion: 'happy',
      audioEvents: ['speech', 'laughter'],
    },
  )
  assert.deepEqual(parseSenseVoiceRichText('<|nospeech|><|BGM|>'), {
    text: '',
    language: 'nospeech',
    emotion: 'unknown',
    audioEvents: ['bgm'],
  })
})

test('FunASR inspection never marks partial installations ready', () => {
  const missing = new FunAsrAudioSemanticRuntime({
    runtimeRoot: process.cwd(),
    runnerPath: __filename,
    expectedFiles: { 'fixture-model.pt': 1 },
  })
  assert.notEqual(missing.inspect().state, 'ready')
})

test('FunASR child runtime honors explicit packaged runtime and runner paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-sensevoice-child-'))
  const runtimeRoot = path.join(root, 'runtime')
  const runnerPath = path.join(root, 'resources', 'sensevoice', 'sensevoice_runner.py')
  const pythonPath = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe')
  const previousRuntimeRoot = process.env.FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT
  const previousRunnerPath = process.env.FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH
  try {
    fs.mkdirSync(path.dirname(runnerPath), { recursive: true })
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true })
    fs.writeFileSync(runnerPath, '# runner fixture\n')
    fs.writeFileSync(pythonPath, 'python fixture')
    process.env.FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT = runtimeRoot
    process.env.FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH = runnerPath

    const status = new FunAsrAudioSemanticRuntime().inspect()
    assert.equal(status.reason, 'audio-model-missing')
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT
    else process.env.FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT = previousRuntimeRoot
    if (previousRunnerPath === undefined) delete process.env.FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH
    else process.env.FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH = previousRunnerPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('diarization output accepts only bounded ordered normalized 192D embeddings', () => {
  const bytes = Buffer.alloc(192 * 4)
  bytes.writeFloatLE(1, 0)
  const parsed = parseAudioDiarizationTurns(
    [{ startMs: 100, endMs: 900, embeddingF32Base64: bytes.toString('base64') }],
    1_000,
  )
  assert.equal(parsed.turns.length, 1)
  assert.equal(parsed.turns[0].embedding.length, 192)
  assert.throws(() => parseAudioDiarizationTurns([{ startMs: 100, endMs: 1_001 }], 1_000), /range/)
  assert.throws(
    () =>
      parseAudioDiarizationTurns(
        [{ startMs: 100, endMs: 900, embeddingF32Base64: Buffer.alloc(4).toString('base64') }],
        1_000,
      ),
    /dimensions/,
  )
})
