import {
  buildBenchmarkReviewExport,
  normalizeBenchmarkJudgment,
  summarizeBenchmarkReview,
} from '/benchmark-model.mjs'

const token = new URLSearchParams(window.location.search).get('token') || ''
const ids = [
  'fatal',
  'backToProfiles',
  'exportReview',
  'reviewProgress',
  'acceptanceLabel',
  'reviewProgressBar',
  'generatedLabel',
  'consistentLabel',
  'partialLabel',
  'inconsistentLabel',
  'hallucinationLabel',
  'filterCount',
  'filterSelect',
  'profileFilter',
  'sampleList',
  'samplePosition',
  'sampleTitle',
  'previousSample',
  'nextSample',
  'video',
  'playerEmpty',
  'playSegment',
  'segmentRange',
  'saveStatus',
  'semanticTitle',
  'semanticSummary',
  'resultMeta',
  'sceneTags',
  'eventList',
  'semanticDetails',
  'warningList',
  'reviewPanel',
  'verdictButtons',
  'hallucinationButtons',
  'timestampButtons',
  'watchedFullSegment',
  'notes',
]
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]))
let state = null
let selectedSampleId = localStorage.getItem('video-benchmark-review:selected') || ''
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
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}
const currentSample = () => state?.samples.find((sample) => sample.sampleId === selectedSampleId)
const judgmentFor = (sampleId) => normalizeBenchmarkJudgment(state?.judgments?.[sampleId])

function filterSamples() {
  const filter = elements.filterSelect.value
  const profile = elements.profileFilter.value
  filteredSamples = state.samples.filter((sample) => {
    const judgment = judgmentFor(sample.sampleId)
    const profileMatches = profile === 'all' || sample.profileId === profile
    const stateMatches =
      filter === 'all' ||
      (filter === 'ready' && sample.resultState === 'ready') ||
      (filter === 'deep-unreviewed' &&
        sample.resultState === 'ready' &&
        (judgment.verdict === 'unreviewed' || !judgment.watchedFullSegment)) ||
      (filter === 'unreviewed' &&
        sample.resultState === 'ready' &&
        judgment.verdict === 'unreviewed') ||
      judgment.verdict === filter
    return profileMatches && stateMatches
  })
  if (!filteredSamples.some((sample) => sample.sampleId === selectedSampleId))
    selectedSampleId = filteredSamples[0]?.sampleId || ''
}

function renderOverview() {
  const summary = summarizeBenchmarkReview(state.samples, state.judgments)
  const fullyWatched = state.samples.filter(
    (sample) => sample.resultState === 'ready' && judgmentFor(sample.sampleId).watchedFullSegment,
  ).length
  elements.reviewProgress.textContent = `完整观看 ${fullyWatched} / ${summary.generated} · 初筛 ${summary.reviewed} / ${summary.generated}`
  elements.acceptanceLabel.textContent = summary.reviewed
    ? `语义接受率 ${summary.semanticAcceptancePercent}% · 严格一致 ${summary.strictConsistencyPercent}%`
    : '语义接受率 —'
  elements.reviewProgressBar.style.width = `${summary.generated ? Math.round((fullyWatched / summary.generated) * 100) : 0}%`
  elements.exportReview.disabled = !summary.deepTruthReady
  elements.exportReview.textContent = summary.deepTruthReady
    ? '导出匿名深度真值'
    : `完整观看后导出（${summary.fullWatch.completed}/${summary.generated}）`
  elements.generatedLabel.textContent = `已生成 ${summary.generated} / ${summary.planned}`
  elements.consistentLabel.textContent = `像 ${summary.counts.consistent}`
  elements.partialLabel.textContent = `部分像 ${summary.counts.partial}`
  elements.inconsistentLabel.textContent = `不像 ${summary.counts.inconsistent}`
  elements.hallucinationLabel.textContent = `明显幻觉 ${summary.counts.major}`
}

function renderList() {
  elements.filterCount.textContent = `${filteredSamples.length} 条`
  elements.sampleList.replaceChildren(
    ...filteredSamples.map((sample, index) => {
      const judgment = judgmentFor(sample.sampleId)
      const button = document.createElement('button')
      const label =
        sample.resultState !== 'ready'
          ? '生成中'
          : {
              unreviewed: '待复核',
              consistent: '像',
              partial: '部分像',
              inconsistent: '不像',
            }[judgment.verdict]
      button.type = 'button'
      button.className = `profile-sample-card${sample.sampleId === selectedSampleId ? ' active' : ''}`
      button.innerHTML = `<span class="sample-index">${String(index + 1).padStart(2, '0')}</span><span class="sample-card-main"><strong>${sample.profileLabel}</strong><small>${sample.sampleId}</small></span><span class="sample-card-status ${judgment.verdict}">${label}</span>`
      button.addEventListener('click', () => selectSample(sample.sampleId))
      return button
    }),
  )
}

function renderTagList(target, values) {
  target.replaceChildren(
    ...(values || []).map((value) => {
      const tag = document.createElement('span')
      tag.textContent = value
      return tag
    }),
  )
  if (!target.childElementCount) target.textContent = '—'
}

function detailGroup(label, values) {
  const section = document.createElement('section')
  const heading = document.createElement('h5')
  const body = document.createElement('p')
  heading.textContent = label
  body.textContent = values?.length ? values.join(' · ') : '—'
  section.append(heading, body)
  return section
}

function renderResult(sample) {
  const result = sample?.result
  elements.semanticTitle.textContent = result ? `${sample.profileLabel} · 模型描述` : '模型描述'
  elements.semanticSummary.textContent =
    result?.summary || (sample ? '模型结果尚未生成，请稍后刷新。' : '选择一个样本。')
  elements.resultMeta.replaceChildren()
  if (result) {
    for (const value of [
      `${(sample.latencyMs / 1000).toFixed(1)} 秒`,
      `${sample.peakGpuUsedMiB || 0} MiB GPU`,
      sample.modelLabel,
    ]) {
      const tag = document.createElement('span')
      tag.textContent = value
      elements.resultMeta.append(tag)
    }
  }
  renderTagList(elements.sceneTags, result?.scenes)
  elements.eventList.replaceChildren(
    ...(result?.events || []).map((event) => {
      const item = document.createElement('article')
      const title = document.createElement('strong')
      const description = document.createElement('p')
      title.textContent = `${formatDuration(event.startMs)}–${formatDuration(event.endMs)} · ${event.label}`
      description.textContent = event.description
      item.append(title, description)
      return item
    }),
  )
  if (!elements.eventList.childElementCount) elements.eventList.textContent = '—'
  elements.semanticDetails.replaceChildren(
    detailGroup('人物', result?.persons),
    detailGroup('物体', result?.objects),
    detailGroup('画面文字', result?.visualText),
    detailGroup('检索词', result?.searchTags),
  )
  elements.warningList.replaceChildren(
    ...(result?.warnings || []).map((warning) => {
      const item = document.createElement('p')
      item.textContent = warning
      return item
    }),
  )
}

function setActiveButtons(container, attribute, value) {
  for (const button of container.querySelectorAll('button'))
    button.classList.toggle('active', button.dataset[attribute] === value)
}

function renderStage(loadVideo = true) {
  const sample = currentSample()
  if (!sample) {
    elements.samplePosition.textContent = '当前筛选没有样本'
    elements.sampleTitle.textContent = '基准样本'
    elements.video.removeAttribute('src')
    elements.video.load()
    elements.playerEmpty.hidden = false
    renderResult(null)
    elements.reviewPanel.classList.add('disabled')
    return
  }
  const judgment = judgmentFor(sample.sampleId)
  elements.samplePosition.textContent = `计划 ${state.samples.indexOf(sample) + 1}/${state.samples.length}`
  elements.sampleTitle.textContent = `${sample.profileLabel} · ${sample.sampleId}`
  elements.segmentRange.textContent = `${formatDuration(sample.target.startMs)}–${formatDuration(sample.target.endMs)}`
  elements.saveStatus.textContent =
    sample.resultState !== 'ready'
      ? '等待模型生成'
      : judgment.reviewedAt
        ? `已保存 ${new Date(judgment.reviewedAt).toLocaleTimeString()}`
        : '尚未复核'
  renderResult(sample)
  const ready = sample.resultState === 'ready'
  elements.reviewPanel.classList.toggle('disabled', !ready)
  for (const control of elements.reviewPanel.querySelectorAll('button,input,textarea'))
    control.disabled = !ready
  setActiveButtons(elements.verdictButtons, 'verdict', judgment.verdict)
  setActiveButtons(elements.hallucinationButtons, 'value', judgment.hallucination)
  setActiveButtons(elements.timestampButtons, 'value', judgment.timestamp)
  elements.watchedFullSegment.checked = judgment.watchedFullSegment
  elements.notes.value = judgment.notes
  if (loadVideo) {
    segmentPlaybackActive = false
    elements.playerEmpty.hidden = !ready
    if (ready)
      elements.video.src = `/api/profile/benchmark/video/${sample.sampleId}?token=${encodeURIComponent(token)}`
    else elements.video.removeAttribute('src')
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
  localStorage.setItem('video-benchmark-review:selected', sampleId)
  renderAll(true)
}
function moveSelection(delta) {
  const index = filteredSamples.findIndex((sample) => sample.sampleId === selectedSampleId)
  const next = filteredSamples[Math.max(0, Math.min(filteredSamples.length - 1, index + delta))]
  if (next) selectSample(next.sampleId)
}

async function persistJudgment(changes, advance = false) {
  const sampleId = selectedSampleId
  if (!sampleId || currentSample()?.resultState !== 'ready') return
  const sequence = ++saveSequence
  elements.saveStatus.textContent = '正在保存…'
  const judgment = { ...judgmentFor(sampleId), ...changes }
  const response = await api(`/api/profile/benchmark/review/${sampleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markReviewed: judgment.verdict !== 'unreviewed', judgment }),
  })
  state.judgments[sampleId] = response.judgment
  if (sequence === saveSequence) elements.saveStatus.textContent = '已保存'
  const activeFilter = elements.filterSelect.value
  const shouldAdvance =
    advance &&
    ((activeFilter === 'unreviewed' && judgment.verdict !== 'unreviewed') ||
      (activeFilter === 'deep-unreviewed' &&
        judgment.verdict !== 'unreviewed' &&
        judgment.watchedFullSegment))
  if (shouldAdvance) {
    filterSamples()
    renderAll(true)
  } else renderAll(false)
}

function playTargetSegment() {
  const sample = currentSample()
  if (!sample || sample.resultState !== 'ready') return
  segmentPlaybackActive = true
  elements.video.currentTime = sample.target.startMs / 1000
  void elements.video.play()
}

function downloadJson(value, fileName) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000)
}

async function refreshState() {
  const next = await api('/api/profile/benchmark/review-state')
  state = next
  filterSamples()
  if (document.activeElement === elements.notes) {
    renderOverview()
    renderList()
  } else {
    renderAll(false)
  }
}
async function load() {
  state = await api('/api/profile/benchmark/review-state')
  elements.backToProfiles.href = `/profiles?token=${encodeURIComponent(token)}`
  elements.profileFilter.append(
    ...state.profiles.map((profile) => {
      const option = document.createElement('option')
      option.value = profile.id
      option.textContent = profile.shortLabel
      return option
    }),
  )
  filterSamples()
  renderAll(true)
  window.setInterval(() => void refreshState().catch(() => {}), 5_000)
}

elements.filterSelect.addEventListener('change', () => {
  filterSamples()
  renderAll(true)
})
elements.profileFilter.addEventListener('change', () => {
  filterSamples()
  renderAll(true)
})
elements.previousSample.addEventListener('click', () => moveSelection(-1))
elements.nextSample.addEventListener('click', () => moveSelection(1))
elements.playSegment.addEventListener('click', playTargetSegment)
for (const button of elements.verdictButtons.querySelectorAll('button'))
  button.addEventListener(
    'click',
    () => void persistJudgment({ verdict: button.dataset.verdict }, true),
  )
for (const button of elements.hallucinationButtons.querySelectorAll('button'))
  button.addEventListener(
    'click',
    () => void persistJudgment({ hallucination: button.dataset.value }),
  )
for (const button of elements.timestampButtons.querySelectorAll('button'))
  button.addEventListener('click', () => void persistJudgment({ timestamp: button.dataset.value }))
elements.watchedFullSegment.addEventListener(
  'change',
  () =>
    void persistJudgment(
      { watchedFullSegment: elements.watchedFullSegment.checked },
      elements.watchedFullSegment.checked && elements.filterSelect.value === 'deep-unreviewed',
    ),
)
elements.notes.addEventListener(
  'change',
  () => void persistJudgment({ notes: elements.notes.value }),
)
elements.video.addEventListener('timeupdate', () => {
  const sample = currentSample()
  if (segmentPlaybackActive && sample && elements.video.currentTime * 1000 >= sample.target.endMs) {
    segmentPlaybackActive = false
    elements.video.pause()
  }
})
elements.exportReview.addEventListener('click', () => {
  if (!summarizeBenchmarkReview(state.samples, state.judgments).deepTruthReady) return
  downloadJson(
    buildBenchmarkReviewExport(state.samples, state.judgments),
    'video-profile-semantic-review-summary.json',
  )
})
window.addEventListener('keydown', (event) => {
  if (
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLInputElement
  )
    return
  if (event.key === 'ArrowLeft') moveSelection(-1)
  if (event.key === 'ArrowRight') moveSelection(1)
  const verdict = { 1: 'consistent', 2: 'partial', 3: 'inconsistent' }[event.key]
  if (verdict) void persistJudgment({ verdict }, true)
  if (event.key === ' ') {
    event.preventDefault()
    playTargetSegment()
  }
})

if (!token) {
  elements.fatal.hidden = false
  elements.fatal.textContent = '缺少本地访问令牌，请使用验收服务输出的完整地址。'
} else
  load().catch((error) => {
    elements.fatal.hidden = false
    elements.fatal.textContent = `无法读取语义复核数据：${error.message}`
  })
