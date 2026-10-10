import React from 'react'
import type {
  RemoteTerminalProfile,
  RemoteTerminalTestResult,
  RemoteServerMetricsSnapshot,
} from '../../../shared/ipc-contract'
import { useTranslation } from '../../i18n/useTranslation'

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString()
}

export function metricSummary(metric?: RemoteServerMetricsSnapshot): string {
  if (!metric) return ''
  if (!metric.ok) return `METRICS FAIL: ${metric.error || 'unknown'}`
  const cpu = metric.cpu?.usagePercent
  const mem =
    metric.memory?.totalBytes && metric.memory.usedBytes !== undefined
      ? Math.round((metric.memory.usedBytes / metric.memory.totalBytes) * 100)
      : undefined
  const rootDisk = metric.disks?.find((d) => d.mount === '/') || metric.disks?.[0]
  return [
    cpu !== undefined ? `CPU ${cpu.toFixed(1)}%` : '',
    mem !== undefined ? `MEM ${mem}%` : '',
    rootDisk ? `DISK ${rootDisk.usedPercent}%` : '',
  ]
    .filter(Boolean)
    .join(' | ')
}

interface Props {
  profiles: RemoteTerminalProfile[]
  filteredProfiles: RemoteTerminalProfile[]
  searchQuery: string
  sortMode: 'name' | 'latency' | 'lastConnected' | 'cpu' | 'memory' | 'disk'
  resultFilter: 'all' | 'ok' | 'fail'
  showEditor: boolean
  selectedProfileId: string | null
  testResults: Record<string, RemoteTerminalTestResult>
  metricsResults: Record<string, RemoteServerMetricsSnapshot>
  protectedProfileIds: Set<string>
  connectingProfileId: string | null
  testingProfileId: string | null
  metricsProfileId: string | null
  pendingProfileId: string | null
  pendingAction: 'connect' | 'test' | 'metrics' | 'files'
  testingAll: boolean
  collectingAll: boolean
  setSearchQuery: (v: string) => void
  setSortMode: (v: 'name' | 'latency' | 'lastConnected' | 'cpu' | 'memory' | 'disk') => void
  setResultFilter: (v: 'all' | 'ok' | 'fail') => void
  setShowEditor: (v: boolean) => void
  setSelectedProfileId: (v: string | null) => void
  setEditingProfile: (v: RemoteTerminalProfile | null) => void
  setNewName: (v: string) => void
  setNewHost: (v: string) => void
  setNewPort: (v: string) => void
  setNewUser: (v: string) => void
  setNewAuthType: (v: 'password' | 'privateKey') => void
  setNewKeyPath: (v: string) => void
  handleConnect: (p: RemoteTerminalProfile) => void
  handleTestConnection: (p: RemoteTerminalProfile) => void
  handleCollectMetrics: (p: RemoteTerminalProfile) => void
  handleEditProfile: (p: RemoteTerminalProfile) => void
  handleDeleteProfile: (id: string) => void
  handleDuplicateProfile: (p: RemoteTerminalProfile) => void
  handleTestAll: () => void
  handleCollectAllMetrics: () => void
  onDeleteCredential: (id: string) => void
}

const RemoteTerminalSidebar: React.FC<Props> = ({
  filteredProfiles,
  searchQuery,
  sortMode,
  resultFilter,
  showEditor,
  selectedProfileId,
  testResults,
  metricsResults,
  protectedProfileIds,
  connectingProfileId,
  testingProfileId,
  metricsProfileId,
  pendingProfileId,
  pendingAction,
  testingAll,
  collectingAll,
  setSearchQuery,
  setSortMode,
  setResultFilter,
  setShowEditor,
  setSelectedProfileId,
  setEditingProfile,
  setNewName,
  setNewHost,
  setNewPort,
  setNewUser,
  setNewAuthType,
  setNewKeyPath,
  handleConnect,
  handleTestConnection,
  handleCollectMetrics,
  handleEditProfile,
  handleDeleteProfile,
  handleDuplicateProfile,
  handleTestAll,
  handleCollectAllMetrics,
  onDeleteCredential,
}) => {
  const { t } = useTranslation()
  return (
    <div
      className="rt-sidebar"
      style={{
        width: 200,
        minWidth: 140,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid rgba(var(--date), 0.12)',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* Search & controls */}
      <div className="rt-sidebar-toolbar">
        <input
          type="text"
          placeholder={t('Search...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            fontSize: 11,
            padding: '2px 6px',
            background: 'rgba(var(--bg), 0.8)',
            border: '1px solid rgba(var(--date), 0.3)',
            color: 'rgb(var(--date))',
            borderRadius: 3,
            outline: 'none',
          }}
        />
        <div className="rt-sidebar-actions">
          <button
            onClick={() => {
              setEditingProfile(null)
              setNewName('')
              setNewHost('')
              setNewPort('22')
              setNewUser('')
              setNewAuthType('password')
              setNewKeyPath('')
              setShowEditor(!showEditor)
            }}
            style={{ fontSize: 11, padding: '2px 4px' }}
          >
            {showEditor ? t('Cancel') : `+ ${t('New')}`}
          </button>
          <button
            onClick={handleTestAll}
            disabled={testingAll}
            style={{ fontSize: 11, padding: '2px 4px', opacity: testingAll ? 0.5 : 1 }}
          >
            {testingAll ? t('Testing...') : t('Test All')}
          </button>
          <button
            onClick={handleCollectAllMetrics}
            disabled={collectingAll}
            style={{ fontSize: 11, padding: '2px 4px', opacity: collectingAll ? 0.5 : 1 }}
          >
            {collectingAll ? t('Collecting...') : t('Collect All')}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          <select
            value={sortMode}
            onChange={(e) =>
              setSortMode(
                e.target.value as 'name' | 'latency' | 'lastConnected' | 'cpu' | 'memory' | 'disk',
              )
            }
            style={{
              flex: 1,
              fontSize: 10,
              padding: '1px 3px',
              background: 'rgba(var(--bg), 0.8)',
              color: 'rgb(var(--date))',
              border: '1px solid rgba(var(--date), 0.3)',
              borderRadius: 3,
            }}
          >
            <option value="name">{t('Name')}</option>
            <option value="latency">{t('Latency')}</option>
            <option value="lastConnected">{t('Recent')}</option>
            <option value="cpu">{t('CPU')}</option>
            <option value="memory">{t('Memory')}</option>
            <option value="disk">{t('Disk')}</option>
          </select>
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as 'all' | 'ok' | 'fail')}
            style={{
              flex: 1,
              fontSize: 10,
              padding: '1px 3px',
              background: 'rgba(var(--bg), 0.8)',
              color: 'rgb(var(--date))',
              border: '1px solid rgba(var(--date), 0.3)',
              borderRadius: 3,
            }}
          >
            <option value="all">{t('All')}</option>
            <option value="ok">{t('OK')}</option>
            <option value="fail">{t('Fail')}</option>
          </select>
        </div>
      </div>

      {/* Profile list */}
      <div className="rt-profile-list">
        {filteredProfiles.map((p) => (
          <div
            key={p.id}
            className={`rt-profile-card ${selectedProfileId === p.id ? 'is-selected' : ''}`}
            style={{
              padding: '4px 6px',
              cursor: 'pointer',
              borderBottom: '1px solid rgba(var(--date), 0.06)',
              fontSize: 10,
              background: selectedProfileId === p.id ? 'rgba(var(--date), 0.14)' : 'transparent',
            }}
            onClick={() => setSelectedProfileId(p.id)}
          >
            <div
              className="rt-profile-name"
              style={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
            </div>
            <div className="rt-profile-endpoint">
              {p.username?.trim() || t('missing user')}@{p.host}:{p.port || 22}
            </div>
            {testResults[p.id] && (
              <div
                title={testResults[p.id].message}
                style={{
                  color: testResults[p.id].ok ? 'rgb(100,255,150)' : 'rgb(255,140,120)',
                  fontSize: 8,
                  marginTop: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {testResults[p.id].ok
                  ? t('OK {milliseconds}ms', { milliseconds: testResults[p.id].durationMs })
                  : t('FAIL {stage}: {message}', {
                      stage: testResults[p.id].stage,
                      message: testResults[p.id].message,
                    })}
              </div>
            )}
            {metricsResults[p.id] && (
              <div
                title={
                  metricsResults[p.id].ok
                    ? fmtTime(metricsResults[p.id].collectedAt)
                    : metricsResults[p.id].error
                }
                style={{
                  color: metricsResults[p.id].ok ? 'rgb(120,200,255)' : 'rgb(255,140,120)',
                  fontSize: 8,
                  marginTop: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {metricSummary(metricsResults[p.id])}
              </div>
            )}
            {/* ── Row 1: primary actions ── */}
            <div className="rt-profile-primary-actions">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleConnect(p)
                }}
                disabled={
                  connectingProfileId === p.id ||
                  testingProfileId === p.id ||
                  (pendingProfileId === p.id && pendingAction === 'connect')
                }
                style={{ fontSize: 9, padding: '1px 5px', fontWeight: 500 }}
              >
                {connectingProfileId === p.id
                  ? '···'
                  : pendingProfileId === p.id && pendingAction === 'connect'
                    ? t('Auth')
                    : t('Connect')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleTestConnection(p)
                }}
                disabled={
                  connectingProfileId === p.id ||
                  testingProfileId === p.id ||
                  (pendingProfileId === p.id && pendingAction === 'test')
                }
                style={{
                  fontSize: 9,
                  padding: '1px 4px',
                  opacity: testingProfileId === p.id ? 0.5 : 0.75,
                }}
              >
                {testingProfileId === p.id ? '···' : t('Test')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleCollectMetrics(p)
                }}
                disabled={metricsProfileId === p.id || connectingProfileId === p.id}
                style={{
                  fontSize: 9,
                  padding: '1px 4px',
                  opacity: metricsProfileId === p.id ? 0.5 : 0.75,
                }}
              >
                {metricsProfileId === p.id ? '···' : t('Mon')}
              </button>
            </div>
            {/* ── Row 2: management ── */}
            <div className="rt-profile-secondary-actions">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleEditProfile(p)
                }}
                style={{ fontSize: 8, padding: '0 4px', opacity: 0.55 }}
              >
                {t('Edit')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDuplicateProfile(p)
                }}
                title={t('Duplicate profile')}
                style={{ fontSize: 8, padding: '0 4px', opacity: 0.55 }}
              >
                {t('Dup')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(t('Delete "{name}"?', { name: p.name }))) handleDeleteProfile(p.id)
                }}
                style={{ fontSize: 8, padding: '0 4px', opacity: 0.35 }}
              >
                {t('Del')}
              </button>
              {protectedProfileIds.has(p.id) && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    onDeleteCredential(p.id)
                  }}
                  title={t('Windows-protected credential saved. Click to forget it.')}
                  style={{ fontSize: 9, padding: '0 3px', opacity: 0.8 }}
                >
                  🔒
                </button>
              )}
            </div>
            {p.lastConnectedAt && (
              <div style={{ fontSize: 8, color: 'rgba(var(--date), 0.82)' }}>
                {fmtTime(p.lastConnectedAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default RemoteTerminalSidebar
