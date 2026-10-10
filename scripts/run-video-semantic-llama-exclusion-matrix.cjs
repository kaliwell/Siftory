#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createProfileManifest } = require('./package-profile.cjs')
const { validateRuntimeManifest } = require('./validate-runtime-manifest.cjs')

const RUNTIME_ID = 'llama-cpp-b10441-windows-x64-managed-video-runtime-candidate'
const MODEL_ID = 'qwen3-vl-2b-instruct-q4-k-m-gguf-managed-runtime-candidate'
const PROFILES = ['online', 'offline']
const FORBIDDEN_PACKAGE_REFERENCES = [
  'llama-server.exe',
  'llama-cpp-runtime.json',
  'qwen3vl-2b-instruct-q4_k_m.gguf',
  'mmproj-qwen3vl-2b-instruct-q8_0.gguf',
]

function packageResourceReferences(packageJson) {
  return (packageJson.build?.extraResources || []).map((entry) =>
    typeof entry === 'string' ? entry : JSON.stringify(entry),
  )
}

function inspectProfile(manifest, profile) {
  const selected = createProfileManifest(manifest, profile)
  const byId = new Map(selected.components.map((component) => [component.id, component]))
  const candidates = [RUNTIME_ID, MODEL_ID].map((id) => {
    const component = byId.get(id)
    if (!component) throw new Error(`${profile}: candidate component missing: ${id}`)
    return {
      id,
      defaultBundled: component.distribution?.defaultBundled === true,
      fetchPolicies: component.artifacts.map((artifact) => artifact.fetchPolicy),
    }
  })
  return {
    profile,
    candidates,
    excluded:
      candidates.every((candidate) => candidate.defaultBundled === false) &&
      candidates.every((candidate) =>
        candidate.fetchPolicies.every((policy) => policy === 'manual-review'),
      ),
  }
}

async function runExclusionMatrix(projectRoot = path.resolve(__dirname, '..')) {
  const manifest = JSON.parse(
    await fsp.readFile(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  const packageJson = JSON.parse(await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const validation = validateRuntimeManifest(manifest)
  if (!validation.ok) throw new Error(`runtime manifest invalid: ${validation.errors.join('; ')}`)
  const references = packageResourceReferences(packageJson)
  const normalizedReferences = references.join('\n').toLowerCase()
  const forbiddenReferences = FORBIDDEN_PACKAGE_REFERENCES.filter((value) =>
    normalizedReferences.includes(value),
  )
  const descriptorPath = path.join(
    projectRoot,
    'resources',
    'video-semantic',
    'llama-cpp-runtime.json',
  )
  const payloadPaths = [
    path.join(projectRoot, 'resources', 'llama-cpp', 'llama-server.exe'),
    path.join(projectRoot, 'resources', 'video-semantic', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf'),
    path.join(projectRoot, 'resources', 'video-semantic', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'),
  ]
  const profiles = PROFILES.map((profile) => inspectProfile(manifest, profile))
  const report = {
    schemaVersion: 1,
    taskId: 'VID-017',
    generatedAt: new Date().toISOString(),
    matrixKind: 'pre-release-unapproved-resource-exclusion',
    profiles,
    packageConfiguration: {
      forbiddenReferenceCount: forbiddenReferences.length,
      approvedDescriptorPresent: fs.existsSync(descriptorPath),
      repositoryPayloadCount: payloadPaths.filter((filePath) => fs.existsSync(filePath)).length,
    },
    formalPackagedRuntimeMatrixExecuted: false,
    ok:
      profiles.every((profile) => profile.excluded) &&
      forbiddenReferences.length === 0 &&
      !fs.existsSync(descriptorPath) &&
      payloadPaths.every((filePath) => !fs.existsSync(filePath)),
  }
  const reportPath = path.join(
    projectRoot,
    'artifacts',
    'vid017',
    'llama-cpp-exclusion-matrix.json',
  )
  await fsp.mkdir(path.dirname(reportPath), { recursive: true })
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
  return report
}

if (require.main === module) {
  runExclusionMatrix().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = { inspectProfile, packageResourceReferences, runExclusionMatrix }
