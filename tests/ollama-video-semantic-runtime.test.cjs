const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildVideoSemanticPrompt } = loadTsModule('electron/videoSemanticPrompt.ts')
const { OllamaVideoSemanticRuntime } = loadTsModule('electron/ollamaVideoSemanticRuntime.ts')

const DIGEST = 'a'.repeat(64)
const FRAME = 'b'.repeat(40)

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
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
      modelId: 'qwen3-vl:2b-q4_K_M',
      modelRevision: DIGEST,
      quantization: 'Q4_K_M',
      sourceFingerprint: 'source-1',
      createdAt: 100,
    },
    frames: [{ frameId: FRAME, timestampMs: 5_000 }],
  })
}

test('adapter accepts only explicit HTTP loopback origins and safe model names', () => {
  const valid = ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']
  for (const baseUrl of valid) {
    assert.doesNotThrow(
      () => new OllamaVideoSemanticRuntime({ baseUrl, modelName: 'qwen3-vl:2b-q4_K_M' }),
    )
  }
  const invalid = [
    'https://127.0.0.1:11434',
    'http://0.0.0.0:11434',
    'http://192.168.1.5:11434',
    'http://example.com:11434',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434/api',
    'http://127.0.0.1:11434?next=http://evil.test',
    'file:///C:/models',
  ]
  for (const baseUrl of invalid) {
    assert.throws(
      () => new OllamaVideoSemanticRuntime({ baseUrl, modelName: 'qwen3-vl:2b-q4_K_M' }),
      /loopback|Invalid Ollama base URL/,
    )
  }
  for (const modelName of ['../model', 'C:\\models\\qwen.gguf', 'qwen/model', 'qwen model']) {
    assert.throws(() => new OllamaVideoSemanticRuntime({ modelName }), /model name/)
  }
  for (const contextTokens of [0, 4_095, 16_385, 4_096.5]) {
    assert.throws(
      () =>
        new OllamaVideoSemanticRuntime({
          modelName: 'qwen3-vl:2b-q4_K_M',
          contextTokens,
        }),
      /context tokens/,
    )
  }
  for (const gpuLayers of [-1, 1_025, 1.5]) {
    assert.throws(
      () =>
        new OllamaVideoSemanticRuntime({
          modelName: 'qwen3-vl:2b-q4_K_M',
          gpuLayers,
        }),
      /GPU layers/,
    )
  }
})

test('inspect reads exact local model digest and quantization without pulling anything', async () => {
  const calls = []
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    expectedDigest: DIGEST,
    expectedQuantization: 'Q4_K_M',
    fetch: async (url, init) => {
      calls.push({ url, init })
      return response({
        models: [
          {
            name: 'qwen3-vl:2b-q4_K_M',
            digest: DIGEST,
            details: { quantization_level: 'Q4_K_M' },
          },
        ],
      })
    },
  })
  const status = await runtime.inspect()
  assert.equal(status.state, 'ready')
  assert.equal(status.model.modelRevision, DIGEST)
  assert.equal(status.model.quantization, 'Q4_K_M')
  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.redirect]),
    [['http://127.0.0.1:11434/api/tags', 'GET', 'error']],
  )
  assert.equal(
    calls.some((call) => /pull|create|show/.test(call.url)),
    false,
  )
})

test('inspect reports missing, mismatched, and unreachable runtimes distinctly', async () => {
  const missing = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () => response({ models: [] }),
  })
  assert.equal((await missing.inspect()).reason, 'model-missing')

  const mismatch = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    expectedDigest: DIGEST,
    fetch: async () =>
      response({
        models: [
          {
            name: 'qwen3-vl:2b-q4_K_M',
            digest: 'c'.repeat(64),
            details: { quantization_level: 'Q4_K_M' },
          },
        ],
      }),
  })
  assert.equal((await mismatch.inspect()).reason, 'model-identity-mismatch')

  const unavailable = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () => {
      throw new Error('connection refused')
    },
  })
  assert.equal((await unavailable.inspect()).state, 'unavailable')
  assert.match((await unavailable.inspect()).reason, /connection refused/)
})

test('generate sends only fixed messages and bounded in-memory images to /api/chat', async () => {
  let captured
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) }
      return response({ message: { role: 'assistant', content: '{"summary":"ok"}' } })
    },
  })
  const content = await runtime.generate({
    jobId: 'job-1',
    plannedSegmentId: 'segment-1',
    prompt: prompt(),
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 512,
    timeoutMs: 180_000,
  })
  assert.equal(content, '{"summary":"ok"}')
  assert.equal(captured.url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(captured.init.redirect, 'error')
  assert.equal(captured.body.stream, false)
  assert.equal(captured.body.think, false)
  assert.equal(captured.body.options.temperature, 0)
  assert.equal(captured.body.options.num_ctx, 8_192)
  assert.equal(captured.body.options.num_predict, 512)
  assert.equal('num_gpu' in captured.body.options, false)
  assert.equal(captured.body.messages[0].role, 'system')
  assert.deepEqual(captured.body.messages[1].images, ['aGVsbG8='])
  assert.equal(JSON.stringify(captured.body).includes('C:\\'), false)
  assert.equal(captured.body.format.additionalProperties, false)
})

test('generate raises an obsolete 4096-token vision budget during prompt preflight', async () => {
  let captured
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    contextTokens: 4_096,
    gpuLayers: 20,
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body)
      return response({ message: { role: 'assistant', content: '{"summary":"ok"}' } })
    },
  })
  await runtime.generate({
    jobId: 'job-low-memory',
    plannedSegmentId: 'segment-low-memory',
    prompt: prompt(),
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 512,
    timeoutMs: 180_000,
  })
  assert.equal(captured.options.num_ctx, 8_192)
  assert.equal(captured.options.num_gpu, 20)
})

test('generate expands a large bounded prompt before contacting Ollama', async () => {
  let captured
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body)
      return response({ message: { role: 'assistant', content: '{"summary":"ok"}' } })
    },
  })
  const largePrompt = prompt()
  largePrompt.messages[1].content += 'x'.repeat(20_000)
  await runtime.generate({
    jobId: 'job-large-prompt',
    plannedSegmentId: 'segment-large-prompt',
    prompt: largePrompt,
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 1_024,
    timeoutMs: 180_000,
    maximumContextTokens: 16_384,
  })
  assert.equal(captured.options.num_ctx, 12_288)
})

test('generate retries a structured Ollama context overflow at the next bounded tier', async () => {
  const contexts = []
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      contexts.push(body.options.num_ctx)
      if (contexts.length === 1) {
        return response(
          {
            error: JSON.stringify({
              error: {
                code: 400,
                message: 'request exceeds the available context size',
                type: 'exceed_context_size_error',
                n_prompt_tokens: 9_000,
                n_ctx: 8_192,
              },
            }),
          },
          400,
        )
      }
      return response({ message: { role: 'assistant', content: '{"summary":"ok"}' } })
    },
  })
  const content = await runtime.generate({
    jobId: 'job-context-retry',
    plannedSegmentId: 'segment-context-retry',
    prompt: prompt(),
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 1_024,
    timeoutMs: 180_000,
    maximumContextTokens: 16_384,
  })
  assert.equal(content, '{"summary":"ok"}')
  assert.deepEqual(contexts, [8_192, 12_288])
})

test('generate stops locally when the estimated prompt exceeds its authoritative context cap', async () => {
  let calls = 0
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () => {
      calls += 1
      return response({})
    },
  })
  const oversizedPrompt = prompt()
  oversizedPrompt.messages[1].content += 'x'.repeat(50_000)
  await assert.rejects(
    runtime.generate({
      jobId: 'job-context-cap',
      plannedSegmentId: 'segment-context-cap',
      prompt: oversizedPrompt,
      images: [
        { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
      ],
      maximumOutputTokens: 1_024,
      timeoutMs: 180_000,
      maximumContextTokens: 8_192,
    }),
    /estimated prompt.*context cap/i,
  )
  assert.equal(calls, 0)
})

test('generate lets an authoritative request override bounded runtime resource defaults', async () => {
  let captured
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    contextTokens: 4_096,
    gpuLayers: 20,
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body)
      return response({ message: { role: 'assistant', content: '{"summary":"ok"}' } })
    },
  })
  await runtime.generate({
    jobId: 'job-resource-retry',
    plannedSegmentId: 'segment-resource-retry',
    prompt: prompt(),
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 512,
    timeoutMs: 180_000,
    contextTokens: 8_192,
    gpuLayers: 12,
  })
  assert.equal(captured.options.num_ctx, 8_192)
  assert.equal(captured.options.num_gpu, 12)
})

test('generate extracts only a bounded terminal JSON object from Qwen thinking', async () => {
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () =>
      response({
        message: {
          role: 'assistant',
          content: '',
          thinking: '{"summary":"schema output"}',
        },
      }),
  })
  const base = {
    jobId: 'job-1',
    plannedSegmentId: 'segment-1',
    prompt: prompt(),
    images: [
      { frameId: FRAME, timestampMs: 5_000, mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' },
    ],
    maximumOutputTokens: 512,
    timeoutMs: 180_000,
  }
  assert.equal(await runtime.generate(base), '{"summary":"schema output"}')

  const traceRuntime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () =>
      response({
        message: {
          role: 'assistant',
          content: '',
          thinking: 'bounded reasoning\n```json\n{"summary":"terminal schema output"}\n```',
        },
      }),
  })
  assert.equal(await traceRuntime.generate(base), '{"summary":"terminal schema output"}')

  const missingRuntime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () =>
      response({
        message: { role: 'assistant', content: '', thinking: 'reasoning without output' },
      }),
  })
  await assert.rejects(missingRuntime.generate(base), /did not contain a JSON object/)
})

test('generate rejects paths, data URLs, missing bytes, and oversized image payloads before fetch', async () => {
  let calls = 0
  const runtime = new OllamaVideoSemanticRuntime({
    modelName: 'qwen3-vl:2b-q4_K_M',
    fetch: async () => {
      calls += 1
      return response({})
    },
  })
  const base = {
    jobId: 'job-1',
    plannedSegmentId: 'segment-1',
    prompt: prompt(),
    maximumOutputTokens: 512,
    timeoutMs: 180_000,
  }
  await assert.rejects(
    runtime.generate({
      ...base,
      images: [{ frameId: FRAME, timestampMs: 1, dataBase64: 'data:image/jpeg;base64,aA==' }],
    }),
    /image payload/,
  )
  await assert.rejects(
    runtime.generate({
      ...base,
      images: [{ frameId: FRAME, timestampMs: 1 }],
    }),
    /in-memory image evidence/,
  )
  await assert.rejects(
    runtime.generate({
      ...base,
      images: [{ frameId: FRAME, timestampMs: 1, dataBase64: 'a'.repeat(8 * 1024 * 1024 + 4) }],
    }),
    /image payload/,
  )
  assert.equal(calls, 0)
})
