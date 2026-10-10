const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  checkIdentity,
  checkMainBranch,
  findSecretContent,
  isForbiddenDirectoryPath,
  stagedBlobSize,
} = require('../scripts/git-preflight.cjs')
const { validate } = require('../scripts/validate-commit-message.cjs')
const { isInside } = require('../scripts/create-git-bundle.cjs')

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return (result.stdout || '').trim()
}

async function withTempRepo(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-git-policy-'))
  try {
    git(dir, ['init', '-b', 'main'])
    git(dir, ['config', 'user.name', 'Git Policy Test'])
    git(dir, ['config', 'user.email', 'git-policy@local.invalid'])
    await run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('preflight rejects generated directories at any nesting depth', () => {
  assert.equal(isForbiddenDirectoryPath('node_modules/pkg/index.js'), true)
  assert.equal(isForbiddenDirectoryPath('feature/node_modules/pkg/index.js'), true)
  assert.equal(isForbiddenDirectoryPath('nested/dist/output.js'), true)
  assert.equal(isForbiddenDirectoryPath('src/distribution/index.ts'), false)
})

test('preflight scans staged text for high-confidence secrets', () => {
  const privateKeyFixture = ['-----BEGIN OPENSSH', ' PRIVATE KEY-----'].join('')
  const awsKeyFixture = ['key=AK', 'IA1234567890ABCDEF'].join('')
  assert.deepEqual(findSecretContent('normal source text'), [])
  assert.deepEqual(findSecretContent(privateKeyFixture), ['private key'])
  assert.deepEqual(findSecretContent(awsKeyFixture), ['AWS access key'])
})

test('staged blob size is read from the index instead of the working tree', async () => {
  await withTempRepo(async (dir) => {
    const original = 'x'.repeat(4096)
    fs.writeFileSync(path.join(dir, 'sample.txt'), original)
    git(dir, ['add', 'sample.txt'])
    fs.writeFileSync(path.join(dir, 'sample.txt'), '')
    assert.equal(stagedBlobSize(dir, 'sample.txt'), Buffer.byteLength(original))
  })
})

test('preflight identity requires repository-local name and email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-git-identity-'))
  try {
    git(dir, ['init', '-b', 'task/test-identity'])
    const missingErrors = []
    checkIdentity(dir, missingErrors)
    assert.equal(missingErrors.length, 2)
    git(dir, ['config', 'user.name', 'Git Policy Test'])
    git(dir, ['config', 'user.email', 'git-policy@local.invalid'])
    const configuredErrors = []
    checkIdentity(dir, configuredErrors)
    assert.deepEqual(configuredErrors, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight accepts a deletion-only staged change', async () => {
  await withTempRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'obsolete.txt'), 'remove me\n')
    git(dir, ['add', 'obsolete.txt'])
    git(dir, ['commit', '-m', 'fixture'])
    git(dir, ['switch', '-c', 'fix/delete-obsolete'])
    fs.rmSync(path.join(dir, 'obsolete.txt'))
    git(dir, ['add', '--all', 'obsolete.txt'])
    const preflight = path.join(__dirname, '..', 'scripts', 'git-preflight.cjs')
    const result = spawnSync(process.execPath, [preflight], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

test('Markdown hard breaks pass preflight while source trailing whitespace stays rejected', async () => {
  await withTempRepo(async (dir) => {
    git(dir, ['switch', '-c', 'docs/hard-breaks'])
    fs.copyFileSync(path.join(__dirname, '..', '.gitattributes'), path.join(dir, '.gitattributes'))
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      '# Fixture\n\n> Status: current  \n> Updated: today\n',
    )
    git(dir, ['add', '--', '.gitattributes', 'README.md'])
    const preflight = path.join(__dirname, '..', 'scripts', 'git-preflight.cjs')
    const accepted = spawnSync(process.execPath, [preflight], { cwd: dir, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout)

    fs.writeFileSync(path.join(dir, 'source.ts'), 'export const value = 1  \n')
    git(dir, ['add', '--', 'source.ts'])
    const rejected = spawnSync(process.execPath, [preflight], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /source\.ts:1: trailing whitespace/)

    fs.writeFileSync(path.join(dir, 'source.ts'), 'export const value = 1\n')
    fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n\n\n')
    git(dir, ['add', '--', 'source.ts', 'README.md'])
    const blankEof = spawnSync(process.execPath, [preflight], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(blankEof.status, 0)
    assert.match(blankEof.stderr, /new blank line at EOF/)
  })
})

test('staged snapshot validation ignores unstaged working-tree changes', async () => {
  await withTempRepo(async (dir) => {
    const packagePath = path.join(dir, 'package.json')
    const validPackage = {
      name: 'staged-snapshot-fixture',
      version: '1.0.0',
      scripts: {
        'privacy:check': 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        'format:check': 'node -e "process.exit(0)"',
        verify: 'node -e "process.exit(0)"',
      },
    }
    fs.writeFileSync(packagePath, JSON.stringify(validPackage))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    git(dir, ['add', 'package.json'])

    const brokenWorkingTree = {
      ...validPackage,
      scripts: { ...validPackage.scripts, typecheck: 'node -e "process.exit(9)"' },
    }
    fs.writeFileSync(packagePath, JSON.stringify(brokenWorkingTree))
    const validator = path.join(__dirname, '..', 'scripts', 'validate-staged-snapshot.cjs')
    const result = spawnSync(process.execPath, [validator], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(
      fs.existsSync(path.join(dir, 'node_modules')),
      true,
      'dependency source must survive',
    )

    git(dir, ['commit', '-m', 'fixture'])
    const committedResult = spawnSync(process.execPath, [validator, '--commit', 'HEAD', '--full'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(committedResult.status, 0, committedResult.stderr || committedResult.stdout)
  })
})

test('direct commits to main are blocked before and after the initial commit', async () => {
  await withTempRepo(async (dir) => {
    const unbornErrors = []
    checkMainBranch(dir, unbornErrors)
    assert.equal(unbornErrors.length, 1)
    fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-m', 'baseline'])
    const errors = []
    checkMainBranch(dir, errors)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /direct commits to main are blocked/)
  })
})

test('push validation rejects invalid metadata anywhere in the new range', async () => {
  await withTempRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-m', 'invalid legacy message'])
    const head = git(dir, ['rev-parse', 'HEAD'])
    const validator = path.join(__dirname, '..', 'scripts', 'validate-push.cjs')
    const input = `refs/heads/task/test ${head} refs/heads/task/test ${'0'.repeat(40)}\n`
    const result = spawnSync(process.execPath, [validator], { cwd: dir, encoding: 'utf8', input })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /commit metadata blocked/)
  })
})

test('commit metadata rejects generated-message bypasses and duplicate ownership', () => {
  const valid = [
    'fix(repo): close commit policy bypasses',
    '',
    'Executor-System: Codex',
    'Executor-Model: GPT-5 series',
    'Task: git-policy',
    'Validation: node --test tests/git-policy.test.cjs; passed',
  ].join('\n')
  assert.deepEqual(validate(valid), [])
  assert.ok(validate('Merge bypass').length > 0)
  assert.ok(validate(`${valid}\nExecutor-System: Kimi`).some((error) => /exactly once/.test(error)))
  assert.ok(
    validate(valid.replace('Executor-System: Codex', 'Executor-System: Unknown')).some((error) =>
      /must be one of/.test(error),
    ),
  )
})

test('task worktree helper creates an isolated branch outside the repository', async () => {
  await withTempRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-m', 'baseline'])
    const destination = `${dir}-worktree`
    const helper = path.join(__dirname, '..', 'scripts', 'create-task-worktree.cjs')
    try {
      const result = spawnSync(process.execPath, [helper, 'task/test-isolation', destination], {
        cwd: dir,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.equal(git(destination, ['branch', '--show-current']), 'task/test-isolation')
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', destination], { cwd: dir })
      fs.rmSync(destination, { recursive: true, force: true })
    }
  })
})

test('backup helper creates and verifies a bundle outside the repository', async () => {
  await withTempRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-m', 'baseline'])
    const destination = `${dir}-backup`
    const helper = path.join(__dirname, '..', 'scripts', 'create-git-bundle.cjs')
    try {
      const result = spawnSync(process.execPath, [helper, destination], {
        cwd: dir,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      const bundles = fs.readdirSync(destination).filter((entry) => entry.endsWith('.bundle'))
      assert.equal(bundles.length, 1)
      git(dir, ['bundle', 'verify', path.join(destination, bundles[0])])
    } finally {
      fs.rmSync(destination, { recursive: true, force: true })
    }
  })
})

test('backup containment accepts a destination on another Windows drive', () => {
  assert.equal(isInside('C:\\repo', 'C:\\repo\\backup', path.win32), true)
  assert.equal(isInside('C:\\repo', 'C:\\repo-copy\\backup', path.win32), false)
  assert.equal(isInside('C:\\repo', 'D:\\ReasonixGitBackups', path.win32), false)
})
