import {
  buildAudioReviewExport,
  createEmptyAudioJudgment,
  isAudioJudgmentComplete,
  normalizeAudioJudgment,
  summarizeAudioReview,
} from '/audio-model.mjs'

const token = new URLSearchParams(window.location.search).get('token') || ''
const elements = Object.fromEntries(
  [
    'fatal',
    'completedCount',
    'totalCount',
    'overallProgress',
    'videoReviewLink',
    'segmentList',
    'nextIncomplete',
    'segmentPosition',
    'segmentTitle',
    'speakerBadge',
    'segmentMeta',
    'referenceButtons',
    'playerShell',
    'video',
    'videoEmpty',
    'playExact',
    'playContext',
    'seekStart',
    'playbackRate',
    'targetRange',
    'verdictButtons',
    'reviewForm',
    'listenedFullSegment',
    'correctedSpeaker',
    'notes',
    'saveStatus',
    'saveReview',
    'completeAndNext',
    'authorityBadge',
    'toggleTranscript',
    'transcriptText',
    'candidateMeta',
    'summaryGrid',
    'gateMessage',
    'exportSummary',
    'exportFull',
    'importBackup',
  ].map((id) => [id, document.getElementById(id)]),
)

let state = null
let selectedSegmentId = localStorage.getItem('audio-semantic-review:selected') || ''
let selectedVerdict = 'unreviewed'
let saveTimer = null
let playbackEndMs = null
let playbackMarksCurrent = false

function formatTime(ms) {
  const totalSeconds = Math.max(0, Number(ms) / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
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

function currentSegment() {
  return (
    state?.segments.find((segment) => segment.segmentId === selectedSegmentId) || state?.segments[0]
  )
}

function currentJudgment() {
  const segment = currentSegment()
  return segment
    ? normalizeAudioJudgment(state.judgments[segment.segmentId])
    : createEmptyAudioJudgment()
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

function candidateField(label, value) {
  const wrapper = document.createElement('div')
  wrapper.className = 'candidate-field'
  const title = document.createElement('strong')
  title.textContent = label
  const body = document.createElement('pre')
  body.textContent = String(value ?? '—')
  wrapper.append(title, body)
  return wrapper
}

function renderSegments() {
  elements.segmentList.replaceChildren()
  state.segments.forEach((segment, index) => {
    const judgment = normalizeAudioJudgment(state.judgments[segment.segmentId])
    const complete = isAudioJudgmentComplete(judgment)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `sample-button${segment.segmentId === currentSegment()?.segmentId ? ' active' : ''}`
    const dot = document.createElement('span')
    dot.className = `status-dot ${complete ? 'done' : segment.speakerId ? '' : 'failed'}`
    const label = document.createElement('span')
    label.textContent = segment.segmentId
    const detail = document.createElement('small')
    detail.textContent = `${segment.speakerId || '无标签'} · ${((segment.endMs - segment.startMs) / 1_000).toFixed(1)}s`
    button.append(dot, label, detail)
    button.addEventListener('click', () => selectSegment(segment.segmentId))
    elements.segmentList.append(button)
  })
}

function renderReferences() {
  elements.referenceButtons.replaceChildren()
  const entries = Object.entries(state.referenceSegments || {})
  if (!entries.length) {
    elements.referenceButtons.textContent = '暂无可用说话人参考片段'
    return
  }
  for (const [speakerId, segmentId] of entries) {
    const segment = state.segments.find((item) => item.segmentId === segmentId)
    if (!segment) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `▶ ${speakerId} 参考（${segmentId}）`
    button.addEventListener('click', () => playRange(segment.startMs, segment.endMs, false))
    elements.referenceButtons.append(button)
  }
}

function renderForm() {
  const judgment = currentJudgment()
  elements.listenedFullSegment.checked = judgment.listenedFullSegment
  elements.correctedSpeaker.value = judgment.correctedSpeaker
  elements.notes.value = judgment.notes
  selectedVerdict = judgment.verdict
  for (const button of elements.verdictButtons.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === selectedVerdict)
  }
  elements.saveStatus.textContent = judgment.reviewedAt
    ? `上次确认：${new Date(judgment.reviewedAt).toLocaleString()}`
    : '自动保存在本机私有数据目录'
}

function renderCandidate(segment) {
  elements.transcriptText.textContent = segment.transcriptText || '（没有生成转写文字）'
  elements.transcriptText.hidden = true
  elements.toggleTranscript.textContent = '显示转写'
  elements.candidateMeta.replaceChildren(
    candidateField('模型', state.metadata.modelId || '—'),
    candidateField('Revision', state.metadata.modelRevision || '—'),
    candidateField(
      '语言 / 情绪',
      `${segment.language || 'unknown'} / ${segment.emotion || 'unknown'}`,
    ),
    candidateField('音频事件', segment.audioEvents.length ? segment.audioEvents.join('、') : '—'),
    candidateField('任务代次', state.metadata.generationId || '—'),
  )
}

function renderSummary() {
  const summary = summarizeAudioReview(state.segments, state.judgments)
  elements.completedCount.textContent = summary.completed
  elements.totalCount.textContent = summary.segments
  elements.overallProgress.max = Math.max(1, summary.segments)
  elements.overallProgress.value = summary.completed
  elements.summaryGrid.replaceChildren()
  ;[
    ['已复核', `${summary.completed}/${summary.segments}`],
    ['标签正确', String(summary.correct)],
    ['说话人错', String(summary.wrongSpeaker)],
    ['边界有误', String(summary.wrongBoundary)],
    ['无法判断', String(summary.unusable)],
    [
      '可判定准确率',
      summary.speakerAccuracyPercent === null ? '—' : `${summary.speakerAccuracyPercent}%`,
    ],
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
    summary.completed < summary.segments
      ? `还需人工听取 ${summary.segments - summary.completed} 条，完成后才能关闭 VID-014。`
      : `${summary.segments} 条已全部人工复核；可导出脱敏汇总并更新 VID-014 验收结论。`
}

function renderCurrent() {
  const segment = currentSegment()
  if (!segment) return
  const index = state.segments.findIndex((item) => item.segmentId === segment.segmentId)
  elements.segmentPosition.textContent = `TURN ${String(index + 1).padStart(2, '0')} / ${state.segments.length}`
  elements.segmentTitle.textContent = segment.segmentId
  setBadge(
    elements.speakerBadge,
    segment.speakerId || '没有说话人标签',
    segment.speakerId ? 'ok' : 'error',
  )
  elements.segmentMeta.replaceChildren(
    metaItem('说话人标签', segment.speakerId || '无'),
    metaItem('开始', formatTime(segment.startMs)),
    metaItem('结束', formatTime(segment.endMs)),
    metaItem('语音时长', `${((segment.endMs - segment.startMs) / 1_000).toFixed(2)} 秒`),
  )
  elements.targetRange.textContent = `${formatTime(segment.startMs)} – ${formatTime(segment.endMs)}`
  playbackEndMs = null
  playbackMarksCurrent = false
  elements.video.pause()
  renderForm()
  renderCandidate(segment)
}

function render() {
  renderSegments()
  renderReferences()
  renderCurrent()
  renderSummary()
}

function selectSegment(segmentId) {
  if (!state.segments.some((segment) => segment.segmentId === segmentId)) return
  selectedSegmentId = segmentId
  localStorage.setItem('audio-semantic-review:selected', segmentId)
  render()
}

function formJudgment() {
  return normalizeAudioJudgment({
    listenedFullSegment: elements.listenedFullSegment.checked,
    verdict: selectedVerdict,
    correctedSpeaker: elements.correctedSpeaker.value,
    notes: elements.notes.value,
    reviewedAt: currentJudgment().reviewedAt,
  })
}

async function saveCurrent(markReviewed = false) {
  const segment = currentSegment()
  if (!segment) return false
  window.clearTimeout(saveTimer)
  const judgment = formJudgment()
  if (markReviewed && !isAudioJudgmentComplete(judgment)) {
    elements.saveStatus.textContent = '请先选择一个验收结论'
    return false
  }
  elements.saveStatus.textContent = '保存中…'
  try {
    const response = await api(`/api/audio/review/${segment.segmentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judgment, markReviewed }),
    })
    state.judgments[segment.segmentId] = response.judgment
    elements.saveStatus.textContent = markReviewed ? '已完成并保存' : '已自动保存'
    renderSegments()
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
  const currentIndex = state.segments.findIndex(
    (segment) => segment.segmentId === selectedSegmentId,
  )
  for (let offset = 1; offset <= state.segments.length; offset += 1) {
    const candidate = state.segments[(currentIndex + offset) % state.segments.length]
    if (!isAudioJudgmentComplete(state.judgments[candidate.segmentId])) {
      selectSegment(candidate.segmentId)
      return
    }
  }
}

function playRange(startMs, endMs, marksCurrent) {
  if (!state?.metadata.available) return
  elements.video.currentTime = startMs / 1_000
  playbackEndMs = endMs
  playbackMarksCurrent = marksCurrent
  void elements.video.play()
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
    : Object.entries(parsed.judgments || {}).map(([segmentId, judgment]) => ({
        segmentId,
        judgment,
      }))
  let imported = 0
  for (const record of records) {
    if (
      !record?.judgment ||
      !state.segments.some((segment) => segment.segmentId === record.segmentId)
    )
      continue
    await api(`/api/audio/review/${record.segmentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        judgment: record.judgment,
        markReviewed: Boolean(record.judgment.reviewedAt),
      }),
    })
    imported += 1
  }
  if (!imported) throw new Error('备份中没有可导入的匿名语音片段')
  await loadState()
}

async function loadState() {
  state = await api('/api/audio/state')
  if (!state.metadata.available || !state.segments.length) {
    throw new Error(state.issue || '没有可验收的权威音频语义数据')
  }
  if (!state.segments.some((segment) => segment.segmentId === selectedSegmentId)) {
    selectedSegmentId = state.segments[0].segmentId
  }
  elements.videoReviewLink.href = `/?token=${encodeURIComponent(token)}`
  elements.video.hidden = false
  elements.videoEmpty.hidden = true
  elements.video.src = `/api/audio/video/${state.metadata.sampleId}?token=${encodeURIComponent(token)}`
  elements.video.load()
  setBadge(
    elements.authorityBadge,
    `${state.metadata.completedChunks}/${state.metadata.totalChunks} 块完成`,
    'ok',
  )
  render()
}

elements.verdictButtons.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-value]')
  if (!button) return
  selectedVerdict = button.dataset.value
  for (const item of elements.verdictButtons.querySelectorAll('button')) {
    item.classList.toggle('active', item === button)
  }
  if (await saveCurrent(true)) nextIncomplete()
})

for (const input of elements.reviewForm.querySelectorAll('input, textarea, select')) {
  input.addEventListener('input', scheduleSave)
  input.addEventListener('change', scheduleSave)
}

elements.playExact.addEventListener('click', () => {
  const segment = currentSegment()
  if (segment) playRange(segment.startMs, segment.endMs, true)
})
elements.playContext.addEventListener('click', () => {
  const segment = currentSegment()
  if (segment) playRange(segment.contextStartMs, segment.contextEndMs, true)
})
elements.seekStart.addEventListener('click', () => {
  const segment = currentSegment()
  if (segment) elements.video.currentTime = segment.startMs / 1_000
})
elements.playbackRate.addEventListener('change', () => {
  elements.video.playbackRate = Number(elements.playbackRate.value)
})
elements.video.addEventListener('loadedmetadata', () => {
  const width = elements.video.videoWidth
  const height = elements.video.videoHeight
  if (width > 0 && height > 0) {
    const aspect = width / height
    elements.playerShell.style.setProperty('--video-aspect', String(aspect))
    elements.playerShell.classList.toggle('portrait', height > width)
  }
})
elements.video.addEventListener('timeupdate', () => {
  if (playbackEndMs === null || elements.video.currentTime * 1_000 < playbackEndMs - 50) return
  elements.video.pause()
  playbackEndMs = null
  if (playbackMarksCurrent && !elements.listenedFullSegment.checked) {
    elements.listenedFullSegment.checked = true
    scheduleSave()
  }
  playbackMarksCurrent = false
})

elements.toggleTranscript.addEventListener('click', () => {
  elements.transcriptText.hidden = !elements.transcriptText.hidden
  elements.toggleTranscript.textContent = elements.transcriptText.hidden ? '显示转写' : '隐藏转写'
})
elements.saveReview.addEventListener('click', () => void saveCurrent(false))
elements.completeAndNext.addEventListener('click', async () => {
  if (await saveCurrent(true)) nextIncomplete()
})
elements.nextIncomplete.addEventListener('click', nextIncomplete)
elements.exportSummary.addEventListener('click', () => {
  downloadJson(
    buildAudioReviewExport(state.segments, state.judgments, state.metadata, 'summary'),
    'audio-speaker-review-summary.json',
  )
})
elements.exportFull.addEventListener('click', () => {
  downloadJson(
    buildAudioReviewExport(state.segments, state.judgments, state.metadata, 'full'),
    'audio-speaker-review-backup.json',
  )
})
elements.importBackup.addEventListener('change', async () => {
  const file = elements.importBackup.files?.[0]
  if (!file) return
  try {
    elements.saveStatus.textContent = '正在导入…'
    await importBackup(file)
    elements.saveStatus.textContent = '备份导入完成'
  } catch (error) {
    elements.saveStatus.textContent = `导入失败：${error.message}`
  } finally {
    elements.importBackup.value = ''
  }
})

document.addEventListener('keydown', (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  )
    return
  if (['1', '2', '3', '4'].includes(event.key)) {
    elements.verdictButtons.querySelector(`button:nth-child(${event.key})`)?.click()
  } else if (event.key === ']') {
    nextIncomplete()
  } else if (event.code === 'Space') {
    event.preventDefault()
    if (elements.video.paused) elements.playExact.click()
    else elements.video.pause()
  }
})

if (!token) {
  elements.fatal.hidden = false
  elements.fatal.textContent = '缺少本地访问令牌。请使用 npm run review:audio 输出的完整地址。'
} else {
  loadState().catch((error) => {
    elements.fatal.hidden = false
    elements.fatal.textContent = `无法载入音频验收数据：${error.message}`
  })
}
