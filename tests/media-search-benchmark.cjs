const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')

const repoRoot = path.resolve(__dirname, '..')
const targetRoot = process.argv[2] || path.join(os.homedir(), 'Downloads')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 0) : Infinity
const jsonOutArg = process.argv.find((arg) => arg.startsWith('--json-out='))
const jsonOut = jsonOutArg ? jsonOutArg.slice('--json-out='.length) : ''
const thumbDir = path.join(os.tmpdir(), 'floating-clock-media-benchmark-thumbs')
const videoExts = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.m4v', '.flv', '.ts', '.mts', '.m2ts'])

function nowNs() {
  return process.hrtime.bigint()
}

function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6
}

function round(n, digits = 2) {
  const m = 10 ** digits
  return Math.round(n * m) / m
}

function mb(bytes) {
  return round(bytes / 1024 / 1024)
}

function isVideo(filePath) {
  return videoExts.has(path.extname(filePath).toLowerCase())
}

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = [
    path.join(repoRoot, 'tools', 'ffmpeg', 'bin', exe),
    path.join(repoRoot, 'tools', 'ffmpeg', exe),
    exe,
  ]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) return candidate
    if (fs.existsSync(candidate)) return candidate
  }
  return exe
}

function enumerateVideos(root) {
  const started = nowNs()
  const videos = []
  let entries = 0
  let dirs = 0
  let failed = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    entries++
    let stat
    try {
      stat = fs.statSync(current)
    } catch {
      failed++
      continue
    }
    if (stat.isFile()) {
      if (isVideo(current)) {
        videos.push({ path: current, sizeBytes: stat.size, mtimeMs: stat.mtimeMs })
        if (videos.length >= limit) break
      }
      continue
    }
    if (!stat.isDirectory()) continue
    dirs++
    let children
    try {
      children = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      failed++
      continue
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(path.join(current, children[i].name))
    }
  }
  return { videos, entries, dirs, failed, elapsedMs: msSince(started) }
}

function sampleProcess(pid) {
  if (process.platform !== 'win32') return null
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `try { $p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write("$($p.CPU)|$($p.WorkingSet64)") } catch {}`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 1000 },
  )
  const text = String(ps.stdout || '').trim()
  if (!text) return null
  const [cpu, ws] = text.split('|').map(Number)
  return {
    cpuSeconds: Number.isFinite(cpu) ? cpu : 0,
    workingSetBytes: Number.isFinite(ws) ? ws : 0,
  }
}

function runMeasured(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = nowNs()
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let peakWorkingSetBytes = 0
    let firstCpuSeconds = null
    let lastCpuSeconds = 0
    let samples = 0
    const sampler = setInterval(() => {
      const sample = sampleProcess(child.pid)
      if (!sample) return
      samples++
      if (firstCpuSeconds === null) firstCpuSeconds = sample.cpuSeconds
      lastCpuSeconds = sample.cpuSeconds
      peakWorkingSetBytes = Math.max(peakWorkingSetBytes, sample.workingSetBytes)
    }, 200)
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The child may already have exited between the timeout and kill attempt.
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024)
    })
    child.on('error', (err) => {
      clearInterval(sampler)
      clearTimeout(timer)
      resolve({
        ok: false,
        elapsedMs: msSince(started),
        cpuSeconds: 0,
        peakWorkingSetBytes,
        error: err.message,
        stdout,
        stderr,
      })
    })
    child.on('exit', (code, signal) => {
      clearInterval(sampler)
      clearTimeout(timer)
      const sample = sampleProcess(child.pid)
      if (sample) {
        samples++
        if (firstCpuSeconds === null) firstCpuSeconds = sample.cpuSeconds
        lastCpuSeconds = sample.cpuSeconds
        peakWorkingSetBytes = Math.max(peakWorkingSetBytes, sample.workingSetBytes)
      }
      resolve({
        ok: code === 0,
        code,
        signal,
        elapsedMs: msSince(started),
        cpuSeconds: Math.max(0, lastCpuSeconds - (firstCpuSeconds ?? lastCpuSeconds)),
        peakWorkingSetBytes,
        samples,
        stdout,
        stderr,
      })
    })
  })
}

function parseMetadata(json) {
  try {
    const parsed = JSON.parse(json)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const video = streams.find((stream) => stream.codec_type === 'video') || {}
    const audio = streams.find((stream) => stream.codec_type === 'audio') || {}
    return {
      durationMs: parsed.format?.duration ? Math.round(Number(parsed.format.duration) * 1000) : undefined,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
    }
  } catch {
    return {}
  }
}

function idFor(filePath) {
  return crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex')
}

async function main() {
  fs.mkdirSync(thumbDir, { recursive: true })
  const ffprobe = findTool('ffprobe')
  const ffmpeg = findTool('ffmpeg')
  const totalStarted = nowNs()
  const procStartCpu = process.cpuUsage()
  const enumResult = enumerateVideos(targetRoot)
  const rows = []
  let metadataOk = 0
  let metadataFailed = 0
  let thumbOk = 0
  let thumbFailed = 0
  let metadataMs = 0
  let thumbnailMs = 0
  let childCpuSeconds = 0
  let childPeakWorkingSetBytes = 0

  for (const video of enumResult.videos) {
    const ffprobeResult = await runMeasured(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video.path],
      10000,
    )
    metadataMs += ffprobeResult.elapsedMs
    childCpuSeconds += ffprobeResult.cpuSeconds
    childPeakWorkingSetBytes = Math.max(childPeakWorkingSetBytes, ffprobeResult.peakWorkingSetBytes)
    if (ffprobeResult.ok) metadataOk++
    else metadataFailed++
    const metadata = ffprobeResult.ok ? parseMetadata(ffprobeResult.stdout) : {}
    const outputPath = path.join(thumbDir, `${idFor(video.path)}.jpg`)
    const timestampSeconds = Math.max(1, Math.min(5, Math.floor((metadata.durationMs || 10000) / 10000)))
    const ffmpegResult = await runMeasured(
      ffmpeg,
      [
        '-y',
        '-ss',
        String(timestampSeconds),
        '-i',
        video.path,
        '-frames:v',
        '1',
        '-vf',
        'scale=320:-2',
        '-q:v',
        '5',
        outputPath,
      ],
      15000,
    )
    thumbnailMs += ffmpegResult.elapsedMs
    childCpuSeconds += ffmpegResult.cpuSeconds
    childPeakWorkingSetBytes = Math.max(childPeakWorkingSetBytes, ffmpegResult.peakWorkingSetBytes)
    if (ffmpegResult.ok && fs.existsSync(outputPath)) thumbOk++
    else thumbFailed++
    rows.push({
      name: path.basename(video.path),
      sizeMb: mb(video.sizeBytes),
      metadataMs: round(ffprobeResult.elapsedMs),
      thumbnailMs: round(ffmpegResult.elapsedMs),
      metadataOk: ffprobeResult.ok,
      thumbnailOk: ffmpegResult.ok && fs.existsSync(outputPath),
      childCpuSeconds: round(ffprobeResult.cpuSeconds + ffmpegResult.cpuSeconds, 3),
      peakChildMemMb: mb(Math.max(ffprobeResult.peakWorkingSetBytes, ffmpegResult.peakWorkingSetBytes)),
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
      path: video.path,
    })
  }

  const procCpu = process.cpuUsage(procStartCpu)
  const totalMs = msSince(totalStarted)
  const result = {
    targetRoot,
    limit: Number.isFinite(limit) ? limit : null,
    ffprobe,
    ffmpeg,
    totalMs: round(totalMs),
    enumerate: {
      entries: enumResult.entries,
      dirs: enumResult.dirs,
      failed: enumResult.failed,
      videos: enumResult.videos.length,
      elapsedMs: round(enumResult.elapsedMs),
      percentOfTotal: round((enumResult.elapsedMs / totalMs) * 100),
    },
    metadata: {
      ok: metadataOk,
      failed: metadataFailed,
      elapsedMs: round(metadataMs),
      avgMs: round(metadataMs / Math.max(1, enumResult.videos.length)),
      percentOfTotal: round((metadataMs / totalMs) * 100),
    },
    thumbnails: {
      ok: thumbOk,
      failed: thumbFailed,
      elapsedMs: round(thumbnailMs),
      avgMs: round(thumbnailMs / Math.max(1, enumResult.videos.length)),
      percentOfTotal: round((thumbnailMs / totalMs) * 100),
    },
    process: {
      nodeCpuSeconds: round((procCpu.user + procCpu.system) / 1e6, 3),
      childCpuSeconds: round(childCpuSeconds, 3),
      childCpuToWallRatio: round(childCpuSeconds / Math.max(0.001, totalMs / 1000) * 100),
      nodePeakMemoryMbApprox: mb(process.memoryUsage().rss),
      childPeakMemoryMb: mb(childPeakWorkingSetBytes),
    },
    rows,
  }
  const json = JSON.stringify(result, null, 2)
  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true })
    fs.writeFileSync(jsonOut, json, 'utf8')
  }
  console.log(json)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
