import path from 'path'
import { redactDiagnosticError } from './diagnosticRedaction'
import fsp from 'fs/promises'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { METRICS_SCRIPT } from './metricsScript'
import type {
  RemoteTerminalProfile,
  RemoteTerminalConnectRequest,
  RemoteTerminalSessionStatus,
  RemoteTerminalTestRequest,
  RemoteTerminalTestResult,
  RemoteServerMetricsRequest,
  RemoteServerMetricsSnapshot,
} from '../shared/ipc-contract'

// ── Types ───────────────────────────────────────────────────

interface ActiveSession {
  sessionId: string
  profileId: string
  client: Client
  stream: ClientChannel | null
  status: RemoteTerminalSessionStatus
}

type DataCallback = (event: { sessionId: string; data: string }) => void
type StatusCallback = (status: RemoteTerminalSessionStatus) => void
type SensitiveRemoteTerminalProfile = RemoteTerminalProfile & {
  password?: string
  passphrase?: string
}
type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  instructionsLang: string,
  prompts: { prompt: string; echo: boolean }[],
  finish: (responses: string[]) => void,
) => void
type KeyboardInteractiveClient = Client & {
  on(event: 'keyboard-interactive', listener: KeyboardInteractiveHandler): Client
}

function errorMessage(err: unknown): string {
  return redactDiagnosticError(err)
}

function isRemoteTerminalProfile(value: unknown): value is RemoteTerminalProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<RemoteTerminalProfile>
  return (
    typeof profile.id === 'string' &&
    typeof profile.name === 'string' &&
    typeof profile.host === 'string'
  )
}

const REMOTE_PROFILE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const REMOTE_PROFILE_HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/
const SSH_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{32,64}$/

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || trimmed.includes('\0')) return null
  return trimmed
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value == null || value === '') return undefined
  return cleanText(value, maxLength) ?? undefined
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const tag = cleanText(item, 48)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= 16) break
  }
  return out
}

export function normalizeRemoteTerminalProfile(
  raw: unknown,
  previous?: RemoteTerminalProfile,
): { ok: true; profile: RemoteTerminalProfile } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid profile' }
  const input = raw as Partial<RemoteTerminalProfile> & {
    password?: unknown
    passphrase?: unknown
  }
  const id = cleanText(input.id, 128)
  const name = cleanText(input.name, 128)
  const host = cleanText(input.host, 253)
  const username = cleanText(input.username, 128)
  if (!id || !REMOTE_PROFILE_ID_PATTERN.test(id)) {
    return { ok: false, error: 'Invalid profile id' }
  }
  if (!name) return { ok: false, error: 'Profile name is required' }
  if (!host || !REMOTE_PROFILE_HOST_PATTERN.test(host)) {
    return { ok: false, error: 'Invalid host' }
  }
  if (!username) return { ok: false, error: 'Username is required' }
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535' }
  }
  const authType =
    input.authType === 'privateKey' || input.authType === 'agent' || input.authType === 'password'
      ? input.authType
      : null
  if (!authType) return { ok: false, error: 'Invalid auth type' }
  const privateKeyPath = cleanOptionalText(input.privateKeyPath, 1024)
  if (authType === 'privateKey' && !privateKeyPath) {
    return { ok: false, error: 'Private key path is required' }
  }
  const hostFingerprint = cleanOptionalText(input.hostFingerprint, 96)
  if (hostFingerprint && !SSH_FINGERPRINT_PATTERN.test(hostFingerprint)) {
    return { ok: false, error: 'Invalid host fingerprint' }
  }
  const now = Date.now()
  return {
    ok: true,
    profile: {
      id,
      name,
      host,
      port,
      username,
      authType,
      ...(privateKeyPath ? { privateKeyPath: path.normalize(privateKeyPath) } : {}),
      ...(hostFingerprint ? { hostFingerprint } : {}),
      tags: cleanTags(input.tags),
      ...(cleanOptionalText(input.group, 96) ? { group: cleanOptionalText(input.group, 96) } : {}),
      ...(typeof input.lastConnectedAt === 'number' && Number.isFinite(input.lastConnectedAt)
        ? { lastConnectedAt: input.lastConnectedAt }
        : {}),
      ...(input.lastTest ? { lastTest: input.lastTest } : {}),
      ...(input.lastMetrics ? { lastMetrics: input.lastMetrics } : {}),
      createdAt:
        previous?.createdAt ?? (Number.isFinite(input.createdAt) ? Number(input.createdAt) : now),
      updatedAt: now,
      credentialMode:
        input.credentialMode === 'session' ||
        input.credentialMode === 'os' ||
        input.credentialMode === 'portableVault'
          ? input.credentialMode
          : 'none',
      ...(cleanOptionalText(input.credentialRef, 256)
        ? { credentialRef: cleanOptionalText(input.credentialRef, 256) }
        : {}),
    },
  }
}

export interface HostKeyState {
  observed?: string
  mismatch: boolean
}

export function formatHostFingerprint(sha256Hex: string): string {
  if (!/^[a-f\d]{64}$/i.test(sha256Hex)) return ''
  return `SHA256:${Buffer.from(sha256Hex, 'hex').toString('base64').replace(/=+$/, '')}`
}

export function verifyHostFingerprint(
  expected: string | undefined,
  sha256Hex: string,
): { accepted: boolean; fingerprint: string; mismatch: boolean } {
  const fingerprint = formatHostFingerprint(sha256Hex)
  const normalizedExpected = expected?.trim()
  return {
    accepted: Boolean(fingerprint && normalizedExpected && fingerprint === normalizedExpected),
    fingerprint,
    mismatch: Boolean(fingerprint && normalizedExpected && fingerprint !== normalizedExpected),
  }
}

export function attachHostVerification(
  config: ConnectConfig,
  profile: RemoteTerminalProfile,
  state: HostKeyState,
): void {
  config.hostHash = 'sha256'
  config.hostVerifier = (sha256Hex: string) => {
    const result = verifyHostFingerprint(profile.hostFingerprint, sha256Hex)
    state.observed = result.fingerprint
    state.mismatch = result.mismatch
    return result.accepted
  }
}

export function hostKeyFailure(
  state: HostKeyState,
): { message: string; hostFingerprint?: string } | null {
  if (!state.observed) return null
  if (state.mismatch) {
    return {
      message: `SSH host key changed. Expected the saved fingerprint, received ${state.observed}. Connection blocked.`,
      hostFingerprint: state.observed,
    }
  }
  return {
    message: `Unknown SSH host key. Verify this fingerprint with the server administrator: ${state.observed}`,
    hostFingerprint: state.observed,
  }
}

// ── Shared SSH config builder ──────────────────────────────

export interface SshConnectionOptions {
  readyTimeout?: number
  keepaliveInterval?: number
}

/** Build a ConnectConfig with host verification attached.
 *  Returns the config and hostKeyState so callers can inspect
 *  host-key outcomes (unknown / changed) in error handlers. */
export function buildSshConfig(
  profile: RemoteTerminalProfile,
  opts: SshConnectionOptions = {},
): { config: ConnectConfig; hostKeyState: HostKeyState } {
  const hostKeyState: HostKeyState = { mismatch: false }
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port || 22,
    username: profile.username.trim(),
    readyTimeout: opts.readyTimeout ?? 15000,
    keepaliveInterval: opts.keepaliveInterval ?? 30000,
  }
  attachHostVerification(config, profile, hostKeyState)
  return { config, hostKeyState }
}

// ── Profile storage ────────────────────────────────────────

let _profiles: RemoteTerminalProfile[] = []
let _profilesWriteQueue: Promise<void> = Promise.resolve()

function getProfilesPath(userDataPath: string): string {
  return path.join(userDataPath, 'remote-terminal-profiles.json')
}

export async function loadProfiles(userDataPath: string): Promise<void> {
  try {
    const raw = await fsp.readFile(getProfilesPath(userDataPath), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      _profiles = parsed.filter(isRemoteTerminalProfile)
    }
  } catch {
    _profiles = []
  }
}

async function saveProfilesToDisk(userDataPath: string): Promise<void> {
  const profilesPath = getProfilesPath(userDataPath)
  const temporaryPath = `${profilesPath}.tmp`
  const snapshot = JSON.stringify(_profiles, null, 2)
  const writeSnapshot = async () => {
    await fsp.writeFile(temporaryPath, snapshot, 'utf-8')
    await fsp.rename(temporaryPath, profilesPath)
  }
  const operation = _profilesWriteQueue.then(writeSnapshot, writeSnapshot)
  _profilesWriteQueue = operation.catch(() => undefined)
  await operation
}

export function listProfiles(): RemoteTerminalProfile[] {
  return [..._profiles]
}

export async function saveProfile(
  userDataPath: string,
  profile: RemoteTerminalProfile,
): Promise<{ ok: boolean; error?: string }> {
  const existing = _profiles.findIndex((p) => p.id === profile.id)
  const normalized = normalizeRemoteTerminalProfile(
    profile,
    existing >= 0 ? _profiles[existing] : undefined,
  )
  if (!normalized.ok) return { ok: false, error: normalized.error }
  const entry: SensitiveRemoteTerminalProfile = {
    ...normalized.profile,
  }
  delete entry.password
  delete entry.passphrase

  if (existing >= 0) {
    _profiles[existing] = entry
  } else {
    _profiles.push(entry)
  }
  try {
    await saveProfilesToDisk(userDataPath)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteProfile(
  userDataPath: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const idx = _profiles.findIndex((p) => p.id === id)
  if (idx < 0) return { ok: false, error: 'Profile not found' }
  _profiles.splice(idx, 1)
  try {
    await saveProfilesToDisk(userDataPath)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── SSH session management ─────────────────────────────────

const sessions = new Map<string, ActiveSession>()
let _dataCallback: DataCallback | null = null
let _statusCallback: StatusCallback | null = null

let _sessionCounter = 0

function nextSessionId(): string {
  _sessionCounter++
  return `term-${Date.now()}-${_sessionCounter}`
}

export function setDataCallback(cb: DataCallback): void {
  _dataCallback = cb
}

export function setStatusCallback(cb: StatusCallback): void {
  _statusCallback = cb
}

function emitStatus(status: RemoteTerminalSessionStatus): void {
  _statusCallback?.(status)
}

function emitData(sessionId: string, data: string): void {
  _dataCallback?.({ sessionId, data })
}

function attachKeyboardInteractivePassword(client: Client, password: string): void {
  ;(client as KeyboardInteractiveClient).on(
    'keyboard-interactive',
    (
      _name: string,
      _instructions: string,
      _instructionsLang: string,
      prompts: { prompt: string; echo: boolean }[],
      finish: (responses: string[]) => void,
    ) => {
      finish(prompts.map(() => password))
    },
  )
}

export async function connect(
  profile: RemoteTerminalProfile,
  req: RemoteTerminalConnectRequest,
): Promise<RemoteTerminalSessionStatus> {
  const sessionId = nextSessionId()

  if (!profile.username?.trim()) {
    return {
      sessionId,
      profileId: req.profileId,
      state: 'error',
      message: 'Username is required. Edit the profile and set username, e.g. root.',
    }
  }

  const client = new Client()

  const status: RemoteTerminalSessionStatus = {
    sessionId,
    profileId: req.profileId,
    state: 'connecting',
  }

  const session: ActiveSession = {
    sessionId,
    profileId: req.profileId,
    client,
    stream: null,
    status,
  }

  sessions.set(sessionId, session)
  emitStatus({ ...status })

  return new Promise((resolve) => {
    let settled = false
    const finish = (next: RemoteTerminalSessionStatus) => {
      if (settled) return
      settled = true
      resolve({ ...next })
    }

    const { config, hostKeyState } = buildSshConfig(profile)

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: req.cols, rows: req.rows }, (err, stream) => {
        if (err) {
          status.state = 'error'
          status.message = `Shell error: ${err.message}`
          session.status = status
          emitStatus({ ...status })
          cleanupSession(sessionId)
          finish(status)
          return
        }

        session.stream = stream
        status.state = 'connected'
        status.connectedAt = Date.now()
        status.message = 'Connected'
        session.status = status
        emitStatus({ ...status })

        stream.on('data', (data: Buffer) => {
          emitData(sessionId, data.toString('utf-8'))
        })

        stream.on('close', () => {
          if (session.status.state === 'connected') {
            status.state = 'disconnected'
            status.disconnectedAt = Date.now()
            status.message = 'Remote shell closed'
            session.status = status
            emitStatus({ ...status })
          }
          session.stream = null
          cleanupSession(sessionId)
        })

        stream.on('error', (e: Error) => {
          status.state = 'error'
          status.message = e.message
          session.status = status
          emitStatus({ ...status })
        })

        finish(status)
      })
    })

    client.on('error', (err: Error) => {
      const hostKeyError = hostKeyFailure(hostKeyState)
      status.state = 'error'
      status.message = hostKeyError?.message || normalizeSshError(err.message)
      status.hostFingerprint = hostKeyError?.hostFingerprint
      session.status = status
      emitStatus({ ...status })
      finish(status)
      cleanupSession(sessionId)
    })

    client.on('close', () => {
      if (status.state === 'connecting') {
        status.state = 'error'
        status.message = 'Connection closed before ready'
        session.status = status
        emitStatus({ ...status })
        finish(status)
      }
      cleanupSession(sessionId)
    })

    const startConnect = async () => {
      if (profile.authType === 'password') {
        if (!req.password) {
          status.state = 'error'
          status.message = 'Password is required'
          session.status = status
          emitStatus({ ...status })
          cleanupSession(sessionId)
          finish(status)
          return
        }
        config.password = req.password
        config.tryKeyboard = true
        attachKeyboardInteractivePassword(client, req.password)
      } else if (profile.authType === 'privateKey') {
        if (!profile.privateKeyPath) {
          status.state = 'error'
          status.message = 'Private key path is required'
          session.status = status
          emitStatus({ ...status })
          cleanupSession(sessionId)
          finish(status)
          return
        }
        try {
          config.privateKey = await fsp.readFile(path.normalize(profile.privateKeyPath), 'utf8')
        } catch (e: unknown) {
          status.state = 'error'
          status.message = `Private key read failed: ${errorMessage(e)}`
          session.status = status
          emitStatus({ ...status })
          cleanupSession(sessionId)
          finish(status)
          return
        }
        if (req.passphrase) config.passphrase = req.passphrase
      } else if (profile.authType === 'agent') {
        config.agent = process.env.SSH_AUTH_SOCK
      }

      try {
        client.connect(config)
      } catch (e: unknown) {
        status.state = 'error'
        status.message = normalizeSshError(errorMessage(e))
        session.status = status
        emitStatus({ ...status })
        cleanupSession(sessionId)
        finish(status)
      }
    }

    startConnect()
  })
}

export async function testConnection(
  profile: RemoteTerminalProfile,
  req: RemoteTerminalTestRequest,
): Promise<RemoteTerminalTestResult> {
  const startedAt = Date.now()
  const client = new Client()

  if (!profile.username?.trim()) {
    return {
      ok: false,
      profileId: req.profileId,
      stage: 'profile',
      durationMs: Date.now() - startedAt,
      message: 'Username is required. Edit the profile and set username, e.g. root.',
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: Omit<RemoteTerminalTestResult, 'durationMs'>) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve({ ...result, durationMs: Date.now() - startedAt })
    }

    const { config, hostKeyState } = buildSshConfig(profile, {
      readyTimeout: 10000,
      keepaliveInterval: 0,
    })

    client.on('ready', () => {
      finish({
        ok: true,
        profileId: req.profileId,
        stage: 'ready',
        message: `SSH auth ok: ${profile.username}@${profile.host}:${profile.port || 22}`,
      })
    })

    client.on('error', (err: Error) => {
      const hostKeyError = hostKeyFailure(hostKeyState)
      finish({
        ok: false,
        profileId: req.profileId,
        stage: hostKeyError ? 'host-key' : 'auth',
        message: hostKeyError?.message || normalizeSshError(err.message),
        hostFingerprint: hostKeyError?.hostFingerprint,
      })
    })

    client.on('close', () => {
      finish({
        ok: false,
        profileId: req.profileId,
        stage: 'auth',
        message: 'Connection closed before authentication completed.',
      })
    })

    prepareAuthConfig(client, config, profile, req)
      .then((authError) => {
        if (authError) {
          finish({
            ok: false,
            profileId: req.profileId,
            stage: 'auth',
            message: authError,
          })
          return
        }
        try {
          client.connect(config)
        } catch (e: unknown) {
          finish({
            ok: false,
            profileId: req.profileId,
            stage: 'auth',
            message: normalizeSshError(errorMessage(e)),
          })
        }
      })
      .catch((e: unknown) => {
        finish({
          ok: false,
          profileId: req.profileId,
          stage: 'auth',
          message: errorMessage(e),
        })
      })
  })
}

export async function collectMetrics(
  profile: RemoteTerminalProfile,
  req: RemoteServerMetricsRequest,
): Promise<RemoteServerMetricsSnapshot> {
  const startedAt = Date.now()
  const client = new Client()

  const fail = (error: string): RemoteServerMetricsSnapshot => ({
    ok: false,
    profileId: req.profileId,
    collectedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    error,
  })

  if (!profile.username?.trim()) {
    return fail('Username is required. Edit the profile and set username, e.g. root.')
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RemoteServerMetricsSnapshot) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve(result)
    }

    const { config, hostKeyState } = buildSshConfig(profile, {
      readyTimeout: 10000,
      keepaliveInterval: 0,
    })

    client.on('ready', () => {
      client.exec(METRICS_SCRIPT, { pty: false }, (err, stream) => {
        if (err) {
          finish(fail(`Metrics exec failed: ${err.message}`))
          return
        }

        let stdout = ''
        let stderr = ''
        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf8')
        })
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8')
        })
        stream.on('close', (code: number | null) => {
          if (code !== 0) {
            finish(fail(stderr.trim() || `Metrics command exited with code ${code}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout.trim())
            finish({
              ok: true,
              profileId: req.profileId,
              collectedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              ...parsed,
            })
          } catch (e: unknown) {
            finish(fail(`Metrics parse failed: ${errorMessage(e)}`))
          }
        })
      })
    })

    client.on('error', (err: Error) => {
      const hostKeyError = hostKeyFailure(hostKeyState)
      finish(fail(hostKeyError?.message || normalizeSshError(err.message)))
    })

    client.on('close', () => {
      finish(fail('Connection closed before metrics collection completed.'))
    })

    prepareAuthConfig(client, config, profile, req)
      .then((authError) => {
        if (authError) {
          finish(fail(authError))
          return
        }
        try {
          client.connect(config)
        } catch (e: unknown) {
          finish(fail(normalizeSshError(errorMessage(e))))
        }
      })
      .catch((e: unknown) => {
        finish(fail(errorMessage(e)))
      })
  })
}

export async function prepareAuthConfig(
  client: Client,
  config: ConnectConfig,
  profile: RemoteTerminalProfile,
  req: { password?: string; passphrase?: string },
): Promise<string | null> {
  if (profile.authType === 'password') {
    if (!req.password) return 'Password is required'
    config.password = req.password
    config.tryKeyboard = true
    attachKeyboardInteractivePassword(client, req.password)
    return null
  }

  if (profile.authType === 'agent') {
    config.agent = process.env.SSH_AUTH_SOCK
    if (!config.agent) return 'SSH agent is not available'
    return null
  }

  if (profile.authType === 'privateKey') {
    if (!profile.privateKeyPath) return 'Private key path is required'
    try {
      config.privateKey = await fsp.readFile(path.normalize(profile.privateKeyPath), 'utf8')
    } catch (e: unknown) {
      return `Private key read failed: ${errorMessage(e)}`
    }
    if (req.passphrase) config.passphrase = req.passphrase
    return null
  }

  return null
}

export function normalizeSshError(message: string): string {
  if (/All configured authentication methods failed/i.test(message)) {
    return 'Authentication failed: check username, password/private key, and server auth policy.'
  }
  if (/Timed out while waiting for handshake/i.test(message)) {
    return 'Connection timed out while waiting for SSH handshake.'
  }
  return message
}

export function write(sessionId: string, data: string): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId)
  if (!session || !session.stream) {
    return { ok: false, error: 'Session not found or not connected' }
  }
  try {
    session.stream.write(data)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: errorMessage(e) }
  }
}

export function resize(
  sessionId: string,
  cols: number,
  rows: number,
): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId)
  if (!session || !session.stream) {
    return { ok: false, error: 'Session not found or not connected' }
  }
  try {
    session.stream.setWindow(rows, cols, 0, 0)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: errorMessage(e) }
  }
}

export function disconnect(sessionId: string): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Session not found' }

  if (session.stream) {
    try {
      session.stream.end()
    } catch {
      // Best effort
    }
  }
  try {
    session.client.end()
  } catch {
    // Best effort
  }

  cleanupSession(sessionId)
  return { ok: true }
}

function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
}

export function disconnectAll(): void {
  for (const [id] of sessions) {
    disconnect(id)
  }
}

export function getSessionStatus(sessionId: string): RemoteTerminalSessionStatus | null {
  const session = sessions.get(sessionId)
  return session ? { ...session.status } : null
}
