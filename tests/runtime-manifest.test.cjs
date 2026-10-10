const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  isSafeRelativePath,
  validateRuntimeManifest,
} = require('../scripts/validate-runtime-manifest.cjs')

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'resources', 'runtime-manifest.json'), 'utf8'),
)

test('runtime manifest has complete unique component and artifact metadata', () => {
  const result = validateRuntimeManifest(manifest)
  assert.deepEqual(result.errors, [])
  assert.equal(result.componentCount, 21)
  assert.equal(result.artifactCount, 60)
})

test('runtime manifest covers packaged resources and supported user-model candidates', () => {
  const targets = new Set(
    manifest.components.flatMap((component) =>
      component.artifacts.map((artifact) => artifact.targetPath),
    ),
  )
  for (const required of [
    'models/yolov8n/model.onnx',
    'models/yolov8n-face/model.onnx',
    'models/adaface/model.onnx',
    'models/osnet/model.onnx',
    'models/mobilesam/encoder.onnx',
    'models/mobilesam/decoder.onnx',
    'ai-models/dinov2_vitb14/Xenova/dinov2-base/onnx/model_q4.onnx',
    'ai-models/clip_vit_base_patch32/Xenova/clip-vit-base-patch32/onnx/model_q4.onnx',
    'ai-models/clip_vit_base_patch32/Xenova/clip-vit-base-patch32/onnx/text_model_q4.onnx',
    'ai-models/clip_vit_b32_multilingual_v1_text/sentence-transformers/clip-ViT-B-32-multilingual-v1/onnx/model_quint8_avx2.onnx',
    'tools/ffmpeg/bin/ffmpeg.exe',
    'tools/ffmpeg/bin/ffprobe.exe',
    'native/build-electron/Release/fast_scanner.node',
    'cuda-runtime/floating_clock_cuda_embedding_worker.exe',
    'cuda-runtime/provider-gates.json',
    'cuda-runtime/onnxruntime_providers_cuda.dll',
    'cuda-runtime/cudart64_12.dll',
    'cuda-runtime/cudnn64_9.dll',
    'resources/runtime-receipts/ollama-0.32.9-windows-x64.json',
    'resources/runtime-receipts/qwen3-vl-2b-q4-k-m-ollama.json',
    'resources/runtime-receipts/llama-cpp-b10441-windows-x64.json',
    'resources/runtime-receipts/qwen3-vl-2b-instruct-gguf-official.json',
    'resources/runtime-receipts/sensevoice-small-funasr.json',
    'resources/runtime-receipts/fsmn-vad-campplus-funasr.json',
    'src/assets/fonts/SourceHanSansCN-VF.otf.woff2',
  ]) {
    assert.ok(targets.has(required), `missing ${required}`)
  }
})

test('bundled Source Han Sans UI font is versioned, hash pinned, and OFL licensed', () => {
  const component = manifest.components.find(
    (candidate) => candidate.id === 'adobe-source-han-sans-cn-vf-2-005',
  )
  assert.ok(component)
  assert.equal(component.componentType, 'font')
  assert.equal(component.upstream.version, '2.005R')
  assert.equal(component.license.spdx, 'OFL-1.1')
  assert.deepEqual(component.license.licenseFiles, ['legal/SourceHanSans-OFL-1.1.txt'])
  assert.equal(component.distribution.defaultBundled, true)
  assert.equal(component.artifacts[0].sizeBytes, 7_995_716)
  assert.equal(
    component.artifacts[0].sha256,
    '7087698d52240614659957608d8c4ad446759aee3208409dc9f566412e7af8f4',
  )
  assert.equal(new URL(component.artifacts[0].sourceUrl).protocol, 'https:')
})

test('downloadable model manifest agrees with the distribution inventory', () => {
  const modelManifest = JSON.parse(
    fs.readFileSync(path.join(root, 'models', 'manifest.json'), 'utf8'),
  )
  const byTarget = new Map(
    manifest.components.flatMap((component) =>
      component.artifacts.map((artifact) => [artifact.targetPath, { component, artifact }]),
    ),
  )
  for (const model of modelManifest.models) {
    const requiredFiles = [
      {
        filename: model.filename,
        sha256: model.sha256,
        sizeBytes: model.sizeBytes,
        url: model.url,
      },
      ...(model.requiredFiles || []),
    ]
    for (const file of requiredFiles) {
      const target = `ai-models/${model.name}/${file.filename}`
      const entry = byTarget.get(target)
      assert.ok(entry, `distribution inventory missing ${model.name}: ${file.filename}`)
      assert.equal(entry.artifact.sha256, file.sha256)
      assert.equal(entry.artifact.sizeBytes, file.sizeBytes)
      assert.equal(new URL(entry.artifact.sourceUrl).hostname, new URL(file.url).hostname)
      assert.equal(entry.component.license.spdx, model.license)
    }
  }
})

test('CLIP downloadable model requires its text projection tower', () => {
  const modelManifest = JSON.parse(
    fs.readFileSync(path.join(root, 'models', 'manifest.json'), 'utf8'),
  )
  const clip = modelManifest.models.find((model) => model.name === 'clip_vit_base_patch32')
  assert.ok(clip)
  assert.ok(
    clip.requiredFiles.some(
      (file) => file.filename === 'Xenova/clip-vit-base-patch32/onnx/text_model_q4.onnx',
    ),
  )
})

test('every Transformers model declares its complete hash-pinned runtime file set', () => {
  const modelManifest = JSON.parse(
    fs.readFileSync(path.join(root, 'models', 'manifest.json'), 'utf8'),
  )
  const expectedCompanions = {
    dinov2_vitb14: [
      'Xenova/dinov2-base/config.json',
      'Xenova/dinov2-base/preprocessor_config.json',
    ],
    clip_vit_base_patch32: [
      'Xenova/clip-vit-base-patch32/onnx/text_model_q4.onnx',
      'Xenova/clip-vit-base-patch32/config.json',
      'Xenova/clip-vit-base-patch32/preprocessor_config.json',
      'Xenova/clip-vit-base-patch32/tokenizer.json',
      'Xenova/clip-vit-base-patch32/tokenizer_config.json',
      'Xenova/clip-vit-base-patch32/special_tokens_map.json',
      'Xenova/clip-vit-base-patch32/vocab.json',
      'Xenova/clip-vit-base-patch32/merges.txt',
    ],
    clip_vit_b32_multilingual_v1_text: [
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/2_Dense/model.safetensors',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/config.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/config_sentence_transformers.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/modules.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/sentence_bert_config.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/special_tokens_map.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/tokenizer.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/tokenizer_config.json',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/vocab.txt',
      'sentence-transformers/clip-ViT-B-32-multilingual-v1/2_Dense/config.json',
    ],
  }
  for (const [name, expected] of Object.entries(expectedCompanions)) {
    const model = modelManifest.models.find((candidate) => candidate.name === name)
    assert.ok(model, `missing ${name}`)
    assert.deepEqual(
      model.requiredFiles.map((file) => file.filename),
      expected,
      `${name} companion inventory drifted`,
    )
    for (const file of model.requiredFiles) {
      assert.match(file.sha256, /^[a-f\d]{64}$/)
      assert.ok(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0)
      assert.equal(new URL(file.url).protocol, 'https:')
      assert.match(file.url, new RegExp(`/resolve/${model.version}/`))
    }
  }
})

test('manifest path guard rejects absolute paths and traversal', () => {
  assert.equal(isSafeRelativePath('models/a/model.onnx'), true)
  assert.equal(isSafeRelativePath('../model.onnx'), false)
  assert.equal(isSafeRelativePath('C:\\model.onnx'), false)
})

test('validator rejects unsafe or unpinned archive extraction metadata', () => {
  const copy = structuredClone(manifest)
  copy.components[0].artifacts[0].archive = {
    format: 'zip',
    entryPath: '../escape.dll',
    sha256: 'invalid',
    sizeBytes: 0,
  }
  const result = validateRuntimeManifest(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('archive entryPath')))
  assert.ok(result.errors.some((error) => error.includes('archive sha256')))
  assert.ok(result.errors.some((error) => error.includes('archive sizeBytes')))
})

test('validator rejects duplicate targets and incomplete provenance', () => {
  const copy = structuredClone(manifest)
  copy.components[1].artifacts[0].targetPath = copy.components[0].artifacts[0].targetPath
  copy.components[0].upstream.version = ''
  const result = validateRuntimeManifest(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('duplicate targetPath')))
  assert.ok(result.errors.some((error) => error.includes('exact version')))
})
