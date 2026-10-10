const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  isWholeDrive,
  parseArgs,
  validateOptions,
} = require('../scripts/rebuild-vector-library.cjs')
const {
  parseWatchArgs,
  processExists,
  readRebuildPhase,
  rebuildStateFile,
} = require('../scripts/watch-vector-rebuild.cjs')

test('vector rebuild requires an explicit whole-drive acknowledgement', () => {
  assert.equal(isWholeDrive('D:\\'), true)
  assert.equal(isWholeDrive('D:\\Images'), false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-rebuild-options-'))
  const userDataPath = path.join(root, 'floating-clock-electron')
  const childrenDir = path.join(root, 'children')
  fs.mkdirSync(userDataPath)
  fs.mkdirSync(childrenDir)
  for (const child of [
    'embeddingPreparationChild.js',
    'dinoEmbeddingChild.js',
    'clipEmbeddingChild.js',
  ]) {
    fs.writeFileSync(path.join(childrenDir, child), '')
  }
  const base = [`--user-data=${userDataPath}`, '--scan-path=D:\\', `--children-dir=${childrenDir}`]
  assert.throws(() => validateOptions(parseArgs(base)), /allow-whole-drive/)
  assert.doesNotThrow(() => validateOptions(parseArgs([...base, '--allow-whole-drive'])))
})

test('vector rebuild defaults to preview and adaptive batch', () => {
  const options = parseArgs(['--scan-path=D:\\Images'])
  assert.equal(options.execute, false)
  assert.equal(options.batchSize, 0)
  assert.equal(options.backend, 'gpu')
  assert.equal(options.jobs, 2)
  assert.equal(options.maxFailures, 1000)
  assert.equal(options.maxFailureRate, 0.01)
})

test('vector rebuild clamps explicit failure budgets', () => {
  const options = parseArgs(['--scan-path=D:\\Images', '--max-failures=50', '--max-failure-rate=2'])
  assert.equal(options.maxFailures, 50)
  assert.equal(options.maxFailureRate, 1)
})

test('vector rebuild watchdog separates its wait pid from rebuild arguments', () => {
  const parsed = parseWatchArgs(['--wait-pid=123', '--execute', '--scan-path=D:\\'])
  assert.equal(parsed.waitPid, 123)
  assert.deepEqual(parsed.rebuildArgs, ['--execute', '--scan-path=D:\\'])
  assert.equal(processExists(process.pid), true)
  assert.throws(() => parseWatchArgs(['--wait-pid=0']), /positive process id/)
})

test('vector rebuild watchdog recognizes completed state before resuming', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-rebuild-watchdog-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const statePath = path.join(root, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({ phase: 'completed' }))
  const rebuildArgs = [`--state-file=${statePath}`, '--execute']
  assert.equal(rebuildStateFile(rebuildArgs), statePath)
  assert.equal(await readRebuildPhase(statePath), 'completed')
})
