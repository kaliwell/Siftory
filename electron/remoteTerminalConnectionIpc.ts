import { secureIpcMain } from './ipcAuthorization'
import { BrowserWindow } from 'electron'
import {
  collectMetrics,
  connect,
  disconnect,
  listProfiles,
  resize,
  saveProfile,
  setDataCallback,
  setStatusCallback,
  testConnection,
  write,
} from './remoteTerminalService'
import { normalizeCredentialRequest, resolveStoredCredential } from './remoteTerminalCredential'

type GetMainWindow = () => BrowserWindow | null

export function registerRemoteTerminalConnectionIpc(
  getMainWindow: GetMainWindow,
  userDataPath: string,
  profilesReady: Promise<void> = Promise.resolve(),
): void {
  secureIpcMain.handle('remoteTerminal:connect', async (_event, rawReq: unknown) => {
    const baseRequest = normalizeCredentialRequest(rawReq)
    const value =
      typeof rawReq === 'object' && rawReq !== null ? (rawReq as Record<string, unknown>) : null
    const cols = value?.cols
    const rows = value?.rows
    if (
      !baseRequest ||
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      Number(cols) < 1 ||
      Number(cols) > 1000 ||
      Number(rows) < 1 ||
      Number(rows) > 1000
    ) {
      return {
        sessionId: '',
        profileId: baseRequest?.profileId || '',
        state: 'error',
        message: 'Invalid connect request',
      }
    }
    const req = { ...baseRequest, cols: Number(cols), rows: Number(rows) }
    await profilesReady
    const profiles = listProfiles()
    const profile = profiles.find((p: { id: string }) => p.id === req.profileId)
    if (!profile) {
      return {
        sessionId: '',
        profileId: req.profileId,
        state: 'error' as const,
        message: 'Profile not found',
      }
    }
    const status = await connect(profile, await resolveStoredCredential(userDataPath, profile, req))
    if (status.state === 'connected') {
      await saveProfile(userDataPath, { ...profile, lastConnectedAt: Date.now() })
    }
    return status
  })

  secureIpcMain.handle('remoteTerminal:testConnection', async (_event, rawReq: unknown) => {
    const req = normalizeCredentialRequest(rawReq)
    if (!req) {
      return {
        ok: false,
        profileId: '',
        stage: 'profile',
        durationMs: 0,
        message: 'Invalid test request',
      }
    }
    await profilesReady
    const profiles = listProfiles()
    const profile = profiles.find((p: { id: string }) => p.id === req.profileId)
    if (!profile) {
      return {
        ok: false,
        profileId: req.profileId,
        stage: 'profile' as const,
        durationMs: 0,
        message: 'Profile not found',
      }
    }
    const result = await testConnection(
      profile,
      await resolveStoredCredential(userDataPath, profile, req),
    )
    await saveProfile(userDataPath, {
      ...profile,
      lastTest: {
        ok: result.ok,
        stage: result.stage,
        durationMs: result.durationMs,
        message: result.message,
        testedAt: Date.now(),
      },
    })
    return result
  })

  secureIpcMain.handle('remoteTerminal:collectMetrics', async (_event, rawReq: unknown) => {
    const req = normalizeCredentialRequest(rawReq)
    if (!req) {
      return {
        ok: false,
        profileId: '',
        collectedAt: Date.now(),
        durationMs: 0,
        error: 'Invalid metrics request',
      }
    }
    await profilesReady
    const profiles = listProfiles()
    const profile = profiles.find((p: { id: string }) => p.id === req.profileId)
    if (!profile) {
      return {
        ok: false,
        profileId: req.profileId,
        collectedAt: Date.now(),
        durationMs: 0,
        error: 'Profile not found',
      }
    }
    const result = await collectMetrics(
      profile,
      await resolveStoredCredential(userDataPath, profile, req),
    )
    await saveProfile(userDataPath, {
      ...profile,
      lastMetrics: result,
    })
    return result
  })

  secureIpcMain.handle('remoteTerminal:disconnect', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
      return { ok: false, error: 'Invalid session id' }
    }
    return disconnect(sessionId)
  })

  secureIpcMain.handle(
    'remoteTerminal:write',
    async (_event, sessionId: unknown, data: unknown) => {
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        sessionId.length > 256 ||
        typeof data !== 'string' ||
        data.length > 1024 * 1024
      ) {
        return { ok: false, error: 'Invalid terminal write request' }
      }
      return write(sessionId, data)
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:resize',
    async (_event, sessionId: unknown, size: unknown) => {
      const value =
        typeof size === 'object' && size !== null ? (size as Record<string, unknown>) : null
      const cols = value?.cols
      const rows = value?.rows
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        sessionId.length > 256 ||
        !Number.isSafeInteger(cols) ||
        !Number.isSafeInteger(rows) ||
        Number(cols) < 1 ||
        Number(cols) > 1000 ||
        Number(rows) < 1 ||
        Number(rows) > 1000
      ) {
        return { ok: false, error: 'Invalid terminal resize request' }
      }
      return resize(sessionId, Number(cols), Number(rows))
    },
  )

  setDataCallback((event) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remoteTerminal:onData', event)
    }
  })

  setStatusCallback((status) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remoteTerminal:onStatusChanged', status)
    }
  })
}
