const fs = require('node:fs')
const path = require('node:path')
const { expectedInstallerName, packageProfileFromArgs } = require('./package-profile.cjs')

function cleanReleaseArtifacts(projectDir = process.cwd(), profile) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const releaseDir = path.resolve(projectDir, packageJson.build?.directories?.output || 'release')
  const expectedInstaller = expectedInstallerName(packageJson, profile)

  if (!fs.existsSync(releaseDir)) return { removed: [], kept: [] }
  const projectRoot = `${path.resolve(projectDir)}${path.sep}`
  if (!`${releaseDir}${path.sep}`.startsWith(projectRoot)) {
    throw new Error(`Refusing to clean release directory outside the project: ${releaseDir}`)
  }

  const entries = fs.readdirSync(releaseDir, { withFileTypes: true })
  if (!entries.some((entry) => entry.isFile() && entry.name === expectedInstaller)) {
    throw new Error(`Expected installer was not produced: ${expectedInstaller}`)
  }

  const removed = []
  const kept = []
  for (const entry of entries) {
    const entryPath = path.join(releaseDir, entry.name)
    if (entry.isFile() && entry.name === expectedInstaller) {
      kept.push(entry.name)
      continue
    }
    fs.rmSync(entryPath, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return { removed, kept }
}

if (require.main === module) {
  const result = cleanReleaseArtifacts(process.cwd(), packageProfileFromArgs())
  console.log(`[release] kept: ${result.kept.join(', ')}`)
  console.log(`[release] removed: ${result.removed.join(', ') || 'none'}`)
}

module.exports = { cleanReleaseArtifacts }
