const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const {
  candidates,
  managedModelNames,
  parseArgs,
  resolveUserDataPath,
} = require('../scripts/install-local-user-models.cjs')
const {
  componentId: ollamaComponentId,
  loadPinnedIdentity,
  parseArgs: parseOllamaArgs,
} = require('../scripts/install-video-semantic-ollama-model.cjs')

test('local model installer requires explicit responsibility acknowledgement', () => {
  assert.throws(() => parseArgs([]), /accept-local-user-models/)
  assert.equal(parseArgs(['--accept-local-user-models']).accept, true)
  assert.equal(parseArgs(['--verify-only']).verifyOnly, true)
  assert.throws(
    () => parseArgs(['--verify-only', '--replace-existing']),
    /cannot be combined/,
  )
})

test('local model installer refuses filesystem roots', () => {
  assert.throws(() => resolveUserDataPath(path.parse(process.cwd()).root), /filesystem root/)
  assert.throws(() => resolveUserDataPath('relative-user-data'), /absolute path/)
})

test('six repair candidates remain manifest-pinned and excluded from release bundles', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  assert.equal(candidates.length, 6)
  assert.equal(new Set(candidates.map((candidate) => candidate.slotId)).size, 6)
  for (const candidate of candidates) {
    const component = manifest.components.find((item) => item.id === candidate.componentId)
    assert.ok(component, candidate.componentId)
    assert.equal(component.distribution.defaultBundled, false, candidate.componentId)
    const artifact = component.artifacts.find(
      (item) => item.targetPath === candidate.targetPath,
    )
    assert.match(artifact?.sha256 || '', /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(artifact?.sizeBytes) && artifact.sizeBytes > 1024)
  }
})

test('repair verification also covers the three managed image-search models', () => {
  assert.deepEqual(managedModelNames, [
    'dinov2_vitb14',
    'clip_vit_base_patch32',
    'clip_vit_b32_multilingual_v1_text',
  ])
})

test('Ollama installer is explicit and pinned to the external-model receipt', () => {
  assert.throws(() => parseOllamaArgs([]), /accept-external-model/)
  assert.equal(parseOllamaArgs(['--verify-only']).verifyOnly, true)
  assert.equal(ollamaComponentId, 'qwen3-vl-2b-q4-k-m-ollama-external-test-model')
  assert.deepEqual(loadPinnedIdentity(), {
    tag: 'qwen3-vl:2b',
    digest: '0635d9d857d497aeadba3d7d27485746c50554446f9f6ec01ef39788221adbe8',
    quantization: 'Q4_K_M',
  })
})

test('package aliases do not pre-accept either model responsibility gate', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.doesNotMatch(packageJson.scripts['models:local:install'], /--accept-/)
  assert.doesNotMatch(packageJson.scripts['models:video:install'], /--accept-/)
})
