'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const cacheDirectory = loadTsModule('electron/transformersCacheDirectory.ts')

function fixturePaths(root) {
  const modelRoot = path.join(root, 'models-root')
  return {
    modelRoot,
    modelPath: path.join(modelRoot, 'models', 'dinov2', 'onnx', 'model_quantized.onnx'),
  }
}

test('explicit absolute TRANSFORMERS_CACHE takes priority for child configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-transformers-cache-'))
  try {
    const { modelRoot, modelPath } = fixturePaths(root)
    const sandboxCache = path.join(root, 'formal-sandbox-cache')
    fs.mkdirSync(sandboxCache)
    const target = {
      localModelPath: '',
      cacheDir: '',
      allowLocalModels: false,
      allowRemoteModels: true,
    }

    const configured = cacheDirectory.configureLocalTransformersEnvironment(target, modelPath, {
      TRANSFORMERS_CACHE: sandboxCache,
    })

    assert.deepEqual(configured, {
      modelRoot: path.resolve(modelRoot),
      cacheDir: path.resolve(sandboxCache),
    })
    assert.equal(target.localModelPath, path.resolve(modelRoot))
    assert.equal(target.cacheDir, path.resolve(sandboxCache))
    assert.equal(target.allowLocalModels, true)
    assert.equal(target.allowRemoteModels, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unset TRANSFORMERS_CACHE preserves the model-root fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-transformers-fallback-'))
  try {
    const { modelRoot } = fixturePaths(root)
    assert.equal(
      cacheDirectory.resolveTransformersCacheDirectory(modelRoot, {}),
      path.join(modelRoot, '.transformers-cache'),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('relative, empty, whitespace, control-character, and NUL cache values fail closed', () => {
  const modelRoot = path.resolve('models-root-fixture')
  for (const value of [
    '',
    '   ',
    'relative/cache',
    `.${path.sep}relative-cache`,
    `${path.parse(modelRoot).root}cache\npath`,
    `${path.parse(modelRoot).root}cache\0path`,
  ]) {
    assert.throws(
      () =>
        cacheDirectory.resolveTransformersCacheDirectory(modelRoot, {
          TRANSFORMERS_CACHE: value,
        }),
      /TRANSFORMERS_CACHE/,
      JSON.stringify(value),
    )
  }
})

test('an absolute existing file is rejected as a cache directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-transformers-file-'))
  try {
    const filePath = path.join(root, 'not-a-directory')
    fs.writeFileSync(filePath, 'fixture')
    assert.throws(
      () =>
        cacheDirectory.resolveTransformersCacheDirectory(root, {
          TRANSFORMERS_CACHE: filePath,
        }),
      /non-directory/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('DINO and CLIP children both delegate cache selection to the shared helper', () => {
  const projectRoot = path.resolve(__dirname, '..')
  for (const childName of ['dinoEmbeddingChild.ts', 'clipEmbeddingChild.ts']) {
    const source = fs.readFileSync(path.join(projectRoot, 'electron', childName), 'utf8')
    assert.match(source, /from '.\/transformersCacheDirectory'/, childName)
    assert.match(
      source,
      /configureLocalTransformersEnvironment\(transformers\.env, (?:modelPath|task\.modelPath)\)/,
      childName,
    )
    assert.doesNotMatch(source, /transformers\.env\.cacheDir\s*=/, childName)
  }
})
