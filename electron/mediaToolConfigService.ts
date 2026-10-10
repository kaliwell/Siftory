import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { MediaSearchToolConfigResult } from '../shared/ipc-contract'
import { getFfmpegStatus, setConfiguredFfmpegDir } from './ffmpegService'
import { ensureMediaSearchDirs, getMediaSearchDir } from './mediaCacheService'

interface MediaToolConfigFile {
  ffmpegDir?: string
}

function configPath(): string {
  return path.join(getMediaSearchDir(), 'tool-config.json')
}

export function getBundledFfmpegBinDir(): string {
  const baseDir = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return path.join(baseDir, 'tools', 'ffmpeg', 'bin')
}

function executableName(name: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function hasMediaTools(dirPath: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dirPath, executableName('ffmpeg'))) &&
      fs.existsSync(path.join(dirPath, executableName('ffprobe')))
    )
  } catch {
    return false
  }
}

export function normalizeFfmpegDirectory(inputPath: string): MediaSearchToolConfigResult {
  const trimmed = inputPath.trim()
  if (!trimmed) return { ok: false, error: 'Invalid ffmpeg directory' }
  const resolved = path.resolve(trimmed)
  const candidates = [resolved, path.join(resolved, 'bin')]
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isDirectory() && hasMediaTools(candidate)) {
        return { ok: true, ffmpegDir: candidate }
      }
    } catch {
      /* try next */
    }
  }
  return {
    ok: false,
    error: `Directory must contain ${executableName('ffmpeg')} and ${executableName('ffprobe')}`,
  }
}

function readConfigFile(): MediaToolConfigFile {
  ensureMediaSearchDirs()
  try {
    const parsed = JSON.parse(
      fs.readFileSync(configPath(), 'utf-8'),
    ) as Partial<MediaToolConfigFile>
    return typeof parsed.ffmpegDir === 'string' ? { ffmpegDir: parsed.ffmpegDir } : {}
  } catch {
    return {}
  }
}

function writeConfigFile(config: MediaToolConfigFile): void {
  ensureMediaSearchDirs()
  const tmp = `${configPath()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmp, configPath())
}

export function initMediaToolConfig(): void {
  const config = readConfigFile()
  if (!config.ffmpegDir) return
  const normalized = normalizeFfmpegDirectory(config.ffmpegDir)
  setConfiguredFfmpegDir(normalized.ok ? normalized.ffmpegDir : undefined)
}

export function saveFfmpegDirectory(dirPath: string): MediaSearchToolConfigResult {
  const normalized = normalizeFfmpegDirectory(dirPath)
  if (!normalized.ok || !normalized.ffmpegDir) return normalized
  writeConfigFile({ ffmpegDir: normalized.ffmpegDir })
  setConfiguredFfmpegDir(normalized.ffmpegDir)
  const status = getFfmpegStatus(true)
  if (!status.ffmpeg.available || !status.ffprobe.available) {
    return { ok: false, ffmpegDir: normalized.ffmpegDir, error: 'Unable to execute ffmpeg tools' }
  }
  return { ok: true, ffmpegDir: normalized.ffmpegDir }
}

export function clearFfmpegDirectory(): MediaSearchToolConfigResult {
  ensureMediaSearchDirs()
  try {
    if (fs.existsSync(configPath())) fs.unlinkSync(configPath())
    setConfiguredFfmpegDir(undefined)
    getFfmpegStatus(true)
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function ensureBundledFfmpegBinDir(): MediaSearchToolConfigResult {
  try {
    const toolsDir = getBundledFfmpegBinDir()
    fs.mkdirSync(toolsDir, { recursive: true })
    return { ok: true, toolsDir }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
