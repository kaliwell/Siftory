import { BrowserWindow, ipcMain, session } from 'electron'
import path from 'path'
import os from 'os'
import { decideThumbnailGpuResources } from './thumbnailGpuResourcePolicy'

const GPU_READY_CHANNEL = 'thumbnail-gpu-internal:ready'
const GPU_RESULT_CHANNEL = 'thumbnail-gpu-internal:result'
const GPU_JOB_CHANNEL = 'thumbnail-gpu-internal:job'
const GPU_CANCEL_CHANNEL = 'thumbnail-gpu-internal:cancel'
const GPU_RENDER_TIMEOUT_MS = 30_000
const MAX_GPU_POOL_SIZE = 8
const MAX_GPU_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_GPU_OUTPUT_BYTES = 8 * 1024 * 1024
const MIN_GPU_DIMENSION = 32
const MAX_GPU_DIMENSION = 256
const GPU_PARTITION = 'thumbnail-gpu-isolated'
const GPU_INPUT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/x-icon',
])

export interface ThumbnailGpuCapability {
  available: boolean
  device?: string
  error?: string
}

export interface ThumbnailGpuRenderResult {
  dataUrl: string
  device: string
}

interface PendingRender {
  resolve: (result: ThumbnailGpuRenderResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ReadyMessage {
  available?: boolean
  device?: string
  error?: string
}

interface ResultMessage {
  id?: number
  ok?: boolean
  bytes?: Uint8Array
  mime?: string
  error?: string
}

let gpuSessionLockedDown = false

function lockDownGpuSession(): void {
  if (gpuSessionLockedDown) return
  const gpuSession = session.fromPartition(GPU_PARTITION)
  gpuSession.setPermissionCheckHandler(() => false)
  gpuSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  gpuSessionLockedDown = true
}

const GPU_RENDERER_HTML = String.raw`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'">
</head>
<body>
<canvas id="surface" width="1" height="1"></canvas>
<script>
(() => {
  const bridge = window.thumbnailGpuBridge
  const canvas = document.getElementById('surface')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance'
  }) || canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance'
  })

  function compileShader(type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed')
    }
    return shader
  }

  function createProgram() {
    const vertex = compileShader(gl.VERTEX_SHADER,
      'attribute vec2 a_position;' +
      'varying vec2 v_texCoord;' +
      'void main(){gl_Position=vec4(a_position,0.0,1.0);' +
      'v_texCoord=vec2((a_position.x+1.0)*0.5,1.0-(a_position.y+1.0)*0.5);}')
    const fragment = compileShader(gl.FRAGMENT_SHADER,
      'precision mediump float;' +
      'uniform sampler2D u_image;' +
      'varying vec2 v_texCoord;' +
      'void main(){gl_FragColor=texture2D(u_image,v_texCoord);}')
    const program = gl.createProgram()
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'WebGL program link failed')
    }
    gl.detachShader(program, vertex)
    gl.detachShader(program, fragment)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return program
  }

  if (!gl) {
    bridge.reportReady({ available: false, error: 'WebGL is unavailable' })
    return
  }

  let program
  let positionBuffer
  let texture
  let device = 'WebGL GPU'
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    if (debug) device = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) || device)
    if (/swiftshader|llvmpipe|software rasterizer/i.test(device)) {
      bridge.reportReady({
        available: false,
        device,
        error: 'Only a software WebGL renderer is available'
      })
      return
    }
    program = createProgram()
    positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    )
    gl.useProgram(program)
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // ImageBitmap uploads do not consistently honor UNPACK_FLIP_Y_WEBGL.
    // The vertex shader performs the Y conversion explicitly instead.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    bridge.reportReady({ available: true, device })
  } catch (error) {
    bridge.reportReady({
      available: false,
      device,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  async function decode(job) {
    const bytes = job.bytes instanceof Uint8Array ? job.bytes : new Uint8Array(job.bytes)
    const blob = new Blob([bytes], { type: job.mime })
    const resize = Number.isInteger(job.targetWidth) && Number.isInteger(job.targetHeight)
      ? { resizeWidth: job.targetWidth, resizeHeight: job.targetHeight, resizeQuality: 'high' }
      : {}
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image', ...resize })
    } catch {
      return createImageBitmap(blob, resize)
    }
  }

  async function render(job, decoded) {
    let bitmap
    try {
      bitmap = await decoded
      if (!bitmap.width || !bitmap.height) throw new Error('GPU decoder returned an empty image')
      const ratio = Math.min(1, job.maxDim / bitmap.width, job.maxDim / bitmap.height)
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap
      )
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      const output = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error('WebP encoder returned no data')),
          'image/webp',
          0.8
        )
      })
      const outputBytes = new Uint8Array(await output.arrayBuffer())
      if (cancelled.delete(job.id)) return
      bridge.reportResult({
        id: job.id,
        ok: true,
        bytes: outputBytes,
        mime: output.type || 'image/webp'
      })
    } catch (error) {
      if (cancelled.delete(job.id)) return
      bridge.reportResult({
        id: job.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (bitmap) bitmap.close()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0])
      )
      canvas.width = 1
      canvas.height = 1
    }
  }

  const cancelled = new Set()
  bridge.onCancel((id) => cancelled.add(id))
  let queue = Promise.resolve()
  bridge.onJob((job) => {
    if (cancelled.delete(job.id)) return
    const decoded = decode(job)
    decoded.catch(() => {})
    queue = queue.then(() => render(job, decoded), () => render(job, decoded))
  })
})()
</script>
</body>
</html>
`

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class ThumbnailGpuRenderer {
  private window: BrowserWindow | null = null
  private readyPromise: Promise<ThumbnailGpuCapability> | null = null
  private capability: ThumbnailGpuCapability = { available: false, error: 'Not initialized' }
  private nextRequestId = 1
  private pending = new Map<number, PendingRender>()

  initialize(): Promise<ThumbnailGpuCapability> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise<ThumbnailGpuCapability>((resolve) => {
      lockDownGpuSession()
      const worker = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        paintWhenInitiallyHidden: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'thumbnailGpuPreload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: GPU_PARTITION,
          backgroundThrottling: false,
          webSecurity: true,
        },
      })
      this.window = worker
      worker.setMenuBarVisibility(false)
      worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      worker.webContents.on('will-navigate', (event) => event.preventDefault())
      worker.webContents.on('will-attach-webview', (event) => event.preventDefault())

      let settled = false
      const readyTimer = setTimeout(() => {
        finish({ available: false, error: 'GPU renderer startup timed out' })
      }, GPU_RENDER_TIMEOUT_MS)

      const finish = (capability: ThumbnailGpuCapability) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        ipcMain.removeListener(GPU_READY_CHANNEL, onReady)
        this.capability = capability
        resolve(capability)
      }

      const onReady = (event: Electron.IpcMainEvent, message: ReadyMessage) => {
        if (event.sender.id !== worker.webContents.id) return
        finish({
          available: message?.available === true,
          device: message?.device,
          error: message?.error,
        })
      }
      ipcMain.on(GPU_READY_CHANNEL, onReady)

      const onResult = (event: Electron.IpcMainEvent, message: ResultMessage) => {
        if (event.sender.id !== worker.webContents.id) return
        const id = Number(message?.id)
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (!message.ok || !message.bytes) {
          pending.reject(new Error(message.error || 'GPU thumbnail render failed'))
          return
        }
        const mime = typeof message.mime === 'string' ? message.mime : 'image/webp'
        if (mime !== 'image/webp') {
          pending.reject(new Error('GPU thumbnail renderer returned an unsupported format'))
          return
        }
        const bytes = Buffer.from(message.bytes)
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_GPU_OUTPUT_BYTES) {
          pending.reject(new Error('GPU thumbnail renderer returned an invalid output size'))
          return
        }
        pending.resolve({
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
          device: this.capability.device || 'WebGL GPU',
        })
      }
      ipcMain.on(GPU_RESULT_CHANNEL, onResult)

      worker.on('closed', () => {
        ipcMain.removeListener(GPU_READY_CHANNEL, onReady)
        ipcMain.removeListener(GPU_RESULT_CHANNEL, onResult)
        finish({ available: false, error: 'GPU thumbnail renderer closed during startup' })
        this.window = null
        this.readyPromise = null
        const error = new Error('GPU thumbnail renderer closed')
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
      })

      void worker
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GPU_RENDERER_HTML)}`)
        .catch((error) => finish({ available: false, error: errorMessage(error) }))
    })
    return this.readyPromise
  }

  render(
    bytes: Buffer,
    mime: string,
    maxDim: number,
    targetWidth?: number,
    targetHeight?: number,
  ): Promise<ThumbnailGpuRenderResult> {
    if (!GPU_INPUT_MIMES.has(mime))
      return Promise.reject(new Error('Unsupported GPU thumbnail input format'))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_GPU_SOURCE_BYTES)
      return Promise.reject(new Error('GPU thumbnail input exceeds the safe size limit'))
    if (!Number.isInteger(maxDim) || maxDim < MIN_GPU_DIMENSION || maxDim > MAX_GPU_DIMENSION)
      return Promise.reject(new Error('GPU thumbnail dimension is outside the safe range'))
    return this.initialize().then(async (capability) => {
      if (!capability.available || !this.window || this.window.isDestroyed()) {
        throw new Error(capability.error || 'GPU thumbnail renderer is unavailable')
      }
      const id = this.nextRequestId++
      return new Promise<ThumbnailGpuRenderResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          this.window?.webContents.send(GPU_CANCEL_CHANNEL, id)
          reject(new Error('GPU thumbnail render timed out'))
        }, GPU_RENDER_TIMEOUT_MS)
        this.pending.set(id, { resolve, reject, timer })
        this.window?.webContents.send(GPU_JOB_CHANNEL, {
          id,
          bytes,
          mime,
          maxDim,
          targetWidth,
          targetHeight,
        })
      })
    })
  }

  dispose(): void {
    const error = new Error('GPU thumbnail renderer disposed')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.readyPromise = null
  }
}

export class ThumbnailGpuPool {
  private readonly renderers: ThumbnailGpuRenderer[]
  private readonly sourceByteBudget: number
  private activeSourceBytes = 0
  private byteWaiters: Array<{
    bytes: number
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  private nextRenderer = 0

  constructor(jobCount = 4) {
    const decision = decideThumbnailGpuResources({
      requestedLanes: Math.max(1, Math.min(MAX_GPU_POOL_SIZE, Math.floor(jobCount) || 4)),
      totalSystemMemoryBytes: os.totalmem(),
      freeSystemMemoryBytes: os.freemem(),
    })
    this.sourceByteBudget = decision.inFlightSourceBytes
    this.renderers = Array.from({ length: decision.lanes }, () => new ThumbnailGpuRenderer())
  }

  get size(): number {
    return this.renderers.length
  }

  async initialize(): Promise<ThumbnailGpuCapability> {
    const capabilities = await Promise.all(this.renderers.map((renderer) => renderer.initialize()))
    const available = capabilities.find((capability) => capability.available)
    if (available) return available
    return {
      available: false,
      device: capabilities.find((capability) => capability.device)?.device,
      error: capabilities
        .map((capability) => capability.error)
        .filter(Boolean)
        .join('; '),
    }
  }

  async withSourceBudget<T>(bytes: number, task: () => Promise<T>): Promise<T> {
    const boundedBytes = Math.max(1, Math.min(MAX_GPU_SOURCE_BYTES, Math.floor(bytes)))
    if (this.activeSourceBytes + boundedBytes > this.sourceByteBudget) {
      await new Promise<void>((resolve, reject) =>
        this.byteWaiters.push({ bytes: boundedBytes, resolve, reject }),
      )
    } else {
      this.activeSourceBytes += boundedBytes
    }
    try {
      return await task()
    } finally {
      this.activeSourceBytes = Math.max(0, this.activeSourceBytes - boundedBytes)
      for (let index = 0; index < this.byteWaiters.length; index += 1) {
        const waiter = this.byteWaiters[index]
        if (this.activeSourceBytes + waiter.bytes > this.sourceByteBudget) continue
        this.byteWaiters.splice(index, 1)
        this.activeSourceBytes += waiter.bytes
        waiter.resolve()
        break
      }
    }
  }

  renderReserved(
    bytes: Buffer,
    mime: string,
    maxDim: number,
    targetWidth?: number,
    targetHeight?: number,
  ): Promise<ThumbnailGpuRenderResult> {
    const renderer = this.renderers[this.nextRenderer % this.renderers.length]
    this.nextRenderer += 1
    return renderer.render(bytes, mime, maxDim, targetWidth, targetHeight)
  }

  render(bytes: Buffer, mime: string, maxDim: number): Promise<ThumbnailGpuRenderResult> {
    return this.withSourceBudget(bytes.byteLength, () => this.renderReserved(bytes, mime, maxDim))
  }

  dispose(): void {
    const error = new Error('GPU thumbnail pool disposed')
    for (const waiter of this.byteWaiters) waiter.reject(error)
    this.byteWaiters = []
    for (const renderer of this.renderers) renderer.dispose()
  }
}
