import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import { normalizeRemotePath } from './remoteSftpService'

const PREFIX = 'sftp-source:v1:'

export interface SftpSourceLocator {
  profileId: string
  hostFingerprint: string
  remoteRoot: string
}

export interface SftpEntryLocator {
  profileId: string
  remotePath: string
}

function validProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value)
}

export function createSftpSourceLocator(
  profile: RemoteTerminalProfile,
  remoteRoot: string,
): string | null {
  const normalizedRoot = normalizeRemotePath(remoteRoot)
  if (
    !validProfileId(profile.id) ||
    !validFingerprint(profile.hostFingerprint) ||
    !normalizedRoot ||
    !normalizedRoot.startsWith('/')
  ) {
    return null
  }
  const payload: SftpSourceLocator = {
    profileId: profile.id,
    hostFingerprint: profile.hostFingerprint,
    remoteRoot: normalizedRoot,
  }
  return `${PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

export function parseSftpSourceLocator(raw: unknown): SftpSourceLocator | null {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 8192) return null
  try {
    const decoded = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'),
    ) as {
      profileId?: unknown
      hostFingerprint?: unknown
      remoteRoot?: unknown
    }
    const remoteRoot = normalizeRemotePath(decoded.remoteRoot)
    if (
      !validProfileId(decoded.profileId) ||
      !validFingerprint(decoded.hostFingerprint) ||
      !remoteRoot ||
      !remoteRoot.startsWith('/')
    ) {
      return null
    }
    return {
      profileId: decoded.profileId,
      hostFingerprint: decoded.hostFingerprint,
      remoteRoot,
    }
  } catch {
    return null
  }
}

export function sftpEntryLocator(profileId: string, remotePath: string): string {
  return `sftp://${encodeURIComponent(profileId)}${remotePath}`
}

export function parseSftpEntryLocator(raw: unknown): SftpEntryLocator | null {
  if (typeof raw !== 'string' || !raw.startsWith('sftp://') || raw.length > 8192) return null
  const encoded = raw.slice('sftp://'.length)
  const pathOffset = encoded.indexOf('/')
  if (pathOffset <= 0) return null
  try {
    const profileId = decodeURIComponent(encoded.slice(0, pathOffset))
    const remotePath = normalizeRemotePath(encoded.slice(pathOffset))
    if (!validProfileId(profileId) || !remotePath || !remotePath.startsWith('/')) return null
    return { profileId, remotePath }
  } catch {
    return null
  }
}

export function isRemotePathWithinRoot(remotePath: string, remoteRoot: string): boolean {
  if (remotePath === remoteRoot) return false
  return remoteRoot === '/' ? remotePath.startsWith('/') : remotePath.startsWith(`${remoteRoot}/`)
}
