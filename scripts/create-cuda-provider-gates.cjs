#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const MODEL_IDS = Object.freeze({
  dinov2_vitb14: 'dino',
  clip_vit_base_patch32_image: 'clip-image',
})

function parseArgs(argv) {
  const options = { reportPaths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [name, inlineValue] = argument.split('=', 2)
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    if (!name.startsWith('--') || value === undefined)
      throw new Error(`invalid argument: ${argument}`)
    if (name === '--ort-version') options.ortVersion = value
    else if (name === '--output') options.outputPath = value
    else if (name === '--report') options.reportPaths.push(value)
    else throw new Error(`unknown option: ${name}`)
  }
  if (options.ortVersion !== '1.24.3') throw new Error('--ort-version must be 1.24.3')
  if (!options.outputPath) throw new Error('--output is required')
  if (options.reportPaths.length < 2)
    throw new Error('DINO and CLIP image --report files are required')
  return options
}

function createProviderGates(reports, ortVersion = '1.24.3') {
  if (ortVersion !== '1.24.3') throw new Error('unsupported ONNX Runtime version')
  const models = new Map()
  for (const report of reports) {
    const id = MODEL_IDS[report?.model]
    if (!id) continue
    if (
      report.schemaVersion !== 1 ||
      report.passed !== true ||
      report.parity?.ok !== true ||
      typeof report.modelSha256 !== 'string' ||
      typeof report.performanceGate?.speedup !== 'number' ||
      report.performanceGate.speedup < 1.5 ||
      typeof report.parity?.metrics?.minimumCosine !== 'number' ||
      report.parity.metrics.minimumCosine < 0.999 ||
      !Array.isArray(report.performanceCriticalCpuOperations) ||
      report.performanceCriticalCpuOperations.length > 0
    ) {
      throw new Error(`${id} PoC report did not pass every CUDA provider gate`)
    }
    if (models.has(id)) throw new Error(`duplicate CUDA provider report: ${id}`)
    models.set(id, {
      id,
      modelSha256: report.modelSha256,
      passed: true,
      minimumCosine: report.parity.metrics.minimumCosine,
      speedup: report.performanceGate.speedup,
      performanceCriticalCpuOperations: [],
    })
  }
  for (const id of Object.values(MODEL_IDS)) {
    if (!models.has(id)) throw new Error(`missing CUDA provider report: ${id}`)
  }
  return { schemaVersion: 1, ortVersion, models: [...models.values()] }
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const reports = options.reportPaths.map((reportPath) =>
      JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')),
    )
    const gates = createProviderGates(reports, options.ortVersion)
    const outputPath = path.resolve(options.outputPath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(gates, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ ok: true, outputPath })}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { MODEL_IDS, createProviderGates, parseArgs }
