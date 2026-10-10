import type {
  MediaPlayerExportApi,
  MediaPlayerExportFormat,
} from '../shared/ipc/media-player-export'
import type { MediaPlayerEvidenceSource, MediaPlayerHitKind } from '../shared/ipc/media-search'
import type { UnifiedTimelineFrameRate } from '../shared/ipc/unified-search'
import {
  computeMediaContainRect,
  normalizeMediaPlayerHitContext,
  stepMediaPlayerHitIndex,
} from '../shared/mediaPlayerNavigation'

const MIN_SELECTION_MS = 40
const DEFAULT_SELECTION_MS = 3_000

function requiredElement<T extends Element>(selector: string, constructor: { new (): T }): T {
  const element = document.querySelector(selector)
  if (!(element instanceof constructor)) throw new Error('Invalid controlled media player layout')
  return element
}

const player = requiredElement('video', HTMLVideoElement)
const stage = requiredElement('#player-stage', HTMLElement)
const exportPanel = requiredElement('#clip-export-panel', HTMLElement)
const toggleExportButton = requiredElement('#toggle-export', HTMLButtonElement)
const selectionSummary = requiredElement('#selection-summary', HTMLElement)
const startInput = requiredElement('#clip-start', HTMLInputElement)
const endInput = requiredElement('#clip-end', HTMLInputElement)
const startRange = requiredElement('#clip-start-range', HTMLInputElement)
const endRange = requiredElement('#clip-end-range', HTMLInputElement)
const setStartButton = requiredElement('#set-clip-start', HTMLButtonElement)
const setEndButton = requiredElement('#set-clip-end', HTMLButtonElement)
const useHitRangeButton = requiredElement('#use-hit-range', HTMLButtonElement)
const startFrameBackButton = requiredElement('#start-frame-back', HTMLButtonElement)
const startFrameForwardButton = requiredElement('#start-frame-forward', HTMLButtonElement)
const endFrameBackButton = requiredElement('#end-frame-back', HTMLButtonElement)
const endFrameForwardButton = requiredElement('#end-frame-forward', HTMLButtonElement)
const startFrameValue = requiredElement('#start-frame-value', HTMLOutputElement)
const endFrameValue = requiredElement('#end-frame-value', HTMLOutputElement)
const selectionTrack = requiredElement('#selection-track', HTMLElement)
const selectionRangeFill = requiredElement('#selection-range-fill', HTMLElement)
const selectionStartMarker = requiredElement('#selection-start-marker', HTMLElement)
const selectionEndMarker = requiredElement('#selection-end-marker', HTMLElement)
const selectionPlayhead = requiredElement('#selection-playhead', HTMLElement)
const selectionCurrentTime = requiredElement('#selection-current-time', HTMLElement)
const selectionTotalTime = requiredElement('#selection-total-time', HTMLElement)
const frameRateSelect = requiredElement('#timeline-frame-rate', HTMLSelectElement)
const loopSelectionInput = requiredElement('#loop-selection', HTMLInputElement)
const exportVideoButton = requiredElement('#export-video', HTMLButtonElement)
const exportEdlButton = requiredElement('#export-edl', HTMLButtonElement)
const exportFcpxmlButton = requiredElement('#export-fcpxml', HTMLButtonElement)
const exportStatus = requiredElement('#export-status', HTMLOutputElement)
const hitPanel = requiredElement('#hit-panel', HTMLElement)
const previousButton = requiredElement('#previous-hit', HTMLButtonElement)
const nextButton = requiredElement('#next-hit', HTMLButtonElement)
const hitPosition = requiredElement('#hit-position', HTMLElement)
const hitQuery = requiredElement('#hit-query', HTMLElement)
const hitText = requiredElement('#hit-text', HTMLElement)
const hitEvidence = requiredElement('#hit-evidence', HTMLElement)
const hitRangeMarker = requiredElement('#hit-range-marker', HTMLElement)

const playerExportApi = (window as Window & { siftoryMediaPlayer?: MediaPlayerExportApi })
  .siftoryMediaPlayer
const query = new URLSearchParams(window.location.search)
const source = query.get('source') || ''
const timestampText = query.get('timestampMs') || ''
const timestampMs = Number(timestampText)

if (!source.startsWith('file:') || !Number.isSafeInteger(timestampMs) || timestampMs < 0) {
  throw new Error('Invalid controlled media player request')
}

const isChinese = navigator.language.toLowerCase().startsWith('zh')
const labels = isChinese
  ? {
      visual: '画面命中',
      subtitle: '对白命中',
      semantic: '视频语义命中',
      fused: '融合证据命中',
      query: '查询',
      evidence: '依据',
      exportTitle: '片段导出',
      start: '开始',
      end: '结束',
      inPoint: '入点',
      outPoint: '出点',
      frameRate: '帧率',
      setCurrent: '设为当前',
      useHitRange: '使用命中范围',
      inPointFine: '入点精调',
      outPointFine: '出点精调',
      previousFrame: '−1 帧',
      nextFrame: '+1 帧',
      precisionHint: '数值框 ↑/↓：1 毫秒 · Shift+↑/↓：1 帧',
      exactStartInput: '精确入点，单位为秒，支持三位小数',
      exactEndInput: '精确出点，单位为秒，支持三位小数',
      loopSelection: '循环选区',
      selectionTimeline: '视频选区进度',
      exportVideo: '导出 MP4',
      exportEdl: '导出 EDL',
      exportFcpxml: '导出 FCPXML',
      collapse: '收起',
      expand: '展开',
      previous: '← 上一处',
      next: '下一处 →',
      shortcuts: 'I 设入点 · O 设出点 · Alt+← / Alt+→',
      exporting: '正在导出，请稍候…',
      exported: '已导出',
      cancelled: '已取消导出',
      unavailable: '播放器导出接口不可用，请重启应用',
      duration: '时长',
    }
  : {
      visual: 'Visual hit',
      subtitle: 'Dialogue hit',
      semantic: 'Video semantic hit',
      fused: 'Fused evidence hit',
      query: 'Query',
      evidence: 'Evidence',
      exportTitle: 'Clip export',
      start: 'Start',
      end: 'End',
      inPoint: 'In',
      outPoint: 'Out',
      frameRate: 'Frame rate',
      setCurrent: 'Use current',
      useHitRange: 'Use hit range',
      inPointFine: 'Fine-tune In',
      outPointFine: 'Fine-tune Out',
      previousFrame: '−1 frame',
      nextFrame: '+1 frame',
      precisionHint: 'Value ↑/↓: 1 ms · Shift+↑/↓: 1 frame',
      exactStartInput: 'Exact In point in seconds, to three decimal places',
      exactEndInput: 'Exact Out point in seconds, to three decimal places',
      loopSelection: 'Loop selection',
      selectionTimeline: 'Video selection timeline',
      exportVideo: 'Export MP4',
      exportEdl: 'Export EDL',
      exportFcpxml: 'Export FCPXML',
      collapse: 'Collapse',
      expand: 'Expand',
      previous: '← Previous',
      next: 'Next →',
      shortcuts: 'I sets In · O sets Out · Alt+← / Alt+→',
      exporting: 'Exporting…',
      exported: 'Exported',
      cancelled: 'Export cancelled',
      unavailable: 'Player export is unavailable; restart the app',
      duration: 'Duration',
    }

const evidenceLabels: Record<MediaPlayerEvidenceSource, string> = isChinese
  ? {
      'cached-frame': '缓存画面帧',
      'embedded-subtitle': '内嵌字幕',
      'ai-visual-semantic': 'AI 画面语义',
      ocr: '画面文字',
      'transcript-reference': '语音转写',
      'audio-event': '音频事件',
    }
  : {
      'cached-frame': 'Cached frame',
      'embedded-subtitle': 'Embedded subtitle',
      'ai-visual-semantic': 'AI visual semantics',
      ocr: 'OCR',
      'transcript-reference': 'Transcript',
      'audio-event': 'Audio event',
    }

function setText(selector: string, text: string): void {
  requiredElement(selector, HTMLElement).textContent = text
}

document.documentElement.lang = isChinese ? 'zh-CN' : 'en'
setText('#export-title', labels.exportTitle)
setText('#start-label', labels.start)
setText('#end-label', labels.end)
setText('#in-label', labels.inPoint)
setText('#out-label', labels.outPoint)
setText('#frame-rate-label', labels.frameRate)
setStartButton.textContent = labels.setCurrent
setEndButton.textContent = labels.setCurrent
useHitRangeButton.textContent = labels.useHitRange
setText('#start-precision-label', labels.inPointFine)
setText('#end-precision-label', labels.outPointFine)
setText('#precision-hint', labels.precisionHint)
startFrameBackButton.textContent = labels.previousFrame
endFrameBackButton.textContent = labels.previousFrame
startFrameForwardButton.textContent = labels.nextFrame
endFrameForwardButton.textContent = labels.nextFrame
startFrameBackButton.title = `${labels.inPointFine}: ${labels.previousFrame}`
startFrameForwardButton.title = `${labels.inPointFine}: ${labels.nextFrame}`
endFrameBackButton.title = `${labels.outPointFine}: ${labels.previousFrame}`
endFrameForwardButton.title = `${labels.outPointFine}: ${labels.nextFrame}`
startInput.title = labels.exactStartInput
startInput.setAttribute('aria-label', labels.exactStartInput)
endInput.title = labels.exactEndInput
endInput.setAttribute('aria-label', labels.exactEndInput)
setText('#loop-selection-label', labels.loopSelection)
selectionTrack.setAttribute('aria-label', labels.selectionTimeline)
exportVideoButton.textContent = labels.exportVideo
exportEdlButton.textContent = labels.exportEdl
exportFcpxmlButton.textContent = labels.exportFcpxml
toggleExportButton.textContent = labels.collapse
previousButton.textContent = labels.previous
nextButton.textContent = labels.next
setText('#hit-hotkeys', labels.shortcuts)

let parsedContext: unknown
const contextText = query.get('hitContext')
if (contextText) {
  try {
    parsedContext = JSON.parse(contextText)
  } catch {
    throw new Error('Invalid controlled media hit context')
  }
}
const hitContext = normalizeMediaPlayerHitContext(parsedContext, undefined, timestampMs)
if (contextText && !hitContext) throw new Error('Invalid controlled media hit context')
let selectedHitIndex = hitContext?.selectedIndex ?? 0
let selectionStartMs = timestampMs
let selectionEndMs = timestampMs + DEFAULT_SELECTION_MS
let exportBusy = false
let selectionInitialized = false
let playbackMonitorFrame = 0

function formatTime(valueMs: number, milliseconds = false): string {
  const totalMs = Math.max(0, Math.floor(valueMs))
  const totalSeconds = Math.floor(totalMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const base =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`
  return milliseconds ? `${base}.${String(totalMs % 1_000).padStart(3, '0')}` : base
}

function selectedFrameRate(): UnifiedTimelineFrameRate {
  const value = Number(frameRateSelect.value)
  return Number.isFinite(value) && value > 0 ? (value as UnifiedTimelineFrameRate) : 25
}

function frameIndexAt(valueMs: number, frameRate = selectedFrameRate()): number {
  return Math.max(0, Math.round((valueMs * frameRate) / 1_000))
}

function frameTimeMs(frameIndex: number, frameRate = selectedFrameRate()): number {
  return Math.max(0, Math.round((Math.max(0, frameIndex) * 1_000) / frameRate))
}

function formatFrameIndex(valueMs: number): string {
  return `F ${String(frameIndexAt(valueMs)).padStart(6, '0')}`
}

function mediaDurationMs(): number {
  return Number.isFinite(player.duration) && player.duration > 0
    ? Math.max(1, Math.floor(player.duration * 1_000))
    : 0
}

function setStatus(text: string, state: 'idle' | 'working' | 'success' | 'error' = 'idle'): void {
  exportStatus.textContent = text
  exportStatus.dataset.state = state
  exportStatus.title = text
}

function timelinePercent(valueMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  return Math.max(0, Math.min(100, (valueMs / durationMs) * 100))
}

function renderPlaybackProgress(): void {
  const durationMs = mediaDurationMs() || Math.max(selectionEndMs, DEFAULT_SELECTION_MS)
  const currentMs = Math.max(0, Math.min(durationMs, Math.round(player.currentTime * 1_000) || 0))
  selectionPlayhead.style.left = `${timelinePercent(currentMs, durationMs)}%`
  selectionCurrentTime.textContent = formatTime(currentMs, true)
  selectionTotalTime.textContent = formatTime(durationMs, true)
  selectionTrack.setAttribute('aria-valuemax', String(Math.max(0, Math.round(durationMs / 1_000))))
  selectionTrack.setAttribute('aria-valuenow', String(Math.max(0, currentMs / 1_000)))
  selectionTrack.setAttribute(
    'aria-valuetext',
    `${formatTime(currentMs, true)} / ${formatTime(durationMs, true)}`,
  )
}

function enforceSelectionLoop(): boolean {
  if (!loopSelectionInput.checked || !selectionInitialized) return false
  const currentMs = Math.round(player.currentTime * 1_000)
  if (currentMs >= selectionStartMs && currentMs < selectionEndMs) return false
  const shouldResume = !player.paused || player.ended
  player.currentTime = selectionStartMs / 1_000
  if (shouldResume) void player.play().catch(() => undefined)
  return true
}

function monitorPlayback(): void {
  playbackMonitorFrame = 0
  enforceSelectionLoop()
  renderPlaybackProgress()
  if (!player.paused && !player.ended) {
    playbackMonitorFrame = window.requestAnimationFrame(monitorPlayback)
  }
}

function schedulePlaybackMonitor(): void {
  if (!playbackMonitorFrame) playbackMonitorFrame = window.requestAnimationFrame(monitorPlayback)
}

function cancelPlaybackMonitor(): void {
  if (!playbackMonitorFrame) return
  window.cancelAnimationFrame(playbackMonitorFrame)
  playbackMonitorFrame = 0
}

function seekFromSelectionTimeline(clientX: number): void {
  const durationMs = mediaDurationMs()
  const bounds = selectionTrack.getBoundingClientRect()
  if (!durationMs || bounds.width <= 0) return
  const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
  seekToSeconds((ratio * durationMs) / 1_000)
  selectionTrack.focus({ preventScroll: true })
}

function renderSelection(): void {
  const durationMs = mediaDurationMs()
  const sliderMaximumMs = Math.max(durationMs, selectionEndMs, DEFAULT_SELECTION_MS)
  const sliderMaximum = (sliderMaximumMs / 1_000).toFixed(3)
  startInput.max = sliderMaximum
  endInput.max = sliderMaximum
  startRange.max = sliderMaximum
  endRange.max = sliderMaximum
  startInput.value = (selectionStartMs / 1_000).toFixed(3)
  endInput.value = (selectionEndMs / 1_000).toFixed(3)
  startRange.value = (selectionStartMs / 1_000).toFixed(3)
  endRange.value = (selectionEndMs / 1_000).toFixed(3)
  startFrameValue.textContent = formatFrameIndex(selectionStartMs)
  endFrameValue.textContent = formatFrameIndex(selectionEndMs)
  selectionSummary.textContent = `${formatTime(selectionStartMs, true)} – ${formatTime(selectionEndMs, true)} · ${labels.duration} ${formatTime(selectionEndMs - selectionStartMs, true)}`
  const visualDurationMs = durationMs || sliderMaximumMs
  const selectionLeft = timelinePercent(selectionStartMs, visualDurationMs)
  const selectionRight = timelinePercent(selectionEndMs, visualDurationMs)
  selectionRangeFill.style.left = `${selectionLeft}%`
  selectionRangeFill.style.width = `${Math.max(0, selectionRight - selectionLeft)}%`
  selectionStartMarker.style.left = `${selectionLeft}%`
  selectionEndMarker.style.left = `${selectionRight}%`
  renderPlaybackProgress()

  const invalid = selectionEndMs - selectionStartMs < MIN_SELECTION_MS
  for (const button of [exportVideoButton, exportEdlButton, exportFcpxmlButton]) {
    button.disabled = exportBusy || invalid || !playerExportApi
  }
  for (const control of [
    startInput,
    endInput,
    startRange,
    endRange,
    setStartButton,
    setEndButton,
    useHitRangeButton,
    startFrameBackButton,
    startFrameForwardButton,
    endFrameBackButton,
    endFrameForwardButton,
    frameRateSelect,
  ]) {
    control.disabled = exportBusy
  }
}

function updateSelection(
  rawStartMs: number,
  rawEndMs: number,
  anchor: 'start' | 'end' | 'both' = 'both',
  clearStatus = true,
): void {
  const durationMs = mediaDurationMs()
  const maximum = durationMs || Math.max(DEFAULT_SELECTION_MS, rawStartMs, rawEndMs)
  let startMs = Math.max(0, Math.min(maximum, Math.round(rawStartMs)))
  let endMs = Math.max(0, Math.min(maximum, Math.round(rawEndMs)))
  if (endMs - startMs < MIN_SELECTION_MS) {
    if (anchor === 'start') {
      startMs = Math.min(startMs, Math.max(0, maximum - MIN_SELECTION_MS))
      endMs = Math.min(maximum, startMs + MIN_SELECTION_MS)
    } else {
      endMs = Math.max(Math.min(maximum, endMs), Math.min(maximum, MIN_SELECTION_MS))
      startMs = Math.max(0, endMs - MIN_SELECTION_MS)
    }
  }
  selectionStartMs = startMs
  selectionEndMs = endMs
  if (clearStatus && !exportBusy) setStatus('')
  enforceSelectionLoop()
  renderSelection()
}

function previewSelectionBoundary(boundary: 'start' | 'end', frameRate: number): void {
  const frameMs = Math.max(1, Math.round(1_000 / frameRate))
  const targetMs =
    boundary === 'start' ? selectionStartMs : Math.max(selectionStartMs, selectionEndMs - frameMs)
  player.pause()
  player.currentTime = targetMs / 1_000
  renderPlaybackProgress()
}

function adjustSelectionByFrame(boundary: 'start' | 'end', deltaFrames: -1 | 1): void {
  const frameRate = selectedFrameRate()
  const currentMs = boundary === 'start' ? selectionStartMs : selectionEndMs
  const targetMs = frameTimeMs(frameIndexAt(currentMs, frameRate) + deltaFrames, frameRate)
  if (boundary === 'start') updateSelection(targetMs, selectionEndMs, 'start')
  else updateSelection(selectionStartMs, targetMs, 'end')
  previewSelectionBoundary(boundary, frameRate)
}

function bindPrecisionInputKeys(input: HTMLInputElement, boundary: 'start' | 'end'): void {
  input.addEventListener('keydown', (event) => {
    if (!event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    adjustSelectionByFrame(boundary, event.key === 'ArrowUp' ? 1 : -1)
  })
}

function selectedHitRange(): { startMs: number; endMs: number } | undefined {
  if (!hitContext) return undefined
  const hit = hitContext.hits[selectedHitIndex]
  const durationMs = mediaDurationMs()
  const endMs = Math.min(durationMs || Number.MAX_SAFE_INTEGER, hit.endMs ?? hit.startMs + 3_000)
  return { startMs: hit.startMs, endMs: Math.max(hit.startMs + MIN_SELECTION_MS, endMs) }
}

function applySelectedHitRange(seek: boolean): void {
  const range = selectedHitRange()
  if (!range) return
  updateSelection(range.startMs, range.endMs, 'both')
  if (seek) seekToSeconds(range.startMs / 1_000)
}

function hitKindLabel(kind: MediaPlayerHitKind): string {
  return labels[kind]
}

function updateRangeMarker(startMs: number, endMs?: number): void {
  const durationMs = mediaDurationMs()
  if (!durationMs) {
    hitRangeMarker.style.left = '0%'
    hitRangeMarker.style.width = '0%'
    return
  }
  const left = Math.max(0, Math.min(100, (startMs / durationMs) * 100))
  const right = Math.max(left, Math.min(100, ((endMs ?? startMs) / durationMs) * 100))
  hitRangeMarker.style.left = `${left}%`
  hitRangeMarker.style.width = `${Math.max(0.35, right - left)}%`
}

function renderHit(): void {
  if (!hitContext) {
    hitPanel.hidden = true
    useHitRangeButton.hidden = true
    return
  }
  const hit = hitContext.hits[selectedHitIndex]
  hitPanel.hidden = false
  useHitRangeButton.hidden = false
  const range =
    hit.endMs !== undefined && hit.endMs > hit.startMs
      ? `${formatTime(hit.startMs)} – ${formatTime(hit.endMs)}`
      : formatTime(hit.startMs)
  hitPosition.textContent = `${selectedHitIndex + 1}/${hitContext.hits.length} · ${hitKindLabel(hit.kind)} · ${range}`
  hitQuery.hidden = !hitContext.query
  hitQuery.textContent = hitContext.query ? `${labels.query}: ${hitContext.query}` : ''
  hitText.hidden = !hit.text
  hitText.textContent = hit.text ?? ''
  const sources = hit.evidenceSources.map((sourceName) => evidenceLabels[sourceName])
  hitEvidence.hidden = sources.length === 0
  hitEvidence.textContent = sources.length ? `${labels.evidence}: ${sources.join(' + ')}` : ''
  previousButton.disabled = selectedHitIndex === 0
  nextButton.disabled = selectedHitIndex === hitContext.hits.length - 1
  updateRangeMarker(hit.startMs, hit.endMs)
}

function seekToSeconds(targetSeconds: number): void {
  player.currentTime = Number.isFinite(player.duration)
    ? Math.min(Math.max(0, targetSeconds), player.duration)
    : Math.max(0, targetSeconds)
  void player.play().catch(() => undefined)
  renderPlaybackProgress()
  schedulePlaybackMonitor()
}

function initializeSelection(): void {
  if (selectionInitialized) return
  selectionInitialized = true
  const durationMs = mediaDurationMs()
  const hitRange = selectedHitRange()
  if (hitRange) {
    updateSelection(hitRange.startMs, hitRange.endMs, 'both', false)
  } else {
    const endMs = Math.min(
      durationMs || timestampMs + DEFAULT_SELECTION_MS,
      timestampMs + DEFAULT_SELECTION_MS,
    )
    const startMs = Math.min(timestampMs, Math.max(0, endMs - MIN_SELECTION_MS))
    updateSelection(startMs, endMs, 'both', false)
  }
  if (!playerExportApi) setStatus(labels.unavailable, 'error')
}

function seekInitial(): void {
  seekToSeconds(timestampMs / 1_000)
  renderHit()
  initializeSelection()
}

function navigateHit(direction: -1 | 1): void {
  if (!hitContext) return
  const nextIndex = stepMediaPlayerHitIndex(hitContext, selectedHitIndex, direction)
  if (nextIndex === selectedHitIndex) return
  selectedHitIndex = nextIndex
  renderHit()
  applySelectedHitRange(true)
}

function setStartFromCurrent(): void {
  const currentMs = Math.max(0, Math.round(player.currentTime * 1_000))
  const durationMs = mediaDurationMs()
  let endMs = selectionEndMs
  if (endMs - currentMs < MIN_SELECTION_MS) {
    endMs = Math.min(
      durationMs || currentMs + DEFAULT_SELECTION_MS,
      currentMs + DEFAULT_SELECTION_MS,
    )
  }
  updateSelection(currentMs, endMs, 'start')
}

function setEndFromCurrent(): void {
  const currentMs = Math.max(0, Math.round(player.currentTime * 1_000))
  let startMs = selectionStartMs
  if (currentMs - startMs < MIN_SELECTION_MS)
    startMs = Math.max(0, currentMs - DEFAULT_SELECTION_MS)
  updateSelection(startMs, currentMs, 'end')
}

async function exportSelection(format: MediaPlayerExportFormat): Promise<void> {
  if (!playerExportApi) {
    setStatus(labels.unavailable, 'error')
    return
  }
  exportBusy = true
  setStatus(labels.exporting, 'working')
  renderSelection()
  try {
    const result = await playerExportApi.exportSelection({
      format,
      startMs: selectionStartMs,
      endMs: selectionEndMs,
      ...(format === 'edl' || format === 'fcpxml'
        ? { frameRate: Number(frameRateSelect.value) as UnifiedTimelineFrameRate }
        : {}),
    })
    if (result.cancelled || result.error === 'cancelled') {
      setStatus(labels.cancelled)
    } else if (!result.ok) {
      setStatus(result.error || 'Export failed', 'error')
    } else {
      setStatus(`${labels.exported}: ${result.filePath ?? ''}`, 'success')
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    exportBusy = false
    renderSelection()
  }
}

function updateMediaLayout(): void {
  if (!player.videoWidth || !player.videoHeight) return
  const rect = computeMediaContainRect(
    stage.clientWidth,
    stage.clientHeight,
    player.videoWidth,
    player.videoHeight,
  )
  player.style.width = `${rect.width}px`
  player.style.height = `${rect.height}px`
  stage.dataset.mediaOrientation =
    player.videoWidth === player.videoHeight
      ? 'square'
      : player.videoWidth > player.videoHeight
        ? 'landscape'
        : 'portrait'
}

previousButton.addEventListener('click', () => navigateHit(-1))
nextButton.addEventListener('click', () => navigateHit(1))
setStartButton.addEventListener('click', setStartFromCurrent)
setEndButton.addEventListener('click', setEndFromCurrent)
useHitRangeButton.addEventListener('click', () => applySelectedHitRange(true))
startFrameBackButton.addEventListener('click', () => adjustSelectionByFrame('start', -1))
startFrameForwardButton.addEventListener('click', () => adjustSelectionByFrame('start', 1))
endFrameBackButton.addEventListener('click', () => adjustSelectionByFrame('end', -1))
endFrameForwardButton.addEventListener('click', () => adjustSelectionByFrame('end', 1))
bindPrecisionInputKeys(startInput, 'start')
bindPrecisionInputKeys(endInput, 'end')
startInput.addEventListener('change', () => {
  const value = Number(startInput.value)
  if (Number.isFinite(value)) updateSelection(value * 1_000, selectionEndMs, 'start')
  else renderSelection()
})
endInput.addEventListener('change', () => {
  const value = Number(endInput.value)
  if (Number.isFinite(value)) updateSelection(selectionStartMs, value * 1_000, 'end')
  else renderSelection()
})
startRange.addEventListener('input', () =>
  updateSelection(Number(startRange.value) * 1_000, selectionEndMs, 'start'),
)
endRange.addEventListener('input', () =>
  updateSelection(selectionStartMs, Number(endRange.value) * 1_000, 'end'),
)
frameRateSelect.addEventListener('change', renderSelection)
selectionTrack.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  seekFromSelectionTimeline(event.clientX)
})
selectionTrack.addEventListener('keydown', (event) => {
  const durationMs = mediaDurationMs()
  if (!durationMs) return
  const currentMs = Math.max(0, Math.min(durationMs, Math.round(player.currentTime * 1_000)))
  const stepMs = event.shiftKey ? 5_000 : 1_000
  let targetMs: number | undefined
  if (event.key === 'ArrowLeft') targetMs = currentMs - stepMs
  else if (event.key === 'ArrowRight') targetMs = currentMs + stepMs
  else if (event.key === 'Home') targetMs = selectionStartMs
  else if (event.key === 'End') targetMs = selectionEndMs
  if (targetMs === undefined) return
  event.preventDefault()
  seekToSeconds(Math.max(0, Math.min(durationMs, targetMs)) / 1_000)
})
loopSelectionInput.addEventListener('change', () => {
  selectionTrack.dataset.looping = loopSelectionInput.checked ? 'true' : 'false'
  if (loopSelectionInput.checked) enforceSelectionLoop()
  renderPlaybackProgress()
  schedulePlaybackMonitor()
})
exportVideoButton.addEventListener('click', () => void exportSelection('video'))
exportEdlButton.addEventListener('click', () => void exportSelection('edl'))
exportFcpxmlButton.addEventListener('click', () => void exportSelection('fcpxml'))
toggleExportButton.addEventListener('click', () => {
  const collapsed = exportPanel.classList.toggle('is-collapsed')
  toggleExportButton.textContent = collapsed ? labels.expand : labels.collapse
})
window.addEventListener('keydown', (event) => {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
  const previous = (event.altKey && event.key === 'ArrowLeft') || event.key === '['
  const next = (event.altKey && event.key === 'ArrowRight') || event.key === ']'
  const setIn = !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'i'
  const setOut =
    !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'o'
  if (!previous && !next && !setIn && !setOut) return
  event.preventDefault()
  if (previous || next) navigateHit(previous ? -1 : 1)
  else if (setIn) setStartFromCurrent()
  else setEndFromCurrent()
})
window.addEventListener('resize', updateMediaLayout)
window.addEventListener('beforeunload', cancelPlaybackMonitor)

player.addEventListener('play', schedulePlaybackMonitor)
player.addEventListener('playing', schedulePlaybackMonitor)
player.addEventListener('timeupdate', () => {
  enforceSelectionLoop()
  renderPlaybackProgress()
})
player.addEventListener('seeking', renderPlaybackProgress)
player.addEventListener('pause', () => {
  cancelPlaybackMonitor()
  renderPlaybackProgress()
})
player.addEventListener('ended', () => {
  if (loopSelectionInput.checked && selectionInitialized) {
    player.currentTime = selectionStartMs / 1_000
    void player.play().catch(() => undefined)
  }
  renderPlaybackProgress()
})
player.addEventListener('durationchange', () => {
  if (selectionInitialized) updateSelection(selectionStartMs, selectionEndMs, 'both', false)
  else renderPlaybackProgress()
  renderHit()
})

player.src = source
if (player.readyState >= 1) {
  seekInitial()
  updateMediaLayout()
} else {
  player.addEventListener(
    'loadedmetadata',
    () => {
      seekInitial()
      updateMediaLayout()
    },
    { once: true },
  )
}
