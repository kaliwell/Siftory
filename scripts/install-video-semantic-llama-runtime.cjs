const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { promisify } = require('node:util')
const unzipper = require('unzipper')
const { downloadToCache, verifyFile } = require('./fetch-runtime-resources.cjs')

const execFileAsync = promisify(execFile)

const INSTALL_SCHEMA_VERSION = 1
const RUNTIME_RELEASE = 'b10441'
const RUNTIME_COMMIT = '0177dcc7300bad8914bb838baabce87899812491'
const MODEL_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
const MAX_ARCHIVE_ENTRIES = 512
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

const ARTIFACTS = Object.freeze({
  runtime: Object.freeze({
    id: 'llama-cpp-vulkan-x64',
    fileName: 'llama-b10441-bin-win-vulkan-x64.zip',
    sourceUrl:
      'https://github.com/ggml-org/llama.cpp/releases/download/b10441/llama-b10441-bin-win-vulkan-x64.zip',
    sizeBytes: 34_580_767,
    sha256: '7fdbac5860ad1c64bf1e5703e4491612562e953a709a9f190affd6141147c6aa',
  }),
  model: Object.freeze({
    id: 'qwen3-vl-2b-instruct-q4-k-m',
    fileName: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    sourceUrl:
      'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/52d6c8ffea26cc873ac5ad116f8631268d7eb503/Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    sizeBytes: 1_107_409_952,
    sha256: '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae',
  }),
  projector: Object.freeze({
    id: 'qwen3-vl-2b-instruct-mmproj-q8-0',
    fileName: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
    sourceUrl:
      'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/52d6c8ffea26cc873ac5ad116f8631268d7eb503/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
    sizeBytes: 445_053_216,
    sha256: 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82',
  }),
})

function defaultInstallRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.resolve(appData, 'floating-clock-electron', 'runtimes', 'video-semantic-llama-cpp')
}

function defaultCacheRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.resolve(localAppData, 'floating-clock-electron', 'runtime-cache', 'vid017')
}

function parseArgs(argv) {
  const options = {
    accepted: false,
    verifyOnly: false,
    variant: undefined,
    installRoot: defaultInstallRoot(),
    cacheRoot: defaultCacheRoot(),
  }
  for (const arg of argv) {
    if (arg === '--accept-local-evaluation') options.accepted = true
    else if (arg === '--verify-only') options.verifyOnly = true
    else if (arg.startsWith('--variant=')) options.variant = arg.slice(10)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.variant !== 'vulkan') throw new Error('--variant=vulkan is required')
  if (!options.verifyOnly && !options.accepted) {
    throw new Error(
      'Local evaluation consent is required; pass --accept-local-evaluation after reviewing the pinned sources and licenses',
    )
  }
  return options
}

function cachePathFor(cacheRoot, artifact) {
  return path.join(cacheRoot, 'sha256', `${artifact.sha256}.blob`)
}

function safeZipEntryPath(value) {
  const normalized = String(value).replaceAll('\\', '/')
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new Error('runtime archive contains an unsafe entry path')
  }
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('runtime archive contains an unsafe entry path')
  }
  return segments.join('/')
}

function isSymlinkEntry(entry) {
  const attributes = Number(entry.externalFileAttributes || 0) >>> 0
  const unixMode = (attributes >>> 16) & 0xffff
  return (unixMode & 0xf000) === 0xa000
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyArtifact(filePath, artifact) {
  const verification = await verifyFile(filePath, artifact)
  if (!verification.ok) {
    throw new Error(`${artifact.id} verification failed: ${verification.reason}`)
  }
}

async function acquireArtifact(artifact, options) {
  const cachedPath = cachePathFor(options.cacheRoot, artifact)
  const verification = await verifyFile(cachedPath, artifact)
  if (verification.ok) {
    process.stdout.write(`verified cache: ${artifact.id}\n`)
    return cachedPath
  }
  if (verification.reason !== 'missing') await fsp.rm(cachedPath, { force: true })
  process.stdout.write(`downloading: ${artifact.id} (${artifact.sizeBytes} bytes)\n`)
  if (process.platform === 'win32') {
    await downloadWithWindowsBits(artifact, cachedPath, options)
  } else {
    await downloadToCache(artifact, cachedPath, {
      retries: 3,
      timeoutMs: 3_600_000,
    })
  }
  await verifyArtifact(cachedPath, artifact)
  process.stdout.write(`downloaded and verified: ${artifact.id}\n`)
  return cachedPath
}

function assertPinnedDownloadUrl(sourceUrl) {
  const parsed = new URL(sourceUrl)
  if (
    parsed.protocol !== 'https:' ||
    !['github.com', 'huggingface.co'].includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error('BITS download source is not an approved HTTPS host')
  }
}

async function downloadWithWindowsBits(artifact, destinationPath, options = {}) {
  assertPinnedDownloadUrl(artifact.sourceUrl)
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true })
  const temporaryPath = `${destinationPath}.${process.pid}.bits.partial`
  const runProcess = options.runProcess || execFileAsync
  const command = [
    "$ErrorActionPreference='Stop'",
    'Import-Module BitsTransfer -ErrorAction Stop',
    "Start-BitsTransfer -Source $args[0] -Destination $args[1] -TransferType Download -DisplayName 'Siftory verified local runtime download'",
  ].join('; ')
  try {
    await fsp.rm(temporaryPath, { force: true })
    await runProcess(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
        artifact.sourceUrl,
        temporaryPath,
      ],
      { windowsHide: true, shell: false, timeout: 3_600_000, maxBuffer: 64 * 1024 },
    )
    await verifyArtifact(temporaryPath, artifact)
    await fsp.rename(temporaryPath, destinationPath)
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

async function extractRuntimeArchive(archivePath, destinationRoot) {
  const archive = await unzipper.Open.file(archivePath)
  if (archive.files.length === 0 || archive.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('runtime archive entry count is outside the allowed range')
  }
  const entries = []
  const seen = new Set()
  let uncompressedBytes = 0
  for (const entry of archive.files) {
    const relativePath = safeZipEntryPath(entry.path)
    const lookup = relativePath.toLowerCase()
    if (seen.has(lookup)) throw new Error('runtime archive contains duplicate entry paths')
    seen.add(lookup)
    if (isSymlinkEntry(entry)) throw new Error('runtime archive contains a symbolic link')
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error('runtime archive contains an unsupported entry type')
    }
    const size = Number(entry.uncompressedSize || 0)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('runtime archive contains an invalid entry size')
    }
    uncompressedBytes += size
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('runtime archive exceeds the uncompressed size limit')
    }
    entries.push({ entry, relativePath })
  }

  const extractedFiles = []
  for (const { entry, relativePath } of entries) {
    const targetPath = path.resolve(destinationRoot, ...relativePath.split('/'))
    if (!targetPath.startsWith(`${path.resolve(destinationRoot)}${path.sep}`)) {
      throw new Error('runtime archive entry escaped the staging directory')
    }
    if (entry.type === 'Directory') {
      await fsp.mkdir(targetPath, { recursive: true })
      continue
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await pipeline(entry.stream(), fs.createWriteStream(targetPath, { flags: 'wx' }))
    const stat = await fsp.stat(targetPath)
    extractedFiles.push({
      path: relativePath,
      sizeBytes: stat.size,
      sha256: await sha256File(targetPath),
    })
  }
  extractedFiles.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return extractedFiles
}

async function linkOrCopy(sourcePath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  try {
    await fsp.link(sourcePath, targetPath)
    return 'hardlink'
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error
    await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
    return 'copy'
  }
}

function receiptPaths(installRoot) {
  return {
    receipt: path.join(installRoot, 'installation-receipt.json'),
    server: path.join(installRoot, 'llama-cpp', 'llama-server.exe'),
    model: path.join(installRoot, 'video-semantic', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf'),
    projector: path.join(installRoot, 'video-semantic', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'),
  }
}

async function verifyInstallation(installRoot) {
  const paths = receiptPaths(installRoot)
  let receipt
  try {
    receipt = JSON.parse(await fsp.readFile(paths.receipt, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'receipt-missing' }
    return { ok: false, reason: 'receipt-invalid' }
  }
  if (
    receipt.schemaVersion !== INSTALL_SCHEMA_VERSION ||
    receipt.scope !== 'local-evaluation-only' ||
    receipt.runtime?.release !== RUNTIME_RELEASE ||
    receipt.runtime?.commit !== RUNTIME_COMMIT ||
    receipt.runtime?.variant !== 'vulkan-x64' ||
    receipt.model?.revision !== MODEL_REVISION
  ) {
    return { ok: false, reason: 'receipt-identity-mismatch' }
  }
  const checks = [
    [paths.server, receipt.runtime.server],
    [paths.model, ARTIFACTS.model],
    [paths.projector, ARTIFACTS.projector],
  ]
  for (const [filePath, artifact] of checks) {
    if (!artifact?.sha256 || !Number.isSafeInteger(artifact?.sizeBytes)) {
      return { ok: false, reason: 'receipt-artifact-invalid' }
    }
    const verification = await verifyFile(filePath, artifact)
    if (!verification.ok) {
      return { ok: false, reason: `${path.basename(filePath)}-${verification.reason}` }
    }
  }
  return { ok: true, receipt, paths }
}

async function install(options) {
  const existing = await verifyInstallation(options.installRoot)
  if (existing.ok) {
    process.stdout.write('existing local evaluation runtime verified\n')
    return existing
  }
  try {
    const stat = await fsp.stat(options.installRoot)
    if (stat) {
      throw new Error(
        `installation target already exists but is not verified (${existing.reason}); refusing to replace it`,
      )
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const [runtimeArchive, modelFile, projectorFile] = await Promise.all([
    acquireArtifact(ARTIFACTS.runtime, options),
    acquireArtifact(ARTIFACTS.model, options),
    acquireArtifact(ARTIFACTS.projector, options),
  ])
  const parentRoot = path.dirname(options.installRoot)
  const stagingRoot = path.join(parentRoot, `.video-semantic-llama-cpp.staging-${process.pid}`)
  await fsp.mkdir(parentRoot, { recursive: true })
  await fsp.rm(stagingRoot, { recursive: true, force: true })
  await fsp.mkdir(stagingRoot, { recursive: false })
  try {
    const runtimeRoot = path.join(stagingRoot, 'llama-cpp')
    await fsp.mkdir(runtimeRoot, { recursive: false })
    const extractedFiles = await extractRuntimeArchive(runtimeArchive, runtimeRoot)
    const server = extractedFiles.find(
      (file) => file.path.replaceAll('\\', '/').toLowerCase() === 'llama-server.exe',
    )
    if (!server) throw new Error('verified runtime archive does not contain llama-server.exe')

    const modelTarget = path.join(stagingRoot, 'video-semantic', ARTIFACTS.model.fileName)
    const projectorTarget = path.join(stagingRoot, 'video-semantic', ARTIFACTS.projector.fileName)
    const modelPublishMode = await linkOrCopy(modelFile, modelTarget)
    const projectorPublishMode = await linkOrCopy(projectorFile, projectorTarget)
    await verifyArtifact(modelTarget, ARTIFACTS.model)
    await verifyArtifact(projectorTarget, ARTIFACTS.projector)

    const receipt = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      scope: 'local-evaluation-only',
      installedAt: new Date().toISOString(),
      redistributionApproved: false,
      packagedByDefault: false,
      runtime: {
        release: RUNTIME_RELEASE,
        commit: RUNTIME_COMMIT,
        variant: 'vulkan-x64',
        archive: {
          fileName: ARTIFACTS.runtime.fileName,
          sizeBytes: ARTIFACTS.runtime.sizeBytes,
          sha256: ARTIFACTS.runtime.sha256,
          sourceUrl: ARTIFACTS.runtime.sourceUrl,
        },
        server: {
          path: 'llama-cpp/llama-server.exe',
          sizeBytes: server.sizeBytes,
          sha256: server.sha256,
        },
        extractedFiles,
      },
      model: {
        id: ARTIFACTS.model.id,
        revision: MODEL_REVISION,
        quantization: 'Q4_K_M',
        path: `video-semantic/${ARTIFACTS.model.fileName}`,
        sizeBytes: ARTIFACTS.model.sizeBytes,
        sha256: ARTIFACTS.model.sha256,
        sourceUrl: ARTIFACTS.model.sourceUrl,
        publishMode: modelPublishMode,
      },
      projector: {
        id: ARTIFACTS.projector.id,
        revision: MODEL_REVISION,
        quantization: 'Q8_0',
        path: `video-semantic/${ARTIFACTS.projector.fileName}`,
        sizeBytes: ARTIFACTS.projector.sizeBytes,
        sha256: ARTIFACTS.projector.sha256,
        sourceUrl: ARTIFACTS.projector.sourceUrl,
        publishMode: projectorPublishMode,
      },
    }
    await fsp.writeFile(
      path.join(stagingRoot, 'installation-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    await fsp.rename(stagingRoot, options.installRoot)
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
  const result = await verifyInstallation(options.installRoot)
  if (!result.ok) throw new Error(`installed runtime verification failed: ${result.reason}`)
  return result
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = options.verifyOnly
      ? await verifyInstallation(options.installRoot)
      : await install(options)
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          scope: result.receipt?.scope,
          runtime: result.receipt?.runtime?.variant,
          release: result.receipt?.runtime?.release,
          model: result.receipt?.model?.id,
          projector: result.receipt?.projector?.id,
          reason: result.reason,
        },
        null,
        2,
      )}\n`,
    )
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  ARTIFACTS,
  cachePathFor,
  defaultCacheRoot,
  defaultInstallRoot,
  downloadWithWindowsBits,
  extractRuntimeArchive,
  install,
  parseArgs,
  safeZipEntryPath,
  assertPinnedDownloadUrl,
  verifyInstallation,
}
