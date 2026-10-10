const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  createDefaultVideoSemanticRuntime,
  VIDEO_SEMANTIC_GGUF_REVISION,
  VIDEO_SEMANTIC_LLAMA_CPP_COMMIT,
  VIDEO_SEMANTIC_LLAMA_CPP_DESCRIPTOR,
  VIDEO_SEMANTIC_LLAMA_CPP_RELEASE,
} = loadTsModule('electron/videoSemanticRuntimeFactory.ts')

const root = path.resolve('fixtures', 'packaged-resources')
const SHA = 'a'.repeat(64)

function descriptor(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    runtime: {
      release: VIDEO_SEMANTIC_LLAMA_CPP_RELEASE,
      commit: VIDEO_SEMANTIC_LLAMA_CPP_COMMIT,
      file: 'llama-cpp/llama-server.exe',
      sha256: SHA,
    },
    model: {
      id: 'qwen3-vl-2b-instruct-q4_k_m',
      revision: VIDEO_SEMANTIC_GGUF_REVISION,
      quantization: 'Q4_K_M',
      file: 'video-semantic/Qwen3VL-2B-Instruct-Q4_K_M.gguf',
      sha256: 'b'.repeat(64),
    },
    projector: {
      file: 'video-semantic/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
      sha256: 'c'.repeat(64),
    },
    approval: {
      status: 'approved',
      approvedBy: 'release-owner',
      approvedAt: '2026-08-15T12:00:00Z',
      evidenceId: 'VID017-approval-1',
      distributionProfile: 'offline',
    },
    ...overrides,
  })
}

test('development and packages without an approved descriptor keep the current Ollama runtime', () => {
  const development = createDefaultVideoSemanticRuntime({
    resourcesRoot: root,
    allowManagedLlamaCpp: false,
    descriptorExists: () => true,
    readDescriptor: () => descriptor(),
  })
  assert.equal(development.adapterId, 'ollama-loopback')

  const absent = createDefaultVideoSemanticRuntime({
    resourcesRoot: root,
    allowManagedLlamaCpp: true,
    descriptorExists: () => false,
  })
  assert.equal(absent.adapterId, 'ollama-loopback')
})

test('an exact approved packaged descriptor activates the managed runtime', () => {
  let requestedPath = ''
  const runtime = createDefaultVideoSemanticRuntime({
    resourcesRoot: root,
    allowManagedLlamaCpp: true,
    descriptorExists: (filePath) => {
      requestedPath = filePath
      return true
    },
    readDescriptor: () => descriptor(),
  })
  assert.equal(requestedPath, path.join(root, ...VIDEO_SEMANTIC_LLAMA_CPP_DESCRIPTOR.split('/')))
  assert.equal(runtime.adapterId, 'llama-cpp-managed')
})

test('invalid, unapproved, changed-version, and path-injected descriptors fail closed', async () => {
  const invalid = [
    '{',
    descriptor({ approval: { status: 'pending' } }),
    descriptor({
      runtime: {
        release: 'latest',
        commit: VIDEO_SEMANTIC_LLAMA_CPP_COMMIT,
        file: 'llama-cpp/llama-server.exe',
        sha256: SHA,
      },
    }),
    descriptor({
      model: {
        id: 'qwen3-vl-2b-instruct-q4_k_m',
        revision: VIDEO_SEMANTIC_GGUF_REVISION,
        quantization: 'Q4_K_M',
        file: '../outside.gguf',
        sha256: 'b'.repeat(64),
      },
    }),
  ]
  for (const raw of invalid) {
    const runtime = createDefaultVideoSemanticRuntime({
      resourcesRoot: root,
      allowManagedLlamaCpp: true,
      descriptorExists: () => true,
      readDescriptor: () => raw,
    })
    assert.equal(runtime.adapterId, 'llama-cpp-managed')
    assert.deepEqual(await runtime.inspect(), {
      adapterId: 'llama-cpp-managed',
      state: 'error',
      reason: 'managed-runtime-config-invalid',
    })
  }
})
