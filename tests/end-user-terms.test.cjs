const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { loadEndUserTerms, hasAcceptedEndUserTerms, acceptEndUserTerms } = loadTsModule(
  'electron/endUserTerms.ts',
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'siftory-terms-unit-'))
  const resources = path.join(directory, 'resources')
  const legal = path.join(resources, 'legal', 'end-user-terms')
  const userData = path.join(directory, 'user-data')
  const manifestFile = path.join(legal, 'manifest.json')
  const receiptFile = path.join(userData, 'end-user-terms-acceptance.json')
  fs.mkdirSync(legal, { recursive: true })
  fs.mkdirSync(userData)
  t.after(() => {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.equal(resolved, directory)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const manifest = {
    schemaVersion: 1,
    status: 'final',
    title: 'Siftory Test Terms',
    version: 'test-1',
    publisher: 'Unit Test Publisher',
    effectiveDate: '2026-09-25',
    documents: [],
  }
  const writeManifest = (value = manifest) =>
    fs.writeFileSync(manifestFile, JSON.stringify(value), 'utf8')
  const document = (name, content) => {
    const bytes = Buffer.from(content)
    fs.writeFileSync(path.join(legal, name), bytes)
    const entry = { path: name, sha256: digest(bytes) }
    const index = manifest.documents.findIndex((item) => item.path === name)
    if (index === -1) manifest.documents.push(entry)
    else manifest.documents[index] = entry
    writeManifest()
  }
  document('terms.txt', 'First document.\nIndependent test data only.')
  const load = () => loadEndUserTerms(resources)
  const identity = (terms) => ({ version: terms.version, sha256: terms.sha256 })
  const accept = (displayed = load().terms, supplied = identity(displayed)) =>
    acceptEndUserTerms(resources, userData, displayed, supplied)
  return {
    directory,
    resources,
    legal,
    userData,
    manifest,
    manifestFile,
    receiptFile,
    writeManifest,
    document,
    load,
    accept,
  }
}

test('review remains review and does not require or manufacture final document data', (t) => {
  const f = fixture(t)
  f.writeManifest({ schemaVersion: 1, status: 'review' })
  assert.deepEqual(f.load(), { status: 'review' })
  assert.equal(fs.existsSync(f.receiptFile), false)
})

test('final terms combine hash-verified UTF-8 documents in manifest order and bind all display metadata', (t) => {
  const f = fixture(t)
  f.document('downstream.md', '第三方条款\nLiteral <text> and Markdown remain text.')
  const result = f.load()
  assert.equal(result.status, 'final')
  const expected = {
    title: f.manifest.title,
    version: f.manifest.version,
    publisher: f.manifest.publisher,
    effectiveDate: f.manifest.effectiveDate,
    text: 'First document.\nIndependent test data only.\n\n第三方条款\nLiteral <text> and Markdown remain text.',
  }
  assert.deepEqual(result.terms, { ...expected, sha256: digest(JSON.stringify(expected)) })
  f.manifest.documents.reverse()
  f.writeManifest()
  assert.notEqual(f.load().terms.sha256, result.terms.sha256)
})

test('changing document bytes without updating its manifest hash is rejected', (t) => {
  const f = fixture(t)
  fs.appendFileSync(path.join(f.legal, 'terms.txt'), '\nTampered')
  assert.throws(f.load)
})

const invalidManifests = [
  ['null manifest', () => null],
  ['array manifest', () => []],
  ['unsupported schema', (m) => ({ ...m, schemaVersion: 2 })],
  ['missing schema', (m) => ({ ...m, schemaVersion: undefined })],
  ['invalid status', (m) => ({ ...m, status: 'published' })],
  ['empty title', (m) => ({ ...m, title: '' })],
  ['non-string version', (m) => ({ ...m, version: 1 })],
  ['untrimmed publisher', (m) => ({ ...m, publisher: ' Name' })],
  ['publisher placeholder', (m) => ({ ...m, publisher: '{{RIGHTSHOLDER}}' })],
  ['control character metadata', (m) => ({ ...m, title: 'Terms\u0000' })],
  ['oversized title', (m) => ({ ...m, title: 't'.repeat(201) })],
  ['invalid calendar date', (m) => ({ ...m, effectiveDate: '2026-02-30' })],
  ['invalid date format', (m) => ({ ...m, effectiveDate: '2026-9-25' })],
  ['missing documents', (m) => ({ ...m, documents: undefined })],
  ['empty documents', (m) => ({ ...m, documents: [] })],
  ['too many documents', (m) => ({ ...m, documents: Array(11).fill(m.documents[0]) })],
  ['non-object document', (m) => ({ ...m, documents: ['terms.txt'] })],
  ['uppercase hash', (m) => ({ ...m, documents: [{ ...m.documents[0], sha256: 'A'.repeat(64) }] })],
  ['invalid hash length', (m) => ({ ...m, documents: [{ ...m.documents[0], sha256: 'a' }] })],
  ['incorrect hash', (m) => ({ ...m, documents: [{ ...m.documents[0], sha256: '0'.repeat(64) }] })],
  [
    'case-insensitive duplicate documents',
    (m) => ({
      ...m,
      documents: [m.documents[0], { ...m.documents[0], path: 'TERMS.txt' }],
    }),
  ],
]

for (const [label, change] of invalidManifests) {
  test(`rejects ${label}`, (t) => {
    const f = fixture(t)
    f.writeManifest(change(f.manifest))
    assert.throws(f.load)
  })
}

for (const filename of [
  '../terms.txt',
  '..\\terms.txt',
  'nested/terms.txt',
  'nested\\terms.txt',
  '/terms.txt',
  'C:\\terms.txt',
  'terms.txt:stream.txt',
  'terms..txt',
  'terms.html',
  'terms.txt\u0000',
]) {
  test(`rejects document path ${JSON.stringify(filename)}`, (t) => {
    const f = fixture(t)
    f.manifest.documents[0].path = filename
    f.writeManifest()
    assert.throws(f.load)
  })
}

for (const [label, content] of [
  ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
  ['empty text', ''],
  ['whitespace-only text', ' \r\n\t'],
  ['NUL text', 'Valid\u0000invalid'],
  ['placeholder', 'Publisher: {{LEGAL_NAME}}'],
  ['draft marker', 'DRAFT — NOT FOR DISTRIBUTION\nTest content.'],
  ['case-insensitive draft marker', 'draft - not for distribution'],
  ['oversized text', 'x'.repeat(512 * 1024 + 1)],
]) {
  test(`rejects ${label} even with a matching document hash`, (t) => {
    const f = fixture(t)
    f.document('terms.txt', content)
    assert.throws(f.load)
  })
}

test('rejects malformed UTF-8 in manifest metadata', (t) => {
  const f = fixture(t)
  const serialized = JSON.stringify(f.manifest)
  const index = serialized.indexOf(f.manifest.publisher)
  const bytes = Buffer.from(serialized)
  bytes[index] = 0xff
  fs.writeFileSync(f.manifestFile, bytes)
  assert.throws(f.load)
})

test('rejects oversized manifests and combined document payloads', (t) => {
  const f = fixture(t)
  f.writeManifest({ ...f.manifest, extra: 'x'.repeat(16384) })
  assert.throws(f.load)
  f.document('terms.txt', 'x'.repeat(300 * 1024))
  f.document('second.txt', 'y'.repeat(300 * 1024))
  assert.throws(f.load)
})

test('rejects missing and non-regular document files', (t) => {
  const f = fixture(t)
  fs.unlinkSync(path.join(f.legal, 'terms.txt'))
  assert.throws(f.load)
  fs.mkdirSync(path.join(f.legal, 'terms.txt'))
  assert.throws(f.load)
})

function symlinkOrSkip(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type)
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Host does not allow this symlink fixture: ${error.code}`)
      return false
    }
    throw error
  }
}

test('rejects document file symlinks', (t) => {
  const f = fixture(t)
  const target = path.join(f.directory, 'outside.txt')
  const doc = path.join(f.legal, 'terms.txt')
  fs.renameSync(doc, target)
  if (!symlinkOrSkip(t, target, doc, 'file')) return
  assert.throws(f.load)
})

test('rejects a redirected terms directory', (t) => {
  const f = fixture(t)
  const moved = path.join(f.directory, 'outside-terms')
  fs.renameSync(f.legal, moved)
  if (!symlinkOrSkip(t, moved, f.legal, process.platform === 'win32' ? 'junction' : 'dir')) return
  assert.throws(f.load)
})

test('acceptance saves a minimal receipt and recognizes only the current document', (t) => {
  const f = fixture(t)
  const terms = f.load().terms
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
  assert.deepEqual(f.accept(terms), { ok: true })
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), true)
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'))
  assert.deepEqual(Object.keys(receipt).sort(), [
    'acceptedAt',
    'publisher',
    'schemaVersion',
    'sha256',
    'version',
  ])
  assert.equal(receipt.publisher, terms.publisher)
  assert.equal(receipt.sha256, terms.sha256)
  assert.equal(receipt.version, terms.version)
  assert.equal(new Date(receipt.acceptedAt).toISOString(), receipt.acceptedAt)
  assert.deepEqual(fs.readdirSync(f.userData), ['end-user-terms-acceptance.json'])
})

for (const field of ['title', 'version', 'publisher', 'effectiveDate', 'text']) {
  test(`a ${field} change requires a fresh decision and rejects a stale open window`, (t) => {
    const f = fixture(t)
    const displayed = f.load().terms
    assert.deepEqual(f.accept(displayed), { ok: true })
    if (field === 'text') f.document('terms.txt', 'Revised terms text.')
    else {
      f.manifest[field] = field === 'effectiveDate' ? '2026-09-26' : `${f.manifest[field]} revised`
      f.writeManifest()
    }
    const current = f.load().terms
    assert.notEqual(current.sha256, displayed.sha256)
    assert.equal(hasAcceptedEndUserTerms(f.userData, current), false)
    assert.deepEqual(f.accept(displayed), { ok: false, reason: 'stale-terms' })
    assert.deepEqual(f.accept(current), { ok: true })
    assert.equal(hasAcceptedEndUserTerms(f.userData, current), true)
  })
}

test('invalid or mismatched renderer identities cannot create a receipt', (t) => {
  const f = fixture(t)
  const displayed = f.load().terms
  for (const supplied of [
    undefined,
    null,
    'yes',
    [],
    {},
    { version: displayed.version },
    { version: 'stale', sha256: displayed.sha256 },
    { version: displayed.version, sha256: '0'.repeat(64) },
  ]) {
    assert.deepEqual(acceptEndUserTerms(f.resources, f.userData, displayed, supplied), {
      ok: false,
      reason: 'invalid-request',
    })
  }
  assert.equal(fs.existsSync(f.receiptFile), false)
})

test('changing to review or damaging resources while the dialog is open is stale', (t) => {
  const f = fixture(t)
  const displayed = f.load().terms
  f.writeManifest({ schemaVersion: 1, status: 'review' })
  assert.deepEqual(f.accept(displayed), { ok: false, reason: 'stale-terms' })
  fs.writeFileSync(f.manifestFile, '{broken')
  assert.deepEqual(f.accept(displayed), { ok: false, reason: 'stale-terms' })
  assert.equal(fs.existsSync(f.receiptFile), false)
})

test('corrupt, mismatched, oversized and non-regular receipts are ignored', (t) => {
  const f = fixture(t)
  const terms = f.load().terms
  assert.deepEqual(f.accept(terms), { ok: true })
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'))
  for (const bad of [
    null,
    [],
    {},
    { ...receipt, schemaVersion: 2 },
    { ...receipt, version: 'different' },
    { ...receipt, sha256: '0'.repeat(64) },
    { ...receipt, publisher: 'different' },
    { ...receipt, acceptedAt: 'invalid' },
    { ...receipt, acceptedAt: 0 },
    { ...receipt, extra: 'x'.repeat(4096) },
  ]) {
    fs.writeFileSync(f.receiptFile, JSON.stringify(bad), 'utf8')
    assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
  }
  fs.writeFileSync(f.receiptFile, '{broken')
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
  fs.unlinkSync(f.receiptFile)
  fs.mkdirSync(f.receiptFile)
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
  assert.deepEqual(f.accept(terms), { ok: false, reason: 'save-failed' })
})

test('malformed UTF-8 receipts are ignored even when required fields remain intact', (t) => {
  const f = fixture(t)
  const terms = f.load().terms
  assert.deepEqual(f.accept(terms), { ok: true })
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'))
  const bytes = Buffer.from(JSON.stringify({ ...receipt, extra: 'marker' }))
  bytes[bytes.indexOf('marker')] = 0xff
  fs.writeFileSync(f.receiptFile, bytes)
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
})

test('symlink receipts are ignored and cannot overwrite their targets', (t) => {
  const f = fixture(t)
  const terms = f.load().terms
  const target = path.join(f.directory, 'outside-receipt.json')
  assert.deepEqual(f.accept(terms), { ok: true })
  fs.renameSync(f.receiptFile, target)
  const before = fs.readFileSync(target)
  if (!symlinkOrSkip(t, target, f.receiptFile, 'file')) return
  assert.equal(hasAcceptedEndUserTerms(f.userData, terms), false)
  assert.deepEqual(f.accept(terms), { ok: false, reason: 'save-failed' })
  assert.deepEqual(fs.readFileSync(target), before)
})

for (const method of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`${method} failure cannot record acceptance or leave a temporary receipt`, (t) => {
    const f = fixture(t)
    const displayed = f.load().terms
    const original = fs[method]
    t.mock.method(fs, method, (...args) => {
      if (method === 'openSync' && args[1] !== 'wx') return original(...args)
      throw Object.assign(new Error('Injected receipt save failure'), { code: 'EIO' })
    })
    assert.deepEqual(f.accept(displayed), { ok: false, reason: 'save-failed' })
    assert.equal(hasAcceptedEndUserTerms(f.userData, displayed), false)
    assert.deepEqual(fs.readdirSync(f.userData), [])
  })
}

test('a failed receipt replacement preserves the previous accepted document', (t) => {
  const f = fixture(t)
  const previous = f.load().terms
  assert.deepEqual(f.accept(previous), { ok: true })
  const receiptBefore = fs.readFileSync(f.receiptFile)
  f.document('terms.txt', 'Updated test content.')
  const current = f.load().terms
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('Injected replacement failure'), { code: 'EIO' })
  })
  assert.deepEqual(f.accept(current), { ok: false, reason: 'save-failed' })
  assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore)
  assert.equal(hasAcceptedEndUserTerms(f.userData, current), false)
  assert.equal(hasAcceptedEndUserTerms(f.userData, previous), true)
  assert.deepEqual(fs.readdirSync(f.userData), ['end-user-terms-acceptance.json'])
})
