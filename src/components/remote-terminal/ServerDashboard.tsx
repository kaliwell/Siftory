import React from 'react'
import type {
  RemoteServerMetricsSnapshot,
  RemoteTerminalProfile,
} from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

type ServerDashboardProps = {
  profile: RemoteTerminalProfile | null
  metrics?: RemoteServerMetricsSnapshot
  message: string
  onConnect: (profile: RemoteTerminalProfile) => void
  onRefreshMetrics: (profile: RemoteTerminalProfile) => void
}

function fmtTime(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx++
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)}${units[idx]}`
}

function pct(used?: number, total?: number): string {
  if (!total || used === undefined) return '-'
  return `${Math.round((used / total) * 100)}%`
}

function fmtUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function pickRootDisk(metrics?: RemoteServerMetricsSnapshot) {
  return metrics?.disks?.find((d) => d.mount === '/') || metrics?.disks?.[0]
}

const cardStyle: React.CSSProperties = {
  border: '1px solid rgba(var(--date), 0.28)',
  background: 'rgba(0,0,0,0.18)',
  borderRadius: 6,
  padding: '8px 10px',
  minHeight: 58,
}

const ServerDashboard: React.FC<ServerDashboardProps> = ({
  profile,
  metrics,
  message,
  onConnect,
  onRefreshMetrics,
}) => {
  const { t } = useTranslation()
  if (!profile) {
    return (
      <>
        <div>{message}</div>
        <div style={{ color: 'rgba(var(--date), 0.95)', fontSize: 10 }}>
          {t('Select a profile to see server metrics.')}
        </div>
      </>
    )
  }

  const rootDisk = pickRootDisk(metrics)
  const networkRows = metrics?.network?.slice(0, 4) || []
  const diskRows = metrics?.disks?.slice(0, 4) || []
  const metricsOk = metrics?.ok !== false

  return (
    <div style={{ width: 'min(580px, 92%)', textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, color: 'rgb(var(--date))', marginBottom: 4 }}>
            {profile.name}
          </div>
          <div style={{ color: 'rgba(var(--date), 0.95)' }}>
            {profile.username}@{profile.host}:{profile.port || 22}
          </div>
        </div>
        <div style={{ color: 'rgba(var(--date), 0.92)', fontSize: 10, textAlign: 'right' }}>
          {t('Updated')}
          <br />
          {fmtTime(metrics?.collectedAt)}
        </div>
      </div>

      {!metricsOk && (
        <div
          style={{
            border: '1px solid rgba(255, 100, 80, 0.35)',
            background: 'rgba(255, 80, 60, 0.08)',
            color: '#ff8a75',
            borderRadius: 5,
            padding: '6px 8px',
            marginBottom: 10,
            fontSize: 10,
          }}
        >
          {t('Metrics failed')}: {metrics?.error || t('unknown')}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <MetricCard
          label="CPU"
          value={
            metrics?.cpu?.usagePercent !== undefined
              ? `${metrics.cpu.usagePercent.toFixed(1)}%`
              : '-'
          }
          sub={metrics?.cpu?.cores ? `${metrics.cpu.cores} ${t('cores')}` : undefined}
        />
        <MetricCard
          label={t('Memory')}
          value={pct(metrics?.memory?.usedBytes, metrics?.memory?.totalBytes)}
          sub={
            metrics?.memory
              ? `${fmtBytes(metrics.memory.usedBytes)} / ${fmtBytes(metrics.memory.totalBytes)}`
              : undefined
          }
        />
        <MetricCard
          label={t('Disk')}
          value={rootDisk?.usedPercent !== undefined ? `${rootDisk.usedPercent}%` : '-'}
          sub={rootDisk ? `${rootDisk.mount} ${fmtBytes(rootDisk.usedBytes)}` : undefined}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          marginTop: 12,
          fontSize: 10,
        }}
      >
        <InfoBox title={t('System')}>
          <InfoLine label="OS" value={metrics?.host?.os || '-'} />
          <InfoLine label={t('Kernel')} value={metrics?.host?.kernel || '-'} />
          <InfoLine label={t('Arch')} value={metrics?.host?.arch || '-'} />
          <InfoLine label={t('Uptime')} value={fmtUptime(metrics?.host?.uptimeSeconds)} />
          <InfoLine
            label={t('Load')}
            value={metrics?.host?.loadavg?.map((v) => v.toFixed(2)).join(' / ') || '-'}
          />
        </InfoBox>

        <InfoBox title={t('Network')}>
          {networkRows.length > 0 ? (
            networkRows.map((item) => (
              <InfoLine
                key={item.iface}
                label={item.iface}
                value={`RX ${fmtBytes(item.rxBytes)} / TX ${fmtBytes(item.txBytes)}`}
              />
            ))
          ) : (
            <InfoLine label={t('Interfaces')} value="-" />
          )}
        </InfoBox>
      </div>

      <InfoBox title={t('Disks')} style={{ marginTop: 10 }}>
        {diskRows.length > 0 ? (
          diskRows.map((disk) => (
            <InfoLine
              key={`${disk.filesystem}:${disk.mount}`}
              label={disk.mount}
              value={`${disk.usedPercent}%  ${fmtBytes(disk.usedBytes)} / ${fmtBytes(
                disk.totalBytes,
              )}`}
            />
          ))
        ) : (
          <InfoLine label={t('Mounts')} value="-" />
        )}
      </InfoBox>

      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        <button onClick={() => onConnect(profile)} style={{ fontSize: 11, padding: '3px 10px' }}>
          {t('Connect')}
        </button>
        <button
          onClick={() => onRefreshMetrics(profile)}
          style={{ fontSize: 11, padding: '3px 10px' }}
        >
          {t('Refresh Metrics')}
        </button>
      </div>
      <div style={{ marginTop: 12, color: 'rgba(var(--date), 0.95)', fontSize: 10 }}>{message}</div>
    </div>
  )
}

const MetricCard: React.FC<{ label: string; value: string; sub?: string }> = ({
  label,
  value,
  sub,
}) => (
  <div style={cardStyle}>
    <div style={{ fontSize: 9, color: 'rgba(var(--date), 0.95)', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 18, color: 'rgb(var(--date))' }}>{value}</div>
    {sub && <div style={{ fontSize: 9, color: 'rgba(var(--date), 0.95)' }}>{sub}</div>}
  </div>
)

const InfoBox: React.FC<{
  title: string
  style?: React.CSSProperties
  children: React.ReactNode
}> = ({ title, style, children }) => (
  <div
    style={{
      border: '1px solid rgba(var(--date), 0.22)',
      background: 'rgba(0,0,0,0.16)',
      borderRadius: 6,
      padding: '8px 10px',
      ...style,
    }}
  >
    <div style={{ fontSize: 9, color: 'rgba(var(--date), 0.95)', marginBottom: 6 }}>{title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
  </div>
)

const InfoLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
    <span style={{ color: 'rgba(var(--date), 0.95)' }}>{label}</span>
    <span style={{ color: 'rgb(var(--date))', textAlign: 'right' }}>{value}</span>
  </div>
)

export default ServerDashboard
