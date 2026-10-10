import React, { useEffect, useMemo, useState } from 'react'
import type { SamPoint, SubjectBBox } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import ThumbnailImage from './filemanager/ThumbnailImage'
import {
  appendSubjectCorrection,
  buildSubjectBoxPrompts,
  clampSubjectPoint,
  MAX_SAM_PROMPTS,
  subjectBoxFromPoints,
  subjectBoxPercentStyle,
  type SubjectImagePoint,
} from './subjectPromptTools'

export interface SubjectPickerData {
  imagePath: string
  width: number
  height: number
  subjects: SubjectBBox[]
}

interface SubjectPickerModalProps {
  data: SubjectPickerData
  enableSegmentation?: boolean
  onPick: (subject: SubjectBBox) => void
  onSegment: (
    bbox: { x: number; y: number; w: number; h: number },
    segmentationSessionId: string,
  ) => void
  onAuto: () => void
  onCancel: () => void
}

interface SegmentState {
  bbox: { x: number; y: number; w: number; h: number }
  iou: number
  maskPngDataUrl: string
  segmentationSessionId: string
}

type PromptTool = 'detect' | 'box' | 'add' | 'subtract'

/**
 * Subject picker backed by the original image's MobileSAM embedding. The
 * displayed image may be scaled to fit the window, but every prompt is mapped
 * back into oriented source-image pixels before inference.
 */
const SubjectPickerModal: React.FC<SubjectPickerModalProps> = ({
  data,
  enableSegmentation = true,
  onPick,
  onSegment,
  onAuto,
  onCancel,
}) => {
  const { t } = useTranslation()
  const ext = data.imagePath.split('.').pop() || ''
  const [tool, setTool] = useState<PromptTool>(data.subjects.length > 0 ? 'detect' : 'box')
  const [samReady, setSamReady] = useState<boolean | null>(null)
  const [segmenting, setSegmenting] = useState(false)
  const [segment, setSegment] = useState<SegmentState | null>(null)
  const [segmentError, setSegmentError] = useState('')
  const [prompts, setPrompts] = useState<SamPoint[]>([])
  const [history, setHistory] = useState<SamPoint[][]>([[]])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [boxStart, setBoxStart] = useState<SubjectImagePoint | null>(null)
  const [boxCurrent, setBoxCurrent] = useState<SubjectImagePoint | null>(null)
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!enableSegmentation) {
      setSamReady(false)
      return
    }
    let cancelled = false
    void window.electronAPI.sam
      .status()
      .then((status) => {
        if (cancelled) return
        setSamReady(status.ready)
        if (!status.ready) setTool((current) => (current === 'detect' ? current : 'box'))
      })
      .catch(() => {
        if (!cancelled) {
          setSamReady(false)
          setTool((current) => (current === 'detect' ? current : 'box'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [enableSegmentation])

  const stageSize = useMemo(() => {
    const maxW = Math.min(720, Math.round(window.innerWidth * 0.85))
    const maxH = Math.min(640, Math.round(window.innerHeight * 0.65))
    if (data.width <= 0 || data.height <= 0) return { width: maxW, height: Math.round(maxH / 2) }
    const scale = Math.min(maxW / data.width, maxH / data.height)
    return {
      width: Math.max(120, Math.round(data.width * scale)),
      height: Math.max(90, Math.round(data.height * scale)),
    }
  }, [data.width, data.height])

  useEffect(() => {
    let cancelled = false
    setOriginalPreviewUrl(null)
    const pixelRatio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const maxWidth = Math.min(2048, Math.max(128, Math.ceil(stageSize.width * pixelRatio)))
    const maxHeight = Math.min(2048, Math.max(128, Math.ceil(stageSize.height * pixelRatio)))
    void window.electronAPI.sam
      .preview(data.imagePath, maxWidth, maxHeight)
      .then((result) => {
        if (!cancelled && result.ok && result.dataUrl) setOriginalPreviewUrl(result.dataUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [data.imagePath, stageSize.height, stageSize.width])

  const pointFromEvent = (
    event: React.PointerEvent<HTMLDivElement>,
    stage = event.currentTarget.getBoundingClientRect(),
  ): SubjectImagePoint | null => {
    if (stage.width <= 0 || stage.height <= 0 || data.width <= 0 || data.height <= 0) return null
    return clampSubjectPoint(
      {
        x: ((event.clientX - stage.left) / stage.width) * data.width,
        y: ((event.clientY - stage.top) / stage.height) * data.height,
      },
      data.width,
      data.height,
    )
  }

  const requestSegment = async (nextPrompts: SamPoint[]) => {
    if (segmenting || samReady !== true || !window.electronAPI?.sam || nextPrompts.length === 0)
      return
    setSegmenting(true)
    setSegmentError('')
    try {
      const result = await window.electronAPI.sam.segment(data.imagePath, nextPrompts)
      if (result.ok && result.bbox && result.maskPngDataUrl && result.segmentationSessionId) {
        setSegment({
          bbox: result.bbox,
          iou: result.iou ?? 0,
          maskPngDataUrl: result.maskPngDataUrl,
          segmentationSessionId: result.segmentationSessionId,
        })
      } else {
        if (/No compatible segment-(?:encoder|decoder) model/i.test(result.error || '')) {
          setSamReady(false)
          setTool('box')
          setSegmentError('')
        } else {
          setSegmentError(result.error || 'Segmentation failed')
        }
      }
    } catch (err) {
      setSegmentError(err instanceof Error ? err.message : 'Segmentation failed')
    } finally {
      setSegmenting(false)
    }
  }

  const commitPrompts = (nextPrompts: SamPoint[]) => {
    const bounded = nextPrompts.slice(0, MAX_SAM_PROMPTS)
    const nextHistory = [...history.slice(0, historyIndex + 1), bounded]
    setPrompts(bounded)
    setHistory(nextHistory)
    setHistoryIndex(nextHistory.length - 1)
    if (bounded.length === 0) {
      setSegment(null)
      setSegmentError('')
    } else {
      void requestSegment(bounded)
    }
  }

  const restoreHistory = (nextIndex: number) => {
    if (segmenting || nextIndex < 0 || nextIndex >= history.length) return
    const restored = history[nextIndex]
    setHistoryIndex(nextIndex)
    setPrompts(restored)
    if (restored.length === 0) {
      setSegment(null)
      setSegmentError('')
    } else {
      void requestSegment(restored)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (segmenting || tool === 'detect') return
    const point = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'box') {
      setBoxStart(point)
      setBoxCurrent(point)
      return
    }
    commitPrompts(appendSubjectCorrection(prompts, point, tool === 'subtract' ? 0 : 1))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== 'box' || !boxStart || !event.currentTarget.hasPointerCapture(event.pointerId))
      return
    const point = pointFromEvent(event)
    if (point) setBoxCurrent(point)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== 'box' || !boxStart) return
    const end = pointFromEvent(event) ?? boxCurrent
    setBoxStart(null)
    setBoxCurrent(null)
    if (!end) return
    const box = subjectBoxFromPoints(boxStart, end)
    if (!box) return
    if (samReady !== true) {
      onPick({ ...box, confidence: 1, label: 'manual' })
      return
    }
    const nextPrompts = buildSubjectBoxPrompts(prompts, boxStart, end)
    if (nextPrompts) commitPrompts(nextPrompts)
  }

  const activeBox = useMemo(() => {
    const topLeft = prompts.find((prompt) => prompt.label === 2)
    const bottomRight = prompts.find((prompt) => prompt.label === 3)
    if (!topLeft || !bottomRight) return null
    return subjectBoxPercentStyle(topLeft, bottomRight, data.width, data.height)
  }, [data.height, data.width, prompts])

  const liveBox =
    boxStart && boxCurrent
      ? subjectBoxPercentStyle(boxStart, boxCurrent, data.width, data.height)
      : null

  const toolButton = (value: PromptTool, label: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled || segmenting}
      onClick={() => setTool(value)}
      aria-pressed={tool === value}
      style={{
        background: tool === value ? 'rgba(var(--fg), 0.2)' : 'transparent',
        borderColor: tool === value ? 'rgba(var(--date), 0.8)' : undefined,
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="subject-picker-backdrop" onClick={onCancel}>
      <div className="subject-picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="subject-picker-title">{t('Refine subject on the original image')}</div>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            alignSelf: 'stretch',
            flexWrap: 'wrap',
          }}
        >
          {data.subjects.length > 0 && toolButton('detect', t('Detected boxes'))}
          {toolButton('box', t('Box select'))}
          {enableSegmentation && toolButton('add', t('Add foreground'), samReady !== true)}
          {enableSegmentation && toolButton('subtract', t('Remove background'), samReady !== true)}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            disabled={segmenting || historyIndex <= 0}
            onClick={() => restoreHistory(historyIndex - 1)}
          >
            {t('Undo')}
          </button>
          <button
            type="button"
            disabled={segmenting || historyIndex >= history.length - 1}
            onClick={() => restoreHistory(historyIndex + 1)}
          >
            {t('Redo')}
          </button>
          <button
            type="button"
            disabled={segmenting || prompts.length === 0}
            onClick={() => commitPrompts([])}
          >
            {t('Reset')}
          </button>
        </div>
        <div style={{ fontSize: 10, opacity: 0.65, alignSelf: 'stretch' }}>
          {tool === 'detect'
            ? t('Click a detected box, or choose a refinement tool.')
            : tool === 'box'
              ? t('Drag a box around the subject.')
              : tool === 'add'
                ? t('Click missing subject areas to add them.')
                : t('Click background areas to remove them.')}
        </div>
        <div
          className="subject-picker-stage"
          style={{
            width: stageSize.width,
            height: stageSize.height,
            maxWidth: '100%',
            cursor: tool === 'box' ? 'crosshair' : tool === 'subtract' ? 'cell' : 'copy',
            touchAction: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            setBoxStart(null)
            setBoxCurrent(null)
          }}
        >
          {originalPreviewUrl ? (
            <img
              src={originalPreviewUrl}
              alt=""
              draggable={false}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                objectFit: 'contain',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            />
          ) : (
            <ThumbnailImage
              filePath={data.imagePath}
              ext={ext}
              isDirectory={false}
              viewMode="grid"
              targetSize={512}
              style={{ width: '100%', height: '100%' }}
              imgStyle={{
                width: '100%',
                height: '100%',
                display: 'block',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            />
          )}
          {segment && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(60, 140, 255, 0.5)',
                WebkitMaskImage: `url("${segment.maskPngDataUrl}")`,
                WebkitMaskSize: '100% 100%',
                WebkitMaskRepeat: 'no-repeat',
                maskImage: `url("${segment.maskPngDataUrl}")`,
                maskSize: '100% 100%',
                maskRepeat: 'no-repeat',
                maskMode: 'luminance',
                pointerEvents: 'none',
              }}
            />
          )}
          {tool === 'detect' &&
            !segment &&
            data.width > 0 &&
            data.height > 0 &&
            data.subjects.map((subject, index) => (
              <button
                key={index}
                type="button"
                className="subject-picker-box"
                style={{
                  left: `${(subject.x / data.width) * 100}%`,
                  top: `${(subject.y / data.height) * 100}%`,
                  width: `${(subject.w / data.width) * 100}%`,
                  height: `${(subject.h / data.height) * 100}%`,
                }}
                title={`${subject.label} ${(subject.confidence * 100).toFixed(0)}%`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onPick(subject)
                }}
              >
                <span className="subject-picker-label">
                  {subject.label} {(subject.confidence * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          {(liveBox ?? activeBox) && (
            <div
              style={{
                position: 'absolute',
                ...(liveBox ?? activeBox)!,
                border: '2px solid rgba(255, 210, 80, 0.95)',
                background: 'rgba(255, 210, 80, 0.08)',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            />
          )}
          {prompts
            .filter((prompt) => prompt.label === 0 || prompt.label === 1)
            .map((prompt, index) => (
              <div
                key={`${prompt.x}-${prompt.y}-${index}`}
                style={{
                  position: 'absolute',
                  left: `${(prompt.x / data.width) * 100}%`,
                  top: `${(prompt.y / data.height) * 100}%`,
                  width: 12,
                  height: 12,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  border: '2px solid white',
                  background: prompt.label === 0 ? 'rgb(240, 80, 80)' : 'rgb(60, 210, 110)',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.8)',
                  pointerEvents: 'none',
                }}
              />
            ))}
          {segmenting && (
            <div className="subject-picker-status">
              {t('Segmenting… (the original image embedding is reused)')}
            </div>
          )}
        </div>
        {segmentError && <div className="subject-picker-error">{t(segmentError)}</div>}
        <div className="subject-picker-actions">
          {segment ? (
            <button
              type="button"
              onClick={() => onSegment(segment.bbox, segment.segmentationSessionId)}
            >
              {t('Search masked subject')} (IoU {segment.iou.toFixed(2)})
            </button>
          ) : (
            data.subjects.length > 0 && (
              <button type="button" onClick={onAuto}>
                {t('Auto (largest)')}
              </button>
            )
          )}
          <button type="button" onClick={onCancel}>
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SubjectPickerModal
