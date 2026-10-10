const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BRANCH_PATTERN = /^(?:task|fix|perf|docs|experiment)\/[a-z0-9][a-z0-9-]*$/

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || `git failed`)
  }
  return String(result.stdout || '').trim()
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
}

function main() {
  const [branch, destinationArgument] = process.argv.slice(2)
  if (!branch || !destinationArgument) {
    throw new Error('usage: npm run git:worktree:create -- <branch> <absolute-destination>')
  }
  if (!BRANCH_PATTERN.test(branch)) {
    throw new Error(
      'branch must use task/, fix/, perf/, docs/, or experiment/ plus lowercase kebab-case',
    )
  }
  if (!path.isAbsolute(destinationArgument)) throw new Error('destination must be an absolute path')

  const repoRoot = path.resolve(runGit(['rev-parse', '--show-toplevel'], process.cwd()))
  runGit(['rev-parse', '--verify', 'HEAD'], repoRoot)
  runGit(['rev-parse', '--verify', 'main^{commit}'], repoRoot)
  const destination = path.resolve(destinationArgument)
  if (isInside(repoRoot, destination)) throw new Error('destination must be outside the repository')
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`)

  runGit(['worktree', 'add', '-b', branch, destination, 'main'], repoRoot)
  console.log(`[git-worktree] created ${branch} at ${destination}`)
  console.log(
    `[git-worktree] next: cd ${JSON.stringify(destination)}; npm.cmd ci; npm.cmd run git:setup`,
  )
}

try {
  main()
} catch (error) {
  console.error(`[git-worktree] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
