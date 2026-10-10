const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { cleanReleaseArtifacts } = require('../scripts/clean-release.cjs')

test('cleanReleaseArtifacts keeps only the explicitly selected offline installer', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'floating-clock-release-clean-'))
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.2.3',
        build: { productName: 'Siftory', directories: { output: 'release' } },
      }),
    )
    const releaseDir = path.join(dir, 'release')
    await fsp.mkdir(path.join(releaseDir, 'win-unpacked'), { recursive: true })
    await fsp.writeFile(path.join(releaseDir, 'builder.yml'), 'temp')
    await fsp.writeFile(path.join(releaseDir, 'old.exe'), 'old')
    await fsp.writeFile(path.join(releaseDir, 'Siftory Setup 1.2.3.exe'), 'installer')

    const result = cleanReleaseArtifacts(dir, 'offline')
    assert.deepEqual(result.kept, ['Siftory Setup 1.2.3.exe'])
    assert.deepEqual(fs.readdirSync(releaseDir), ['Siftory Setup 1.2.3.exe'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('cleanReleaseArtifacts fails when the expected installer is absent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'floating-clock-release-clean-'))
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        build: { productName: 'Siftory', directories: { output: 'release' } },
      }),
    )
    const releaseDir = path.join(dir, 'release')
    await fsp.mkdir(releaseDir)
    await fsp.writeFile(path.join(releaseDir, 'builder-debug.yml'), 'keep for diagnosis')
    await assert.rejects(
      async () => cleanReleaseArtifacts(dir),
      /Expected installer was not produced/,
    )
    assert.deepEqual(await fsp.readdir(releaseDir), ['builder-debug.yml'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('cleanReleaseArtifacts defaults to keeping the online installer', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'floating-clock-release-clean-'))
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.2.3',
        build: { productName: 'Siftory', directories: { output: 'release' } },
      }),
    )
    const releaseDir = path.join(dir, 'release')
    await fsp.mkdir(releaseDir)
    await fsp.writeFile(path.join(releaseDir, 'Siftory Setup 1.2.3.exe'), 'offline')
    await fsp.writeFile(path.join(releaseDir, 'Siftory Online Setup 1.2.3.exe'), 'online')

    const result = cleanReleaseArtifacts(dir)
    assert.deepEqual(result.kept, ['Siftory Online Setup 1.2.3.exe'])
    assert.deepEqual(await fsp.readdir(releaseDir), ['Siftory Online Setup 1.2.3.exe'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
