import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import SourceDerivedDataCleanup from './SourceDerivedDataCleanup'
import ThirdPartyLicensesButton from './ThirdPartyLicensesButton'
import EndUserTermsButton from './EndUserTermsButton'
import { useStore } from '../stores/useStore'
import { useFMStore } from '../stores/useFMStore'
import type { VectorSettings as VectorSettingsConfig } from '../../shared/vectorTypes'
import type { UserModelSlotId, UserModelSlotStatus } from '../../shared/userModelPlatform'
import type {
  AiControlAuditEntry,
  AiControlConfirmation,
  AiControlScope,
  AiControlSettings,
  DisplayScope,
  GlobalHotkeyStatus,
  ProcessedImageDataPreview,
  ProcessedImageDataResetResult,
  WorkspaceDisplay,
} from '../../shared/ipc-contract'
import { DEFAULT_QUICK_ACCESS } from './filemanager/types'
import DraggablePanel from './DraggablePanel'
import {
  DEFAULT_SETTINGS_W,
  DEFAULT_SETTINGS_H,
  DEFAULT_CLOCK_W,
  DEFAULT_CLOCK_H,
  DEFAULT_FOLDERS_W,
  DEFAULT_FOLDERS_H,
  DEFAULT_PROMPTS_W,
  DEFAULT_PROMPTS_H,
  DEFAULT_CALC_W,
  DEFAULT_CALC_H,
  DEFAULT_FM_W,
  DEFAULT_FM_H,
  DEFAULT_IMAGESEARCH_W,
  DEFAULT_IMAGESEARCH_H,
  DEFAULT_UNIFIED_SEARCH_W,
  DEFAULT_UNIFIED_SEARCH_H,
  DEFAULT_APPSTORAGE_W,
  DEFAULT_APPSTORAGE_H,
  DEFAULT_REMOTE_TERMINAL_W,
  DEFAULT_REMOTE_TERMINAL_H,
  DEFAULT_DUPLICATE_FINDER_W,
  DEFAULT_DUPLICATE_FINDER_H,
  DEFAULT_MEDIA_SEARCH_W,
  DEFAULT_MEDIA_SEARCH_H,
  DEFAULT_ASSET_LIBRARY_W,
  DEFAULT_ASSET_LIBRARY_H,
  DEFAULT_BATCH_RENAME_W,
  DEFAULT_BATCH_RENAME_H,
  PANEL_VISIBILITY_DEFAULTS_VERSION,
  FONT_SCALE_STEPS,
  FONT_SCALE_COUNT,
} from '../types'
import { createDefaultTabs, createDefaultPromptTabs } from '../config/default'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { flushSettingsWrites, scheduleSettingsWrite } from '../hooks/settingsWriter'
import { useTranslation } from '../i18n/useTranslation'
import {
  buildThemePalette,
  getThemePreset,
  rgbCss,
  THEME_PRESETS,
  type ThemeGroup,
  type ThemeMode,
} from '../services/themeCatalog'
import {
  PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,
} from '../services/productInformationArchitecture'
import VideoSemanticStatusCard from './VideoSemanticStatusCard'
import {
  DEFAULT_IMAGE_SEARCH_UI_PREFERENCES,
  DEFAULT_MEDIA_SEARCH_UI_PREFERENCES,
} from '../../shared/searchUiPreferences'
import { PANEL_IDENTITIES, type PanelId } from '../../shared/ipc/app-core'

const THEME_GROUPS: ThemeGroup[] = ['classic', 'soft', 'bold', 'neutral']

type PanelVisibilityItem = {
  key: PanelId
  label: string
  show: boolean
  toggle: () => void
  read: () => boolean
  disabled?: boolean
}

const normalizeVectorBackend = (value: string): VectorSettingsConfig['backend'] =>
  value === 'gpu' ? 'gpu' : 'cpu'

const normalizeTextEncoder = (value: string): NonNullable<VectorSettingsConfig['textEncoder']> =>
  value === 'english' || value === 'multilingual' ? value : 'auto'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

type SettingsSectionId =
  | 'appearance'
  | 'panels'
  | 'searchModels'
  | 'dataReset'
  | 'aiControl'
  | 'system'

const SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  'appearance',
  'panels',
  'searchModels',
  'dataReset',
  'aiControl',
  'system',
]

const CollapsibleSettingsSection: React.FC<{
  id: SettingsSectionId
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}> = React.memo(({ id, label, expanded, onToggle, children }) => {
  const hasMountedBody = React.useRef(expanded)
  if (expanded) hasMountedBody.current = true

  return (
    <section className="settings-category" data-settings-category={id}>
      <button
        type="button"
        className="settings-category__header"
        data-testid={`settings-category-${id}`}
        aria-expanded={expanded}
        aria-controls={`settings-category-content-${id}`}
        onClick={onToggle}
      >
        <span className="settings-category__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span>{label}</span>
      </button>
      <div
        id={`settings-category-content-${id}`}
        className="settings-category__content"
        hidden={!expanded}
      >
        {hasMountedBody.current ? children : null}
      </div>
    </section>
  )
})

// ── Vector Settings inline component ────────────────────────

const VectorSettings: React.FC = () => {
  const { t } = useTranslation()
  const [vecEnabled, setVecEnabled] = useState(false)
  const [rerankEnabled, setRerankEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [maxConcurrency, setMaxConcurrency] = useState(2)
  const [backend, setBackend] = useState<VectorSettingsConfig['backend']>('cpu')
  const [textEncoder, setTextEncoder] =
    useState<NonNullable<VectorSettingsConfig['textEncoder']>>('auto')

  useEffect(() => {
    ;(async () => {
      try {
        const api = window.electronAPI?.vector
        if (!api?.getVectorSettings) return
        const s = await api.getVectorSettings()
        if (s) {
          setVecEnabled(s.enabled ?? false)
          setRerankEnabled(s.rerankEnabled ?? false)
          setMaxConcurrency(s.maxConcurrentEmbeddings ?? 2)
          setBackend(normalizeVectorBackend(s.backend || 'cpu'))
          setTextEncoder(normalizeTextEncoder(s.textEncoder || 'auto'))
        }
      } catch {
        /* ignore */
      }
      setLoaded(true)
    })()
  }, [])

  const save = async (patch: Partial<VectorSettingsConfig>) => {
    try {
      const api = window.electronAPI?.vector
      if (api?.saveVectorSettings) {
        await api.saveVectorSettings(patch)
      }
    } catch {
      /* ignore */
    }
  }

  if (!loaded)
    return <div style={{ fontSize: 10, opacity: 0.5, padding: 4 }}>{t('Loading')}...</div>

  const btn = (label: string, active: boolean, onClick: () => void, disabled?: boolean) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        textAlign: 'left',
        fontSize: 11,
        padding: '3px 8px',
        background: active ? 'rgba(0, 255, 100, 0.12)' : 'rgba(255, 80, 80, 0.12)',
        color: 'rgb(var(--fg))',
        border: '0.5px solid rgba(var(--date), 0.18)',
        borderRadius: 2,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {active ? '☑' : '☐'} {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '2px 0' }}>
      {btn(t('Vector Retrieval'), vecEnabled, () => {
        const next = !vecEnabled
        setVecEnabled(next)
        save({ enabled: next, rerankEnabled })
      })}
      {btn(
        t('Rerank (Color + Shape)'),
        rerankEnabled,
        () => {
          const next = !rerankEnabled
          setRerankEnabled(next)
          save({ enabled: vecEnabled, rerankEnabled: next })
        },
        !vecEnabled,
      )}
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          fontSize: 9,
          opacity: 0.5,
          padding: '2px 6px',
        }}
      >
        <span>{t('Backend')}:</span>
        <select
          value={backend}
          onChange={(e) => {
            const next = normalizeVectorBackend(e.target.value)
            setBackend(next)
            save({ backend: next })
          }}
          style={{
            fontSize: 9,
            padding: '0 2px',
            background: 'rgba(var(--bg),0.6)',
            color: 'rgb(var(--fg))',
            border: '0.5px solid rgba(var(--date),0.3)',
            borderRadius: 2,
          }}
          title={t('Windows uses ONNX Runtime DirectML when available; falls back to CPU')}
        >
          <option value="cpu">{t('CPU')}</option>
          <option value="gpu">{t('GPU (DirectML)')}</option>
        </select>
        <span style={{ marginLeft: 4 }}>{t('Jobs')}:</span>
        <select
          value={maxConcurrency}
          onChange={(e) => {
            const v = Number(e.target.value)
            setMaxConcurrency(v)
            save({ maxConcurrentEmbeddings: v })
          }}
          style={{
            fontSize: 9,
            padding: '0 2px',
            background: 'rgba(var(--bg),0.6)',
            color: 'rgb(var(--fg))',
            border: '0.5px solid rgba(var(--date),0.3)',
            borderRadius: 2,
          }}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={4}>4</option>
          <option value={8}>8</option>
        </select>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          fontSize: 9,
          opacity: 0.5,
          padding: '2px 6px',
        }}
      >
        <span>{t('Text encoder')}:</span>
        <select
          value={textEncoder}
          onChange={(e) => {
            const next = normalizeTextEncoder(e.target.value)
            setTextEncoder(next)
            save({ textEncoder: next })
          }}
          style={{
            fontSize: 9,
            padding: '0 2px',
            background: 'rgba(var(--bg),0.6)',
            color: 'rgb(var(--fg))',
            border: '0.5px solid rgba(var(--date),0.3)',
            borderRadius: 2,
          }}
          title={t(
            'Semantic search text encoder: Auto routes CJK queries to the multilingual model; both share the CLIP ViT-B/32 embedding space',
          )}
        >
          <option value="auto">
            {t('Auto')} (CJK → {t('Multilingual')})
          </option>
          <option value="multilingual">{t('Multilingual')}</option>
          <option value="english">{t('English only')}</option>
        </select>
      </div>
    </div>
  )
}

const UserModelPlatformSettings: React.FC = () => {
  const { t } = useTranslation()
  const [slots, setSlots] = useState<UserModelSlotStatus[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<UserModelSlotId | null>(null)
  const [error, setError] = useState('')
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({})

  const refresh = async () => {
    const api = window.electronAPI?.vector
    if (!api?.listUserModelSlots) return
    const nextSlots = await api.listUserModelSlots()
    setSlots(nextSlots)
    setSelectedProfiles((current) => {
      const next = { ...current }
      for (const slot of nextSlots) {
        if (!slot.profiles.some((profile) => profile.id === next[slot.id])) {
          next[slot.id] = slot.activeProfileId
        }
      }
      return next
    })
  }

  useEffect(() => {
    void refresh().catch(() => setError(t('Unable to read model slots')))
  }, [t])

  const importModel = async (slotId: UserModelSlotId) => {
    const api = window.electronAPI?.vector
    if (!api?.importUserModel || !acknowledged) return
    setBusy(slotId)
    setError('')
    try {
      const result = await api.importUserModel(slotId, true, selectedProfiles[slotId])
      if (!result.ok && !result.cancelled) setError(result.error || t('Model import failed'))
      await refresh()
      if (result.ok) window.dispatchEvent(new Event('workspace-models-changed'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Model import failed'))
    } finally {
      setBusy(null)
    }
  }

  const removeModel = async (slotId: UserModelSlotId) => {
    const api = window.electronAPI?.vector
    if (!api?.removeUserModel) return
    setBusy(slotId)
    setError('')
    try {
      const result = await api.removeUserModel(slotId)
      if (!result.ok) setError(result.error || t('Model removal failed'))
      await refresh()
      if (result.ok) window.dispatchEvent(new Event('workspace-models-changed'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Model removal failed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '2px 0' }}>
      <div style={{ fontSize: 9, opacity: 0.72, lineHeight: 1.35 }}>
        {t(
          'Commercial builds do not include these models. Import only models whose license and interface you have verified.',
        )}
      </div>
      <label style={{ display: 'flex', gap: 5, alignItems: 'flex-start', fontSize: 9 }}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>{t('I am responsible for the model license and compatibility')}</span>
      </label>
      {slots.map((slot) => {
        const selectedProfile =
          slot.profiles.find((profile) => profile.id === selectedProfiles[slot.id]) ??
          slot.profiles[0]
        return (
          <div
            key={slot.id}
            style={{
              padding: 5,
              border: '0.5px solid rgba(var(--date),0.2)',
              borderRadius: 2,
              display: 'grid',
              gap: 3,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 5, fontSize: 10 }}>
              <span>{t(slot.displayName)}</span>
              <span
                style={{ color: slot.installed ? 'rgb(100,255,150)' : 'rgba(var(--date),0.6)' }}
              >
                {slot.installed ? t('Installed') : t('Not installed')}
              </span>
            </div>
            <div style={{ fontSize: 8, opacity: 0.62, overflowWrap: 'anywhere' }}>
              {slot.compatibility}
            </div>
            <select
              value={selectedProfile?.id || ''}
              disabled={busy !== null}
              onChange={(event) =>
                setSelectedProfiles((current) => ({
                  ...current,
                  [slot.id]: event.target.value,
                }))
              }
              style={{ width: '100%', fontSize: 9, padding: '2px 3px' }}
              aria-label={`${t(slot.displayName)} ${t('Compatibility profile')}`}
            >
              {slot.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName}
                </option>
              ))}
            </select>
            {selectedProfile && (
              <div style={{ fontSize: 8, opacity: 0.62, overflowWrap: 'anywhere' }}>
                {selectedProfile.compatibility}
              </div>
            )}
            {slot.installed && (
              <div style={{ fontSize: 8, opacity: 0.62 }}>
                {slot.sourceFileName || slot.targetFileName} · {slot.activeProfileName} ·{' '}
                {slot.sizeBytes
                  ? t('{size} MiB', { size: (slot.sizeBytes / 1024 / 1024).toFixed(1) })
                  : '--'}
              </div>
            )}
            {slot.installed && slot.inspection && (
              <details style={{ fontSize: 8, opacity: 0.72 }}>
                <summary>
                  {t('Graph checked')} · {slot.inspection.inputs.length} {t('inputs')} ·{' '}
                  {slot.inspection.outputs.length} {t('outputs')}
                </summary>
                {[...slot.inspection.inputs, ...slot.inspection.outputs].map((tensor) => (
                  <div key={`${tensor.name}:${tensor.shape.join('x')}`}>
                    {tensor.name}: {tensor.type} [{tensor.shape.join(', ')}]
                  </div>
                ))}
              </details>
            )}
            {slot.installed && !slot.inspection && (
              <div style={{ fontSize: 8, color: 'rgb(255,190,90)' }}>
                {t('Legacy model: replace it to run graph compatibility checks')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                disabled={!acknowledged || busy !== null}
                onClick={() => void importModel(slot.id)}
                style={{ flex: 1, fontSize: 9, padding: '2px 4px' }}
              >
                {slot.installed ? t('Replace') : t('Import')}
              </button>
              {slot.installed && (
                <button
                  disabled={busy !== null}
                  onClick={() => void removeModel(slot.id)}
                  style={{ fontSize: 9, padding: '2px 4px' }}
                >
                  {t('Remove')}
                </button>
              )}
            </div>
          </div>
        )
      })}
      <button
        onClick={() => void window.electronAPI?.vector.openUserModelFolder()}
        style={{ width: '100%', fontSize: 10, padding: '3px 6px' }}
      >
        {t('Open User Model Folder')}
      </button>
      {error && <div style={{ color: 'rgb(255,100,100)', fontSize: 9 }}>{error}</div>}
    </div>
  )
}

// ── Main Settings Panel ────────────────────────────────────

const SettingsPanel: React.FC = () => {
  const { language, t } = useTranslation()
  const [expandedSections, setExpandedSections] = useState<Record<SettingsSectionId, boolean>>({
    appearance: true,
    panels: true,
    searchModels: false,
    dataReset: false,
    aiControl: false,
    system: false,
  })
  const setAllSectionsExpanded = (expanded: boolean) =>
    setExpandedSections(
      Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, expanded])) as Record<
        SettingsSectionId,
        boolean
      >,
    )
  const toggleSection = (id: SettingsSectionId) =>
    setExpandedSections((sections) => ({ ...sections, [id]: !sections[id] }))
  const setLanguage = useStore((s) => s.setLanguage)
  const setThemeIdx = useStore((s) => s.setThemeIdx)
  const themeId = useStore((s) => s.themeId)
  const themeMode = useStore((s) => s.themeMode)
  const setThemeId = useStore((s) => s.setThemeId)
  const setThemeMode = useStore((s) => s.setThemeMode)
  const selectedThemeIndex = Math.max(
    0,
    THEME_PRESETS.findIndex((theme) => theme.id === themeId),
  )
  const showDate = useStore((s) => s.showDate)
  const setShowDate = useStore((s) => s.setShowDate)
  const transparency = useStore((s) => s.transparency)
  const setTransparency = useStore((s) => s.setTransparency)
  const fontScaleIdx = useStore((s) => s.fontScaleIdx)
  const setFontScaleIdx = useStore((s) => s.setFontScaleIdx)
  const displayScope = useStore((s) => s.displayScope)
  const setDisplayScope = useStore((s) => s.setDisplayScope)
  const [workspaceDisplays, setWorkspaceDisplays] = useState<WorkspaceDisplay[]>([])
  const [aiControlSettings, setAiControlSettings] = useState<AiControlSettings>({
    enabled: false,
    running: false,
    port: 32145,
    address: 'http://127.0.0.1:32145/v1',
    tokenAvailable: false,
    tokenScopes: ['read', 'window', 'search', 'control'],
    auditEntries: 0,
    pendingConfirmations: 0,
  })
  const [aiControlPort, setAiControlPort] = useState(32145)
  const [aiControlScopes, setAiControlScopes] = useState<AiControlScope[]>([
    'read',
    'window',
    'search',
    'control',
  ])
  const [aiControlToken, setAiControlToken] = useState('')
  const [aiControlAudit, setAiControlAudit] = useState<AiControlAuditEntry[]>([])
  const [aiControlConfirmations, setAiControlConfirmations] = useState<AiControlConfirmation[]>([])
  const [aiControlBusy, setAiControlBusy] = useState(false)
  const [aiControlError, setAiControlError] = useState('')
  const aiControlOpenApiAddress = `${aiControlSettings.address}/openapi.json`

  const setSettingsSize = useStore((s) => s.setSettingsSize)
  const settingsSize = useStore((s) => s.settingsSize)
  const settingsPos = useStore((s) => s.settingsPos)
  const setSettingsPos = useStore((s) => s.setSettingsPos)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['settings'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['settings'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)

  useEffect(() => {
    void window.electronAPI.getDisplayTopology().then((topology) => {
      setWorkspaceDisplays(topology.displays)
      setDisplayScope(topology.scope)
    })
  }, [setDisplayScope])

  useEffect(() => {
    void window.electronAPI.getAiControlSettings().then((settings) => {
      setAiControlSettings(settings)
      setAiControlPort(settings.port)
      setAiControlScopes(settings.tokenScopes)
    })
  }, [])

  useEffect(() => {
    if (!aiControlSettings.enabled) {
      setAiControlConfirmations([])
      return
    }
    const refresh = () => {
      void window.electronAPI
        .getAiControlConfirmations()
        .then((pending) => {
          setAiControlConfirmations(pending)
          setAiControlSettings((current) => ({
            ...current,
            pendingConfirmations: pending.length,
          }))
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(timer)
  }, [aiControlSettings.enabled])

  const changeDisplayScope = async (value: string) => {
    const scope: DisplayScope =
      value === 'all'
        ? { mode: 'all' }
        : value === 'primary'
          ? { mode: 'primary' }
          : { mode: 'display', displayId: value }
    const topology = await window.electronAPI.setDisplayScope(scope)
    setDisplayScope(topology.scope)
    setWorkspaceDisplays(topology.displays)
  }

  const toggleAiControl = async () => {
    setAiControlBusy(true)
    setAiControlError('')
    try {
      const result = await window.electronAPI.setAiControlEnabled(
        !aiControlSettings.enabled,
        aiControlPort,
        aiControlScopes,
      )
      setAiControlSettings(result.settings)
      setAiControlScopes(result.settings.tokenScopes)
      if (result.token) setAiControlToken(result.token)
      if (!result.ok) setAiControlError(result.error ?? t('AI control operation failed'))
    } finally {
      setAiControlBusy(false)
    }
  }

  const rotateAiControlToken = async () => {
    setAiControlBusy(true)
    setAiControlError('')
    try {
      const result = await window.electronAPI.rotateAiControlToken(aiControlScopes)
      setAiControlSettings(result.settings)
      setAiControlScopes(result.settings.tokenScopes)
      if (result.token) setAiControlToken(result.token)
      if (!result.ok) setAiControlError(result.error ?? t('AI control operation failed'))
    } finally {
      setAiControlBusy(false)
    }
  }

  const toggleAiControlScope = (scope: AiControlScope) => {
    if (scope === 'read') return
    setAiControlScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    )
  }

  const refreshAiControlAudit = async () => {
    setAiControlAudit(await window.electronAPI.getAiControlAudit())
  }

  const refreshAiControlConfirmations = async () => {
    setAiControlConfirmations(await window.electronAPI.getAiControlConfirmations())
  }

  const resolveAiControlConfirmation = async (confirmationId: string, approved: boolean) => {
    setAiControlBusy(true)
    setAiControlError('')
    try {
      const result = await window.electronAPI.resolveAiControlConfirmation(confirmationId, approved)
      setAiControlConfirmations(result.confirmations)
      const settings = await window.electronAPI.getAiControlSettings()
      setAiControlSettings(settings)
      if (!result.ok) setAiControlError(result.error ?? t('AI control operation failed'))
    } finally {
      setAiControlBusy(false)
    }
  }
  const showClock = useStore((s) => s.showClock)
  const showFolders = useStore((s) => s.showFolders)
  const showPrompts = useStore((s) => s.showPrompts)
  const showSettings = useStore((s) => s.showSettings)
  const showCalc = useStore((s) => s.showCalc)
  const showFM = useStore((s) => s.showFM)
  const showImageSearch = useStore((s) => s.showImageSearch)
  const showUnifiedSearch = useStore((s) => s.showUnifiedSearch)
  const showAppStorage = useStore((s) => s.showAppStorage)
  const showRemoteTerminal = useStore((s) => s.showRemoteTerminal)
  const showDuplicateFinder = useStore((s) => s.showDuplicateFinder)
  const showMediaSearch = useStore((s) => s.showMediaSearch)
  const showAssetLibrary = useStore((s) => s.showAssetLibrary)
  const showBatchRename = useStore((s) => s.showBatchRename)
  const toggleShowClock = useStore((s) => s.toggleShowClock)
  const toggleShowFolders = useStore((s) => s.toggleShowFolders)
  const toggleShowPrompts = useStore((s) => s.toggleShowPrompts)
  const toggleShowSettings = useStore((s) => s.toggleShowSettings)
  const toggleShowCalc = useStore((s) => s.toggleShowCalc)
  const toggleShowFM = useStore((s) => s.toggleShowFM)
  const toggleShowImageSearch = useStore((s) => s.toggleShowImageSearch)
  const toggleShowUnifiedSearch = useStore((s) => s.toggleShowUnifiedSearch)
  const toggleShowAppStorage = useStore((s) => s.toggleShowAppStorage)
  const toggleShowRemoteTerminal = useStore((s) => s.toggleShowRemoteTerminal)
  const toggleShowDuplicateFinder = useStore((s) => s.toggleShowDuplicateFinder)
  const toggleShowMediaSearch = useStore((s) => s.toggleShowMediaSearch)
  const toggleShowAssetLibrary = useStore((s) => s.toggleShowAssetLibrary)
  const toggleShowBatchRename = useStore((s) => s.toggleShowBatchRename)
  const handleMove = useLinkedMove('settings', settingsPos, setSettingsPos, linkedMove)

  const handlePanelVisibilityToggle = async (
    key: PanelId,
    toggle: () => void,
    readVisibility: () => boolean,
  ) => {
    toggle()
    const visible = readVisibility()
    if (visible) {
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent('panel-focus-request', {
            detail: { panel: PANEL_IDENTITIES[key].domId },
          }),
        )
      })
    }
    const current = useStore.getState()
    const savedVisibility = { ...current.savedVisibility, [key]: visible }
    useStore.setState({ savedVisibility })
    const next = useStore.getState()
    scheduleSettingsWrite({
      showClock: next.showClock,
      showFolders: next.showFolders,
      showPrompts: next.showPrompts,
      showSettings: next.showSettings,
      showCalc: next.showCalc,
      showFM: next.showFM,
      showImageSearch: next.showImageSearch,
      showUnifiedSearch: next.showUnifiedSearch,
      showAppStorage: next.showAppStorage,
      showRemoteTerminal: next.showRemoteTerminal,
      showDuplicateFinder: next.showDuplicateFinder,
      showMediaSearch: next.showMediaSearch,
      showAssetLibrary: next.showAssetLibrary,
      showBatchRename: next.showBatchRename,
      savedVisibility,
    })
    await flushSettingsWrites()
  }

  const [hotkeyStatus, setHotkeyStatus] = useState<GlobalHotkeyStatus>({
    active: false,
    entries: [],
  })
  const hotkeyRegistered = hotkeyStatus.entries.some((entry) => entry.status === 'registered')
  const hotkeyConflicts = hotkeyStatus.entries.filter((entry) => entry.status === 'conflicted')
  const [showReset, setShowReset] = useState(false)
  const [showClearData, setShowClearData] = useState(false)
  const [clearDataPreview, setClearDataPreview] = useState<ProcessedImageDataPreview | null>(null)
  const [clearDataBusy, setClearDataBusy] = useState(false)
  const [clearDataResult, setClearDataResult] = useState<ProcessedImageDataResetResult | null>(null)

  useEffect(() => {
    const openModelSettings = () => {
      setExpandedSections((current) => ({ ...current, searchModels: true }))
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>('[data-settings-category="searchModels"]')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }
    window.addEventListener('workspace-open-model-settings', openModelSettings)
    return () => window.removeEventListener('workspace-open-model-settings', openModelSettings)
  }, [])

  useEffect(() => {
    const reviewDerivedReset = () => {
      setExpandedSections((current) => ({ ...current, dataReset: true }))
      setShowClearData(true)
    }
    window.addEventListener('workspace-review-derived-reset', reviewDerivedReset)
    return () => window.removeEventListener('workspace-review-derived-reset', reviewDerivedReset)
  }, [])

  useEffect(() => {
    if (!showClearData) return
    let cancelled = false
    setClearDataPreview(null)
    setClearDataResult(null)
    setClearDataBusy(false)
    ;(async () => {
      try {
        const preview = await window.electronAPI.vector.previewProcessedImageData()
        if (!cancelled) setClearDataPreview(preview)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showClearData])

  useEffect(() => {
    window.electronAPI.getHotkeyStatus().then(setHotkeyStatus)
  }, [])

  const handleReset = () => {
    setThemeIdx(0)
    setShowDate(true)
    setTransparency(0)
    setFontScaleIdx(0)
    // Use a single setState call with configDirty so auto-save writes immediately
    useStore.setState({
      themeIdx: 0,
      themeId: 'matrix-dark',
      themeMode: 'dark',
      showDate: true,
      transparency: 0,
      fontScaleIdx: 0,
      displayScope: { mode: 'all' },
      tabs: createDefaultTabs(),
      promptTabs: createDefaultPromptTabs(),
      editPrompts: [],
      activeTab: 0,
      activePromptTab: 0,
      clockSize: { w: DEFAULT_CLOCK_W, h: DEFAULT_CLOCK_H },
      foldersSize: { w: DEFAULT_FOLDERS_W, h: DEFAULT_FOLDERS_H },
      promptsSize: { w: DEFAULT_PROMPTS_W, h: DEFAULT_PROMPTS_H },
      settingsSize: { w: DEFAULT_SETTINGS_W, h: DEFAULT_SETTINGS_H },
      calcSize: { w: DEFAULT_CALC_W, h: DEFAULT_CALC_H },
      fmSize: { w: DEFAULT_FM_W, h: DEFAULT_FM_H },
      imageSearchSize: { w: DEFAULT_IMAGESEARCH_W, h: DEFAULT_IMAGESEARCH_H },
      unifiedSearchSize: { w: DEFAULT_UNIFIED_SEARCH_W, h: DEFAULT_UNIFIED_SEARCH_H },
      appStorageSize: { w: DEFAULT_APPSTORAGE_W, h: DEFAULT_APPSTORAGE_H },
      remoteTerminalSize: { w: DEFAULT_REMOTE_TERMINAL_W, h: DEFAULT_REMOTE_TERMINAL_H },
      dupFinderSize: { w: DEFAULT_DUPLICATE_FINDER_W, h: DEFAULT_DUPLICATE_FINDER_H },
      mediaSearchSize: { w: DEFAULT_MEDIA_SEARCH_W, h: DEFAULT_MEDIA_SEARCH_H },
      assetLibrarySize: { w: DEFAULT_ASSET_LIBRARY_W, h: DEFAULT_ASSET_LIBRARY_H },
      batchRenameSize: { w: DEFAULT_BATCH_RENAME_W, h: DEFAULT_BATCH_RENAME_H },
      panelVisibilityDefaultsVersion: PANEL_VISIBILITY_DEFAULTS_VERSION,
      globalVisible: true,
      savedVisibility: { ...PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY },
      ...PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,
      imageSearchUiPreferences: { ...DEFAULT_IMAGE_SEARCH_UI_PREFERENCES },
      mediaSearchUiPreferences: { ...DEFAULT_MEDIA_SEARCH_UI_PREFERENCES },
      configDirty: true, // ensure reset is persisted to disk
    })
    void window.electronAPI.setDisplayScope({ mode: 'all' })
    // Also reset FM store to defaults
    useFMStore.setState({
      fmLayout: 'single',
      fmPaneTabs: [['C:\\'], [], [], []],
      fmActiveTab: [0, 0, 0, 0],
      fmPaneSorts: [
        { field: 'name' as const, direction: 'asc' as const },
        { field: 'name' as const, direction: 'asc' as const },
        { field: 'name' as const, direction: 'asc' as const },
        { field: 'name' as const, direction: 'asc' as const },
      ],
      fmShowHidden: false,
      fmFavorites: DEFAULT_QUICK_ACCESS,
      fmClipboard: null,
      fmViewModes: ['list' as const, 'list' as const, 'list' as const, 'list' as const],
      fmGroupModes: ['none' as const, 'none' as const, 'none' as const, 'none' as const],
      fmGroupExpanded: {},
      fmFontScale: 1.0,
    })
    setShowReset(false)
  }

  const handleClearData = async () => {
    setClearDataBusy(true)
    try {
      const result = await window.electronAPI.vector.clearProcessedImageData()
      setClearDataResult(result)
    } catch (error) {
      setClearDataResult({
        ok: false,
        freedBytes: 0,
        deletedFiles: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      setClearDataBusy(false)
    }
  }

  const handleHotkeyToggle = async () => {
    if (hotkeyRegistered) {
      await window.electronAPI.unregisterHotkey()
      setHotkeyStatus((current) => ({
        active: false,
        entries: current.entries.map((entry) => ({ ...entry, status: 'disabled' })),
      }))
    } else {
      setHotkeyStatus(await window.electronAPI.registerHotkey())
    }
  }

  const btn = (label: string, action: () => void, extra: React.CSSProperties = {}) => (
    <button onClick={action} style={{ width: '100%', fontSize: 11, padding: '4px 8px', ...extra }}>
      {label}
    </button>
  )

  const searchPanelVisibilityItems: PanelVisibilityItem[] = [
    {
      key: 'unifiedSearch',
      label: 'Unified search',
      show: showUnifiedSearch,
      toggle: toggleShowUnifiedSearch,
      read: () => useStore.getState().showUnifiedSearch,
    },
    {
      key: 'imageSearch',
      label: 'Image Search',
      show: showImageSearch,
      toggle: toggleShowImageSearch,
      read: () => useStore.getState().showImageSearch,
    },
    {
      key: 'mediaSearch',
      label: 'Media Search',
      show: showMediaSearch,
      toggle: toggleShowMediaSearch,
      read: () => useStore.getState().showMediaSearch,
    },
    {
      key: 'assetLibrary',
      label: 'Asset Library',
      show: showAssetLibrary,
      toggle: toggleShowAssetLibrary,
      read: () => useStore.getState().showAssetLibrary,
    },
  ]

  const otherPanelVisibilityItems: PanelVisibilityItem[] = [
    {
      key: 'clock',
      label: 'Clock',
      show: showClock,
      toggle: toggleShowClock,
      read: () => useStore.getState().showClock,
    },
    {
      key: 'folders',
      label: 'Folders',
      show: showFolders,
      toggle: toggleShowFolders,
      read: () => useStore.getState().showFolders,
    },
    {
      key: 'prompts',
      label: 'Prompts',
      show: showPrompts,
      toggle: toggleShowPrompts,
      read: () => useStore.getState().showPrompts,
    },
    {
      key: 'settings',
      label: 'Settings',
      show: showSettings,
      toggle: toggleShowSettings,
      read: () => useStore.getState().showSettings,
      disabled: true,
    },
    {
      key: 'calc',
      label: 'Calculator',
      show: showCalc,
      toggle: toggleShowCalc,
      read: () => useStore.getState().showCalc,
    },
    {
      key: 'fm',
      label: 'File Manager',
      show: showFM,
      toggle: toggleShowFM,
      read: () => useStore.getState().showFM,
    },
    {
      key: 'appStorage',
      label: 'App Storage',
      show: showAppStorage,
      toggle: toggleShowAppStorage,
      read: () => useStore.getState().showAppStorage,
    },
    {
      key: 'duplicateFinder',
      label: 'Duplicate Finder',
      show: showDuplicateFinder,
      toggle: toggleShowDuplicateFinder,
      read: () => useStore.getState().showDuplicateFinder,
    },
    {
      key: 'batchRename',
      label: 'Batch Rename',
      show: showBatchRename,
      toggle: toggleShowBatchRename,
      read: () => useStore.getState().showBatchRename,
    },
  ]

  const sourceAdvancedToolItems: PanelVisibilityItem[] = [
    {
      key: 'remoteTerminal',
      label: 'Remote source advanced tools',
      show: showRemoteTerminal,
      toggle: toggleShowRemoteTerminal,
      read: () => useStore.getState().showRemoteTerminal,
    },
  ]

  const renderPanelVisibilityGroup = (label: string, items: PanelVisibilityItem[]) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 4,
        border: '1px solid rgba(var(--date),0.16)',
      }}
    >
      <div style={{ fontSize: 9, opacity: 0.58, padding: '1px 4px 2px' }}>{t(label)}</div>
      {items.map(({ key, label: itemLabel, show, toggle, read, disabled }) => (
        <button
          key={itemLabel}
          disabled={disabled}
          onClick={() => void handlePanelVisibilityToggle(key, toggle, read)}
          style={{
            width: '100%',
            textAlign: 'left',
            fontSize: 11,
            padding: '3px 8px',
            background: show ? 'rgba(0, 255, 100, 0.12)' : 'rgba(255, 80, 80, 0.12)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.62 : 1,
          }}
        >
          {show ? '☑' : '☐'} {t(itemLabel)}
        </button>
      ))}
    </div>
  )

  return (
    <DraggablePanel
      panelId="settings"
      title="Settings"
      displayTitle={t('Settings')}
      x={settingsPos.x}
      y={settingsPos.y}
      defaultX={42}
      defaultY={42}
      w={settingsSize.w}
      h={settingsSize.h}
      defaultW={DEFAULT_SETTINGS_W}
      defaultH={DEFAULT_SETTINGS_H}
      onMove={handleMove}
      onResize={(w, h) => setSettingsSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('settings')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('settings')}
    >
      <div className="settings-categories">
        <div className="settings-categories__toolbar">
          <button type="button" onClick={() => setAllSectionsExpanded(true)}>
            {t('Expand all')}
          </button>
          <button type="button" onClick={() => setAllSectionsExpanded(false)}>
            {t('Collapse all')}
          </button>
        </div>

        <CollapsibleSettingsSection
          id="appearance"
          label={t('Appearance & Display')}
          expanded={expandedSections.appearance}
          onToggle={() => toggleSection('appearance')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label htmlFor="app-language" style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>
              {t('Language')}
            </label>
            <select
              id="app-language"
              data-testid="app-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value === 'zh-CN' ? 'zh-CN' : 'en')}
              style={{ flex: 1, fontSize: 11, padding: '2px 4px' }}
            >
              <option value="zh-CN">{t('Chinese')}</option>
              <option value="en">{t('English')}</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label htmlFor="display-scope" style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>
              {t('Displays')}
            </label>
            <select
              id="display-scope"
              data-testid="display-scope"
              value={displayScope.mode === 'display' ? displayScope.displayId : displayScope.mode}
              onChange={(event) => void changeDisplayScope(event.target.value)}
              style={{ flex: 1, fontSize: 11, padding: '2px 4px' }}
            >
              <option value="all">{t('All displays')}</option>
              <option value="primary">{t('Primary display')}</option>
              {workspaceDisplays.map((display, index) => (
                <option key={display.id} value={display.id}>
                  {t('Display {number}', { number: index + 1 })} · {display.workArea.width}×
                  {display.workArea.height} · {Math.round(display.scaleFactor * 100)}%
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>{t('Theme')}</span>
            <button
              onClick={() =>
                setThemeId(
                  THEME_PRESETS[
                    (selectedThemeIndex - 1 + THEME_PRESETS.length) % THEME_PRESETS.length
                  ].id,
                )
              }
              style={{ width: 22, padding: '2px 0', fontSize: 11 }}
            >
              {'<'}
            </button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: 11 }}>
              {getThemePreset(themeId).name}
            </span>
            <button
              onClick={() =>
                setThemeId(THEME_PRESETS[(selectedThemeIndex + 1) % THEME_PRESETS.length].id)
              }
              style={{ width: 22, padding: '2px 0', fontSize: 11 }}
            >
              {'>'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label htmlFor="theme-mode" style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>
              {t('Mode')}
            </label>
            <select
              id="theme-mode"
              data-testid="theme-mode"
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
              style={{ flex: 1 }}
            >
              <option value="system">{t('Follow system')}</option>
              <option value="light">{t('Light')}</option>
              <option value="dark">{t('Dark')}</option>
            </select>
          </div>
          <div className="theme-preset-groups" aria-label={t('Window style')}>
            {THEME_GROUPS.map((group) => (
              <div key={group} className="theme-preset-group">
                <small className="theme-preset-group-label">{t(`Theme group: ${group}`)}</small>
                <div className="theme-style-picker">
                  {THEME_PRESETS.filter((theme) => theme.group === group).map((theme) => {
                    const previewMode = theme.defaultMode === 'light' ? 'light' : 'dark'
                    const palette = buildThemePalette(theme.id, previewMode)
                    return (
                      <button
                        key={theme.id}
                        className={`theme-style-option ${themeId === theme.id ? 'is-active' : ''}`}
                        onClick={() => setThemeId(theme.id)}
                        title={t('{name} window style', { name: theme.name })}
                        aria-label={t('{name} window style', { name: theme.name })}
                        aria-pressed={themeId === theme.id}
                        style={{
                          color: `rgb(${rgbCss(palette.accent)})`,
                          background: `rgb(${rgbCss(palette.canvas)})`,
                        }}
                      >
                        <span />
                        <small>{theme.name}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>{t('Date')}</span>
            <button
              onClick={() => setShowDate(!showDate)}
              style={{ flex: 1, fontSize: 11, padding: '3px 6px' }}
            >
              {t(showDate ? 'Show' : 'Hide')}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>{t('Material')}</span>
            <button
              data-testid="window-material-solid"
              className={transparency === 0 ? 'is-selected' : undefined}
              onClick={() => setTransparency(0)}
              aria-pressed={transparency === 0}
              style={{ flex: 1, fontSize: 11, padding: '3px 6px' }}
            >
              {t('Solid')}
            </button>
            <button
              data-testid="window-material-glass"
              className={transparency > 0 ? 'is-selected' : undefined}
              onClick={() => setTransparency(Math.max(32, transparency))}
              aria-pressed={transparency > 0}
              style={{ flex: 1, fontSize: 11, padding: '3px 6px' }}
            >
              {t('Glass')}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>{t('Glass')}</span>
            <input
              data-testid="window-glass-strength"
              type="range"
              min={1}
              max={60}
              value={Math.max(1, transparency)}
              onChange={(e) => setTransparency(Number(e.target.value))}
              disabled={transparency === 0}
              aria-label={t('Glass strength')}
              style={{ flex: 1, margin: 0 }}
            />
            <span style={{ fontSize: 10, opacity: 0.5, minWidth: 30 }}>
              {transparency === 0 ? t('Off') : `${transparency}%`}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ opacity: 0.6, fontSize: 11, minWidth: 58 }}>{t('Font')}</span>
            <button
              onClick={() => fontScaleIdx > 0 && setFontScaleIdx(fontScaleIdx - 1)}
              disabled={fontScaleIdx === 0}
              style={{ width: 22, padding: '2px 0', fontSize: 11 }}
            >
              −
            </button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: 11 }}>
              {Math.round(FONT_SCALE_STEPS[fontScaleIdx] * 100)}%
            </span>
            <button
              onClick={() =>
                fontScaleIdx < FONT_SCALE_COUNT - 1 && setFontScaleIdx(fontScaleIdx + 1)
              }
              disabled={fontScaleIdx === FONT_SCALE_COUNT - 1}
              style={{ width: 22, padding: '2px 0', fontSize: 11 }}
            >
              +
            </button>
          </div>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          id="panels"
          label={t('Panel Management')}
          expanded={expandedSections.panels}
          onToggle={() => toggleSection('panels')}
        >
          <div style={{ display: 'grid', gap: 5 }}>
            {renderPanelVisibilityGroup('Search panels', searchPanelVisibilityItems)}
            {renderPanelVisibilityGroup('Other panels', otherPanelVisibilityItems)}
            {renderPanelVisibilityGroup('Source advanced tools', sourceAdvancedToolItems)}
          </div>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          id="searchModels"
          label={t('Search & Models')}
          expanded={expandedSections.searchModels}
          onToggle={() => toggleSection('searchModels')}
        >
          <div className="settings-category__subheading">{t('Vector / Rerank')}</div>
          <div style={{ padding: '2px 0' }}>
            <VectorSettings />
          </div>

          <div className="settings-category__subheading">{t('Model Platform')}</div>
          <UserModelPlatformSettings />

          <div className="settings-category__subheading">{t('Video Semantic Model')}</div>
          <VideoSemanticStatusCard compact />
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          id="dataReset"
          label={t('Data & Reset')}
          expanded={expandedSections.dataReset}
          onToggle={() => toggleSection('dataReset')}
        >
          {btn(t('Open App Data Folder'), () => window.electronAPI.openConfigDir())}
          {btn(t('Reset Sizes'), () => {
            useStore.setState({
              clockSize: { w: DEFAULT_CLOCK_W, h: DEFAULT_CLOCK_H },
              foldersSize: { w: DEFAULT_FOLDERS_W, h: DEFAULT_FOLDERS_H },
              promptsSize: { w: DEFAULT_PROMPTS_W, h: DEFAULT_PROMPTS_H },
              settingsSize: { w: DEFAULT_SETTINGS_W, h: DEFAULT_SETTINGS_H },
              calcSize: { w: DEFAULT_CALC_W, h: DEFAULT_CALC_H },
              fmSize: { w: DEFAULT_FM_W, h: DEFAULT_FM_H },
              imageSearchSize: { w: DEFAULT_IMAGESEARCH_W, h: DEFAULT_IMAGESEARCH_H },
              unifiedSearchSize: { w: DEFAULT_UNIFIED_SEARCH_W, h: DEFAULT_UNIFIED_SEARCH_H },
              appStorageSize: { w: DEFAULT_APPSTORAGE_W, h: DEFAULT_APPSTORAGE_H },
              remoteTerminalSize: {
                w: DEFAULT_REMOTE_TERMINAL_W,
                h: DEFAULT_REMOTE_TERMINAL_H,
              },
              dupFinderSize: {
                w: DEFAULT_DUPLICATE_FINDER_W,
                h: DEFAULT_DUPLICATE_FINDER_H,
              },
              mediaSearchSize: { w: DEFAULT_MEDIA_SEARCH_W, h: DEFAULT_MEDIA_SEARCH_H },
              assetLibrarySize: { w: DEFAULT_ASSET_LIBRARY_W, h: DEFAULT_ASSET_LIBRARY_H },
              batchRenameSize: { w: DEFAULT_BATCH_RENAME_W, h: DEFAULT_BATCH_RENAME_H },
            })
          })}
          {btn(t('Reset Config'), () => setShowReset(true), {
            color: 'rgba(255, 100, 100, 1)',
          })}
          <button
            data-testid="clear-processed-image-data"
            onClick={() => setShowClearData(true)}
            style={{
              width: '100%',
              fontSize: 11,
              padding: '4px 8px',
              color: 'rgba(255, 100, 100, 1)',
            }}
          >
            {t('Clear Processed Image Data')}
          </button>
          <SourceDerivedDataCleanup />

          {/* Clear processed image data modal (portal to body to avoid panel overflow clip) */}
          {showClearData &&
            createPortal(
              <div style={{ pointerEvents: 'auto' }} data-portal="">
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'rgba(0,0,0,0.3)' }}
                  onClick={() => !clearDataBusy && setShowClearData(false)}
                />
                <div
                  style={{
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 100,
                    background: 'rgba(var(--bg), 0.97)',
                    border: '1px solid rgba(var(--date), 0.5)',
                    borderRadius: 6,
                    padding: 16,
                    minWidth: 260,
                    maxWidth: 380,
                  }}
                >
                  <div style={{ marginBottom: 12, fontSize: 13 }}>
                    {t('Delete all processed image search data?')}
                    <br />
                    <span style={{ color: 'rgba(255, 100, 100, 1)', fontSize: 11 }}>
                      {t(
                        'This removes the native index, thumbnails, scan logs and all DINO/CLIP vector data. This cannot be undone; you will need to rescan and rebuild embeddings.',
                      )}
                    </span>
                  </div>
                  {clearDataPreview && (
                    <div style={{ marginBottom: 12, fontSize: 11, opacity: 0.85 }}>
                      {t('Files to delete')}: {clearDataPreview.fileCount} (
                      {formatBytes(clearDataPreview.estimatedBytes)})
                      {clearDataPreview.categories.map((category) => (
                        <div key={category.id} style={{ opacity: 0.75 }}>
                          {category.label}: {category.fileCount} (
                          {formatBytes(category.estimatedBytes)})
                        </div>
                      ))}
                    </div>
                  )}
                  {clearDataResult && (
                    <div style={{ marginBottom: 12, fontSize: 11 }}>
                      {clearDataResult.ok ? (
                        clearDataResult.deletedFiles > 0 ? (
                          <>
                            {t('Deleted {files} files, freed {size}.', {
                              files: clearDataResult.deletedFiles,
                              size: formatBytes(clearDataResult.freedBytes),
                            })}
                            <br />
                            {t('Reopen the Image Search panel before searching again.')}
                          </>
                        ) : (
                          t('Nothing to delete.')
                        )
                      ) : (
                        <>
                          {t('Some files could not be deleted:')}
                          {(clearDataResult.errors.length > 0
                            ? clearDataResult.errors
                            : [clearDataResult.error || '']
                          )
                            .filter(Boolean)
                            .map((message) => (
                              <div key={message} style={{ color: 'rgba(255, 100, 100, 1)' }}>
                                {message}
                              </div>
                            ))}
                        </>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    {clearDataResult ? (
                      <button onClick={() => setShowClearData(false)}>{t('Close')}</button>
                    ) : (
                      <>
                        <button
                          onClick={() => void handleClearData()}
                          disabled={clearDataBusy}
                          style={{ background: 'rgba(255, 80, 80, 0.35)' }}
                        >
                          {clearDataBusy ? t('Deleting…') : t('Yes, delete')}
                        </button>
                        <button onClick={() => setShowClearData(false)} disabled={clearDataBusy}>
                          {t('Cancel')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )}

          {/* Reset modal (portal to body to avoid panel overflow clip) */}
          {showReset &&
            createPortal(
              <div style={{ pointerEvents: 'auto' }} data-portal="">
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'rgba(0,0,0,0.3)' }}
                  onClick={() => setShowReset(false)}
                />
                <div
                  style={{
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 100,
                    background: 'rgba(var(--bg), 0.97)',
                    border: '1px solid rgba(var(--date), 0.5)',
                    borderRadius: 6,
                    padding: 16,
                    minWidth: 260,
                  }}
                >
                  <div style={{ marginBottom: 12, fontSize: 13 }}>
                    {t('Delete all shortcuts and prompts?')}
                    <br />
                    {t('This cannot be undone.')}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={handleReset} style={{ background: 'rgba(255, 80, 80, 0.35)' }}>
                      {t('Yes, reset')}
                    </button>
                    <button onClick={() => setShowReset(false)}>{t('Cancel')}</button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          id="aiControl"
          label={t('AI Control')}
          expanded={expandedSections.aiControl}
          onToggle={() => toggleSection('aiControl')}
        >
          <div
            data-testid="ai-control-settings"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ minWidth: 58, opacity: 0.65 }}>{t('Local API')}</span>
              <button
                data-testid="ai-control-toggle"
                onClick={() => void toggleAiControl()}
                disabled={aiControlBusy}
                style={{ flex: 1, padding: '3px 6px' }}
              >
                {t(aiControlSettings.enabled ? 'Disable' : 'Enable')}
              </button>
              <span style={{ color: aiControlSettings.running ? 'rgb(var(--accent))' : undefined }}>
                {t(aiControlSettings.running ? 'Running' : 'Stopped')}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <label htmlFor="ai-control-port" style={{ minWidth: 58, opacity: 0.65 }}>
                {t('Port')}
              </label>
              <input
                id="ai-control-port"
                type="number"
                min={1024}
                max={65535}
                value={aiControlPort}
                disabled={aiControlSettings.enabled}
                onChange={(event) => setAiControlPort(Number(event.target.value) || 32145)}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <code style={{ overflowWrap: 'anywhere', opacity: 0.7 }}>
              {aiControlSettings.address}
            </code>
            <code style={{ overflowWrap: 'anywhere', opacity: 0.7 }}>
              {aiControlOpenApiAddress}
            </code>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 7px' }}>
              {(['read', 'window', 'search', 'control'] as AiControlScope[]).map((scope) => (
                <label key={scope} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <input
                    type="checkbox"
                    checked={aiControlScopes.includes(scope)}
                    disabled={scope === 'read'}
                    onChange={() => toggleAiControlScope(scope)}
                  />
                  {t(scope)}
                </label>
              ))}
            </div>
            <div style={{ opacity: 0.6 }}>{t('Scope changes apply when the token is rotated')}</div>
            <div style={{ display: 'flex', gap: 5 }}>
              <button
                onClick={() => void rotateAiControlToken()}
                disabled={aiControlBusy}
                style={{ flex: 1 }}
              >
                {t('Rotate token')}
              </button>
              <button
                onClick={() => void window.electronAPI.copyToClipboard(aiControlToken)}
                disabled={!aiControlToken}
                style={{ flex: 1 }}
              >
                {t('Copy token')}
              </button>
            </div>
            {aiControlToken && (
              <div>
                <div style={{ color: 'rgb(var(--date))' }}>{t('Token is shown only once')}</div>
                <input
                  data-testid="ai-control-token"
                  readOnly
                  value={aiControlToken}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </div>
            )}
            <div style={{ opacity: 0.6 }}>
              {t('Loopback only')} ·{' '}
              {t('{count} audit entries', { count: aiControlSettings.auditEntries })} ·{' '}
              {t('{count} pending confirmations', {
                count: aiControlSettings.pendingConfirmations,
              })}
            </div>
            <button
              data-testid="ai-control-confirmations-refresh"
              onClick={() => void refreshAiControlConfirmations()}
              style={{ padding: '3px 6px' }}
            >
              {t('Review pending confirmations')}
            </button>
            {aiControlConfirmations.length > 0 && (
              <div
                data-testid="ai-control-confirmations"
                style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
              >
                {aiControlConfirmations.map((confirmation) => (
                  <div
                    key={confirmation.id}
                    style={{ border: '1px solid rgb(var(--border))', padding: 5, borderRadius: 4 }}
                  >
                    <div style={{ fontWeight: 600 }}>{confirmation.capabilityId}</div>
                    <div style={{ opacity: 0.65, overflowWrap: 'anywhere' }}>
                      {confirmation.inputKeys.join(', ') || t('No input fields')}
                    </div>
                    <code style={{ display: 'block', overflowWrap: 'anywhere', opacity: 0.72 }}>
                      {JSON.stringify(confirmation.inputPreview)}
                    </code>
                    <div style={{ display: 'flex', gap: 5, marginTop: 3 }}>
                      <button
                        data-testid={`ai-control-approve-${confirmation.id}`}
                        disabled={aiControlBusy}
                        onClick={() => void resolveAiControlConfirmation(confirmation.id, true)}
                        style={{ flex: 1 }}
                      >
                        {t('Approve once')}
                      </button>
                      <button
                        disabled={aiControlBusy}
                        onClick={() => void resolveAiControlConfirmation(confirmation.id, false)}
                        style={{ flex: 1 }}
                      >
                        {t('Deny')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => void refreshAiControlAudit()} style={{ padding: '3px 6px' }}>
              {t('Show recent audit')}
            </button>
            {aiControlAudit.length > 0 && (
              <div
                data-testid="ai-control-audit"
                style={{ maxHeight: 110, overflow: 'auto', fontSize: 9, opacity: 0.78 }}
              >
                {aiControlAudit.slice(0, 20).map((entry) => (
                  <div key={`${entry.timestamp}-${entry.requestId}`}>
                    {entry.timestamp.slice(0, 19).replace('T', ' ')} · {entry.capabilityId} ·{' '}
                    {entry.outcome} · {entry.durationMs}ms
                  </div>
                ))}
              </div>
            )}
            {(aiControlError || aiControlSettings.lastError) && (
              <div style={{ color: '#ff7a7a' }}>
                {aiControlError || aiControlSettings.lastError}
              </div>
            )}
          </div>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          id="system"
          label={t('System & Shortcuts')}
          expanded={expandedSections.system}
          onToggle={() => toggleSection('system')}
        >
          <div style={{ fontSize: 10, opacity: 0.5, lineHeight: 1.6 }}>
            Ctrl+Shift+Alt+R — {t('Toggle visibility')}
            <br />
            Ctrl+Shift+Alt+Q — {t('Toggle visibility')} ({t('Legacy')})
            <br />
            {t('Ctrl+Shift+Alt+P —')} {t('Snap panels')}
            <br />
            Ctrl+Shift+Alt+S — {t('Show all panels')}
            <br />
            Shift+Alt+Q — {t('Arrange in a row')}
            <br />
            Shift+Alt+W — {t('Arrange in a grid')}
            <br />
            Shift+Alt+E — {t('Arrange in a column')}
            <br />
            Shift+Escape — {t('Quit')}
          </div>
          {hotkeyConflicts.length > 0 && (
            <div style={{ margin: '4px 0', color: 'var(--warning, #f0b45b)', fontSize: 10 }}>
              {t('Shortcut conflicts')}:{' '}
              {hotkeyConflicts.map((entry) => entry.accelerator).join(', ')}
            </div>
          )}
          {btn(t(hotkeyRegistered ? 'Unregister Hotkeys' : 'Register Hotkeys'), handleHotkeyToggle)}
          <ThirdPartyLicensesButton />
          <EndUserTermsButton />
          {btn(t('Quit'), () => window.close(), {
            background: 'rgba(255, 80, 80, 0.2)',
            marginTop: 4,
          })}
        </CollapsibleSettingsSection>
      </div>
    </DraggablePanel>
  )
}

export default SettingsPanel
