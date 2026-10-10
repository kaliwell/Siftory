const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  hardenDataDirectoryPermissions,
  probeDataDirectorySecurity,
  dataDirectorySecurityInternals,
} = loadTsModule('electron/dataDirectorySecurity.ts')

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `siftory-data-security-${label}-`))
}

test('Windows security tools resolve to System32 rather than a PATH shadow', () => {
  const resolve = dataDirectorySecurityInternals.windowsSystemExecutable
  assert.equal(resolve('whoami.exe', 'C:\\Windows'), 'C:\\Windows\\System32\\whoami.exe')
  assert.equal(
    resolve('powershell.exe', 'C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.throws(() => resolve('whoami.exe', 'relative'), /system directory/)
  assert.throws(() => resolve('untrusted.exe', 'C:\\Windows'), /Unsupported/)
})

test('data directory hardening is opt-in for packaged startup', async () => {
  let calls = 0
  const result = await hardenDataDirectoryPermissions(path.join(os.tmpdir(), 'not-created'), {
    enabled: false,
    platform: 'win32',
    runCommand: async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(result, { applied: false, platform: 'win32', reason: 'disabled' })
  assert.equal(calls, 0)
})

test('Windows ACL hardening grants only the current user and operating-system administrators', async () => {
  const root = temporaryDirectory('windows')
  const calls = []
  try {
    const result = await hardenDataDirectoryPermissions(root, {
      enabled: true,
      platform: 'win32',
      runCommand: async (executable, args) => {
        calls.push({ executable, args })
        if (executable === 'whoami.exe') {
          return {
            stdout: '"WORKSTATION\\user","S-1-5-21-111111111-222222222-333333333-1001"\r\n',
            stderr: '',
          }
        }
        return { stdout: 'verified\r\n', stderr: '' }
      },
    })
    assert.equal(result.applied, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].executable, 'powershell.exe')
    assert.ok(calls[1].args.includes('-NoProfile'))
    assert.ok(calls[1].args.includes('-NonInteractive'))
    const script = calls[1].args.join(' ')
    // powershell.exe -Command ignores trailing argv for $args, so the target and
    // SID must be inlined into the script text itself.
    assert.ok(script.includes(path.resolve(root)))
    assert.ok(script.includes('S-1-5-21-111111111-222222222-333333333-1001'))
    assert.doesNotMatch(script, /\$args/, 'inlined literals replace the broken $args passing')
    assert.match(script, /SetAccessRuleProtection/)
    assert.match(script, /ACL verification failed/)
    assert.equal(
      calls[1].args.includes('/T'),
      false,
      'startup hardening must not traverse the 15GB store',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows ACL hardening fails before changing permissions when the current SID is unavailable', async () => {
  const root = temporaryDirectory('sid')
  const calls = []
  try {
    const result = await hardenDataDirectoryPermissions(root, {
      enabled: true,
      platform: 'win32',
      runCommand: async (executable, args) => {
        calls.push({ executable, args })
        return { stdout: 'unexpected output', stderr: '' }
      },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'failed')
    assert.equal(calls.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows ACL hardening rejects a command that does not prove the final ACL', async () => {
  const root = temporaryDirectory('verification')
  try {
    const result = await hardenDataDirectoryPermissions(root, {
      enabled: true,
      platform: 'win32',
      runCommand: async (executable) =>
        executable === 'whoami.exe'
          ? {
              stdout: '"WORKSTATION\\user","S-1-5-21-111111111-222222222-333333333-1001"\r\n',
              stderr: '',
            }
          : { stdout: 'permission command returned without verification', stderr: '' },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'failed')
    assert.match(result.error, /verification did not complete/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('filesystem roots are never accepted as an application data target', async () => {
  const filesystemRoot = path.parse(process.cwd()).root
  const result = await hardenDataDirectoryPermissions(filesystemRoot, {
    enabled: true,
    platform: 'win32',
    runCommand: async () => {
      throw new Error('must not execute')
    },
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'failed')
})

test('SID parser rejects built-in and malformed identities', () => {
  assert.equal(
    dataDirectorySecurityInternals.extractWindowsUserSid('"HOST\\user","S-1-5-21-1-2-3-1001"'),
    'S-1-5-21-1-2-3-1001',
  )
  assert.throws(
    () => dataDirectorySecurityInternals.extractWindowsUserSid('S-1-5-32-544'),
    /current Windows user SID/,
  )
})

test(
  'Windows ACL command succeeds against an isolated temporary directory',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = temporaryDirectory('windows-integration')
    try {
      const result = await hardenDataDirectoryPermissions(root, {
        enabled: true,
        platform: 'win32',
      })
      assert.deepEqual(result, { applied: true, platform: 'win32' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test('data directory probe is a read-only check gated like hardening', async () => {
  let calls = 0
  const result = await probeDataDirectorySecurity(path.join(os.tmpdir(), 'not-created'), {
    enabled: false,
    platform: 'win32',
    runCommand: async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(result, { applied: false, platform: 'win32', reason: 'disabled' })
  assert.equal(calls, 0, 'a disabled probe must not spawn platform commands')
})

test('Windows ACL probe accepts only the hardened three-rule state', async () => {
  const root = temporaryDirectory('probe-compliant')
  const calls = []
  try {
    const result = await probeDataDirectorySecurity(root, {
      enabled: true,
      platform: 'win32',
      runCommand: async (executable, args) => {
        calls.push({ executable, args })
        if (executable === 'whoami.exe') {
          return {
            stdout: '"WORKSTATION\\user","S-1-5-21-111111111-222222222-333333333-1001"\r\n',
            stderr: '',
          }
        }
        return { stdout: 'compliant\r\n', stderr: '' }
      },
    })
    assert.deepEqual(result, { applied: true, platform: 'win32' })
    assert.equal(calls.length, 2)
    const script = calls[1].args.join(' ')
    assert.doesNotMatch(
      script,
      /Set-Acl|RemoveAccessRule|AddAccessRule/,
      'probe must not modify ACLs',
    )
    assert.match(script, /AreAccessRulesProtected/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows ACL probe reports drift as a failed, repairable state', async () => {
  const root = temporaryDirectory('probe-drifted')
  try {
    const result = await probeDataDirectorySecurity(root, {
      enabled: true,
      platform: 'win32',
      runCommand: async (executable) =>
        executable === 'whoami.exe'
          ? {
              stdout: '"WORKSTATION\\user","S-1-5-21-111111111-222222222-333333333-1001"\r\n',
              stderr: '',
            }
          : { stdout: 'drifted\r\n', stderr: '' },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'failed')
    assert.match(result.error, /drifted/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test(
  'POSIX probe verifies 0700 root and 0600 sensitive files without changing them',
  { skip: process.platform === 'win32' },
  async () => {
    const root = temporaryDirectory('probe-posix')
    try {
      fs.chmodSync(root, 0o700)
      const credential = path.join(root, 'remote-terminal-credentials.json')
      fs.writeFileSync(credential, '{}', { mode: 0o600 })
      assert.deepEqual(
        await probeDataDirectorySecurity(root, { enabled: true, platform: 'linux' }),
        {
          applied: true,
          platform: 'linux',
        },
      )

      fs.chmodSync(credential, 0o644)
      const drifted = await probeDataDirectorySecurity(root, { enabled: true, platform: 'linux' })
      assert.equal(drifted.applied, false)
      assert.equal(drifted.reason, 'failed')
      assert.equal(fs.statSync(credential).mode & 0o777, 0o644, 'probe must not repair by itself')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows ACL probe confirms a freshly hardened isolated directory',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = temporaryDirectory('probe-integration')
    try {
      await hardenDataDirectoryPermissions(root, { enabled: true, platform: 'win32' })
      const result = await probeDataDirectorySecurity(root, { enabled: true, platform: 'win32' })
      assert.deepEqual(result, { applied: true, platform: 'win32' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)
