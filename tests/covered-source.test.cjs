const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  inspectCoveredSourcePayload,
  inspectCoveredSourceDistribution,
} = require('../scripts/check-covered-source.cjs')

const projectRoot = path.resolve(__dirname, '..')
const payload = path.join(projectRoot, 'legal', 'covered-source')
const readManifest = () => JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'))

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'siftory-covered-source-'))
  const copy = path.join(root, 'legal', 'covered-source')
  fs.cpSync(payload, copy, { recursive: true })
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent)
    assert.ok(path.basename(root).startsWith('siftory-covered-source-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, copy }
}

test('identified sources and notice are present without a full native-source approval claim', (t) => {
  const result = inspectCoveredSourcePayload()
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.ok(result.verifiedFiles.includes('canvas-rust-sources.zip'))
  assert.ok(result.verifiedFiles.includes('README.md'))
  assert.equal(result.approvalGranted, false)
  assert.equal(result.completeNativeInventory, false)
  const { root } = fixture(t)
  const binding = readManifest().bindings[0]
  const target = path.join(root, 'app.asar.unpacked', binding.binaryPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(projectRoot, binding.binaryPath), target)
  const binary = inspectCoveredSourceDistribution(root)
  assert.equal(binary.ok, true, binary.errors.join('\n'))
  assert.equal(binary.binaryBindings.length, 1)
})

test('missing archive and same-size altered access notice fail closed', (t) => {
  const { copy } = fixture(t)
  fs.unlinkSync(path.join(copy, 'canvas-rust-sources.zip'))
  let result = inspectCoveredSourcePayload(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('missing or unsafe')))
  fs.copyFileSync(
    path.join(payload, 'canvas-rust-sources.zip'),
    path.join(copy, 'canvas-rust-sources.zip'),
  )
  const note = fs.readFileSync(path.join(copy, 'README.md'))
  note[0] ^= 1
  fs.writeFileSync(path.join(copy, 'README.md'), note)
  result = inspectCoveredSourcePayload(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('reviewed bytes: README.md')))
})

test('self-consistent replacement of source archive and packaged manifest cannot pass', (t) => {
  const { copy } = fixture(t)
  const data = Buffer.from('replacement archive')
  fs.writeFileSync(path.join(copy, 'canvas-rust-sources.zip'), data)
  const manifest = readManifest()
  const entry = manifest.files.find((file) => file.path === 'canvas-rust-sources.zip')
  entry.bytes = data.length
  entry.sha256 = crypto.createHash('sha256').update(data).digest('hex')
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest))
  const result = inspectCoveredSourcePayload(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('reviewed bytes: manifest.json')))
  assert.ok(
    result.errors.some((error) => error.includes('reviewed bytes: canvas-rust-sources.zip')),
  )
})

test('extra files and directory links are rejected without following their targets', (t) => {
  const { root, copy } = fixture(t)
  fs.writeFileSync(path.join(copy, 'undeclared.txt'), 'extra')
  assert.equal(inspectCoveredSourcePayload(copy).ok, false)
  fs.unlinkSync(path.join(copy, 'undeclared.txt'))
  const external = path.join(root, 'external')
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, 'keep.txt'), 'retained')
  fs.symlinkSync(external, path.join(copy, 'linked'), 'junction')
  const result = inspectCoveredSourcePayload(copy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unsafe source payload entry: linked')))
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'retained')
  const link = path.join(root, 'payload-link')
  fs.symlinkSync(copy, link, 'junction')
  assert.equal(inspectCoveredSourcePayload(link).ok, false)
})

test('actual packaged binding rejects stale native binary and unpacked directory redirection', (t) => {
  const { root } = fixture(t)
  const binding = readManifest().bindings[0]
  const target = path.join(root, 'app.asar.unpacked', binding.binaryPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(projectRoot, binding.binaryPath), target)
  let result = inspectCoveredSourceDistribution(root)
  assert.equal(result.ok, true, result.errors.join('\n'))
  fs.writeFileSync(target, 'different native version')
  result = inspectCoveredSourceDistribution(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('binary binding changed')))
  const unpacked = path.join(root, 'app.asar.unpacked')
  const isolated = path.join(root, 'isolated')
  assert.equal(path.dirname(fs.realpathSync(unpacked)), fs.realpathSync(root))
  assert.equal(path.dirname(path.resolve(isolated)), fs.realpathSync(root))
  fs.renameSync(unpacked, isolated)
  fs.symlinkSync(isolated, unpacked, 'junction')
  result = inspectCoveredSourceDistribution(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('Binary root must not be a link')))
})

test('a linked legal parent cannot source the package payload from another directory', (t) => {
  const { root } = fixture(t)
  const legal = path.join(root, 'legal')
  const redirected = path.join(root, 'redirected-legal')
  assert.equal(path.dirname(fs.realpathSync(legal)), fs.realpathSync(root))
  assert.equal(path.dirname(path.resolve(redirected)), fs.realpathSync(root))
  fs.renameSync(legal, redirected)
  fs.symlinkSync(redirected, legal, 'junction')
  const report = inspectCoveredSourcePayload(path.join(legal, 'covered-source'), root)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('parent must not be a link')))
  assert.equal(report.verifiedFiles.length, 0)
  assert.equal(inspectCoveredSourceDistribution(root).ok, false)
})
