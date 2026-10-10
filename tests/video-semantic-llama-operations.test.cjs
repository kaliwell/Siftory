const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ARTIFACTS, cachePathFor } = require('../scripts/install-video-semantic-llama-runtime.cjs')
const {
  cleanupInvalidCache,
  inspectCache,
} = require('../scripts/manage-video-semantic-llama-cache.cjs')
const {
  renderPerformanceReport,
} = require('../scripts/report-video-semantic-llama-performance.cjs')

test('cache cleanup removes only partial and invalid known blobs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vid017-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const shaRoot = path.join(root, 'sha256')
  fs.mkdirSync(shaRoot, { recursive: true })
  fs.writeFileSync(path.join(shaRoot, 'download.bits.partial'), 'partial')
  fs.writeFileSync(path.join(shaRoot, 'keep.txt'), 'unknown and preserved')
  fs.writeFileSync(cachePathFor(root, ARTIFACTS.runtime), 'invalid known artifact')
  const before = await inspectCache(root)
  assert.equal(before.invalid, 1)
  assert.equal(before.partialFiles.length, 1)
  const result = await cleanupInvalidCache(root)
  assert.equal(result.removed, 2)
  assert.equal(fs.existsSync(path.join(shaRoot, 'keep.txt')), true)
  assert.equal(result.after.invalid, 0)
})

test('performance report contains aggregate metrics but no private evidence', () => {
  const report = renderPerformanceReport(
    { latencyMs: 1234 },
    {
      sample: { profileCount: 8 },
      summary: {
        attempted: 8,
        strictJson: 8,
        averageLatencyMs: 2000,
        p95LatencyMs: 3000,
        maximumGpuUsedMiB: 2700,
      },
      sidecarStopped: true,
      ok: true,
    },
  )
  assert.match(report, /8\/8/)
  assert.doesNotMatch(report, /[A-Z]:\\|\.mp4|summary.*person/i)
})
