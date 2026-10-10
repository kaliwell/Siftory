import { secureIpcMain } from './ipcAuthorization'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import crypto from 'crypto'
import path from 'path'
import { listProfiles } from './remoteTerminalService'
import {
  cancelTransfer,
  clearTransferHistory,
  enqueueDownload,
  enqueueUpload,
  listTransfers,
  setTransferCallback,
} from './remoteTransferService'
import { normalizeCredentialFields, resolveStoredCredential } from './remoteTerminalCredential'
import {
  remoteCatalogDownloadTokens,
  resolveRemoteCatalogDownloadClaim,
  sameRemoteCatalogDownloadClaim,
} from './remoteCatalogDownload'
import { getSourceCatalogService } from './sourceCatalogService'

type GetMainWindow = () => BrowserWindow | null

interface TransferSelectionToken {
  kind: 'upload-file' | 'download-directory'
  selectedPath: string
  senderId: number
  expiresAt: number
}

const TRANSFER_SELECTION_TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_TRANSFER_SELECTION_TOKENS = 256

export class TransferSelectionTokens {
  private readonly tokens = new Map<string, TransferSelectionToken>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = TRANSFER_SELECTION_TOKEN_TTL_MS,
    private readonly maxEntries = MAX_TRANSFER_SELECTION_TOKENS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error(`Invalid transfer selection token TTL: ${ttlMs}`)
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`Invalid transfer selection token limit: ${maxEntries}`)
    }
  }

  get size(): number {
    return this.tokens.size
  }

  issue(kind: TransferSelectionToken['kind'], selectedPath: string, senderId: number): string {
    const issuedAt = this.now()
    this.pruneExpired(issuedAt)
    while (this.tokens.size >= this.maxEntries) {
      const oldest = this.tokens.keys().next()
      if (oldest.done) break
      this.tokens.delete(oldest.value)
    }
    const token = crypto.randomUUID()
    this.tokens.set(token, {
      kind,
      selectedPath,
      senderId,
      expiresAt: issuedAt + this.ttlMs,
    })
    return token
  }

  consume(token: unknown, kind: TransferSelectionToken['kind'], senderId: number): string | null {
    if (typeof token !== 'string') return null
    const selection = this.tokens.get(token)
    this.tokens.delete(token)
    if (
      !selection ||
      selection.kind !== kind ||
      selection.senderId !== senderId ||
      selection.expiresAt <= this.now()
    ) {
      return null
    }
    return selection.selectedPath
  }

  clearSender(senderId: number): void {
    for (const [token, selection] of this.tokens) {
      if (selection.senderId === senderId) this.tokens.delete(token)
    }
  }

  private pruneExpired(now: number): void {
    for (const [token, selection] of this.tokens) {
      if (selection.expiresAt <= now) this.tokens.delete(token)
    }
  }
}

const transferSelectionTokens = new TransferSelectionTokens()
const trackedTransferSelectionSenders = new Set<number>()

function trackTransferSelectionSender(sender: WebContents): void {
  if (trackedTransferSelectionSenders.has(sender.id)) return
  trackedTransferSelectionSenders.add(sender.id)
  sender.once('destroyed', () => {
    transferSelectionTokens.clearSender(sender.id)
    trackedTransferSelectionSenders.delete(sender.id)
  })
}

function createTransferSelectionToken(
  kind: TransferSelectionToken['kind'],
  selectedPath: string,
  senderId: number,
): string {
  return transferSelectionTokens.issue(kind, selectedPath, senderId)
}

function consumeTransferSelectionToken(
  token: unknown,
  kind: TransferSelectionToken['kind'],
  senderId: number,
): string | null {
  return transferSelectionTokens.consume(token, kind, senderId)
}

function normalizeConflictPolicy(input: unknown): 'ask' | 'overwrite' | 'skip' | 'rename' {
  if (input === 'overwrite' || input === 'skip' || input === 'rename' || input === 'ask') {
    return input
  }
  return 'ask'
}

export function registerRemoteTerminalTransferIpc(
  getMainWindow: GetMainWindow,
  userDataPath: string,
  profilesReady: Promise<void> = Promise.resolve(),
): void {
  secureIpcMain.handle('remoteTerminal:chooseUploadFile', async (event) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Window unavailable' }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a file to upload',
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, error: 'Cancelled' }
    const selectedPath = result.filePaths[0]
    trackTransferSelectionSender(event.sender)
    return {
      ok: true,
      token: createTransferSelectionToken('upload-file', selectedPath, event.sender.id),
      displayName: path.basename(selectedPath),
    }
  })

  secureIpcMain.handle('remoteTerminal:chooseDownloadDirectory', async (event) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Window unavailable' }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a download directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, error: 'Cancelled' }
    const selectedPath = result.filePaths[0]
    trackTransferSelectionSender(event.sender)
    return {
      ok: true,
      token: createTransferSelectionToken('download-directory', selectedPath, event.sender.id),
      displayName: path.basename(selectedPath) || selectedPath,
    }
  })

  secureIpcMain.handle(
    'remoteTerminal:enqueueUpload',
    async (
      event,
      profileId: unknown,
      remoteDirectory: unknown,
      token: unknown,
      credential: unknown,
      conflictPolicy: unknown,
    ) => {
      const selectedPath = consumeTransferSelectionToken(token, 'upload-file', event.sender.id)
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        !selectedPath ||
        typeof profileId !== 'string' ||
        typeof remoteDirectory !== 'string' ||
        remoteDirectory.length > 4096 ||
        !credentialFields
      )
        return { ok: false, error: 'Invalid or expired upload selection' }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) return { ok: false, error: 'Profile not found' }
      const resolved = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        ...credentialFields,
      })
      try {
        const cp = normalizeConflictPolicy(conflictPolicy)
        const task = await enqueueUpload(profile, selectedPath, remoteDirectory, resolved, cp)
        return { ok: true, task }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:enqueueDownload',
    async (
      event,
      profileId: unknown,
      remoteFilePath: unknown,
      totalBytes: unknown,
      token: unknown,
      credential: unknown,
      conflictPolicy: unknown,
    ) => {
      const selectedPath = consumeTransferSelectionToken(
        token,
        'download-directory',
        event.sender.id,
      )
      const credentialFields = normalizeCredentialFields(credential)
      await profilesReady
      if (
        !selectedPath ||
        typeof profileId !== 'string' ||
        typeof remoteFilePath !== 'string' ||
        remoteFilePath.length > 4096 ||
        typeof totalBytes !== 'number' ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes < 0 ||
        !credentialFields
      )
        return { ok: false, error: 'Invalid or expired download selection' }
      const profile = listProfiles().find((item) => item.id === profileId)
      if (!profile) return { ok: false, error: 'Profile not found' }
      const resolved = await resolveStoredCredential(userDataPath, profile, {
        profileId,
        ...credentialFields,
      })
      try {
        const cp = normalizeConflictPolicy(conflictPolicy)
        const task = await enqueueDownload(
          profile,
          remoteFilePath,
          selectedPath,
          totalBytes,
          resolved,
          cp,
        )
        return { ok: true, task }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  secureIpcMain.handle(
    'remoteTerminal:enqueueCatalogDownload',
    async (event, actionToken: unknown, selectionToken: unknown, conflictPolicy: unknown) => {
      const selectedPath = consumeTransferSelectionToken(
        selectionToken,
        'download-directory',
        event.sender.id,
      )
      const claim = remoteCatalogDownloadTokens.consume(actionToken, event.sender.id)
      await profilesReady
      if (!selectedPath || !claim) {
        return { ok: false, error: 'Invalid or expired catalog download selection' }
      }
      const current = resolveRemoteCatalogDownloadClaim(
        getSourceCatalogService()?.getFileEntryForAction(claim.fileEntryId) ?? null,
        listProfiles(),
      )
      if (!current.ok) return current
      if (!sameRemoteCatalogDownloadClaim(claim, current.claim)) {
        return { ok: false, error: 'Catalog file changed. Search again before downloading.' }
      }
      const profile = listProfiles().find((item) => item.id === claim.profileId)
      if (!profile) return { ok: false, error: 'Profile not found' }
      const resolvedCredential = await resolveStoredCredential(userDataPath, profile, {
        profileId: profile.id,
        password: undefined as string | undefined,
        passphrase: undefined as string | undefined,
      })
      try {
        const task = await enqueueDownload(
          profile,
          claim.remotePath,
          selectedPath,
          claim.totalBytes,
          {
            password: resolvedCredential.password,
            passphrase: resolvedCredential.passphrase,
          },
          normalizeConflictPolicy(conflictPolicy),
        )
        return { ok: true, task }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  secureIpcMain.handle('remoteTerminal:listTransfers', () => listTransfers())

  secureIpcMain.handle('remoteTerminal:cancelTransfer', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string' || taskId.length > 256) {
      return { ok: false, error: 'Invalid task id' }
    }
    return cancelTransfer(taskId)
  })

  secureIpcMain.handle('remoteTerminal:clearTransferHistory', () => {
    clearTransferHistory()
    return { ok: true }
  })

  setTransferCallback((task) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remoteTerminal:onTransferChanged', task)
    }
  })
}
