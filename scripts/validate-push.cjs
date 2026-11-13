const fs = require('node:fs')
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
    remoteSha === ZERO_SHA
      ? ['rev-list', localSha, '--not', '--remotes']
      : ['rev-list', `${remoteSha}..${localSha}`]
  const output = git(args, cwd)
  return output ? output.split(/\r?\n/) : []
}

/**
 * Resolve the commits a push introduces.
 *
 * A brand-new tag must resolve to the commit it points at instead of the whole
 * reachable history; otherwise every new tag re-validates legacy commits that
 * predate the current message policy and can never be pushed.
 */
function updateCommits(cwd, localRef, localSha, remoteSha) {
  if (!localSha || localSha === ZERO_SHA) return []
  if (remoteSha === ZERO_SHA && localRef.startsWith('refs/tags/')) {
    return [git(['rev-parse', `${localSha}^{commit}`], cwd)]
  }
  return commitsForUpdate(cwd, localSha, remoteSha)
}

function updateTip(cwd, localRef, localSha, remoteSha) {
  if (remoteSha === ZERO_SHA && localRef.startsWith('refs/tags/')) {
    return git(['rev-parse', `${localSha}^{commit}`], cwd)
  }
  return localSha
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

  for (const [localRef, localSha, , remoteSha] of updates) {
    if (!localSha || !remoteSha) throw new Error('invalid pre-push input')
    if (localSha === ZERO_SHA) continue
    tips.add(updateTip(repoRoot, localRef, localSha, remoteSha))
    for (const commit of updateCommits(repoRoot, localRef, localSha, remoteSha)) commits.add(commit)
  }

  const metadataErrors = []
  for (const commit of commits) {
    const message = git(['log', '-1', '--format=%B', commit], repoRoot)
    for (const error of validate(message)) metadataErrors.push(`${commit.slice(0, 12)}: ${error}`)
  }
  if (metadataErrors.length > 0) {
    console.error('[pre-push] commit message blocked:')
    for (const error of metadataErrors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  // Push checks commit format only; CI owns source validation.
  console.log(`[pre-push] passed: ${commits.size} new commit(s), ${tips.size} tip(s)`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[pre-push] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { updateCommits, updateTip, ZERO_SHA }
