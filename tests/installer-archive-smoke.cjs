const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { expectedInstallerName, packageProfileFromArgs } = require('../scripts/package-profile.cjs')

const root = path.resolve(__dirname, '..')
const packageJson = require('../package.json')
const profile = packageProfileFromArgs()
const installerPath = path.join(root, 'release', expectedInstallerName(packageJson, profile))
const artifactDir = path.join(root, 'artifacts', 'installer-archive-smoke')

function findSevenZip() {
  const explicit = process.env.SEVEN_ZIP_PATH?.trim()
  if (explicit && fs.existsSync(explicit)) return explicit

  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    '7zip@1.0.0',
  )
  const stack = fs.existsSync(cacheRoot) ? [cacheRoot] : []
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(entryPath)
      else if (entry.isFile() && entry.name.toLowerCase() === '7za.exe') return entryPath
    }
  }
  return null
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

if (!fs.existsSync(installerPath)) {
  console.error(`Installer not found: ${installerPath}`)
  process.exit(1)
}
const sevenZip = findSevenZip()
if (!sevenZip) {
  console.error('7za.exe not found. Build the NSIS installer first or set SEVEN_ZIP_PATH.')
  process.exit(1)
}

const startedAt = Date.now()
const result = spawnSync(sevenZip, ['t', installerPath], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  shell: false,
})
const output = `${result.stdout || ''}${result.stderr || ''}`
const fileCount = Number(output.match(/Files:\s+(\d+)/)?.[1] || 0)
const archiveOk = result.status === 0 && output.includes('Everything is Ok') && fileCount > 0
const stat = fs.statSync(installerPath)
const report = {
  ok: archiveOk,
  profile,
  installerPath,
  bytes: stat.size,
  mebibytes: Number((stat.size / 1024 / 1024).toFixed(2)),
  sha256: sha256(installerPath),
  archiveFileCount: fileCount,
  sevenZip,
  exitCode: result.status,
  elapsedMs: Date.now() - startedAt,
  note: output.includes('There are data after the end of archive')
    ? 'Expected NSIS executable tail detected.'
    : undefined,
}

fs.rmSync(artifactDir, { recursive: true, force: true })
fs.mkdirSync(artifactDir, { recursive: true })
fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
fs.writeFileSync(path.join(artifactDir, '7zip-output.txt'), output, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (!archiveOk) process.exitCode = 1
