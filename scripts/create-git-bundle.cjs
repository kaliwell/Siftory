const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || `git failed`)
  }
  return String(result.stdout || '').trim()
}

function isInside(parent, candidate, pathApi = path) {
  const parentRoot = pathApi.parse(parent).root
  const candidateRoot = pathApi.parse(candidate).root
  if (parentRoot.toLowerCase() !== candidateRoot.toLowerCase()) return false
  const relative = pathApi.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..')
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function main() {
  const [destinationArgument] = process.argv.slice(2)
  if (!destinationArgument) {
    throw new Error('usage: npm run git:backup -- <absolute-output-directory>')
  }
  if (!path.isAbsolute(destinationArgument)) throw new Error('output directory must be absolute')

  const repoRoot = path.resolve(runGit(['rev-parse', '--show-toplevel'], process.cwd()))
  runGit(['rev-parse', '--verify', 'HEAD'], repoRoot)
  const historyAudit = spawnSync(
    process.execPath,
    [path.join(__dirname, 'audit-git-history.cjs')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )
  if (historyAudit.status !== 0) {
    throw new Error(
      String(
        historyAudit.stderr || historyAudit.stdout || 'Git history privacy audit failed',
      ).trim(),
    )
  }
  const destination = path.resolve(destinationArgument)
  if (isInside(repoRoot, destination))
    throw new Error('backup directory must be outside the repository')
  fs.mkdirSync(destination, { recursive: true })

  const bundlePath = path.join(destination, `floating-clock-${timestamp()}.bundle`)
  if (fs.existsSync(bundlePath)) throw new Error(`backup already exists: ${bundlePath}`)
  runGit(['bundle', 'create', bundlePath, '--all'], repoRoot)
  runGit(['bundle', 'verify', bundlePath], repoRoot)
  console.log(`[git-backup] verified bundle: ${bundlePath}`)
  console.log(
    '[git-backup] note: bundles contain committed Git objects only, not working-tree changes',
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[git-backup] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { isInside }
