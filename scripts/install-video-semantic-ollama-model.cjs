#!/usr/bin/env node
'use strict'

// Explicit local-evaluation installer for the exact Ollama model consumed by
// the development runtime. The application itself never pulls or updates it.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const receiptRelativePath = 'resources/runtime-receipts/qwen3-vl-2b-q4-k-m-ollama.json'
const receiptPath = path.join(repoRoot, ...receiptRelativePath.split('/'))
const manifestPath = path.join(repoRoot, 'resources', 'runtime-manifest.json')
const componentId = 'qwen3-vl-2b-q4-k-m-ollama-external-test-model'
const apiOrigin = 'http://127.0.0.1:11434'

function usage() {
  return [
    'Usage:',
    '  node scripts/install-video-semantic-ollama-model.cjs --accept-external-model',
    '  node scripts/install-video-semantic-ollama-model.cjs --verify-only',
    '',
    'The command never installs/updates Ollama itself and refuses to replace a different tag digest.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { accept: false, verifyOnly: false, ollamaPath: '', help: false }
  for (const argument of argv) {
    if (argument === '--accept-external-model') options.accept = true
    else if (argument === '--verify-only') options.verifyOnly = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument.startsWith('--ollama=')) options.ollamaPath = argument.slice(9).trim()
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.verifyOnly && !options.accept && !options.help) {
    throw new Error('--accept-external-model is required before Ollama may pull the model')
  }
  return options
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function loadPinnedIdentity() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const component = manifest.components?.find((item) => item.id === componentId)
  const artifact = component?.artifacts?.find((item) => item.targetPath === receiptRelativePath)
  if (
    !component ||
    component.distribution?.defaultBundled !== false ||
    artifact?.sha256 !== sha256File(receiptPath)
  ) {
    throw new Error('Pinned Ollama model receipt is missing, changed, or distribution-unsafe')
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  if (
    receipt.schemaVersion !== 1 ||
    receipt.distribution?.applicationMayPullOrUpdate !== false ||
    receipt.distribution?.userApprovalRequired !== true ||
    !/^[a-f0-9]{64}$/.test(receipt.tagIdentity?.digest || '') ||
    typeof receipt.ollamaTag !== 'string' ||
    typeof receipt.model?.quantization !== 'string'
  ) {
    throw new Error('Pinned Ollama model receipt has an invalid policy or identity')
  }
  return {
    tag: receipt.ollamaTag,
    digest: receipt.tagIdentity.digest,
    quantization: receipt.model.quantization,
  }
}

function resolveOllamaExecutable(configuredPath) {
  const candidates = []
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) throw new Error('--ollama must be an absolute path')
    candidates.push(path.resolve(configuredPath))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'))
  }
  const located = spawnSync('where.exe', ['ollama.exe'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (located.status === 0) {
    candidates.push(...located.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate)
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate
    } catch {
      // Try the next fixed candidate.
    }
  }
  throw new Error('Ollama is not installed; install and start the approved external runtime first')
}

async function inspectModel(identity) {
  let response
  try {
    response = await fetch(`${apiOrigin}/api/tags`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(`Ollama loopback API is unavailable: ${error.message}`, { cause: error })
  }
  if (!response.ok) throw new Error(`Ollama loopback API returned HTTP ${response.status}`)
  const responseText = await response.text()
  if (Buffer.byteLength(responseText, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Ollama loopback API response exceeds the safety limit')
  }
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw new Error('Ollama loopback API returned invalid JSON')
  }
  const model = Array.isArray(payload.models)
    ? payload.models.find((item) => item?.name === identity.tag || item?.model === identity.tag)
    : undefined
  if (!model) return { installed: false, ready: false }
  const digest = typeof model.digest === 'string' ? model.digest.toLowerCase() : ''
  const quantization = model.details?.quantization_level
  return {
    installed: true,
    ready: digest === identity.digest && quantization === identity.quantization,
    digest,
    quantization,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const identity = loadPinnedIdentity()
  const ollamaExecutable = resolveOllamaExecutable(options.ollamaPath)
  let status = await inspectModel(identity)
  if (status.installed && !status.ready) {
    throw new Error(
      `${identity.tag} is installed with a different digest or quantization; refusing implicit replacement`,
    )
  }
  if (!status.installed && !options.verifyOnly) {
    console.log(`[install] requesting exact configured tag ${identity.tag} through Ollama`)
    const pull = spawnSync(ollamaExecutable, ['pull', identity.tag], {
      stdio: 'inherit',
      windowsHide: true,
    })
    if (pull.status !== 0) throw new Error(`Ollama pull failed with exit code ${pull.status}`)
    status = await inspectModel(identity)
  }
  const result = {
    ok: status.ready,
    mode: options.verifyOnly ? 'verify-only' : 'install',
    model: identity.tag,
    installed: status.installed,
    digestMatch: status.digest === identity.digest,
    quantizationMatch: status.quantization === identity.quantization,
  }
  console.log(`OLLAMA_MODEL_INSTALL_RESULT ${JSON.stringify(result)}`)
  if (!result.ok) process.exitCode = 2
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ollama-model-install] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = { componentId, loadPinnedIdentity, parseArgs }
