#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const {
  cachePathFor,
  parseArgs,
  runResourceFetch,
  seedCacheFromTarget,
  verifyFile,
} = require('./fetch-runtime-resources.cjs')

const projectRoot = path.resolve(__dirname, '..')
const CUDA_RUNTIME_COMPONENT_IDS = [
  'microsoft-onnxruntime-gpu-windows-1-24-3',
  'nvidia-cuda-12-8-embedding-runtime',
  'nvidia-cudnn-9-19-1-cuda12-runtime',
  'floating-clock-cuda-embedding-worker',
]
const NVIDIA_COMPONENT_IDS = [
  'nvidia-cuda-12-8-embedding-runtime',
  'nvidia-cudnn-9-19-1-cuda12-runtime',
]

function parseInstallerArgs(argv) {
  let workerPath
  let providerGatesPath = path.join(projectRoot, 'resources', 'cuda-provider-gates.json')
  let acceptNvidiaLicense = false
  const forwarded = []
  for (const argument of argv) {
    if (argument.startsWith('--worker-path=')) workerPath = path.resolve(argument.slice(14))
    else if (argument.startsWith('--provider-gates=')) {
      providerGatesPath = path.resolve(argument.slice(17))
    } else if (argument === '--accept-nvidia-license') acceptNvidiaLicense = true
    else if (argument.startsWith('--component=') || argument.startsWith('--accept-license=')) {
      throw new Error('CUDA runtime components and license identifiers are fixed by the installer')
    } else {
      forwarded.push(argument)
    }
  }
  if (!forwarded.some((argument) => argument.startsWith('--target-dir='))) {
    throw new Error('--target-dir is required and must name the app data root')
  }
  const options = parseArgs(forwarded)
  options.componentIds = [...CUDA_RUNTIME_COMPONENT_IDS]
  options.acceptedLicenses = acceptNvidiaLicense ? [...NVIDIA_COMPONENT_IDS] : []
  return { options, workerPath, providerGatesPath }
}

function artifactByRole(manifest, role) {
  for (const component of manifest.components || []) {
    for (const artifact of component.artifacts || []) {
      if (artifact.role === role) return artifact
    }
  }
  throw new Error(`CUDA runtime manifest is missing role=${role}`)
}

async function seedLocalArtifact(sourcePath, cacheDir, artifact) {
  const verification = await verifyFile(sourcePath, artifact)
  if (!verification.ok) {
    throw new Error(`${artifact.role}: local source failed ${verification.reason}`)
  }
  const cachePath = cachePathFor(cacheDir, artifact)
  if (await seedCacheFromTarget(sourcePath, cachePath, artifact)) return 1
  return 0
}

async function installCudaRuntime(parsed) {
  const manifest = JSON.parse(await fsp.readFile(parsed.options.manifestPath, 'utf8'))
  let seeded = 0
  if (!parsed.options.verifyOnly) {
    if (parsed.workerPath) {
      seeded += await seedLocalArtifact(
        parsed.workerPath,
        parsed.options.cacheDir,
        artifactByRole(manifest, 'cuda-embedding-worker'),
      )
    }
    if (fs.existsSync(parsed.providerGatesPath)) {
      seeded += await seedLocalArtifact(
        parsed.providerGatesPath,
        parsed.options.cacheDir,
        artifactByRole(manifest, 'cuda-provider-gates'),
      )
    }
  }
  const result = await runResourceFetch(parsed.options)
  result.seeded += seeded
  return result
}

async function main() {
  try {
    const result = await installCudaRuntime(parseInstallerArgs(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  CUDA_RUNTIME_COMPONENT_IDS,
  NVIDIA_COMPONENT_IDS,
  artifactByRole,
  installCudaRuntime,
  parseInstallerArgs,
  seedLocalArtifact,
}
