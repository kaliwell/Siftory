import React from 'react'
import type {
  RemoteServerMetricsSnapshot,
  RemoteTerminalProfile,
  RemoteTerminalSessionStatus,
} from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

interface SessionOverviewProps {
  activeMetrics: RemoteServerMetricsSnapshot | undefined
  activeProfile: RemoteTerminalProfile | null
  activeStatus: RemoteTerminalSessionStatus | undefined
  refreshing: boolean
  onRefresh: () => void
}

function metricShortValue(
  metric: RemoteServerMetricsSnapshot | undefined,
  key: 'cpu' | 'memory' | 'disk',
): string {
  if (!metric?.ok) return '-'
  if (key === 'cpu') {
    return metric.cpu?.usagePercent !== undefined ? `${metric.cpu.usagePercent.toFixed(1)}%` : '-'
  }
  if (key === 'memory') {
    return metric.memory?.totalBytes && metric.memory.usedBytes !== undefined
      ? `${Math.round((metric.memory.usedBytes / metric.memory.totalBytes) * 100)}%`
      : '-'
  }
  const rootDisk = metric.disks?.find((disk) => disk.mount === '/') || metric.disks?.[0]
  return rootDisk ? `${rootDisk.usedPercent}%` : '-'
}

const StatusPill: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      border: '1px solid rgba(var(--date), 0.18)',
      padding: '2px 6px',
      minWidth: 58,
      background: 'rgba(0,0,0,0.16)',
    }}
  >
    <span style={{ opacity: 0.6 }}>{label}</span> {value}
  </div>
)

const SessionOverview: React.FC<SessionOverviewProps> = ({
  activeMetrics,
  activeProfile,
  activeStatus,
  refreshing,
  onRefresh,
}) => {
  const { t } = useTranslation()
  return (
    <div
      className="rt-session-overview"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1fr) repeat(3, 78px) auto',
        gap: 8,
        alignItems: 'center',
        padding: '6px 8px',
        borderBottom: '1px solid rgba(var(--date), 0.16)',
        background: 'rgba(0,0,0,0.28)',
        color: 'rgb(var(--date))',
        fontSize: 10,
        flexShrink: 0,
      }}
    >
      <div className="rt-session-identity">
        <div
          style={{
            color: 'rgb(var(--date))',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {activeProfile?.name || t('Session')}
        </div>
        <div
          style={{
            color: 'rgba(var(--date), 0.95)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {activeProfile
            ? `${activeProfile.username}@${activeProfile.host}:${activeProfile.port || 22}`
            : activeStatus?.sessionId}
        </div>
      </div>
      <StatusPill label={t('CPU')} value={metricShortValue(activeMetrics, 'cpu')} />
      <StatusPill label={t('MEM')} value={metricShortValue(activeMetrics, 'memory')} />
      <StatusPill label={t('DISK')} value={metricShortValue(activeMetrics, 'disk')} />
      <button
        onClick={onRefresh}
        disabled={!activeProfile || refreshing}
        style={{ fontSize: 10, padding: '2px 8px' }}
      >
        {refreshing ? t('Refreshing...') : t('Refresh')}
      </button>
    </div>
  )
}

export default SessionOverview
