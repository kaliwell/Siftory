const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const terminal = loadTsModule('electron/remoteTerminalService.ts')
const sftp = loadTsModule('electron/remoteSftpService.ts')
const transfer = loadTsModule('electron/remoteTransferService.ts')

function measure(label, operation) {
  const heapBefore = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  const result = operation()
  const durationMs = performance.now() - startedAt
  const heapDelta = process.memoryUsage().heapUsed - heapBefore
  process.stdout.write(
    `[stress] ${label}: ${durationMs.toFixed(1)} ms, heap delta ${(heapDelta / 1024 / 1024).toFixed(2)} MiB\n`,
  )
  return { result, durationMs, heapDelta }
}

test('stress: 25k SSH host fingerprint verifications', () => {
  const hex = 'ab'.repeat(32)
  const expected = terminal.formatHostFingerprint(hex)
  const { durationMs, heapDelta } = measure('25k fingerprints', () => {
    for (let i = 0; i < 25_000; i++) {
      assert.equal(terminal.verifyHostFingerprint(expected, hex).accepted, true)
    }
  })
  assert.ok(durationMs < 5_000, `fingerprint verification took ${durationMs} ms`)
  assert.ok(heapDelta < 64 * 1024 * 1024, `fingerprint heap grew by ${heapDelta} bytes`)
})

test('stress: 100k remote path normalizations', () => {
  const { durationMs, heapDelta } = measure('100k paths', () => {
    for (let i = 0; i < 100_000; i++) {
      assert.equal(
        sftp.normalizeRemotePath(`/srv/app-${i % 100}/logs/../data`),
        `/srv/app-${i % 100}/data`,
      )
    }
  })
  assert.ok(durationMs < 5_000, `path normalization took ${durationMs} ms`)
  assert.ok(heapDelta < 64 * 1024 * 1024, `path heap grew by ${heapDelta} bytes`)
})

test('stress: 200 concurrent profile saves remain complete and parseable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-profile-stress-'))
  try {
    await terminal.loadProfiles(root)
    const startedAt = performance.now()
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        terminal.saveProfile(root, {
          id: `stress-${index}`,
          name: `Stress Server ${index}`,
          host: `host-${index}.example.test`,
          port: 22,
          username: 'stress',
          authType: 'password',
          tags: ['stress'],
          createdAt: 1,
          updatedAt: 1,
        }),
      ),
    )
    const durationMs = performance.now() - startedAt
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, 'remote-terminal-profiles.json'), 'utf8'),
    )
    process.stdout.write(`[stress] 200 concurrent profile saves: ${durationMs.toFixed(1)} ms\n`)
    assert.equal(
      results.every((result) => result.ok),
      true,
    )
    assert.equal(terminal.listProfiles().length, 200)
    assert.equal(saved.length, 200)
    assert.ok(durationMs < 10_000, `profile saves took ${durationMs} ms`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stress: 200 concurrent local atomic replacements preserve contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-transfer-stress-'))
  try {
    const jobs = Array.from({ length: 200 }, (_, index) => {
      const finalPath = path.join(root, `file-${index}.txt`)
      const partPath = path.join(root, `file-${index}.part`)
      fs.writeFileSync(finalPath, `old-${index}`)
      fs.writeFileSync(partPath, `new-${index}`)
      return { finalPath, partPath, index }
    })
    const startedAt = performance.now()
    await Promise.all(
      jobs.map((job) =>
        transfer.replaceLocalFile(job.partPath, job.finalPath, `stress-${job.index}`),
      ),
    )
    const durationMs = performance.now() - startedAt
    process.stdout.write(
      `[stress] 200 concurrent atomic replacements: ${durationMs.toFixed(1)} ms\n`,
    )
    for (const job of jobs) {
      assert.equal(fs.readFileSync(job.finalPath, 'utf8'), `new-${job.index}`)
      assert.equal(fs.existsSync(`${job.finalPath}.floatingclock-stress-${job.index}.bak`), false)
    }
    assert.ok(durationMs < 10_000, `atomic replacements took ${durationMs} ms`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stress: 50 refused SSH connections settle and release sessions', async () => {
  const profile = {
    id: 'refused-stress',
    name: 'Refused Stress',
    host: '127.0.0.1',
    port: 1,
    username: 'stress',
    authType: 'password',
    tags: ['stress'],
    createdAt: 1,
    updatedAt: 1,
  }
  const startedAt = performance.now()
  const statuses = await Promise.all(
    Array.from({ length: 50 }, () =>
      terminal.connect(profile, {
        profileId: profile.id,
        password: 'not-used',
        cols: 80,
        rows: 24,
      }),
    ),
  )
  const durationMs = performance.now() - startedAt
  process.stdout.write(`[stress] 50 refused SSH connections: ${durationMs.toFixed(1)} ms\n`)
  assert.equal(
    statuses.every((status) => status.state === 'error'),
    true,
  )
  assert.equal(
    statuses.every((status) => terminal.getSessionStatus(status.sessionId) === null),
    true,
  )
  assert.ok(durationMs < 10_000, `refused connections took ${durationMs} ms`)
})
