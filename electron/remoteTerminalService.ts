import path from 'path'
import { redactDiagnosticError } from './diagnosticRedaction'
import fsp from 'fs/promises'
import type { Client, ConnectConfig } from 'ssh2'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'

// ── Types ───────────────────────────────────────────────────

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
