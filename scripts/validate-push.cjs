const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { validate } = require('./validate-commit-message.cjs')

const ZERO_SHA = '0000000000000000000000000000000000000000'

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || `git failed`)
  }
  return String(result.stdout || '').trim()
}

function commitsForUpdate(cwd, localSha, remoteSha) {
  const args =
    remoteSha === ZERO_SHA ? ['rev-list', localSha] : ['rev-list', `${remoteSha}..${localSha}`]
  const output = git(args, cwd)
  return output ? output.split(/\r?\n/) : []
}

function main() {
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd())
  const updates = fs
    .readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
  const tips = new Set()
  const commits = new Set()

  for (const [, localSha, , remoteSha] of updates) {
    if (!localSha || !remoteSha) throw new Error('invalid pre-push input')
    if (localSha === ZERO_SHA) continue
    tips.add(localSha)
    for (const commit of commitsForUpdate(repoRoot, localSha, remoteSha)) commits.add(commit)
  }

  const metadataErrors = []
  for (const commit of commits) {
    const message = git(['log', '-1', '--format=%B', commit], repoRoot)
    for (const error of validate(message)) metadataErrors.push(`${commit.slice(0, 12)}: ${error}`)
  }
  if (metadataErrors.length > 0) {
    console.error('[pre-push] commit metadata blocked:')
    for (const error of metadataErrors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  const validator = path.join(repoRoot, 'scripts', 'validate-staged-snapshot.cjs')
  for (const tip of tips) {
    const result = spawnSync(process.execPath, [validator, '--commit', tip, '--full'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error(`full verification failed for ${tip}`)
  }
  console.log(`[pre-push] passed: ${commits.size} new commit(s), ${tips.size} tip(s)`)
}

try {
  main()
} catch (error) {
  console.error(`[pre-push] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
