const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildVideoSemanticPrompt } = loadTsModule('electron/videoSemanticPrompt.ts')
const { LlamaCppVideoSemanticRuntime } = loadTsModule('electron/llamaCppVideoSemanticRuntime.ts')

const DIGESTS = {
  server: 'a'.repeat(64),
  model: 'b'.repeat(64),
  projector: 'c'.repeat(64),
}
const MODEL_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
const FRAME = 'd'.repeat(40)

class FakeChild extends EventEmitter {
  exitCode = null
  signalCode = null
  killCalls = 0

  kill() {
    this.killCalls += 1
    this.exitCode = 0
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  }
}

function paths() {
  const root = path.resolve('fixtures', 'llama cpp')
  return {
    serverExecutablePath: path.join(root, 'llama-server.exe'),
    modelPath: path.join(root, 'Qwen3VL-2B-Instruct-Q4_K_M.gguf'),
    mmprojPath: path.join(root, 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'),
  }
}

function options(overrides = {}) {
  const fileDigests = new Map([
    [paths().serverExecutablePath, DIGESTS.server],
    [paths().modelPath, DIGESTS.model],
    [paths().mmprojPath, DIGESTS.projector],
  ])
  return {
    ...paths(),
    expectedServerSha256: DIGESTS.server,
    expectedModelSha256: DIGESTS.model,
    expectedMmprojSha256: DIGESTS.projector,
    modelId: 'qwen3-vl-2b-instruct-q4_k_m',
    modelRevision: MODEL_REVISION,
    quantization: 'Q4_K_M',
    apiKey: 'e'.repeat(64),
    fileExists: async (filePath) => fileDigests.has(filePath),
    hashFile: async (filePath) => fileDigests.get(filePath),
    ...overrides,
  }
}

function prompt() {
  return buildVideoSemanticPrompt({
    authority: {
      generationId: 'generation-1',
      assetId: 'asset-1',
      videoId: 'video-1',
      startMs: 0,
      endMs: 10_000,
      profileId: 'general',
      evidenceFrameIds: [FRAME],
      evidenceFrameDigest: 'digest',
      modelId: 'qwen3-vl-2b-instruct-q4_k_m',
      modelRevision: MODEL_REVISION,
      quantization: 'Q4_K_M',
      sourceFingerprint: 'source-1',
      createdAt: 100,
    },
    frames: [{ frameId: FRAME, timestampMs: 5_000 }],
  })
}

test('requires absolute typed resource paths, fixed digests, and bounded execution settings', () => {
  for (const key of ['serverExecutablePath', 'modelPath', 'mmprojPath']) {
    assert.throws(
      () => new LlamaCppVideoSemanticRuntime(options({ [key]: '../unsafe' })),
      /absolute/,
    )
  }
  assert.throws(
    () => new LlamaCppVideoSemanticRuntime(options({ expectedModelSha256: 'not-a-digest' })),
    /SHA-256/,
  )
  for (const port of [0, 80, 65_536, 4_000.5]) {
    assert.throws(() => new LlamaCppVideoSemanticRuntime(options({ port })), /port/)
  }
  for (const gpuLayers of [-1, 1_025, 1.5]) {
    assert.throws(() => new LlamaCppVideoSemanticRuntime(options({ gpuLayers })), /GPU layers/)
  }
})

test('fails closed for missing and digest-mismatched resources before spawning', async () => {
  let spawnCalls = 0
  const missing = new LlamaCppVideoSemanticRuntime(
    options({
      fileExists: async (filePath) => filePath !== paths().modelPath,
      spawn: () => {
        spawnCalls += 1
        return new FakeChild()
      },
    }),
  )
  assert.deepEqual(await missing.inspect(), {
    adapterId: 'llama-cpp-managed',
    state: 'not-installed',
    reason: 'model-missing',
  })
  assert.equal(spawnCalls, 0)

  const mismatch = new LlamaCppVideoSemanticRuntime(
    options({
      hashFile: async (filePath) =>
        filePath === paths().mmprojPath
          ? 'f'.repeat(64)
          : DIGESTS[filePath.endsWith('.exe') ? 'server' : 'model'],
      spawn: () => {
        spawnCalls += 1
        return new FakeChild()
      },
    }),
  )
  assert.equal((await mismatch.inspect()).reason, 'projector-digest-mismatch')
  assert.equal(spawnCalls, 0)
})

test('managed server is loopback-only, offline, authenticated, shell-free, and disposable', async () => {
  const calls = []
  const spawns = []
  const child = new FakeChild()
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      port: 49_175,
      spawn: (executable, args, spawnOptions) => {
        spawns.push({ executable, args, options: spawnOptions })
        return child
      },
      fetch: async (url, init) => {
        calls.push({ url, init })
        return response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] })
      },
    }),
  )

  const status = await runtime.inspect()
  assert.equal(status.state, 'ready')
  assert.equal(status.model.modelRevision, MODEL_REVISION)
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].executable, paths().serverExecutablePath)
  assert.equal(spawns[0].options.shell, false)
  assert.equal(spawns[0].options.windowsHide, true)
  assert.equal(spawns[0].options.env.HF_HUB_OFFLINE, '1')
  assert.equal(spawns[0].options.env.TRANSFORMERS_OFFLINE, '1')
  assert.equal(spawns[0].options.env.LLAMA_API_KEY, 'e'.repeat(64))
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'ignore', 'ignore'])
  assert.deepEqual(spawns[0].args.slice(0, 10), [
    '--model',
    paths().modelPath,
    '--mmproj',
    paths().mmprojPath,
    '--no-mmproj-auto',
    '--host',
    '127.0.0.1',
    '--port',
    '49175',
    '--alias',
  ])
  assert.equal(spawns[0].args.includes('--no-ui'), true)
  assert.equal(spawns[0].args.includes('--api-key'), false)
  assert.equal(spawns[0].args.includes('e'.repeat(64)), false)
  assert.equal(spawns[0].args.includes('-hf'), false)
  assert.equal(spawns[0].args.includes('--model-url'), false)
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:49175\/v1\/models$/)
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers.authorization, `Bearer ${'e'.repeat(64)}`)
  }

  await runtime.dispose()
  assert.equal(child.killCalls, 1)
})

test('spawn errors become an unavailable status instead of an unhandled process error', async () => {
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => {
        const child = new FakeChild()
        queueMicrotask(() => child.emit('error', new Error('fixture spawn failure with a path')))
        return child
      },
      fetch: async () => {
        throw new Error('not listening')
      },
    }),
  )
  const status = await runtime.inspect()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.reason, 'llama.cpp server could not be started')
  assert.doesNotMatch(status.reason, /fixture|path/i)
})

test('concurrent inspections coalesce startup into one sidecar process', async () => {
  let spawnCalls = 0
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => {
        spawnCalls += 1
        return new FakeChild()
      },
      fetch: async () => response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] }),
    }),
  )
  const statuses = await Promise.all([runtime.inspect(), runtime.inspect(), runtime.inspect()])
  assert.equal(spawnCalls, 1)
  assert.ok(statuses.every((status) => status.state === 'ready'))
  await runtime.dispose()
})

test('an occupied or incompatible port times out safely and reclaims the child', async () => {
  const child = new FakeChild()
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      startupTimeoutMs: 1_000,
      spawn: () => child,
      fetch: async () => response({ error: 'foreign listener' }, 409),
    }),
  )
  const status = await runtime.inspect()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.reason, 'llama.cpp server startup timed out')
  assert.equal(child.killCalls, 1)
})

test('chat sends only bounded in-memory data URLs and schema-constrained JSON', async () => {
  const calls = []
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => new FakeChild(),
      fetch: async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/v1/models')) {
          return response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] })
        }
        return response({
          choices: [{ message: { content: '{"summary":"ok","scenes":[]}' } }],
        })
      },
    }),
  )
  const result = await runtime.generate({
    jobId: 'job-1',
    plannedSegmentId: 'segment-1',
    prompt: prompt(),
    images: [{ frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'YWJj' }],
    maximumOutputTokens: 512,
    timeoutMs: 10_000,
  })
  assert.equal(result, '{"summary":"ok","scenes":[]}')
  const chat = calls.find((call) => call.url.endsWith('/v1/chat/completions'))
  const body = JSON.parse(chat.init.body)
  assert.equal(body.stream, false)
  assert.equal(body.temperature, 0)
  assert.equal(body.response_format.type, 'json_object')
  assert.equal(body.response_format.schema.additionalProperties, false)
  assert.equal(body.response_format.schema.properties.events.maxItems, 4)
  assert.equal(body.response_format.schema.properties.objects.maxItems, 8)
  assert.equal(body.response_format.schema.properties.persons.items.properties.actions.maxItems, 4)
  assert.equal(body.chat_template_kwargs.enable_thinking, false)
  const image = body.messages[1].content.find((part) => part.type === 'image_url')
  assert.equal(image.image_url.url, 'data:image/jpeg;base64,YWJj')
  assert.equal(JSON.stringify(body).includes('C:\\'), false)
  assert.equal(JSON.stringify(body).includes('http://'), false)
  await runtime.dispose()
})

test('extracts a deeply nested JSON object from compatibility text', async () => {
  const events = Array.from({ length: 80 }, (_, index) => ({
    label: `event-${index}`,
    description: `description-${index}`,
    startMs: index,
    endMs: index + 1,
    confidence: 0.5,
  }))
  const expected = JSON.stringify({
    summary: 'deep output',
    scenes: [],
    events,
    persons: [],
    objects: [],
    searchTags: [],
    visualText: [],
    audioEvents: [],
    warnings: [],
  })
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => new FakeChild(),
      fetch: async (url) =>
        url.endsWith('/v1/models')
          ? response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] })
          : response({
              choices: [
                { message: { content: `compatibility prefix\n\`\`\`json\n${expected}\n\`\`\`` } },
              ],
            }),
    }),
  )
  const result = await runtime.generate({
    jobId: 'job-deep',
    plannedSegmentId: 'segment-deep',
    prompt: prompt(),
    images: [{ frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'YWJj' }],
    maximumOutputTokens: 1_024,
    timeoutMs: 10_000,
  })
  assert.equal(result, expected)
  await runtime.dispose()
})

test('rejects responses that llama.cpp reports as token-limited truncation', async () => {
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => new FakeChild(),
      fetch: async (url) =>
        url.endsWith('/v1/models')
          ? response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] })
          : response({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    }),
  )
  await assert.rejects(
    runtime.generate({
      jobId: 'job-truncated',
      plannedSegmentId: 'segment-truncated',
      prompt: prompt(),
      images: [{ frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'YWJj' }],
      maximumOutputTokens: 512,
      timeoutMs: 10_000,
    }),
    /truncated at token limit/,
  )
  await runtime.dispose()
})

test('rejects file-backed, malformed, and oversized image evidence', async () => {
  const runtime = new LlamaCppVideoSemanticRuntime(
    options({
      spawn: () => new FakeChild(),
      fetch: async (url) =>
        url.endsWith('/v1/models')
          ? response({ data: [{ id: 'qwen3-vl-2b-instruct-q4_k_m' }] })
          : response({ choices: [{ message: { content: '{}' } }] }),
    }),
  )
  const base = {
    jobId: 'job-1',
    plannedSegmentId: 'segment-1',
    prompt: prompt(),
    maximumOutputTokens: 512,
    timeoutMs: 10_000,
  }
  await assert.rejects(
    runtime.generate({ ...base, images: [{ frameId: FRAME, timestampMs: 0 }] }),
    /in-memory/,
  )
  await assert.rejects(
    runtime.generate({
      ...base,
      images: [{ frameId: FRAME, timestampMs: 0, dataBase64: 'not base64!' }],
    }),
    /in-memory/,
  )
  await assert.rejects(
    runtime.generate({
      ...base,
      images: [{ frameId: FRAME, timestampMs: 0, dataBase64: 'Y'.repeat(8 * 1024 * 1024 + 4) }],
    }),
    /per-image limit/,
  )
  await runtime.dispose()
})
