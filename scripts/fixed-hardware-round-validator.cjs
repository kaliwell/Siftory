const FIXED_SCAN_WORKERS = 2
const TIMELINE_MAX_BYTES = 8 * 1024 * 1024
const TIMELINE_MAX_EVENTS = 50_000
const TIMESTAMP_TOLERANCE_MS = 2_000

function positiveFinite(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
}

function parseTimestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function expectedRoundConfig(config) {
  return {
    imageCount: config.sample,
    pipeline: 'overlap',
    backend: config.backend,
    jobs: config.jobs,
    batchSize: config.batchSize,
    requestedScanWorkers: FIXED_SCAN_WORKERS,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: TIMELINE_MAX_BYTES,
    timelineMaxEvents: TIMELINE_MAX_EVENTS,
  }
}

function directMlProviderEvidenceFailures(value, model) {
  const failures = []
  if (value?.schemaVersion !== 1 || value?.model !== model) {
    failures.push(model.toUpperCase() + ' provider telemetry is missing or has the wrong model')
    return failures
  }
  if (!Number.isInteger(value.reports) || value.reports < 1 || value.reports > 1_024) {
    failures.push(model.toUpperCase() + ' provider report count is invalid')
  }
  if (
    !Array.isArray(value.requestedBackends) ||
    value.requestedBackends.length !== 1 ||
    value.requestedBackends[0] !== 'gpu'
  ) {
    failures.push(model.toUpperCase() + ' requested provider backend was not exactly gpu')
  }
  if (
    !Array.isArray(value.selectedProviders) ||
    value.selectedProviders.length !== 1 ||
    value.selectedProviders[0] !== 'dml'
  ) {
    failures.push(model.toUpperCase() + ' effective provider was not exclusively DirectML')
  }
  if (value.fallbackDetected !== false) {
    failures.push(model.toUpperCase() + ' provider fallback was detected')
  }
  if (
    !Array.isArray(value.reasons) ||
    value.reasons.length < 1 ||
    value.reasons.length > 16 ||
    value.reasons.some(
      (reason) => typeof reason !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(reason),
    )
  ) {
    failures.push(model.toUpperCase() + ' provider reason telemetry is invalid')
  }
  return failures
}

function validateRound(run, proof, config, index, previousProof, mode) {
  const failures = []
  const prefix = 'round ' + (index + 1) + ': '
  if (run?.schemaVersion !== 1 || run?.ok !== true)
    failures.push(prefix + 'report did not pass schema v1')
  const expected = expectedRoundConfig(config)
  for (const [key, value] of Object.entries(expected)) {
    if (run?.config?.[key] !== value) failures.push(prefix + 'config differs: ' + key)
  }
  if (
    !Number.isInteger(run?.config?.sourceImageCount) ||
    run.config.sourceImageCount < config.sample
  ) {
    failures.push(prefix + 'source image count is incomplete')
  }
  if (run?.safety?.sourceDatasetReadOnly !== true)
    failures.push(prefix + 'source corpus was not read-only')
  if (run?.safety?.isolatedUserData !== true) failures.push(prefix + 'userData was not isolated')
  if (run?.safety?.sourceUnchanged !== true) failures.push(prefix + 'source corpus changed')
  if (run?.safety?.noBenchmarkChildProcessesAtStop !== true) {
    failures.push(prefix + 'benchmark child process remained at stop')
  }
  if (run?.safety?.sourceSnapshot?.count !== config.sample) {
    failures.push(prefix + 'source snapshot count differs')
  }
  if (run?.scan?.digest?.count !== config.sample)
    failures.push(prefix + 'Native scan count differs')
  if (run?.scan?.progress?.scanWorkerCount !== FIXED_SCAN_WORKERS) {
    failures.push(prefix + 'effective Native scan worker count differs')
  }
  if (run?.vectorIndex?.status?.built !== true) failures.push(prefix + 'vector index was not built')
  if (run?.vectorIndex?.status?.count !== config.sample)
    failures.push(prefix + 'vector count differs')
  if (run?.embeddingDigests?.dino?.count !== config.sample)
    failures.push(prefix + 'DINO count differs')
  if (run?.embeddingDigests?.clip?.count !== config.sample)
    failures.push(prefix + 'CLIP count differs')
  if (run?.pipeline?.result?.commitFeedDropped !== 0)
    failures.push(prefix + 'commit feed dropped paths')
  if (run?.warmVerification?.ok !== true) failures.push(prefix + 'warm verification failed')
  if (mode !== 'diagnostic') {
    for (const model of ['dino', 'clip']) {
      failures.push(
        ...directMlProviderEvidenceFailures(run?.providerEvidence?.[model], model).map(
          (failure) => prefix + failure,
        ),
      )
    }
  }

  const sampling = run?.resources?.sampling
  const processes = run?.resources?.processes
  if (sampling?.errors !== 0 || sampling?.failureCode)
    failures.push(prefix + 'resource sampling was incomplete')
  if (!Number.isInteger(sampling?.samples) || sampling.samples <= 0) {
    failures.push(prefix + 'resource sample count is missing')
  }
  if (sampling?.sampleCount !== sampling?.samples)
    failures.push(prefix + 'resource sample count is inconsistent')
  if (!Number.isInteger(sampling?.observedChildProcesses) || sampling.observedChildProcesses <= 0) {
    failures.push(prefix + 'resource sampler did not observe child processes')
  }
  if (!Number.isInteger(processes?.spawned) || processes.spawned <= 0) {
    failures.push(prefix + 'no benchmark child spawn was recorded')
  }
  if (
    !Number.isInteger(processes?.observedChildProcesses) ||
    processes.observedChildProcesses <= 0
  ) {
    failures.push(prefix + 'child lifecycle tracker observed no processes')
  }
  if (processes?.activeAtStop !== 0 || processes?.noResidualAtStop !== true) {
    failures.push(prefix + 'child lifecycle did not reach a clean stop')
  }
  if (processes?.lifecycleAccounted !== true)
    failures.push(prefix + 'child lifecycle evidence is incomplete')
  if (sampling?.observedChildEvidence?.lifecycleTracked !== processes?.observedChildProcesses) {
    failures.push(prefix + 'lifecycle child evidence is inconsistent')
  }
  if (sampling?.observedChildEvidence?.samplerObserved !== sampling?.observedChildProcesses) {
    failures.push(prefix + 'sampler child evidence is inconsistent')
  }
  if (sampling?.observedChildEvidence?.lifecycleAccounted !== true) {
    failures.push(prefix + 'combined child evidence is incomplete')
  }

  for (const [label, value] of [
    ['library ready time', run?.phases?.libraryReadyMs],
    ['main peak RSS', run?.resources?.memory?.mainPeakRssMiB],
    ['child peak RSS', run?.resources?.memory?.childPeakAggregateRssMiBApprox],
    ['system free memory', run?.resources?.memory?.systemMinFreeMiB],
  ]) {
    if (!positiveFinite(value)) failures.push(prefix + label + ' must be positive')
  }
  if (config.backend === 'gpu') {
    if (
      !positiveFinite(run?.resources?.gpu?.deviceCount) ||
      !positiveFinite(run?.resources?.gpu?.totalMiB)
    ) {
      failures.push(prefix + 'GPU telemetry is required for the GPU backend')
    }
  }

  const childStart = parseTimestamp(run?.execution?.startedAt)
  const childFinish = parseTimestamp(run?.execution?.finishedAt)
  const parentStart = parseTimestamp(proof?.startedAt)
  const parentFinish = parseTimestamp(proof?.finishedAt)
  if (
    !proof ||
    run?.execution?.runNonce !== proof.runNonce ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(proof?.runNonce || '')
  ) {
    failures.push(prefix + 'execution nonce is missing or does not match')
  }
  if (
    !run?.execution?.tempDirectoryId ||
    run.execution.tempDirectoryId !== run?.safety?.tempDirectoryId
  ) {
    failures.push(prefix + 'temporary directory identity is missing or inconsistent')
  }
  if (
    childStart === null ||
    childFinish === null ||
    parentStart === null ||
    parentFinish === null ||
    childStart > childFinish ||
    parentStart > parentFinish ||
    childStart + TIMESTAMP_TOLERANCE_MS < parentStart ||
    childFinish > parentFinish + TIMESTAMP_TOLERANCE_MS ||
    !positiveFinite(run?.execution?.durationMs)
  ) {
    failures.push(prefix + 'execution timestamps are invalid or stale')
  }
  if (previousProof && parentStart !== null) {
    const previousFinish = parseTimestamp(previousProof.finishedAt)
    if (previousFinish === null || parentStart < previousFinish) {
      failures.push(prefix + 'rounds were not consecutive')
    }
  }
  if (!/^[a-f0-9]{64}$/.test(proof?.reportSha256 || '') || !positiveFinite(proof?.reportBytes)) {
    failures.push(prefix + 'fresh report proof is incomplete')
  }
  if (
    !proof?.sandbox ||
    proof.sandbox.environmentPolicy !== 'minimal-allowlist-v1' ||
    proof.sandbox.networkModelFetchDisabled !== true ||
    proof.sandbox.nodeOptionsCleared !== true ||
    proof.sandbox.nodeInheritedOverridesDropped !== true ||
    proof.sandbox.systemFontsDisabled !== true ||
    proof.sandbox.performanceOverridesCleared !== true ||
    proof.sandbox.fixedHarnessOverrides?.scanWorkers !== FIXED_SCAN_WORKERS
  ) {
    failures.push(prefix + 'outer process environment was not isolated')
  }
  if (
    !proof?.timeline ||
    proof.timeline.bytes !== proof.timelineBytes ||
    proof.timeline.sha256 !== proof.timelineSha256 ||
    !/^[a-f0-9]{64}$/.test(proof.timelineSha256 || '') ||
    proof.timeline.events !== run?.timeline?.eventsWritten ||
    proof.timeline.bytes !== run?.timeline?.bytesWritten ||
    run?.timeline?.maxBytes !== TIMELINE_MAX_BYTES ||
    run?.timeline?.maxEvents !== TIMELINE_MAX_EVENTS ||
    proof.timeline.truncated !== run?.timeline?.truncated ||
    (proof.timeline.truncated && run?.timeline?.terminalEventWritten !== true)
  ) {
    failures.push(prefix + 'bounded timeline proof is incomplete')
  }
  return failures
}

module.exports = {
  FIXED_SCAN_WORKERS,
  TIMELINE_MAX_BYTES,
  TIMELINE_MAX_EVENTS,
  TIMESTAMP_TOLERANCE_MS,
  directMlProviderEvidenceFailures,
  expectedRoundConfig,
  parseTimestamp,
  positiveFinite,
  validateRound,
}
