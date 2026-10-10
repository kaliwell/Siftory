#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const { loadTsModule } = require('../tests/guard-utils.cjs')

const REPAIR_SCHEMA_VERSION = 1
const CLIP_CHANNEL_FAILURE = /unsupported number of channels:\s*4/i
const MODEL_CONFIGS = [
  { modelName: 'dinov2_vitb14', dim: 768, candidateIssue: 'zero-norm' },
  { modelName: 'clip_vit_base_patch32', dim: 512, candidateIssue: 'missing-channel-failure' },
]

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv) {
  const userDataPath = path.resolve(
    option(argv, 'user-data', path.join(process.env.APPDATA || '', 'floating-clock-electron')),
  )
  return {
    execute: argv.includes('--execute'),
    confirm: option(argv, 'confirm', ''),
    userDataPath,
    backend: option(argv, 'backend', 'gpu'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize: Math.max(0, Math.min(16, Number(option(argv, 'batch-size', '0')) || 0)),
    appRoot: path.resolve(option(argv, 'app-root', path.join(__dirname, '..'))),
    childrenDir: path.resolve(
      option(argv, 'children-dir', path.join(__dirname, '..', 'dist-electron')),
    ),
    stateFile: path.resolve(
      option(
        argv,
        'state-file',
        path.join(userDataPath, 'value-automation', 'vector-coverage-repair-state.json'),
      ),
    ),
  }
}

function validateOptions(options) {
  if (path.basename(options.userDataPath).toLowerCase() !== 'floating-clock-electron') {
    throw new Error('The user-data directory must end in floating-clock-electron')
  }
  if (!fs.existsSync(options.userDataPath) || !fs.statSync(options.userDataPath).isDirectory()) {
    throw new Error(`User-data directory does not exist: ${options.userDataPath}`)
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (options.execute && !options.confirm) {
    throw new Error('Execution requires --confirm=<preview token>')
  }
  if (options.execute) {
    for (const child of ['dinoEmbeddingChild.js', 'clipEmbeddingChild.js']) {
      const childPath = path.join(options.childrenDir, child)
      if (!fs.existsSync(childPath) || !fs.statSync(childPath).isFile()) {
        throw new Error(`Compiled child is missing: ${childPath}`)
      }
    }
  }
}

function embeddingPathKey(filePath) {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function embeddingSourcePaths(userDataPath, modelName) {
  const vectorDb = path.join(userDataPath, 'vector-db')
  const paths = [
    path.join(vectorDb, 'image_embeddings.jsonl'),
    path.join(vectorDb, 'embeddings', `${modelName}__global.jsonl`),
  ]
  return paths.filter((filePath) => {
    try {
      return fs.statSync(filePath).isFile()
    } catch {
      return false
    }
  })
}

function fileDescriptor(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`)
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameFileDescriptor(descriptor) {
  try {
    const current = fileDescriptor(descriptor.path)
    return current.size === descriptor.size && current.mtimeMs === descriptor.mtimeMs
  } catch {
    return false
  }
}

async function collectCurrentVectorState(sourcePaths, modelName, dim, classifyEmbeddingVector) {
  const latest = new Map()
  let sourceRecordCount = 0
  let malformedRows = 0
  let invalidPhysicalRows = 0
  for (const sourcePath of sourcePaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(sourcePath, {
        encoding: 'utf8',
        highWaterMark: 4 * 1024 * 1024,
      }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        malformedRows++
        continue
      }
      if (row?.modelName !== modelName || row?.embeddingType !== 'global') continue
      if (typeof row.imageId !== 'string') {
        malformedRows++
        continue
      }
      sourceRecordCount++
      const validation =
        row.dim === dim
          ? classifyEmbeddingVector(row.vector, dim)
          : { ok: false, issue: 'dimension-mismatch' }
      if (!validation.ok) invalidPhysicalRows++
      const key = embeddingPathKey(row.imageId)
      latest.delete(key)
      latest.set(key, {
        imageId: row.imageId,
        issue: validation.ok ? undefined : validation.issue,
      })
    }
  }
  return { latest, sourceRecordCount, malformedRows, invalidPhysicalRows }
}

async function collectClipChannelFailures(failurePath) {
  const failures = new Map()
  let malformedRows = 0
  if (!fs.existsSync(failurePath)) return { failures, malformedRows }
  const reader = readline.createInterface({
    input: fs.createReadStream(failurePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      malformedRows++
      continue
    }
    if (
      row?.modelName !== 'clip_vit_base_patch32' ||
      typeof row.imageId !== 'string' ||
      !CLIP_CHANNEL_FAILURE.test(String(row.error || ''))
    ) {
      continue
    }
    const key = embeddingPathKey(row.imageId)
    failures.delete(key)
    failures.set(key, row.imageId)
  }
  return { failures, malformedRows }
}

function candidateDescriptor(imageId) {
  try {
    const stat = fs.statSync(imageId)
    if (!stat.isFile()) return null
    return { imageId, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function previewToken(preview) {
  const contract = {
    schemaVersion: preview.schemaVersion,
    sources: preview.sources,
    failureLog: preview.failureLog,
    dinoCandidates: preview.models.dinov2_vitb14.candidates,
    clipCandidates: preview.models.clip_vit_base_patch32.candidates,
  }
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

async function createRepairPreview(userDataPath, classifyEmbeddingVector) {
  const vectorDb = path.join(userDataPath, 'vector-db')
  const failurePath = path.join(vectorDb, 'embedding_failures.jsonl')
  const dinoSources = embeddingSourcePaths(userDataPath, 'dinov2_vitb14')
  const clipSources = embeddingSourcePaths(userDataPath, 'clip_vit_base_patch32')
  if (dinoSources.length === 0 || clipSources.length === 0) {
    throw new Error('Both DINO and CLIP authoritative JSONL sources are required')
  }
  const dino = await collectCurrentVectorState(
    dinoSources,
    'dinov2_vitb14',
    768,
    classifyEmbeddingVector,
  )
  const clip = await collectCurrentVectorState(
    clipSources,
    'clip_vit_base_patch32',
    512,
    classifyEmbeddingVector,
  )
  const channelFailures = await collectClipChannelFailures(failurePath)

  const missingDinoFiles = []
  const dinoCandidates = []
  for (const state of dino.latest.values()) {
    if (state.issue !== 'zero-norm') continue
    const candidate = candidateDescriptor(state.imageId)
    if (candidate) dinoCandidates.push(candidate)
    else missingDinoFiles.push(state.imageId)
  }
  const missingClipFiles = []
  const alreadyValidClip = []
  const clipCandidates = []
  for (const [key, imageId] of channelFailures.failures) {
    if (!clip.latest.get(key)?.issue && clip.latest.has(key)) {
      alreadyValidClip.push(imageId)
      continue
    }
    const candidate = candidateDescriptor(imageId)
    if (candidate) clipCandidates.push(candidate)
    else missingClipFiles.push(imageId)
  }

  dinoCandidates.sort((left, right) =>
    embeddingPathKey(left.imageId).localeCompare(embeddingPathKey(right.imageId)),
  )
  clipCandidates.sort((left, right) =>
    embeddingPathKey(left.imageId).localeCompare(embeddingPathKey(right.imageId)),
  )
  const preview = {
    schemaVersion: REPAIR_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    userDataPath,
    sources: [...dinoSources, ...clipSources].map(fileDescriptor),
    failureLog: fs.existsSync(failurePath) ? fileDescriptor(failurePath) : null,
    models: {
      dinov2_vitb14: {
        dim: 768,
        sourceRecordCount: dino.sourceRecordCount,
        sourceEffectiveCount: dino.latest.size,
        invalidPhysicalRows: dino.invalidPhysicalRows,
        malformedRows: dino.malformedRows,
        zeroNormCurrent: [...dino.latest.values()].filter((state) => state.issue === 'zero-norm')
          .length,
        nonFiniteCurrent: [...dino.latest.values()].filter((state) => state.issue === 'non-finite')
          .length,
        dimensionMismatchCurrent: [...dino.latest.values()].filter(
          (state) => state.issue === 'dimension-mismatch',
        ).length,
        missingFiles: missingDinoFiles.length,
        candidates: dinoCandidates,
      },
      clip_vit_base_patch32: {
        dim: 512,
        sourceRecordCount: clip.sourceRecordCount,
        sourceEffectiveCount: clip.latest.size,
        invalidPhysicalRows: clip.invalidPhysicalRows,
        malformedRows: clip.malformedRows,
        zeroNormCurrent: [...clip.latest.values()].filter((state) => state.issue === 'zero-norm')
          .length,
        nonFiniteCurrent: [...clip.latest.values()].filter((state) => state.issue === 'non-finite')
          .length,
        dimensionMismatchCurrent: [...clip.latest.values()].filter(
          (state) => state.issue === 'dimension-mismatch',
        ).length,
        channelFailureRecords: channelFailures.failures.size,
        failureLogMalformedRows: channelFailures.malformedRows,
        alreadyValid: alreadyValidClip.length,
        missingFiles: missingClipFiles.length,
        candidates: clipCandidates,
      },
    },
  }
  return { ...preview, token: previewToken(preview) }
}

function assertRepairablePreview(preview) {
  const dino = preview.models.dinov2_vitb14
  const clip = preview.models.clip_vit_base_patch32
  if (
    dino.malformedRows !== 0 ||
    dino.missingFiles !== 0 ||
    dino.nonFiniteCurrent !== 0 ||
    dino.dimensionMismatchCurrent !== 0 ||
    dino.candidates.length !== dino.zeroNormCurrent
  ) {
    throw new Error('DINO preview contains damage outside the authorized zero-vector repair set')
  }
  if (
    clip.malformedRows !== 0 ||
    clip.failureLogMalformedRows !== 0 ||
    clip.missingFiles !== 0 ||
    clip.zeroNormCurrent !== 0 ||
    clip.nonFiniteCurrent !== 0 ||
    clip.dimensionMismatchCurrent !== 0 ||
    clip.candidates.length + clip.alreadyValid !== clip.channelFailureRecords
  ) {
    throw new Error(
      'CLIP preview contains damage outside the authorized channel-failure repair set',
    )
  }
}

function summarizePreview(preview) {
  return {
    schemaVersion: preview.schemaVersion,
    createdAt: preview.createdAt,
    token: preview.token,
    sourceReadOnly: true,
    models: Object.fromEntries(
      Object.entries(preview.models).map(([modelName, model]) => [
        modelName,
        { ...model, candidates: model.candidates.length },
      ]),
    ),
  }
}

function verifyPreviewInputs(preview) {
  if (!preview.sources.every(sameFileDescriptor)) {
    throw new Error('Embedding sources changed after preview; generate a new preview token')
  }
  if (preview.failureLog && !sameFileDescriptor(preview.failureLog)) {
    throw new Error('Embedding failure log changed after preview; generate a new preview token')
  }
  for (const model of Object.values(preview.models)) {
    for (const candidate of model.candidates) {
      if (!sameFileDescriptor({ path: candidate.imageId, ...candidate })) {
        throw new Error(`Candidate image changed after preview: ${candidate.imageId}`)
      }
    }
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  fs.renameSync(temporary, filePath)
}

function createElectronMock(options) {
  return {
    app: {
      isPackaged: false,
      getPath: () => options.userDataPath,
      getAppPath: () => options.appRoot,
    },
  }
}

function waitForEmbedding(service, state, options, modelName) {
  return new Promise((resolve, reject) => {
    let lastLogAt = 0
    const timer = setInterval(() => {
      const progress = service.getEmbeddingProgress()
      state.models[modelName] = { ...state.models[modelName], progress }
      writeState(options.stateFile, state)
      const now = Date.now()
      if (now - lastLogAt >= 30_000) {
        lastLogAt = now
        process.stderr.write(
          `[${modelName}] ${progress.state} ${progress.completed}/${progress.total} ` +
            `${Number(progress.itemsPerSecond || 0).toFixed(2)} items/s ${progress.currentPath || ''}\n`,
        )
      }
      if (progress.state === 'done') {
        clearInterval(timer)
        resolve(progress)
      } else if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.error || `${modelName} build failed`))
      }
    }, 1000)
  })
}

async function runModel(service, state, options, modelName, candidates) {
  state.phase = `embedding:${modelName}`
  state.models[modelName] = { candidates: candidates.length }
  writeState(options.stateFile, state)
  if (candidates.length === 0) return
  const started = await service.startEmbeddingBuild({
    modelName,
    embeddingType: 'global',
    imageIds: candidates.map((candidate) => candidate.imageId),
    backend: options.backend,
    maxConcurrentEmbeddings: options.jobs,
    batchSize: options.batchSize,
  })
  if (!started.ok) throw new Error(started.error || `${modelName} build did not start`)
  const progress = await waitForEmbedding(service, state, options, modelName)
  if (progress.failed > 0 || progress.completed !== candidates.length) {
    throw new Error(
      `${modelName} repair incomplete: ${progress.completed}/${candidates.length} completed, ${progress.failed} failed, ${progress.skipped} skipped`,
    )
  }
}

async function runMigration(state, options, vectorDb) {
  const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
  const cacheDir = path.join(options.userDataPath, 'vector-db', 'embedding-cache')
  const sources = MODEL_CONFIGS.map((model) => ({
    cacheDir,
    modelName: model.modelName,
    embeddingType: 'global',
    dim: model.dim,
    sourcePaths: vectorDb.getEmbeddingStorePaths(model.modelName, 'global'),
  }))
  const preview = migration.createVectorStoreMigrationPreview(options.userDataPath, sources)
  if (preview.models.length !== MODEL_CONFIGS.length) {
    throw new Error('Migration preview does not contain both vector models')
  }
  state.phase = 'vector-store-migration'
  state.migration = { preview }
  writeState(options.stateFile, state)
  const started = migration.startVectorStoreMigration(options.userDataPath, preview.token)
  if (!started.ok) throw new Error(started.error || 'Vector store migration did not start')
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const progress = migration.getVectorStoreMigrationProgress()
    state.migration = { preview, progress }
    writeState(options.stateFile, state)
    if (progress.state !== 'running') {
      if (progress.state !== 'completed') {
        throw new Error(progress.errors?.at(-1) || `Migration ended in ${progress.state}`)
      }
      return progress
    }
  }
}

function runRecallGate(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(options.appRoot, 'scripts', 'verify-vector-generation-recall.cjs'),
        options.userDataPath,
        '--queries=200',
        '--top-k=10',
      ],
      { cwd: options.appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      let report
      try {
        report = JSON.parse(stdout)
      } catch (error) {
        reject(new Error(`Recall gate returned invalid JSON: ${error.message}`))
        return
      }
      if (code !== 0 || !report.reports?.every((item) => item.gatePassed === true)) {
        reject(new Error(`Recall gate failed (exit ${code}): ${stderr.slice(-2000)}`))
        return
      }
      resolve(report)
    })
  })
}

function acquireLock(userDataPath) {
  const lockPath = path.join(userDataPath, 'value-automation', 'vector-coverage-repair.lock')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  if (fs.existsSync(lockPath)) {
    let ownerPid = 0
    try {
      ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid)
    } catch {
      /* An unreadable lock has no live owner evidence. */
    }
    let ownerAlive = false
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0)
        ownerAlive = true
      } catch {
        ownerAlive = false
      }
    }
    if (ownerAlive) throw new Error(`Vector coverage repair is already running as PID ${ownerPid}`)
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`)
  }
  let descriptor
  try {
    descriptor = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    )
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor)
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* The lock we created could not be cleaned up after its write failed. */
      }
    }
    throw new Error(`Vector coverage repair is already locked: ${error.message}`, { cause: error })
  }
  return () => {
    try {
      fs.closeSync(descriptor)
    } finally {
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* A stale lock is safer than overlapping a second real-data repair. */
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  validateOptions(options)
  const { classifyEmbeddingVector } = loadTsModule('electron/embeddingVectorValidation.ts')
  const preview = await createRepairPreview(options.userDataPath, classifyEmbeddingVector)
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify(summarizePreview(preview), null, 2)}\n`)
    return
  }
  if (options.confirm !== preview.token) {
    throw new Error('Preview token mismatch; no real vector data was changed')
  }
  assertRepairablePreview(preview)
  verifyPreviewInputs(preview)
  const releaseLock = acquireLock(options.userDataPath)
  const state = {
    schemaVersion: REPAIR_SCHEMA_VERSION,
    execute: true,
    preview: summarizePreview(preview),
    config: { backend: options.backend, jobs: options.jobs, batchSize: options.batchSize },
    phase: 'starting',
    models: {},
  }
  writeState(options.stateFile, state)
  const originalAppData = process.env.APPDATA
  const originalResourcesPath = process.resourcesPath
  const originalLoad = Module._load
  process.env.APPDATA = path.dirname(options.userDataPath)
  process.resourcesPath = options.childrenDir
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return createElectronMock(options)
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const modelService = loadTsModule('electron/modelService.ts')
    const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
    const embedding = loadTsModule('electron/embeddingService.ts')
    modelService.initModelService(options.userDataPath)
    vectorDb.initVectorDatabase(options.userDataPath)
    for (const model of MODEL_CONFIGS) {
      const status = modelService.getModelStatus(model.modelName)
      if (status.state !== 'downloaded') {
        throw new Error(`${model.modelName} is not ready: ${status.state} ${status.error || ''}`)
      }
      const candidates = preview.models[model.modelName].candidates
      for (const candidate of candidates) {
        if (!sameFileDescriptor({ path: candidate.imageId, ...candidate })) {
          throw new Error(
            `Candidate changed before ${model.modelName} repair: ${candidate.imageId}`,
          )
        }
      }
      await runModel(embedding, state, options, model.modelName, candidates)
      await vectorDb.embeddingStore.flush()
    }
    state.phase = 'post-repair-preview'
    writeState(options.stateFile, state)
    const repaired = await createRepairPreview(options.userDataPath, classifyEmbeddingVector)
    state.postRepair = summarizePreview(repaired)
    writeState(options.stateFile, state)
    if (
      repaired.models.dinov2_vitb14.candidates.length !== 0 ||
      repaired.models.clip_vit_base_patch32.candidates.length !== 0 ||
      repaired.models.dinov2_vitb14.zeroNormCurrent !== 0
    ) {
      throw new Error('Post-repair coverage preview still contains repair candidates')
    }
    state.generation = await runMigration(state, options, vectorDb)
    state.phase = 'recall-gate'
    writeState(options.stateFile, state)
    state.recall = await runRecallGate(options)
    state.phase = 'completed'
    state.completedAt = new Date().toISOString()
    writeState(options.stateFile, state)
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
  } catch (error) {
    state.phase = 'error'
    state.error = error instanceof Error ? error.message : String(error)
    writeState(options.stateFile, state)
    throw error
  } finally {
    Module._load = originalLoad
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    process.resourcesPath = originalResourcesPath
    releaseLock()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  CLIP_CHANNEL_FAILURE,
  REPAIR_SCHEMA_VERSION,
  assertRepairablePreview,
  collectClipChannelFailures,
  collectCurrentVectorState,
  createRepairPreview,
  embeddingPathKey,
  main,
  parseArgs,
  previewToken,
  summarizePreview,
  validateOptions,
  verifyPreviewInputs,
}
