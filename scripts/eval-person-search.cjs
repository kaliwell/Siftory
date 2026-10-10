// Read-only evaluation of Phase 2/3 person identity search on the real
// asset library. Query = one confirmed photo of a category; candidates =
// the rest of the category (same identity) + random distractor assets.
// Reports AdaFace / OSNet similarity distributions and Precision@K.
//
// Usage: node scripts/eval-person-search.cjs [--category=12] [--distractors=60] [--query-index=0]

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const fm = loadTsModule('electron/faceMatchService.ts')
const reid = loadTsModule('electron/personReidService.ts')

const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a ? a.split('=')[1] : dflt
}
const CATEGORY_ID = Number(argVal('category', '12'))
const DISTRACTORS = Number(argVal('distractors', '60'))
const QUERY_INDEX = Number(argVal('query-index', '0'))

const LIB = path.join(process.env.APPDATA, 'floating-clock-electron', 'asset-library')

function loadCategoryPaths(categoryId) {
  const db = new DatabaseSync(path.join(LIB, 'asset-library.sqlite'), { readOnly: true })
  const rows = db
    .prepare("SELECT asset_id FROM asset_categories WHERE category_id=? AND status='confirmed'")
    .all(categoryId)
  db.close()
  return new Set(rows.map((r) => r.asset_id))
}

function loadAssets() {
  const assets = new Map()
  for (const line of fs.readFileSync(path.join(LIB, 'assets.jsonl'), 'utf8').split('\n')) {
    if (!line) continue
    const a = JSON.parse(line)
    if (!a.missing && a.kind === 'image') assets.set(a.id, a)
  }
  return assets
}

function precisionAtK(ranked, positives, k) {
  const top = ranked.slice(0, k)
  const hits = top.filter((r) => positives.has(r.id)).length
  return hits / Math.min(k, positives.size)
}

async function main() {
  const categoryIds = loadCategoryPaths(CATEGORY_ID)
  const assets = loadAssets()
  const categoryPaths = [...categoryIds]
    .map((id) => assets.get(id))
    .filter((a) => a && fs.existsSync(a.path))

  // random distractors: existing images not in the category
  const pool = [...assets.values()].filter((a) => !categoryIds.has(a.id) && fs.existsSync(a.path))
  const distractors = []
  const seen = new Set()
  while (distractors.length < Math.min(DISTRACTORS, pool.length)) {
    const a = pool[Math.floor(Math.random() * pool.length)]
    if (seen.has(a.id)) continue
    seen.add(a.id)
    distractors.push(a)
  }

  const query = categoryPaths[QUERY_INDEX]
  const candidates = [...categoryPaths.filter((a) => a.id !== query.id), ...distractors]
  console.log(
    `query: asset ${query.id} | category size: ${categoryPaths.length} | distractors: ${distractors.length}`,
  )

  // query embeddings
  const qFace = await fm.getFaceEmbedding(query.path)
  const qOsnet = await reid.getPersonEmbedding(query.path)
  console.log(
    `query face: ${qFace.ok ? 'ok' : 'FAIL ' + qFace.error} | query osnet: ${qOsnet.ok ? 'ok' : 'FAIL ' + qOsnet.error}`,
  )
  if (!qFace.ok && !qOsnet.ok) {
    console.log('no query embedding — abort')
    process.exit(2)
  }

  // candidate embeddings (batched osnet, sequential face)
  const faceSims = new Map()
  let faceDetected = 0
  for (const c of candidates) {
    if (!qFace.ok) break
    try {
      const e = await fm.getFaceEmbedding(c.path)
      if (e.ok) {
        faceSims.set(c.id, fm.faceSimilarity(qFace.vector, e.vector))
        faceDetected++
      }
    } catch {
      /* unreadable candidate — skip */
    }
  }

  const osnetSims = new Map()
  if (qOsnet.ok) {
    const vecs = await reid.embedPersonCrops(candidates.map((c) => ({ imagePath: c.path })))
    candidates.forEach((c, i) => {
      if (vecs[i]) osnetSims.set(c.id, reid.personSimilarity(qOsnet.vector, vecs[i]))
    })
  }
  console.log(`face detected in ${faceDetected}/${candidates.length} candidates`)

  const positives = new Set(categoryPaths.map((a) => a.id).filter((id) => id !== query.id))

  const report = (name, sims) => {
    if (sims.size === 0) {
      console.log(`\n[${name}] no embeddings`)
      return
    }
    const ranked = [...sims.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
    const posSims = [...positives].filter((id) => sims.has(id)).map((id) => sims.get(id))
    const negSims = [...sims.entries()].filter(([id]) => !positives.has(id)).map(([, s]) => s)
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN)
    console.log(`\n[${name}] embedded: ${sims.size} (pos ${posSims.length}, neg ${negSims.length})`)
    console.log(
      `  avg pos sim: ${avg(posSims).toFixed(4)} | avg neg sim: ${avg(negSims).toFixed(4)} | gap: ${(avg(posSims) - avg(negSims)).toFixed(4)}`,
    )
    for (const k of [10, 20, 50]) {
      console.log(`  P@${k}: ${precisionAtK(ranked, positives, k).toFixed(3)}`)
    }
    console.log(
      '  top10:',
      ranked
        .slice(0, 10)
        .map((r) => `${r.id}:${r.score.toFixed(3)}${positives.has(r.id) ? '✓' : '✗'}`)
        .join(' '),
    )
  }

  report('AdaFace', faceSims)
  report('OSNet', osnetSims)

  // fused: max(face, osnet) per candidate where available
  const fused = new Map()
  for (const c of candidates) {
    const f = faceSims.get(c.id)
    const o = osnetSims.get(c.id)
    if (f !== undefined || o !== undefined) fused.set(c.id, Math.max(f ?? -1, o ?? -1))
  }
  report('max(face,osnet)', fused)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
