const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  commitPreparedPath,
  createPreparedSiblingPath,
  discardPreparedPath,
  recoverPreparedPathTransactions,
} = loadTsModule('electron/localFileTransaction.ts')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-fm-transaction-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('commitPreparedPath replaces an existing file and removes transaction artifacts', async () => {
  await withTempDir(async (dir) => {
    const finalPath = path.join(dir, 'asset.txt')
    const preparedPath = createPreparedSiblingPath(finalPath)
    await fs.writeFile(finalPath, 'old', 'utf8')
    await fs.writeFile(preparedPath, 'new', 'utf8')

    await commitPreparedPath(preparedPath, finalPath)

    assert.equal(await fs.readFile(finalPath, 'utf8'), 'new')
    const names = await fs.readdir(dir)
    assert.deepEqual(names, ['asset.txt'])
  })
})

test('commitPreparedPath restores the old target when commit fails', async () => {
  await withTempDir(async (dir) => {
    const finalPath = path.join(dir, 'asset.txt')
    const missingPreparedPath = createPreparedSiblingPath(finalPath)
    await fs.writeFile(finalPath, 'old', 'utf8')

    await assert.rejects(commitPreparedPath(missingPreparedPath, finalPath))

    assert.equal(await fs.readFile(finalPath, 'utf8'), 'old')
    const names = await fs.readdir(dir)
    assert.deepEqual(names, ['asset.txt'])
  })
})

test('commitPreparedPath supports directory replacement and discard is idempotent', async () => {
  await withTempDir(async (dir) => {
    const finalPath = path.join(dir, 'folder')
    const preparedPath = createPreparedSiblingPath(finalPath)
    await fs.mkdir(finalPath)
    await fs.writeFile(path.join(finalPath, 'old.txt'), 'old', 'utf8')
    await fs.mkdir(preparedPath)
    await fs.writeFile(path.join(preparedPath, 'new.txt'), 'new', 'utf8')

    await commitPreparedPath(preparedPath, finalPath)
    assert.equal(await fs.readFile(path.join(finalPath, 'new.txt'), 'utf8'), 'new')
    await assert.rejects(fs.access(path.join(finalPath, 'old.txt')))

    await discardPreparedPath(preparedPath)
    await discardPreparedPath(preparedPath)
  })
})

test('prepared-path recovery rejects a journal that escapes its directory', async () => {
  await withTempDir(async (dir) => {
    const journalPath = path.join(dir, '.asset.txt.floatingclock-test.transaction.json')
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        version: 1,
        final: '../outside.txt',
        prepared: '.asset.txt.floatingclock-test.part',
        backup: '.asset.txt.floatingclock-test.bak',
        hadTarget: true,
      }),
      'utf8',
    )
    assert.throws(() => recoverPreparedPathTransactions(dir), /Invalid prepared-path transaction/)
  })
})
