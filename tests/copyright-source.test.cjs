const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  prepareSource,
  wrapSourceLine,
  findSubmissionIssues,
} = require('../scripts/prepare-copyright-source.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copyright-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return { root, put }
}

test('source candidate excludes vendored code and build outputs without claiming ownership', (t) => {
  const { root, put } = fixture(t)
  put('electron/main.ts', 'const first = 1\n\nexport { first }\n')
  put('native/stb_image.h', 'third party code')
  put('native/build/generated.cc', 'generated code')
  put('src/api.d.ts', 'generated declaration')
  const report = prepareSource(root)
  assert.equal(report.selection, 'complete-selected-source-set')
  assert.equal(report.totals.files, 1)
  assert.equal(report.totals.nonemptyLines, 2)
  assert.equal(report.pages[0].rows[2].line, 3)
  assert.equal(report.files[0].ownership, 'requires-rightsholder-confirmation')
  assert.equal(report.excluded.length, 2)
  assert.deepEqual(prepareSource(root), report)
  put('electron/main.ts', 'export const first = 2\n')
  assert.notEqual(prepareSource(root).sourceSha256, report.sourceSha256)
})

test('front and back remain contiguous and map every display row to original code', (t) => {
  const { root, put } = fixture(t)
  put(
    'electron/main.ts',
    Array.from({ length: 3600 }, (_, i) => `const value${i + 1} = ${i + 1}`).join('\n'),
  )
  const report = prepareSource(root)
  assert.equal(report.pages.length, 60)
  assert.ok(report.pages.every((page) => page.rows.length === 50))
  assert.deepEqual(
    report.pages.slice(0, 30).flatMap((page) => page.rows.map((row) => row.line)),
    Array.from({ length: 1500 }, (_, i) => i + 1),
  )
  assert.deepEqual(
    report.pages.slice(30).flatMap((page) => page.rows.map((row) => row.line)),
    Array.from({ length: 1500 }, (_, i) => i + 2101),
  )
})

test('wrapping preserves Unicode, tab expansion and exact content ordering', () => {
  const line = '\tconst 示例 = "' + '甲a'.repeat(120) + '"'
  const parts = wrapSourceLine(line)
  assert.equal(parts.join(''), line.replace(/\t/g, '    '))
  for (const part of parts)
    assert.ok([...part].reduce((n, c) => n + (c.codePointAt(0) > 255 ? 2 : 1), 0) <= 100)
})

test('blank lines and whitespace-only wrapped segments inside literals survive intact', (t) => {
  const { root, put } = fixture(t)
  const source = 'const template = `start\n\n' + ' '.repeat(220) + 'end`\n'
  put('electron/main.ts', source)
  const report = prepareSource(root)
  assert.equal(
    report.pages.flatMap((page) => page.sourceLines.map((line) => line.text)).join('\n') + '\n',
    source,
  )
  assert.equal(report.pages[0].sourceLines[1].text, '')
  assert.ok(report.pages[0].rows.some((row) => row.text === ' '.repeat(100)))
})

test('non-divisible full source paginates before front/back selection and never slices a line', (t) => {
  const { root, put } = fixture(t)
  put(
    'electron/main.ts',
    Array.from(
      { length: 3607 },
      (_, i) => `const value${i + 1} = "${'a'.repeat(i % 3 === 0 ? 220 : 1)}"`,
    ).join('\n'),
  )
  const report = prepareSource(root)
  assert.equal(report.pages.length, 60)
  assert.deepEqual(
    report.pages.map((page) => page.originalPage),
    [
      ...Array.from({ length: 30 }, (_, i) => i + 1),
      ...Array.from({ length: 30 }, (_, i) => i + 43),
    ],
  )
  assert.ok(report.pages.every((page) => page.nonemptySourceLines >= 50))
  assert.equal(report.pages[59].sourceLines.at(-1).line, 3607)
  assert.ok(report.pages.every((page) => page.rows[0].segment === 0))
})

test('candidate rejects private keys, personal paths and malformed UTF-8', (t) => {
  assert.deepEqual(findSubmissionIssues('-----BEGIN ' + 'PRIVATE KEY-----'), ['private-key'])
  assert.deepEqual(findSubmissionIssues('C:/Users/' + 'private-person/file.ts'), [
    'personal-user-path',
  ])
  assert.deepEqual(findSubmissionIssues('C:/Users/<user>/file.ts'), [])
  assert.deepEqual(findSubmissionIssues('"C:/Users/..."'), [])
  assert.deepEqual(findSubmissionIssues('C:/Users/...private-person/file.ts'), [
    'personal-user-path',
  ])
  const { root, put } = fixture(t)
  put('electron/main.ts', Buffer.from([0xff, 0xfe, 0xff]))
  assert.throws(() => prepareSource(root), /encoded data|encoding/i)
})

test('source directory junction cannot escape the selected project', (t) => {
  const { root, put } = fixture(t)
  put('outside/secret.ts', 'export const credential = 1')
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(root, 'electron'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.throws(() => prepareSource(root), /symlink/)
})
