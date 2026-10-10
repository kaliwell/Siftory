// NekoSearch (smart asset classification) accuracy benchmark + regression gate.
//
// Usage:
//   node tests/neko-search-accuracy-benchmark.cjs [options]
//
// Options:
//   --help                     Print this usage text and exit.
//   --gate                     Compare against docs/benchmark/neko-search-accuracy-baseline.json;
//                              exit 1 when any gated metric regresses.
//   --write-baseline           Write the current macro metrics as the gate baseline.
//   --variants a,b,c           Subset of: clip,dino,hybrid,hybrid_feedback (default: all).
//   --allow-partial            Continue with partially judged pools (report marked provisional).
//   --runs=N                   Cold and warm exact-scan repetitions (minimum/default: 3).
//
// Readiness:
//   Requires the annotation artifacts produced by the parallel annotation tooling:
//   dataset.json / judgments.json under $NEKO_SEARCH_ANNOTATION_DIR
//   (default: <repo>/artifacts/neko-search-annotation). Missing data or
//   unjudged pools exit with code 2. The benchmark never writes to the
//   userData directory. It reads an authoritative generation or the latest
//   complete F16 snapshot and never rebuilds caches or feedback state.
//
// Leakage boundary (also embedded in the report): hybrid_feedback negative
// samples come from the annotation/review set itself and overlap the seeded
// labels, so its metrics are optimistically biased by construction — treat
// them as trend reference only. `hybrid` is the primary gated variant.

const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')
const binaryRuntime = require('./neko-search-binary-runtime.cjs')

const repoRoot = path.resolve(__dirname, '..')
const annotationDir = path.resolve(
  process.env.NEKO_SEARCH_ANNOTATION_DIR ||
    path.join(repoRoot, 'artifacts', 'neko-search-annotation'),
)
const userDataDir = path.resolve(
  process.env.NEKO_SEARCH_USER_DATA ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'floating-clock-electron',
    ),
)
const datasetPath = path.join(annotationDir, 'dataset.json')
const judgmentsPath = path.join(annotationDir, 'judgments.json')
const feedbackManifestPath = path.join(
  userDataDir,
  'asset-library',
  'search-feedback',
  'manifest.json',
)
const feedbackStatePath = path.join(userDataDir, 'asset-library', 'search-feedback', 'state.json')
const baselinePath = path.join(repoRoot, 'docs', 'benchmark', 'neko-search-accuracy-baseline.json')
const reportDir = path.join(repoRoot, 'artifacts', 'neko-search-accuracy')

const ALL_VARIANTS = ['clip', 'dino', 'hybrid', 'hybrid_feedback']
const TOP_KS = [20, 50]
const CLIP_MODEL = 'clip_vit_base_patch32'
const DINO_MODEL = 'dinov2_vitb14'
const DINO_DIM = 768
const CLIP_DIM = 512
const CLIP_WEIGHT = 0.25 // mirrors electron/dinoCategoryRerankService.ts
const DINO_WEIGHT = 0.75
const NEGATIVE_SUPPRESSION = 0.65 // mirrors scoreAssetFeedbackTarget discriminative signal

const LEAKAGE_NOTE =
  'hybrid_feedback 的负样本来自标注/审核集，与 seeded 标签重叠，指标偏高属预期，仅作趋势参考；' +
  'hybrid 为主门禁变体。留一法 AUC 仅为审核集诊断，不代表全库精度。'

const GATE_THRESHOLDS = {
  ndcgAt20RelativeDrop: 0.02, // nDCG@20 relative drop > 2%
  precisionAt20DropPoints: 0.02, // Precision@20 absolute drop > 2pt
  recallAt50DropPoints: 0.01, // Recall@50 absolute drop > 1pt
  rejectIntrusionAt20Absolute: 0.05, // Reject intrusion@20 above 5%
  rejectIntrusionAt20RisePoints: 0.01, // or +1pt over baseline
  scanP95SlowdownFactor: 1.5, // p95 scan latency > 1.5x baseline
  scanP95AbsoluteMs: 40_000, // engineering budget with room below the 55,477ms recovery ceiling
  clusterPurityMedianWarnBelow: 0.8, // warning only
}

function parseArgs(argv) {
  const args = {
    gate: false,
    writeBaseline: false,
    allowPartial: false,
    help: false,
    category: null,
    variants: [...ALL_VARIANTS],
    runs: 3,
  }
  for (const arg of argv) {
    if (arg === '--gate') args.gate = true
    else if (arg === '--write-baseline') args.writeBaseline = true
    else if (arg === '--allow-partial') args.allowPartial = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('--category=')) {
      const value = arg.slice('--category='.length).trim()
      if (!value) throw new Error('--category requires a category id or name')
      args.category = value
    } else if (arg.startsWith('--runs=')) {
      const value = Number(arg.slice('--runs='.length))
      if (!Number.isInteger(value) || value < 3 || value > 10) {
        throw new Error('--runs must be an integer between 3 and 10')
      }
      args.runs = value
    } else if (arg.startsWith('--variants=')) {
      const requested = arg
        .slice('--variants='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const unknown = requested.filter((value) => !ALL_VARIANTS.includes(value))
      if (requested.length === 0 || unknown.length > 0) {
        throw new Error(`Unknown --variants entries: ${unknown.join(', ') || '(empty)'}`)
      }
      args.variants = ALL_VARIANTS.filter((value) => requested.includes(value))
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function printUsage() {
  console.log(`NekoSearch accuracy benchmark + regression gate

Usage: node tests/neko-search-accuracy-benchmark.cjs [options]

Options:
  --help               Print this usage text and exit.
  --gate               Compare against docs/benchmark/neko-search-accuracy-baseline.json;
                       exit 1 when any gated metric regresses.
  --write-baseline     Write the current macro metrics as the gate baseline.
  --category id|name   Evaluate a single category only (default: all).
  --variants a,b,c     Subset of: ${ALL_VARIANTS.join(',')} (default: all).
  --allow-partial      Continue with partially judged pools (report marked provisional).
  --runs=N             Cold and warm exact-scan repetitions (minimum/default: 3).

Inputs:
  NEKO_SEARCH_ANNOTATION_DIR  Annotation dir with dataset.json + judgments.json
                              (default: <repo>/artifacts/neko-search-annotation).
  NEKO_SEARCH_USER_DATA       Asset library root (default: %APPDATA%/floating-clock-electron).

Exit codes: 0 ok / gate passed, 1 error or gate failure, 2 annotation data not ready.
Run the annotation:neko:prepare flow and finish labeling before benchmarking.`)
}

function pathKey(filePath) {
  return String(filePath).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function nowMs() {
  return performance.now()
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

// ── Bounded min-heap for library Top-N (memory-bounded scan) ─────────────

// ── Annotation loading / readiness gate ──────────────────────────────────

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function loadAnnotationsOrExit() {
  const missing = [datasetPath, judgmentsPath].filter((filePath) => !fs.existsSync(filePath))
  if (missing.length > 0) {
    console.error('标注数据缺失，无法运行准确率基准：')
    for (const filePath of missing) console.error(`  缺少 ${filePath}`)
    console.error('先运行 annotation:neko:prepare 并完成标注，再运行本基准。')
    process.exit(2)
  }
  let dataset
  let judgments
  try {
    dataset = readJsonFile(datasetPath)
    judgments = readJsonFile(judgmentsPath)
  } catch (error) {
    console.error(`标注数据解析失败：${error.message}`)
    console.error('先运行 annotation:neko:prepare 并完成标注，再运行本基准。')
    process.exit(2)
  }
  if (
    !dataset ||
    !Array.isArray(dataset.categories) ||
    !judgments ||
    typeof judgments !== 'object'
  ) {
    console.error('标注数据格式不符合契约（缺少 categories 或 judgments）。')
    process.exit(2)
  }
  return { dataset, judgmentBook: judgments.judgments || {} }
}

// Per category, every pool candidate must carry a relevant/not_relevant label.
// `unsure` and missing entries count as unjudged; seeded labels count as judged
// but are reported separately.
function checkPoolCompleteness(dataset, judgmentBook, allowPartial) {
  const gaps = []
  for (const category of dataset.categories) {
    const judged = judgmentBook[String(category.id)] || {}
    const candidates = Array.isArray(category.candidates) ? category.candidates : []
    let unjudged = 0
    let seeded = 0
    let manual = 0
    for (const candidate of candidates) {
      const judgment = judged[candidate.id]
      if (!judgment || judgment.label === 'unsure' || !judgment.label) {
        unjudged += 1
      } else if (judgment.origin === 'seeded') {
        seeded += 1
      } else {
        manual += 1
      }
    }
    gaps.push({
      categoryId: category.id,
      name: category.name,
      poolSize: candidates.length,
      unjudged,
      seeded,
      manual,
    })
  }
  const incomplete = gaps.filter((gap) => gap.unjudged > 0)
  if (incomplete.length > 0 && !allowPartial) {
    console.error('候选池标注未完成（unsure 或缺失均视为未判定）：')
    for (const gap of incomplete) {
      console.error(
        `  分类 ${gap.name} (id=${gap.categoryId}): ${gap.poolSize - gap.unjudged}/${gap.poolSize} 已判定，缺口 ${gap.unjudged}`,
      )
    }
    console.error(
      '先运行 annotation:neko:prepare 并完成标注；或以 --allow-partial 运行临时（provisional）评估。',
    )
    process.exit(2)
  }
  return { gaps, provisional: incomplete.length > 0 }
}

// hybrid_feedback mirrors the production feedback reranker, so it only runs
// when the production feedback model snapshot is present and not stale.
// This benchmark never triggers a rebuild itself.
function checkFeedbackModelReady() {
  try {
    const manifest = readJsonFile(feedbackManifestPath)
    if (!manifest || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
      return { ready: false, reason: `反馈模型 manifest 无可用 targets: ${feedbackManifestPath}` }
    }
    if (fs.existsSync(feedbackStatePath)) {
      const state = readJsonFile(feedbackStatePath)
      if (
        Number.isFinite(state.revision) &&
        Number.isFinite(manifest.revision) &&
        state.revision !== manifest.revision
      ) {
        return {
          ready: false,
          reason: `反馈模型 state 非 ready（revision ${state.revision} != 已构建 ${manifest.revision}）`,
        }
      }
    }
    return { ready: true }
  } catch (error) {
    return { ready: false, reason: `反馈模型 manifest 不可用: ${error.message}` }
  }
}

// ── Electron-stubbed module loading ──────────────────────────────────────

function installElectronStub() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: (name) => (name === 'userData' ? userDataDir : repoRoot) } }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  return () => {
    Module._load = originalLoad
  }
}

function sourceSnapshotState(imports, currentPaths) {
  if (!Array.isArray(imports) || imports.length === 0) return 'unknown'
  try {
    for (const sourcePath of currentPaths) {
      const stat = fs.statSync(sourcePath)
      const imported = imports.find((item) => path.resolve(item.path) === path.resolve(sourcePath))
      if (!imported || imported.size !== stat.size || imported.mtimeMs !== stat.mtimeMs) {
        return 'stale-complete-snapshot'
      }
    }
    return 'fresh'
  } catch {
    return 'source-missing'
  }
}

function storeFromF16Handle(handle, source, freshness) {
  if (!handle) return null
  return {
    modelName: handle.meta.modelName,
    embeddingType: handle.meta.embeddingType,
    dtype: 'f16-le',
    dim: handle.meta.dim,
    count: handle.meta.count,
    vectorPath: handle.vectorPath,
    pathIndexPath: handle.pathIndexPath,
    source,
    freshness,
    generation: handle.meta.generation || null,
  }
}

function resolveExactStore({ modelName, dim, sourcePaths, authoritativeStore, embeddingF16Cache }) {
  const storeRoot = path.join(userDataDir, 'vector-db', 'vector-store')
  const authoritative = authoritativeStore.openAuthoritativeVectorStore(
    storeRoot,
    modelName,
    'global',
    dim,
  )
  if (authoritative) {
    const manifest = authoritativeStore.readCurrentAuthoritativeManifest(storeRoot)
    const entry = manifest?.entries.find(
      (item) => item.modelName === modelName && item.embeddingType === 'global' && item.dim === dim,
    )
    return storeFromF16Handle(
      authoritative,
      'authoritative-generation',
      sourceSnapshotState(entry?.imports, sourcePaths),
    )
  }
  const existing = embeddingF16Cache.readExistingEmbeddingF16Cache({
    cacheDir: path.join(userDataDir, 'vector-db', 'embedding-cache'),
    modelName,
    embeddingType: 'global',
    dim,
    sourcePaths,
    preferAuthoritative: false,
  })
  return storeFromF16Handle(
    existing,
    'derived-f16-cache',
    existing ? sourceSnapshotState(existing.meta.sourceFiles, sourcePaths) : 'unavailable',
  )
}

async function loadActiveAssetSet() {
  const filePath = path.join(userDataDir, 'asset-library', 'assets.jsonl')
  const keys = new Set()
  let jsonParseMs = 0
  const startedAt = nowMs()
  const input = fs.createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    const parseStartedAt = nowMs()
    let row
    try {
      row = JSON.parse(line)
    } catch {
      row = null
    }
    jsonParseMs += nowMs() - parseStartedAt
    if (row && typeof row.path === 'string' && row.missing !== true && row.deletedAt == null) {
      const key = pathKey(row.path)
      keys.add(key)
    }
  }
  const totalMs = nowMs() - startedAt
  const hash = crypto.createHash('sha256')
  for (const key of [...keys].sort()) {
    hash.update(key)
    hash.update('\0')
  }
  return {
    keys,
    fingerprint: hash.digest('hex'),
    timings: {
      totalMs,
      jsonParseMs,
      ioMs: Math.max(0, totalMs - jsonParseMs),
    },
  }
}

function roundedSummary(summary) {
  return {
    mean: round(summary.mean, 1),
    median: round(summary.median, 1),
    p95: round(summary.p95, 1),
    max: round(summary.max, 1),
    samples: summary.samples,
  }
}

function summarizeRuntimeSamples(samples) {
  const result = {}
  for (const field of [
    'totalMs',
    'pathIoMs',
    'jsonParseMs',
    'vectorIoMs',
    'similarityMs',
    'rankingMs',
  ]) {
    result[field] = roundedSummary(binaryRuntime.summarize(samples.map((row) => row[field])))
  }
  return result
}

// ── Metric helpers ────────────────────────────────────────────────────────

function ndcgAtK(labels, k) {
  const top = labels.slice(0, k)
  let dcg = 0
  top.forEach((label, index) => {
    if (label === 'relevant') dcg += 1 / Math.log2(index + 2)
  })
  const relevantTotal = labels.filter((label) => label === 'relevant').length
  const idealCount = Math.min(relevantTotal, k)
  let idcg = 0
  for (let index = 0; index < idealCount; index += 1) idcg += 1 / Math.log2(index + 2)
  return idcg > 0 ? dcg / idcg : null
}

function rankedMetrics(ranked, pool) {
  // ranked: [{id, score}] desc; pool: Map id -> {label, judged}
  const labels = ranked.map((entry) => {
    const info = pool.get(entry.id)
    return info && info.judged ? info.label : 'unjudged'
  })
  const result = { ndcgAt20: ndcgAtK(labels, 20) }
  for (const k of TOP_KS) {
    const top = labels.slice(0, k)
    const judged = top.filter((label) => label !== 'unjudged')
    const relevant = judged.filter((label) => label === 'relevant').length
    result[`precisionAt${k}`] = {
      value: top.length === judged.length && judged.length > 0 ? relevant / judged.length : null,
      judgedValue: judged.length > 0 ? relevant / judged.length : null,
      judgedCount: judged.length,
      totalCount: top.length,
      partial: top.length !== judged.length,
    }
  }
  const top50 = labels.slice(0, 50)
  const relevantInTop50 = top50.filter((label) => label === 'relevant').length
  const relevantTotal = labels.filter((label) => label === 'relevant').length
  result.recallAt50 = relevantTotal > 0 ? relevantInTop50 / relevantTotal : null
  const top20Judged = labels.slice(0, 20).filter((label) => label !== 'unjudged')
  const rejected = top20Judged.filter((label) => label === 'not_relevant').length
  result.rejectIntrusionAt20 = top20Judged.length > 0 ? rejected / top20Judged.length : null
  return result
}

// Mann-Whitney AUC of positive scores vs negative scores.
function auc(positiveScores, negativeScores) {
  if (positiveScores.length === 0 || negativeScores.length === 0) return null
  let wins = 0
  for (const positive of positiveScores) {
    for (const negative of negativeScores) {
      if (positive > negative) wins += 1
      else if (positive === negative) wins += 0.5
    }
  }
  return wins / (positiveScores.length * negativeScores.length)
}

function macroAverage(perCategory, variants) {
  const macro = {}
  for (const variant of variants) {
    const rows = perCategory
      .map((category) => category.variants[variant])
      .filter((row) => row && row.metrics)
    const pick = (selector) => {
      const values = rows.map(selector).filter((value) => Number.isFinite(value))
      return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null
    }
    macro[variant] = {
      categories: rows.length,
      precisionAt20: pick(
        (row) => row.metrics.precisionAt20.value ?? row.metrics.precisionAt20.judgedValue,
      ),
      precisionAt50: pick(
        (row) => row.metrics.precisionAt50.value ?? row.metrics.precisionAt50.judgedValue,
      ),
      recallAt50: pick((row) => row.metrics.recallAt50),
      ndcgAt20: pick((row) => row.metrics.ndcgAt20),
      rejectIntrusionAt20: pick((row) => row.metrics.rejectIntrusionAt20),
    }
  }
  return macro
}

// ── Library scans ─────────────────────────────────────────────────────────

// One bounded pass over the full CLIP library: max-cosine to positive
// prototypes for every asset (Top-N heap), plus exact scores for pool
// candidates (positive max-cosine + nearest negative cosine).
// ── Variant ranking ───────────────────────────────────────────────────────

function rankVariants(candidates, variants) {
  // candidates: [{id, clip, dino, clipNegative}] — clip/dino may be null when the vector is missing
  const rankings = {}
  const sortDesc = (entries) => entries.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  if (variants.includes('clip')) {
    rankings.clip = sortDesc(
      candidates
        .filter((entry) => entry.clip !== null)
        .map((entry) => ({ id: entry.id, score: entry.clip })),
    )
  }
  if (variants.includes('dino')) {
    rankings.dino = sortDesc(
      candidates
        .filter((entry) => entry.dino !== null)
        .map((entry) => ({ id: entry.id, score: entry.dino })),
    )
  }
  if (variants.includes('hybrid') || variants.includes('hybrid_feedback')) {
    const hybridEntries = candidates.map((entry) => {
      // Production fallback: without a DINO vector only the weighted CLIP term survives.
      const dinoPart = entry.dino !== null ? entry.dino * DINO_WEIGHT : 0
      const clipPart = entry.clip !== null ? entry.clip * CLIP_WEIGHT : 0
      return { id: entry.id, score: clipPart + dinoPart, clipNegative: entry.clipNegative }
    })
    if (variants.includes('hybrid')) {
      rankings.hybrid = sortDesc(
        hybridEntries.map((entry) => ({ id: entry.id, score: entry.score })),
      )
    }
    if (variants.includes('hybrid_feedback')) {
      rankings.hybrid_feedback = sortDesc(
        hybridEntries.map((entry) => ({
          id: entry.id,
          score: entry.score - NEGATIVE_SUPPRESSION * entry.clipNegative,
        })),
      )
    }
  }
  return rankings
}

// ── Leave-one-out AUC diagnostic (review-set only) ────────────────────────

function leaveOneOutAuc(assetFeedbackModel, category, positives, negatives) {
  if (positives.length < 2 || negatives.length === 0) return null
  const toWeighted = (items) =>
    items.map((item) => ({ path: item.path, vector: item.vector, weight: 1 }))
  const negativeSamples = toWeighted(negatives)
  const fullModel = assetFeedbackModel.buildFeedbackTargetModel({
    key: `category:${category.id}`,
    kind: 'category',
    id: Number(category.id) || 1,
    name: category.name || `category-${category.id}`,
    positiveSampleCount: positives.length,
    negativeSampleCount: negatives.length,
    positiveVectors: toWeighted(positives),
    negativeVectors: negativeSamples,
  })
  if (!fullModel) return null
  const negativeScores = negatives.map(
    (item) => assetFeedbackModel.scoreAssetFeedbackTarget(item.vector, fullModel).score,
  )
  const heldOutScores = []
  for (let index = 0; index < positives.length; index += 1) {
    const remaining = positives.filter((_, position) => position !== index)
    const model = assetFeedbackModel.buildFeedbackTargetModel({
      key: `category:${category.id}`,
      kind: 'category',
      id: Number(category.id) || 1,
      name: category.name || `category-${category.id}`,
      positiveSampleCount: remaining.length,
      negativeSampleCount: negatives.length,
      positiveVectors: toWeighted(remaining),
      negativeVectors: negativeSamples,
    })
    if (!model) continue
    heldOutScores.push(
      assetFeedbackModel.scoreAssetFeedbackTarget(positives[index].vector, model).score,
    )
  }
  return auc(heldOutScores, negativeScores)
}

// ── Cluster quality (read-only) ───────────────────────────────────────────

async function readJsonLines(filePath, onRow) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let malformed = 0
  try {
    for await (const line of lines) {
      if (!line) continue
      try {
        onRow(JSON.parse(line))
      } catch {
        malformed += 1
      }
    }
  } finally {
    lines.close()
  }
  return malformed
}

function weightedMedian(entries) {
  // entries: [{value, weight}]
  const sorted = entries
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0)
  if (sorted.length === 0 || total <= 0) return null
  let cumulative = 0
  for (const entry of sorted) {
    cumulative += entry.weight
    if (cumulative >= total / 2) return entry.value
  }
  return sorted[sorted.length - 1].value
}

async function evaluateClusterQuality(assetLibraryDir) {
  const { relationJsonlDir } = require('./guard-utils.cjs')
  // Relation JSONL may live in a temp export after the SQLite migration.
  const relation = relationJsonlDir(assetLibraryDir)
  const groupsPath = path.join(relation.dir, 'cluster_groups.jsonl')
  const membersPath = path.join(relation.dir, 'cluster_group_assets.jsonl')
  const assetsPath = path.join(assetLibraryDir, 'assets.jsonl')
  if (!fs.existsSync(groupsPath) || !fs.existsSync(membersPath)) {
    relation.cleanup()
    return {
      available: false,
      note: 'cluster_groups.jsonl / cluster_group_assets.jsonl 缺失，跳过聚类质量评估',
    }
  }
  const groups = new Map()
  await readJsonLines(groupsPath, (row) => {
    if (row && Number.isInteger(row.id)) groups.set(row.id, row)
  })
  const similaritiesByGroup = new Map()
  let groupedAssetCount = 0
  await readJsonLines(membersPath, (row) => {
    if (!row || !Number.isInteger(row.clusterGroupId)) return
    const list = similaritiesByGroup.get(row.clusterGroupId) || []
    if (Number.isFinite(row.similarity)) list.push(row.similarity)
    similaritiesByGroup.set(row.clusterGroupId, list)
    groupedAssetCount += 1
  })
  let totalAssets = null
  if (fs.existsSync(assetsPath)) {
    totalAssets = 0
    await readJsonLines(assetsPath, () => {
      totalAssets += 1
    })
  }

  const statusCounts = {}
  const algorithmCounts = {}
  const avgSimilarities = []
  const purityEntries = []
  const perGroup = []
  for (const [groupId, group] of groups) {
    statusCounts[group.status] = (statusCounts[group.status] || 0) + 1
    algorithmCounts[group.algorithm] = (algorithmCounts[group.algorithm] || 0) + 1
    if (Number.isFinite(group.avgSimilarity)) avgSimilarities.push(group.avgSimilarity)
    const memberSimilarities = similaritiesByGroup.get(groupId) || []
    memberSimilarities.sort((a, b) => a - b)
    const memberMedian =
      memberSimilarities.length > 0
        ? memberSimilarities[Math.floor((memberSimilarities.length - 1) / 2)]
        : null
    if (memberMedian !== null) {
      purityEntries.push({
        value: memberMedian,
        weight: Math.max(1, group.assetCount || memberSimilarities.length),
      })
    }
    perGroup.push({
      id: groupId,
      status: group.status,
      algorithm: group.algorithm,
      assetCount: group.assetCount,
      avgSimilarity: round(group.avgSimilarity),
      memberSimilarityMedian: round(memberMedian),
    })
  }
  relation.cleanup()
  return {
    available: true,
    groupCount: groups.size,
    statusCounts,
    algorithmCounts,
    avgSimilarityMedian: round(percentile(avgSimilarities, 0.5)),
    purityMedianWeighted: round(weightedMedian(purityEntries)),
    groupedAssetCount,
    totalAssets,
    ungroupedRatio:
      totalAssets && totalAssets > 0
        ? round(Math.max(0, totalAssets - groupedAssetCount) / totalAssets)
        : null,
    groups: perGroup,
  }
}

// ── Baseline / gate ───────────────────────────────────────────────────────

function buildBaseline(macro, latency, cluster, comparability) {
  const variants = {}
  for (const [variant, metrics] of Object.entries(macro)) {
    variants[variant] = {
      precisionAt20: round(metrics.precisionAt20),
      precisionAt50: round(metrics.precisionAt50),
      recallAt50: round(metrics.recallAt50),
      ndcgAt20: round(metrics.ndcgAt20),
      rejectIntrusionAt20: round(metrics.rejectIntrusionAt20),
    }
  }
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    primaryVariant: 'hybrid',
    variants,
    latency: {
      scanP95Ms: round(latency.scanMs.p95, 1),
      applicationColdP95Ms: round(latency.applicationCold.totalMs.p95, 1),
      warmP95Ms: round(latency.warmPathIndex.totalMs.p95, 1),
      minimumRunsPerCondition: 3,
      absoluteBudgetMs: GATE_THRESHOLDS.scanP95AbsoluteMs,
    },
    comparability,
    cluster: {
      purityMedianWeighted: cluster && cluster.available ? cluster.purityMedianWeighted : null,
    },
  }
}

function evaluateGate(current, baseline) {
  const failures = []
  const warnings = []
  if (
    baseline.comparability?.annotationFingerprint &&
    baseline.comparability.annotationFingerprint !== current.comparability?.annotationFingerprint
  ) {
    failures.push(
      'Annotation dataset differs from the baseline; quality metrics are not comparable',
    )
  }
  if (
    baseline.comparability?.activeSetFingerprint &&
    baseline.comparability.activeSetFingerprint !== current.comparability?.activeSetFingerprint
  ) {
    failures.push(
      'Active asset set differs from the baseline; run a controlled before/after comparison',
    )
  }
  const primaryVariant = baseline.primaryVariant || 'hybrid'
  const baseMetrics = baseline.variants?.[primaryVariant]
  const metrics = current.variants?.[primaryVariant]
  if (!baseMetrics || !metrics) {
    failures.push(`Primary gate variant is unavailable: ${primaryVariant}`)
  } else {
    const prefix = `[${primaryVariant}]`
    if (
      Number.isFinite(metrics.ndcgAt20) &&
      Number.isFinite(baseMetrics.ndcgAt20) &&
      baseMetrics.ndcgAt20 > 0 &&
      (baseMetrics.ndcgAt20 - metrics.ndcgAt20) / baseMetrics.ndcgAt20 >
        GATE_THRESHOLDS.ndcgAt20RelativeDrop
    ) {
      failures.push(
        `${prefix} nDCG@20 相对降幅超 2%: ${round(baseMetrics.ndcgAt20)} -> ${round(metrics.ndcgAt20)}`,
      )
    }
    if (
      Number.isFinite(metrics.precisionAt20) &&
      Number.isFinite(baseMetrics.precisionAt20) &&
      baseMetrics.precisionAt20 - metrics.precisionAt20 > GATE_THRESHOLDS.precisionAt20DropPoints
    ) {
      failures.push(
        `${prefix} Precision@20 下降超 2pt: ${round(baseMetrics.precisionAt20)} -> ${round(metrics.precisionAt20)}`,
      )
    }
    if (
      Number.isFinite(metrics.recallAt50) &&
      Number.isFinite(baseMetrics.recallAt50) &&
      baseMetrics.recallAt50 - metrics.recallAt50 > GATE_THRESHOLDS.recallAt50DropPoints
    ) {
      failures.push(
        `${prefix} Recall@50 下降超 1pt: ${round(baseMetrics.recallAt50)} -> ${round(metrics.recallAt50)}`,
      )
    }
    if (Number.isFinite(metrics.rejectIntrusionAt20)) {
      if (metrics.rejectIntrusionAt20 > GATE_THRESHOLDS.rejectIntrusionAt20Absolute) {
        failures.push(
          `${prefix} Reject intrusion@20 超 5% 绝对上限: ${round(metrics.rejectIntrusionAt20)}`,
        )
      } else if (
        Number.isFinite(baseMetrics.rejectIntrusionAt20) &&
        metrics.rejectIntrusionAt20 - baseMetrics.rejectIntrusionAt20 >
          GATE_THRESHOLDS.rejectIntrusionAt20RisePoints
      ) {
        failures.push(
          `${prefix} Reject intrusion@20 较基线上升超 1pt: ${round(baseMetrics.rejectIntrusionAt20)} -> ${round(metrics.rejectIntrusionAt20)}`,
        )
      }
    }
  }
  const baseP95 = baseline.latency && baseline.latency.scanP95Ms
  const currentP95 = current.latency.scanMs.p95
  if (Number.isFinite(baseP95) && baseP95 > 0 && Number.isFinite(currentP95)) {
    if (currentP95 > baseP95 * GATE_THRESHOLDS.scanP95SlowdownFactor) {
      failures.push(`扫描 p95 延迟超基线 1.5x: ${round(baseP95, 1)}ms -> ${round(currentP95, 1)}ms`)
    }
  }
  if (Number.isFinite(currentP95) && currentP95 > GATE_THRESHOLDS.scanP95AbsoluteMs) {
    failures.push(
      `Exact warm scan p95 exceeds ${GATE_THRESHOLDS.scanP95AbsoluteMs}ms engineering budget: ${round(currentP95, 1)}ms`,
    )
  }
  if (
    current.latency.warmPathIndex?.totalMs?.samples < 3 ||
    current.latency.applicationCold?.totalMs?.samples < 3
  ) {
    failures.push('Latency gate requires at least 3 application-cold and 3 warm samples')
  }
  const purity =
    current.cluster && current.cluster.available ? current.cluster.purityMedianWeighted : null
  if (Number.isFinite(purity) && purity < GATE_THRESHOLDS.clusterPurityMedianWarnBelow) {
    warnings.push(`聚类 purity 加权中位 ${purity} 低于 0.80（仅警告，不门禁）`)
  }
  return { failures, warnings }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const { dataset, judgmentBook } = loadAnnotationsOrExit()
  const evalDataset = args.category
    ? (() => {
        const matched = dataset.categories.filter(
          (category) => String(category.id) === args.category || category.name === args.category,
        )
        if (matched.length === 0) {
          console.error(`--category "${args.category}" 在标注数据集中没有匹配分类。`)
          process.exit(1)
        }
        return { ...dataset, categories: matched }
      })()
    : dataset
  const { gaps, provisional } = checkPoolCompleteness(evalDataset, judgmentBook, args.allowPartial)
  if (provisional) {
    console.warn('警告：存在未完全判定的候选池，本次结果为 provisional（不可用于门禁基线）。')
  }

  const feedback = checkFeedbackModelReady()
  const activeVariants = args.variants.filter((variant) => {
    if (variant !== 'hybrid_feedback') return true
    if (!feedback.ready) {
      console.warn(`警告：跳过 hybrid_feedback 变体 — ${feedback.reason}`)
      return false
    }
    return true
  })
  if (activeVariants.length === 0) {
    console.error('没有可评估的变体。')
    process.exit(1)
  }

  const restoreLoad = installElectronStub()
  let assetFeedbackModel
  let embeddingF16Cache
  let vectorDatabaseService
  let authoritativeStore
  try {
    assetFeedbackModel = loadTsModule('electron/assetFeedbackModel.ts')
    embeddingF16Cache = loadTsModule('electron/embeddingF16Cache.ts')
    vectorDatabaseService = loadTsModule('electron/vectorDatabaseService.ts')
    authoritativeStore = loadTsModule('electron/authoritativeVectorStore.ts')
  } finally {
    restoreLoad()
  }

  const clipSourcePaths = vectorDatabaseService.getEmbeddingStorePaths(CLIP_MODEL, 'global')
  const dinoSourcePaths = vectorDatabaseService.getEmbeddingStorePaths(DINO_MODEL, 'global')
  const clipStore = resolveExactStore({
    modelName: CLIP_MODEL,
    dim: CLIP_DIM,
    sourcePaths: clipSourcePaths,
    authoritativeStore,
    embeddingF16Cache,
  })
  const dinoStore = resolveExactStore({
    modelName: DINO_MODEL,
    dim: DINO_DIM,
    sourcePaths: dinoSourcePaths,
    authoritativeStore,
    embeddingF16Cache,
  })
  if (!clipStore) {
    throw new Error(
      'CLIP exact binary snapshot is unavailable; build the F16 cache or migrate the authoritative store before benchmarking',
    )
  }
  if (!dinoStore) {
    console.warn('警告：DINO 向量库不可用，dino/hybrid/hybrid_feedback 变体将退化为 CLIP 部分。')
  }

  const activeAssets = await loadActiveAssetSet()
  const comparability = {
    annotationFingerprint: crypto
      .createHash('sha256')
      .update(fileSha256(datasetPath))
      .update(fileSha256(judgmentsPath))
      .digest('hex'),
    activeSetFingerprint: activeAssets.fingerprint,
    activeSetCount: activeAssets.keys.size,
  }
  const perCategory = []
  const runtimeSamples = { applicationCold: [], warmPathIndex: [] }

  for (const category of evalDataset.categories) {
    const judged = judgmentBook[String(category.id)] || {}
    const candidates = (category.candidates || []).map((candidate) => {
      const judgment = judged[candidate.id]
      const label = judgment && judgment.label !== 'unsure' ? judgment.label : null
      return {
        id: candidate.id,
        path: candidate.path,
        label,
        judged: label === 'relevant' || label === 'not_relevant',
        origin: judgment ? judgment.origin : null,
      }
    })
    const pool = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const positives = candidates.filter((candidate) => candidate.label === 'relevant')
    const negatives = candidates.filter((candidate) => candidate.label === 'not_relevant')
    const seededPositiveCount = positives.filter(
      (candidate) => candidate.origin === 'seeded',
    ).length
    const note = {
      categoryId: category.id,
      name: category.name,
      poolSize: candidates.length,
      positives: positives.length,
      negatives: negatives.length,
      seededPositives: seededPositiveCount,
      missingClipVectors: 0,
      missingDinoVectors: 0,
      variants: {},
    }
    if (positives.length === 0) {
      note.skipped = '无 relevant 标注，跳过该分类'
      perCategory.push(note)
      continue
    }

    const allPaths = candidates.map((candidate) => candidate.path)
    const clipVectorRead = await binaryRuntime.readVectorsForPaths(clipStore, allPaths)
    const clipVectors = clipVectorRead.vectors
    const dinoVectorRead = dinoStore
      ? await binaryRuntime.readVectorsForPaths(dinoStore, allPaths)
      : null
    const dinoVectors = dinoVectorRead?.vectors || new Map()

    const positivesClip = []
    const negativesClip = []
    const positivesDino = []
    const negativesDino = []
    for (const candidate of positives) {
      const key = pathKey(candidate.path)
      const clip = clipVectors.get(key)
      if (clip) positivesClip.push({ path: candidate.path, vector: clip })
      else note.missingClipVectors += 1
      const dino = dinoVectors.get(key)
      if (dino) positivesDino.push({ path: candidate.path, vector: dino })
    }
    for (const candidate of negatives) {
      const key = pathKey(candidate.path)
      const clip = clipVectors.get(key)
      if (clip) negativesClip.push({ path: candidate.path, vector: clip })
      const dino = dinoVectors.get(key)
      if (dino) negativesDino.push({ path: candidate.path, vector: dino })
    }
    note.missingDinoVectors = candidates.length - dinoVectors.size

    if (positivesClip.length === 0) {
      note.skipped = 'relevant 候选全部缺少 CLIP 向量，跳过该分类'
      perCategory.push(note)
      continue
    }

    const poolByPath = new Map(candidates.map((candidate) => [pathKey(candidate.path), candidate]))
    const topN = Math.max(5000, candidates.length * 4)

    const scanOptions = {
      poolByPath,
      topN,
      runs: args.runs,
      acceptPathKey: (key) => activeAssets.keys.has(key),
    }
    const clipBenchmark = await binaryRuntime.benchmarkExactStore(clipStore, {
      ...scanOptions,
      positiveVectors: positivesClip.map((item) => item.vector),
      negativeVectors: negativesClip.map((item) => item.vector),
    })
    const clipScan = clipBenchmark.result
    runtimeSamples.applicationCold.push(
      ...clipBenchmark.profile.samples.applicationCold.map((sample) => ({
        ...sample,
        modelName: CLIP_MODEL,
        categoryId: category.id,
      })),
    )
    runtimeSamples.warmPathIndex.push(
      ...clipBenchmark.profile.samples.warmPathIndex.map((sample) => ({
        ...sample,
        modelName: CLIP_MODEL,
        categoryId: category.id,
      })),
    )
    note.clipScan = {
      source: clipStore.source,
      freshness: clipStore.freshness,
      scanned: clipScan.scanned,
      scored: clipScan.scored,
      profile: clipBenchmark.profile,
      topN,
    }

    let dinoScan = { poolScores: new Map(), scanned: 0, scored: 0 }
    if (dinoStore && positivesDino.length > 0) {
      const dinoBenchmark = await binaryRuntime.benchmarkExactStore(dinoStore, {
        ...scanOptions,
        positiveVectors: positivesDino.map((item) => item.vector),
        negativeVectors: negativesDino.map((item) => item.vector),
      })
      dinoScan = dinoBenchmark.result
      runtimeSamples.applicationCold.push(
        ...dinoBenchmark.profile.samples.applicationCold.map((sample) => ({
          ...sample,
          modelName: DINO_MODEL,
          categoryId: category.id,
        })),
      )
      runtimeSamples.warmPathIndex.push(
        ...dinoBenchmark.profile.samples.warmPathIndex.map((sample) => ({
          ...sample,
          modelName: DINO_MODEL,
          categoryId: category.id,
        })),
      )
      note.dinoScan = {
        source: dinoStore.source,
        freshness: dinoStore.freshness,
        scanned: dinoScan.scanned,
        scored: dinoScan.scored,
        profile: dinoBenchmark.profile,
        topN,
      }
    } else {
      note.dinoScan = { scanned: 0, scored: 0, topN }
    }

    const scored = candidates.map((candidate) => {
      const key = pathKey(candidate.path)
      const clipScore = clipScan.poolScores.get(key)
      const dinoScore = dinoScan.poolScores.get(key)
      return {
        id: candidate.id,
        clip: clipScore ? clipScore.positive : null,
        dino: dinoScore ? dinoScore.positive : null,
        clipNegative: clipScore ? clipScore.negative : -1,
      }
    })
    const rankings = rankVariants(scored, activeVariants)
    for (const variant of activeVariants) {
      const ranked = rankings[variant]
      if (!ranked) continue
      note.variants[variant] = { metrics: rankedMetrics(ranked, pool) }
    }

    if (positivesClip.length >= 2 && negativesClip.length > 0) {
      note.aucLeaveOneOut = {
        clip: round(leaveOneOutAuc(assetFeedbackModel, category, positivesClip, negativesClip)),
        dino:
          positivesDino.length >= 2 && negativesDino.length > 0
            ? round(leaveOneOutAuc(assetFeedbackModel, category, positivesDino, negativesDino))
            : null,
        note: '仅审核集诊断，不代表全库精度',
      }
    }
    perCategory.push(note)
  }

  const evaluatedCategories = perCategory.filter((category) => !category.skipped)
  const macro = macroAverage(evaluatedCategories, activeVariants)
  const applicationCold = summarizeRuntimeSamples(runtimeSamples.applicationCold)
  const warmPathIndex = summarizeRuntimeSamples(runtimeSamples.warmPathIndex)
  const latency = {
    // Backward-compatible gate alias: exact warm full scan.
    scanMs: {
      mean: warmPathIndex.totalMs.mean,
      p50: warmPathIndex.totalMs.median,
      p95: warmPathIndex.totalMs.p95,
      max: warmPathIndex.totalMs.max,
      samples: warmPathIndex.totalMs.samples,
    },
    applicationCold,
    warmPathIndex,
    conditions:
      'applicationCold reparses metadata; warmPathIndex reuses parsed metadata. OS file cache is not flushed.',
    minimumRunsPerCondition: args.runs,
  }

  const cluster = await evaluateClusterQuality(path.join(userDataDir, 'asset-library'))

  const report = {
    version: 2,
    generatedAt: new Date().toISOString(),
    provisional,
    leakageBoundary: LEAKAGE_NOTE,
    environment: {
      userData: userDataDir,
      annotationDir,
      node: process.version,
      platform: process.platform,
      variants: activeVariants,
      feedbackModelReady: feedback.ready,
      exactRanking: true,
      annRole: 'candidate-recall-only; quality and latency gate use complete exact scans',
      stores: {
        clip: {
          source: clipStore.source,
          dtype: clipStore.dtype,
          count: clipStore.count,
          freshness: clipStore.freshness,
          generation: clipStore.generation,
        },
        dino: dinoStore
          ? {
              source: dinoStore.source,
              dtype: dinoStore.dtype,
              count: dinoStore.count,
              freshness: dinoStore.freshness,
              generation: dinoStore.generation,
            }
          : null,
      },
      activeSet: {
        count: activeAssets.keys.size,
        fingerprint: activeAssets.fingerprint,
        timings: activeAssets.timings,
      },
    },
    poolCompleteness: gaps,
    comparability,
    macro,
    latency,
    cluster,
    categories: perCategory,
  }

  fs.mkdirSync(reportDir, { recursive: true })
  fs.writeFileSync(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')

  printSummary(report, macro, latency, cluster, provisional)

  if (args.writeBaseline) {
    const baseline = buildBaseline(macro, latency, cluster, comparability)
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf8')
    console.log(`基线已写入 ${baselinePath}`)
  }

  if (args.gate) {
    if (provisional) {
      console.error('门禁拒绝在 provisional（标注不完整）结果上执行。')
      process.exit(1)
    }
    if (!fs.existsSync(baselinePath)) {
      console.log(
        `未找到基线 ${baselinePath}，本次仅记录不门禁（可用 --write-baseline 建立基线）。`,
      )
      return
    }
    const baseline = readJsonFile(baselinePath)
    const { failures, warnings } = evaluateGate(
      { variants: macro, latency, cluster, comparability },
      baseline,
    )
    for (const warning of warnings) console.warn(`警告：${warning}`)
    if (failures.length > 0) {
      console.error('门禁失败：')
      for (const failure of failures) console.error(`  ✗ ${failure}`)
      process.exit(1)
    }
    console.log('门禁通过：所有指标均在基线容差内。')
  }
}

function printSummary(report, macro, latency, cluster, provisional) {
  console.log('')
  console.log(`NekoSearch 准确率基准 ${provisional ? '(provisional)' : ''} — ${report.generatedAt}`)
  console.log(`说明：${LEAKAGE_NOTE}`)
  console.log('')
  console.log('变体宏平均（跨分类）：')
  console.log(
    padRight('variant', 18) +
      padRight('P@20', 9) +
      padRight('P@50', 9) +
      padRight('R@50', 9) +
      padRight('nDCG@20', 10) +
      padRight('rejInt@20', 10),
  )
  for (const [variant, metrics] of Object.entries(macro)) {
    console.log(
      padRight(variant, 18) +
        padRight(formatMetric(metrics.precisionAt20), 9) +
        padRight(formatMetric(metrics.precisionAt50), 9) +
        padRight(formatMetric(metrics.recallAt50), 9) +
        padRight(formatMetric(metrics.ndcgAt20), 10) +
        padRight(formatMetric(metrics.rejectIntrusionAt20), 10),
    )
  }
  console.log('')
  console.log(
    `全库扫描延迟 ms: mean=${latency.scanMs.mean} p50=${latency.scanMs.p50} p95=${latency.scanMs.p95} max=${latency.scanMs.max} (n=${latency.scanMs.samples})`,
  )
  console.log(
    `Exact application-cold p95=${latency.applicationCold.totalMs.p95}ms; warm p95=${latency.warmPathIndex.totalMs.p95}ms; ` +
      `warm phases: pathIO=${latency.warmPathIndex.pathIoMs.p95} json=${latency.warmPathIndex.jsonParseMs.p95} ` +
      `vectorIO=${latency.warmPathIndex.vectorIoMs.p95} similarity=${latency.warmPathIndex.similarityMs.p95} ranking=${latency.warmPathIndex.rankingMs.p95}`,
  )
  if (cluster.available) {
    console.log(
      `聚类: 组数=${cluster.groupCount} purity加权中位=${cluster.purityMedianWeighted} avgSim中位=${cluster.avgSimilarityMedian} 未分组比例=${cluster.ungroupedRatio}`,
    )
  } else {
    console.log(`聚类: ${cluster.note}`)
  }
  console.log(`原始报告: ${path.join(reportDir, 'latest.json')}`)
}

function padRight(value, width) {
  const text = String(value)
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length)
}

function formatMetric(value) {
  return Number.isFinite(value) ? value.toFixed(4) : 'n/a'
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = {
  GATE_THRESHOLDS,
  buildBaseline,
  evaluateGate,
  parseArgs,
}
