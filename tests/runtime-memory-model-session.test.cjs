const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  parseArgs,
  sourcesUnchanged,
} = require('../scripts/run-runtime-memory-model-session.cjs')

test('model-session benchmark requires bounded repetitions and artifact-only output', () => {
  const projectRoot = path.join('C:\\', 'project')
  const parsed = parseArgs(['--repetitions=3'], projectRoot)
  assert.equal(parsed.repetitions, 3)
  assert.equal(
    parsed.outputDir,
    path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory', 'model-session'),
  )
  assert.throws(() => parseArgs(['--repetitions=4'], projectRoot), /repetitions/)
  assert.throws(
    () => parseArgs(['--output-dir=C:\\outside'], projectRoot),
    /artifacts\/benchmark\/runtime-memory/,
  )
})

test('model-session source proof detects content metadata changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-model-session-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'frame.jpg')
  fs.writeFileSync(filePath, 'frame')
  const stat = fs.statSync(filePath)
  const snapshots = [{ filePath, size: stat.size, mtimeMs: stat.mtimeMs }]
  assert.equal(sourcesUnchanged(snapshots), true)
  fs.appendFileSync(filePath, 'changed')
  assert.equal(sourcesUnchanged(snapshots), false)
})
