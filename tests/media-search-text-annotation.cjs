const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const root = path.resolve(__dirname, '..')
const mediaDir = path.resolve(
  process.env.MEDIA_SEARCH_DIR ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'floating-clock-electron',
      'media-search',
    ),
)
const artifactDir = path.join(root, 'artifacts', 'media-search-text-annotation')
const datasetPath = path.join(artifactDir, 'dataset.json')
const judgmentsPath = path.join(artifactDir, 'judgments.json')
const judgmentEventsPath = path.join(artifactDir, 'judgment-events.jsonl')
const backupDir = path.join(artifactDir, 'backups')
const reportPath = path.join(artifactDir, 'evaluation.json')
const concepts = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'media-search-text-concepts.json'), 'utf8'),
)
const command = process.argv[2] || 'prepare'
const topPool = 60
const randomPool = 20

function keyOf(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function eachJsonLine(filePath, callback) {
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line) continue
    try {
      callback(JSON.parse(line))
    } catch {
      /* malformed rows are excluded from annotation candidates */
    }
  }
}

function normalize(input) {
  const vector = Float32Array.from(input, Number)
  let sum = 0
  for (const value of vector) sum += value * value
  if (!(sum > 0)) return null
  const scale = 1 / Math.sqrt(sum)
  for (let index = 0; index < vector.length; index += 1) vector[index] *= scale
  return vector
}

function dot(a, b) {
  let score = 0
  for (let index = 0; index < a.length; index += 1) score += a[index] * b[index]
  return score
}

function rank(entries, query, limit = topPool) {
  return entries
    .map((entry, index) => ({ index, score: dot(query, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function seededIndices(seedText, count, limit) {
  let state = Number.parseInt(
    crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8),
    16,
  )
  const values = new Set()
  while (values.size < Math.min(count, limit)) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values.add(state % limit)
  }
  return [...values]
}

async function embedQueries() {
  const transformers = await import('@huggingface/transformers')
  const modelRoot = path.join(root, 'ai-models', 'clip_vit_base_patch32')
  transformers.env.localModelPath = modelRoot
  transformers.env.cacheDir = path.join(modelRoot, '.transformers-cache')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false
  const tokenizer = await transformers.AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32')
  const model = await transformers.CLIPTextModelWithProjection.from_pretrained(
    'Xenova/clip-vit-base-patch32',
    { dtype: 'q4', device: 'cpu' },
  )
  const queries = concepts.flatMap((concept) => [concept.en, concept.zh])
  const prompts = queries.flatMap((query) => [`a photo of ${query}`, query])
  const output = await model(tokenizer(prompts, { padding: true, truncation: true }))
  const data = output.text_embeds.data
  const dim = output.text_embeds.dims[1]
  const vectors = []
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const pooled = new Array(dim).fill(0)
    for (let promptIndex = 0; promptIndex < 2; promptIndex += 1) {
      const start = (queryIndex * 2 + promptIndex) * dim
      const vector = normalize(Array.from(data).slice(start, start + dim))
      for (let index = 0; index < dim; index += 1) pooled[index] += vector[index] / 2
    }
    vectors.push(normalize(pooled))
  }
  return vectors
}

async function prepare() {
  const manifest = new Map()
  await eachJsonLine(path.join(mediaDir, 'manifests', 'video_frames.jsonl'), (row) => {
    if (row?.status !== 'done' || typeof row.imagePath !== 'string') return
    manifest.set(keyOf(row.imagePath), row)
  })
  const entries = []
  await eachJsonLine(path.join(mediaDir, 'vectors', 'frame_embedding_index.jsonl'), (row) => {
    if (row?.modelName !== 'clip_vit_base_patch32' || typeof row.imagePath !== 'string') return
    const frame = manifest.get(keyOf(row.imagePath))
    const vector = Array.isArray(row.vector) ? normalize(row.vector) : null
    if (!frame || !vector || vector.length !== 512 || !fs.existsSync(row.imagePath)) return
    entries.push({ frame, vector })
  })
  const queryVectors = await embedQueries()
  const outputConcepts = []
  for (let conceptIndex = 0; conceptIndex < concepts.length; conceptIndex += 1) {
    const concept = concepts[conceptIndex]
    const enRanking = rank(entries, queryVectors[conceptIndex * 2])
    const zhRanking = rank(entries, queryVectors[conceptIndex * 2 + 1])
    const candidates = new Map()
    const add = (entryIndex, source, score, rankValue) => {
      const entry = entries[entryIndex]
      const id = crypto
        .createHash('sha1')
        .update(keyOf(entry.frame.imagePath))
        .digest('hex')
        .slice(0, 16)
      const current = candidates.get(id) || {
        id,
        imagePath: entry.frame.imagePath,
        videoPath: entry.frame.videoPath,
        timestampMs: entry.frame.timestampMs,
        sources: [],
      }
      current.sources.push({ source, score, rank: rankValue })
      candidates.set(id, current)
    }
    enRanking.forEach((item, index) => add(item.index, 'clip_en', item.score, index + 1))
    zhRanking.forEach((item, index) => add(item.index, 'clip_zh', item.score, index + 1))
    const terms = concept.terms.map((term) => term.toLowerCase())
    entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        const text = `${entry.frame.videoPath || ''} ${entry.frame.imagePath}`.toLowerCase()
        return terms.some((term) => text.includes(term))
      })
      .slice(0, 40)
      .forEach(({ index }) => add(index, 'filename', undefined, undefined))
    seededIndices(concept.id, randomPool, entries.length).forEach((index) =>
      add(index, 'random', undefined, undefined),
    )
    outputConcepts.push({
      ...concept,
      rankings: {
        en: enRanking.map((item) => candidatesForRank(entries[item.index], item)),
        zh: zhRanking.map((item) => candidatesForRank(entries[item.index], item)),
      },
      candidates: [...candidates.values()].sort(
        (a, b) => bestRank(a.sources) - bestRank(b.sources),
      ),
    })
  }
  const dataset = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mediaDir,
    indexedFrames: entries.length,
    methodology:
      'Union of CLIP English Top60, CLIP Chinese Top60, filename hits, and 20 deterministic random negatives.',
    concepts: outputConcepts,
  }
  await fsp.mkdir(artifactDir, { recursive: true })
  await fsp.writeFile(datasetPath, JSON.stringify(dataset, null, 2), 'utf8')
  if (!fs.existsSync(judgmentsPath)) {
    await fsp.writeFile(
      judgmentsPath,
      JSON.stringify({ version: 1, judgments: {} }, null, 2),
      'utf8',
    )
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        datasetPath,
        concepts: outputConcepts.length,
        indexedFrames: entries.length,
        candidates: outputConcepts.reduce((sum, item) => sum + item.candidates.length, 0),
      },
      null,
      2,
    ),
  )
}

function candidatesForRank(entry, item) {
  return {
    id: crypto.createHash('sha1').update(keyOf(entry.frame.imagePath)).digest('hex').slice(0, 16),
    score: item.score,
  }
}

function bestRank(sources) {
  return Math.min(...sources.map((source) => source.rank || 1e9))
}

function candidateTier(candidate) {
  const rank = Math.min(
    ...candidate.sources
      .filter((source) => source.source === 'clip_en' || source.source === 'clip_zh')
      .map((source) => source.rank || Number.POSITIVE_INFINITY),
  )
  if (rank <= 10) return 0
  if (rank <= 20) return 1
  if (rank <= 50) return 2
  return 3
}

function fingerprintDataset(dataset) {
  const canonical = dataset.concepts.map((concept) => ({
    id: concept.id,
    candidates: concept.candidates.map((candidate) => candidate.id),
    rankings: {
      en: concept.rankings.en.map((item) => item.id),
      zh: concept.rankings.zh.map((item) => item.id),
    },
  }))
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function fingerprintJudgments(judgments) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(judgments.judgments || {}))
    .digest('hex')
}

function validateState(dataset, judgments) {
  const errors = []
  const warnings = []
  const conceptIds = new Set()
  const candidateIds = new Map()
  const missingFileExamples = []
  let missingFiles = 0
  let candidates = 0
  for (const concept of dataset.concepts) {
    if (conceptIds.has(concept.id)) errors.push(`duplicate concept: ${concept.id}`)
    conceptIds.add(concept.id)
    const ids = new Set()
    for (const candidate of concept.candidates) {
      candidates += 1
      if (ids.has(candidate.id)) errors.push(`duplicate candidate: ${concept.id}/${candidate.id}`)
      ids.add(candidate.id)
      if (!fs.existsSync(candidate.imagePath)) {
        missingFiles += 1
        if (missingFileExamples.length < 10) missingFileExamples.push(candidate.imagePath)
      }
    }
    candidateIds.set(concept.id, ids)
    for (const language of ['en', 'zh'])
      for (const item of concept.rankings[language])
        if (!ids.has(item.id))
          errors.push(`ranking outside pool: ${concept.id}/${language}/${item.id}`)
  }
  let judgmentsCount = 0
  let staleJudgments = 0
  for (const [conceptId, labels] of Object.entries(judgments.judgments || {})) {
    const ids = candidateIds.get(conceptId)
    if (!ids) {
      staleJudgments += Object.keys(labels).length
      warnings.push(`judgments for unknown concept: ${conceptId}`)
      continue
    }
    for (const [id, label] of Object.entries(labels)) {
      judgmentsCount += 1
      if (!ids.has(id)) {
        staleJudgments += 1
        continue
      }
      if (!['relevant', 'not_relevant', 'unsure'].includes(label))
        errors.push(`invalid judgment: ${conceptId}/${id}/${label}`)
    }
  }
  if (staleJudgments > 0) warnings.push(`${staleJudgments} stale judgments are ignored`)
  if (missingFiles > 0) errors.push(`${missingFiles} candidate image files are missing`)
  return {
    ok: errors.length === 0,
    datasetFingerprint: fingerprintDataset(dataset),
    judgmentFingerprint: fingerprintJudgments(judgments),
    candidates,
    judgments: judgmentsCount,
    staleJudgments,
    missingFiles,
    missingFileExamples,
    errors,
    warnings,
  }
}

function loadState() {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
  const judgments = JSON.parse(fs.readFileSync(judgmentsPath, 'utf8'))
  return { dataset, judgments, integrity: validateState(dataset, judgments) }
}

async function backupJudgments(reason = 'manual', currentState) {
  const state = currentState || loadState()
  await fsp.mkdir(backupDir, { recursive: true })
  const backups = (await fsp.readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^judgments-.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (reason === 'serve-start' && backups.length > 0) {
    try {
      const latest = JSON.parse(await fsp.readFile(path.join(backupDir, backups.at(-1)), 'utf8'))
      if (
        latest.datasetFingerprint === state.integrity.datasetFingerprint &&
        latest.judgmentFingerprint === state.integrity.judgmentFingerprint
      )
        return null
    } catch {
      /* an invalid old backup does not block creation of a new valid snapshot */
    }
  }
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const filePath = path.join(backupDir, `judgments-${timestamp}.json`)
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    reason,
    datasetFingerprint: state.integrity.datasetFingerprint,
    judgmentFingerprint: state.integrity.judgmentFingerprint,
    judgments: state.judgments,
  }
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
  backups.push(path.basename(filePath))
  for (const name of backups.slice(0, Math.max(0, backups.length - 20)))
    await fsp.unlink(path.join(backupDir, name))
  console.log(JSON.stringify({ backupPath: filePath, judgments: state.integrity.judgments }))
  return filePath
}

async function restoreJudgments(fileName, confirmed) {
  if (!fileName || !confirmed) throw new Error('Restore requires a backup file name and --confirm')
  const filePath = path.resolve(backupDir, fileName)
  const backupRoot = `${path.resolve(backupDir)}${path.sep}`
  if (!filePath.startsWith(backupRoot))
    throw new Error('Backup must be inside the backup directory')
  const current = loadState()
  const payload = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  if (payload.datasetFingerprint !== current.integrity.datasetFingerprint)
    throw new Error('Backup dataset fingerprint does not match the current dataset')
  const restoredJudgments = payload.judgments
  const restoredIntegrity = validateState(current.dataset, restoredJudgments)
  if (!restoredIntegrity.ok || restoredIntegrity.staleJudgments > 0)
    throw new Error(`Backup judgments failed validation: ${restoredIntegrity.errors.join('; ')}`)
  await backupJudgments('before-restore', current)
  const temporary = `${judgmentsPath}.${process.pid}.restore.tmp`
  await fsp.writeFile(temporary, JSON.stringify(restoredJudgments, null, 2), 'utf8')
  await fsp.rename(temporary, judgmentsPath)
  console.log(
    JSON.stringify({
      restoredFrom: filePath,
      judgments: restoredIntegrity.judgments,
      judgmentFingerprint: restoredIntegrity.judgmentFingerprint,
    }),
  )
}

async function appendJudgmentEvent(event) {
  try {
    const stat = await fsp.stat(judgmentEventsPath)
    if (stat.size >= 5 * 1024 * 1024) {
      const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      const archived = path.join(artifactDir, `judgment-events-${timestamp}.jsonl`)
      await fsp.rename(judgmentEventsPath, archived)
      const archives = (await fsp.readdir(artifactDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^judgment-events-.*\.jsonl$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
      for (const name of archives.slice(0, Math.max(0, archives.length - 5)))
        await fsp.unlink(path.join(artifactDir, name))
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fsp.appendFile(judgmentEventsPath, `${JSON.stringify(event)}\n`, 'utf8')
}

function metricForRanking(ranking, labels, totalRelevant, poolComplete, k) {
  const top = ranking.slice(0, k)
  const relevant = top.filter((item) => labels[item.id] === 'relevant').length
  const judged = top.filter((item) => labels[item.id] && labels[item.id] !== 'unsure').length
  let dcg = 0
  top.forEach((item, index) => {
    if (labels[item.id] === 'relevant') dcg += 1 / Math.log2(index + 2)
  })
  let ideal = 0
  for (let index = 0; index < Math.min(k, totalRelevant); index += 1)
    ideal += 1 / Math.log2(index + 2)
  return {
    precision: judged === top.length ? relevant / Math.max(1, top.length) : null,
    judgedPrecision: judged > 0 ? relevant / judged : null,
    pooledRecall: poolComplete && totalRelevant > 0 ? relevant / totalRelevant : null,
    ndcg: poolComplete && ideal > 0 ? dcg / ideal : null,
    judged,
    coverage: judged / Math.max(1, top.length),
    complete: judged === top.length,
  }
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function aggregateMetrics(concepts, language, k) {
  const metrics = concepts.map((concept) => concept[language][`@${k}`])
  const ready = metrics.filter((metric) => metric.complete)
  const poolReady = concepts.filter((concept) => concept.complete)
  return {
    readyConcepts: ready.length,
    totalConcepts: concepts.length,
    macroPrecision: average(
      ready.map((metric) => metric.precision).filter((value) => value !== null),
    ),
    macroJudgedPrecision: average(
      metrics.map((metric) => metric.judgedPrecision).filter((value) => value !== null),
    ),
    macroPooledRecall: average(
      poolReady
        .map((concept) => concept[language][`@${k}`].pooledRecall)
        .filter((value) => value !== null),
    ),
    macroNdcg: average(
      poolReady.map((concept) => concept[language][`@${k}`].ndcg).filter((value) => value !== null),
    ),
  }
}

async function evaluate() {
  const { dataset, judgments, integrity } = loadState()
  const result = []
  for (const concept of dataset.concepts) {
    const labels = judgments.judgments[concept.id] || {}
    const labelValues = concept.candidates.map((candidate) => labels[candidate.id])
    const relevant = labelValues.filter((label) => label === 'relevant').length
    const notRelevant = labelValues.filter((label) => label === 'not_relevant').length
    const unsure = labelValues.filter((label) => label === 'unsure').length
    const decided = relevant + notRelevant
    const poolComplete = decided === concept.candidates.length
    result.push({
      id: concept.id,
      labeled: decided + unsure,
      decided,
      unsure,
      candidates: concept.candidates.length,
      coverage: decided / Math.max(1, concept.candidates.length),
      complete: poolComplete,
      relevant,
      en: Object.fromEntries(
        [10, 20, 50].map((k) => [
          `@${k}`,
          metricForRanking(concept.rankings.en, labels, relevant, poolComplete, k),
        ]),
      ),
      zh: Object.fromEntries(
        [10, 20, 50].map((k) => [
          `@${k}`,
          metricForRanking(concept.rankings.zh, labels, relevant, poolComplete, k),
        ]),
      ),
    })
  }
  const total = result.reduce((sum, item) => sum + item.candidates, 0)
  const decided = result.reduce((sum, item) => sum + item.decided, 0)
  const aggregate = Object.fromEntries(
    ['en', 'zh'].map((language) => [
      language,
      Object.fromEntries([10, 20, 50].map((k) => [`@${k}`, aggregateMetrics(result, language, k)])),
    ]),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      concepts: result.length,
      readyConcepts: result.filter((item) => item.complete).length,
      candidates: total,
      decided,
      coverage: decided / Math.max(1, total),
      publishable: integrity.ok && result.every((item) => item.complete),
      warning:
        decided === total
          ? null
          : 'Accuracy metrics are provisional until every candidate has a relevant or not_relevant judgment.',
    },
    integrity,
    aggregate,
    concepts: result,
  }
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2))
}

function status() {
  const { dataset, judgments, integrity } = loadState()
  let decided = 0
  let unsure = 0
  const tiers = [
    { name: 'Top10', candidates: 0, decided: 0 },
    { name: 'Top20', candidates: 0, decided: 0 },
    { name: 'Top50', candidates: 0, decided: 0 },
    { name: 'Pool', candidates: 0, decided: 0 },
  ]
  for (const concept of dataset.concepts) {
    const labels = judgments.judgments[concept.id] || {}
    for (const candidate of concept.candidates) {
      const label = labels[candidate.id]
      const tier = tiers[candidateTier(candidate)]
      tier.candidates += 1
      if (label === 'relevant' || label === 'not_relevant') decided += 1
      else if (label === 'unsure') unsure += 1
      if (label === 'relevant' || label === 'not_relevant') tier.decided += 1
    }
  }
  console.log(
    JSON.stringify(
      {
        ...integrity,
        concepts: dataset.concepts.length,
        decided,
        unsure,
        coverage: decided / Math.max(1, integrity.candidates),
        tiers,
      },
      null,
      2,
    ),
  )
  if (!integrity.ok) process.exitCode = 1
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.png'
    ? 'image/png'
    : ext === '.gif'
      ? 'image/gif'
      : ext === '.webp'
        ? 'image/webp'
        : 'image/jpeg'
}

async function serve() {
  const html = fs.readFileSync(path.join(__dirname, 'media-search-text-annotation.html'), 'utf8')
  let state = loadState()
  if (!state.integrity.ok)
    throw new Error(
      `Annotation dataset failed integrity checks. Run annotation:text:status. ${state.integrity.errors.join('; ')}`,
    )
  if (state.integrity.judgments > 0) await backupJudgments('serve-start', state)
  let judgmentWriteQueue = Promise.resolve()
  const allowed = new Map()
  for (const concept of state.dataset.concepts)
    for (const item of concept.candidates) allowed.set(`${concept.id}:${item.id}`, item.imagePath)
  const handleRequest = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      return response.end(html)
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      return response.end(JSON.stringify(state))
    }
    if (request.method === 'GET' && url.pathname === '/frame') {
      const filePath = allowed.get(
        `${url.searchParams.get('concept')}:${url.searchParams.get('id')}`,
      )
      if (!filePath || !fs.existsSync(filePath)) {
        response.statusCode = 404
        return response.end('missing')
      }
      response.setHeader('Content-Type', contentType(filePath))
      const stream = fs.createReadStream(filePath)
      stream.on('error', (error) => {
        if (!response.headersSent) {
          response.statusCode = 404
          response.end('missing')
        } else response.destroy(error)
      })
      return stream.pipe(response)
    }
    if (request.method === 'POST' && url.pathname === '/api/judgment') {
      let body = ''
      try {
        for await (const chunk of request) {
          body += chunk
          if (body.length > 4096) throw new Error('request body too large')
        }
      } catch {
        response.statusCode = 413
        return response.end('invalid')
      }
      let value
      try {
        value = JSON.parse(body)
      } catch {
        response.statusCode = 400
        return response.end('invalid')
      }
      if (
        !value ||
        typeof value !== 'object' ||
        !allowed.has(`${value.conceptId}:${value.id}`) ||
        !['relevant', 'not_relevant', 'unsure', 'unlabeled'].includes(value.label)
      ) {
        response.statusCode = 400
        return response.end('invalid')
      }
      state.judgments.judgments[value.conceptId] ||= {}
      const previous = state.judgments.judgments[value.conceptId][value.id] || null
      if (value.label === 'unlabeled') delete state.judgments.judgments[value.conceptId][value.id]
      else state.judgments.judgments[value.conceptId][value.id] = value.label
      const snapshot = JSON.stringify(state.judgments, null, 2)
      judgmentWriteQueue = judgmentWriteQueue
        .catch(() => undefined)
        .then(async () => {
          const temporary = `${judgmentsPath}.${process.pid}.tmp`
          await fsp.writeFile(temporary, snapshot, 'utf8')
          await fsp.rename(temporary, judgmentsPath)
          const event = {
            at: new Date().toISOString(),
            datasetFingerprint: state.integrity.datasetFingerprint,
            conceptId: value.conceptId,
            id: value.id,
            previous,
            label: value.label === 'unlabeled' ? null : value.label,
          }
          try {
            await appendJudgmentEvent(event)
          } catch (error) {
            console.warn(`Could not append annotation audit event: ${error.message}`)
          }
        })
      await judgmentWriteQueue
      const next = value.label === 'unlabeled' ? null : value.label
      state.integrity = {
        ...state.integrity,
        judgments:
          state.integrity.judgments +
          (previous === null && next !== null ? 1 : 0) -
          (previous !== null && next === null ? 1 : 0),
        judgmentFingerprint: fingerprintJudgments(state.judgments),
      }
      return response.end('ok')
    }
    response.statusCode = 404
    response.end('not found')
  }
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
    )
    void handleRequest(request, response).catch((error) => {
      console.error(`Annotation request failed: ${error.stack || error.message}`)
      if (!response.headersSent) {
        response.statusCode = 500
        response.end('internal error')
      } else response.destroy(error)
    })
  })
  const port = Number(process.env.MEDIA_SEARCH_ANNOTATION_PORT || 41739)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  if (command === 'serve') {
    let shuttingDown = false
    const shutdown = async (signal) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`Annotation service received ${signal}; flushing pending judgments...`)
      server.close()
      await judgmentWriteQueue.catch((error) =>
        console.error(`Pending annotation write failed during shutdown: ${error.message}`),
      )
      server.closeAllConnections?.()
      console.log('Annotation service stopped cleanly.')
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
  }
  console.log(`Annotation UI: http://127.0.0.1:${port}`)
  return server
}

async function smoke() {
  const validFixture = {
    concepts: [
      {
        id: 'fixture',
        candidates: [{ id: 'a', imagePath: __filename }],
        rankings: { en: [{ id: 'a' }], zh: [{ id: 'a' }] },
      },
    ],
  }
  const validIntegrity = validateState(validFixture, {
    judgments: { fixture: { a: 'relevant' } },
  })
  const invalidLabelIntegrity = validateState(validFixture, {
    judgments: { fixture: { a: 'invalid' } },
  })
  const missingFileIntegrity = validateState(
    {
      concepts: [
        {
          ...validFixture.concepts[0],
          candidates: [{ id: 'a', imagePath: `${__filename}.missing` }],
        },
      ],
    },
    { judgments: {} },
  )
  if (!validIntegrity.ok || invalidLabelIntegrity.ok || missingFileIntegrity.ok)
    throw new Error('annotation integrity gate smoke failed')
  const partialMetric = metricForRanking([{ id: 'a' }, { id: 'b' }], { a: 'relevant' }, 1, false, 2)
  const completeMetric = metricForRanking(
    [{ id: 'a' }, { id: 'b' }],
    { a: 'relevant', b: 'not_relevant' },
    1,
    true,
    2,
  )
  if (
    partialMetric.precision !== null ||
    partialMetric.judgedPrecision !== 1 ||
    completeMetric.precision !== 0.5 ||
    completeMetric.pooledRecall !== 1
  )
    throw new Error('annotation metric readiness smoke failed')
  const aggregate = aggregateMetrics(
    [
      {
        complete: true,
        en: { '@10': completeMetric },
      },
    ],
    'en',
    10,
  )
  if (aggregate.readyConcepts !== 1 || aggregate.macroPrecision !== 0.5)
    throw new Error('annotation aggregate metric smoke failed')
  const server = await serve()
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const stateResponse = await fetch(`${baseUrl}/api/state`)
    const state = await stateResponse.json()
    if (!state.integrity.ok || state.integrity.candidates !== 1748)
      throw new Error('annotation dataset integrity smoke failed')
    const concept = state.dataset.concepts[0]
    const item = concept.candidates[0]
    const frameResponse = await fetch(
      `${baseUrl}/frame?concept=${encodeURIComponent(concept.id)}&id=${encodeURIComponent(item.id)}`,
    )
    const invalidResponse = await fetch(`${baseUrl}/api/judgment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    })
    const nullResponse = await fetch(`${baseUrl}/api/judgment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    const oversizedResponse = await fetch(`${baseUrl}/api/judgment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(5000) }),
    })
    if (
      !stateResponse.ok ||
      !frameResponse.ok ||
      invalidResponse.status !== 400 ||
      nullResponse.status !== 400 ||
      oversizedResponse.status !== 413 ||
      !stateResponse.headers.get('content-security-policy')
    )
      throw new Error('annotation HTTP smoke failed')
    console.log(
      JSON.stringify({
        concepts: state.dataset.concepts.length,
        candidates: state.dataset.concepts.reduce((sum, entry) => sum + entry.candidates.length, 0),
        frameBytes: (await frameResponse.arrayBuffer()).byteLength,
        invalidJsonStatus: invalidResponse.status,
        nullBodyStatus: nullResponse.status,
        oversizedBodyStatus: oversizedResponse.status,
        securityHeaders: 'ok',
        integrityGate: 'ok',
        metricReadiness: 'ok',
      }),
    )
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

if (command === 'prepare') prepare().catch(fail)
else if (command === 'serve') serve().catch(fail)
else if (command === 'evaluate') evaluate().catch(fail)
else if (command === 'status') status()
else if (command === 'backup') backupJudgments().catch(fail)
else if (command === 'restore')
  restoreJudgments(process.argv[3], process.argv.includes('--confirm')).catch(fail)
else if (command === 'smoke') smoke().catch(fail)
else
  fail(
    new Error(
      'Usage: node tests/media-search-text-annotation.cjs <prepare|serve|evaluate|status|backup|restore|smoke>',
    ),
  )

function fail(error) {
  console.error(error)
  process.exitCode = 1
}
