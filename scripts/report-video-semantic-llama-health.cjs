#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  defaultInstallRoot,
  verifyInstallation,
} = require('./install-video-semantic-llama-runtime.cjs')
const { inspectCache } = require('./manage-video-semantic-llama-cache.cjs')

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function buildHealthReport(options = {}) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const mediaRoot =
    options.mediaRoot || path.join(appData, 'floating-clock-electron', 'media-search')
  const verification = await verifyInstallation(options.runtimeRoot || defaultInstallRoot())
  const smoke = readJson(
    path.join(mediaRoot, 'semantic', 'benchmarks', 'llama-cpp-local-smoke', 'report.json'),
  )
  const soak = readJson(
    path.join(mediaRoot, 'semantic', 'benchmarks', 'llama-cpp-local-soak', 'report.json'),
  )
  const cache = await inspectCache(options.cacheRoot)
  return {
    schemaVersion: 1,
    taskId: 'VID-017',
    scope: 'local-evaluation-only',
    installed: verification.ok,
    runtime: verification.ok
      ? {
          release: verification.receipt.runtime.release,
          variant: verification.receipt.runtime.variant,
          serverSha256: verification.receipt.runtime.server.sha256,
        }
      : { reason: verification.reason },
    model: verification.ok
      ? {
          id: verification.receipt.model.id,
          revision: verification.receipt.model.revision,
          quantization: verification.receipt.model.quantization,
          sha256: verification.receipt.model.sha256,
          projectorSha256: verification.receipt.projector.sha256,
        }
      : undefined,
    validation: {
      smoke: smoke?.ok === true,
      soak: soak?.ok === true,
      strictJsonRounds: soak?.summary?.strictJson || 0,
      profileCount: soak?.sample?.profileCount || 0,
      maximumGpuUsedMiB: soak?.summary?.maximumGpuUsedMiB ?? smoke?.gpu?.after?.usedMiB,
    },
    cache: {
      verified: cache.verified,
      invalid: cache.invalid,
      partial: cache.partialFiles.length,
      unknown: cache.unknownFiles,
    },
    healthy:
      verification.ok &&
      smoke?.ok === true &&
      soak?.ok === true &&
      cache.invalid === 0 &&
      cache.partialFiles.length === 0,
  }
}

async function main() {
  const report = await buildHealthReport()
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const root = path.join(
    appData,
    'floating-clock-electron',
    'media-search',
    'semantic',
    'benchmarks',
    'llama-cpp-health',
  )
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.healthy) process.exitCode = 1
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
module.exports = { buildHealthReport }
