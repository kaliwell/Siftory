const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const sharp = require('sharp')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const CONFIRMATION = 'REAL_VECTOR_APPEND'
const MODEL_SPECS = {
  clip_vit_base_patch32: {
    dim: 512,
    worker: 'clipEmbeddingChild.js',
  },
  dinov2_vitb14: {
    dim: 768,
    worker: 'dinoEmbeddingChild.js',
  },
}

function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const option = (name) =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=')
  return {
    userDataPath: positional[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron'),
    execute: argv.includes('--execute'),
    confirm: option('confirm'),
    modelName: option('model') || 'dinov2_vitb14',
    count: Math.max(1, Math.min(4, Number(option('count')) || 2)),
    modelRoot: option('model-root') || path.join(process.cwd(), 'ai-models'),
    workerRoot: option('worker-root') || path.join(process.cwd(), 'dist-electron'),
  }
}

function assertExecutionAuthorized(options) {
  if (!options.execute) return
  if (options.confirm !== CONFIRMATION) {
    throw new Error(`Execution requires --confirm=${CONFIRMATION}`)
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function privacyId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function fileSnapshot(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('Crash-recovery target is not a file')
  return { size: stat.size, sha256: sha256File(filePath) }
}

function removeOwnedTemp(tempDir, tempParent) {
  const resolved = path.resolve(tempDir)
  const parent = `${path.resolve(tempParent)}${path.sep}`
  if (!resolved.startsWith(parent)) throw new Error('Refusing to remove a non-temporary backup')
  fs.rmSync(resolved, { recursive: true, force: true })
}

async function validateUncommittedTailRecovery(files, recover, options = {}) {
  const names = ['f16', 'paths', 'commit']
  const tempParent = path.resolve(options.tempParent || os.tmpdir())
  const before = Object.fromEntries(names.map((name) => [name, fileSnapshot(files[name])]))
  const tempDir = fs.mkdtempSync(path.join(tempParent, 'reasonix-vector-tail-recovery-'))
  try {
    for (const name of names) fs.copyFileSync(files[name], path.join(tempDir, name))
    fs.appendFileSync(files.f16, Buffer.from([0xde, 0xad, 0xbe]))
    fs.appendFileSync(files.paths, '{"row":', 'utf8')
    try {
      await recover()
      for (const name of names) {
        const after = fileSnapshot(files[name])
        if (after.size !== before[name].size || after.sha256 !== before[name].sha256) {
          throw new Error(`Recovered ${name} does not match its committed snapshot`)
        }
      }
    } catch (error) {
      fs.mkdirSync(path.dirname(files.f16), { recursive: true })
      for (const name of names) fs.copyFileSync(path.join(tempDir, name), files[name])
      for (const name of names) {
        const restored = fileSnapshot(files[name])
        if (restored.size !== before[name].size || restored.sha256 !== before[name].sha256) {
          throw new Error(`Crash-recovery test failed and ${name} could not be restored`, {
            cause: error,
          })
        }
      }
      throw new Error(
        `Crash-recovery test failed; committed delta was restored: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    return {
      injectedVectorBytes: 3,
      injectedPathBytes: Buffer.byteLength('{"row":'),
      exactCommittedSnapshotRestored: true,
      committedSizes: Object.fromEntries(names.map((name) => [name, before[name].size])),
    }
  } finally {
    removeOwnedTemp(tempDir, tempParent)
  }
}

async function addIndexedPaths(filePath, target, maxRows) {
  if (!filePath || maxRows <= 0) return
  let rows = 0
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (rows >= maxRows) break
    if (!line) continue
    const item = JSON.parse(line)
    if (typeof item.path !== 'string') throw new Error('Malformed authoritative path index')
    target.add(item.path)
    rows++
  }
  if (rows !== maxRows) {
    throw new Error(`Authoritative path index ended at ${rows}; expected ${maxRows}`)
  }
}

async function collectExistingIds(handle) {
  const ids = new Set()
  const baseCount = handle.delta ? handle.delta.baseCount : handle.meta.count
  await addIndexedPaths(handle.pathIndexPath, ids, baseCount)
  if (handle.delta) {
    await addIndexedPaths(handle.delta.pathIndexPath, ids, handle.meta.count - baseCount)
  }
  return ids
}

async function collectCandidateJobs(jobsPath, modelName, existingIds, limit) {
  const latest = new Map()
  const lines = readline.createInterface({
    input: fs.createReadStream(jobsPath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line) continue
    let job
    try {
      job = JSON.parse(line)
    } catch {
      continue
    }
    if (
      job.modelName !== modelName ||
      typeof job.imageId !== 'string' ||
      typeof job.path !== 'string'
    ) {
      continue
    }
    latest.set(job.imageId, job)
  }
  const candidates = []
  for (const job of latest.values()) {
    if (candidates.length >= limit) break
    if (job.status !== 'pending' && job.status !== 'failed') continue
    if (existingIds.has(job.imageId) || !path.isAbsolute(job.path)) continue
    try {
      const stat = fs.statSync(job.path)
      if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024) continue
      candidates.push({
        imageId: job.imageId,
        imagePath: job.path,
        size: stat.size,
        extension: path.extname(job.path).toLowerCase().slice(0, 16),
      })
    } catch {
      /* stale job */
    }
  }
  return candidates
}

async function selectDecodableCandidates(candidates, count) {
  const accepted = []
  let rejected = 0
  for (const candidate of candidates) {
    try {
      const metadata = await sharp(candidate.imagePath).metadata()
      if (!metadata.width || !metadata.height) throw new Error('missing image dimensions')
      accepted.push(candidate)
      if (accepted.length >= count) break
    } catch {
      rejected++
    }
  }
  return { accepted, rejected }
}

function readModelManifest(modelName) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'models', 'manifest.json'), 'utf8'),
  )
  const model = manifest.models?.find((candidate) => candidate.name === modelName)
  if (!model) throw new Error(`Model ${modelName} is absent from models/manifest.json`)
  return model
}

function resolveVerifiedModel(modelRoot, manifest) {
  const modelPath = path.join(modelRoot, manifest.name, ...manifest.filename.split('/'))
  const stat = fs.statSync(modelPath)
  if (!stat.isFile() || stat.size !== manifest.sizeBytes) {
    throw new Error(`Model ${manifest.name} size does not match the manifest`)
  }
  const actualHash = sha256File(modelPath)
  if (actualHash !== manifest.sha256) {
    throw new Error(`Model ${manifest.name} SHA-256 does not match the manifest`)
  }
  return { modelPath, size: stat.size, sha256: actualHash }
}

function sanitizedWorkerError(message, candidates) {
  let output = String(message || 'Embedding worker failed')
  for (const candidate of candidates) {
    output = output.replaceAll(candidate.imagePath, '<candidate>')
    output = output.replaceAll(candidate.imageId, '<candidate-id>')
  }
  return output.slice(0, 500)
}

function runEmbeddingWorker(workerPath, modelPath, candidates, dim, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const nodePath = [process.env.NODE_PATH, path.join(process.cwd(), 'node_modules')]
      .filter(Boolean)
      .join(path.delimiter)
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const results = new Map()
    let stdout = ''
    let stderr = ''
    let sent = false
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* already exited */
      }
      if (error) reject(error)
      else resolve(candidates.map((candidate, index) => ({ candidate, ...results.get(index + 1) })))
    }
    const timer = setTimeout(() => finish(new Error('Embedding worker timed out')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000)
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        newline = stdout.indexOf('\n')
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'ready' && !sent) {
          sent = true
          const payload = candidates
            .map((candidate, index) =>
              JSON.stringify({
                id: index + 1,
                imageId: candidate.imageId,
                imagePath: candidate.imagePath,
                modelPath,
                dim,
                backend: 'cpu',
                batchSize: candidates.length,
              }),
            )
            .join('\n')
          child.stdin.write(`${payload}\n`)
          continue
        }
        if (!Number.isInteger(message.id)) continue
        results.set(message.id, {
          ok: message.ok === true,
          vector: Array.isArray(message.vector) ? message.vector.map(Number) : undefined,
          error: message.error,
        })
        if (results.size === candidates.length) finish()
      }
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            sanitizedWorkerError(
              `Embedding worker exited before completing: code=${code} signal=${signal}; ${stderr}`,
              candidates,
            ),
          ),
        )
      }
    })
  })
}

function validateVector(vector, dim) {
  if (
    !Array.isArray(vector) ||
    vector.length !== dim ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Embedding worker returned an invalid vector')
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (Math.abs(norm - 1) > 1e-3) throw new Error(`Embedding vector norm ${norm} is invalid`)
  return norm
}

function deltaFiles(storeRoot, modelName) {
  const dir = path.join(storeRoot, 'incremental', `${modelName}__global`)
  return {
    f16: path.join(dir, 'delta.f16'),
    paths: path.join(dir, 'delta.paths.jsonl'),
    commit: path.join(dir, 'delta.json'),
  }
}

function summarizeMaintenance(stats) {
  return {
    dinoEmbeddingRecords: stats.dinoEmbeddingRecords,
    dinoUniqueImages: stats.dinoUniqueImages,
    clipEmbeddingRecords: stats.clipEmbeddingRecords,
    clipUniqueImages: stats.clipUniqueImages,
    persistenceReadOnly: (stats.persistence || [])
      .filter((item) => item.readOnly)
      .map((item) => item.filename),
  }
}

async function executeValidation(options) {
  const spec = MODEL_SPECS[options.modelName]
  if (!spec) throw new Error(`Unsupported model: ${options.modelName}`)
  const userDataPath = path.resolve(options.userDataPath)
  const vectorDb = path.join(userDataPath, 'vector-db')
  const shard = path.join(vectorDb, 'embeddings', `${options.modelName}__global.jsonl`)
  const cacheDir = path.join(vectorDb, 'embedding-cache')
  const storeRoot = path.join(vectorDb, 'vector-store')
  const jobsPath = path.join(vectorDb, 'embedding_jobs.jsonl')
  for (const required of [userDataPath, shard, jobsPath, path.join(storeRoot, 'CURRENT')]) {
    if (!fs.existsSync(required)) throw new Error('Required real-data validation input is missing')
  }

  const vectorDbApi = loadTsModule('electron/vectorDatabaseService.ts')
  const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
  const incrementApi = loadTsModule('electron/embeddingIncrementLog.ts')
  const maintenanceApi = loadTsModule('electron/vectorMaintenanceService.ts')
  const inputApi = loadTsModule('electron/embeddingInputValidation.ts')
  vectorDbApi.initVectorDatabase(userDataPath)
  const handleOptions = {
    cacheDir,
    modelName: options.modelName,
    embeddingType: 'global',
    dim: spec.dim,
    sourcePaths: [shard],
  }
  const beforeHandle = cacheApi.readFreshEmbeddingF16Cache(handleOptions)
  if (!beforeHandle) throw new Error('Authoritative composite snapshot is unavailable or stale')
  const existingIds = await collectExistingIds(beforeHandle)
  const rawCandidates = await collectCandidateJobs(
    jobsPath,
    options.modelName,
    existingIds,
    Math.max(1024, options.count * 64),
  )
  const filtered = await inputApi.filterSupportedEmbeddingInputs(rawCandidates, { concurrency: 8 })
  const decoded = await selectDecodableCandidates(filtered.accepted, options.count)
  const candidates = decoded.accepted
  if (candidates.length < options.count) {
    throw new Error(`Only ${candidates.length} safe unembedded candidate(s) are available`)
  }

  const manifest = readModelManifest(options.modelName)
  const verifiedModel = resolveVerifiedModel(path.resolve(options.modelRoot), manifest)
  const workerPath = path.join(path.resolve(options.workerRoot), spec.worker)
  if (!fs.statSync(workerPath).isFile()) throw new Error('Built embedding worker is missing')
  const beforeStats = {
    ...(await maintenanceApi.getVectorMaintenanceShardStats(vectorDb)),
    persistence: vectorDbApi.getVectorDatabasePersistenceStatus(),
  }
  const preview = {
    mode: options.execute ? 'execute' : 'preview',
    modelName: options.modelName,
    requestedCount: options.count,
    authoritativeCount: beforeHandle.meta.count,
    authoritativeUniquePaths: existingIds.size,
    candidateCount: candidates.length,
    rejectedCandidateHeaders: filtered.rejected,
    rejectedCandidateDecodes: decoded.rejected,
    candidates: candidates.map((candidate) => ({
      id: privacyId(candidate.imageId),
      size: candidate.size,
      extension: candidate.extension,
    })),
    model: {
      size: verifiedModel.size,
      manifestSha256Matched: verifiedModel.sha256 === manifest.sha256,
    },
    maintenanceBefore: summarizeMaintenance(beforeStats),
    writes: [
      'embedding JSONL append',
      'committed F16 delta append',
      'temporary uncommitted delta tail',
    ],
  }
  if (!options.execute) return preview

  const inference = await runEmbeddingWorker(
    workerPath,
    verifiedModel.modelPath,
    candidates,
    spec.dim,
  )
  const failed = inference.filter((item) => !item.ok)
  if (failed.length > 0) {
    throw new Error(
      sanitizedWorkerError(
        `Embedding inference failed before any write: ${failed.map((item) => item.error).join('; ')}`,
        candidates,
      ),
    )
  }
  const createdAt = Date.now()
  for (const item of inference) {
    validateVector(item.vector, spec.dim)
    await vectorDbApi.appendEmbeddingNoUpsertAsync({
      imageId: item.candidate.imageId,
      modelName: options.modelName,
      modelVersion: manifest.version,
      embeddingType: 'global',
      dim: spec.dim,
      vector: item.vector,
      norm: 1,
      createdAt,
      updatedAt: createdAt,
    })
  }
  await vectorDbApi.flushVectorDatabaseWrites()
  const afterAppendHandle = cacheApi.readFreshEmbeddingF16Cache(handleOptions)
  if (
    !afterAppendHandle ||
    afterAppendHandle.meta.count !== beforeHandle.meta.count + candidates.length
  ) {
    throw new Error('Composite snapshot count did not advance by the committed append count')
  }

  const files = deltaFiles(storeRoot, options.modelName)
  const crashRecovery = await validateUncommittedTailRecovery(files, () => {
    incrementApi.resetEmbeddingIncrementStateForTests()
    const recovered = incrementApi.prepareEmbeddingIncrement(
      storeRoot,
      options.modelName,
      'global',
      shard,
    )
    if (!recovered) throw new Error('Increment writer rejected the committed delta during recovery')
  })
  const afterRecoveryHandle = cacheApi.readFreshEmbeddingF16Cache(handleOptions)
  if (!afterRecoveryHandle || afterRecoveryHandle.meta.count !== afterAppendHandle.meta.count) {
    throw new Error('Recovered composite snapshot is unavailable or changed count')
  }
  const afterStats = {
    ...(await maintenanceApi.getVectorMaintenanceShardStats(vectorDb)),
    persistence: vectorDbApi.getVectorDatabasePersistenceStatus(),
  }
  const beforeSummary = summarizeMaintenance(beforeStats)
  const afterSummary = summarizeMaintenance(afterStats)
  const recordField =
    options.modelName === 'dinov2_vitb14' ? 'dinoEmbeddingRecords' : 'clipEmbeddingRecords'
  const uniqueField =
    options.modelName === 'dinov2_vitb14' ? 'dinoUniqueImages' : 'clipUniqueImages'
  if (
    afterSummary[recordField] !== beforeSummary[recordField] + candidates.length ||
    afterSummary[uniqueField] !== beforeSummary[uniqueField] + candidates.length
  ) {
    throw new Error('Maintenance statistics did not advance by the committed append count')
  }
  return {
    ...preview,
    mode: 'executed',
    appended: candidates.map((candidate, index) => ({
      id: privacyId(candidate.imageId),
      dim: spec.dim,
      norm: validateVector(inference[index].vector, spec.dim),
    })),
    authoritativeCountAfter: afterRecoveryHandle.meta.count,
    crashRecovery,
    maintenanceAfter: afterSummary,
    gateReady: true,
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  assertExecutionAuthorized(options)
  const { app } = require('electron')
  if (!app?.setPath) throw new Error('Run this command through Electron, not plain Node')
  app.setPath('userData', path.resolve(options.userDataPath))
  await app.whenReady()
  return executeValidation(options)
}

if (process.versions.electron) {
  main()
    .then((report) => {
      // This is a headless, single-operation maintenance CLI. Imported stores
      // can retain handles even though no application resources are active;
      // synchronously flush the report, then terminate this dedicated host.
      fs.writeSync(process.stdout.fd, `${JSON.stringify(report, null, 2)}\n`)
      require('electron').app.exit(0)
    })
    .catch((error) => {
      fs.writeSync(
        process.stderr.fd,
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      )
      require('electron').app.exit(1)
    })
}

module.exports = {
  CONFIRMATION,
  assertExecutionAuthorized,
  parseArgs,
  validateUncommittedTailRecovery,
}
