import { secureIpcMain } from './ipcAuthorization'
import { nativeImage, type BrowserWindow, type IpcMainEvent, type NativeImage } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { WebContents } from 'electron'
import { normalizeUserPath } from './pathGuards'
import {
  FileDragAuthorizer,
  shouldPreferPhotoshopCompatibilityPreview,
} from './fileDragAuthorization'
import { getProjectSearchMetadata } from './projectSearchIndexService'
import { convertStillImageToPng } from './ffmpegService'

type MainWindowProvider = () => BrowserWindow | null

const authorizer = new FileDragAuthorizer()
const MAX_TOKEN_LENGTH = 128
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av0pAAAAAElFTkSuQmCC'
const DRAG_MODE_VALUES = new Set(['compatible', 'original'])
const COMPATIBILITY_CACHE_MAX_FILES = 256
const COMPATIBILITY_CACHE_MAX_BYTES = 512 * 1024 * 1024

function notifyError(sender: WebContents, message: string): void {
  if (!sender.isDestroyed()) sender.send('fileDrag:error', message)
}

function createDragIcon(iconPath?: string): NativeImage {
  if (iconPath) {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  }
  return nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL)
}

function currentFileFingerprint(
  rawPath: unknown,
): { filePath: string; size: number; mtimeMs: number } | null {
  const filePath = normalizeUserPath(rawPath)
  if (!filePath) return null
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

export function authorizeFileDragResults<T>(
  senderId: number,
  results: readonly T[],
  getPath: (result: T) => unknown,
): Array<T & { dragToken?: string; dragUsesCompatibilityPreview?: boolean }> {
  return results.map(
    (result): T & { dragToken?: string; dragUsesCompatibilityPreview?: boolean } => {
      const fingerprint = currentFileFingerprint(getPath(result))
      if (!fingerprint) {
        return { ...result } as T & {
          dragToken?: string
          dragUsesCompatibilityPreview?: boolean
        }
      }
      return {
        ...result,
        dragToken: authorizer.issue(senderId, fingerprint),
        dragUsesCompatibilityPreview: shouldPreferPhotoshopCompatibilityPreview(
          fingerprint.filePath,
        ),
      }
    },
  )
}

function isAuthorizedSender(event: IpcMainEvent, getMainWindow: MainWindowProvider): boolean {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false
  return event.senderFrame === window.webContents.mainFrame
}

function compatibilityCachePath(
  userDataPath: string,
  source: { filePath: string; size: number; mtimeMs: number },
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(source.filePath)}\0${source.size}\0${source.mtimeMs}`)
    .digest('hex')
    .slice(0, 20)
  return path.join(userDataPath, 'drag-compatibility-cache', `${digest}.png`)
}

function pruneCompatibilityCache(cacheDir: string, preservePath: string): void {
  try {
    const cached = fs
      .readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
      .map((entry) => {
        const filePath = path.join(cacheDir, entry.name)
        const stat = fs.statSync(filePath)
        return { filePath, size: stat.size, atimeMs: stat.atimeMs }
      })
      .sort((left, right) => left.atimeMs - right.atimeMs)
    let totalBytes = cached.reduce((total, entry) => total + entry.size, 0)
    let totalFiles = cached.length
    for (const entry of cached) {
      if (
        totalFiles <= COMPATIBILITY_CACHE_MAX_FILES &&
        totalBytes <= COMPATIBILITY_CACHE_MAX_BYTES
      ) {
        break
      }
      if (path.resolve(entry.filePath) === path.resolve(preservePath)) continue
      fs.unlinkSync(entry.filePath)
      totalBytes -= entry.size
      totalFiles -= 1
    }
  } catch {
    // Cache maintenance must never block a drag.
  }
}

function createRasterCompatibilityPreview(
  userDataPath: string,
  source: { filePath: string; size: number; mtimeMs: number },
): string | null {
  const destination = compatibilityCachePath(userDataPath, source)
  try {
    const cached = fs.statSync(destination)
    if (cached.isFile() && cached.size > 0) {
      const now = new Date()
      fs.utimesSync(destination, now, now)
      return destination
    }
  } catch {
    // Cache miss.
  }

  const cacheDir = path.dirname(destination)
  fs.mkdirSync(cacheDir, { recursive: true })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    const image = nativeImage.createFromPath(source.filePath)
    const png = image.isEmpty() ? Buffer.alloc(0) : image.toPNG()
    if (png.length > 0) {
      fs.writeFileSync(temporary, png, { flag: 'wx' })
    } else {
      const converted = convertStillImageToPng({
        filePath: source.filePath,
        outputPath: temporary,
      })
      if (!converted.ok) throw new Error(converted.error || 'Image conversion failed')
    }
    try {
      fs.renameSync(temporary, destination)
    } catch (error) {
      if (!fs.existsSync(destination)) throw error
      fs.unlinkSync(temporary)
    }
    pruneCompatibilityCache(cacheDir, destination)
    return destination
  } catch {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // Best-effort temporary cleanup.
    }
    return null
  }
}

function resolveCompatibilityDragFile(
  source: { filePath: string; size: number; mtimeMs: number },
  userDataPath?: string,
): string {
  if (!shouldPreferPhotoshopCompatibilityPreview(source.filePath)) return source.filePath

  const projectPreview = getProjectSearchMetadata(source.filePath)?.previewPath
  const preview = currentFileFingerprint(projectPreview)
  if (preview) return preview.filePath

  if (!userDataPath) return source.filePath
  return createRasterCompatibilityPreview(userDataPath, source) ?? source.filePath
}

export function registerFileDragIpc(
  getMainWindow: MainWindowProvider,
  iconPath?: string,
  userDataPath?: string,
): void {
  const dragIcon = createDragIcon(iconPath)

  secureIpcMain.on('fileDrag:start', (event, rawToken: unknown, rawMode: unknown) => {
    if (!isAuthorizedSender(event, getMainWindow)) return
    if (
      typeof rawToken !== 'string' ||
      rawToken.length === 0 ||
      rawToken.length > MAX_TOKEN_LENGTH
    ) {
      notifyError(event.sender, 'The drag result is invalid. Run the search again.')
      return
    }
    if (typeof rawMode !== 'string' || !DRAG_MODE_VALUES.has(rawMode)) {
      notifyError(event.sender, 'The drag mode is invalid. Try dragging the result again.')
      return
    }
    const grant = authorizer.resolve(event.sender.id, rawToken)
    if (!grant) {
      notifyError(event.sender, 'The drag result expired. Run the search again.')
      return
    }
    const current = currentFileFingerprint(grant.filePath)
    if (!current || current.size !== grant.size || Math.abs(current.mtimeMs - grant.mtimeMs) > 1) {
      notifyError(event.sender, 'The source file changed or no longer exists.')
      return
    }
    const dragFile =
      rawMode === 'original'
        ? current.filePath
        : resolveCompatibilityDragFile(current, userDataPath)
    try {
      event.sender.startDrag({ file: dragFile, icon: dragIcon })
    } catch (error) {
      console.warn(
        '[FileDrag] Native drag failed:',
        error instanceof Error ? error.message : String(error),
      )
      notifyError(
        event.sender,
        'Windows could not start the file drag. Try opening the file instead.',
      )
    }
  })
}
