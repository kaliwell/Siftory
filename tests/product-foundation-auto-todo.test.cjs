const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildValueTodoSnapshot,
  parseValueTaskRows,
} = require('../scripts/next-value-optimization-task.cjs')

const projectRoot = path.resolve(__dirname, '..')
const todoPath = path.join(
  projectRoot,
  'docs',
  'current',
  '2026-08-25-product-foundation-auto-todo.md',
)

test('product-foundation TODO is machine readable, dependency closed, and fully automatic', () => {
  const markdown = fs.readFileSync(todoPath, 'utf8')
  const tasks = parseValueTaskRows(markdown)
  const snapshot = buildValueTodoSnapshot(tasks)
  assert.equal(snapshot.ok, true, snapshot.errors.join('\n'))
  assert.deepEqual(
    tasks.map((task) => task.id),
    ['VAL-801', 'VAL-802', 'VAL-803', 'VAL-804', 'VAL-805', 'VAL-806', 'VAL-807'],
  )
  assert.ok(tasks.every((task) => task.mode === 'auto'))
  assert.ok(tasks.every((task) => task.externalBlockers.length === 0))
  assert.deepEqual(tasks.map((task) => task.status), Array(7).fill('verified'))
  assert.equal(snapshot.selected, null)
  assert.deepEqual(snapshot.blocked, [])
  assert.equal(snapshot.counts.verified, 7)
  assert.equal(snapshot.counts.active, 0)
  assert.match(markdown, /脚本、生成计划或复用旧报告均不算完成/)
  assert.match(markdown, /不更改索引、搜索结果或用户素材语义/)
  assert.match(markdown, /baseline-20260826-final-accepted\/report\.json/)
  assert.match(markdown, /Library Ready P50\/P95 为 `265833\.94\/270172\.98 ms`/)
})

test('package scripts expose selection, full automatic execution, and the real baseline', () => {
  const scripts = require('../package.json').scripts
  assert.match(scripts['todo:foundation-next'], /product-foundation-auto-todo\.md$/)
  assert.match(scripts['todo:foundation-check'], /--check$/)
  assert.match(scripts['todo:foundation-auto'], /test:foundation-automation/)
  assert.match(scripts['todo:foundation-auto'], /typecheck/)
  assert.match(scripts['todo:foundation-auto'], /test:architecture/)
  assert.match(scripts['todo:foundation-auto'], /native-image-fuzz\.test\.cjs/)
  assert.match(scripts['todo:foundation-auto'], /automation:performance-baseline/)
  assert.match(scripts['test:foundation-automation'], /fixed-hardware-system-tools\.test\.cjs/)
  assert.match(scripts['test:foundation-automation'], /transformers-cache-directory\.test\.cjs/)
  assert.equal(
    scripts['automation:performance-baseline'],
    'node scripts/run-fixed-hardware-performance-baseline.cjs',
  )
  assert.match(scripts.test, /test:foundation-automation/)
  assert.match(scripts['test:native'], /native-image-fuzz\.test\.cjs/)
})

test('fixed-hardware baseline retains detailed evidence and fails closed', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'run-fixed-hardware-performance-baseline.cjs'),
    'utf8',
  )
  assert.match(source, /const REQUIRED_RUNS = 3/)
  assert.match(source, /round-.*\.timeline\.ndjson/)
  assert.match(source, /child-process peak RSS must be observed, not zero-filled/)
  assert.match(source, /hardware fingerprint changed/)
  assert.match(source, /measured source changed/)
  assert.match(source, /compareEvidence/)
  assert.match(source, /implementationMode: 'stable'/)
  assert.match(source, /source corpus was not read-only/)
  assert.match(source, /writeBoundedLog/)
  assert.match(source, /taskkill.*\/T.*\/F/s)
  assert.match(source, /snapshotUserDataRoots/)
  assert.match(source, /realLibraryWritten:\s*userDataComparison/)
  assert.match(source, /commitAcceptedBaseline/)
  assert.match(source, /resolveFixedHardwareSystemTools/)
  assert.match(source, /--diagnostic/)
})

test('Native fuzz uses deterministic isolated child processes with bounded output and time', () => {
  const fuzz = fs.readFileSync(
    path.join(projectRoot, 'tests', 'native-image-fuzz.test.cjs'),
    'utf8',
  )
  const worker = fs.readFileSync(
    path.join(projectRoot, 'tests', 'native-image-fuzz-worker.cjs'),
    'utf8',
  )
  assert.match(fuzz, /EXPECTED_CORPUS_SHA256/)
  assert.match(fuzz, /CASE_TIMEOUT_MS/)
  assert.match(fuzz, /maxBuffer:\s*64 \* 1024/)
  assert.match(fuzz, /spawnSync\(/)
  assert.match(worker, /realpathSync/)
  assert.match(worker, /os\.tmpdir\(\)/)
  assert.match(worker, /hashImageAsync/)
})
