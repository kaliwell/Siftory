// Records only the locally compiled Electron addon. External resource pins stay fixed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Record the Electron addon on the Windows x64 build host')
const manifestPath = path.join(root, 'resources/runtime-manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const component = manifest.components.find(
  (item) => item.id === 'floating-clock-fast-scanner-electron',
)
const artifact = component?.artifacts.find((item) => item.role === 'electron-native-addon')
if (
  artifact?.fetchPolicy !== 'local-build' ||
  artifact.targetPath !== 'native/build-electron/Release/fast_scanner.node'
)
  throw new Error('Unexpected native artifact inventory')
const bytes = fs.readFileSync(path.join(root, artifact.targetPath))
if (bytes.length < 1024 || bytes.toString('ascii', 0, 2) !== 'MZ')
  throw new Error('Invalid Windows addon')
const previousSha256 = artifact.sha256
artifact.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
artifact.sizeBytes = bytes.length
component.upstream.version = require('../package.json').version
component.upstream.releasedAt = new Date().toISOString().slice(0, 10)
const output = path.join(root, 'artifacts/online-installer')
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(
  path.join(output, 'native-build.json'),
  JSON.stringify(
    {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      electron: require('../package.json').devDependencies.electron,
      node: process.version,
      previousSha256,
      artifact,
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ nativeSha256: artifact.sha256, nativeBytes: artifact.sizeBytes }))
