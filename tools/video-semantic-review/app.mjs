import {
  buildReviewExport,
  createEmptyJudgment,
  isJudgmentComplete,
  normalizeJudgment,
  summarizeReview,
} from '/model.mjs'

const token = new URLSearchParams(window.location.search).get('token') || ''
const elements = Object.fromEntries(
  [
    'fatal',
    'completedCount',
    'overallProgress',
    'sampleList',
    'nextIncomplete',
    'samplePosition',
    'sampleTitle',
    'availabilityBadge',
    'sampleMeta',
    'playerShell',
    'video',
    'videoEmpty',
    'playSegment',
    'seekStart',
    'playbackRate',
    'targetRange',
    'durationWarning',
    'quickCandidate',
    'quickCandidateSummary',
    'quickCandidateTags',
    'reviewForm',
    'watchedFullSegment',
    'scene',
    'personCount',
    'events',
    'ocr',
    'consistencyButtons',
    'hallucination',
    'notes',
    'saveStatus',
    'saveReview',
    'completeAndNext',
    'inferenceBadge',
    'inferenceMeta',
    'candidateView',
    'summaryGrid',
    'gateMessage',
    'exportSummary',
    'exportFull',
    'importBackup',
  ].map((id) => [id, document.getElementById(id)]),
)

let state = null
let selectedSampleId = localStorage.getItem('video-semantic-review:selected') || ''
let selectedConsistency = 'unreviewed'
let saveTimer = null
let segmentPlaybackStarted = false

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'X-Review-Token': token, ...(options.headers || {}) },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
    return body
  })
}

function currentSample() {
  return state?.samples.find((sample) => sample.sampleId === selectedSampleId) || state?.samples[0]
}

function currentJudgment() {
  const sample = currentSample()
  return sample ? normalizeJudgment(state.judgments[sample.sampleId]) : createEmptyJudgment()
}

function setBadge(element, text, kind) {
  element.textContent = text
  element.className = `badge ${kind || ''}`.trim()
}

function metaItem(label, value) {
  const node = document.createElement('div')
  node.className = 'meta-item'
  const caption = document.createElement('span')
  caption.textContent = label
  const strong = document.createElement('strong')
  strong.textContent = value
  node.append(caption, strong)
  return node
}

function renderSamples() {
  const sample = currentSample()
  elements.sampleList.replaceChildren()
  state.samples.forEach((item, index) => {
    const judgment = state.judgments[item.sampleId]
    const complete = isJudgmentComplete(judgment)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `sample-button${item.sampleId === sample?.sampleId ? ' active' : ''}`
    button.dataset.sampleId = item.sampleId
    const dot = document.createElement('span')
    dot.className = `status-dot ${complete ? 'done' : item.inference.ok ? '' : 'failed'}`
    const label = document.createElement('span')
    label.textContent = item.sampleId
    const detail = document.createElement('small')
    detail.textContent = `${index + 1}/20 · ${item.profile === 'general' ? '通用' : '短视频'}`
    button.append(dot, label, detail)
    button.addEventListener('click', () => selectSample(item.sampleId))
    elements.sampleList.append(button)
  })
}

function renderForm() {
  const judgment = currentJudgment()
  elements.watchedFullSegment.checked = judgment.watchedFullSegment
  elements.scene.value = judgment.scene
  elements.personCount.value = judgment.personCount ?? ''
  elements.events.value = judgment.events
  elements.ocr.value = judgment.ocr
  elements.hallucination.value = judgment.hallucination
  elements.notes.value = judgment.notes
  selectedConsistency = judgment.consistency
  for (const button of elements.consistencyButtons.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === selectedConsistency)
  }
  elements.saveStatus.textContent = judgment.reviewedAt
    ? `上次确认：${new Date(judgment.reviewedAt).toLocaleString()}`
    : '自动保存在本机私有数据目录'
}

function candidateField(label, value) {
  const wrapper = document.createElement('div')
  wrapper.className = 'candidate-field'
  const title = document.createElement('strong')
  title.textContent = label
  const body = document.createElement('pre')
  body.textContent =
    Array.isArray(value) || (value && typeof value === 'object')
      ? JSON.stringify(value, null, 2)
      : String(value || '—')
  wrapper.append(title, body)
  return wrapper
}

function renderCandidate(sample) {
  const inference = sample.inference
  const candidate = inference.candidate
  elements.quickCandidate.classList.toggle('failed', !inference.ok || !candidate)
  elements.quickCandidateSummary.textContent =
    inference.ok && candidate?.summary
      ? candidate.summary
      : '未生成语义结果。该条可直接判断为“不像”，失败原因可在右侧查看。'
  elements.quickCandidateTags.replaceChildren()
  const tags = inference.ok && Array.isArray(candidate?.searchTags) ? candidate.searchTags : []
  for (const value of tags) {
    const tag = document.createElement('span')
    tag.textContent = value
    elements.quickCandidateTags.append(tag)
  }
  setBadge(
    elements.inferenceBadge,
    inference.ok ? '严格JSON通过' : '严格JSON失败',
    inference.ok ? 'ok' : 'error',
  )
  elements.inferenceMeta.replaceChildren()
  const lines = [
    inference.model?.modelId ? `模型：${inference.model.modelId}` : null,
    inference.model?.modelRevision ? `Revision：${inference.model.modelRevision}` : null,
    Number.isFinite(inference.latencyMs)
      ? `延迟：${(inference.latencyMs / 1000).toFixed(2)} 秒`
      : null,
    Number.isFinite(inference.peakGpuUsedMiB) ? `GPU峰值：${inference.peakGpuUsedMiB} MiB` : null,
  ].filter(Boolean)
  for (const line of lines) {
    const node = document.createElement('span')
    node.textContent = line
    elements.inferenceMeta.append(node)
  }
  elements.candidateView.replaceChildren()
  if (!inference.ok || !inference.candidate) {
    elements.candidateView.append(candidateField('失败原因', inference.error || '无候选结果'))
    return
  }
  ;[
    ['摘要', candidate.summary],
    ['场景', candidate.scenes],
    ['人物', candidate.persons],
    ['事件', candidate.events],
    ['物体', candidate.objects],
    ['OCR', candidate.visualText],
    ['搜索标签', candidate.searchTags],
    ['警告', candidate.warnings],
  ].forEach(([label, value]) => elements.candidateView.append(candidateField(label, value)))
}

function renderSummary() {
  const summary = summarizeReview(state.samples, state.judgments)
  elements.completedCount.textContent = summary.completed
  elements.overallProgress.value = summary.completed
  elements.summaryGrid.replaceChildren()
  ;[
    ['人工完成', `${summary.completed}/${summary.samples}`],
    ['严格JSON', `${summary.inferencePassed}/${summary.samples} · ${summary.strictJsonPercent}%`],
    ['像', String(summary.consistent)],
    ['旧版部分一致', String(summary.partial)],
    ['不像', String(summary.inconsistent)],
    ['严重幻觉', String(summary.hallucinationMajor)],
  ].forEach(([label, value]) => {
    const node = document.createElement('div')
    node.className = 'summary-item'
    const caption = document.createElement('span')
    caption.textContent = label
    const strong = document.createElement('strong')
    strong.textContent = value
    node.append(caption, strong)
    elements.summaryGrid.append(node)
  })
  elements.gateMessage.textContent =
    summary.completed < summary.samples
      ? `仍有 ${summary.samples - summary.completed} 段未完成“像 / 不像”初筛。`
      : summary.inferencePassed < summary.samples
        ? '人工真值已完成，但严格JSON未达到20/20，VID-012仍不能通过。'
        : '人工真值与严格JSON均达到20/20，可以生成正式汇总。'
}

function renderCurrent() {
  const sample = currentSample()
  if (!sample) return
  const index = state.samples.findIndex((item) => item.sampleId === sample.sampleId)
  elements.samplePosition.textContent = `SAMPLE ${String(index + 1).padStart(2, '0')} / 20`
  elements.sampleTitle.textContent = sample.sampleId
  setBadge(
    elements.availabilityBadge,
    sample.available ? '原视频可播放' : '原视频不可用',
    sample.available ? 'ok' : 'error',
  )
  elements.sampleMeta.replaceChildren(
    metaItem('体积', sample.sizeLabel),
    metaItem('源时长', formatDuration(sample.durationMs)),
    metaItem('分辨率', sample.resolution),
    metaItem('编码 / Profile', `${sample.codec} · ${sample.profile}`),
  )
  const start = sample.target.startMs
  const end = sample.target.endMs
  elements.targetRange.textContent = `目标 ${formatDuration(start)} – ${formatDuration(end)} · ${((end - start) / 1000).toFixed(1)}秒`
  elements.video.hidden = !sample.available
  elements.videoEmpty.hidden = sample.available
  elements.playSegment.disabled = !sample.available
  elements.seekStart.disabled = !sample.available
  segmentPlaybackStarted = false
  elements.durationWarning.hidden = true
  elements.video.pause()
  elements.video.removeAttribute('src')
  elements.playerShell.classList.remove('portrait')
  elements.playerShell.style.removeProperty('--video-aspect')
  elements.playerShell.style.removeProperty('max-width')
  if (sample.available) {
    elements.video.src = `/api/video/${sample.sampleId}?token=${encodeURIComponent(token)}`
    elements.video.load()
  }
  renderForm()
  renderCandidate(sample)
}

function render() {
  renderSamples()
  renderCurrent()
  renderSummary()
}

function selectSample(sampleId) {
  if (!state.samples.some((sample) => sample.sampleId === sampleId)) return
  selectedSampleId = sampleId
  localStorage.setItem('video-semantic-review:selected', sampleId)
  render()
}

function formJudgment() {
  return normalizeJudgment({
    watchedFullSegment: elements.watchedFullSegment.checked,
    scene: elements.scene.value,
    personCount: elements.personCount.value === '' ? null : Number(elements.personCount.value),
    events: elements.events.value,
    ocr: elements.ocr.value,
    consistency: selectedConsistency,
    hallucination: elements.hallucination.value,
    notes: elements.notes.value,
    reviewedAt: currentJudgment().reviewedAt,
  })
}

async function saveCurrent(markReviewed = false) {
  const sample = currentSample()
  if (!sample) return false
  window.clearTimeout(saveTimer)
  const judgment = formJudgment()
  if (markReviewed && !isJudgmentComplete(judgment)) {
    elements.saveStatus.textContent = '请先选择“像”或“不像”'
    return false
  }
  elements.saveStatus.textContent = '保存中…'
  try {
    const response = await api(`/api/review/${sample.sampleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judgment, markReviewed }),
    })
    state.judgments[sample.sampleId] = response.judgment
    elements.saveStatus.textContent = markReviewed ? '已完成并保存' : '已自动保存'
    renderSamples()
    renderSummary()
    return true
  } catch (error) {
    elements.saveStatus.textContent = `保存失败：${error.message}`
    return false
  }
}

function scheduleSave() {
  elements.saveStatus.textContent = '有未保存修改…'
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void saveCurrent(false), 500)
}

function nextIncomplete() {
  const currentIndex = state.samples.findIndex((sample) => sample.sampleId === selectedSampleId)
  for (let offset = 1; offset <= state.samples.length; offset += 1) {
    const candidate = state.samples[(currentIndex + offset) % state.samples.length]
    if (!isJudgmentComplete(state.judgments[candidate.sampleId])) {
      selectSample(candidate.sampleId)
      return
    }
  }
}

function downloadJson(value, name) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

async function importBackup(file) {
  const parsed = JSON.parse(await file.text())
  const records = Array.isArray(parsed.records)
    ? parsed.records
    : Object.entries(parsed.judgments || {}).map(([sampleId, judgment]) => ({ sampleId, judgment }))
  let imported = 0
  for (const record of records) {
    if (!record?.judgment || !state.samples.some((sample) => sample.sampleId === record.sampleId))
      continue
    await api(`/api/review/${record.sampleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        judgment: record.judgment,
        markReviewed: Boolean(record.judgment.reviewedAt),
      }),
    })
    imported += 1
  }
  if (!imported) throw new Error('备份中没有可导入的匿名样本')
  await loadState()
}

async function loadState() {
  const response = await api('/api/state')
  state = response
  if (!state.samples.some((sample) => sample.sampleId === selectedSampleId)) {
    selectedSampleId = state.samples[0]?.sampleId || ''
  }
  render()
}

elements.consistencyButtons.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-value]')
  if (!button) return
  selectedConsistency = button.dataset.value
  for (const item of elements.consistencyButtons.querySelectorAll('button')) {
    item.classList.toggle('active', item === button)
  }
  if (await saveCurrent(true)) nextIncomplete()
})

for (const input of elements.reviewForm.querySelectorAll('input, textarea, select')) {
  input.addEventListener('input', scheduleSave)
  input.addEventListener('change', scheduleSave)
}

elements.playSegment.addEventListener('click', () => {
  const sample = currentSample()
  if (!sample?.available) return
  elements.video.currentTime = sample.target.startMs / 1000
  segmentPlaybackStarted = true
  void elements.video.play()
})

elements.seekStart.addEventListener('click', () => {
  const sample = currentSample()
  if (sample) elements.video.currentTime = sample.target.startMs / 1000
})

elements.playbackRate.addEventListener('change', () => {
  elements.video.playbackRate = Number(elements.playbackRate.value)
})

elements.video.addEventListener('loadedmetadata', () => {
  const sample = currentSample()
  if (!sample || !Number.isFinite(elements.video.duration)) return
  const width = elements.video.videoWidth
  const height = elements.video.videoHeight
  if (width > 0 && height > 0) {
    const aspect = width / height
    elements.playerShell.style.setProperty('--video-aspect', String(aspect))
    elements.playerShell.classList.toggle('portrait', height > width)
    elements.playerShell.style.maxWidth = height > width ? `${Math.max(32, 72 * aspect)}vh` : ''
  }
  const deltaMs = Math.abs(elements.video.duration * 1000 - sample.durationMs)
  elements.durationWarning.hidden = deltaMs <= 1_500
  elements.durationWarning.textContent = `所载视频时长与匿名样本相差 ${(deltaMs / 1000).toFixed(1)} 秒，请确认样本映射。`
  if (!segmentPlaybackStarted) {
    elements.video.currentTime = (sample.target.startMs + sample.target.endMs) / 2_000
  }
})

elements.video.addEventListener('timeupdate', () => {
  const sample = currentSample()
  if (!sample || !segmentPlaybackStarted) return
  if (elements.video.currentTime * 1000 >= sample.target.endMs - 100) {
    elements.video.pause()
    segmentPlaybackStarted = false
    if (!elements.watchedFullSegment.checked) {
      elements.watchedFullSegment.checked = true
      scheduleSave()
    }
  }
})

elements.saveReview.addEventListener('click', () => void saveCurrent(false))
elements.completeAndNext.addEventListener('click', async () => {
  if (await saveCurrent(true)) nextIncomplete()
})
elements.nextIncomplete.addEventListener('click', nextIncomplete)
elements.exportSummary.addEventListener('click', () => {
  downloadJson(
    buildReviewExport(state.samples, state.judgments, 'summary'),
    'video-semantic-review-summary.json',
  )
})
elements.exportFull.addEventListener('click', () => {
  downloadJson(
    buildReviewExport(state.samples, state.judgments, 'full'),
    'video-semantic-review-backup.json',
  )
})
elements.importBackup.addEventListener('change', async () => {
  const file = elements.importBackup.files?.[0]
  if (!file) return
  elements.saveStatus.textContent = '正在导入…'
  try {
    await importBackup(file)
    elements.saveStatus.textContent = '备份导入完成'
  } catch (error) {
    elements.saveStatus.textContent = `导入失败：${error.message}`
  } finally {
    elements.importBackup.value = ''
  }
})

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    return
  if (['1', '2'].includes(event.key)) {
    elements.consistencyButtons.querySelector(`button:nth-child(${event.key})`)?.click()
  } else if (event.key === '[') {
    elements.seekStart.click()
  } else if (event.key === ']') {
    nextIncomplete()
  } else if (event.code === 'Space') {
    event.preventDefault()
    if (elements.video.paused) void elements.video.play()
    else elements.video.pause()
  }
})

if (!token) {
  elements.fatal.hidden = false
  elements.fatal.textContent = '缺少本地访问令牌。请使用 npm run review:video 输出的完整地址。'
} else {
  loadState().catch((error) => {
    elements.fatal.hidden = false
    elements.fatal.textContent = `无法载入验收数据：${error.message}`
  })
}
