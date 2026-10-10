const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    input: options.input,
    stdio: options.inherit ? 'inherit' : 'pipe',
  })
  if (result.status !== 0) {
    const detail = options.inherit
      ? result.error?.message || ''
      : String(result.error?.message || result.stderr || result.stdout || '').trim()
    throw new Error(detail || `${command} ${args.join(' ')} failed (${result.status})`)
  }
  return String(result.stdout || '').trim()
}

function git(args, options = {}) {
  return run('git', args, options)
}

function createSnapshotCommit(repoRoot) {
  const tree = git(['write-tree'], { cwd: repoRoot })
  const parentResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const args = ['commit-tree', tree]
  if (parentResult.status === 0) args.push('-p', parentResult.stdout.trim())
  const identityEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Staged Snapshot Validator',
    GIT_AUTHOR_EMAIL: 'staged-snapshot@local.invalid',
    GIT_COMMITTER_NAME: 'Staged Snapshot Validator',
    GIT_COMMITTER_EMAIL: 'staged-snapshot@local.invalid',
  }
  return git(args, {
    cwd: repoRoot,
    env: identityEnv,
    input: 'temporary staged snapshot\n',
  })
}

function linkDependencies(repoRoot, snapshotRoot) {
  const source = path.join(repoRoot, 'node_modules')
  if (!fs.existsSync(source)) throw new Error('node_modules is required for staged validation')
  const target = path.join(snapshotRoot, 'node_modules')
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

function validateSnapshot(snapshotRoot, full) {
  const scripts = full ? ['verify'] : ['privacy:check', 'typecheck', 'lint', 'format:check']
  for (const script of scripts) {
    console.log(`[staged-snapshot] npm run ${script}`)
    if (process.platform === 'win32') {
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', script], {
        cwd: snapshotRoot,
        inherit: true,
      })
    } else {
      run('npm', ['run', script], { cwd: snapshotRoot, inherit: true })
    }
  }
}

function main() {
  // Hooks leak repo-scoped variables (notably GIT_INDEX_FILE) into the
  // environment; sanitize once so every spawned git/npm child sees a clean env.
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_INDEX_FILE
  const repoRoot = git(['rev-parse', '--show-toplevel'])
  const commitIndex = process.argv.indexOf('--commit')
  const requestedCommit = commitIndex >= 0 ? process.argv[commitIndex + 1] : ''
  if (commitIndex >= 0 && !requestedCommit) throw new Error('--commit requires a commit id')
  const full = process.argv.includes('--full')
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-staged-'))
  const snapshotRoot = path.join(tempParent, 'worktree')
  const dependencyLink = path.join(snapshotRoot, 'node_modules')
  let worktreeAdded = false
  try {
    const commit = requestedCommit
      ? git(['rev-parse', '--verify', `${requestedCommit}^{commit}`], { cwd: repoRoot })
      : createSnapshotCommit(repoRoot)
    git(['worktree', 'add', '--detach', '--quiet', snapshotRoot, commit], { cwd: repoRoot })
    worktreeAdded = true
    linkDependencies(repoRoot, snapshotRoot)
    validateSnapshot(snapshotRoot, full)
    console.log(
      requestedCommit
        ? `[staged-snapshot] commit ${requestedCommit} passed ${full ? 'full' : 'quick'} checks`
        : '[staged-snapshot] staged tree passed all checks',
    )
  } finally {
    if (fs.existsSync(dependencyLink)) {
      try {
        fs.unlinkSync(dependencyLink)
      } catch {
        fs.rmSync(dependencyLink, { recursive: false, force: true })
      }
    }
    if (worktreeAdded) {
      const remove = spawnSync('git', ['worktree', 'remove', '--force', snapshotRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      if (remove.status !== 0) {
        console.error(`[staged-snapshot] cleanup warning: ${remove.stderr || remove.stdout}`)
      }
    }
    fs.rmSync(tempParent, { recursive: true, force: true })
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' })
  }
}

try {
  main()
} catch (error) {
  console.error(`[staged-snapshot] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
