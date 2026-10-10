const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { prepareSnapshotTools } = require('../scripts/prepare-snapshot-tools.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-snapshot-tools-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const snapshot = path.join(root, 'snapshot')
  fs.mkdirSync(path.join(repo, 'tools/ffmpeg/bin'), { recursive: true })
  fs.mkdirSync(path.join(snapshot, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(snapshot, 'THIRD_PARTY_NOTICES.md'), 'Fixture notice\n')
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../resources/runtime-manifest.json'), 'utf8'),
  )
  const component = manifest.components.find((item) =>
    item.artifacts.some((artifact) => artifact.targetPath === 'tools/ffmpeg/bin/ffmpeg.exe'),
  )
  manifest.components = [component]
  for (const artifact of component.artifacts) {
    const content = Buffer.from(`verified fixture ${artifact.role}`)
    artifact.sha256 = crypto.createHash('sha256').update(content).digest('hex')
    artifact.sizeBytes = content.length
    fs.writeFileSync(path.join(repo, artifact.targetPath), content)
  }
  const manifestPath = path.join(snapshot, 'resources/runtime-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  return { repo, snapshot, manifest, manifestPath }
}

test('snapshot tools are copied only after manifest verification and retain exact bytes', async (t) => {
  const { repo, snapshot } = fixture(t)
  assert.equal(await prepareSnapshotTools(repo, snapshot), 2)
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    assert.deepEqual(
      fs.readFileSync(path.join(snapshot, 'tools/ffmpeg/bin', name)),
      fs.readFileSync(path.join(repo, 'tools/ffmpeg/bin', name)),
    )
  }
})

test('tampered local tools stop snapshot preparation before copying', async (t) => {
  const { repo, snapshot } = fixture(t)
  fs.appendFileSync(path.join(repo, 'tools/ffmpeg/bin/ffmpeg.exe'), 'tampered')
  await assert.rejects(prepareSnapshotTools(repo, snapshot), /Prepare the pinned local FFmpeg/)
  assert.equal(fs.existsSync(path.join(snapshot, 'tools/ffmpeg/bin/ffmpeg.exe')), false)
})

test('manifest cannot use an extra artifact to copy arbitrary local files into a snapshot', async (t) => {
  const { repo, snapshot, manifest, manifestPath } = fixture(t)
  manifest.components[0].artifacts.push({ targetPath: '../private.txt' })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  await assert.rejects(prepareSnapshotTools(repo, snapshot), /exactly the two/)
})
