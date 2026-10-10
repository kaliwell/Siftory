const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { loadTsModule } = require('../tests/guard-utils.cjs')

const MODEL_CONFIGS = [
  { modelName: 'dinov2_vitb14', dim: 768 },
  { modelName: 'clip_vit_base_patch32', dim: 512 },
]

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function isWholeDrive(candidate) {
  return /^[a-z]:[\\/]?$/i.test(path.resolve(candidate))
}

function parseArgs(argv) {
  const userDataPath = path.resolve(
    option(argv, 'user-data', path.join(process.env.APPDATA || '', 'floating-clock-electron')),
  )
  const scanPaths = argv
    .filter((value) => value.startsWith('--scan-path='))
    .map((value) => path.resolve(value.slice('--scan-path='.length)))
  return {
    execute: argv.includes('--execute'),
    allowWholeDrive: argv.includes('--allow-whole-drive'),
    userDataPath,
    scanPaths,
    backend: option(argv, 'backend', 'gpu'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize: Math.max(0, Math.min(16, Number(option(argv, 'batch-size', '0')) || 0)),
    maxFailures: Math.max(0, Number(option(argv, 'max-failures', '1000')) || 0),
    maxFailureRate: Math.max(0, Math.min(1, Number(option(argv, 'max-failure-rate', '0.01')) || 0)),
    appRoot: path.resolve(option(argv, 'app-root', path.join(__dirname, '..'))),
    childrenDir: path.resolve(
      option(argv, 'children-dir', path.join(__dirname, '..', 'dist-electron')),
    ),
    stateFile: path.resolve(
      option(
        argv,
        'state-file',
        path.join(userDataPath, 'value-automation', 'vector-rebuild-state.json'),
      ),
    ),
  }
}

function validateOptions(options) {
  if (path.basename(options.userDataPath).toLowerCase() !== 'floating-clock-electron') {
    throw new Error('The user-data directory must end in floating-clock-electron')
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (options.scanPaths.length === 0) throw new Error('Pass at least one --scan-path=<directory>')
  for (const scanPath of options.scanPaths) {
    if (!fs.existsSync(scanPath) || !fs.statSync(scanPath).isDirectory()) {
      throw new Error(`Scan directory does not exist: ${scanPath}`)
    }
    if (isWholeDrive(scanPath) && !options.allowWholeDrive) {
      throw new Error('Whole-drive rebuild requires --allow-whole-drive')
    }
  }
  for (const child of [
    'embeddingPreparationChild.js',
    'dinoEmbeddingChild.js',
    'clipEmbeddingChild.js',
  ]) {
    if (!fs.existsSync(path.join(options.childrenDir, child))) {
      throw new Error(`Compiled child is missing: ${path.join(options.childrenDir, child)}`)
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
      state.models[modelName] = { ...progress }
      writeState(options.stateFile, state)
      const now = Date.now()
      if (now - lastLogAt >= 30_000) {
        lastLogAt = now
        process.stderr.write(
          `[${modelName}] ${progress.state} ${progress.completed}/${progress.total} ` +
            `${Number(progress.itemsPerSecond || 0).toFixed(2)} items/s ` +
            `${progress.currentPath || ''}\n`,
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

async function runModel(service, state, options, modelName) {
  state.phase = `embedding:${modelName}`
  writeState(options.stateFile, state)
  let preparationDone = false
  const preparationTimer = setInterval(() => {
    if (preparationDone) return
    const progress = service.getEmbeddingProgress()
    state.models[modelName] = { ...progress }
    writeState(options.stateFile, state)
  }, 1000)
  const started = await service.startEmbeddingBuild({
    modelName,
    embeddingType: 'global',
    scanPaths: options.scanPaths,
    backend: options.backend,
    maxConcurrentEmbeddings: options.jobs,
    batchSize: options.batchSize,
  })
  preparationDone = true
  clearInterval(preparationTimer)
  if (!started.ok) throw new Error(started.error || `${modelName} build did not start`)
  const progress = await waitForEmbedding(service, state, options, modelName)
  const failureBudget = Math.min(
    options.maxFailures,
    Math.max(0, Math.ceil(progress.total * options.maxFailureRate)),
  )
  state.models[modelName] = { ...progress, failureBudget }
  writeState(options.stateFile, state)
  if (progress.failed > failureBudget) {
    throw new Error(
      `${modelName} finished with ${progress.failed} failures (budget ${failureBudget})`,
    )
  }
}

async function runMigration(state, options, vectorDb) {
  const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
  const vectorDbDir = path.join(options.userDataPath, 'vector-db')
  const cacheDir = path.join(vectorDbDir, 'embedding-cache')
  const sources = MODEL_CONFIGS.map((model) => ({
    cacheDir,
    modelName: model.modelName,
    embeddingType: 'global',
    dim: model.dim,
    sourcePaths: vectorDb.getEmbeddingStorePaths(model.modelName, 'global'),
  }))
  const preview = migration.createVectorStoreMigrationPreview(options.userDataPath, sources)
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
        throw new Error(progress.error || `Migration ended in ${progress.state}`)
      }
      return
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  validateOptions(options)
  const state = {
    schemaVersion: 1,
    execute: options.execute,
    sourceReadOnly: true,
    userDataPath: options.userDataPath,
    scanPaths: options.scanPaths,
    config: {
      backend: options.backend,
      jobs: options.jobs,
      batchSize: options.batchSize,
      maxFailures: options.maxFailures,
      maxFailureRate: options.maxFailureRate,
    },
    phase: 'preview',
    models: {},
  }
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }

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
    const vectorIndex = loadTsModule('electron/vectorIndexService.ts')
    modelService.initModelService(options.userDataPath)
    vectorDb.initVectorDatabase(options.userDataPath)
    for (const { modelName } of MODEL_CONFIGS) {
      const status = modelService.getModelStatus(modelName)
      if (status.state !== 'downloaded') {
        throw new Error(`${modelName} is not ready: ${status.state} ${status.error || ''}`)
      }
      await runModel(embedding, state, options, modelName)
    }
    await vectorDb.embeddingStore.flush()
    await runMigration(state, options, vectorDb)
    state.phase = 'ann-index'
    writeState(options.stateFile, state)
    const built = await vectorIndex.buildVectorIndex('dinov2_vitb14')
    if (!built.ok) throw new Error(built.error || 'ANN build failed')
    state.phase = 'completed'
    state.completedAt = new Date().toISOString()
    state.ann = built
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
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { isWholeDrive, main, parseArgs, validateOptions }
