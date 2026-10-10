import { app, BrowserWindow } from 'electron'
import { randomBytes } from 'crypto'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { ControlledMediaSeek } from './controlledMediaSeek'
import { authorizeIpcWebContents } from './ipcAuthorization'
import {
  registerMediaPlayerExportGrant,
  revokeMediaPlayerExportGrant,
} from './mediaPlayerExportService'

const playerWindows = new Map<string, BrowserWindow>()

function isTrustedPlayerNavigation(rawUrl: string, trustedPlayerPath: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return (
      parsed.protocol === 'file:' &&
      path.resolve(fileURLToPath(parsed)).toLowerCase() === trustedPlayerPath.toLowerCase()
    )
  } catch {
    return false
  }
}

export async function openControlledMediaPlayer(
  seek: ControlledMediaSeek,
  options: {
    parent?: BrowserWindow | null
    show?: boolean
    playerHtmlPath?: string
    playerPreloadPath?: string
  } = {},
): Promise<{ ok: boolean; error?: string; window?: BrowserWindow }> {
  let player: BrowserWindow | undefined
  let exportToken = ''
  try {
    const previous = playerWindows.get(seek.videoId)
    if (previous && !previous.isDestroyed()) previous.close()
    exportToken = randomBytes(24).toString('base64url')
    const playerPreloadPath =
      options.playerPreloadPath ?? path.join(__dirname, 'mediaPlayerPreload.js')
    player = new BrowserWindow({
      width: 960,
      height: 600,
      minWidth: 480,
      minHeight: 320,
      show: options.show !== false,
      autoHideMenuBar: true,
      backgroundColor: '#080b10',
      ...(options.parent && !options.parent.isDestroyed() ? { parent: options.parent } : {}),
      webPreferences: {
        preload: playerPreloadPath,
        additionalArguments: [`--siftory-player-export-token=${exportToken}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    registerMediaPlayerExportGrant(exportToken, player.webContents.id, {
      videoId: seek.videoId,
      videoPath: seek.videoPath,
      title: seek.title,
      ...(seek.durationMs !== undefined ? { durationMs: seek.durationMs } : {}),
      ...(seek.width !== undefined ? { width: seek.width } : {}),
      ...(seek.height !== undefined ? { height: seek.height } : {}),
      ...(seek.sizeBytes !== undefined ? { sizeBytes: seek.sizeBytes } : {}),
      ...(seek.mtimeMs !== undefined ? { mtimeMs: seek.mtimeMs } : {}),
    })
    playerWindows.set(seek.videoId, player)
    player.on('closed', () => {
      revokeMediaPlayerExportGrant(exportToken)
      if (playerWindows.get(seek.videoId) === player) playerWindows.delete(seek.videoId)
    })
    player.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const playerUrl =
      options.playerHtmlPath ?? path.join(app.getAppPath(), 'dist', 'media-player.html')
    const trustedPlayerPath = path.resolve(playerUrl)
    authorizeIpcWebContents(player.webContents, (rawUrl) =>
      isTrustedPlayerNavigation(rawUrl, trustedPlayerPath),
    )
    const mediaUrl = pathToFileURL(seek.videoPath).href
    await player.loadFile(playerUrl, {
      query: {
        source: mediaUrl,
        timestampMs: String(seek.timestampMs),
        ...(seek.hitContext ? { hitContext: JSON.stringify(seek.hitContext) } : {}),
      },
    })
    player.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isTrustedPlayerNavigation(targetUrl, trustedPlayerPath)) event.preventDefault()
    })
    player.setTitle(`${seek.title} @ ${(seek.timestampMs / 1000).toFixed(3)}s`)
    return { ok: true, window: player }
  } catch (error) {
    if (exportToken) revokeMediaPlayerExportGrant(exportToken)
    if (player && !player.isDestroyed()) player.destroy()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function closeControlledMediaPlayers(): void {
  for (const player of playerWindows.values()) {
    if (!player.isDestroyed()) player.close()
  }
  playerWindows.clear()
}
