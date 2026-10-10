const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  isWithin,
  parseArgs,
  pathBelongsToSource,
  redactReportPaths,
  runAudit,
  sanitizePreview,
  validateOptions,
} = require('../scripts/audit-source-derived-data.cjs')

test('source audit arguments require an explicit source and reject mutation-like flags', () => {
  assert.throws(() => parseArgs([]), /--source/)
  assert.throws(() => parseArgs(['--source=C:\\Pictures', '--execute']), /Unknown/)
  assert.throws(() => parseArgs(['--source=C:\\Pictures', '--history=delete-all']), /--history/)
  const parsed = parseArgs([
    '--source=C:\\Pictures',
    '--user-data=C:\\AppData\\floating-clock-electron',
    '--plan',
    '--json',
  ])
  assert.equal(parsed.plan, true)
  assert.equal(parsed.json, true)
  assert.equal(parsed.historyPolicy, 'preserve-audit')
  assert.equal(parsed.mediaRoot, path.join(parsed.userDataPath, 'media-search'))
})

test('path redaction is recursive, longest-first, and case insensitive', () => {
  const redacted = redactReportPaths(
    {
      path: 'C:\\Users\\Alice\\AppData\\index.json',
      nested: ['c:\\users\\alice\\Pictures\\a.jpg'],
    },
    [
      ['C:\\Users\\Alice', '<USER>'],
      ['C:\\Users\\Alice\\AppData', '<APP_DATA>'],
    ],
  )
  assert.equal(redacted.path, '<APP_DATA>\\index.json')
  assert.equal(redacted.nested[0], '<USER>\\Pictures\\a.jpg')
})

test('source boundary checks are separator aware', () => {
  const source = path.resolve('D:/images')
  assert.equal(isWithin(source, path.join(source, 'nested', 'a.jpg')), true)
  assert.equal(pathBelongsToSource(source, path.join(source, 'b.jpg')), true)
  assert.equal(pathBelongsToSource(source, `${source}-other/a.jpg`), false)
  assert.equal(pathBelongsToSource(source, ''), false)
})

test('audit plans are read-only and do not call native or preview dependencies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-plan-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  let called = false
  const report = await runAudit(
    {
      sourcePath: source,
      userDataPath: path.join(root, 'user-data'),
      mediaRoot: path.join(root, 'media'),
      outputPath: '',
      historyPolicy: 'preserve-audit',
      plan: true,
      json: true,
    },
    {
      nativeInspector: () => {
        called = true
      },
      previewer: () => {
        called = true
      },
    },
  )
  assert.equal(called, false)
  assert.equal(report.readOnly, true)
  assert.equal(report.kind, 'source-derived-data-audit-plan')
  assert.ok(report.operations.every((operation) => !operation.includes('delete')))
})

test('source audit writes a token-free report outside the source and preserves source bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-run-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const original = path.join(source, 'original.jpg')
  const outputPath = path.join(root, 'reports', 'audit.json')
  fs.mkdirSync(source)
  fs.writeFileSync(original, 'original-bytes')

  const report = await runAudit(
    {
      sourcePath: source,
      userDataPath: path.join(root, 'user-data'),
      mediaRoot: path.join(root, 'media-search'),
      outputPath,
      historyPolicy: 'preserve-audit',
      plan: false,
      json: false,
    },
    {
      nativeInspector: async () => ({
        status: 'ready',
        indexRoot: path.join(root, 'user-data', 'image-search-index'),
        version: 'fixture',
        stats: { count: 4, totalBytes: 1024, replacedCount: 0, deletedCount: 0 },
        thumbnailSources: [{ path: original, mtimeMs: 10 }],
      }),
      previewer: async (input) => ({
        ok: true,
        token: 'must-not-be-persisted',
        sourcePath: input.sourcePath,
        categories: [
          {
            id: 'image-native-index',
            recordCount: input.nativeStats.count,
            fileCount: 0,
            estimatedBytes: input.nativeStats.totalBytes,
            exactBytes: true,
          },
        ],
        imageRecords: 4,
        videoRecords: 2,
        totalRecords: 6,
        fileCount: 1,
        estimatedBytes: 2048,
        originalFilesAffected: 0,
        warnings: [],
      }),
    },
  )

  assert.equal(report.status, 'passed')
  assert.equal(report.invariants.sourceRootUnchanged, true)
  assert.equal(report.invariants.sourceTreeMetadataUnchanged, true)
  assert.equal(report.invariants.readOnlyInvariantsPassed, true)
  assert.equal(report.invariants.confirmationTokenPersisted, false)
  assert.equal(report.invariants.deleteOperationAvailable, false)
  assert.equal(fs.readFileSync(original, 'utf8'), 'original-bytes')
  const persisted = fs.readFileSync(outputPath, 'utf8')
  assert.doesNotMatch(persisted, /must-not-be-persisted/)
  assert.equal(JSON.parse(persisted).preview.totalRecords, 6)
})

test('source audit fails closed when preview changes source metadata or reports affected originals', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-invariant-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const original = path.join(source, 'original.jpg')
  fs.mkdirSync(source)
  fs.writeFileSync(original, 'before')
  const report = await runAudit(
    {
      sourcePath: source,
      userDataPath: path.join(root, 'user-data'),
      mediaRoot: path.join(root, 'media-search'),
      outputPath: path.join(root, 'audit.json'),
      historyPolicy: 'preserve-audit',
      plan: false,
      json: false,
    },
    {
      nativeInspector: async () => ({
        status: 'ready',
        stats: { count: 1, totalBytes: 6, replacedCount: 0, deletedCount: 0 },
        thumbnailSources: [],
      }),
      previewer: async () => {
        fs.writeFileSync(original, 'after-with-different-size')
        return {
          ok: true,
          token: 'ephemeral',
          categories: [],
          imageRecords: 1,
          videoRecords: 0,
          totalRecords: 1,
          fileCount: 0,
          estimatedBytes: 0,
          originalFilesAffected: 1,
          warnings: [],
        }
      },
    },
  )
  assert.equal(report.status, 'failed')
  assert.equal(report.invariants.sourceTreeMetadataUnchanged, false)
  assert.equal(report.invariants.readOnlyInvariantsPassed, false)
  assert.match(report.warnings.join('\n'), /Source tree metadata changed/)
  assert.match(report.warnings.join('\n'), /1 original file/)
})

test('source audit reports partial evidence when the native index cannot be inspected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-partial-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  let written
  const report = await runAudit(
    {
      sourcePath: source,
      userDataPath: path.join(root, 'user-data'),
      mediaRoot: path.join(root, 'media-search'),
      outputPath: path.join(root, 'audit.json'),
      historyPolicy: 'preserve-audit',
      plan: false,
      json: false,
    },
    {
      nativeInspector: async () => ({
        status: 'unavailable',
        stats: { count: 0, totalBytes: 0, replacedCount: 0, deletedCount: 0 },
        thumbnailSources: [],
        warning: 'fixture unavailable',
      }),
      previewer: async () => ({
        ok: true,
        token: 'ephemeral',
        categories: [],
        imageRecords: 0,
        videoRecords: 0,
        totalRecords: 0,
        fileCount: 0,
        estimatedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
      }),
      writeReport: async (_filePath, value) => {
        written = value
      },
    },
  )
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.warnings, ['fixture unavailable'])
  assert.equal(written.preview.token, undefined)
})

test('audit report paths inside the source are rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  assert.throws(
    () =>
      validateOptions({
        sourcePath: source,
        outputPath: path.join(source, 'audit.json'),
      }),
    /cannot be written inside/,
  )
})

test('audit report boundary resolves junction targets before accepting output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-audit-junction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const linked = path.join(root, 'linked-output')
  fs.mkdirSync(source)
  try {
    fs.symlinkSync(source, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.message}`)
    return
  }
  assert.throws(
    () =>
      validateOptions({
        sourcePath: source,
        outputPath: path.join(linked, 'audit.json'),
      }),
    /cannot be written inside/,
  )
})

test('preview sanitization strips the destructive confirmation capability', () => {
  assert.deepEqual(sanitizePreview({ ok: true, token: 'secret', totalRecords: 3 }), {
    ok: true,
    totalRecords: 3,
  })
})
