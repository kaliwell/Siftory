const fsp = require('node:fs/promises')

const { main: rebuildVectorLibrary } = require('./rebuild-vector-library.cjs')

function parseWatchArgs(argv) {
  const waitArgument = argv.find((value) => value.startsWith('--wait-pid='))
  const waitPid = Number(waitArgument?.slice('--wait-pid='.length))
  if (!Number.isSafeInteger(waitPid) || waitPid <= 0) {
    throw new Error('--wait-pid must be a positive process id')
  }
  return {
    waitPid,
    rebuildArgs: argv.filter((value) => value !== waitArgument),
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function rebuildStateFile(rebuildArgs) {
  const argument = rebuildArgs.find((value) => value.startsWith('--state-file='))
  return argument?.slice('--state-file='.length)
}

async function readRebuildPhase(stateFile) {
  if (!stateFile) return undefined
  try {
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    return typeof state.phase === 'string' ? state.phase : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseWatchArgs(argv)
  let lastLogAt = 0
  while (processExists(options.waitPid)) {
    const now = Date.now()
    if (now - lastLogAt >= 5 * 60 * 1000) {
      process.stdout.write(
        `[${new Date(now).toISOString()}] waiting for vector rebuild PID ${options.waitPid}\n`,
      )
      lastLogAt = now
    }
    await delay(30 * 1000)
  }
  const phase = await readRebuildPhase(rebuildStateFile(options.rebuildArgs))
  if (phase === 'completed') {
    process.stdout.write(
      `[${new Date().toISOString()}] PID ${options.waitPid} completed the vector rebuild; no resume needed\n`,
    )
    return
  }
  process.stdout.write(
    `[${new Date().toISOString()}] PID ${options.waitPid} exited in phase ${phase || 'unknown'}; resuming vector rebuild in 10 seconds\n`,
  )
  await delay(10 * 1000)
  await rebuildVectorLibrary(options.rebuildArgs)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  main,
  parseWatchArgs,
  processExists,
  readRebuildPhase,
  rebuildStateFile,
}
