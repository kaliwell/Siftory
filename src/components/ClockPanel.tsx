import React, { useEffect, useState } from 'react'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import { DEFAULT_CLOCK_W, DEFAULT_CLOCK_H, FONT_SCALE_STEPS } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useTranslation } from '../i18n/useTranslation'

const ClockPanel: React.FC = () => {
  const { language } = useTranslation()
  const showDate = useStore((s) => s.showDate)
  const fontScaleIdx = useStore((s) => s.fontScaleIdx)
  const clockPos = useStore((s) => s.clockPos)
  const setClockPos = useStore((s) => s.setClockPos)
  const setClockSize = useStore((s) => s.setClockSize)
  const clockSize = useStore((s) => s.clockSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['clock'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['clock'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('clock', clockPos, setClockPos, linkedMove)

  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 200) // ~5 fps for smooth seconds
    return () => clearInterval(timer)
  }, [])

  const scale = FONT_SCALE_STEPS[fontScaleIdx]

  return (
    <DraggablePanel
      panelId="clock"
      title="Clock"
      x={clockPos.x}
      y={clockPos.y}
      defaultX={50}
      defaultY={50}
      w={clockSize.w}
      h={clockSize.h}
      defaultW={DEFAULT_CLOCK_W}
      defaultH={DEFAULT_CLOCK_H}
      onMove={handleMove}
      onResize={(w, h) => setClockSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('clock')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('clock')}
    >
      <div style={{ textAlign: 'center', paddingTop: 4 }}>
        <div
          style={{
            fontSize: Math.round(38 * scale),
            fontWeight: 300,
            letterSpacing: 2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {now.toLocaleTimeString(language, { hour12: false })}
        </div>
        {showDate && (
          <div
            style={{
              fontSize: Math.round(13 * scale),
              opacity: 0.6,
              marginTop: 4,
            }}
          >
            {now.toLocaleDateString(language, {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              weekday: 'long',
            })}
          </div>
        )}
      </div>
    </DraggablePanel>
  )
}

export default ClockPanel
