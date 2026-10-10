import { spawn, spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface VideoMetadata {
  durationMs?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  containerFormat?: string
}

export interface MediaToolStatus {
  available: boolean
  command: string
  version?: string
  error?: string
}

export interface FfmpegStatus {
  ffmpeg: MediaToolStatus
  ffprobe: MediaToolStatus
}

let configuredFfmpegDir: string | undefined
const activeMediaToolChildren = new Set<ChildProcess>()
let temporaryMediaSequence = 0
let cachedStatus: FfmpegStatus | null = null
let statusGeneration = 0
let warmingStatus: {
  generation: number
  promise: Promise<FfmpegStatus>
  token: symbol
} | null = null

export function cancelRunningMediaTools(): void {
  for (const child of activeMediaToolChildren) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  activeMediaToolChildren.clear()
}

for (const eventName of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.once(eventName, cancelRunningMediaTools)
}

export function setConfiguredFfmpegDir(dirPath: string | undefined): void {
  configuredFfmpegDir = dirPath && dirPath.trim() ? dirPath : undefined
  statusGeneration += 1
  cachedStatus = null
}

function executableName(toolName: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${toolName}.exe` : toolName
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    output.push(value)
  }
  return output
}

export function buildMediaToolCandidates(
  toolName: 'ffmpeg' | 'ffprobe',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const exe = executableName(toolName)
  const explicitToolPath = toolName === 'ffmpeg' ? env.FFMPEG_PATH : env.FFPROBE_PATH
  const configuredDirs = [
    configuredFfmpegDir,
    env.FLOATING_CLOCK_FFMPEG_DIR,
    env.FFMPEG_DIR,
    env.FFMPEG_HOME ? path.join(env.FFMPEG_HOME, 'bin') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const roots = uniqueStrings(
    [
      env.FLOATING_CLOCK_RESOURCES_PATH,
      process.resourcesPath,
      process.cwd(),
      path.resolve(__dirname, '..'),
      path.resolve(__dirname, '..', '..'),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
  )
  const localDirs = roots.flatMap((root) => [
    path.join(root, 'tools', 'ffmpeg', 'bin'),
    path.join(root, 'tools', 'ffmpeg'),
    path.join(root, 'ffmpeg', 'bin'),
    path.join(root, 'ffmpeg'),
  ])

  return uniqueStrings([
    ...(explicitToolPath ? [explicitToolPath] : []),
    ...configuredDirs.map((dir) => path.join(dir, exe)),
    ...localDirs.map((dir) => path.join(dir, exe)),
    toolName,
  ])
}

function firstVersionLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (
    [...lines]
      .reverse()
      .find(
        (line) =>
          !line.startsWith('ffmpeg version ') &&
          !line.startsWith('ffprobe version ') &&
          !line.startsWith('built with ') &&
          !line.startsWith('configuration:') &&
          !line.startsWith('libav'),
      ) || lines.find(Boolean)
  )
}

function runToolAsync(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeMediaToolChildren.add(child)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      activeMediaToolChildren.delete(child)
      resolve({ status: null, stdout, stderr, error: 'timed out' })
    }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > options.maxBuffer) stdout = stdout.slice(-options.maxBuffer)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > options.maxBuffer) stderr = stderr.slice(-options.maxBuffer)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeMediaToolChildren.delete(child)
      resolve({ status: null, stdout, stderr, error: err.message })
    })
    child.on('exit', (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeMediaToolChildren.delete(child)
      resolve({ status, stdout, stderr })
    })
  })
}

function probeCommand(command: string): MediaToolStatus {
  try {
    const result = spawnSync(command, ['-version'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    })
    if (result.error) {
      return { available: false, command, error: result.error.message }
    }
    if (result.status !== 0) {
      return {
        available: false,
        command,
        error: firstVersionLine(result.stderr || result.stdout) || `exit ${result.status}`,
      }
    }
    return {
      available: true,
      command,
      version: firstVersionLine(result.stdout || result.stderr),
    }
  } catch (err: unknown) {
    return { available: false, command, error: err instanceof Error ? err.message : String(err) }
  }
}

export function getCachedFfmpegStatus(): FfmpegStatus {
  return (
    cachedStatus ?? {
      ffmpeg: { available: false, command: 'ffmpeg', error: 'status pending' },
      ffprobe: { available: false, command: 'ffprobe', error: 'status pending' },
    }
  )
}

export function warmFfmpegStatusCache(): Promise<FfmpegStatus> {
  if (cachedStatus) return Promise.resolve(cachedStatus)
  const generation = statusGeneration
  if (warmingStatus?.generation === generation) return warmingStatus.promise
  const token = Symbol('ffmpeg-status-probe')
  const promise = (async () => {
    try {
      const [ffmpeg, ffprobe] = await Promise.all([
        probeToolAsync('ffmpeg'),
        probeToolAsync('ffprobe'),
      ])
      const value = { ffmpeg, ffprobe }
      if (generation === statusGeneration) cachedStatus = value
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const value = {
        ffmpeg: { available: false, command: 'ffmpeg', error: message },
        ffprobe: { available: false, command: 'ffprobe', error: message },
      }
      if (generation === statusGeneration) cachedStatus = value
      return value
    } finally {
      if (warmingStatus?.token === token) warmingStatus = null
    }
  })()
  warmingStatus = { generation, promise, token }
  return promise
}

function probeTool(toolName: 'ffmpeg' | 'ffprobe'): MediaToolStatus {
  let lastResult: MediaToolStatus | null = null
  for (const command of buildMediaToolCandidates(toolName)) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      lastResult = { available: false, command, error: 'not found' }
      continue
    }
    const result = probeCommand(command)
    if (result.available) return result
    lastResult = result
  }
  return lastResult ?? { available: false, command: toolName, error: 'not found' }
}

async function probeCommandAsync(command: string): Promise<MediaToolStatus> {
  try {
    const result = await runToolAsync(command, ['-version'], {
      timeoutMs: 3000,
      maxBuffer: 256 * 1024,
    })
    if (result.error) return { available: false, command, error: result.error }
    if (result.status !== 0) {
      return {
        available: false,
        command,
        error: firstVersionLine(result.stderr || result.stdout) || `exit ${result.status}`,
      }
    }
    return {
      available: true,
      command,
      version: firstVersionLine(result.stdout || result.stderr),
    }
  } catch (err: unknown) {
    return { available: false, command, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeToolAsync(toolName: 'ffmpeg' | 'ffprobe'): Promise<MediaToolStatus> {
  let lastResult: MediaToolStatus | null = null
  for (const command of buildMediaToolCandidates(toolName)) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      lastResult = { available: false, command, error: 'not found' }
      continue
    }
    const result = await probeCommandAsync(command)
    if (result.available) return result
    lastResult = result
  }
  return lastResult ?? { available: false, command: toolName, error: 'not found' }
}

export function getFfmpegStatus(refresh = false): FfmpegStatus {
  if (!refresh && cachedStatus) return cachedStatus
  if (refresh) {
    statusGeneration += 1
    warmingStatus = null
  }
  cachedStatus = {
    ffmpeg: probeTool('ffmpeg'),
    ffprobe: probeTool('ffprobe'),
  }
  return cachedStatus
}

/** Check if an error string indicates the tool is not installed/configured. */
export function isToolNotFoundError(error?: string): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('not found') ||
    lower.includes('enoent') ||
    lower.includes('is not available') ||
    lower.includes('cannot find')
  )
}

/** Return a user-friendly help message for missing ffmpeg tools. */
export function getFfmpegHelpMessage(): string {
  const status = getFfmpegStatus()
  const missing: string[] = []
  if (!status.ffmpeg.available) missing.push('ffmpeg.exe')
  if (!status.ffprobe.available) missing.push('ffprobe.exe')
  if (missing.length === 0) return ''
  return (
    `${missing.join(' and ')} not found. ` +
    'Place them in tools/ffmpeg/bin/ or select a directory via FFmpeg Dir button, ' +
    'or add them to your system PATH.'
  )
}

function finitePositiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function parseFfprobeMetadata(jsonText: string): VideoMetadata | null {
  try {
    const parsed = JSON.parse(jsonText) as {
      format?: { duration?: unknown; format_name?: unknown }
      streams?: Array<{
        codec_type?: unknown
        codec_name?: unknown
        width?: unknown
        height?: unknown
      }>
    }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const video = streams.find((stream) => stream.codec_type === 'video')
    const audio = streams.find((stream) => stream.codec_type === 'audio')
    const durationSec = finitePositiveNumber(parsed.format?.duration)
    return {
      ...(durationSec ? { durationMs: Math.round(durationSec * 1000) } : {}),
      ...(finitePositiveNumber(video?.width)
        ? { width: Math.round(finitePositiveNumber(video?.width) || 0) }
        : {}),
      ...(finitePositiveNumber(video?.height)
        ? { height: Math.round(finitePositiveNumber(video?.height) || 0) }
        : {}),
      ...(safeString(video?.codec_name) ? { videoCodec: safeString(video?.codec_name) } : {}),
      ...(safeString(audio?.codec_name) ? { audioCodec: safeString(audio?.codec_name) } : {}),
      ...(safeString(parsed.format?.format_name)
        ? { containerFormat: safeString(parsed.format?.format_name) }
        : {}),
    }
  } catch {
    return null
  }
}

export function readVideoMetadata(filePath: string): {
  ok: boolean
  metadata?: VideoMetadata
  error?: string
} {
  const status = getFfmpegStatus()
  if (!status.ffprobe.available) {
    return { ok: false, error: status.ffprobe.error || 'ffprobe is not available' }
  }

  try {
    const result = spawnSync(
      status.ffprobe.command,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffprobe exit ${result.status}`,
      }
    }
    const metadata = parseFfprobeMetadata(result.stdout)
    if (!metadata) return { ok: false, error: 'Unable to parse ffprobe output' }
    return { ok: true, metadata }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function readVideoMetadataAsync(filePath: string): Promise<{
  ok: boolean
  metadata?: VideoMetadata
  error?: string
}> {
  const status = getFfmpegStatus()
  if (!status.ffprobe.available) {
    return { ok: false, error: status.ffprobe.error || 'ffprobe is not available' }
  }

  try {
    const result = await runToolAsync(
      status.ffprobe.command,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeoutMs: 10000, maxBuffer: 2 * 1024 * 1024 },
    )
    if (result.error) return { ok: false, error: result.error }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffprobe exit ${result.status}`,
      }
    }
    const metadata = parseFfprobeMetadata(result.stdout)
    if (!metadata) return { ok: false, error: 'Unable to parse ffprobe output' }
    return { ok: true, metadata }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function generateVideoCoverThumbnail(input: {
  filePath: string
  outputPath: string
  timestampMs?: number
  width?: number
}): {
  ok: boolean
  path?: string
  error?: string
} {
  const status = getFfmpegStatus()
  if (!status.ffmpeg.available) {
    return { ok: false, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }

  try {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
    const timestampSeconds = Math.max(0, Math.floor((input.timestampMs ?? 1000) / 1000))
    const width = Math.max(96, Math.min(640, Math.floor(input.width ?? 320)))
    const result = spawnSync(
      status.ffmpeg.command,
      [
        '-y',
        '-ss',
        String(timestampSeconds),
        '-i',
        input.filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '5',
        input.outputPath,
      ],
      {
        encoding: 'utf-8',
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      },
    )
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
      }
    }
    if (!fs.existsSync(input.outputPath)) return { ok: false, error: 'thumbnail was not created' }
    return { ok: true, path: input.outputPath }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Synchronous by design: Electron's native file drag must begin inside the
 * renderer's dragstart turn. This is only used for a single, explicitly
 * dragged image and callers cache the result, so the bounded wait happens at
 * most once per source fingerprint.
 */
export function convertStillImageToPng(input: {
  filePath: string
  outputPath: string
  maxDimension?: number
}): { ok: boolean; path?: string; error?: string } {
  const status = getFfmpegStatus()
  if (!status.ffmpeg.available) {
    return { ok: false, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }

  const maxDimension = Math.max(512, Math.min(8192, Math.floor(input.maxDimension ?? 4096)))
  const scale = `scale='min(${maxDimension}\\,iw)':'min(${maxDimension}\\,ih)':force_original_aspect_ratio=decrease`
  try {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
    const result = spawnSync(
      status.ffmpeg.command,
      [
        '-v',
        'error',
        '-y',
        '-i',
        input.filePath,
        '-frames:v',
        '1',
        '-vf',
        scale,
        '-c:v',
        'png',
        '-f',
        'image2',
        input.outputPath,
      ],
      {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      },
    )
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
      }
    }
    const output = fs.statSync(input.outputPath)
    if (!output.isFile() || output.size === 0) {
      return { ok: false, error: 'converted image was not created' }
    }
    return { ok: true, path: input.outputPath }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Render an exact player selection to a broadly compatible H.264/AAC MP4.
 * Input seeking stays fast while FFmpeg's default accurate-seek path decodes
 * from the preceding keyframe before re-encoding the requested range.
 */
export async function exportVideoSelectionToMp4(input: {
  filePath: string
  outputPath: string
  startMs: number
  endMs: number
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const status = await warmFfmpegStatusCache()
  if (!status.ffmpeg.available) {
    return { ok: false, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }
  const startMs = Math.floor(input.startMs)
  const endMs = Math.floor(input.endMs)
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs - startMs < 40) {
    return { ok: false, error: 'The selected video range must be at least 40 ms' }
  }
  if (path.resolve(input.filePath).toLowerCase() === path.resolve(input.outputPath).toLowerCase()) {
    return { ok: false, error: 'The exported clip cannot overwrite its source video' }
  }

  const outputDirectory = path.dirname(input.outputPath)
  const outputExtension = path.extname(input.outputPath) || '.mp4'
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(input.outputPath, outputExtension)}.${process.pid}-${Date.now()}.partial${outputExtension}`,
  )
  const durationMs = endMs - startMs
  const timeoutMs = Math.max(60_000, Math.min(6 * 60 * 60 * 1_000, durationMs * 4 + 120_000))
  try {
    fs.mkdirSync(outputDirectory, { recursive: true })
    const result = await runToolAsync(
      status.ffmpeg.command,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-ss',
        (startMs / 1_000).toFixed(3),
        '-i',
        input.filePath,
        '-t',
        (durationMs / 1_000).toFixed(3),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-map_metadata',
        '0',
        '-sn',
        '-dn',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        temporaryPath,
      ],
      { timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    )
    if (result.error) return { ok: false, error: result.error }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
      }
    }
    const rendered = fs.statSync(temporaryPath)
    if (!rendered.isFile() || rendered.size === 0) {
      return { ok: false, error: 'The exported video clip was not created' }
    }
    fs.copyFileSync(temporaryPath, input.outputPath)
    const saved = fs.statSync(input.outputPath)
    if (!saved.isFile() || saved.size === 0) {
      return { ok: false, error: 'The exported video clip could not be finalized' }
    }
    return { ok: true, path: input.outputPath }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    } catch {
      /* best-effort cleanup of this export's private temporary file */
    }
  }
}

async function runThumbnailCommand(
  command: string,
  args: string[],
  outputPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await runToolAsync(command, args, { timeoutMs: 15000, maxBuffer: 512 * 1024 })
  if (result.error) return { ok: false, error: result.error }
  if (result.status !== 0) {
    return {
      ok: false,
      error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
    }
  }
  if (!fs.existsSync(outputPath)) return { ok: false, error: 'thumbnail was not created' }
  return { ok: true }
}

export async function generateVideoCoverThumbnailAsync(input: {
  filePath: string
  outputPath: string
  timestampMs?: number
  width?: number
  preferHardwareDecode?: boolean
}): Promise<{
  ok: boolean
  path?: string
  error?: string
}> {
  const status = getFfmpegStatus()
  if (!status.ffmpeg.available) {
    return { ok: false, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }

  try {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
    const timestampSeconds = Math.max(0, Math.floor((input.timestampMs ?? 1000) / 1000))
    const width = Math.max(96, Math.min(640, Math.floor(input.width ?? 320)))
    const commonTail = [
      '-ss',
      String(timestampSeconds),
      '-i',
      input.filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-q:v',
      '5',
      input.outputPath,
    ]
    if (input.preferHardwareDecode !== false) {
      const hw = await runThumbnailCommand(
        status.ffmpeg.command,
        ['-y', '-hwaccel', 'auto', ...commonTail],
        input.outputPath,
      )
      if (hw.ok) return { ok: true, path: input.outputPath }
      try {
        if (fs.existsSync(input.outputPath)) fs.unlinkSync(input.outputPath)
      } catch {
        /* ignore */
      }
    }

    const cpu = await runThumbnailCommand(
      status.ffmpeg.command,
      ['-y', ...commonTail],
      input.outputPath,
    )
    if (!cpu.ok) return { ok: false, error: cpu.error }
    return { ok: true, path: input.outputPath }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Subtitle detection & extraction ───────────────────────

export async function generateVideoFramesBatchAsync(input: {
  filePath: string
  frames: Array<{ timestampMs: number; outputPath: string }>
  width?: number
  preferHardwareDecode?: boolean
}): Promise<{ ok: boolean; created: Set<string>; error?: string }> {
  const status = getFfmpegStatus()
  const created = new Set<string>()
  if (!status.ffmpeg.available) {
    return { ok: false, created, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }

  const frames = input.frames.filter(
    (frame) => frame.outputPath && Number.isFinite(frame.timestampMs),
  )
  if (frames.length === 0) return { ok: true, created }
  const width = Math.max(96, Math.min(640, Math.floor(input.width ?? 320)))
  for (const frame of frames) fs.mkdirSync(path.dirname(frame.outputPath), { recursive: true })

  const buildArgs = (hardware: boolean): string[] => {
    const args = ['-y']
    if (hardware) args.push('-hwaccel', 'auto')
    for (const frame of frames) {
      args.push(
        '-ss',
        String(Math.max(0, Math.floor(frame.timestampMs / 1000))),
        '-i',
        input.filePath,
      )
    }
    for (let i = 0; i < frames.length; i++) {
      args.push(
        '-map',
        `${i}:v:0`,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '5',
        frames[i].outputPath,
      )
    }
    return args
  }

  const run = async (hardware: boolean): Promise<{ ok: boolean; error?: string }> => {
    const result = await runToolAsync(status.ffmpeg.command, buildArgs(hardware), {
      timeoutMs: Math.max(30000, frames.length * 8000),
      maxBuffer: 1024 * 1024,
    })
    if (result.error) return { ok: false, error: result.error }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
      }
    }
    for (const frame of frames) {
      if (fs.existsSync(frame.outputPath)) created.add(frame.outputPath)
    }
    return {
      ok: created.size === frames.length,
      error: created.size > 0 ? undefined : 'frames were not created',
    }
  }

  try {
    if (input.preferHardwareDecode !== false) {
      const hw = await run(true)
      if (hw.ok) return { ok: true, created }
      for (const frame of frames) {
        try {
          if (!created.has(frame.outputPath) && fs.existsSync(frame.outputPath))
            fs.unlinkSync(frame.outputPath)
        } catch {
          /* ignore */
        }
      }
      created.clear()
    }

    const cpu = await run(false)
    return cpu.ok ? { ok: true, created } : { ok: false, created, error: cpu.error }
  } catch (err: unknown) {
    return { ok: false, created, error: err instanceof Error ? err.message : String(err) }
  }
}

const MAX_SINGLE_INPUT_FRAME_BATCH = 32

interface VideoFrameOutput {
  timestampMs: number
  outputPath: string
}

function uniqueVideoFrameOutputs(frames: VideoFrameOutput[]): VideoFrameOutput[] {
  const seen = new Set<string>()
  return frames.filter((frame) => {
    if (!frame.outputPath || !Number.isFinite(frame.timestampMs)) return false
    const key = path.resolve(frame.outputPath).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function privateFrameOutputPath(outputPath: string, token: string, index: number): string {
  const extension = path.extname(outputPath) || '.jpg'
  const basename = path.basename(outputPath, path.extname(outputPath))
  return path.join(path.dirname(outputPath), `.${basename}.${token}-${index}.partial${extension}`)
}

function removeFilesBestEffort(filePaths: Iterable<string>): void {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {
      /* best-effort cleanup of private derived files */
    }
  }
}

/**
 * Extract a bounded, nearby group of frames after opening the source once.
 *
 * The caller is responsible for keeping the timestamp span bounded. Each
 * branch uses the same whole-second timestamp semantics as the legacy
 * per-frame helper. Outputs are first written to private files and are only
 * renamed into their manifest-owned paths after FFmpeg exits successfully.
 */
export async function generateVideoFramesSingleInputAsync(input: {
  filePath: string
  frames: Array<{ timestampMs: number; outputPath: string }>
  width?: number
  preferHardwareDecode?: boolean
}): Promise<{ ok: boolean; created: Set<string>; error?: string }> {
  const status = getFfmpegStatus()
  const created = new Set<string>()
  if (!status.ffmpeg.available) {
    return { ok: false, created, error: status.ffmpeg.error || 'ffmpeg is not available' }
  }

  const frames = uniqueVideoFrameOutputs(input.frames)
  if (frames.length === 0) return { ok: true, created }
  if (frames.length > MAX_SINGLE_INPUT_FRAME_BATCH) {
    return {
      ok: false,
      created,
      error: `single-input frame batch exceeds ${MAX_SINGLE_INPUT_FRAME_BATCH} outputs`,
    }
  }

  const width = Math.max(96, Math.min(640, Math.floor(input.width ?? 320)))
  const timestampsSeconds = frames.map((frame) => Math.max(0, Math.floor(frame.timestampMs / 1000)))
  const seekSeconds = Math.min(...timestampsSeconds)

  const run = async (hardware: boolean): Promise<{ ok: boolean; error?: string }> => {
    const token = `${process.pid}-${Date.now()}-${++temporaryMediaSequence}`
    const temporaryFrames = frames.map((frame, index) => ({
      ...frame,
      temporaryPath: privateFrameOutputPath(frame.outputPath, token, index),
    }))
    for (const frame of temporaryFrames)
      fs.mkdirSync(path.dirname(frame.outputPath), { recursive: true })

    const sourceLabels = frames.map((_, index) => `split${index}`)
    const outputLabels = frames.map((_, index) => `frame${index}`)
    const filters: string[] = []
    if (frames.length === 1) {
      filters.push('[0:v:0]null[split0]')
    } else {
      filters.push(
        `[0:v:0]split=${frames.length}${sourceLabels.map((label) => `[${label}]`).join('')}`,
      )
    }
    for (let index = 0; index < frames.length; index++) {
      const relativeSeconds = Math.max(0, timestampsSeconds[index] - seekSeconds)
      filters.push(
        `[${sourceLabels[index]}]trim=start=${relativeSeconds},setpts=PTS-STARTPTS,scale=${width}:-2[${outputLabels[index]}]`,
      )
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
    if (hardware) args.push('-hwaccel', 'auto')
    args.push(
      '-ss',
      String(seekSeconds),
      '-i',
      input.filePath,
      '-filter_complex',
      filters.join(';'),
    )
    for (let index = 0; index < temporaryFrames.length; index++) {
      args.push(
        '-map',
        `[${outputLabels[index]}]`,
        '-frames:v',
        '1',
        '-q:v',
        '5',
        temporaryFrames[index].temporaryPath,
      )
    }

    try {
      const spanSeconds = Math.max(...timestampsSeconds) - seekSeconds
      const result = await runToolAsync(status.ffmpeg.command, args, {
        timeoutMs: Math.max(30_000, Math.min(10 * 60_000, (spanSeconds + 15) * 4_000)),
        maxBuffer: 1024 * 1024,
      })
      if (result.error) return { ok: false, error: result.error }
      if (result.status !== 0) {
        return {
          ok: false,
          error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
        }
      }

      for (const frame of temporaryFrames) {
        try {
          const stat = fs.statSync(frame.temporaryPath)
          if (!stat.isFile() || stat.size === 0) continue
          fs.renameSync(frame.temporaryPath, frame.outputPath)
          created.add(frame.outputPath)
        } catch {
          /* A missing or uncommittable output is retried by the caller. */
        }
      }
      return {
        ok: created.size === frames.length,
        error: created.size === frames.length ? undefined : 'one or more frames were not created',
      }
    } finally {
      removeFilesBestEffort(temporaryFrames.map((frame) => frame.temporaryPath))
    }
  }

  try {
    if (input.preferHardwareDecode !== false) {
      const hardware = await run(true)
      if (hardware.ok) return { ok: true, created }
      if (created.size > 0) return { ok: false, created, error: hardware.error }
    }
    const cpu = await run(false)
    return cpu.ok ? { ok: true, created } : { ok: false, created, error: cpu.error }
  } catch (err: unknown) {
    return { ok: false, created, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface SubtitleStream {
  index: number
  codec: string
  language?: string
  title?: string
}

export interface SubtitleSegment {
  startMs: number
  endMs: number
  text: string
}

export function detectSubtitleStreams(filePath: string): {
  ok: boolean
  streams?: SubtitleStream[]
  error?: string
} {
  const status = getFfmpegStatus()
  if (!status.ffprobe.available) {
    return { ok: false, error: status.ffprobe.error || 'ffprobe is not available' }
  }
  try {
    const result = spawnSync(
      status.ffprobe.command,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', filePath],
      { encoding: 'utf-8', timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 },
    )
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffprobe exit ${result.status}`,
      }
    }
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{
        index?: unknown
        codec_name?: unknown
        tags?: { language?: unknown; title?: unknown }
      }>
    }
    const streams: SubtitleStream[] = (parsed.streams || [])
      .filter((s) => typeof s.codec_name === 'string')
      .map((s, i) => ({
        index: typeof s.index === 'number' ? s.index : i,
        codec: s.codec_name as string,
        language: typeof s.tags?.language === 'string' ? s.tags.language : undefined,
        title: typeof s.tags?.title === 'string' ? s.tags.title : undefined,
      }))
    return { ok: true, streams }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function extractSubtitleTrack(
  filePath: string,
  streamIndex: number,
  outputPath: string,
): { ok: boolean; path?: string; error?: string } {
  const status = getFfmpegStatus()
  if (!status.ffmpeg.available)
    return { ok: false, error: status.ffmpeg.error || 'ffmpeg is not available' }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const result = spawnSync(
      status.ffmpeg.command,
      ['-y', '-i', filePath, '-map', `0:s:${streamIndex}`, '-c:s', 'srt', outputPath],
      { encoding: 'utf-8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0 && !fs.existsSync(outputPath)) {
      return {
        ok: false,
        error: firstVersionLine(result.stderr || result.stdout) || `ffmpeg exit ${result.status}`,
      }
    }
    if (!fs.existsSync(outputPath)) return { ok: false, error: 'subtitle file was not created' }
    return { ok: true, path: outputPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function parseSrt(srtText: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = []
  const blocks = srtText.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/)
    if (lines.length < 2) continue
    const tsLine = lines.find((l) => /-->/.test(l))
    if (!tsLine) continue
    const m = tsLine.match(
      /(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})/,
    )
    if (!m) continue
    const startMs =
      Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4])
    const endMs = Number(m[5]) * 3600000 + Number(m[6]) * 60000 + Number(m[7]) * 1000 + Number(m[8])
    const text = lines
      .filter((l) => l !== tsLine && !/^\d+$/.test(l.trim()))
      .join(' ')
      .trim()
    if (text) segments.push({ startMs, endMs, text })
  }
  return segments
}
