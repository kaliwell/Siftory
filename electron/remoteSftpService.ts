import path from 'path'
import { Client, type FileEntryWithStats } from 'ssh2'
import type {
  RemoteDirectoryResult,
  RemoteDirectoryPage,
  RemoteFileEntry,
  RemoteOperationResult,
  RemoteTerminalProfile,
} from '../shared/ipc-contract'
import {
  buildSshConfig,
  hostKeyFailure,
  normalizeSshError,
  prepareAuthConfig,
} from './remoteTerminalService'

const MAX_REMOTE_PATH_LENGTH = 4096
const MAX_DIRECTORY_ENTRIES = 5000

export function normalizeRemotePath(rawPath: unknown): string | null {
  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    rawPath.length > MAX_REMOTE_PATH_LENGTH
  )
    return null
  if (rawPath.includes('\0') || rawPath.includes('\\')) return null
  const normalized = path.posix.normalize(rawPath)
  if (!normalized || normalized.length > MAX_REMOTE_PATH_LENGTH) return null
  return normalized
}

function entryType(entry: FileEntryWithStats): RemoteFileEntry['type'] {
  if (entry.attrs.isDirectory()) return 'directory'
  if (entry.attrs.isFile()) return 'file'
  if (entry.attrs.isSymbolicLink()) return 'symlink'
  return 'other'
}

export function mapRemoteEntry(parentPath: string, entry: FileEntryWithStats): RemoteFileEntry {
  return {
    name: entry.filename,
    path: path.posix.join(parentPath, entry.filename),
    type: entryType(entry),
    size: Number(entry.attrs.size) || 0,
    modifiedAt: entry.attrs.mtime ? entry.attrs.mtime * 1000 : undefined,
    accessedAt: entry.attrs.atime ? entry.attrs.atime * 1000 : undefined,
    mode: entry.attrs.mode,
    uid: entry.attrs.uid,
    gid: entry.attrs.gid,
  }
}

export async function listRemoteDirectory(
  profile: RemoteTerminalProfile,
  request: { profileId: string; remotePath: string; password?: string; passphrase?: string },
): Promise<RemoteDirectoryResult> {
  const remotePath = normalizeRemotePath(request.remotePath)
  const fail = (error: string, hostFingerprint?: string): RemoteDirectoryResult => ({
    ok: false,
    profileId: profile.id,
    path: remotePath || request.remotePath,
    entries: [],
    error,
    hostFingerprint,
  })
  if (!remotePath) return fail('Invalid remote path')
  if (!profile.username?.trim()) return fail('Username is required')

  const client = new Client()
  const { config, hostKeyState } = buildSshConfig(profile)

  const authError = await prepareAuthConfig(client, config, profile, request)
  if (authError) return fail(authError)

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RemoteDirectoryResult) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve(result)
    }

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) {
          finish(fail(`SFTP unavailable: ${sftpError.message}`))
          return
        }
        sftp.readdir(remotePath, (readError, entries) => {
          try {
            sftp.end()
          } catch {
            // Best effort.
          }
          if (readError) {
            finish(fail(`Remote directory read failed: ${readError.message}`))
            return
          }
          if (entries.length > MAX_DIRECTORY_ENTRIES) {
            finish(fail(`Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`))
            return
          }
          const mapped = entries
            .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
            .map((entry) => mapRemoteEntry(remotePath, entry))
            .sort((a, b) => {
              if (a.type === 'directory' && b.type !== 'directory') return -1
              if (a.type !== 'directory' && b.type === 'directory') return 1
              return a.name.localeCompare(b.name, undefined, { numeric: true })
            })
          finish({ ok: true, profileId: profile.id, path: remotePath, entries: mapped })
        })
      })
    })

    client.on('error', (error: Error) => {
      const hostError = hostKeyFailure(hostKeyState)
      finish(
        fail(hostError?.message || normalizeSshError(error.message), hostError?.hostFingerprint),
      )
    })
    client.on('close', () => finish(fail('Connection closed before SFTP completed')))

    try {
      client.connect(config)
    } catch (error) {
      finish(fail(normalizeSshError(error instanceof Error ? error.message : String(error))))
    }
  })
}

// ── Paginated directory listing ──────────────────────────

export async function listRemoteDirectoryPaged(
  profile: RemoteTerminalProfile,
  request: {
    profileId: string
    remotePath: string
    cursor?: string
    password?: string
    passphrase?: string
  },
): Promise<RemoteDirectoryPage> {
  const remotePath = normalizeRemotePath(request.remotePath)
  const fail = (error: string, hostFingerprint?: string): RemoteDirectoryPage => ({
    ok: false,
    profileId: profile.id,
    path: remotePath || request.remotePath,
    entries: [],
    total: 0,
    hasMore: false,
    error,
    hostFingerprint,
  })
  if (!remotePath) return fail('Invalid remote path')
  if (!profile.username?.trim()) return fail('Username is required')

  const offset = Number(request.cursor) || 0
  if (!Number.isSafeInteger(offset) || offset < 0) return fail('Invalid cursor')

  const client = new Client()
  const { config, hostKeyState } = buildSshConfig(profile)

  const authError = await prepareAuthConfig(client, config, profile, request)
  if (authError) return fail(authError)

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RemoteDirectoryPage) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve(result)
    }

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) {
          finish(fail(`SFTP unavailable: ${sftpError.message}`))
          return
        }
        sftp.readdir(remotePath, (readError, entries) => {
          try {
            sftp.end()
          } catch {
            // Best effort.
          }
          if (readError) {
            finish(fail(`Remote directory read failed: ${readError.message}`))
            return
          }
          const PAGE_SIZE = 500
          const filtered = entries.filter(
            (entry) => entry.filename !== '.' && entry.filename !== '..',
          )
          const total = filtered.length
          const slice = filtered.slice(offset, offset + PAGE_SIZE)
          const mapped = slice
            .map((entry) => mapRemoteEntry(remotePath, entry))
            .sort((a, b) => {
              if (a.type === 'directory' && b.type !== 'directory') return -1
              if (a.type !== 'directory' && b.type === 'directory') return 1
              return a.name.localeCompare(b.name, undefined, { numeric: true })
            })
          const nextCursor = offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : undefined
          finish({
            ok: true,
            profileId: profile.id,
            path: remotePath,
            entries: mapped,
            total,
            hasMore: Boolean(nextCursor),
            cursor: nextCursor,
          })
        })
      })
    })

    client.on('error', (error: Error) => {
      const hostError = hostKeyFailure(hostKeyState)
      finish(
        fail(hostError?.message || normalizeSshError(error.message), hostError?.hostFingerprint),
      )
    })
    client.on('close', () => finish(fail('Connection closed before SFTP completed')))

    try {
      client.connect(config)
    } catch (error) {
      finish(fail(normalizeSshError(error instanceof Error ? error.message : String(error))))
    }
  })
}

// ── SFTP mutations ───────────────────────────────────────

const MAX_NAME_LENGTH = 255
const SAFE_NAME_RE = /^[^/\\\0]+$/

function safeRemoteName(rawName: unknown): string | null {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > MAX_NAME_LENGTH)
    return null
  if (!SAFE_NAME_RE.test(rawName)) return null
  return rawName
}

async function withSftpClient<T>(
  profile: RemoteTerminalProfile,
  request: { profileId: string; password?: string; passphrase?: string },
  operation: (
    sftp: import('ssh2').SFTPWrapper,
    fail: (error: string, hostFingerprint?: string | undefined) => void,
    finish: (result: T) => void,
  ) => void,
  resultFactory: (
    ok: boolean,
    profileId: string,
    path: string,
    error?: string,
    hostFingerprint?: string,
  ) => T,
): Promise<T> {
  if (!profile.username?.trim()) {
    return resultFactory(false, profile.id, '', 'Username is required')
  }

  const client = new Client()
  const { config, hostKeyState } = buildSshConfig(profile)

  const authError = await prepareAuthConfig(client, config, profile, request)
  if (authError) return resultFactory(false, profile.id, '', authError)

  return new Promise((resolve) => {
    let settled = false
    const fail = (error: string, hostFingerprint?: string) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve(resultFactory(false, profile.id, '', error, hostFingerprint))
    }
    const finish = (result: T) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // Best effort.
      }
      resolve(result)
    }

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) {
          fail(`SFTP unavailable: ${sftpError.message}`)
          return
        }
        operation(sftp, fail, finish)
      })
    })

    client.on('error', (error: Error) => {
      const hostError = hostKeyFailure(hostKeyState)
      fail(hostError?.message || normalizeSshError(error.message), hostError?.hostFingerprint)
    })
    client.on('close', () => fail('Connection closed before SFTP completed'))

    try {
      client.connect(config)
    } catch (error) {
      fail(normalizeSshError(error instanceof Error ? error.message : String(error)))
    }
  })
}

export async function mkdirRemote(
  profile: RemoteTerminalProfile,
  request: {
    profileId: string
    parentPath: string
    name: string
    password?: string
    passphrase?: string
  },
): Promise<RemoteOperationResult> {
  const parentPath = normalizeRemotePath(request.parentPath)
  const name = safeRemoteName(request.name)
  if (!parentPath) {
    return { ok: false, profileId: profile.id, path: '', error: 'Invalid parent path' }
  }
  if (!name) {
    return { ok: false, profileId: profile.id, path: '', error: 'Invalid folder name' }
  }
  const fullPath = path.posix.join(parentPath, name)

  return withSftpClient(
    profile,
    request,
    (sftp, fail, finish) => {
      sftp.mkdir(fullPath, { mode: 0o755 }, (err) => {
        try {
          sftp.end()
        } catch {
          // Best effort.
        }
        if (err) {
          finish({
            ok: false,
            profileId: profile.id,
            path: fullPath,
            error: err.message,
          })
          return
        }
        finish({ ok: true, profileId: profile.id, path: fullPath })
      })
    },
    (ok, profileId, path, error, hostFingerprint) => ({
      ok,
      profileId,
      path,
      error,
      hostFingerprint,
    }),
  )
}

export async function renameRemote(
  profile: RemoteTerminalProfile,
  request: {
    profileId: string
    oldPath: string
    newName: string
    password?: string
    passphrase?: string
  },
): Promise<RemoteOperationResult> {
  const oldPath = normalizeRemotePath(request.oldPath)
  const newName = safeRemoteName(request.newName)
  if (!oldPath) {
    return { ok: false, profileId: profile.id, path: '', error: 'Invalid source path' }
  }
  if (!newName) {
    return { ok: false, profileId: profile.id, path: '', error: 'Invalid new name' }
  }
  const newPath = path.posix.join(path.posix.dirname(oldPath), newName)

  return withSftpClient(
    profile,
    request,
    (sftp, fail, finish) => {
      sftp.rename(oldPath, newPath, (err) => {
        try {
          sftp.end()
        } catch {
          // Best effort.
        }
        if (err) {
          finish({
            ok: false,
            profileId: profile.id,
            path: oldPath,
            error: err.message,
          })
          return
        }
        finish({ ok: true, profileId: profile.id, path: newPath })
      })
    },
    (ok, profileId, path, error, hostFingerprint) => ({
      ok,
      profileId,
      path,
      error,
      hostFingerprint,
    }),
  )
}

export async function removeRemote(
  profile: RemoteTerminalProfile,
  request: {
    profileId: string
    remotePath: string
    password?: string
    passphrase?: string
  },
): Promise<RemoteOperationResult> {
  const remotePath = normalizeRemotePath(request.remotePath)
  if (!remotePath) {
    return { ok: false, profileId: profile.id, path: '', error: 'Invalid path' }
  }
  // Reject deletion of dangerous paths
  if (
    remotePath === '/' ||
    remotePath === '/home' ||
    remotePath === '/root' ||
    remotePath === '.'
  ) {
    return {
      ok: false,
      profileId: profile.id,
      path: remotePath,
      error: 'Deleting system directories is not allowed through this interface.',
    }
  }

  return withSftpClient(
    profile,
    request,
    (sftp, fail, finish) => {
      // Try rmdir first, fall back to unlink
      sftp.rmdir(remotePath, (rmdirErr) => {
        if (!rmdirErr) {
          try {
            sftp.end()
          } catch {
            // Best effort.
          }
          finish({ ok: true, profileId: profile.id, path: remotePath })
          return
        }
        sftp.unlink(remotePath, (unlinkErr) => {
          try {
            sftp.end()
          } catch {
            // Best effort.
          }
          if (unlinkErr) {
            finish({
              ok: false,
              profileId: profile.id,
              path: remotePath,
              error: `Cannot remove: ${rmdirErr.message}; ${unlinkErr.message}`,
            })
            return
          }
          finish({ ok: true, profileId: profile.id, path: remotePath })
        })
      })
    },
    (ok, profileId, path, error, hostFingerprint) => ({
      ok,
      profileId,
      path,
      error,
      hostFingerprint,
    }),
  )
}
