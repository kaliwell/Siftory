'use strict'
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process')
const root = process.cwd(),
  file = path.join(root, 'src/App.tsx'),
  original = fs.readFileSync(file, 'utf8')
const needle = 'const loaders = lazyPanels.map((panel) => panel.load)'
if (!original.includes(needle)) throw new Error('Unexpected preload source; refusing experiment')
const out = path.join(root, 'artifacts/benchmark/runtime-memory/preload-visible-screen-20261107')
fs.mkdirSync(out, { recursive: true })
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
function run(args, log, env = {}) {
  const fd = fs.openSync(path.join(out, log), 'w')
  try {
    const r = cp.spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 600000,
    })
    if (r.status !== 0) throw new Error(log + ' failed with ' + r.status)
  } finally {
    fs.closeSync(fd)
  }
}
const policies = [
  ['all', needle],
  [
    'search',
    "const loaders = lazyPanels.filter((panel) => panel.id === 'imageSearch' || panel.id === 'mediaSearch').map((panel) => panel.load)",
  ],
  ['demand', 'const loaders: Array<() => Promise<unknown>> = []'],
]
let current = original
const restoreExperimentSource1 = () => {
  if (fs.readFileSync(file, 'utf8') === current) {
    fs.writeFileSync(file, original)
    console.log(JSON.stringify({ step: 'restore-original-source-and-build' }))
    run([npm, 'run', 'build:renderer:checked'], 'restored-build.log')
  } else {
    throw new Error('Source changed during benchmark; no automatic restore')
  }
}
try {
  for (const [name, line] of policies) {
    if (fs.readFileSync(file, 'utf8') !== current)
      throw new Error('Concurrent source edit; refusing overwrite')
    current = original.replace(needle, line)
    fs.writeFileSync(file, current)
    console.log(JSON.stringify({ step: 'build', policy: name }))
    run([npm, 'run', 'build:renderer:checked'], name + '-build.log')
    console.log(JSON.stringify({ step: 'measure', policy: name }))
    run(['scripts/run-workspace-performance-baseline.cjs'], name + '-benchmark.log', {
      SIFTORY_PERFORMANCE_FIRST_RUN: '1',
      SIFTORY_PERFORMANCE_IDLE_MS: '15000',
      SIFTORY_PERFORMANCE_OUTPUT: path.join(out, name),
    })
  }
} finally {
  restoreExperimentSource1()
}
const median = (x) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)]
const report = policies.map(([name]) => {
  const r = JSON.parse(fs.readFileSync(path.join(out, name, 'baseline.json'))).results
  return {
    policy: name,
    runs: r.length,
    status: r.every((x) => x.status === 'passed') ? 'passed' : 'failed',
    medianInteractiveMs: median(r.map((x) => x.startup.searchNavigationInteractiveMs)),
    medianBeforeNavigationMiB: median(r.map((x) => x.beforeNavigation.workingSetMiB)),
    medianFirstFiveOpenMs: median(r.flatMap((x) => x.switches.slice(0, 5).map((s) => s.ms))),
    medianAfter100MiB: median(r.map((x) => x.after100Switches.workingSetMiB)),
  }
})
fs.writeFileSync(
  path.join(out, 'comparison.json'),
  JSON.stringify(
    {
      scope:
        'Screening only: 15-second idle, three grouped runs per policy; uncontrolled OS cache, empty library, not randomized paired acceptance; original source and build restored. No policy adopted.',
      report,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify(report))
