import {
  buildRegressionReviewExport,
  normalizeRegressionJudgment,
  summarizeRegressionReview,
} from '/regression-model.mjs'

const token = new URLSearchParams(window.location.search).get('token') || ''
const shadowMode =
  window.location.pathname === '/shadow' || window.location.pathname === '/shadow.html'
const mitigationMode =
  window.location.pathname === '/mitigation' || window.location.pathname === '/mitigation.html'
const stateEndpoint = mitigationMode
  ? '/api/profile/benchmark/mitigation-state'
  : shadowMode
    ? '/api/profile/benchmark/shadow-state'
    : '/api/profile/benchmark/regression-state'
const reviewEndpoint = mitigationMode
  ? '/api/profile/benchmark/mitigation-review'
  : shadowMode
    ? '/api/profile/benchmark/shadow-review'
    : '/api/profile/benchmark/regression-review'
const storageKey = mitigationMode
  ? 'video-mitigation-review:selected'
  : shadowMode
    ? 'video-shadow-review:selected'
    : 'video-regression-review:selected'
const leftVersionLabel = mitigationMode ? 'V7' : 'V1'
const rightVersionLabel = mitigationMode ? 'V8.1' : 'V7'
const ids = [
  'fatal',
  'pageEyebrow',
  'pageTitle',
  'pageLede',
  'backToBenchmark',
  'exportReview',
  'reviewProgress',
  'resultLabel',
  'reviewProgressBar',
  'improvedLabel',
  'sameLabel',
  'regressedLabel',
  'fullWatchLabel',
  'sampleList',
  'samplePosition',
  'sampleTitle',
  'previousSample',
  'nextSample',
  'video',
  'videoShell',
  'playerEmpty',
  'playSegment',
  'segmentRange',
  'saveStatus',
  'archiveNote',
  'v1Card',
  'v7Card',
  'reviewTitle',
  'reviewPanel',
  'verdictButtons',
  'preferenceButtons',
  'watchedFullSegment',
  'notes',
]
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]))
let state = null
let selectedSampleId = localStorage.getItem(storageKey) || ''
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
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const currentSample = () => state?.samples.find((sample) => sample.sampleId === selectedSampleId)
const judgmentFor = (sampleId) => normalizeRegressionJudgment(state?.judgments?.[sampleId])

function applyVideoGeometry(width, height) {
  const ratio = Number(width) / Number(height)
  if (!Number.isFinite(ratio) || ratio <= 0) return
  elements.videoShell.style.setProperty('--video-source-ratio', String(ratio))
  elements.videoShell.dataset.orientation =
    ratio < 0.92 ? 'portrait' : ratio > 1.08 ? 'landscape' : 'square'
}

function resultSection(title, values) {
  const section = document.createElement('section')
  const heading = document.createElement('h4')
  heading.textContent = title
  section.append(heading)
  if (!values?.length) {
    const empty = document.createElement('p')
    empty.textContent = '—'
    section.append(empty)
    return section
  }
  const list = document.createElement('div')
  list.className = 'semantic-list compact'
  for (const value of values) {
    const item = document.createElement('p')
    item.textContent =
      typeof value === 'string'
        ? value
        : `${formatDuration(value.startMs)}–${formatDuration(value.endMs)} · ${value.label}：${value.description}`
    list.append(item)
  }
  section.append(list)
  return section
}

function renderRun(card, label, run) {
  card.replaceChildren()
  const eyebrow = document.createElement('p')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = label
  const heading = document.createElement('h3')
  heading.textContent =
    run.promptVersion === 'unknown' ? '结果未就绪' : `提示词 ${run.promptVersion}`
  const meta = document.createElement('div')
  meta.className = 'result-meta'
  for (const value of [
    `${(run.latencyMs / 1000).toFixed(1)} 秒`,
    `${run.peakGpuUsedMiB} MiB GPU`,
  ]) {
    const tag = document.createElement('span')
    tag.textContent = value
    meta.append(tag)
  }
  const summary = document.createElement('p')
  summary.className = 'semantic-summary'
  summary.textContent = run.result?.summary || '该版本没有可比较结果。'
  card.append(eyebrow, heading, meta, summary)
  if (!run.result) return
  card.append(
    resultSection('场景', run.result.scenes),
    resultSection('事件', run.result.events),
    resultSection('人物', run.result.persons),
    resultSection('物体', run.result.objects),
    resultSection('画面文字', run.result.visualText),
    resultSection('检索词', run.result.searchTags),
    resultSection('警告', run.result.warnings),
  )
}

function setActiveButtons(container, attribute, value) {
  for (const button of container.querySelectorAll('button'))
    button.classList.toggle('active', button.dataset[attribute] === value)
}

function renderOverview() {
  const summary = summarizeRegressionReview(state.samples, state.judgments)
  elements.reviewProgress.textContent = `${summary.reviewed} / ${summary.comparable} 已判断`
  elements.resultLabel.textContent = summary.reviewed
    ? `${rightVersionLabel} 更好 ${summary.preferences.v7} · ${leftVersionLabel} 更好 ${summary.preferences.v1}`
    : '等待人工对照'
  elements.reviewProgressBar.style.width = `${summary.completionPercent}%`
  elements.improvedLabel.textContent = `改善 ${summary.verdicts.improved}`
  elements.sameLabel.textContent = `持平 ${summary.verdicts.same}`
  elements.regressedLabel.textContent = `退化 ${summary.verdicts.regressed}`
  elements.fullWatchLabel.textContent = `完整观看 ${summary.watchedFullSegment}`
}

function renderList() {
  elements.sampleList.replaceChildren(
    ...state.samples.map((sample, index) => {
      const judgment = judgmentFor(sample.sampleId)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `regression-sample-tab${sample.sampleId === selectedSampleId ? ' active' : ''}`
      const status = { unreviewed: '待判断', improved: '改善', same: '持平', regressed: '退化' }[
        judgment.verdict
      ]
      const title = document.createElement('strong')
      title.textContent = `${index + 1}. ${sample.profileLabel}`
      const subtitle = document.createElement('small')
      const baselineLabel = {
        consistent: '原：像',
        partial: '原：部分像',
        inconsistent: '原：不像',
        unreviewed: '原：未判断',
      }[sample.baselineVerdict]
      subtitle.textContent = `${baselineLabel || '原：未知'} · 变化 ${sample.difference?.changeScore || 0} · ${status}`
      button.append(title, subtitle)
      button.addEventListener('click', () => selectSample(sample.sampleId))
      return button
    }),
  )
}

function renderStage(loadVideo = true) {
  const sample = currentSample()
  if (!sample) return
  const judgment = judgmentFor(sample.sampleId)
  const ready = sample.v1.resultState === 'ready' && sample.v7.resultState === 'ready'
  elements.samplePosition.textContent = `样本 ${state.samples.indexOf(sample) + 1}/${state.samples.length}`
  elements.sampleTitle.textContent = `${sample.profileLabel} · ${sample.sampleId}`
  elements.segmentRange.textContent = `${formatDuration(sample.target.startMs)}–${formatDuration(sample.target.endMs)}`
  const [sourceWidth, sourceHeight] = sample.resolution.split('×').map(Number)
  applyVideoGeometry(sourceWidth, sourceHeight)
  elements.saveStatus.textContent = judgment.reviewedAt
    ? `已保存 ${new Date(judgment.reviewedAt).toLocaleTimeString()}`
    : ready
      ? '尚未判断'
      : '结果未就绪'
  elements.archiveNote.textContent = state.note
  renderRun(
    elements.v1Card,
    mitigationMode
      ? 'V7 影子存档 · 上轮人工判为退化'
      : `V1 基线 · 原人工结论：${sample.baselineVerdict === 'inconsistent' ? '不像' : '部分像'}`,
    sample.v1,
  )
  renderRun(elements.v7Card, `${rightVersionLabel} 候选`, sample.v7)
  elements.reviewPanel.classList.toggle('disabled', !ready)
  for (const control of elements.reviewPanel.querySelectorAll('button,input,textarea'))
    control.disabled = !ready
  setActiveButtons(elements.verdictButtons, 'verdict', judgment.verdict)
  setActiveButtons(elements.preferenceButtons, 'value', judgment.preferredOutput)
  elements.watchedFullSegment.checked = judgment.watchedFullSegment
  elements.notes.value = judgment.notes
  if (loadVideo) {
    segmentPlaybackActive = false
    elements.playerEmpty.hidden = ready
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
  localStorage.setItem(storageKey, sampleId)
  renderAll(true)
}

function moveSelection(delta) {
  const index = state.samples.findIndex((sample) => sample.sampleId === selectedSampleId)
  const next = state.samples[Math.max(0, Math.min(state.samples.length - 1, index + delta))]
  if (next) selectSample(next.sampleId)
}

function nextUnreviewed() {
  const next = state.samples.find((sample) => judgmentFor(sample.sampleId).verdict === 'unreviewed')
  if (next) selectSample(next.sampleId)
}

async function persistJudgment(changes, advance = false) {
  const sampleId = selectedSampleId
  if (!sampleId) return
  const sequence = ++saveSequence
  elements.saveStatus.textContent = '正在保存…'
  const judgment = { ...judgmentFor(sampleId), ...changes }
  const complete = judgment.verdict !== 'unreviewed' && judgment.preferredOutput !== 'unselected'
  const response = await api(`${reviewEndpoint}/${sampleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markReviewed: complete, judgment }),
  })
  state.judgments[sampleId] = response.judgment
  if (sequence === saveSequence)
    elements.saveStatus.textContent = complete ? '已保存' : '已暂存，还需选择另一项'
  renderAll(false)
  if (advance && complete) nextUnreviewed()
}

function playTargetSegment() {
  const sample = currentSample()
  if (!sample) return
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

async function load() {
  state = await api(stateEndpoint)
  if (mitigationMode) {
    document.body.classList.add('mitigation-review-page')
    document.title = 'Qwen V7 / V8.1 定向缓解验收'
    elements.pageEyebrow.textContent = 'VAL-211 · 六条定向缓解人工门禁'
    elements.pageTitle.textContent = 'V7 / V8.1 定向缓解对照'
    elements.pageLede.textContent =
      '只复核上轮退化的六条：确认V8.1修正遗漏或误推，同时没有替换掉V7中仍然正确的内容。'
    elements.reviewTitle.textContent = 'V8.1 相对 V7 有改善吗？'
    const preferenceButtons = Object.fromEntries(
      [...elements.preferenceButtons.querySelectorAll('button')].map((button) => [
        button.dataset.value,
        button,
      ]),
    )
    preferenceButtons.v7.textContent = 'V8.1 更好'
    preferenceButtons.v1.textContent = 'V7 更好'
    elements.notes.placeholder = '例如：V8.1补回了第二个地点，但仍误认了人物动作'
  } else if (shadowMode) {
    document.body.classList.add('shadow-review-page')
    document.title = 'Qwen 44条 V1 / V7 差异复核'
    elements.pageEyebrow.textContent = 'VID-016 · 44条影子结果人工门禁'
    elements.pageTitle.textContent = '44条 V1 / V7 差异复核'
    elements.pageLede.textContent =
      '优先确认原来判断为“像”的样本没有退化；同一视频和片段下比较两版真实存档。'
    state.samples.sort(
      (left, right) =>
        Number(right.baselineVerdict === 'consistent') -
          Number(left.baselineVerdict === 'consistent') ||
        (right.difference?.changeScore || 0) - (left.difference?.changeScore || 0),
    )
  }
  elements.backToBenchmark.href = `/benchmark?token=${encodeURIComponent(token)}`
  if (!state.samples.some((sample) => sample.sampleId === selectedSampleId))
    selectedSampleId = state.samples[0]?.sampleId || ''
  renderAll(true)
}

elements.previousSample.addEventListener('click', () => moveSelection(-1))
elements.nextSample.addEventListener('click', () => moveSelection(1))
elements.playSegment.addEventListener('click', playTargetSegment)
for (const button of elements.verdictButtons.querySelectorAll('button'))
  button.addEventListener(
    'click',
    () => void persistJudgment({ verdict: button.dataset.verdict }, true),
  )
for (const button of elements.preferenceButtons.querySelectorAll('button'))
  button.addEventListener(
    'click',
    () => void persistJudgment({ preferredOutput: button.dataset.value }, true),
  )
elements.watchedFullSegment.addEventListener(
  'change',
  () => void persistJudgment({ watchedFullSegment: elements.watchedFullSegment.checked }),
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
elements.video.addEventListener('loadedmetadata', () => {
  applyVideoGeometry(elements.video.videoWidth, elements.video.videoHeight)
})
elements.exportReview.addEventListener('click', () =>
  (() => {
    const report = buildRegressionReviewExport(state.samples, state.judgments)
    if (mitigationMode) {
      report.purpose = 'Qwen3-VL 2B 六条 V7/V8.1 定向缓解人工对照'
      report.preferenceMapping = { v1: 'V7左侧存档', v7: 'V8.1右侧候选' }
    } else if (shadowMode) report.purpose = 'Qwen3-VL 2B 44条 V1/V7 影子结果人工差异复核'
    downloadJson(
      report,
      mitigationMode
        ? 'video-profile-v8-mitigation-review-summary.json'
        : shadowMode
        ? 'video-profile-shadow-review-summary.json'
        : 'video-profile-regression-review-summary.json',
    )
  })(),
)
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
    return
  if (event.key === 'ArrowLeft') moveSelection(-1)
  if (event.key === 'ArrowRight') moveSelection(1)
  const verdict = { 1: 'improved', 2: 'same', 3: 'regressed' }[event.key]
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
    elements.fatal.textContent = `无法读取回归对照数据：${error.message}`
  })
