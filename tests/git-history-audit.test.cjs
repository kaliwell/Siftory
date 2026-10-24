const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { auditHistory, summarizeFindings } = require('../scripts/audit-git-history.cjs')
const { scanRepository } = require('../scripts/check-tracked-privacy.cjs')

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return String(result.stdout || '').trim()
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-history-audit-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', 'History Audit Test'])
  git(dir, ['config', 'user.email', 'history-audit@local.invalid'])
  return dir
}

test('source endpoints are blocked before commit and remain detectable after removal from history', () => {
  const dir = createRepo()
  try {
    const address = [8, 8, 8, 8].join('.')
    const source = path.join(dir, 'example.tsx')
    fs.writeFileSync(source, `export const host = "demo@${address}:22"`)
    git(dir, ['add', '.'])
    const current = scanRepository(dir)
    assert.ok(current.some((finding) => finding.kind === 'public SSH endpoint'))
    assert.ok(!JSON.stringify(current).includes(address))
    git(dir, ['commit', '-m', 'synthetic endpoint fixture'])
    fs.writeFileSync(source, 'export const host = "demo@203.0.113.10:22"')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'redacted fixture'])
    assert.deepEqual(scanRepository(dir), [])
    const history = auditHistory(dir)
    assert.ok(history.some((finding) => finding.kind === 'public SSH endpoint'))
    assert.ok(!JSON.stringify(history).includes(address))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('history audit catches personal paths removed from the current tree', () => {
  const dir = createRepo()
  const destination = `${dir}-backup`
  try {
    fs.mkdirSync(path.join(dir, 'docs'))
    const document = path.join(dir, 'docs', 'sample.md')
    fs.writeFileSync(document, String.raw`source: C:\Users\private-user\Downloads\sample.psd`)
    git(dir, ['add', 'docs/sample.md'])
    git(dir, ['commit', '-m', 'private fixture'])
    fs.writeFileSync(document, String.raw`source: <DATASET>\sample.psd`)
    git(dir, ['add', 'docs/sample.md'])
    git(dir, ['commit', '-m', 'redacted fixture'])

    const findings = auditHistory(dir)
    assert.ok(findings.some((finding) => finding.kind === 'Windows user directory'))
    assert.equal(summarizeFindings(findings).ok, false)

    const backup = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'create-git-bundle.cjs'), destination],
      { cwd: dir, encoding: 'utf8' },
    )
    assert.notEqual(backup.status, 0)
    assert.match(backup.stderr, /git-history-audit.*blocked/)
    assert.equal(fs.existsSync(destination), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(destination, { recursive: true, force: true })
  }
})

test('history audit accepts repositories that only use stable placeholders', () => {
  const dir = createRepo()
  try {
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'sample.md'), String.raw`source: <DATASET>\sample.psd`)
    git(dir, ['add', 'docs/sample.md'])
    git(dir, ['commit', '-m', 'clean fixture'])
    assert.deepEqual(summarizeFindings(auditHistory(dir)), { ok: true, count: 0, byKind: {} })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
