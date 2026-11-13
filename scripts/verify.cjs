// Shared verification entry point. Timings are local artifacts, never source data.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const runId = process.env.SIFTORY_VERIFY_RUN_ID || randomUUID()
const timingPath = path.join(root, 'artifacts/verification/timing.jsonl')
function run(command, args) {
  const started = performance.now()
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SIFTORY_VERIFY_RUN_ID: runId },
  })
  const record = {
    runId,
    mode: process.argv[2] || 'fast',
    at: new Date().toISOString(),
    command: [command, ...args],
    durationMs: Math.round(performance.now() - started),
    passed: result.status === 0,
  }
  fs.mkdirSync(path.join(root, 'artifacts/verification'), { recursive: true })
  fs.appendFileSync(timingPath, JSON.stringify(record) + '\n')
  console.log(
    `[verify] ${record.durationMs}ms ${record.passed ? 'PASS' : 'FAIL'} ${args.join(' ')}`,
  )
  if (result.status !== 0)
    throw new Error(result.error?.message || `Verification failed (${result.status})`)
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
function changedFiles() {
  const ref = process.argv.find((x) => x.startsWith('--base='))?.slice(7)
  const tracked = ref
    ? git(['diff', '--name-only', '-z', `${ref}...HEAD`])
    : git(['diff', '--name-only', '-z', 'HEAD'])
  const untracked = ref ? '' : git(['ls-files', '--others', '--exclude-standard', '-z'])
  return [...new Set((tracked + untracked).split('\0').filter(Boolean))]
}
function testsFor(files) {
  const tests = new Set()
  const rules = [
    [/projectPreview|projectSearchIndex/, ['tests/project-preview.test.cjs']],
    [
      /imageSearchService|progressCoalescer/,
      ['tests/image-search-shutdown.test.cjs', 'tests/image-search-sort.test.cjs'],
    ],
    [
      /git-policy|validate-(push|commit-message|staged-snapshot)|git-preflight|\.githooks|verify\.cjs/,
      ['tests/git-policy.test.cjs', 'tests/verification-routing.test.cjs'],
    ],
    [/check-build-graph/, ['tests/build-graph.test.cjs']],
    [
      /thumbnail|ThumbnailImage|boundedBatchScheduler/,
      [
        'tests/thumbnail-policy.test.cjs',
        'tests/thumbnail-request-scheduler.test.cjs',
        'tests/thumbnail-rebuild-pipeline.test.cjs',
      ],
    ],
    [
      /settings|Settings|settingsWriter/,
      ['tests/settings-store.test.cjs', 'tests/settings-writer.test.cjs'],
    ],
    [
      /WorkspaceNavigator|workspaceRoutes|workspaceNavigation|openWorkspace/,
      ['tests/workspace-navigation.test.cjs', 'tests/focused-workspace.test.cjs'],
    ],
    [
      /assetLibrary|AssetLibrary|assetMetadata/,
      [
        'tests/asset-library.test.cjs',
        'tests/asset-library-list-request.test.cjs',
        'tests/asset-library-task-controller.test.cjs',
      ],
    ],
    [
      /mediaSearch|MediaSearch/,
      ['tests/media-search-guards.test.cjs', 'tests/media-search-single-video-source.test.cjs'],
    ],
  ]
  let broad = false
  const reasons = []
  let docs = false
  for (const file of files) {
    if (/^tests\/.*\.test\.cjs$/.test(file)) {
      tests.add(file)
      continue
    }
    if (/\.md$/.test(file)) {
      docs = true
      continue
    }
    if (file === '.gitmessage' || file.startsWith('scripts/experiments/')) continue
    let matched = false
    for (const [pattern, targets] of rules)
      if (pattern.test(file)) {
        targets.forEach((x) => tests.add(x))
        matched = true
      }
    if (!matched) {
      broad = true
      reasons.push(file)
    }
  }
  return { tests: [...tests], broad, reasons, docs }
}
function npm(script) {
  if (!process.env.npm_execpath) throw new Error('Run this mode through npm run verify:<mode>')
  run(process.execPath, [process.env.npm_execpath, 'run', script])
}
function unitTestFiles(scripts, names) {
  const files = new Set()
  for (const name of names) {
    const command = scripts[name]
    if (
      typeof command !== 'string' ||
      !/^node --test(?: tests\/[\w.-]+\.test\.cjs)+$/.test(command)
    )
      throw new Error(`Cannot safely deduplicate test script: ${name}`)
    for (const file of command.slice('node --test '.length).split(/\s+/)) files.add(file)
  }
  return [...files]
}
function summarizeTimings(records) {
  const groups = new Map()
  for (const record of records) {
    if (!Array.isArray(record.command) || !Number.isFinite(record.durationMs)) continue
    const name = record.command.join(' ')
    const item = groups.get(name) || {
      command: name,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      failures: 0,
      repeatedInRun: 0,
      runs: new Set(),
    }
    item.count += 1
    item.totalMs += record.durationMs
    item.maxMs = Math.max(item.maxMs, record.durationMs)
    if (!record.passed) item.failures += 1
    if (record.runId && item.runs.has(record.runId)) item.repeatedInRun += 1
    if (record.runId) item.runs.add(record.runId)
    groups.set(name, item)
  }
  return [...groups.values()]
    .map(({ runs, ...item }) => ({
      ...item,
      runs: runs.size,
      meanMs: Math.round(item.totalMs / item.count),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
}
function main() {
  const mode = process.argv[2] || 'fast'
  if (mode === 'timings') {
    const records = fs.existsSync(timingPath)
      ? fs
          .readFileSync(timingPath, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    console.table(summarizeTimings(records))
  } else if (mode === 'fast') {
    run(process.execPath, ['scripts/git-preflight.cjs'])
    run('git', ['diff', '--cached', '--check'])
  } else if (mode === 'changed') {
    const files = changedFiles()
    console.log('[verify] changed files:', files.join(', ') || '(none)')
    const selected = testsFor(files)
    if (process.argv.includes('--plan')) {
      console.log(JSON.stringify(selected, null, 2))
      return
    }
    if (selected.broad) {
      console.log(
        '[verify] unclassified/shared changes: using CI checks:',
        selected.reasons.join(', '),
      )
      npm('verify:ci')
      return
    }
    const code = files.filter(
      (x) => /\.(tsx?|cjs|mjs)$/.test(x) && fs.existsSync(path.join(root, x)),
    )
    if (code.length)
      run(process.execPath, [
        path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js'),
        ...code,
      ])
    if (selected.tests.length) run(process.execPath, ['--test', ...selected.tests])
    if (selected.docs) npm('docs:check')
    const formatted = files.filter(
      (x) => /\.(tsx?|cjs|mjs|json|css|md|ya?ml)$/.test(x) && fs.existsSync(path.join(root, x)),
    )
    if (formatted.length)
      run(process.execPath, [
        path.join(path.dirname(require.resolve('prettier/package.json')), 'bin/prettier.cjs'),
        '--check',
        ...formatted,
      ])
  } else if (mode === 'ci') {
    npm('toolchain:check')
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
    run(process.execPath, [
      '--test',
      ...unitTestFiles(scripts, ['test:focused-workspace', 'test:core-behavior']),
    ])
    for (const script of [
      'typecheck',
      'test:architecture',
      'test:indexing-ui:regression',
      'test:project-preview:worker',
      'test:storage:metadata',
      'lint',
      'format:check',
      'docs:check',
      'test:git-policy',
      'test:git-history-audit',
      'test:privacy',
      'test:i18n-static',
      'test:ipc-validation',
      'build:renderer:checked',
    ])
      npm(script)
    run(process.execPath, [process.env.npm_execpath, 'audit', '--audit-level=high'])
  } else if (mode === 'release') {
    // Keep the existing full-suite/critical-coverage gate for releases.
    npm('ci:verify')
    npm('docs:check')
    for (const script of ['licenses:gate', 'smoke:packaged:resources', 'smoke:installer:archive'])
      npm(script)
    run(process.execPath, ['tests/packaged-launch-smoke.cjs'])
  } else throw new Error(`Unknown verification mode: ${mode}`)
}
if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { testsFor, summarizeTimings, unitTestFiles }
