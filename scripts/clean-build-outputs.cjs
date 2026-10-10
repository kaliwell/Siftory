const fs = require('node:fs')
const path = require('node:path')

const BUILD_OUTPUT_DIRECTORIES = ['dist', 'dist-electron']

function cleanBuildOutputs(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot)
  const removed = []
  for (const name of BUILD_OUTPUT_DIRECTORIES) {
    const target = path.resolve(root, name)
    if (path.dirname(target) !== root) {
      throw new Error(`Refusing to clean build output outside the project: ${target}`)
    }
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

if (require.main === module) {
  const removed = cleanBuildOutputs()
  console.log(`[build-clean] removed: ${removed.join(', ') || 'none'}`)
}

module.exports = { BUILD_OUTPUT_DIRECTORIES, cleanBuildOutputs }
