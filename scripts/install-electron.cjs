const path = require('node:path')
const { spawnSync } = require('node:child_process')

const FALLBACK_MIRROR = 'https://npmmirror.com/mirrors/electron/'

function runInstaller(installerPath, env) {
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
    shell: false,
  })
  return { exitCode: result.status ?? 1, error: result.error?.message }
}

function installElectron(options = {}) {
  const env = options.env || process.env
  const runner = options.runner || runInstaller
  const installerPath =
    options.installerPath || path.resolve(__dirname, '..', 'node_modules', 'electron', 'install.js')
  const first = runner(installerPath, env)
  if (first.exitCode === 0) return { ok: true, usedFallback: false }
  if (env.ELECTRON_MIRROR?.trim()) {
    return { ok: false, usedFallback: false, error: first.error }
  }

  console.warn(
    `[electron-install] official download failed; retrying ${FALLBACK_MIRROR} with Electron's bundled checksums`,
  )
  const fallback = runner(installerPath, { ...env, ELECTRON_MIRROR: FALLBACK_MIRROR })
  return {
    ok: fallback.exitCode === 0,
    usedFallback: true,
    error: fallback.error,
  }
}

if (require.main === module) {
  const result = installElectron()
  if (!result.ok) {
    console.error(`[electron-install] failed${result.error ? `: ${result.error}` : ''}`)
    process.exitCode = 1
  }
}

module.exports = { FALLBACK_MIRROR, installElectron }
