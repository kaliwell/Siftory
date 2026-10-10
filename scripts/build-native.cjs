const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const nativeDir = path.join(projectRoot, 'native')
const nodeGyp = path.join(projectRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const mode = process.argv[2] || 'node'
const packageJson = require(path.join(projectRoot, 'package.json'))
const electronVersion = packageJson.devDependencies.electron.replace(/^[^\d]*/, '')

const buildReleaseDir = path.join(nativeDir, 'build', 'Release')
const buildArtifact = path.join(buildReleaseDir, 'fast_scanner.node')
const nodeReleaseDir = path.join(nativeDir, 'build-node', 'Release')
const electronReleaseDir = path.join(nativeDir, 'build-electron', 'Release')

function run(args) {
  const result = spawnSync(process.execPath, [nodeGyp, ...args], {
    cwd: nativeDir,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function copyArtifact(targetDir) {
  if (!fs.existsSync(buildArtifact)) {
    console.error(`Missing native build artifact: ${buildArtifact}`)
    process.exit(1)
  }
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(buildArtifact, path.join(targetDir, 'fast_scanner.node'))
}

function restoreNodeArtifact() {
  const nodeArtifact = path.join(nodeReleaseDir, 'fast_scanner.node')
  if (fs.existsSync(nodeArtifact)) {
    fs.mkdirSync(buildReleaseDir, { recursive: true })
    fs.copyFileSync(nodeArtifact, buildArtifact)
  }
}

if (mode === 'node') {
  run(['rebuild'])
  copyArtifact(nodeReleaseDir)
} else if (mode === 'electron') {
  run([
    'rebuild',
    `--target=${electronVersion}`,
    '--arch=x64',
    '--dist-url=https://electronjs.org/headers',
  ])
  copyArtifact(electronReleaseDir)
  restoreNodeArtifact()
} else {
  console.error('Usage: node scripts/build-native.cjs <node|electron>')
  process.exit(1)
}
