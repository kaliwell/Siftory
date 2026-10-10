#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MANAGED_NAME_PATTERNS = [
  /^phase0-corpus-\d+k$/,
  /^phase0-index-[A-Za-z0-9_-]+$/,
  /^phase0-thumbs-[A-Za-z0-9_-]+$/,
  /^phase0-jpeg-subset$/,
]

function resolveManagedPhase0Target(tempRoot, candidate) {
  const root = path.resolve(tempRoot)
  const target = path.resolve(candidate)
  const name = path.basename(target)
  if (path.dirname(target) !== root) return undefined
  if (!MANAGED_NAME_PATTERNS.some((pattern) => pattern.test(name))) return undefined
  return target
}

function inspectManagedPhase0Target(tempRoot, candidate) {
  const target = resolveManagedPhase0Target(tempRoot, candidate)
  if (!target) return { target: path.resolve(candidate), managed: false, reason: 'outside-policy' }
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return { target, managed: false, reason: 'symbolic-link' }
    if (!stat.isDirectory()) return { target, managed: false, reason: 'not-directory' }
    return { target, managed: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { target, managed: true, missing: true }
    return { target, managed: false, reason: error?.message || String(error) }
  }
}

function listManagedPhase0Targets(tempRoot = os.tmpdir()) {
  const root = path.resolve(tempRoot)
  return fs
    .readdirSync(root)
    .map((name) => inspectManagedPhase0Target(root, path.join(root, name)))
    .filter((entry) => entry.managed || entry.reason === 'symbolic-link')
}

function removeManagedPhase0Target(tempRoot, candidate) {
  const inspected = inspectManagedPhase0Target(tempRoot, candidate)
  if (!inspected.managed) {
    return { ...inspected, deleted: false }
  }
  if (inspected.missing) return { ...inspected, deleted: false }
  fs.rmSync(inspected.target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  return { ...inspected, deleted: !fs.existsSync(inspected.target) }
}

function main(argv = process.argv.slice(2)) {
  const execute = argv.includes('--execute')
  const unknown = argv.filter((argument) => argument !== '--execute')
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`)
  const tempRoot = path.resolve(os.tmpdir())
  const preview = listManagedPhase0Targets(tempRoot)
  const results = execute
    ? preview.map((entry) =>
        entry.managed
          ? removeManagedPhase0Target(tempRoot, entry.target)
          : { ...entry, deleted: false },
      )
    : preview.map((entry) => ({ ...entry, deleted: false }))
  process.stdout.write(
    `${JSON.stringify(
      {
        tempRoot,
        execute,
        candidates: results.length,
        deleted: results.filter((entry) => entry.deleted).length,
        refused: results.filter((entry) => !entry.managed).length,
        results,
      },
      null,
      2,
    )}\n`,
  )
  if (execute && results.some((entry) => entry.managed && !entry.deleted && !entry.missing)) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  inspectManagedPhase0Target,
  listManagedPhase0Targets,
  main,
  removeManagedPhase0Target,
  resolveManagedPhase0Target,
}
