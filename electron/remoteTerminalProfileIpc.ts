import { secureIpcMain } from './ipcAuthorization'
import { deleteProfile, listProfiles, saveProfile } from './remoteTerminalService'
import { credentialStatus, deleteCredential, saveCredential } from './remoteCredentialService'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'

export function registerRemoteTerminalProfileIpc(
  userDataPath: string,
  profilesReady: Promise<void> = Promise.resolve(),
): void {
  secureIpcMain.handle('remoteTerminal:listProfiles', async () => {
    await profilesReady
    return listProfiles()
  })

  secureIpcMain.handle(
    'remoteTerminal:saveProfile',
    async (_event, profile: RemoteTerminalProfile) => {
      await profilesReady
      return saveProfile(userDataPath, profile)
    },
  )

  secureIpcMain.handle('remoteTerminal:deleteProfile', async (_event, id: string) => {
    await profilesReady
    const result = await deleteProfile(userDataPath, id)
    if (result.ok) await deleteCredential(userDataPath, id)
    return result
  })

  secureIpcMain.handle('remoteTerminal:credentialStatus', async (_event, profileId: unknown) => {
    await profilesReady
    if (typeof profileId !== 'string' || !profileId || profileId.length > 256) {
      return { available: false, stored: false }
    }
    return credentialStatus(userDataPath, profileId)
  })

  secureIpcMain.handle(
    'remoteTerminal:saveCredential',
    async (_event, profileId: unknown, kind: unknown, secret: unknown) => {
      await profilesReady
      if (
        typeof profileId !== 'string' ||
        !profileId ||
        profileId.length > 256 ||
        (kind !== 'password' && kind !== 'passphrase') ||
        typeof secret !== 'string' ||
        !secret ||
        secret.length > 65536
      ) {
        return { ok: false, error: 'Invalid credential request' }
      }
      const profile = listProfiles().find((item) => item.id === profileId)
      const expectedKind = profile?.authType === 'privateKey' ? 'passphrase' : 'password'
      if (!profile || profile.authType === 'agent' || kind !== expectedKind) {
        return { ok: false, error: 'Credential type does not match the profile' }
      }
      return saveCredential(userDataPath, profileId, kind, secret)
    },
  )

  secureIpcMain.handle('remoteTerminal:deleteCredential', async (_event, profileId: unknown) => {
    await profilesReady
    if (typeof profileId !== 'string' || !profileId || profileId.length > 256) {
      return { ok: false, error: 'Invalid profile id' }
    }
    return deleteCredential(userDataPath, profileId)
  })
}
