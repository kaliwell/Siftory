const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const service = loadTsModule('electron/remoteTerminalService.ts')

test('Remote Terminal formats and verifies SHA-256 host fingerprints', () => {
  const hex = '00'.repeat(32)
  const fingerprint = service.formatHostFingerprint(hex)
  assert.match(fingerprint, /^SHA256:/)
  assert.deepEqual(service.verifyHostFingerprint(undefined, hex), {
    accepted: false,
    fingerprint,
    mismatch: false,
  })
  assert.equal(service.verifyHostFingerprint(fingerprint, hex).accepted, true)
  assert.equal(service.verifyHostFingerprint(`SHA256:${'x'.repeat(43)}`, hex).mismatch, true)
  assert.equal(service.formatHostFingerprint('invalid'), '')
})

test('Remote Terminal persists pinned fingerprints but strips secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-remote-'))
  const fingerprint = `SHA256:${'A'.repeat(43)}`
  try {
    await service.loadProfiles(root)
    const profile = {
      id: 'server-1',
      name: 'Server 1',
      host: 'example.test',
      port: 22,
      username: 'root',
      authType: 'password',
      tags: [],
      hostFingerprint: fingerprint,
      password: 'must-not-persist',
      passphrase: 'must-not-persist',
      createdAt: 1,
      updatedAt: 1,
    }
    assert.deepEqual(await service.saveProfile(root, profile), { ok: true })
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, 'remote-terminal-profiles.json'), 'utf8'),
    )[0]
    assert.equal(saved.hostFingerprint, profile.hostFingerprint)
    assert.equal('password' in saved, false)
    assert.equal('passphrase' in saved, false)
    assert.equal(saved.credentialMode, 'none')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Remote Terminal rejects invalid profile fields before persistence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-remote-invalid-'))
  try {
    await service.loadProfiles(root)
    const base = {
      id: 'server-2',
      name: 'Server 2',
      host: 'example.test',
      port: 22,
      username: 'root',
      authType: 'password',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }
    assert.equal((await service.saveProfile(root, { ...base, port: 0 })).ok, false)
    assert.equal((await service.saveProfile(root, { ...base, host: 'https://example.test' })).ok, false)
    assert.equal((await service.saveProfile(root, { ...base, id: '../server' })).ok, false)
    assert.equal(
      (await service.saveProfile(root, { ...base, hostFingerprint: 'SHA256:not-valid' })).ok,
      false,
    )
    assert.deepEqual(service.listProfiles(), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Remote Terminal normalizes private key profiles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-remote-key-'))
  try {
    await service.loadProfiles(root)
    const result = await service.saveProfile(root, {
      id: 'server-3',
      name: ' Server 3 ',
      host: 'example.test',
      port: 2222,
      username: ' user ',
      authType: 'privateKey',
      privateKeyPath: 'C:\\keys\\..\\keys\\id_rsa',
      tags: ['prod', 'prod', ''],
      credentialMode: 'os',
      createdAt: 1,
      updatedAt: 1,
    })
    assert.deepEqual(result, { ok: true })
    const [saved] = service.listProfiles()
    assert.equal(saved.name, 'Server 3')
    assert.equal(saved.username, 'user')
    assert.deepEqual(saved.tags, ['prod'])
    assert.equal(saved.credentialMode, 'os')
    assert.ok(saved.privateKeyPath.endsWith('keys\\id_rsa'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
