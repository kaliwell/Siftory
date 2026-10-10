const { spawnSync } = require('node:child_process')
const path = require('node:path')

const MAX_STAGED_FILE_BYTES = 25 * 1024 * 1024
const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '.model-cache-test',
  'ai-models',
  'artifacts',
  'backup',
  'cppbackup',
  'crash-dumps',
  'dist',
  'dist-electron',
  'node_modules',
  'release',
])
const FORBIDDEN_PREFIXES = ['native/build/', 'native/build-electron/', 'native/build-node/']
const FORBIDDEN_EXTENSIONS = new Set(['.7z', '.dll', '.exe', '.node', '.onnx', '.zip'])
const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)(id_rsa|id_ed25519)$/i,
  /\.(key|p12|pfx|pem)$/i,
]
const SECRET_CONTENT_PATTERNS = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
]

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding || 'utf8',
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return result.stdout || ''
}

function normalizeGitPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function stagedPaths(cwd) {
  return runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd })
    .split('\0')
    .filter(Boolean)
    .map(normalizeGitPath)
}

function allStagedPaths(cwd) {
  return runGit(['diff', '--cached', '--name-only', '-z'], { cwd })
    .split('\0')
    .filter(Boolean)
    .map(normalizeGitPath)
}

function isForbiddenDirectoryPath(stagedPath) {
  const lower = normalizeGitPath(stagedPath).toLowerCase()
  const segments = lower.split('/')
  return (
    segments.some((segment) => FORBIDDEN_DIRECTORY_NAMES.has(segment)) ||
    FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))
  )
}

function stagedBlobSize(cwd, stagedPath) {
  const value = runGit(['cat-file', '-s', `:${stagedPath}`], { cwd }).trim()
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`invalid staged size for ${stagedPath}`)
  return size
}

function stagedBlobText(cwd, stagedPath, size) {
  if (size > MAX_SECRET_SCAN_BYTES) return ''
  return runGit(['cat-file', 'blob', `:${stagedPath}`], {
    cwd,
    maxBuffer: MAX_SECRET_SCAN_BYTES + 1024,
  })
}

function findSecretContent(text) {
  return SECRET_CONTENT_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name)
}

function checkStagedPath(cwd, stagedPath, errors) {
  const lower = stagedPath.toLowerCase()
  if (isForbiddenDirectoryPath(stagedPath)) {
    errors.push(`${stagedPath}: generated/runtime directory is not allowed`)
  }
  if (FORBIDDEN_EXTENSIONS.has(path.posix.extname(lower))) {
    errors.push(`${stagedPath}: binary/model extension is not allowed in normal Git history`)
  }
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(stagedPath))) {
    errors.push(`${stagedPath}: possible credential or private-key file`)
  }

  const size = stagedBlobSize(cwd, stagedPath)
  if (size > MAX_STAGED_FILE_BYTES) {
    errors.push(`${stagedPath}: ${(size / 1024 / 1024).toFixed(2)} MiB exceeds the 25 MiB limit`)
  }
  if (size <= MAX_SECRET_SCAN_BYTES) {
    const secretKinds = findSecretContent(stagedBlobText(cwd, stagedPath, size))
    for (const secretKind of secretKinds) errors.push(`${stagedPath}: detected ${secretKind}`)
  }
}

function currentBranch(cwd) {
  return runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }).trim()
}

function checkMainBranch(cwd, errors) {
  if (currentBranch(cwd) === 'main') {
    errors.push(
      'direct commits to main are blocked; commit on a task branch and merge with --ff-only',
    )
  }
}

function checkIdentity(cwd, errors) {
  for (const key of ['user.name', 'user.email']) {
    const result = spawnSync('git', ['config', '--local', '--get', key], {
      cwd,
      encoding: 'utf8',
    })
    if (result.status !== 0 || !String(result.stdout || '').trim()) {
      errors.push(
        `local Git identity ${key} is required; configure it explicitly before committing`,
      )
    }
  }
}

function selfTest() {
  if (!isForbiddenDirectoryPath('feature/node_modules/pkg/index.js')) {
    throw new Error('nested generated directory rule is not active')
  }
  if (!isForbiddenDirectoryPath('native/build/Release/addon.node')) {
    throw new Error('native build rule is not active')
  }
  const privateKeyFixture = ['-----BEGIN OPENSSH', ' PRIVATE KEY-----'].join('')
  if (findSecretContent(privateKeyFixture).length !== 1) {
    throw new Error('secret content rule is not active')
  }
  console.log('[git-preflight] self-test passed')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const repoRoot = runGit(['rev-parse', '--show-toplevel']).trim()
  const allStaged = allStagedPaths(repoRoot)
  const staged = stagedPaths(repoRoot)
  if (allStaged.length === 0) throw new Error('no staged files')

  const errors = []
  checkMainBranch(repoRoot, errors)
  checkIdentity(repoRoot, errors)
  for (const stagedPath of staged) checkStagedPath(repoRoot, stagedPath, errors)

  const diffCheck = spawnSync('git', ['diff', '--cached', '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (diffCheck.status !== 0) {
    errors.push((diffCheck.stdout || diffCheck.stderr || 'git diff --cached --check failed').trim())
  }

  if (errors.length > 0) {
    console.error('[git-preflight] blocked:')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[git-preflight] passed: ${allStaged.length} staged file(s)`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[git-preflight] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  MAX_STAGED_FILE_BYTES,
  checkIdentity,
  checkMainBranch,
  findSecretContent,
  isForbiddenDirectoryPath,
  stagedBlobSize,
}
