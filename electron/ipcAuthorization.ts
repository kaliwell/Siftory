import path from 'path'
import { fileURLToPath } from 'url'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { getIpcCapabilityDeclaration } from '../shared/ipc-capabilities'
import { validateIpcPayloadArguments } from '../shared/ipc-payload-validation'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const authorizedWebContents = new Set<number>()
const trustedFrameUrlChecks = new Map<number, (rawUrl: string) => boolean>()
const windowChannels = new Map<number, ReadonlySet<string>>()
const IPC_TIMING_ENABLED = process.env.SIFTORY_IPC_TIMING === '1'
const IPC_TIMING_THRESHOLD_MS = Math.max(
  0,
  Number(process.env.SIFTORY_IPC_TIMING_THRESHOLD_MS) || 10,
)

function reportIpcTiming(channel: string, startedAt: number): void {
  const durationMs = performance.now() - startedAt
  if (durationMs >= IPC_TIMING_THRESHOLD_MS) {
    console.info(`[IPC timing] ${channel}: ${durationMs.toFixed(1)}ms`)
  }
}

function trustedFrameUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'file:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
    )
  } catch {
    return false
  }
}

/**
 * VAL-029: strict per-window IPC origin trust. The generic fallback above
 * accepts any file: URL and any loopback http port; a registered window
 * instead trusts only the URL space it actually loaded:
 * - packaged/self-hosted builds: file: URLs inside the application bundle
 *   directory, nothing else;
 * - development: the exact dev-server origin (not every loopback port).
 */
export function createRendererFrameUrlTrust(options: {
  appPath: string
  devServerUrl?: string | null
}): (rawUrl: string) => boolean {
  let devOrigin: string | null = null
  if (options.devServerUrl) {
    try {
      devOrigin = new URL(options.devServerUrl).origin
    } catch {
      devOrigin = null
    }
  }
  const appRoot = path.resolve(options.appPath)
  return (rawUrl: string): boolean => {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return false
    }
    if (devOrigin && (url.protocol === 'http:' || url.protocol === 'https:')) {
      return url.origin === devOrigin
    }
    if (url.protocol !== 'file:') return false
    let filePath: string
    try {
      filePath = fileURLToPath(url)
    } catch {
      return false
    }
    const relative = path.relative(appRoot, path.resolve(filePath))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
}

function isTrustedFrame(senderId: number, rawUrl: string): boolean {
  const strict = trustedFrameUrlChecks.get(senderId)
  return strict ? strict(rawUrl) : trustedFrameUrl(rawUrl)
}

function assertAuthorizedSender(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): void {
  if (!authorizedWebContents.has(event.sender.id)) throw new Error('Unauthorized IPC sender')
  const allowed = windowChannels.get(event.sender.id)
  if (allowed && !allowed.has(channel)) throw new Error('IPC channel is unavailable to this window')
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC is only available to the main frame')
  }
  if (!isTrustedFrame(event.sender.id, event.senderFrame.url)) {
    throw new Error('Untrusted IPC frame origin')
  }
}

function assertDeclaredChannel(channel: string): void {
  if (!getIpcCapabilityDeclaration(channel)) {
    throw new Error(`IPC channel has no capability declaration or validator: ${channel}`)
  }
}

export function authorizeIpcWebContents(
  webContents: WebContents,
  isTrustedFrameUrl?: (rawUrl: string) => boolean,
  allowedChannels?: ReadonlySet<string>,
): void {
  authorizedWebContents.add(webContents.id)
  if (isTrustedFrameUrl) trustedFrameUrlChecks.set(webContents.id, isTrustedFrameUrl)
  if (allowedChannels) windowChannels.set(webContents.id, new Set(allowedChannels))
  webContents.once('destroyed', () => {
    authorizedWebContents.delete(webContents.id)
    trustedFrameUrlChecks.delete(webContents.id)
    windowChannels.delete(webContents.id)
  })
}

export const secureIpcMain = Object.freeze({
  handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ): void {
    assertDeclaredChannel(channel)
    ipcMain.handle(channel, (event, ...args: Args) => {
      assertAuthorizedSender(event, channel)
      validateIpcPayloadArguments(args)
      if (!IPC_TIMING_ENABLED) return listener(event, ...args)
      const startedAt = performance.now()
      try {
        const result = listener(event, ...args)
        if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
          return Promise.resolve(result).finally(() => reportIpcTiming(channel, startedAt))
        }
        reportIpcTiming(channel, startedAt)
        return result
      } catch (error) {
        reportIpcTiming(channel, startedAt)
        throw error
      }
    })
  },
  on<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void {
    assertDeclaredChannel(channel)
    ipcMain.on(channel, (event, ...args: Args) => {
      try {
        assertAuthorizedSender(event, channel)
        validateIpcPayloadArguments(args)
        listener(event, ...args)
      } catch (error) {
        console.warn(`[IPC] Rejected ${channel}:`, error instanceof Error ? error.message : error)
      }
    })
  },
})
