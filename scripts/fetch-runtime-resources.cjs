const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { EnvHttpProxyAgent } = require('undici')
const unzipper = require('unzipper')
const { validateRuntimeManifest } = require('./validate-runtime-manifest.cjs')
const { createProfileManifest, normalizePackageProfile } = require('./package-profile.cjs')

const projectRoot = path.resolve(__dirname, '..')
const defaultManifestPath = path.join(projectRoot, 'resources', 'runtime-manifest.json')
const retryableStatus = new Set([408, 425, 429, 500, 502, 503, 504])

function parseArgs(argv) {
  const options = {
    verifyOnly: false,
    offline: false,
    retries: 2,
    timeoutMs: 60_000,
    targetDir: projectRoot,
    componentIds: [],
    acceptedLicenses: [],
    profile: undefined,
  }
  for (const arg of argv) {
    if (arg === '--verify-only') options.verifyOnly = true
    else if (arg === '--offline') options.offline = true
    else if (arg.startsWith('--manifest=')) options.manifestPath = arg.slice(11)
    else if (arg.startsWith('--cache-dir=')) options.cacheDir = arg.slice(12)
    else if (arg.startsWith('--target-dir=')) options.targetDir = arg.slice(13)
    else if (arg.startsWith('--component=')) options.componentIds.push(arg.slice(12))
    else if (arg.startsWith('--accept-license=')) options.acceptedLicenses.push(arg.slice(17))
    else if (arg.startsWith('--profile=')) {
      if (options.profile) throw new Error('--profile may be specified only once')
      options.profile = normalizePackageProfile(arg.slice(10))
    } else if (arg.startsWith('--retries=')) options.retries = Number(arg.slice(10))
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = Number(arg.slice(13))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  options.manifestPath = path.resolve(options.manifestPath || defaultManifestPath)
  options.targetDir = path.resolve(options.targetDir)
  if (options.cacheDir) options.cacheDir = path.resolve(options.cacheDir)
  if (!options.verifyOnly && !options.cacheDir) {
    throw new Error('--cache-dir is required unless --verify-only is used')
  }
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10) {
    throw new Error('--retries must be an integer from 0 to 10')
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 3_600_000
  ) {
    throw new Error('--timeout-ms must be an integer from 100 to 3600000')
  }
  return options
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyFile(filePath, artifact) {
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size !== artifact.sizeBytes) {
      return { ok: false, reason: 'size-mismatch' }
    }
    const actualSha256 = await sha256File(filePath)
    return actualSha256 === artifact.sha256
      ? { ok: true }
      : { ok: false, reason: 'sha256-mismatch', actualSha256 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing' }
    throw error
  }
}

function cachePathFor(cacheDir, artifact) {
  return path.join(cacheDir, 'sha256', `${artifact.archive?.sha256 || artifact.sha256}.blob`)
}

function downloadableSource(artifact) {
  return artifact.archive
    ? {
        sourceUrl: artifact.sourceUrl,
        sha256: artifact.archive.sha256,
        sizeBytes: artifact.archive.sizeBytes,
      }
    : artifact
}

async function downloadOnce(artifact, temporaryPath, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('download timeout')), options.timeoutMs)
  const dispatcher = options.dispatcherFactory?.() || new EnvHttpProxyAgent()
  try {
    const response = await (options.fetchImpl || fetch)(artifact.sourceUrl, {
      dispatcher,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Siftory-ResourceFetcher/1.0' },
    })
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`)
      error.status = response.status
      throw error
    }
    if (!response.body) throw new Error('response body is empty')
    const hash = crypto.createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporaryPath), {
      signal: controller.signal,
    })
    const actualSha256 = hash.digest('hex')
    if (bytes !== artifact.sizeBytes) {
      throw new Error(`size mismatch: expected ${artifact.sizeBytes}, received ${bytes}`)
    }
    if (actualSha256 !== artifact.sha256) {
      throw new Error(`sha256 mismatch: expected ${artifact.sha256}, received ${actualSha256}`)
    }
  } finally {
    clearTimeout(timer)
    dispatcher.close?.()
  }
}

async function downloadToCache(artifact, cachePath, options) {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true })
  let lastError
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const temporaryPath = `${cachePath}.${process.pid}.${attempt}.partial`
    try {
      await downloadOnce(artifact, temporaryPath, options)
      await fsp.rename(temporaryPath, cachePath)
      return
    } catch (error) {
      lastError = error
      await fsp.rm(temporaryPath, { force: true })
      const retryable =
        error?.name === 'AbortError' ||
        error?.status === undefined ||
        retryableStatus.has(error.status)
      if (!retryable || attempt === options.retries) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * 2 ** attempt)))
    }
  }
  throw lastError
}

async function publishFromCache(cachePath, targetPath, artifact) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.partial`
  try {
    if (artifact.archive) {
      const directory = await unzipper.Open.file(cachePath)
      const normalizedEntry = artifact.archive.entryPath.replaceAll('\\', '/')
      const matches = directory.files.filter(
        (entry) => entry.type === 'File' && entry.path.replaceAll('\\', '/') === normalizedEntry,
      )
      if (matches.length !== 1) {
        throw new Error(
          `${artifact.archive.entryPath}: expected exactly one matching ZIP entry, found ${matches.length}`,
        )
      }
      await pipeline(matches[0].stream(), fs.createWriteStream(temporaryPath))
    } else {
      await fsp.copyFile(cachePath, temporaryPath)
    }
    const verification = await verifyFile(temporaryPath, artifact)
    if (!verification.ok) throw new Error(`prepared target failed: ${verification.reason}`)
    await fsp.rm(targetPath, { force: true })
    await fsp.rename(temporaryPath, targetPath)
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

async function seedCacheFromTarget(targetPath, cachePath, artifact) {
  const verification = await verifyFile(cachePath, artifact)
  if (verification.ok) return false
  await fsp.rm(cachePath, { force: true })
  await fsp.mkdir(path.dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.seed.partial`
  try {
    await fsp.copyFile(targetPath, temporaryPath)
    const prepared = await verifyFile(temporaryPath, artifact)
    if (!prepared.ok) throw new Error(`cache seed failed: ${prepared.reason}`)
    await fsp.rename(temporaryPath, cachePath)
    return true
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

function selectedComponents(manifest, componentIds) {
  if (componentIds.length === 0) return manifest.components
  const requested = new Set(componentIds)
  const selected = manifest.components.filter((component) => requested.delete(component.id))
  if (requested.size > 0) throw new Error(`Unknown component(s): ${[...requested].join(', ')}`)
  return selected
}

async function verifyLicenseFiles(component, manifestDir) {
  for (const relativePath of component.license.licenseFiles) {
    const candidates = [
      path.resolve(projectRoot, relativePath),
      path.resolve(manifestDir, relativePath),
    ]
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(`${component.id}: license file is missing: ${relativePath}`)
    }
  }
}

async function runResourceFetch(options) {
  const manifest = JSON.parse(await fsp.readFile(options.manifestPath, 'utf8'))
  const validation = validateRuntimeManifest(manifest)
  if (!validation.ok) throw new Error(`Invalid manifest:\n${validation.errors.join('\n')}`)
  const profile = options.profile ? normalizePackageProfile(options.profile) : undefined
  const selectionManifest = profile ? createProfileManifest(manifest, profile) : manifest
  if (profile) {
    selectionManifest.components = selectionManifest.components.filter(
      (component) => component.distribution?.defaultBundled === true,
    )
  }
  const components = selectedComponents(selectionManifest, options.componentIds)
  const acceptedLicenses = new Set(options.acceptedLicenses || [])
  const result = {
    verified: 0,
    seeded: 0,
    cached: 0,
    downloaded: 0,
    published: 0,
    errors: [],
    profile: profile || 'all',
    componentIds: components.map((component) => component.id),
  }
  for (const component of components) {
    try {
      if (
        !options.verifyOnly &&
        component.license.acceptanceRequired === true &&
        !acceptedLicenses.has(component.id)
      ) {
        throw new Error(
          `explicit license acceptance required; review ${component.license.sourceUrl} and pass --accept-license=${component.id}`,
        )
      }
      await verifyLicenseFiles(component, path.dirname(options.manifestPath))
      for (const artifact of component.artifacts) {
        const targetPath = path.resolve(options.targetDir, ...artifact.targetPath.split('/'))
        const targetVerification = await verifyFile(targetPath, artifact)
        if (targetVerification.ok) {
          result.verified += 1
          if (!options.verifyOnly) {
            const cachePath = cachePathFor(options.cacheDir, artifact)
            if (!artifact.archive && (await seedCacheFromTarget(targetPath, cachePath, artifact))) {
              result.seeded += 1
            }
          }
          continue
        }
        if (options.verifyOnly) {
          throw new Error(`${artifact.targetPath}: ${targetVerification.reason}`)
        }
        const cachePath = cachePathFor(options.cacheDir, artifact)
        let cacheVerification = await verifyFile(cachePath, downloadableSource(artifact))
        if (!cacheVerification.ok && cacheVerification.reason !== 'missing') {
          await fsp.rm(cachePath, { force: true })
          cacheVerification = { ok: false, reason: 'missing' }
        }
        if (!cacheVerification.ok) {
          if (options.offline)
            throw new Error(`${artifact.targetPath}: verified cache entry missing`)
          if (artifact.fetchPolicy !== 'download') {
            throw new Error(
              `${artifact.targetPath}: fetchPolicy=${artifact.fetchPolicy}; provide a verified cache entry`,
            )
          }
          await downloadToCache(downloadableSource(artifact), cachePath, options)
          result.downloaded += 1
        } else {
          result.cached += 1
        }
        await publishFromCache(cachePath, targetPath, artifact)
        result.published += 1
      }
    } catch (error) {
      result.errors.push(
        `${component.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  result.ok = result.errors.length === 0
  return result
}

async function main() {
  try {
    const result = await runResourceFetch(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  cachePathFor,
  downloadToCache,
  parseArgs,
  runResourceFetch,
  seedCacheFromTarget,
  verifyFile,
}
