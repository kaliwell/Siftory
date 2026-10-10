#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function renderPerformanceReport(smoke, soak) {
  const summary = soak.summary || {}
  return `# VID-017 llama.cpp 本机性能趋势\n\n> 范围：仅聚合指标；不包含原始路径、文件名、自由备注或模型语义正文。\n\n| 指标 | 结果 |\n| --- | ---: |\n| 单次冒烟延迟 | ${smoke.latencyMs || 0} ms |\n| 持续推理轮数 | ${summary.attempted || 0} |\n| 严格 JSON 通过 | ${summary.strictJson || 0} |\n| 平均延迟 | ${summary.averageLatencyMs || 0} ms |\n| P95 延迟 | ${summary.p95LatencyMs || 0} ms |\n| 最大显存占用 | ${summary.maximumGpuUsedMiB || 0} MiB |\n| 八类素材覆盖 | ${soak.sample?.profileCount || 0}/8 |\n| sidecar 已回收 | ${soak.sidecarStopped === true ? '是' : '否'} |\n\n结论：${soak.ok === true ? '本机持续推理门禁通过。' : '本机持续推理门禁未通过。'}\n`
}

function reportPaths(projectRoot = path.resolve(__dirname, '..')) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const root = path.join(
    appData,
    'floating-clock-electron',
    'media-search',
    'semantic',
    'benchmarks',
  )
  return {
    smoke: path.join(root, 'llama-cpp-local-smoke', 'report.json'),
    soak: path.join(root, 'llama-cpp-local-soak', 'report.json'),
    output: path.join(
      projectRoot,
      'docs',
      'benchmarks',
      '2026-08-15-vid-017-llama-cpp-local-performance.md',
    ),
  }
}

function main() {
  const paths = reportPaths()
  const rendered = renderPerformanceReport(
    JSON.parse(fs.readFileSync(paths.smoke, 'utf8')),
    JSON.parse(fs.readFileSync(paths.soak, 'utf8')),
  )
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(paths.output) || fs.readFileSync(paths.output, 'utf8') !== rendered)
      throw new Error('VID-017 performance report is stale')
  } else fs.writeFileSync(paths.output, rendered, 'utf8')
  process.stdout.write(`${paths.output}\n`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
module.exports = { renderPerformanceReport, reportPaths }
