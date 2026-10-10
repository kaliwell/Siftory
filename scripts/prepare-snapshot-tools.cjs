const fs = require('node:fs')
const path = require('node:path')
const { parseArgs, runResourceFetch, verifyFile } = require('./fetch-runtime-resources.cjs')

const REQUIRED_TARGETS = ['tools/ffmpeg/bin/ffmpeg.exe', 'tools/ffmpeg/bin/ffprobe.exe']

async function prepareSnapshotTools(repoRoot, snapshotRoot) {
  const manifestPath = path.join(snapshotRoot, 'resources', 'runtime-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const component = manifest.components.find((item) =>
    item.artifacts?.some((artifact) => artifact.targetPath === REQUIRED_TARGETS[0]),
  )
  if (
    !component ||
    component.artifacts.length !== REQUIRED_TARGETS.length ||
    !REQUIRED_TARGETS.every((target) =>
      component.artifacts.some((artifact) => artifact.targetPath === target),
    )
  ) {
    throw new Error('Snapshot FFmpeg manifest must contain exactly the two verification tools')
  }
  const options = (targetDir) =>
    parseArgs([
      '--verify-only',
      `--manifest=${manifestPath}`,
      `--component=${component.id}`,
      `--target-dir=${targetDir}`,
    ])
  const sourceVerification = await runResourceFetch(options(repoRoot))
  if (!sourceVerification.ok) {
    throw new Error(
      `Prepare the pinned local FFmpeg tools before pushing: ${sourceVerification.errors.join('; ')}`,
    )
  }
  for (const target of REQUIRED_TARGETS) {
    const destination = path.join(snapshotRoot, ...target.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, ...target.split('/')), destination)
  }
  const snapshotVerification = await runResourceFetch(options(snapshotRoot))
  if (!snapshotVerification.ok) {
    throw new Error(
      `Snapshot FFmpeg verification failed: ${snapshotVerification.errors.join('; ')}`,
    )
  }
  return snapshotVerification.verified
}

async function prepareSnapshotCoveredSource(repoRoot, snapshotRoot) {
  const relative = 'legal/covered-source/canvas-rust-sources.zip'
  const manifest = JSON.parse(
    fs.readFileSync(path.join(snapshotRoot, 'legal/covered-source/manifest.json'), 'utf8'),
  )
  const declaration = manifest.files.find((entry) => entry.path === 'canvas-rust-sources.zip')
  if (!declaration) throw new Error('Covered-source verification archive is not declared')
  const artifact = { sizeBytes: declaration.bytes, sha256: declaration.sha256 }
  const source = path.join(repoRoot, relative)
  const sourceCheck = await verifyFile(source, artifact)
  if (!sourceCheck.ok) {
    throw new Error(
      `Prepare the pinned local covered-source archive before pushing: ${sourceCheck.reason}`,
    )
  }
  const destination = path.join(snapshotRoot, relative)
  fs.copyFileSync(source, destination)
  const destinationCheck = await verifyFile(destination, artifact)
  if (!destinationCheck.ok) throw new Error('Copied covered-source archive does not match manifest')
}

module.exports = { prepareSnapshotTools, prepareSnapshotCoveredSource }
