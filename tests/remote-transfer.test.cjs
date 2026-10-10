const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  MAX_TRANSFER_HISTORY,
  RemoteTransferHistory,
  cancelTransfer,
  clearTransferHistory,
  createTransferTask,
  enqueueDownload,
  getTransferRetentionStatsForTests,
  listTransfers,
  replaceLocalFile,
  resetTransferRetentionForTests,
} = loadTsModule('electron/remoteTransferService.ts')
const { TransferSelectionTokens } = loadTsModule('electron/remoteTerminalTransferIpc.ts')

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`)
}

test('transfer tasks start queued without exposing credentials', () => {
  const task = createTransferTask('profile-1', 'upload', 'demo.txt', '/tmp/demo.txt', 123)
  assert.equal(task.state, 'queued')
  assert.equal(task.totalBytes, 123)
  assert.equal(task.transferredBytes, 0)
  assert.equal('password' in task, false)
  assert.equal('localPath' in task, false)
})

test('downloads reject silent overwrite before entering the queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-transfer-'))
  try {
    fs.writeFileSync(path.join(root, 'demo.txt'), 'existing')
    await assert.rejects(
      enqueueDownload(
        {
          id: 'profile-1',
          name: 'Test',
          host: 'example.test',
          port: 22,
          username: 'root',
          authType: 'password',
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        },
        '/tmp/demo.txt',
        root,
        10,
        {},
      ),
      /already exists/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling an unknown transfer is explicit', () => {
  assert.deepEqual(cancelTransfer('missing'), { ok: false, error: 'Transfer not found' })
})

test('terminal transfer history is bounded without evicting active tasks', () => {
  assert.equal(MAX_TRANSFER_HISTORY, 200)
  const history = new RemoteTransferHistory(3)
  for (let index = 0; index < 5; index += 1) {
    const task = createTransferTask('profile-1', 'download', `${index}.txt`, `${index}.txt`, 1)
    task.id = `completed-${index}`
    task.state = 'completed'
    task.createdAt = index
    task.finishedAt = index
    history.remember(task)
  }
  const active = createTransferTask('profile-1', 'download', 'active.txt', 'active.txt', 1)
  active.id = 'active'
  active.createdAt = 10
  history.remember(active)

  assert.deepEqual(
    history.list().map((task) => task.id),
    ['active', 'completed-4', 'completed-3', 'completed-2'],
  )
  assert.equal(history.get('completed-0'), undefined)
  assert.equal(history.get('completed-1'), undefined)
  assert.deepEqual(history.clearTerminal().sort(), [
    'completed-2',
    'completed-3',
    'completed-4',
  ])
  assert.deepEqual(history.list().map((task) => task.id), ['active'])
})

test('selection tokens prune expired and oldest entries and clear renderer ownership', () => {
  let now = 1000
  const tokens = new TransferSelectionTokens(() => now, 100, 3)
  const oldest = tokens.issue('upload-file', 'C:\\oldest.txt', 1)
  const second = tokens.issue('download-directory', 'C:\\second', 2)
  tokens.issue('upload-file', 'C:\\third.txt', 1)
  tokens.issue('upload-file', 'C:\\fourth.txt', 1)

  assert.equal(tokens.size, 3)
  assert.equal(tokens.consume(oldest, 'upload-file', 1), null)
  assert.equal(tokens.consume(second, 'download-directory', 2), 'C:\\second')
  tokens.clearSender(1)
  assert.equal(tokens.size, 0)

  const expired = tokens.issue('upload-file', 'C:\\expired.txt', 3)
  now += 101
  const fresh = tokens.issue('upload-file', 'C:\\fresh.txt', 3)
  assert.equal(tokens.size, 1)
  assert.equal(tokens.consume(expired, 'upload-file', 3), null)
  now += 100
  assert.equal(tokens.consume(fresh, 'upload-file', 3), null, 'expiry boundary is exclusive')
  assert.equal(tokens.size, 0)

  const ipcSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'remoteTerminalTransferIpc.ts'),
    'utf8',
  )
  assert.match(ipcSource, /trackTransferSelectionSender\(event\.sender\)/)
  assert.match(ipcSource, /sender\.once\('destroyed'/)
  assert.match(ipcSource, /transferSelectionTokens\.clearSender\(sender\.id\)/)
})

test('failed transfer releases its internal job and credential-bearing context', async () => {
  resetTransferRetentionForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-transfer-retention-'))
  try {
    const task = await enqueueDownload(
      {
        id: 'retention-profile',
        name: 'Retention test',
        host: '127.0.0.1',
        port: 1,
        username: 'test',
        authType: 'password',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
      '/tmp/retention.txt',
      root,
      10,
      { password: 'sensitive-test-password' },
    )

    await waitFor(() => listTransfers().some((candidate) => candidate.id === task.id && candidate.state === 'failed'))
    assert.deepEqual(getTransferRetentionStatsForTests(), {
      historyTasks: 1,
      retainedJobs: 0,
      running: 0,
    })
    assert.deepEqual(cancelTransfer(task.id), {
      ok: false,
      error: 'Transfer already finished',
    })
    clearTransferHistory()
    assert.equal(getTransferRetentionStatsForTests().historyTasks, 0)
  } finally {
    resetTransferRetentionForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local overwrite commits the part file and removes its backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-replace-'))
  const finalPath = path.join(root, 'demo.txt')
  const partPath = path.join(root, 'demo.part')
  try {
    fs.writeFileSync(finalPath, 'old')
    fs.writeFileSync(partPath, 'new')
    await replaceLocalFile(partPath, finalPath, 'test-task')
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'new')
    assert.equal(fs.existsSync(`${finalPath}.floatingclock-test-task.bak`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('application shutdown disposes transfer jobs and credential-bearing fields', () => {
  const root = path.resolve(__dirname, '..')
  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8')
  const transferSource = fs.readFileSync(
    path.join(root, 'electron', 'remoteTransferService.ts'),
    'utf8',
  )
  assert.match(mainSource, /disposeRemoteTransfers\(\)/)
  assert.match(transferSource, /delete job\.password/)
  assert.match(transferSource, /delete job\.passphrase/)
  assert.match(transferSource, /jobs\.delete\(job\.task\.id\)/)
})
