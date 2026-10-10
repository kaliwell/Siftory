import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import ServerDashboard from './remote-terminal/ServerDashboard'
import RemoteFileBrowser from './remote-terminal/RemoteFileBrowser'
import ProfileEditor from './remote-terminal/ProfileEditor'
import RemoteTerminalSidebar, { metricSummary } from './remote-terminal/RemoteTerminalSidebar'
import SessionTabs from './remote-terminal/SessionTabs'
import CredentialBar, { type RemoteTerminalPendingAction } from './remote-terminal/CredentialBar'
import SessionOverview from './remote-terminal/SessionOverview'
import { DEFAULT_REMOTE_TERMINAL_W, DEFAULT_REMOTE_TERMINAL_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useTranslation } from '../i18n/useTranslation'
import type {
  RemoteTerminalProfile,
  RemoteTerminalSessionStatus,
  RemoteTerminalTestResult,
  RemoteServerMetricsSnapshot,
} from '../../shared/ipc-contract'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../styles/remote-terminal.css'

// ── Component ───────────────────────────────────────────────

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

type TerminalInstance = {
  term: XTerm
  fitAddon: XTermFitAddon
}

function profileLastTestToResult(profile: RemoteTerminalProfile): RemoteTerminalTestResult | null {
  if (!profile.lastTest) return null
  return {
    ok: profile.lastTest.ok,
    profileId: profile.id,
    stage: profile.lastTest.stage,
    durationMs: profile.lastTest.durationMs,
    message: profile.lastTest.message,
  }
}

const RemoteTerminalPanel: React.FC = () => {
  const { t } = useTranslation()
  const terminalPos = useStore((s) => s.remoteTerminalPos)
  const setTerminalPos = useStore((s) => s.setRemoteTerminalPos)
  const terminalSize = useStore((s) => s.remoteTerminalSize)
  const setTerminalSize = useStore((s) => s.setRemoteTerminalSize)
  const showRemoteTerminal = useStore((s) => s.showRemoteTerminal)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['remoteTerminal'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['remoteTerminal'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('remoteTerminal', terminalPos, setTerminalPos, linkedMove)

  // Profile management
  const [profiles, setProfiles] = useState<RemoteTerminalProfile[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [resultFilter, setResultFilter] = useState<'all' | 'ok' | 'fail'>('all')
  const [sortMode, setSortMode] = useState<
    'name' | 'latency' | 'lastConnected' | 'cpu' | 'memory' | 'disk'
  >('name')
  const [editingProfile, setEditingProfile] = useState<RemoteTerminalProfile | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [protectedProfileIds, setProtectedProfileIds] = useState<Set<string>>(new Set())

  // Connection state
  const [activeSessions, setActiveSessions] = useState<Map<string, RemoteTerminalSessionStatus>>(
    new Map(),
  )
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null)
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null)
  const [metricsProfileId, setMetricsProfileId] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [collectingAll, setCollectingAll] = useState(false)
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<RemoteTerminalPendingAction>('connect')
  const [rememberForSession, setRememberForSession] = useState(false)
  const [rememberOnDevice, setRememberOnDevice] = useState(false)
  const [showRemoteFiles, setShowRemoteFiles] = useState(false)
  const [filesRefreshToken, setFilesRefreshToken] = useState(0)
  const [lastMessage, setLastMessage] = useState('Select a profile and connect.')
  const [testResults, setTestResults] = useState<Record<string, RemoteTerminalTestResult>>({})
  const [metricsResults, setMetricsResults] = useState<Record<string, RemoteServerMetricsSnapshot>>(
    {},
  )

  // New profile form
  const [newName, setNewName] = useState('')
  const [newHost, setNewHost] = useState('')
  const [newPort, setNewPort] = useState('22')
  const [newHostFingerprint, setNewHostFingerprint] = useState('')
  const [newUser, setNewUser] = useState('')
  const [newAuthType, setNewAuthType] = useState<'password' | 'privateKey' | 'agent'>('password')
  const [newKeyPath, setNewKeyPath] = useState('')

  const termContainerRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const terminalRefs = useRef<Record<string, TerminalInstance>>({})
  const sessionSecretsRef = useRef<Record<string, string>>({})

  // Load profiles
  useEffect(() => {
    window.electronAPI.remoteTerminal.listProfiles().then((loadedProfiles) => {
      setProfiles(loadedProfiles)
      const loadedResults: Record<string, RemoteTerminalTestResult> = {}
      for (const profile of loadedProfiles) {
        const result = profileLastTestToResult(profile)
        if (result) loadedResults[profile.id] = result
      }
      setTestResults(loadedResults)
      const loadedMetrics: Record<string, RemoteServerMetricsSnapshot> = {}
      for (const profile of loadedProfiles) {
        if (profile.lastMetrics) loadedMetrics[profile.id] = profile.lastMetrics
      }
      setMetricsResults(loadedMetrics)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all(
      profiles.map(async (profile) => ({
        id: profile.id,
        status: await window.electronAPI.remoteTerminal.credentialStatus(profile.id),
      })),
    ).then((results) => {
      if (!cancelled) {
        setProtectedProfileIds(
          new Set(results.filter((item) => item.status.stored).map((item) => item.id)),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [profiles])

  // Listen for data events
  useEffect(() => {
    const unsubData = window.electronAPI.remoteTerminal.onData((event) => {
      terminalRefs.current[event.sessionId]?.term.write(event.data)
    })
    const unsubStatus = window.electronAPI.remoteTerminal.onStatusChanged((status) => {
      setActiveSessions((prev) => {
        const next = new Map(prev)
        const previous = next.get(status.sessionId)
        if (status.state === 'error' && previous?.state !== 'connected') {
          next.delete(status.sessionId)
        } else if (status.state === 'disconnected') {
          next.delete(status.sessionId)
        } else {
          next.set(status.sessionId, status)
        }
        return next
      })
      if (status.state === 'connected') {
        setConnectingProfileId(null)
        setLastMessage('Connected.')
      }
      if (status.state === 'error' || status.state === 'disconnected') {
        setConnectingProfileId(null)
        setLastMessage(status.message || status.state)
        setActiveTabId((current) => (current === status.sessionId ? null : current))
      }
    })
    return () => {
      unsubData()
      unsubStatus()
    }
  }, [])

  const ensureTerminal = useCallback(async (sessionId: string) => {
    if (terminalRefs.current[sessionId]) return terminalRefs.current[sessionId]
    const container = termContainerRefs.current[sessionId]
    if (!container) return null

    try {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const fitAddon = new FitAddon()

      const term = new Terminal({
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        theme: {
          background: '#0d0d0d',
          foreground: '#c0c0c0',
          cursor: '#c0c0c0',
        },
      })
      term.loadAddon(fitAddon)
      term.open(container)
      fitAddon.fit()

      term.onData((data: string) => {
        window.electronAPI.remoteTerminal.write(sessionId, data)
      })

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        window.electronAPI.remoteTerminal.resize(sessionId, { cols, rows })
      })

      const instance = { term, fitAddon }
      terminalRefs.current[sessionId] = instance
      return instance
    } catch (e) {
      console.error('Failed to init xterm:', e)
      return null
    }
  }, [])

  useEffect(() => {
    for (const sessionId of activeSessions.keys()) {
      ensureTerminal(sessionId)
    }
  }, [activeSessions, ensureTerminal])

  useEffect(() => {
    if (!activeTabId) return
    let cancelled = false
    ensureTerminal(activeTabId).then((instance) => {
      if (cancelled || !instance) return
      window.requestAnimationFrame(() => {
        instance.fitAddon.fit()
        instance.term.focus()
      })
    })
    return () => {
      cancelled = true
    }
  }, [activeTabId, ensureTerminal])

  useEffect(() => {
    const activeIds = new Set(activeSessions.keys())
    for (const sessionId of Object.keys(terminalRefs.current)) {
      if (!activeIds.has(sessionId)) {
        terminalRefs.current[sessionId].term.dispose()
        delete terminalRefs.current[sessionId]
        delete termContainerRefs.current[sessionId]
      }
    }
  }, [activeSessions])

  useEffect(() => {
    return () => {
      for (const instance of Object.values(terminalRefs.current)) {
        instance.term.dispose()
      }
      terminalRefs.current = {}
    }
  }, [])

  useEffect(() => {
    if (!showRemoteTerminal || !activeTabId) return
    const id = window.requestAnimationFrame(() => {
      terminalRefs.current[activeTabId]?.fitAddon.fit()
    })
    return () => window.cancelAnimationFrame(id)
  }, [showRemoteTerminal, activeTabId, terminalSize.w, terminalSize.h])

  // ── Actions ───────────────────────────────────────────────

  const handleConnect = useCallback(
    async (profile: RemoteTerminalProfile) => {
      const secret = password || sessionSecretsRef.current[profile.id] || ''
      if (!profile.username?.trim()) {
        setLastMessage('Username is missing. Edit this profile and set username, e.g. root.')
        return
      }
      setConnectingProfileId(profile.id)
      setLastMessage(`Connecting to ${profile.username}@${profile.host}:${profile.port || 22}...`)

      const request = {
        profileId: profile.id,
        password: profile.authType === 'password' ? secret || undefined : undefined,
        passphrase: profile.authType === 'privateKey' ? secret || undefined : undefined,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      }
      let status = await window.electronAPI.remoteTerminal.connect(request)

      if (status.hostFingerprint && !profile.hostFingerprint) {
        const accepted = confirm(
          `${t('First connection to {host}:{port}.', {
            host: profile.host,
            port: profile.port || 22,
          })}\n\n` +
            `${t('Verify this SSH host fingerprint with the server administrator:')}\n${status.hostFingerprint}\n\n` +
            t('Trust and save this fingerprint?'),
        )
        if (accepted) {
          const pinnedProfile = { ...profile, hostFingerprint: status.hostFingerprint }
          const saved = await window.electronAPI.remoteTerminal.saveProfile(pinnedProfile)
          if (saved.ok) {
            setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
            status = await window.electronAPI.remoteTerminal.connect(request)
          }
        }
      }

      if (status.state === 'connected' && status.sessionId) {
        if (rememberOnDevice && secret) {
          const savedCredential = await window.electronAPI.remoteTerminal.saveCredential(
            profile.id,
            profile.authType === 'privateKey' ? 'passphrase' : 'password',
            secret,
          )
          if (!savedCredential.ok) {
            setLastMessage(`Connected, but secure credential save failed: ${savedCredential.error}`)
          } else {
            setProtectedProfileIds((current) => new Set(current).add(profile.id))
          }
        }
        setActiveTabId(status.sessionId)
        setActiveSessions((prev) => {
          const next = new Map(prev)
          next.set(status.sessionId, status)
          return next
        })
        setPendingProfileId(null)
        if (rememberForSession && secret) {
          sessionSecretsRef.current[profile.id] = secret
        } else {
          delete sessionSecretsRef.current[profile.id]
        }
        setPassword('')
        setRememberForSession(false)
        setRememberOnDevice(false)
        if (!rememberOnDevice || !secret) setLastMessage('Connected.')
      } else {
        setLastMessage(status.message || 'Connection failed.')
        if (/password|passphrase is required/i.test(status.message || '')) {
          setPendingAction('connect')
          setPendingProfileId(profile.id)
        }
      }
      setConnectingProfileId(null)
    },
    [password, rememberForSession, rememberOnDevice, t],
  )

  const handleTestConnection = useCallback(
    async (profile: RemoteTerminalProfile) => {
      const secret = password || sessionSecretsRef.current[profile.id] || ''
      if (!profile.username?.trim()) {
        setLastMessage('Username is missing. Edit this profile and set username, e.g. root.')
        return
      }

      setTestingProfileId(profile.id)
      setLastMessage(`Testing ${profile.username}@${profile.host}:${profile.port || 22}...`)

      const request = {
        profileId: profile.id,
        password: profile.authType === 'password' ? secret || undefined : undefined,
        passphrase: profile.authType === 'privateKey' ? secret || undefined : undefined,
      }
      let result: RemoteTerminalTestResult =
        await window.electronAPI.remoteTerminal.testConnection(request)

      if (result.hostFingerprint && !profile.hostFingerprint) {
        const accepted = confirm(
          `${t('First connection to {host}:{port}.', {
            host: profile.host,
            port: profile.port || 22,
          })}\n\n` +
            `${t('Verify this SSH host fingerprint with the server administrator:')}\n${result.hostFingerprint}\n\n` +
            t('Trust and save this fingerprint?'),
        )
        if (accepted) {
          const pinnedProfile = { ...profile, hostFingerprint: result.hostFingerprint }
          const saved = await window.electronAPI.remoteTerminal.saveProfile(pinnedProfile)
          if (saved.ok) {
            setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
            result = await window.electronAPI.remoteTerminal.testConnection(request)
          }
        }
      }

      setTestingProfileId(null)
      setLastMessage(
        result.ok
          ? `Test passed in ${result.durationMs} ms. ${result.message}`
          : `Test failed at ${result.stage} after ${result.durationMs} ms. ${result.message}`,
      )
      setTestResults((prev) => ({ ...prev, [profile.id]: result }))
      setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
      if (result.ok) {
        if (rememberOnDevice && secret) {
          const savedCredential = await window.electronAPI.remoteTerminal.saveCredential(
            profile.id,
            profile.authType === 'privateKey' ? 'passphrase' : 'password',
            secret,
          )
          if (!savedCredential.ok) {
            setLastMessage(
              `Test passed, but secure credential save failed: ${savedCredential.error}`,
            )
          } else {
            setProtectedProfileIds((current) => new Set(current).add(profile.id))
          }
        }
        if (rememberForSession && secret) {
          sessionSecretsRef.current[profile.id] = secret
        } else {
          delete sessionSecretsRef.current[profile.id]
        }
        setPendingProfileId(null)
        setPassword('')
        setRememberForSession(false)
        setRememberOnDevice(false)
      } else if (/password|passphrase is required/i.test(result.message)) {
        setPendingAction('test')
        setPendingProfileId(profile.id)
      }
    },
    [password, rememberForSession, rememberOnDevice, t],
  )

  const handleTestAll = useCallback(async () => {
    if (profiles.length === 0 || testingAll) return
    setTestingAll(true)
    setLastMessage('Testing profiles that do not require interactive secrets...')

    let okCount = 0
    let skippedCount = 0
    for (const profile of profiles) {
      const cachedSecret = sessionSecretsRef.current[profile.id]
      const storedCredential = await window.electronAPI.remoteTerminal.credentialStatus(profile.id)
      if (
        (profile.authType === 'password' || profile.authType === 'privateKey') &&
        !cachedSecret &&
        !storedCredential.stored
      ) {
        skippedCount++
        setTestResults((prev) => ({
          ...prev,
          [profile.id]: {
            ok: false,
            profileId: profile.id,
            stage: 'auth',
            durationMs: 0,
            message: 'Skipped: interactive secret required',
          },
        }))
        continue
      }

      setTestingProfileId(profile.id)
      const result = await window.electronAPI.remoteTerminal.testConnection({
        profileId: profile.id,
        password: profile.authType === 'password' ? cachedSecret || undefined : undefined,
        passphrase: profile.authType === 'privateKey' ? cachedSecret || undefined : undefined,
      })
      if (result.ok) okCount++
      setTestResults((prev) => ({ ...prev, [profile.id]: result }))
      setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
    }

    setTestingProfileId(null)
    setTestingAll(false)
    setLastMessage(
      `Batch test finished. Passed ${okCount}, skipped ${skippedCount}, total ${profiles.length}.`,
    )
  }, [profiles, testingAll])

  const handleCollectMetrics = useCallback(
    async (profile: RemoteTerminalProfile) => {
      const secret = password || sessionSecretsRef.current[profile.id] || ''
      if (!profile.username?.trim()) {
        setLastMessage('Username is missing. Edit this profile and set username, e.g. root.')
        return
      }

      setMetricsProfileId(profile.id)
      setLastMessage(`Collecting metrics from ${profile.username}@${profile.host}...`)
      const result = await window.electronAPI.remoteTerminal.collectMetrics({
        profileId: profile.id,
        password: profile.authType === 'password' ? secret || undefined : undefined,
        passphrase: profile.authType === 'privateKey' ? secret || undefined : undefined,
      })
      setMetricsProfileId(null)
      setMetricsResults((prev) => ({ ...prev, [profile.id]: result }))
      setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
      if (result.ok && rememberOnDevice && secret) {
        const savedCredential = await window.electronAPI.remoteTerminal.saveCredential(
          profile.id,
          profile.authType === 'privateKey' ? 'passphrase' : 'password',
          secret,
        )
        if (!savedCredential.ok) {
          setLastMessage(
            `Metrics passed, but secure credential save failed: ${savedCredential.error}`,
          )
        } else {
          setProtectedProfileIds((current) => new Set(current).add(profile.id))
        }
        setRememberOnDevice(false)
        setPassword('')
        setPendingProfileId(null)
      } else if (!result.ok && /password|passphrase is required/i.test(result.error || '')) {
        setPendingAction('metrics')
        setPendingProfileId(profile.id)
      }
      setLastMessage(
        result.ok
          ? `Metrics collected in ${result.durationMs} ms. ${metricSummary(result)}`
          : `Metrics failed after ${result.durationMs} ms. ${result.error || 'unknown error'}`,
      )
    },
    [password, rememberOnDevice],
  )

  const handleCollectAllMetrics = useCallback(async () => {
    if (profiles.length === 0 || collectingAll) return
    setCollectingAll(true)
    setLastMessage('Collecting metrics with concurrency 3...')

    let completed = 0
    let okCount = 0
    let skippedCount = 0
    let cursor = 0
    const concurrency = 3

    const worker = async () => {
      while (cursor < profiles.length) {
        const profile = profiles[cursor++]
        const cachedSecret = sessionSecretsRef.current[profile.id]
        const storedCredential = await window.electronAPI.remoteTerminal.credentialStatus(
          profile.id,
        )
        if (
          (profile.authType === 'password' || profile.authType === 'privateKey') &&
          !cachedSecret &&
          !storedCredential.stored
        ) {
          skippedCount++
          const skipped: RemoteServerMetricsSnapshot = {
            ok: false,
            profileId: profile.id,
            collectedAt: Date.now(),
            durationMs: 0,
            error: 'Skipped: interactive secret required',
          }
          setMetricsResults((prev) => ({ ...prev, [profile.id]: skipped }))
          completed++
          setLastMessage(`Collecting metrics... ${completed}/${profiles.length}`)
          continue
        }

        setMetricsProfileId(profile.id)
        const result = await window.electronAPI.remoteTerminal.collectMetrics({
          profileId: profile.id,
          password: profile.authType === 'password' ? cachedSecret || undefined : undefined,
          passphrase: profile.authType === 'privateKey' ? cachedSecret || undefined : undefined,
        })
        if (result.ok) okCount++
        completed++
        setMetricsResults((prev) => ({ ...prev, [profile.id]: result }))
        setLastMessage(`Collecting metrics... ${completed}/${profiles.length}`)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, profiles.length) }, () => worker()),
    )
    setMetricsProfileId(null)
    setCollectingAll(false)
    setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
    setLastMessage(
      `Metrics collection finished. Passed ${okCount}, skipped ${skippedCount}, total ${profiles.length}.`,
    )
  }, [profiles, collectingAll])

  const handleDisconnect = useCallback(
    async (sessionId: string) => {
      await window.electronAPI.remoteTerminal.disconnect(sessionId)
      setActiveSessions((prev) => {
        const next = new Map(prev)
        next.delete(sessionId)
        if (activeTabId === sessionId) {
          setActiveTabId(next.keys().next().value ?? null)
        }
        return next
      })
    },
    [activeTabId],
  )

  const handleSaveProfile = useCallback(async () => {
    const id = editingProfile?.id || `profile-${Date.now()}`
    const profile: RemoteTerminalProfile = {
      ...editingProfile,
      id,
      name: newName.trim(),
      host: newHost.trim(),
      port: parseInt(newPort, 10) || 22,
      username: newUser.trim(),
      authType: newAuthType,
      privateKeyPath: newAuthType === 'privateKey' ? newKeyPath || undefined : undefined,
      hostFingerprint: newHostFingerprint || undefined,
      tags: editingProfile?.tags || [],
      createdAt: editingProfile?.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    const result = await window.electronAPI.remoteTerminal.saveProfile(profile)
    if (result.ok) {
      setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
      setShowEditor(false)
      setEditingProfile(null)
      setNewName('')
      setNewHost('')
      setNewPort('22')
      setNewHostFingerprint('')
      setNewUser('')
      setNewAuthType('password')
      setNewKeyPath('')
    }
  }, [
    editingProfile,
    newName,
    newHost,
    newPort,
    newUser,
    newAuthType,
    newKeyPath,
    newHostFingerprint,
  ])

  const handleDeleteProfile = useCallback(async (id: string) => {
    await window.electronAPI.remoteTerminal.deleteProfile(id)
    setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
  }, [])

  const handleDeleteCredential = useCallback(
    async (id: string) => {
      const p = profiles.find((prof) => prof.id === id)
      if (!p || !confirm(t('Forget the protected credential for "{name}"?', { name: p.name })))
        return
      const result = await window.electronAPI.remoteTerminal.deleteCredential(id)
      if (result.ok) {
        setProtectedProfileIds((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
        setLastMessage(`Protected credential cleared for ${p.name}.`)
      } else {
        setLastMessage(result.error || 'Credential clear failed.')
      }
    },
    [profiles, t],
  )

  const handleEditProfile = useCallback((p: RemoteTerminalProfile) => {
    setEditingProfile(p)
    setNewName(p.name)
    setNewHost(p.host)
    setNewPort(String(p.port || 22))
    setNewHostFingerprint(p.hostFingerprint || '')
    setNewUser(p.username)
    setNewAuthType(p.authType)
    setNewKeyPath(p.privateKeyPath || '')
    setShowEditor(true)
  }, [])

  const handleDuplicateProfile = useCallback(async (p: RemoteTerminalProfile) => {
    const dup: RemoteTerminalProfile = {
      ...p,
      id: `profile-${Date.now()}`,
      name: `${p.name} (Copy)`,
      tags: [...p.tags],
      lastConnectedAt: undefined,
      lastTest: undefined,
      lastMetrics: undefined,
      credentialRef: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const result = await window.electronAPI.remoteTerminal.saveProfile(dup)
    if (result.ok) {
      setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
      setLastMessage(`Duplicated "${p.name}".`)
    } else {
      setLastMessage(result.error || 'Duplicate failed.')
    }
  }, [])

  // ── Filtered profiles ────────────────────────────────────
  const filteredProfiles = profiles
    .filter((p) => {
      const result = testResults[p.id]
      if (resultFilter === 'ok' && !result?.ok) return false
      if (resultFilter === 'fail' && (!result || result.ok)) return false
      return (
        !searchQuery ||
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    })
    .sort((a, b) => {
      if (sortMode === 'latency') {
        const ar = testResults[a.id]
        const br = testResults[b.id]
        const aRank = ar?.ok ? 0 : ar ? 1 : 2
        const bRank = br?.ok ? 0 : br ? 1 : 2
        if (aRank !== bRank) return aRank - bRank
        const aLatency = ar?.ok ? ar.durationMs : Number.MAX_SAFE_INTEGER
        const bLatency = br?.ok ? br.durationMs : Number.MAX_SAFE_INTEGER
        if (aLatency !== bLatency) return aLatency - bLatency
      }
      if (sortMode === 'lastConnected') {
        const aLast = a.lastConnectedAt || 0
        const bLast = b.lastConnectedAt || 0
        if (aLast !== bLast) return bLast - aLast
      }
      if (sortMode === 'cpu') {
        const av = metricsResults[a.id]?.cpu?.usagePercent ?? -1
        const bv = metricsResults[b.id]?.cpu?.usagePercent ?? -1
        if (av !== bv) return bv - av
      }
      if (sortMode === 'memory') {
        const am = metricsResults[a.id]?.memory
        const bm = metricsResults[b.id]?.memory
        const av = am?.totalBytes ? (am.usedBytes || 0) / am.totalBytes : -1
        const bv = bm?.totalBytes ? (bm.usedBytes || 0) / bm.totalBytes : -1
        if (av !== bv) return bv - av
      }
      if (sortMode === 'disk') {
        const av =
          (
            metricsResults[a.id]?.disks?.find((d) => d.mount === '/') ||
            metricsResults[a.id]?.disks?.[0]
          )?.usedPercent ?? -1
        const bv =
          (
            metricsResults[b.id]?.disks?.find((d) => d.mount === '/') ||
            metricsResults[b.id]?.disks?.[0]
          )?.usedPercent ?? -1
        if (av !== bv) return bv - av
      }
      return a.name.localeCompare(b.name)
    })
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) || profiles[0] || null
  const selectedMetrics = selectedProfile ? metricsResults[selectedProfile.id] : undefined
  const activeStatus = activeTabId ? activeSessions.get(activeTabId) : undefined
  const activeProfile = activeStatus
    ? profiles.find((p) => p.id === activeStatus.profileId) || selectedProfile
    : selectedProfile
  const activeMetrics = activeProfile ? metricsResults[activeProfile.id] : undefined
  const pendingProfile = pendingProfileId
    ? profiles.find((profile) => profile.id === pendingProfileId) || null
    : null

  const runPendingCredentialAction = useCallback(() => {
    if (!pendingProfile) return
    if (pendingAction === 'files') {
      setFilesRefreshToken((value) => value + 1)
    } else if (pendingAction === 'metrics') {
      handleCollectMetrics(pendingProfile)
    } else if (pendingAction === 'test') {
      handleTestConnection(pendingProfile)
    } else {
      handleConnect(pendingProfile)
    }
  }, [handleCollectMetrics, handleConnect, handleTestConnection, pendingAction, pendingProfile])

  const forgetPendingCredential = useCallback(async () => {
    if (!pendingProfileId) return
    delete sessionSecretsRef.current[pendingProfileId]
    const result = await window.electronAPI.remoteTerminal.deleteCredential(pendingProfileId)
    setRememberForSession(false)
    setRememberOnDevice(false)
    setPassword('')
    setProtectedProfileIds((current) => {
      const next = new Set(current)
      next.delete(pendingProfileId)
      return next
    })
    setLastMessage(
      result.ok
        ? t('Session and protected credentials cleared for this profile.')
        : result.error || t('Credential clear failed.'),
    )
  }, [pendingProfileId, t])

  // ── Render ────────────────────────────────────────────────
  return (
    <DraggablePanel
      panelId="remoteTerminal"
      title="Remote Terminal"
      displayTitle={t('Remote source advanced tools')}
      x={terminalPos.x}
      y={terminalPos.y}
      defaultX={180}
      defaultY={180}
      w={terminalSize.w}
      h={terminalSize.h}
      defaultW={DEFAULT_REMOTE_TERMINAL_W}
      defaultH={DEFAULT_REMOTE_TERMINAL_H}
      onMove={handleMove}
      onResize={(w, h) => {
        setTerminalSize(w, h)
        if (activeTabId) {
          setTimeout(() => terminalRefs.current[activeTabId]?.fitAddon.fit(), 50)
        }
      }}
      locked={locked}
      onToggleLock={() => togglePanelLocked('remoteTerminal')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('remoteTerminal')}
    >
      <div
        className="rt-shell"
        style={{
          display: 'flex',
          height: '100%',
          fontSize: 11,
          background: 'transparent',
          boxShadow: 'inset 0 0 0 1px rgba(var(--date), 0.08)',
        }}
      >
        {/* ── Left sidebar: profiles ── */}
        <RemoteTerminalSidebar
          profiles={profiles}
          filteredProfiles={filteredProfiles}
          searchQuery={searchQuery}
          sortMode={sortMode}
          resultFilter={resultFilter}
          showEditor={showEditor}
          selectedProfileId={selectedProfileId}
          testResults={testResults}
          metricsResults={metricsResults}
          protectedProfileIds={protectedProfileIds}
          connectingProfileId={connectingProfileId}
          testingProfileId={testingProfileId}
          metricsProfileId={metricsProfileId}
          pendingProfileId={pendingProfileId}
          pendingAction={pendingAction}
          testingAll={testingAll}
          collectingAll={collectingAll}
          setSearchQuery={setSearchQuery}
          setSortMode={setSortMode}
          setResultFilter={setResultFilter}
          setShowEditor={setShowEditor}
          setSelectedProfileId={setSelectedProfileId}
          setEditingProfile={setEditingProfile}
          setNewName={setNewName}
          setNewHost={setNewHost}
          setNewPort={setNewPort}
          setNewUser={setNewUser}
          setNewAuthType={(v) => setNewAuthType(v)}
          setNewKeyPath={setNewKeyPath}
          handleConnect={handleConnect}
          handleTestConnection={handleTestConnection}
          handleCollectMetrics={handleCollectMetrics}
          handleEditProfile={handleEditProfile}
          handleDeleteProfile={handleDeleteProfile}
          handleDuplicateProfile={handleDuplicateProfile}
          handleTestAll={handleTestAll}
          handleCollectAllMetrics={handleCollectAllMetrics}
          onDeleteCredential={handleDeleteCredential}
        />

        {/* ── Right: terminal area ── */}
        <div
          className="rt-workspace"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            position: 'relative',
          }}
        >
          <button
            className="rt-files-button"
            onClick={() => setShowRemoteFiles(true)}
            disabled={!selectedProfile}
            title={t('Browse remote files over SFTP')}
            style={{ position: 'absolute', right: 5, top: 3, zIndex: 5, fontSize: 9 }}
          >
            {t('Files')}
          </button>
          {showRemoteFiles && selectedProfile && (
            <RemoteFileBrowser
              profile={selectedProfile}
              credential={password || sessionSecretsRef.current[selectedProfile.id]}
              authKind={
                selectedProfile.authType === 'password'
                  ? 'password'
                  : selectedProfile.authType === 'privateKey'
                    ? 'passphrase'
                    : 'none'
              }
              refreshToken={filesRefreshToken}
              onClose={() => setShowRemoteFiles(false)}
              onCredentialRequired={() => {
                setPendingAction('files')
                setPendingProfileId(selectedProfile.id)
                setLastMessage(t('Password/passphrase is required to browse remote files.'))
              }}
              onAuthenticated={async (secret) => {
                if (rememberForSession && secret)
                  sessionSecretsRef.current[selectedProfile.id] = secret
                if (rememberOnDevice && secret) {
                  const saved = await window.electronAPI.remoteTerminal.saveCredential(
                    selectedProfile.id,
                    selectedProfile.authType === 'privateKey' ? 'passphrase' : 'password',
                    secret,
                  )
                  if (saved.ok) {
                    setProtectedProfileIds((current) => new Set(current).add(selectedProfile.id))
                  } else {
                    setLastMessage(saved.error || 'Protected credential save failed.')
                  }
                }
                setPendingProfileId(null)
                setPassword('')
                setRememberForSession(false)
                setRememberOnDevice(false)
              }}
              onProfilesChanged={async () =>
                setProfiles(await window.electronAPI.remoteTerminal.listProfiles())
              }
            />
          )}
          <SessionTabs
            activeSessionId={activeTabId}
            profiles={profiles}
            sessions={activeSessions}
            onCloseSession={handleDisconnect}
            onSelectSession={setActiveTabId}
          />
          <CredentialBar
            busy={Boolean(connectingProfileId || testingProfileId)}
            password={password}
            pendingAction={pendingAction}
            pendingProfile={pendingProfile}
            rememberForSession={rememberForSession}
            rememberOnDevice={rememberOnDevice}
            onForget={forgetPendingCredential}
            onPasswordChange={setPassword}
            onRememberForSessionChange={setRememberForSession}
            onRememberOnDeviceChange={setRememberOnDevice}
            onSubmit={runPendingCredentialAction}
          />

          {/* Terminal container */}
          {activeSessions.size > 0 ? (
            <>
              <SessionOverview
                activeMetrics={activeMetrics}
                activeProfile={activeProfile}
                activeStatus={activeStatus}
                refreshing={Boolean(activeProfile && metricsProfileId === activeProfile.id)}
                onRefresh={() => activeProfile && handleCollectMetrics(activeProfile)}
              />
              <div className="rt-terminal-stage">
                {Array.from(activeSessions.keys()).map((sessionId) => (
                  <div
                    key={sessionId}
                    ref={(node) => {
                      termContainerRefs.current[sessionId] = node
                    }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: activeTabId === sessionId ? 'block' : 'none',
                      overflow: 'hidden',
                    }}
                  />
                ))}
              </div>
            </>
          ) : (
            <div
              className="rt-dashboard-stage"
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                color: 'rgb(var(--date))',
                textAlign: 'center',
                padding: 24,
                background: 'transparent',
              }}
            >
              <ServerDashboard
                profile={selectedProfile}
                metrics={selectedMetrics}
                message={lastMessage}
                onConnect={handleConnect}
                onRefreshMetrics={handleCollectMetrics}
              />
            </div>
          )}

          {/* Status bar */}
          {activeTabId && activeSessions.get(activeTabId) && (
            <div
              className="rt-status-bar"
              style={{
                display: 'flex',
                gap: 8,
                fontSize: 9,
                color: 'rgb(var(--date))',
                padding: '1px 6px',
                borderTop: '1px solid rgba(var(--date), 0.14)',
                background: 'rgba(0,0,0,0.24)',
                flexShrink: 0,
              }}
            >
              <span>{activeSessions.get(activeTabId)!.state}</span>
              {activeSessions.get(activeTabId)!.message && (
                <span>{activeSessions.get(activeTabId)!.message}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Profile editor modal ── */}
      <ProfileEditor
        editingProfile={editingProfile}
        showEditor={showEditor}
        newName={newName}
        newHost={newHost}
        newPort={newPort}
        newUser={newUser}
        newAuthType={newAuthType as 'password' | 'privateKey'}
        newKeyPath={newKeyPath}
        newHostFingerprint={newHostFingerprint}
        setNewName={setNewName}
        setNewHost={setNewHost}
        setNewPort={setNewPort}
        setNewUser={setNewUser}
        setNewAuthType={(v) => setNewAuthType(v)}
        setNewKeyPath={setNewKeyPath}
        setNewHostFingerprint={setNewHostFingerprint}
        setShowEditor={setShowEditor}
        handleSaveProfile={handleSaveProfile}
      />
    </DraggablePanel>
  )
}

export default RemoteTerminalPanel
