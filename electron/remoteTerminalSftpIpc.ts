import { secureIpcMain } from './ipcAuthorization'
import { listProfiles } from './remoteTerminalService'
import {
  listRemoteDirectory,
  listRemoteDirectoryPaged,
  mkdirRemote,
  removeRemote,
  renameRemote,
} from './remoteSftpService'
import { normalizeCredentialFields, resolveStoredCredential } from './remoteTerminalCredential'

export function registerRemoteTerminalSftpIpc(
  userDataPath: string,
  profilesReady: Promise<void> = Promise.resolve(),
): void {
  secureIpcMain.handle(
    'remoteTerminal:listRemoteDirectory',
    async (_event, profileId: unknown, remotePath: unknown, credential: unknown) => {
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        typeof remotePath !== 'string' ||
        remotePath.length > 4096 ||
        !credentialFields
      ) {
        return {
          ok: false,
          profileId: typeof profileId === 'string' ? profileId : '',
          path: typeof remotePath === 'string' ? remotePath : '',
          entries: [],
          error: 'Invalid SFTP request',
        }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) {
        return { ok: false, profileId, path: remotePath, entries: [], error: 'Profile not found' }
      }
      const request = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        remotePath,
        ...credentialFields,
      })
      return listRemoteDirectory(profile, request)
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:listRemoteDirectoryPaged',
    async (
      _event,
      profileId: unknown,
      remotePath: unknown,
      cursor: unknown,
      credential: unknown,
    ) => {
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        typeof remotePath !== 'string' ||
        remotePath.length > 4096 ||
        !credentialFields
      ) {
        return {
          ok: false,
          profileId: typeof profileId === 'string' ? profileId : '',
          path: typeof remotePath === 'string' ? remotePath : '',
          entries: [],
          total: 0,
          hasMore: false,
          error: 'Invalid paginated SFTP request',
        }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) {
        return {
          ok: false,
          profileId,
          path: remotePath,
          entries: [],
          total: 0,
          hasMore: false,
          error: 'Profile not found',
        }
      }
      const request = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        remotePath,
        cursor: typeof cursor === 'string' ? cursor : undefined,
        ...credentialFields,
      })
      return listRemoteDirectoryPaged(profile, request)
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:mkdirRemote',
    async (_event, profileId: unknown, parentPath: unknown, name: unknown, credential: unknown) => {
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        typeof parentPath !== 'string' ||
        parentPath.length > 4096 ||
        typeof name !== 'string' ||
        name.length > 255 ||
        !credentialFields
      ) {
        return { ok: false, profileId: '', path: '', error: 'Invalid mkdir request' }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) return { ok: false, profileId, path: '', error: 'Profile not found' }
      const request = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        parentPath,
        name,
        ...credentialFields,
      })
      return mkdirRemote(profile, request)
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:renameRemote',
    async (_event, profileId: unknown, oldPath: unknown, newName: unknown, credential: unknown) => {
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        typeof oldPath !== 'string' ||
        oldPath.length > 4096 ||
        typeof newName !== 'string' ||
        newName.length > 255 ||
        !credentialFields
      ) {
        return { ok: false, profileId: '', path: '', error: 'Invalid rename request' }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) return { ok: false, profileId, path: '', error: 'Profile not found' }
      const request = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        oldPath,
        newName,
        ...credentialFields,
      })
      return renameRemote(profile, request)
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:removeRemote',
    async (_event, profileId: unknown, remotePath: unknown, credential: unknown) => {
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        typeof remotePath !== 'string' ||
        remotePath.length > 4096 ||
        !credentialFields
      ) {
        return { ok: false, profileId: '', path: '', error: 'Invalid remove request' }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) return { ok: false, profileId, path: '', error: 'Profile not found' }
      const request = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        remotePath,
        ...credentialFields,
      })
      return removeRemote(profile, request)
    },
  )
}
