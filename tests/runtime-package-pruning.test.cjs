const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  inspectPrunedRuntimeFiles,
  isOmittedRuntimePath,
  runtimePackageExclusions,
  verifyRuntimePruningInputs,
} = require('../scripts/runtime-package-pruning.cjs')
const manifest = require('../scripts/runtime-package-pruning.manifest.json')

const root = path.resolve(__dirname, '..')
function reviewedFiles() {
  const result = new Map()
  for (const name of Object.keys(manifest.packages)) {
    const relative = `node_modules/${name}/package.json`
    result.set(relative, fs.readFileSync(path.join(root, relative)))
  }
  for (const file of manifest.distFiles.filter((value) => !value.exclude)) {
    result.set(file.path, fs.readFileSync(path.join(root, file.path)))
  }
  return result
}
function inspect(files) {
  return inspectPrunedRuntimeFiles([...files.keys()], (entry) => {
    const value = files.get(entry)
    if (!value) throw new Error('Fixture file is missing')
    return value
  })
}

test('reviewed runtime inputs and all retained Node/browser bundles match fixed upstream bytes', () => {
  assert.deepEqual(verifyRuntimePruningInputs(root).errors, [])
  const result = inspect(reviewedFiles())
  assert.equal(result.ok, true)
  assert.equal(result.hashMatchedFiles, 49)
  assert.equal(result.legalApproval, false)
})

test('distribution omissions include embedded copies but preserve used backends and notices', () => {
  assert.equal(isOmittedRuntimePath('node_modules/guid-typescript/dist/guid.js'), true)
  assert.equal(isOmittedRuntimePath('node_modules/onnxruntime-web/lib/onnxjs/tensor.js'), true)
  assert.equal(isOmittedRuntimePath('node_modules/onnxruntime-web/dist/ort.all.min.mjs.map'), true)
  assert.equal(isOmittedRuntimePath('node_modules/onnxruntime-web/dist/ort.webgl.min.js'), true)
  for (const file of [
    'node_modules/onnxruntime-web/dist/ort.webgl.LICENSE',
    'node_modules/onnxruntime-web/dist/ort.all.NOTICE',
    'node_modules/onnxruntime-web/dist/ort.node.min.mjs',
    'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
    'node_modules/onnxruntime-web/dist/ort.wasm.min.js',
    'node_modules/onnxruntime-web/dist/ort.jspi.min.js',
    'node_modules/@huggingface/transformers/dist/transformers.web.js',
    'node_modules/onnxruntime-web/lib/backend-webgl.js',
  ]) {
    assert.equal(isOmittedRuntimePath(file), false, file)
  }
  const filters = runtimePackageExclusions()
  assert.equal(filters.length, 16)
  assert.ok(filters.every((value) => !value.includes('dist/ort.all*')))
})

test('package verification rejects restored guid and copied embedded code', () => {
  const files = reviewedFiles()
  files.set('node_modules/guid-typescript/package.json', Buffer.from('{}'))
  files.set('dist-electron/unexpected.js', Buffer.from('const copied = "emptyguid"'))
  const result = inspect(files)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((value) => value.includes('Omitted runtime content remains')))
  assert.deepEqual(result.markerMatches, [
    { path: 'dist-electron/unexpected.js', markers: ['emptyguid'] },
  ])
})

test('package verification rejects modified or missing required artifacts and unreviewed versions', () => {
  const files = reviewedFiles()
  const first = manifest.distFiles.find((value) => !value.exclude && value.requiredInPackage)
  files.set(first.path, Buffer.from('changed runtime'))
  const second = manifest.distFiles.find(
    (value) => !value.exclude && value.requiredInPackage && value.path !== first.path,
  )
  files.delete(second.path)
  files.set('node_modules/onnxruntime-web/package.json', Buffer.from('{"version":"99.0.0"}'))
  const result = inspect(files)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((value) => value.includes('review the new version')))
  assert.ok(result.errors.some((value) => value.includes('artifact changed')))
  assert.ok(result.errors.some((value) => value.includes('artifact is missing')))
})

test('a new application import of removed WebGL is rejected', () => {
  const files = reviewedFiles()
  files.set('dist-electron/embedding.js', Buffer.from('import("onnxruntime-web/webgl")'))
  assert.ok(inspect(files).errors.some((value) => value.includes('omitted runtime entry')))
})

test('same-version package exports cannot redirect to omitted or differently selected bundles', () => {
  for (const name of Object.keys(manifest.packages)) {
    const files = reviewedFiles()
    const relative = `node_modules/${name}/package.json`
    const metadata = JSON.parse(files.get(relative))
    if (name === 'onnxruntime-web') {
      metadata.exports['.'].node.import = './dist/ort.all.min.mjs'
    } else {
      metadata.exports.node.import.default = './dist/transformers.web.js'
    }
    files.set(relative, Buffer.from(JSON.stringify(metadata)))
    const result = inspect(files)
    assert.equal(result.ok, false)
    assert.equal(result.hashMatchedFiles, 49)
    assert.ok(
      result.errors.some((value) => value === `Runtime package metadata changed: ${relative}`),
    )
  }
})

test('unreviewed distribution entrypoints cannot silently widen the checked scope', () => {
  const files = reviewedFiles()
  files.set('node_modules/onnxruntime-web/dist/future.mjs', Buffer.from('export const version = 2'))
  assert.ok(
    inspect(files).errors.some((value) => value.includes('Unreviewed runtime distribution')),
  )
})

test('invalid reader paths fail before they can be read', () => {
  for (const entry of ['../secret.js', 'C:/secret.js', '/../../secret.js', 'file:stream.js']) {
    assert.throws(() => isOmittedRuntimePath(entry), /Invalid package entry/)
  }
  const reads = []
  const result = inspectPrunedRuntimeFiles(['../secret.js'], (entry) => {
    reads.push(entry)
    throw new Error('missing')
  })
  assert.equal(result.ok, false)
  assert.equal(reads.includes('../secret.js'), false)
})
