const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { auditHistory, summarizeFindings } = require('../scripts/audit-git-history.cjs')

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
