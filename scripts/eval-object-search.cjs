// Read-only evaluation of object-subject identity rerank on real data.
// Positives = frames of one video clip (same car instances, varying
// viewpoint/occlusion); distractors = random library images.
// Compares whole-image DINO ranking vs same-class crop DINO ranking.
//
// Usage: node scripts/eval-object-search.cjs [--clip=<dirHash>] [--positives=30] [--distractors=60]

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')

// Electron stub so modelService resolves the dev ai-models dir and the
// real userData path outside the app (same pattern as verify-*.cjs).
const userDataDir = path.join(process.env.APPDATA, 'floating-clock-electron')
const projectRoot = path.resolve(__dirname, '..')
const electronStub = {
  app: {
    isPackaged: false,
    getAppPath: () => projectRoot,
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
  },
}
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

const { loadTsModule } = require('../tests/guard-utils.cjs')

const ss = loadTsModule('electron/subjectSearchService.ts')
const { SubjectCropEmbedder } = loadTsModule('electron/subjectCropEmbedder.ts')
const { cosineSimilarity } = loadTsModule('electron/faceAlign.ts')
const { colorIdentitySimilarity, computeImageColorHist } = loadTsModule(
  'electron/colorFeatureService.ts',
)
const modelService = loadTsModule('electron/modelService.ts')
const sharp = require('sharp')

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a ? a.split('=')[1] : dflt
}
const CLIP = argVal('clip', '0027161bec0207898e104b55e95f81a1a8a89dfa')
const MAX_POS = Number(argVal('positives', '30'))
const DISTRACTORS = Number(argVal('distractors', '60'))
const LABEL = argVal('label', 'car')

const FRAMES = path.join(process.env.APPDATA, 'floating-clock-electron', 'media-search', 'frames')
const LIB = path.join(process.env.APPDATA, 'floating-clock-electron', 'asset-library')

function precisionAtK(ranked, positives, k) {
  const top = ranked.slice(0, k)
  const hits = top.filter((r) => positives.has(r.path)).length
  return hits / Math.min(k, positives.size)
}

async function main() {
  modelService.initModelService()
  const clipDir = path.join(FRAMES, CLIP)
  const frames = fs
    .readdirSync(clipDir)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => path.join(clipDir, f))
    .sort()
  const step = Math.max(1, Math.floor(frames.length / MAX_POS))
  const positives = frames.filter((_, i) => i % step === 0).slice(0, MAX_POS)
  const query = positives[0]
  const posSet = new Set(positives.slice(1))

  // random distractors from the asset library
  const pool = []
  for (const line of fs.readFileSync(path.join(LIB, 'assets.jsonl'), 'utf8').split('\n')) {
    if (!line) continue
    const a = JSON.parse(line)
    if (
      !a.missing &&
      a.kind === 'image' &&
      !posSet.has(a.path) &&
      a.path !== query &&
      fs.existsSync(a.path)
    )
      pool.push(a.path)
  }
  const distractors = []
  const seen = new Set()
  while (distractors.length < Math.min(DISTRACTORS, pool.length)) {
    const p = pool[Math.floor(Math.random() * pool.length)]
    if (seen.has(p)) continue
    seen.add(p)
    distractors.push(p)
  }

  const candidates = [...positives.slice(1), ...distractors]
  console.log(
    `query: ${path.basename(query)} | positives: ${posSet.size} | distractors: ${distractors.length}`,
  )

  const embedder = await SubjectCropEmbedder.create()
  if (!embedder) {
    console.log('DINO model not ready — abort')
    process.exit(2)
  }

  try {
    // ── A: whole-image DINO baseline
    const qWhole = await embedder.embed(query)
    const wholeSims = new Map()
    for (const c of candidates) {
      const v = await embedder.embed(c)
      if (v && qWhole) wholeSims.set(c, cosineSimilarity(qWhole, v))
    }

    // ── B: same-class crop rerank
    // query crop: best matching subject in query frame
    const qDet = await ss.detectSubjects(query)
    const qSub = qDet.ok ? qDet.subjects.filter((s) => s.label === LABEL)[0] : null
    if (!qSub) {
      console.log(`no '${LABEL}' subject in query — abort`)
      process.exit(2)
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-eval-crops-'))
    try {
      const qCrop = path.join(tmpDir, 'query.jpg')
      await sharp(query)
        .extract({ left: qSub.x, top: qSub.y, width: qSub.w, height: qSub.h })
        .jpeg({ quality: 90 })
        .toFile(qCrop)
      const qCropVec = await embedder.embed(qCrop)
      const qCropHist = await computeImageColorHist(qCrop)

      const cropSims = new Map()
      const cropColorSims = new Map()
      let cropped = 0
      for (const c of candidates) {
        const det = await ss.detectSubjects(c)
        const sub = det.ok ? det.subjects.filter((s) => s.label === LABEL)[0] : null
        if (!sub || !qCropVec) continue
        const cp = path.join(tmpDir, `${cropped}.jpg`)
        try {
          await sharp(c)
            .extract({ left: sub.x, top: sub.y, width: sub.w, height: sub.h })
            .jpeg({ quality: 90 })
            .toFile(cp)
        } catch {
          continue
        }
        const v = await embedder.embed(cp)
        if (v) {
          const dinoSim = cosineSimilarity(qCropVec, v)
          cropSims.set(c, dinoSim)
          const hist = await computeImageColorHist(cp)
          if (hist && qCropHist) {
            cropColorSims.set(c, dinoSim * 0.75 + colorIdentitySimilarity(qCropHist, hist) * 0.25)
          } else {
            cropColorSims.set(c, dinoSim)
          }
          cropped++
        }
      }
      console.log(`crop coverage: ${cropped}/${candidates.length} candidates have '${LABEL}' crop`)

      const report = (name, sims, floorRest) => {
        const ranked = candidates
          .map((c) => ({ path: c, score: sims.has(c) ? sims.get(c) : floorRest }))
          .sort((a, b) => b.score - a.score)
        const posSims = [...posSet].filter((p) => sims.has(p)).map((p) => sims.get(p))
        const negSims = distractors.filter((p) => sims.has(p)).map((p) => sims.get(p))
        const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN)
        console.log(`\n[${name}] scored: ${sims.size}`)
        console.log(
          `  avg pos: ${avg(posSims).toFixed(4)} | avg neg: ${avg(negSims).toFixed(4)} | gap: ${(avg(posSims) - avg(negSims)).toFixed(4)}`,
        )
        for (const k of [10, 20, 30]) {
          console.log(`  P@${k}: ${precisionAtK(ranked, posSet, k).toFixed(3)}`)
        }
        console.log(
          '  top10:',
          ranked
            .slice(0, 10)
            .map((r) => `${r.score.toFixed(3)}${posSet.has(r.path) ? '✓' : '✗'}`)
            .join(' '),
        )
      }

      report('whole-image DINO (baseline)', wholeSims, 0)
      report('same-class crop DINO (identity)', cropSims, -1)
      report('crop DINO×0.75 + color×0.25', cropColorSims, -1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } finally {
    await embedder.dispose()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
