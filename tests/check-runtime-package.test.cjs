const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const asar = require('@electron/asar')
const {
  inspectRuntimePackage,
  parseRuntimePackageArgs,
} = require('../scripts/check-runtime-package.cjs')
const manifest = require('../scripts/runtime-package-pruning.manifest.json')
const projectRoot = path.resolve(__dirname, '..')
const cli = path.join(projectRoot, 'scripts/check-runtime-package.cjs')

function temporaryRoot(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'siftory-runtime-package-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), parent)
    assert.ok(path.basename(resolved).startsWith('siftory-runtime-package-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return root
}

function inputFixture(root) {
  const input = path.join(root, 'input')
  const files = [
    ...Object.keys(manifest.packages).map((name) => `node_modules/${name}/package.json`),
    ...manifest.distFiles.filter((file) => !file.exclude).map((file) => file.path),
  ]
  for (const relative of files) {
    const target = path.join(input, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(projectRoot, relative), target)
  }
  return input
}

test('CLI defaults follow the project output and explicit resources override them', (t) => {
  const root = temporaryRoot(t)
  fs.writeFileSync(path.join(root, 'package.json'), '{"build":{"directories":{"output":"output"}}}')
  assert.equal(
    parseRuntimePackageArgs([], root).resourcesDir,
    path.join(root, 'output', 'win-unpacked', 'resources'),
  )
  assert.equal(parseRuntimePackageArgs(['--resources', root]).resourcesDir, root)
  assert.equal(parseRuntimePackageArgs([`--resources=${root}`]).resourcesDir, root)
  for (const args of [['--resources'], ['--unknown'], ['--resources=x', '--resources=y']]) {
    assert.throws(() => parseRuntimePackageArgs(args, root), /Usage:/)
  }
})

test('missing and corrupt ASAR fail closed and CLI emits parseable JSON with failure status', (t) => {
  const root = temporaryRoot(t)
  assert.equal(inspectRuntimePackage(root).ok, false)
  fs.writeFileSync(path.join(root, 'app.asar'), 'corrupt archive')
  const result = spawnSync(process.execPath, [cli, '--resources', root], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.errors.length > 0)
  assert.equal(report.legalApproval, false)
})

test('real ASAR adapter verifies retained bytes and rejects restored guid plus truncated payloads', async (t) => {
  const root = temporaryRoot(t)
  const input = inputFixture(root)
  const resources = path.join(root, 'resources')
  fs.mkdirSync(resources)
  const archive = path.join(resources, 'app.asar')
  await asar.createPackage(input, archive)
  const valid = inspectRuntimePackage(resources)
  assert.equal(valid.ok, true, valid.errors.join('\n'))
  assert.equal(valid.hashMatchedFiles, 49)
  assert.match(valid.archive.sha256, /^[a-f0-9]{64}$/)

  const original = fs.readFileSync(archive)
  fs.writeFileSync(archive, original.subarray(0, original.length - 1))
  const truncated = inspectRuntimePackage(resources)
  assert.equal(truncated.ok, false)
  assert.ok(truncated.errors.some((value) => value.includes('out of bounds')))

  const restored = path.join(input, 'node_modules/guid-typescript/dist/guid.js')
  fs.mkdirSync(path.dirname(restored), { recursive: true })
  fs.writeFileSync(restored, 'module.exports = "emptyguid"')
  await asar.createPackage(input, archive)
  const bad = inspectRuntimePackage(resources)
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((value) => value.includes('Omitted runtime content remains')))
})

test('unpacked script content is inspected and missing unpacked files fail closed', async (t) => {
  const root = temporaryRoot(t)
  const input = inputFixture(root)
  fs.writeFileSync(path.join(input, 'extra.js'), 'module.exports = "emptyguid"')
  const resources = path.join(root, 'resources')
  fs.mkdirSync(resources)
  await asar.createPackageWithOptions(input, path.join(resources, 'app.asar'), {
    unpack: 'extra.js',
  })
  const bad = inspectRuntimePackage(resources)
  assert.equal(bad.ok, false)
  assert.equal(bad.unpackedFiles, 1)
  assert.ok(bad.markerMatches.some((value) => value.path === 'extra.js'))
  fs.unlinkSync(path.join(resources, 'app.asar.unpacked', 'extra.js'))
  assert.equal(inspectRuntimePackage(resources).ok, false)
})
