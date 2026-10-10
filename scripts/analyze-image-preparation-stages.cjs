#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const benchmarkRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'image-preparation-pipeline')
const automationRoot = path.join(projectRoot, 'artifacts', 'automation')
const SERIAL_READY_FIELDS = [
  'serviceInitMs',
  'imageScanMs',
  'hashIndexSaveMs',
  'dinoPreparationMs',
  'dinoInferencePersistenceMs',
  'clipPreparationMs',
  'clipInferencePersistenceMs',
  'vectorIndexBuildMs',
]

function option(argv, name) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || ''
}

function finite(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(finite(value) * factor) / factor
}

function percentile(values, ratio) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function latestBenchmarkDirectory() {
  if (!fs.existsSync(benchmarkRoot)) return ''
  return fs
    .readdirSync(benchmarkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(benchmarkRoot, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]
}

function isStrictChild(root, directory) {
  const relative = path.relative(path.resolve(root), path.resolve(directory))
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveBenchmarkDirectory(argv, managedRoots = [benchmarkRoot, automationRoot]) {
  const requested = option(argv, 'dir')
  const directory = path.resolve(requested || latestBenchmarkDirectory())
  if (!managedRoots.some((root) => isStrictChild(root, directory))) {
    throw new Error('Benchmark directory must be a child of a managed benchmark artifact root')
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Benchmark directory does not exist: ${directory}`)
  }
  return directory
}

function progressIntervals(samples, counter) {
  const rows = [...(samples || [])]
    .filter((sample) => Number.isFinite(Number(sample?.atMs)))
    .sort((left, right) => Number(left.atMs) - Number(right.atMs))
  const sampleGaps = rows
    .slice(1)
    .map((row, index) => finite(row.atMs) - finite(rows[index].atMs))
    .filter((gap) => gap >= 0)
  const sampleCadenceMs = {
    p50: round(percentile(sampleGaps, 0.5)),
    p95: round(percentile(sampleGaps, 0.95)),
    max: round(Math.max(0, ...sampleGaps)),
  }
  const initialValue = rows.length ? finite(rows[0][counter]) : 0
  const maximumValue = rows.reduce(
    (maximum, row) => Math.max(maximum, finite(row[counter])),
    initialValue,
  )
  if (rows.length < 2) {
    return {
      samples: rows.length,
      changes: 0,
      resets: 0,
      initialValue,
      maximumValue,
      partialCoverage: initialValue > 0,
      sampleCadenceMs,
      p95ChangeGapMs: 0,
      maxChangeGapMs: 0,
      largestChangeGap: null,
      suspectedMidRunStalls: 0,
      stallThresholdMs: Math.max(2_000, round(sampleCadenceMs.p95 * 2.5)),
      stallWindows: [],
    }
  }
  const changes = []
  let resets = 0
  let segment = 1
  let lastChangeAt = finite(rows[0].atMs)
  let lastValue = finite(rows[0][counter])
  for (const row of rows.slice(1)) {
    const value = finite(row[counter])
    const atMs = finite(row.atMs)
    if (value < lastValue) {
      resets++
      segment++
      lastChangeAt = atMs
      lastValue = value
      continue
    }
    if (value === lastValue) continue
    changes.push({
      gapMs: atMs - lastChangeAt,
      fromAtMs: lastChangeAt,
      toAtMs: atMs,
      fromValue: lastValue,
      toValue: value,
      location: lastValue <= 0 ? 'startup' : value >= maximumValue ? 'tail' : 'mid-run',
      segment,
    })
    lastChangeAt = atMs
    lastValue = value
  }
  const gaps = changes.map((change) => change.gapMs)
  const largestChangeGap = changes.reduce(
    (largest, change) => (!largest || change.gapMs > largest.gapMs ? change : largest),
    null,
  )
  const stallThresholdMs = Math.max(2_000, round(sampleCadenceMs.p95 * 2.5))
  const stallWindows = changes
    .filter((change) => change.location === 'mid-run' && change.gapMs > stallThresholdMs)
    .sort((left, right) => right.gapMs - left.gapMs)
    .slice(0, 5)
    .map((change) => ({
      ...change,
      gapMs: round(change.gapMs),
      fromAtMs: round(change.fromAtMs),
      toAtMs: round(change.toAtMs),
    }))
  return {
    samples: rows.length,
    changes: changes.length,
    resets,
    initialValue,
    maximumValue,
    partialCoverage: initialValue > 0,
    sampleCadenceMs,
    p95ChangeGapMs: round(percentile(gaps, 0.95)),
    maxChangeGapMs: round(Math.max(0, ...gaps)),
    largestChangeGap: largestChangeGap
      ? {
          ...largestChangeGap,
          gapMs: round(largestChangeGap.gapMs),
          fromAtMs: round(largestChangeGap.fromAtMs),
          toAtMs: round(largestChangeGap.toAtMs),
        }
      : null,
    suspectedMidRunStalls: stallWindows.length,
    stallThresholdMs,
    stallWindows,
  }
}

function pipelinePhaseWindows(progress) {
  const windows = new Map()
  for (const snapshot of progress || []) {
    const phase = String(snapshot?.phase || 'unknown')
    const atMs = finite(snapshot?.atMs)
    const current = windows.get(phase)
    if (!current) {
      windows.set(phase, { phase, firstAtMs: atMs, lastAtMs: atMs, events: 1 })
    } else {
      current.lastAtMs = atMs
      current.events++
    }
  }
  return [...windows.values()].map((window) => ({
    ...window,
    observedDurationMs: round(window.lastAtMs - window.firstAtMs),
  }))
}

function ratioPercent(numerator, denominator) {
  const total = finite(denominator)
  return total > 0 ? round((finite(numerator) / total) * 100) : 0
}

function embeddingStageBreakdown(progress) {
  const metrics = progress?.stageMetrics
  if (!metrics || finite(metrics.schemaVersion) !== 1) {
    return { available: false }
  }
  const runtimeLoadMs = finite(metrics.runtimeLoadMsTotal)
  const decodeNormalizeMs = finite(metrics.decodeNormalizeMsTotal)
  const preprocessMs = finite(metrics.preprocessMsTotal)
  const inferenceMs = finite(metrics.inferenceMsTotal)
  const postprocessMs = finite(metrics.postprocessMsTotal)
  const preInferenceMs = decodeNormalizeMs + preprocessMs
  const coreStageMs = runtimeLoadMs + preInferenceMs + inferenceMs + postprocessMs
  const items = finite(metrics.items)
  const batches = finite(metrics.batches)
  const persistenceOperations = finite(metrics.persistenceOperations)
  return {
    available: true,
    batches,
    items,
    succeeded: finite(metrics.succeeded),
    failed: finite(metrics.failed),
    fallbackBatches: finite(metrics.fallbackBatches),
    fallbackBatchPercent: ratioPercent(metrics.fallbackBatches, batches),
    queueWaitMsTotal: round(metrics.queueWaitMsTotal),
    queueWaitMsMax: round(metrics.queueWaitMsMax),
    queueWaitMsPerItem: items > 0 ? round(finite(metrics.queueWaitMsTotal) / items, 3) : 0,
    batchWallMsTotal: round(metrics.batchWallMsTotal),
    batchWallMsMax: round(metrics.batchWallMsMax),
    batchWallMsAverage: batches > 0 ? round(finite(metrics.batchWallMsTotal) / batches) : 0,
    runtimeLoadMs: round(runtimeLoadMs),
    decodeNormalizeMs: round(decodeNormalizeMs),
    preprocessMs: round(preprocessMs),
    preInferenceMs: round(preInferenceMs),
    inferenceMs: round(inferenceMs),
    postprocessMs: round(postprocessMs),
    coreStageMs: round(coreStageMs),
    preInferenceSharePercent: ratioPercent(preInferenceMs, coreStageMs),
    inferenceSharePercent: ratioPercent(inferenceMs, coreStageMs),
    fallbackMs: round(metrics.fallbackMsTotal),
    persistenceOperations,
    persistenceMsTotal: round(metrics.persistenceMsTotal),
    persistenceMsAverage:
      persistenceOperations > 0
        ? round(finite(metrics.persistenceMsTotal) / persistenceOperations, 3)
        : 0,
    persistenceMsMax: round(metrics.persistenceMsMax),
    persistencePeakPending: finite(metrics.persistencePeakPending),
  }
}

function analyzeReport(filePath) {
  const report = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const match = /^round-(\d+)-(serial|overlap)\.json$/.exec(path.basename(filePath))
  const diagnosticMatch = /^instrumented-(serial|overlap)-(\d+)(?:-[a-z0-9-]+)?\.json$/.exec(
    path.basename(filePath),
  )
  if (!match && !diagnosticMatch) {
    throw new Error(`Unexpected report name: ${path.basename(filePath)}`)
  }
  const pipeline = match?.[2] || diagnosticMatch[1]
  const imageCount = finite(report.config?.imageCount)
  const readyMs = finite(report.phases?.libraryReadyMs)
  const serialAttributedMs = SERIAL_READY_FIELDS.reduce(
    (total, field) => total + finite(report.phases?.[field]),
    0,
  )
  const pipelineTotalMs = finite(report.pipeline?.result?.timings?.totalMs)
  const progress = report.pipeline?.progress || []
  const explicitScanSamples = report.scan?.progressSamples || []
  const scanSamples =
    explicitScanSamples.length > 0
      ? explicitScanSamples
      : pipeline === 'overlap'
        ? progress.map((snapshot) => ({ atMs: snapshot.atMs, scanIndexed: snapshot.scanIndexed }))
        : []
  const scanCounter =
    explicitScanSamples.length > 0 || pipeline === 'serial' ? 'indexedCount' : 'scanIndexed'
  const dinoSamples = report.dino?.progressSamples || []
  const clipSamples = report.clip?.progressSamples || []
  const timelineFile = `${path.basename(filePath, '.json')}.timeline.ndjson`
  return {
    file: path.basename(filePath),
    round: match ? Number(match[1]) : null,
    diagnostic: Boolean(diagnosticMatch),
    pipeline,
    imageCount,
    readyMs: round(readyMs),
    totalMs: round(report.phases?.totalMs),
    imagesPerSecond: readyMs > 0 ? round((imageCount * 1000) / readyMs, 3) : 0,
    harness: Object.fromEntries(
      Object.entries(report.harness || {}).map(([key, value]) => [key, round(value)]),
    ),
    timeline: {
      file: timelineFile,
      available: fs.existsSync(path.join(path.dirname(filePath), timelineFile)),
      progressIntervalMs: finite(report.timeline?.progressIntervalMs),
    },
    phases: Object.fromEntries(
      Object.entries(report.phases || {}).map(([key, value]) => [key, round(value)]),
    ),
    readyUnattributedMs: round(
      Math.max(0, readyMs - (pipeline === 'serial' ? serialAttributedMs : pipelineTotalMs)),
    ),
    milestones: {
      scanReadyMs: round(report.pipeline?.result?.timings?.scanReadyMs),
      dinoReadyMs: round(report.pipeline?.result?.timings?.dinoReadyMs),
      clipReadyMs: round(report.pipeline?.result?.timings?.clipReadyMs),
      vectorIndexMs: round(report.pipeline?.result?.timings?.vectorIndexMs),
    },
    progressIntervals: {
      scan: progressIntervals(scanSamples, scanCounter),
      dino: progressIntervals(dinoSamples, 'completed'),
      clip: progressIntervals(clipSamples, 'completed'),
    },
    pipelinePhaseWindows: pipelinePhaseWindows(progress),
    nativeScan: {
      detailedMetricsEnabled: report.scan?.progress?.detailedMetricsEnabled === true,
      backend: String(report.scan?.progress?.backend || 'unknown'),
      fallbackCode: String(report.scan?.progress?.fallbackCode || ''),
      durationMs: round(report.scan?.progress?.durationMs),
      enumMs: round(report.scan?.progress?.enumMs),
      filesystemEnumMs: round(report.scan?.progress?.filesystemEnumMs),
      queueWaitMs: round(report.scan?.progress?.queueWaitMs),
      queueSubmitCount: finite(report.scan?.progress?.queueSubmitCount),
      queueBlockedCount: finite(report.scan?.progress?.queueBlockedCount),
      queueBlockedPercent: ratioPercent(
        report.scan?.progress?.queueBlockedCount,
        report.scan?.progress?.queueSubmitCount,
      ),
      readMs: round(report.scan?.progress?.readMs),
      readFileCount: finite(report.scan?.progress?.readFileCount),
      readBytes: finite(report.scan?.progress?.readBytes),
      readMiBPerSecond:
        finite(report.scan?.progress?.readMs) > 0
          ? round(
              finite(report.scan?.progress?.readBytes) /
                1024 /
                1024 /
                (finite(report.scan?.progress?.readMs) / 1000),
            )
          : 0,
      normalizeMs: round(report.scan?.progress?.normalizeMs),
      mapLookupMs: round(report.scan?.progress?.mapLookupMs),
      statMs: round(report.scan?.progress?.statMs),
      decodeMsTotal: round(report.scan?.progress?.decodeMsTotal),
      hashMsTotal: round(report.scan?.progress?.hashMsTotal),
      pushMs: round(report.scan?.progress?.pushMs),
      commitMs: round(report.scan?.progress?.commitMs),
      totalScanMs: round(report.scan?.progress?.totalScanMs),
      workers: finite(report.scan?.progress?.scanWorkerCount),
      peakQueuePending: finite(report.scan?.progress?.scanPeakQueuePending),
      workerMinCompleted: finite(report.scan?.progress?.scanWorkerMinCompleted),
      workerMaxCompleted: finite(report.scan?.progress?.scanWorkerMaxCompleted),
      workerCompletedSpread:
        finite(report.scan?.progress?.scanWorkerMaxCompleted) -
        finite(report.scan?.progress?.scanWorkerMinCompleted),
      workerMinBusyMs: round(report.scan?.progress?.scanWorkerMinBusyMs),
      workerMaxBusyMs: round(report.scan?.progress?.scanWorkerMaxBusyMs),
      workerBusySpreadMs: round(
        finite(report.scan?.progress?.scanWorkerMaxBusyMs) -
          finite(report.scan?.progress?.scanWorkerMinBusyMs),
      ),
      totalBytes: Math.max(
        finite(report.scan?.progress?.totalBytes),
        ...scanSamples.map((sample) => finite(sample.totalBytes)),
      ),
    },
    embedding: {
      dino: {
        effectiveBatchSize: finite(report.dino?.progress?.effectiveBatchSize),
        itemsPerSecond: round(
          Math.max(
            finite(report.dino?.progress?.itemsPerSecond),
            ...dinoSamples.map((sample) => finite(sample.itemsPerSecond)),
          ),
          3,
        ),
        stages: embeddingStageBreakdown(report.dino?.progress),
      },
      clip: {
        effectiveBatchSize: finite(report.clip?.progress?.effectiveBatchSize),
        itemsPerSecond: round(
          Math.max(
            finite(report.clip?.progress?.itemsPerSecond),
            ...clipSamples.map((sample) => finite(sample.itemsPerSecond)),
          ),
          3,
        ),
        stages: embeddingStageBreakdown(report.clip?.progress),
      },
    },
    resources: {
      samples: finite(report.resources?.sampling?.samples),
      errors: finite(report.resources?.sampling?.errors),
      failureCode: String(report.resources?.sampling?.failureCode || ''),
      checkpointRecovered: report.resources?.sampling?.checkpointRecovered === true,
      processRaceSkips: finite(report.resources?.sampling?.processRaceSkips),
      observedChildProcesses: finite(report.resources?.sampling?.observedChildProcesses),
      wallMs: round(report.resources?.wallMs),
      logicalCapacityPercentApprox: round(report.resources?.cpu?.logicalCapacityPercentApprox),
      mainPeakRssMiB: round(report.resources?.memory?.mainPeakRssMiB),
      mainPeakHeapUsedMiB: round(report.resources?.memory?.mainPeakHeapUsedMiB),
      childPeakAggregateRssMiBApprox: round(
        report.resources?.memory?.childPeakAggregateRssMiBApprox,
      ),
      childLargestPeakRssMiBApprox: round(report.resources?.memory?.childLargestPeakRssMiBApprox),
      systemMinFreeMiB: round(report.resources?.memory?.systemMinFreeMiB),
      gpuBaselineUsedMiB: report.resources?.gpu
        ? round(report.resources.gpu.baselineUsedMiB)
        : null,
      gpuPeakUsedMiB: report.resources?.gpu ? round(report.resources.gpu.peakUsedMiB) : null,
      gpuPeakDeltaUsedMiB: report.resources?.gpu
        ? round(report.resources.gpu.peakDeltaUsedMiB)
        : null,
      gpuTotalMiB: report.resources?.gpu ? round(report.resources.gpu.totalMiB) : null,
      gpuPeakUtilizationPercent: report.resources?.gpu
        ? round(report.resources.gpu.peakUtilizationPercent)
        : null,
      mainReadBytesApprox: finite(report.resources?.io?.mainReadBytesApprox),
      mainWriteBytesApprox: finite(report.resources?.io?.mainWriteBytesApprox),
      childReadBytesApprox: finite(report.resources?.io?.childReadBytesApprox),
      childWriteBytesApprox: finite(report.resources?.io?.childWriteBytesApprox),
      spawnedProcesses: finite(report.resources?.processes?.spawned),
      peakActiveProcesses: finite(report.resources?.processes?.peakActive),
    },
    correctness: {
      native: finite(report.scan?.digest?.count),
      dino: finite(report.embeddingDigests?.dino?.count),
      clip: finite(report.embeddingDigests?.clip?.count),
      index: finite(report.vectorIndex?.status?.count),
      sourceUnchanged: report.safety?.sourceUnchanged === true,
      isolatedUserData: report.safety?.isolatedUserData === true,
      commitFeedDropped: finite(report.pipeline?.result?.commitFeedDropped),
    },
  }
}

function pairedComparisons(runs) {
  const rounds = [...new Set(runs.map((run) => run.round))].sort((left, right) => left - right)
  return rounds.flatMap((roundNumber) => {
    const serial = runs.find((run) => run.round === roundNumber && run.pipeline === 'serial')
    const overlap = runs.find((run) => run.round === roundNumber && run.pipeline === 'overlap')
    if (!serial || !overlap) return []
    return [
      {
        round: roundNumber,
        serialReadyMs: serial.readyMs,
        overlapReadyMs: overlap.readyMs,
        improvementPercent: round((1 - overlap.readyMs / serial.readyMs) * 100),
      },
    ]
  })
}

function renderMarkdown(analysis) {
  const detailedRuns = [...analysis.runs, ...analysis.diagnostics]
  const runRows = analysis.runs
    .map(
      (run) =>
        `| ${run.round} | ${run.pipeline} | ${run.imageCount} | ${round(run.readyMs / 1000, 3)} | ${run.imagesPerSecond} | ${round(run.phases.imageScanMs / 1000, 3)} | ${round(run.phases.dinoInferencePersistenceMs / 1000, 3)} | ${round(run.phases.clipInferencePersistenceMs / 1000, 3)} | ${round(run.phases.vectorIndexBuildMs / 1000, 3)} | ${round(run.readyUnattributedMs / 1000, 3)} |`,
    )
    .join('\n')
  const pairedRows = analysis.paired
    .map(
      (pair) =>
        `| ${pair.round} | ${round(pair.serialReadyMs / 1000, 3)} | ${round(pair.overlapReadyMs / 1000, 3)} | ${pair.improvementPercent}% |`,
    )
    .join('\n')
  const milestoneRows = analysis.runs
    .filter((run) => run.pipeline === 'overlap')
    .map(
      (run) =>
        `| ${run.round} | ${round(run.milestones.scanReadyMs / 1000, 3)} | ${round(run.milestones.dinoReadyMs / 1000, 3)} | ${round(run.milestones.clipReadyMs / 1000, 3)} | ${round(run.milestones.vectorIndexMs / 1000, 3)} |`,
    )
    .join('\n')
  const intervalRows = analysis.runs
    .flatMap((run) =>
      Object.entries(run.progressIntervals).map(([stage, value]) => {
        const coverage = value.samples === 0 ? 'none' : value.partialCoverage ? 'partial' : 'full'
        return `| ${run.round} | ${run.pipeline} | ${stage} | ${coverage} | ${value.samples} | ${round(value.sampleCadenceMs.p95 / 1000, 3)} | ${round(value.p95ChangeGapMs / 1000, 3)} | ${round(value.maxChangeGapMs / 1000, 3)} | ${value.largestChangeGap?.location || '-'} | ${value.suspectedMidRunStalls} |`
      }),
    )
    .join('\n')
  const nativeRows = analysis.runs
    .map(
      (run) =>
        `| ${run.round} | ${run.pipeline} | ${run.nativeScan.backend} | ${run.nativeScan.fallbackCode || '-'} | ${run.nativeScan.workers} | ${round(run.nativeScan.enumMs / 1000, 3)} | ${round(run.nativeScan.decodeMsTotal / 1000, 3)} | ${round(run.nativeScan.hashMsTotal / 1000, 3)} | ${run.embedding.dino.itemsPerSecond} | ${run.embedding.clip.itemsPerSecond} |`,
    )
    .join('\n')
  const nativeDetailedRows = detailedRuns
    .map(
      (run) =>
        `| ${run.round ?? run.file} | ${run.pipeline} | ${run.nativeScan.detailedMetricsEnabled ? 'yes' : 'no'} | ${round(run.nativeScan.filesystemEnumMs / 1000, 3)} | ${round(run.nativeScan.queueWaitMs / 1000, 3)} | ${run.nativeScan.queueBlockedPercent}% | ${round(run.nativeScan.readMs / 1000, 3)} | ${run.nativeScan.readMiBPerSecond} | ${round(run.nativeScan.commitMs / 1000, 3)} | ${run.nativeScan.peakQueuePending} | ${run.nativeScan.workerCompletedSpread} | ${round(run.nativeScan.workerBusySpreadMs / 1000, 3)} |`,
    )
    .join('\n')
  const embeddingDetailedRows = detailedRuns
    .flatMap((run) =>
      ['dino', 'clip'].map((model) => {
        const stages = run.embedding[model].stages
        if (!stages.available) {
          return `| ${run.round ?? run.file} | ${run.pipeline} | ${model.toUpperCase()} | no | - | - | - | - | - | - | - | - | - |`
        }
        return `| ${run.round ?? run.file} | ${run.pipeline} | ${model.toUpperCase()} | yes | ${stages.batches} | ${round(stages.queueWaitMsTotal / 1000, 3)} | ${round(stages.runtimeLoadMs / 1000, 3)} | ${round(stages.decodeNormalizeMs / 1000, 3)} | ${round(stages.preprocessMs / 1000, 3)} | ${round(stages.inferenceMs / 1000, 3)} | ${stages.preInferenceSharePercent}% | ${round(stages.postprocessMs / 1000, 3)} | ${round(stages.persistenceMsTotal / 1000, 3)} |`
      }),
    )
    .join('\n')
  const harnessRows = analysis.runs
    .filter((run) => Object.keys(run.harness).length > 0)
    .map(
      (run) =>
        `| ${run.round} | ${run.pipeline} | ${round(run.harness.corpusDiscoveryMs / 1000, 3)} | ${round(run.harness.sourceSnapshotMs / 1000, 3)} | ${round(run.harness.isolatedCorpusCopyMs / 1000, 3)} |`,
    )
    .join('\n')
  const resourceRows = detailedRuns
    .map(
      (run) =>
        `| ${run.round ?? run.file} | ${run.pipeline} | ${run.resources.samples} | ${run.resources.errors}${run.resources.failureCode ? ` (${run.resources.failureCode})` : ''} | ${run.resources.checkpointRecovered ? 'yes' : 'no'} | ${run.resources.processRaceSkips} | ${run.resources.mainPeakRssMiB} | ${run.resources.childPeakAggregateRssMiBApprox} | ${run.resources.childLargestPeakRssMiBApprox} | ${run.resources.systemMinFreeMiB} |`,
    )
    .join('\n')
  const resourceDetailRows = detailedRuns
    .map(
      (run) =>
        `| ${run.round ?? run.file} | ${run.resources.gpuBaselineUsedMiB ?? '-'} | ${run.resources.gpuPeakUsedMiB ?? '-'} | ${run.resources.gpuPeakDeltaUsedMiB ?? '-'} | ${run.resources.gpuTotalMiB ?? '-'} | ${run.resources.gpuPeakUtilizationPercent ?? '-'} | ${round(run.resources.mainReadBytesApprox / 1024 ** 3, 3)} | ${round(run.resources.childReadBytesApprox / 1024 ** 3, 3)} | ${round(run.resources.mainWriteBytesApprox / 1024 ** 2, 3)} | ${round(run.resources.childWriteBytesApprox / 1024 ** 2, 3)} | ${run.resources.logicalCapacityPercentApprox}% | ${run.resources.spawnedProcesses}/${run.resources.peakActiveProcesses} |`,
    )
    .join('\n')
  const timelineRows = analysis.runs
    .map(
      (run) =>
        `| ${run.round} | ${run.pipeline} | ${run.timeline.available ? run.timeline.file : '-'} | ${run.timeline.progressIntervalMs || '-'} |`,
    )
    .join('\n')
  const diagnosticRows = analysis.diagnostics
    .map(
      (run) =>
        `| ${run.file} | ${run.imageCount} | ${round(run.readyMs / 1000, 3)} | ${round(run.phases.imageScanMs / 1000, 3)} | ${round(run.phases.dinoInferencePersistenceMs / 1000, 3)} | ${round(run.phases.clipInferencePersistenceMs / 1000, 3)} | ${run.resources.samples} | ${run.resources.errors}${run.resources.failureCode ? ` (${run.resources.failureCode})` : ''}${run.resources.checkpointRecovered ? ' recovered' : ''} |`,
    )
    .join('\n')
  const diagnosticGapRows = analysis.diagnostics
    .flatMap((run) =>
      Object.entries(run.progressIntervals).map(
        ([stage, value]) =>
          `| ${run.file} | ${stage} | ${value.samples} | ${round(value.sampleCadenceMs.p95 / 1000, 3)} | ${round(value.maxChangeGapMs / 1000, 3)} | ${value.largestChangeGap?.location || '-'} | ${value.suspectedMidRunStalls} |`,
      ),
    )
    .join('\n')
  return `# Image preparation detailed stage analysis

- Generated: ${analysis.generatedAt}
- Reports analyzed: ${analysis.runs.length}
- Supplemental instrumented reports: ${analysis.diagnostics.length}
- Source paths and source filenames are intentionally omitted.

## Per-run stages

| Round | Pipeline | Images | Ready s | Images/s | Scan s | DINO s | CLIP s | Vector index s | Unattributed ready s |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${runRows}

## Paired ready comparison

| Round | Serial s | Overlap s | Improvement |
| ---: | ---: | ---: | ---: |
${pairedRows || '| - | - | - | Waiting for a complete pair |'}

## Overlap milestones

| Round | Scan ready s | DINO ready s | CLIP ready s | Vector index s |
| ---: | ---: | ---: | ---: | ---: |
${milestoneRows || '| - | - | - | - | - |'}

## Progress-change intervals

Large gaps indicate a stage worth inspecting. Startup and tail gaps are labeled separately from suspected mid-run stalls. The stall threshold is sampling-aware, so an older coarsely sampled report is not mislabeled as a stall. Partial coverage means sampling began after that stage had already progressed.

| Round | Pipeline | Stage | Coverage | Samples | Sample P95 s | Change P95 s | Change max s | Max location | Mid-run stalls |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
${intervalRows}

## Harness setup

These timings are outside the product-ready metric. Corpus copy exists only to isolate benchmark writes from the source folder.

| Round | Pipeline | Discovery s | Source snapshot s | Isolated copy s |
| ---: | --- | ---: | ---: | ---: |
${harnessRows || '| - | - | - | - | Not recorded by this runner version |'}

## Native and embedding breakdown

Decode/hash values are worker-aggregate CPU time and may exceed wall time.

| Round | Pipeline | Scan backend | Fallback | Workers | Enum s | Decode aggregate s | Hash aggregate s | DINO img/s | CLIP img/s |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${nativeRows}

### Native detailed attribution

Enumeration is producer wall time. Pure filesystem enumeration excludes the callback, while queue wait shows producer backpressure. Read/commit and worker busy values are worker aggregates and can exceed scan wall time.

| Run | Pipeline | Detailed | Filesystem enum s | Queue wait s | Queue blocked | Read aggregate s | Read MiB/s | Commit aggregate s | Peak queue | Worker item spread | Worker busy spread s |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${nativeDetailedRows}

### Embedding detailed attribution

Child stage values are aggregate batch/worker time, not critical-path wall time. Fallback time overlaps the underlying stage buckets and is therefore kept out of the core-share denominator. Persistence is measured in the main process.

| Run | Pipeline | Model | Detailed | Batches | Queue wait s | Runtime load s | Decode/normalize s | Preprocess s | Inference s | Pre-inference share | Postprocess s | Persistence s |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${embeddingDetailedRows}

## Resource sampler

Child RSS and I/O are approximate direct-child aggregates. A recovered checkpoint is usable but remains visibly distinct from a clean final sampler result.

| Run | Pipeline | Samples | Errors | Checkpoint recovered | Process-race skips | Main RSS MiB | Child aggregate RSS MiB | Largest child RSS MiB | System minimum free MiB |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
${resourceRows || '| - | - | - | - | - | - | - | - | - | - |'}

| Run | GPU baseline MiB | GPU peak MiB | GPU delta MiB | GPU total MiB | GPU peak utilization | Main read GiB | Child read GiB | Main write MiB | Child write MiB | CPU logical capacity | Processes spawned/peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${resourceDetailRows || '| - | - | - | - | - | - | - | - | - | - | - | - |'}

## Durable per-run timelines

NDJSON timelines are written incrementally and remain useful if a future child run fails or times out. They omit source paths and filenames.

| Round | Pipeline | Timeline | Target interval ms |
| ---: | --- | --- | ---: |
${timelineRows}

## Supplemental instrumented runs

| Report | Images | Ready s | Scan s | DINO s | CLIP s | Resource samples | Resource errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${diagnosticRows || '| - | - | - | - | - | - | - | None |'}

| Report | Stage | Samples | Sample P95 s | Change max s | Max location | Mid-run stalls |
| --- | --- | ---: | ---: | ---: | --- | ---: |
${diagnosticGapRows || '| - | - | - | - | - | - | - |'}
`
}

function main() {
  const directory = resolveBenchmarkDirectory(process.argv.slice(2))
  const reportFiles = fs
    .readdirSync(directory)
    .filter((name) => /^round-\d+-(?:serial|overlap)\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name))
  const diagnosticFiles = fs
    .readdirSync(directory)
    .filter((name) => /^instrumented-(?:serial|overlap)-\d+(?:-[a-z0-9-]+)?\.json$/.test(name))
    .sort()
  if (reportFiles.length === 0 && diagnosticFiles.length === 0) {
    throw new Error('No completed round or instrumented reports found')
  }
  const runs = reportFiles
    .map(analyzeReport)
    .sort((left, right) =>
      left.round === right.round
        ? left.pipeline.localeCompare(right.pipeline)
        : left.round - right.round,
    )
  const diagnostics = diagnosticFiles.map((name) => analyzeReport(path.join(directory, name)))
  const analysis = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reportDirectory: path.basename(directory),
    runs,
    diagnostics,
    paired: pairedComparisons(runs),
  }
  fs.writeFileSync(
    path.join(directory, 'stage-analysis.json'),
    `${JSON.stringify(analysis, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(directory, 'stage-analysis.md'), renderMarkdown(analysis), 'utf8')
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        directory,
        runs: runs.length,
        diagnostics: diagnostics.length,
        pairs: analysis.paired.length,
      },
      null,
      2,
    )}\n`,
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

module.exports = {
  analyzeReport,
  embeddingStageBreakdown,
  isStrictChild,
  pairedComparisons,
  progressIntervals,
  resolveBenchmarkDirectory,
}
