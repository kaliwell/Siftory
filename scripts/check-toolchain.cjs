const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')

function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^v/, '')
}

function readToolchainContract(root = projectRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const nodeVersion = normalizeVersion(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'))
  const packageManagerMatch = String(packageJson.packageManager || '').match(/^npm@(.+)$/)
  if (!packageManagerMatch) throw new Error('packageManager must pin npm with npm@<version>')
  return {
    node: nodeVersion,
    npm: normalizeVersion(packageManagerMatch[1]),
    enginesNode: normalizeVersion(packageJson.engines?.node),
    enginesNpm: normalizeVersion(packageJson.engines?.npm),
  }
}

function validateToolchainContract(contract, actual) {
  const errors = []
  if (!contract.node) errors.push('.nvmrc must pin Node')
  if (contract.enginesNode !== contract.node) errors.push('engines.node must match .nvmrc')
  if (contract.enginesNpm !== contract.npm) errors.push('engines.npm must match packageManager')
  if (actual) {
    if (normalizeVersion(actual.node) !== contract.node) {
      errors.push(`Node ${contract.node} required, received ${normalizeVersion(actual.node)}`)
    }
    if (normalizeVersion(actual.npm) !== contract.npm) {
      errors.push(`npm ${contract.npm} required, received ${normalizeVersion(actual.npm)}`)
    }
  }
  return errors
}

function readActualNpmVersion(env = process.env) {
  // npm.cmd can delegate to a global-prefix installation different from the
  // Node-adjacent npm. Validate the CLI that actually launched this lifecycle.
  const npmCli =
    env.npm_execpath ||
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const result = spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to read npm version')
  return result.stdout.trim()
}

function main() {
  try {
    const contract = readToolchainContract()
    const errors = validateToolchainContract(contract, {
      node: process.version,
      npm: readActualNpmVersion(),
    })
    if (errors.length > 0) throw new Error(errors.join('\n'))
    console.log(`[toolchain] Node ${contract.node}, npm ${contract.npm}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  normalizeVersion,
  readActualNpmVersion,
  readToolchainContract,
  validateToolchainContract,
}
