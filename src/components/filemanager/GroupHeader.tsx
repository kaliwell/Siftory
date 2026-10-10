import React from 'react'
import { useFMStore } from '../../stores/useFMStore'

interface GroupHeaderProps {
  groupKey: string
  label: string
  count: number
  defaultExpanded?: boolean
}

const GroupHeader: React.FC<GroupHeaderProps> = ({
  groupKey,
  label,
  count,
  defaultExpanded = true,
}) => {
  const expanded = useFMStore((s) => s.fmGroupExpanded[groupKey] ?? defaultExpanded)
  const setExpanded = useFMStore((s) => s.setFMGroupExpanded)

  const toggle = () => setExpanded(groupKey, !expanded)

  return (
    <div
      onClick={toggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        cursor: 'pointer',
        userSelect: 'none',
        background: 'rgba(var(--date), 0.15)',
        borderBottom: '1px solid rgba(var(--date), 0.2)',
        borderTop: '1px solid rgba(var(--date), 0.08)',
        position: 'sticky',
        top: 0,
        zIndex: 1,
      }}
    >
      <span style={{ fontSize: 10, width: 14, textAlign: 'center', opacity: 0.6 }}>
        {expanded ? '▼' : '▶'}
      </span>
      <span style={{ fontSize: 11, fontWeight: 500, flex: 1 }}>{label}</span>
      <span style={{ fontSize: 10, opacity: 0.5 }}>({count})</span>
    </div>
  )
}

export default GroupHeader
