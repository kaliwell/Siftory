const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('NekoSearch annotation smoke covers the ACC-02 acceptance policy', () => {
  const script = path.join(__dirname, 'neko-search-annotation.cjs')
  const result = spawnSync(process.execPath, [script, 'smoke'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /"acc02Acceptance":"ok"/)
  assert.match(result.stdout, /"manualReviewQueue":"ok"/)
  assert.match(result.stdout, /"datasetBoundAudit":"ok"/)
})

test('NekoSearch annotation UI advances through seeded labels for audited manual review', () => {
  const source = fs.readFileSync(path.join(__dirname, 'neko-search-annotation.cjs'), 'utf8')
  const html = fs.readFileSync(path.join(__dirname, 'neko-search-annotation.html'), 'utf8')

  assert.match(source, /event\.datasetFingerprint !== datasetFingerprint/)
  assert.match(source, /state\.reviewQueue = Object\.fromEntries/)
  assert.match(html, /function needsManualReview\(category, item\)/)
  assert.match(html, /isDecided\(labels\[item\.id\]\) && !needsManualReview\(category, item\)/)
})
