const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return (result.stdout || '').trim()
}

function readGitConfig(key) {
  const result = spawnSync('git', ['config', '--get', key], { encoding: 'utf8', stdio: 'pipe' })
  return result.status === 0 ? (result.stdout || '').trim() : ''
}

function main() {
  const repoRoot = runGit(['rev-parse', '--show-toplevel'])
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    const hookPath = path.join(repoRoot, '.githooks', hook)
    if (!fs.existsSync(hookPath)) throw new Error(`missing hook: .githooks/${hook}`)
    fs.chmodSync(hookPath, 0o755)
  }
  runGit(['config', '--local', 'core.hooksPath', '.githooks'])
  runGit(['config', '--local', 'commit.template', '.gitmessage'])
  runGit(['config', '--local', 'core.autocrlf', 'false'])
  runGit(['config', '--local', 'core.safecrlf', 'true'])
  console.log('[git-setup] core.hooksPath=.githooks')
  console.log('[git-setup] commit.template=.gitmessage')
  console.log('[git-setup] core.autocrlf=false; core.safecrlf=true')
  const name = readGitConfig('user.name')
  const email = readGitConfig('user.email')
  if (!name || !email) {
    console.warn('[git-setup] warning: configure user.name and user.email before the first commit')
  }
}

try {
  main()
} catch (error) {
  console.error(`[git-setup] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
