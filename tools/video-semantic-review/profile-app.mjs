import {
  VIDEO_PROFILES,
  buildProfileReviewExport,
  normalizeProfileJudgment,
  summarizeSelectedProfileReview,
} from '/profile-model.mjs'

const token = new URLSearchParams(window.location.search).get('token') || ''
let activeProfiles = VIDEO_PROFILES
let profileById = new Map(activeProfiles.map((profile) => [profile.id, profile]))
const ids = [
  'fatal',
  'pageEyebrow',
  'pageTitle',
  'pageLede',
  'completionLabel',
  'readyLabel',
  'progressBar',
  'profileCounters',
  'benchmarkStatus',
  'benchmarkProgress',
  'benchmarkParse',
  'benchmarkFailed',
  'benchmarkLatency',
  'benchmarkProgressBar',
  'filterCount',
  'filterSelect',
  'sampleList',
  'samplePosition',
  'sampleTitle',
  'previousSample',
  'nextSample',
  'playerShell',
  'video',
  'playerEmpty',
  'playSegment',
  'segmentRange',
  'saveStatus',
  'sampleMeta',
  'acceptSuggestion',
  'suggestionReason',
  'profileButtons',
  'notes',
  'skipSample',
  'exportSummary',
]
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]))
let state = null
let selectionStorageKey = 'video-profile-review:selected'
let selectedSampleId = ''
let filteredSamples = []
let segmentPlaybackActive = false
let saveSequence = 0

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'X-Review-Token': token, ...(options.headers || {}) },
  })
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000)),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}
const currentSample = () =>
  state?.samples.find((sample) => sample.sampleId === selectedSampleId) || null
const judgmentFor = (sampleId) => normalizeProfileJudgment(state?.judgments?.[sampleId])
const currentJudgment = () => judgmentFor(selectedSampleId)

function filterSamples() {
  const filter = elements.filterSelect.value
  filteredSamples = state.samples.filter((sample) => {
    const verdict = judgmentFor(sample.sampleId).verdict
    return (
      filter === 'all' ||
      verdict === filter ||
      (filter === 'unreviewed' && verdict === 'unreviewed')
    )
  })
  if (!filteredSamples.some((sample) => sample.sampleId === selectedSampleId))
    selectedSampleId = filteredSamples[0]?.sampleId || state.samples[0]?.sampleId || ''
}
function renderOverview() {
  const summary = summarizeSelectedProfileReview(
    state.samples,
    state.judgments,
    state.targetPerProfile,
    state.targetProfileIds,
  )
  elements.completionLabel.textContent = `${summary.completed} / ${summary.samples} 已处理 · ${summary.skipped} 跳过`
  elements.readyLabel.textContent = `${summary.readyProfiles} / ${summary.totalProfiles} 类就绪`
  elements.readyLabel.classList.toggle('ready', summary.readyForBenchmark)
  elements.progressBar.style.width = `${summary.completionPercent}%`
  elements.profileCounters.replaceChildren(
    ...activeProfiles.map((profile) => {
      const count = summary.perProfile[profile.id].accepted,
        item = document.createElement('button')
      item.type = 'button'
      item.className = `profile-counter${count >= state.targetPerProfile ? ' complete' : ''}`
      item.innerHTML = `<span>${profile.shortLabel}</span><strong>${count}/${state.targetPerProfile}</strong>`
      item.addEventListener('click', () => {
        elements.filterSelect.value = 'accepted'
        filteredSamples = state.samples.filter(
          (sample) => judgmentFor(sample.sampleId).profileId === profile.id,
        )
        selectedSampleId = filteredSamples[0]?.sampleId || selectedSampleId
        renderAll(false)
      })
      return item
    }),
  )
}

function renderBenchmarkStatus(benchmark) {
  if (!benchmark?.available) return
  elements.benchmarkStatus.hidden = false
  const percent = benchmark.total
    ? Math.round(((benchmark.completed + benchmark.failed) / benchmark.total) * 100)
    : 0
  const stateLabel =
    { running: '运行中', completed: '已完成', paused: '已暂停' }[benchmark.state] || benchmark.state
  elements.benchmarkProgress.textContent = `${stateLabel} · ${benchmark.completed}/${benchmark.total}`
  elements.benchmarkParse.textContent = `严格 JSON ${benchmark.parsePassed}/${benchmark.resultCount}`
  elements.benchmarkFailed.textContent = `失败 ${benchmark.failed}`
  elements.benchmarkLatency.textContent = benchmark.averageLatencyMs
    ? `平均耗时 ${(benchmark.averageLatencyMs / 1000).toFixed(1)} 秒`
    : '平均耗时 —'
  elements.benchmarkProgressBar.style.width = `${percent}%`
}

async function refreshBenchmarkStatus() {
  try {
    const response = await api('/api/profile/benchmark/state')
    renderBenchmarkStatus(response.benchmark)
  } catch {
    // The primary review workflow remains available if status polling fails.
  }
}
function renderList() {
  elements.filterCount.textContent = `${filteredSamples.length} 条`
  elements.sampleList.replaceChildren(
    ...filteredSamples.map((sample, index) => {
      const judgment = judgmentFor(sample.sampleId),
        button = document.createElement('button')
      const status =
        judgment.verdict === 'accepted'
          ? profileById.get(judgment.profileId)?.shortLabel
          : judgment.verdict === 'skipped'
            ? '已跳过'
            : '未分类'
      button.type = 'button'
      button.className = `profile-sample-card${sample.sampleId === selectedSampleId ? ' active' : ''}`
      button.innerHTML = `<span class="sample-index">${String(index + 1).padStart(3, '0')}</span><span class="sample-card-main"><strong>${sample.sampleId}</strong><small>${formatDuration(sample.durationMs)} · ${sample.resolution}</small></span><span class="sample-card-status ${judgment.verdict}">${status}</span>`
      button.addEventListener('click', () => selectSample(sample.sampleId))
      return button
    }),
  )
}
function metaItem(label, value) {
  const item = document.createElement('div')
  item.innerHTML = `<span>${label}</span><strong>${value}</strong>`
  return item
}
function renderStage(loadVideo = true) {
  const sample = currentSample()
  if (!sample) {
    elements.sampleTitle.textContent = '当前筛选没有样本'
    elements.playerEmpty.hidden = false
    elements.video.removeAttribute('src')
    elements.video.load()
    return
  }
  const globalIndex = state.samples.findIndex((item) => item.sampleId === sample.sampleId)
  elements.samplePosition.textContent = `全库 ${globalIndex + 1}/${state.samples.length}`
  elements.sampleTitle.textContent = sample.sampleId
  elements.segmentRange.textContent = `${formatDuration(sample.target.startMs)} – ${formatDuration(sample.target.endMs)}`
  elements.sampleMeta.replaceChildren(
    metaItem('时长', formatDuration(sample.durationMs)),
    metaItem('分辨率', sample.resolution),
    metaItem('方向', { portrait: '竖屏', landscape: '横屏', square: '近方形' }[sample.orientation]),
    metaItem(
      '时长层',
      { short: '短 <2 分钟', medium: '中 2–30 分钟', long: '长 ≥30 分钟' }[sample.durationBucket],
    ),
    metaItem('视频编码', sample.videoCodec || '未知'),
    metaItem(
      '音频/转写',
      `${sample.hasAudio ? '有音轨' : '无音轨'} · ${sample.hasTranscript ? '已转写' : '无转写'}`,
    ),
  )
  const suggestion = profileById.get(sample.proposedProfileId)
  elements.acceptSuggestion.textContent = `采用弱建议：${suggestion?.shortLabel || '通用'}`
  elements.suggestionReason.textContent = sample.proposalReason
  const judgment = currentJudgment()
  elements.notes.value = judgment.notes
  elements.saveStatus.textContent = judgment.reviewedAt
    ? `已保存 ${new Date(judgment.reviewedAt).toLocaleTimeString()}`
    : '尚未分类'
  elements.profileButtons.replaceChildren(
    ...activeProfiles.map((profile) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `profile-choice${judgment.profileId === profile.id ? ' active' : ''}`
      button.innerHTML = `<strong>${profile.shortLabel}</strong><span>${profile.label}</span>`
      button.addEventListener('click', () => saveClassification(profile.id))
      return button
    }),
  )
  if (loadVideo) {
    segmentPlaybackActive = false
    elements.playerEmpty.hidden = true
    elements.video.src = `/api/profile/video/${sample.sampleId}?token=${encodeURIComponent(token)}`
    elements.video.load()
  }
}
function renderAll(loadVideo = true) {
  renderOverview()
  renderList()
  renderStage(loadVideo)
}
function selectSample(sampleId) {
  selectedSampleId = sampleId
  localStorage.setItem(selectionStorageKey, sampleId)
  renderAll(true)
}
function moveSelection(delta) {
  const source = filteredSamples.length ? filteredSamples : state.samples,
    index = source.findIndex((sample) => sample.sampleId === selectedSampleId),
    next = source[Math.max(0, Math.min(source.length - 1, index + delta))]
  if (next) selectSample(next.sampleId)
}
async function persistJudgment(judgment) {
  const sampleId = selectedSampleId,
    sequence = ++saveSequence
  elements.saveStatus.textContent = '正在保存…'
  const response = await api(`/api/profile/review/${sampleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markReviewed: true, judgment }),
  })
  state.judgments[sampleId] = response.judgment
  if (sequence === saveSequence) elements.saveStatus.textContent = '已保存'
}
async function saveClassification(profileId) {
  try {
    await persistJudgment({ verdict: 'accepted', profileId, notes: elements.notes.value })
    if (elements.filterSelect.value === 'unreviewed') {
      filterSamples()
      renderAll(true)
    } else {
      renderAll(false)
      window.setTimeout(() => moveSelection(1), 180)
    }
  } catch (error) {
    elements.saveStatus.textContent = `保存失败：${error.message}`
  }
}
async function skipCurrent() {
  try {
    await persistJudgment({ verdict: 'skipped', profileId: '', notes: elements.notes.value })
    filterSamples()
    renderAll(true)
  } catch (error) {
    elements.saveStatus.textContent = `保存失败：${error.message}`
  }
}
function playTargetSegment() {
  const sample = currentSample()
  if (!sample) return
  segmentPlaybackActive = true
  elements.video.currentTime = sample.target.startMs / 1000
  void elements.video.play()
}
function downloadJson(value, fileName) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }),
    link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
async function load() {
  state = await api('/api/profile/state')
  activeProfiles =
    Array.isArray(state.profiles) && state.profiles.length ? state.profiles : VIDEO_PROFILES
  profileById = new Map(activeProfiles.map((profile) => [profile.id, profile]))
  selectionStorageKey = `video-profile-review:${state.mode || 'full'}:selected`
  selectedSampleId = localStorage.getItem(selectionStorageKey) || ''
  elements.pageEyebrow.textContent = state.presentation?.eyebrow || 'VID-016 · 真实素材分层验收'
  elements.pageTitle.textContent = state.presentation?.title || '多类型视频样本库'
  elements.pageLede.textContent = state.presentation?.lede || ''
  filterSamples()
  renderAll(true)
  if (!String(state.mode || '').startsWith('gap')) {
    await refreshBenchmarkStatus()
    window.setInterval(refreshBenchmarkStatus, 5_000)
  }
}

elements.filterSelect.addEventListener('change', () => {
  filterSamples()
  renderAll(true)
})
elements.previousSample.addEventListener('click', () => moveSelection(-1))
elements.nextSample.addEventListener('click', () => moveSelection(1))
elements.playSegment.addEventListener('click', playTargetSegment)
elements.acceptSuggestion.addEventListener('click', () => {
  const sample = currentSample()
  if (sample) void saveClassification(sample.proposedProfileId)
})
elements.skipSample.addEventListener('click', () => void skipCurrent())
elements.notes.addEventListener('change', async () => {
  const judgment = currentJudgment()
  if (judgment.verdict === 'unreviewed') return
  await persistJudgment({ ...judgment, notes: elements.notes.value }).catch((error) => {
    elements.saveStatus.textContent = `保存失败：${error.message}`
  })
})
elements.video.addEventListener('timeupdate', () => {
  const sample = currentSample()
  if (segmentPlaybackActive && sample && elements.video.currentTime * 1000 >= sample.target.endMs) {
    segmentPlaybackActive = false
    elements.video.pause()
  }
})
elements.exportSummary.addEventListener('click', () =>
  downloadJson(
    buildProfileReviewExport(state.samples, state.judgments, new Date(), state.targetProfileIds),
    state.presentation?.exportFileName || 'video-profile-corpus-summary.json',
  ),
)
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)
    return
  if (event.key === 'ArrowLeft') moveSelection(-1)
  if (event.key === 'ArrowRight') moveSelection(1)
  const numeric = Number(event.key)
  if (numeric >= 1 && numeric <= activeProfiles.length)
    void saveClassification(activeProfiles[numeric - 1].id)
  if (event.key === ' ') {
    event.preventDefault()
    playTargetSegment()
  }
})
if (!token) {
  elements.fatal.hidden = false
  elements.fatal.textContent = '缺少本地访问令牌。请使用 npm run review:profiles 输出的完整地址。'
} else {
  load().catch((error) => {
    elements.fatal.hidden = false
    elements.fatal.textContent = `无法读取验收数据：${error.message}`
  })
}
