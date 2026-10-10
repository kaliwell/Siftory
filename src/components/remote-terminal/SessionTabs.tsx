import React from 'react'
import type {
  RemoteTerminalProfile,
  RemoteTerminalSessionStatus,
} from '../../../shared/ipc-contract'

interface SessionTabsProps {
  activeSessionId: string | null
  profiles: RemoteTerminalProfile[]
  sessions: Map<string, RemoteTerminalSessionStatus>
  onCloseSession: (sessionId: string) => void
  onSelectSession: (sessionId: string) => void
}

const SessionTabs: React.FC<SessionTabsProps> = ({
  activeSessionId,
  profiles,
  sessions,
  onCloseSession,
  onSelectSession,
}) => {
  if (sessions.size === 0) return null

  return (
    <div
      className="rt-session-tabs"
      style={{
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid rgba(var(--date), 0.12)',
        padding: '2px 4px 0',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {Array.from(sessions.entries()).map(([sessionId, status]) => {
        const profile = profiles.find((item) => item.id === status.profileId)
        const label = profile?.name || sessionId.slice(0, 12)
        const active = activeSessionId === sessionId
        return (
          <div
            className={`rt-session-tab ${active ? 'is-active' : ''}`}
            key={sessionId}
            onClick={() => onSelectSession(sessionId)}
            style={{
              cursor: 'pointer',
              padding: '2px 8px',
              fontSize: 10,
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
              background: active ? 'rgba(var(--date), 0.18)' : 'transparent',
              color: active ? 'rgb(var(--date))' : 'rgba(var(--date), 0.72)',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              className={`rt-state-dot is-${status.state}`}
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: 3,
                background:
                  status.state === 'connected'
                    ? 'rgb(100,255,150)'
                    : status.state === 'connecting'
                      ? 'rgb(255,200,100)'
                      : 'rgb(255,100,100)',
              }}
            />
            {label}
            <span
              className="rt-session-close"
              onClick={(event) => {
                event.stopPropagation()
                onCloseSession(sessionId)
              }}
              style={{ cursor: 'pointer', fontSize: 9, color: 'rgba(var(--date), 0.85)' }}
            >
              x
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default SessionTabs
