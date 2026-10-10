const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const http = require('node:http')

function localTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: '127.0.0.1', port, path: '/json/list', agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200)
              throw new Error('Target discovery status ' + response.statusCode)
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.setTimeout(2500, () =>
      request.destroy(new Error('Loopback target discovery timed out')),
    )
    request.on('error', reject)
  })
}

function loopbackEndpoint(raw, protocol, requiredPort) {
  const url = new URL(raw)
  if (
    url.protocol !== protocol ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    (requiredPort && url.port !== requiredPort)
  )
    throw new Error('Media probe requires the launched loopback debugging endpoint')
  return url
}

function audioProbeExpression() {
  return `(${async function () {
    const sampleRate = 16000
    const samples = 16000
    const wav = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(wav)
    const ascii = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
    }
    ascii(0, 'RIFF')
    view.setUint32(4, wav.byteLength - 8, true)
    ascii(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    ascii(36, 'data')
    view.setUint32(40, samples * 2, true)
    for (let i = 0; i < samples; i++) {
      view.setInt16(
        44 + i * 2,
        Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
        true,
      )
    }
    const context = new AudioContext({ sampleRate })
    let decoded
    try {
      decoded = await context.decodeAudioData(wav.slice(0))
    } finally {
      await context.close()
    }
    let maxDifference = 0
    const pcm = decoded.getChannelData(0)
    for (let i = 0; i < samples; i++) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(pcm[i] - view.getInt16(44 + i * 2, true) / 32768),
      )
    }
    // Web Audio float normalization can differ from integer / 32768. Require
    // less than half a 16-bit PCM step; baseline and replacement float digests
    // are compared separately by the replacement audit.
    const sampleTolerance = 0.5 / 32768
    const digest = await crypto.subtle.digest('SHA-256', pcm.buffer)
    const decodedPcmSha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    const audio = document.createElement('audio')
    audio.muted = true
    audio.preload = 'auto'
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    const events = []
    for (const type of ['loadedmetadata', 'canplay', 'playing', 'seeked', 'ended', 'error']) {
      audio.addEventListener(type, () => events.push({ type, time: audio.currentTime }))
    }
    const wait = (type) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Media event timed out: ' + type)), 6000)
        audio.addEventListener(
          type,
          () => {
            clearTimeout(timeout)
            resolve(true)
          },
          { once: true },
        )
        audio.addEventListener(
          'error',
          () => {
            clearTimeout(timeout)
            reject(new Error('HTML audio error ' + audio.error?.code))
          },
          { once: true },
        )
      })
    try {
      const metadata = wait('loadedmetadata')
      audio.src = url
      document.body.append(audio)
      await metadata
      const seek = wait('seeked')
      audio.currentTime = 0.4
      await seek
      const ended = wait('ended')
      await audio.play()
      await ended
      return {
        ok:
          decoded.length === samples &&
          decoded.sampleRate === sampleRate &&
          decoded.numberOfChannels === 1 &&
          maxDifference <= sampleTolerance &&
          audio.ended &&
          audio.currentTime >= 0.99,
        decodedSamples: decoded.length,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        maxDifference,
        sampleTolerance,
        decodedPcmSha256,
        duration: audio.duration,
        ended: audio.ended,
        currentTime: audio.currentTime,
        events,
        syntheticInputOnly: true,
        rendererUrl: location.href,
      }
    } finally {
      audio.pause()
      audio.remove()
      URL.revokeObjectURL(url)
    }
  }.toString()})()`
}

async function runMediaProbe({ browserEndpoint, mainPid, packageDirectory, reportPath }) {
  const browser = loopbackEndpoint(browserEndpoint, 'ws:')
  const deadline = Date.now() + 15000
  let target
  const discovery = []
  while (Date.now() < deadline) {
    let targets
    try {
      targets = await localTargets(browser.port)
    } catch (error) {
      discovery.push({ error: String(error) })
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    target = targets.find(
      (item) =>
        item.type === 'page' &&
        item.url.startsWith('file:') &&
        /\/dist\/index\.html$/.test(item.url),
    )
    if (target) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!target)
    throw new Error('The packaged Siftory renderer was not found: ' + JSON.stringify(discovery))
  const endpoint = loopbackEndpoint(target.webSocketDebuggerUrl, 'ws:', browser.port)
  const socket = new WebSocket(endpoint)
  const pending = new Map()
  const mediaEvents = []
  let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(waiter.timeout)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    } else if (message.method?.startsWith('Media.')) mediaEvents.push(message)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Media debugging connection closed before completion'))
    }
    pending.clear()
  })
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(method + ' timed out'))
      }, 12000)
      pending.set(id, { resolve, reject, timeout })
      socket.send(JSON.stringify({ id, method, params }))
    })
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Media debugging connection timed out')),
        3000,
      )
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout)
          reject(new Error('Media debugging connection failed'))
        },
        { once: true },
      )
    })
    await command('Media.enable')
    const evaluated = await command('Runtime.evaluate', {
      expression: audioProbeExpression(),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails))
    const audio = evaluated.result.value
    const propertiesDeadline = Date.now() + 4000
    while (
      Date.now() < propertiesDeadline &&
      !mediaEvents.some((event) => /FFmpegAudioDecoder|FFmpegDemuxer/.test(JSON.stringify(event)))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const observation = spawnSync(
      'python',
      [
        path.join(__dirname, 'windows-ffmpeg-module-probe.py'),
        String(mainPid),
        path.join(packageDirectory, 'ffmpeg.dll'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    )
    if (observation.status !== 0) throw new Error(observation.stderr || observation.stdout)
    const modules = JSON.parse(observation.stdout)
    const ffmpegDecoderObserved = mediaEvents.some((event) =>
      /FFmpegAudioDecoder|FFmpegDemuxer/.test(JSON.stringify(event)),
    )
    const report = {
      ok: audio.ok && modules.ok && ffmpegDecoderObserved,
      audio,
      modules,
      ffmpegDecoderObserved,
      mediaEvents,
      discovery,
      productRendererUnmodified: true,
      scope:
        'Synthetic WAV Web Audio sample equality plus HTML audio seek/play/end in the actual packaged renderer, with read-only loaded DLL code observation. Not complete codec, video, install, signature or legal approval validation.',
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    socket.close()
  }
}

module.exports = { audioProbeExpression, loopbackEndpoint, runMediaProbe }
