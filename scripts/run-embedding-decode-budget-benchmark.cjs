#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const sharp = require('sharp')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const { decodeEmbeddingImagesInWaves } = loadTsModule('electron/embeddingDecodeBudget.ts')
// Embedding children hard-cap one inference batch at 16 images.
const SAMPLE_COUNT = 16
const ROUNDS = 7

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
  return { p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1) }
}

async function createFixtures(root) {
  const paths = []
  const width = 1200
  const height = 800
  const pixels = Buffer.alloc(width * height * 3)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 17) % 251
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const target = path.join(root, `ordinary-${String(index).padStart(3, '0')}.jpg`)
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 + (index % 3) })
      .toFile(target)
    paths.push(target)
  }
  return paths
}

async function decode(imagePath) {
  return sharp(imagePath, { animated: false, sequentialRead: true })
    .rotate()
    .raw()
    .toBuffer()
}

async function runVariant(paths, variant) {
  const started = performance.now()
  const results =
    variant === 'baseline'
      ? await Promise.allSettled(paths.map(decode))
      : (await decodeEmbeddingImagesInWaves(paths, decode)).results
  const elapsedMs = performance.now() - started
  const succeeded = results.filter((result) => result.status === 'fulfilled').length
  const bytes = results.reduce(
    (sum, result) => sum + (result.status === 'fulfilled' ? result.value.byteLength : 0),
    0,
  )
  return { elapsedMs, succeeded, bytes }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const outputDir = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory', 'decode-budget')
  fs.mkdirSync(outputDir, { recursive: true })
  const workingRoot = fs.mkdtempSync(path.join(outputDir, 'working-'))
  try {
    const paths = await createFixtures(workingRoot)
    await runVariant(paths, 'baseline')
    await runVariant(paths, 'budgeted')
    const runs = { baseline: [], budgeted: [] }
    for (let round = 0; round < ROUNDS; round += 1) {
      const order = round % 2 === 0 ? ['baseline', 'budgeted'] : ['budgeted', 'baseline']
      for (const variant of order) {
        if (global.gc) global.gc()
        runs[variant].push(await runVariant(paths, variant))
      }
    }
    const baseline = summarize(runs.baseline.map((run) => run.elapsedMs))
    const budgeted = summarize(runs.budgeted.map((run) => run.elapsedMs))
    const parity = [...runs.baseline, ...runs.budgeted].every(
      (run) => run.succeeded === SAMPLE_COUNT && run.bytes === SAMPLE_COUNT * 1200 * 800 * 3,
    )
    const p95ChangePercent = ((budgeted.p95 - baseline.p95) / baseline.p95) * 100
    const report = {
      schema: 'siftory-embedding-decode-budget/v1',
      generatedAt: new Date().toISOString(),
      status: parity && p95ChangePercent <= 5 ? 'passed' : 'failed',
      synthetic: { count: SAMPLE_COUNT, width: 1200, height: 800, channels: 3 },
      rounds: ROUNDS,
      baseline,
      budgeted,
      p95ChangePercent,
      parity,
      runs,
      safety: { syntheticOnly: true, artifactBoundaryMaintained: true },
    }
    fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.status !== 'passed') process.exitCode = 1
  } finally {
    fs.rmSync(workingRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
