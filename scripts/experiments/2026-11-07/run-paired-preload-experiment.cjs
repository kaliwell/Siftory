'use strict'
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process')
const root = path.resolve(__dirname, '../../..'),
  file = path.join(root, 'src/App.tsx'),
  original = fs.readFileSync(file, 'utf8')
const needle = 'const loaders = lazyPanels.map((panel) => panel.load)'
if (!original.includes(needle)) throw new Error('Unexpected preload source; no source changed')
const parent = path.join(root, 'artifacts/benchmark/runtime-memory')
fs.mkdirSync(parent, { recursive: true })
const out = fs.mkdtempSync(path.join(parent, 'preload-paired-'))
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
async function run(args, log, env = {}) {
  const fd = fs.openSync(path.join(out, log), 'w')
  try {
    await new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, args, {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32')
            cp.execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            })
          else child.kill()
        } catch {
          /* Ignore incomplete diagnostic records or best-effort cleanup errors; acceptance is validated separately. */
        }
        reject(new Error(log + ' exceeded 10-minute bound'))
      }, 600000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        code === 0 ? resolve() : reject(new Error(log + ' failed: ' + code))
      })
    })
  } finally {
    fs.closeSync(fd)
  }
}
async function main() {
  fs.writeFileSync(path.join(out, 'original-App.tsx'), original)
  let current = original
  const reports = []
  const restoreExperimentSource1 = async () => {
    if (fs.readFileSync(file, 'utf8') !== current)
      throw new Error('Concurrent source edit; automatic restore skipped')
    fs.writeFileSync(file, original)
    await run([npm, 'run', 'build:renderer:checked'], 'restored-build.log')
  }
  try {
    for (const [round, policy] of ['all', 'demand', 'demand', 'all', 'all', 'demand'].entries()) {
      if (fs.readFileSync(file, 'utf8') !== current)
        throw new Error('Concurrent App edit; refusing overwrite')
      current =
        policy === 'all'
          ? original
          : original.replace(needle, 'const loaders: Array<() => Promise<unknown>> = []')
      fs.writeFileSync(file, current)
      console.log(JSON.stringify({ round, policy, step: 'build', out }))
      await run([npm, 'run', 'build:renderer:checked'], round + '-build.log')
      await run(['scripts/run-workspace-performance-baseline.cjs'], round + '-measure.log', {
        SIFTORY_PERFORMANCE_FIRST_RUN: '3',
        SIFTORY_PERFORMANCE_IDLE_MS: '15000',
        SIFTORY_PERFORMANCE_SETTLE_MS: '30000',
        SIFTORY_PERFORMANCE_OUTPUT: path.join(out, 'round-' + round),
      })
      const r = JSON.parse(fs.readFileSync(path.join(out, 'round-' + round, 'run-3.json'), 'utf8'))
      if (r.status !== 'passed' || !r.after100Settled) throw new Error('Round incomplete: ' + round)
      reports.push({
        round,
        policy,
        status: r.status,
        startup: r.startup,
        before: r.beforeNavigation,
        after: r.after100Switches,
        settled: r.after100Settled,
        firstOpens: r.switches.slice(0, 5),
      })
      fs.writeFileSync(
        path.join(out, 'comparison.json'),
        JSON.stringify(
          {
            scope:
              'Interleaved order; fresh isolated profiles; 15 seconds idle and 30 seconds settling; uncontrolled OS cache. No strategy adopted automatically.',
            reports,
          },
          null,
          2,
        ),
      )
      console.log(JSON.stringify(reports.at(-1)))
    }
  } finally {
    restoreExperimentSource1()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
