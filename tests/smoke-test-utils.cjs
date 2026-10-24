const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SMOKE_SESSION_MARKER = '.floating-clock-smoke-session.json'
const SMOKE_ENVIRONMENT_KEYS = [
  'SIFTORY_PACKAGED_VALIDATION',
  'FLOATING_CLOCK_UI_SMOKE_REPORT',
  'FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT',
  'FLOATING_CLOCK_UI_SMOKE_USER_DATA',
  'FLOATING_CLOCK_SMOKE_SESSION_NONCE',
  'FLOATING_CLOCK_UI_SMOKE_ALLOW_NO_SANDBOX',
  'FLOATING_CLOCK_REQUIRE_SANDBOX',
  'FLOATING_CLOCK_UI_SMOKE_SCREENSHOT',
  'FLOATING_CLOCK_UI_SMOKE_LOCALE',
  'FLOATING_CLOCK_UI_SMOKE_SURFACE',
  'FLOATING_CLOCK_UI_SMOKE_VIEWPORT',
  'FLOATING_CLOCK_UI_SMOKE_SCALE',
  'FLOATING_CLOCK_UI_SMOKE_WORK_AREA',
  'FLOATING_CLOCK_UI_SMOKE_CHURN_CYCLES',
  'FLOATING_CLOCK_UI_SMOKE_LISTENER_DIAGNOSTICS',
  'FLOATING_CLOCK_UI_SMOKE_FILE_FIXTURE_BYTES',
  'FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_MANIFEST',
  'FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_JOBS',
  'FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BATCH',
  'FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_POLLS',
  'FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND',
  'FLOATING_CLOCK_AI_CONTROL_SMOKE_SEMANTIC_QUERY',
  'FLOATING_CLOCK_AI_CONTROL_SMOKE_MODEL_SOURCE',
]
const CLIP_MODEL = 'clip_vit_base_patch32'
const CLIP_TYPE = 'global'
const CLIP_CACHE_BASE = `${CLIP_MODEL}__${CLIP_TYPE}`
const CLIP_DIMENSION = 512
const MAX_CLIP_CACHE_ROWS = 1_000_000
const MAX_CLIP_CACHE_VECTOR_BYTES = 512 * 1024 * 1024
const MAX_CLIP_CACHE_PATH_BYTES = 256 * 1024 * 1024
const SMOKE_EMBEDDED_PATH_PATTERN =
  /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|root|tmp|var|etc|mnt|volumes)\/)[^\r\n"']*/gi
const SMOKE_SECRET_PATTERN =
  /\b(password|passphrase|token|secret|private[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi

function redactSmokeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replaceAll('\u0000', '')
    .replace(SMOKE_SECRET_PATTERN, '$1=[redacted]')
    .replace(SMOKE_EMBEDDED_PATH_PATTERN, '[path]')
}

function embeddingF16CacheApi() {
  // Keep the smoke helper aligned with the cache reader's schema and Float16
  // decoder. This is deliberately lazy: ordinary UI smoke tests do not need
  // to transpile Electron TypeScript just to make a temporary marker.
  const { loadTsModule } = require('./guard-utils.cjs')
  return loadTsModule('electron/embeddingF16Cache.ts')
}

function isNestedPath(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function assertTemporaryDirectory(directory) {
  const resolvedTemp = fs.realpathSync(os.tmpdir())
  const resolvedDirectory = fs.realpathSync(directory)
  if (!isNestedPath(resolvedTemp, resolvedDirectory)) {
    throw new Error(`Smoke directory must be below the system temp directory: ${directory}`)
  }
}

function resolveUiSmokeExecutable({ repo, packaged, packagedDirectory, developmentExecutable }) {
  if (packagedDirectory && !packaged) {
    throw new Error('--packaged-dir requires --packaged')
  }
  if (!packaged) return developmentExecutable
  const directory = fs.realpathSync(packagedDirectory || path.join(repo, 'release', 'win-unpacked'))
  if (!fs.statSync(directory).isDirectory())
    throw new Error('Packaged smoke root is not a directory')
  const executable = path.join(directory, 'Siftory.exe')
  for (const file of [executable, path.join(directory, 'resources', 'app.asar')]) {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error('Packaged smoke requires regular Siftory.exe and resources/app.asar files')
    }
  }
  return executable
}

function createSmokeSessionMarker(userDataPath, runner) {
  if (runner !== 'ui' && runner !== 'ai-control' && runner !== 'packaged') {
    throw new Error(`Unsupported smoke runner: ${runner}`)
  }
  fs.mkdirSync(userDataPath, { recursive: true })
  assertTemporaryDirectory(userDataPath)
  const nonce = crypto.randomBytes(32).toString('hex')
  const markerPath = path.join(userDataPath, SMOKE_SESSION_MARKER)
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ version: 1, runner, nonce, createdAt: Date.now() }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  return nonce
}

function createUiSmokeFileFixture(tempRoot) {
  assertTemporaryDirectory(tempRoot)
  const directory = path.join(fs.realpathSync(tempRoot), 'file-manager-fixture')
  fs.mkdirSync(directory)
  const files = [
    { path: 'sample.txt', bytes: 128 },
    { path: 'Small files/sample.bin', bytes: 512 },
    { path: 'Nested files/Child/sample.txt', bytes: 256 },
  ].map((entry) => {
    const target = path.join(directory, entry.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const content = Buffer.alloc(entry.bytes, 65)
    fs.writeFileSync(target, content, { flag: 'wx' })
    return { ...entry, sha256: crypto.createHash('sha256').update(content).digest('hex') }
  })
  return { directory, files, totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0) }
}

function verifyUiSmokeFileFixture(fixture) {
  try {
    assertTemporaryDirectory(fixture.directory)
    const root = fs.realpathSync(fixture.directory)
    return fixture.files.every((entry) => {
      const target = path.join(root, entry.path)
      return (
        isNestedPath(root, target) &&
        fs.realpathSync(target) === target &&
        fs.lstatSync(target).isFile() &&
        fs.statSync(target).size === entry.bytes &&
        crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === entry.sha256
      )
    })
  } catch {
    return false
  }
}

function createSmokeSpawnEnvironment(overrides) {
  const env = { ...process.env }
  for (const key of SMOKE_ENVIRONMENT_KEYS) delete env[key]
  Object.assign(env, overrides)
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
  if (pathKeys.length > 1) {
    const value = pathKeys.map((key) => env[key] || '').sort((a, b) => b.length - a.length)[0]
    for (const key of pathKeys) delete env[key]
    env.Path = value
  }
  return env
}

function captureDirectoryState(root) {
  const records = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
      const stat = fs.lstatSync(absolutePath)
      if (entry.isDirectory()) {
        visit(absolutePath)
      } else if (entry.isFile()) {
        records.push({ path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs })
      } else {
        records.push({ path: relativePath, type: 'non-file', mtimeMs: stat.mtimeMs })
      }
    }
  }
  visit(root)
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

function copyIndependentFile(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  const sourceStat = fs.statSync(source, { bigint: true })
  const destinationStat = fs.statSync(destination, { bigint: true })
  if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
    throw new Error(`Writable semantic cache snapshot unexpectedly aliases production: ${source}`)
  }
}

function copyIndependentDirectory(source, destination) {
  const sourceStat = fs.lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Semantic model source is not a real directory: ${source}`)
  }
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) copyIndependentDirectory(sourcePath, destinationPath)
    else if (entry.isFile()) copyIndependentFile(sourcePath, destinationPath)
    else throw new Error(`Semantic model source contains a non-file entry: ${sourcePath}`)
  }
}

function readStrictClipCacheMetadata(metadataPath, acceptedVersions) {
  const metadataStat = fs.lstatSync(metadataPath)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error('Production CLIP cache metadata is not a regular file')
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  if (
    !acceptedVersions.includes(metadata.version) ||
    metadata.modelName !== CLIP_MODEL ||
    metadata.embeddingType !== CLIP_TYPE ||
    metadata.dim !== CLIP_DIMENSION ||
    !Number.isSafeInteger(metadata.count) ||
    metadata.count <= 0 ||
    metadata.count > MAX_CLIP_CACHE_ROWS
  ) {
    throw new Error('Production CLIP cache metadata is missing or incompatible')
  }
  return metadata
}

function validateStrictClipCache(vectorPath, pathsPath, metadata, cacheApi) {
  const expectedBytes = metadata.count * metadata.dim * 2
  const vectorStat = fs.lstatSync(vectorPath)
  const pathsStat = fs.lstatSync(pathsPath)
  if (
    !vectorStat.isFile() ||
    vectorStat.isSymbolicLink() ||
    !pathsStat.isFile() ||
    pathsStat.isSymbolicLink() ||
    vectorStat.size !== expectedBytes ||
    expectedBytes > MAX_CLIP_CACHE_VECTOR_BYTES ||
    pathsStat.size > MAX_CLIP_CACHE_PATH_BYTES
  ) {
    throw new Error('Production CLIP cache files are missing or incompatible')
  }

  const lines = fs.readFileSync(pathsPath, 'utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== metadata.count || pathsStat.size <= 0) {
    throw new Error('Production CLIP cache path rows do not match metadata')
  }
  const rows = new Uint8Array(metadata.count)
  const paths = new Set()
  for (const line of lines) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('Production CLIP cache contains an invalid path row')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(value, 'row') ||
      !Object.prototype.hasOwnProperty.call(value, 'path') ||
      !Number.isInteger(value.row) ||
      value.row < 0 ||
      value.row >= metadata.count ||
      typeof value.path !== 'string' ||
      value.path.trim().length === 0 ||
      rows[value.row] !== 0 ||
      paths.has(cacheApi.embeddingCachePathKey(value.path))
    ) {
      throw new Error('Production CLIP cache contains an invalid path row')
    }
    rows[value.row] = 1
    paths.add(cacheApi.embeddingCachePathKey(value.path))
  }
  if (rows.some((value) => value === 0)) {
    throw new Error('Production CLIP cache path rows do not cover every vector')
  }

  const vectors = fs.readFileSync(vectorPath)
  for (let row = 0; row < metadata.count; row++) {
    let nonZero = false
    const offset = row * metadata.dim * 2
    for (let column = 0; column < metadata.dim; column++) {
      const value = cacheApi.float16ToFloat32(vectors.readUInt16LE(offset + column * 2))
      if (!Number.isFinite(value)) {
        throw new Error('Production CLIP cache contains a non-finite vector')
      }
      if (value !== 0) nonZero = true
    }
    if (!nonZero) throw new Error('Production CLIP cache contains a zero-norm vector')
  }
}

function createIsolatedRealSemanticSnapshot(
  sourceVectorDb,
  destinationVectorDb,
  sourceSemanticModelDirectory,
) {
  const sourceRoot = fs.realpathSync(sourceVectorDb)
  fs.mkdirSync(destinationVectorDb, { recursive: true })
  assertTemporaryDirectory(destinationVectorDb)
  const destinationRoot = fs.realpathSync(destinationVectorDb)
  if (sourceRoot === destinationRoot || isNestedPath(sourceRoot, destinationRoot)) {
    throw new Error('Semantic snapshot destination must not alias or nest inside production data')
  }

  const destinationEmbeddings = path.join(destinationRoot, 'embeddings')
  const destinationCache = path.join(destinationRoot, 'embedding-cache')
  fs.mkdirSync(destinationEmbeddings, { recursive: true })
  fs.mkdirSync(destinationCache, { recursive: true })

  const sourceShard = path.join(sourceRoot, 'embeddings', `${CLIP_CACHE_BASE}.jsonl`)
  const sourceShardStat = fs.lstatSync(sourceShard)
  if (!sourceShardStat.isFile() || sourceShardStat.isSymbolicLink()) {
    throw new Error(`Production CLIP shard is not a regular file: ${sourceShard}`)
  }
  // A placeholder is sufficient because the independent F16 cache below is
  // validated against rewritten temp-only source metadata before use. Never
  // create a hardlink that could turn an accidental append into a production
  // data mutation.
  const destinationShard = path.join(destinationEmbeddings, path.basename(sourceShard))
  fs.writeFileSync(destinationShard, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const sourceFiles = [destinationShard]

  const sourceCache = path.join(sourceRoot, 'embedding-cache')
  const cacheVectors = `${CLIP_CACHE_BASE}.f16`
  const cachePaths = `${CLIP_CACHE_BASE}.paths.jsonl`
  const cacheMetadata = `${CLIP_CACHE_BASE}.f16.json`
  const cacheApi = embeddingF16CacheApi()
  const { EMBEDDING_F16_CACHE_VERSION } = cacheApi
  const sourceVectors = path.join(sourceCache, cacheVectors)
  const sourcePaths = path.join(sourceCache, cachePaths)
  const sourceMetadata = path.join(sourceCache, cacheMetadata)
  const validatedMetadata = readStrictClipCacheMetadata(sourceMetadata, [
    1,
    EMBEDDING_F16_CACHE_VERSION,
  ])
  validateStrictClipCache(sourceVectors, sourcePaths, validatedMetadata, cacheApi)

  const destinationVectors = path.join(destinationCache, cacheVectors)
  const destinationPaths = path.join(destinationCache, cachePaths)
  copyIndependentFile(sourceVectors, destinationVectors)
  copyIndependentFile(sourcePaths, destinationPaths)
  // Validate the copies too. Do not make a temp cache discoverable at the
  // current schema version until its metadata, paths, and every decoded
  // Float16 row form one complete set.
  validateStrictClipCache(destinationVectors, destinationPaths, validatedMetadata, cacheApi)
  // Version-3 derived metas must carry the committed content proof of the
  // copied segments (VAL-038); compute it from the validated copies.
  const sha256File = (filePath) =>
    crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  const isolatedMetadata = {
    ...validatedMetadata,
    version: EMBEDDING_F16_CACHE_VERSION,
    sourceFiles: sourceFiles.map((sourcePath) => {
      const stat = fs.statSync(sourcePath)
      return { path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs }
    }),
    updatedAt: Date.now(),
    integrity: {
      vectorsSha256: sha256File(destinationVectors),
      pathsSha256: sha256File(destinationPaths),
    },
  }
  fs.writeFileSync(
    path.join(destinationCache, cacheMetadata),
    JSON.stringify(isolatedMetadata, null, 2),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )

  const sourceModelDirectory = fs.realpathSync(sourceSemanticModelDirectory)
  const destinationModelDirectory = path.join(path.dirname(destinationRoot), 'models', CLIP_MODEL)
  copyIndependentDirectory(sourceModelDirectory, destinationModelDirectory)
  return {
    count: isolatedMetadata.count,
    sourceFiles: [...sourceFiles],
    sourceModelDirectory,
  }
}

module.exports = {
  SMOKE_SESSION_MARKER,
  assertTemporaryDirectory,
  captureDirectoryState,
  createIsolatedRealSemanticSnapshot,
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  createUiSmokeFileFixture,
  verifyUiSmokeFileFixture,
  redactSmokeText,
  resolveUiSmokeExecutable,
}
