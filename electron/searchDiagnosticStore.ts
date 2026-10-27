import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactDiagnosticText } from './diagnosticRedaction'

const LIMIT = 4 * 1024 * 1024
const RETENTION = 14 * 24 * 60 * 60 * 1000
const FILES = 5
const INPUT_LIMIT = 64 * 1024 * 1024

/** Bounded, serialized, local-only diagnostics. No image bytes or embeddings are stored. */
export class SearchDiagnosticStore {
  readonly sessionId = crypto.randomUUID()
  private queue = Promise.resolve()
  private queued = 0
  private key?: Buffer
  private initialization?: Promise<void>
  private fingerprints = 0
  private observations = new Set<Promise<unknown>>()
  dropped = 0
  error?: string

  constructor(
    private directory: string,
    private version: string,
    private limit = LIMIT,
  ) {}

  private initialize(): Promise<void> {
    if (this.key) return Promise.resolve()
    if (!this.initialization) {
      this.initialization = this.initializeKey().finally(() => {
        this.initialization = undefined
      })
    }
    return this.initialization
  }

  private async initializeKey(): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const keyPath = path.join(this.directory, 'identity-key')
    try {
      await fs.promises.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const key = await fs.promises.readFile(keyPath)
    if (key.length !== 32) throw new Error('Invalid diagnostic identity key')
    this.key = key
  }

  private file(index: number): string {
    return path.join(this.directory, `search-${index}.jsonl`)
  }

  async identity(value: string): Promise<string> {
    await this.initialize()
    return crypto.createHmac('sha256', this.key!).update(value).digest('hex').slice(0, 24)
  }

  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[bounded]'
    if (typeof value === 'string')
      return redactDiagnosticText(value, 512).replace(/\/[^\s"']+/g, '[path]')
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (value === null || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.sanitize(v, depth + 1))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 50)
          .map(([k, v]) => [
            k.slice(0, 64),
            /password|token|secret|path|directory|filename|imageId/i.test(k)
              ? '[redacted]'
              : this.sanitize(v, depth + 1),
          ]),
      )
    }
    return undefined
  }

  append(traceId: string, event: string, detail: unknown = {}): void {
    if (this.queued >= 128) {
      this.dropped++
      return
    }
    const line =
      JSON.stringify({
        schema: 1,
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        traceId,
        event,
        version: this.version,
        detail: this.sanitize(detail),
      }) + '\n'
    if (Buffer.byteLength(line) > Math.min(32_768, this.limit)) {
      this.dropped++
      return
    }
    this.queued++
    this.queue = this.queue
      .then(async () => {
        await this.initialize()
        for (let i = 0; i < FILES; i++) {
          const stat = await fs.promises.stat(this.file(i)).catch(() => null)
          if (stat && Date.now() - stat.mtimeMs > RETENTION) await fs.promises.unlink(this.file(i))
        }
        await this.queryCopies()
        const size = (await fs.promises.stat(this.file(0)).catch(() => null))?.size ?? 0
        if (size + Buffer.byteLength(line) > this.limit) {
          await fs.promises.rm(this.file(FILES - 1), { force: true })
          for (let i = FILES - 2; i >= 0; i--) {
            await fs.promises
              .rename(this.file(i), this.file(i + 1))
              .catch((e: NodeJS.ErrnoException) => {
                if (e.code !== 'ENOENT') throw e
              })
          }
        }
        const handle = await fs.promises
          .open(this.file(0), 'r+')
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return null
          })
        if (handle) {
          try {
            const size = (await handle.stat()).size
            if (size) {
              const last = Buffer.alloc(1)
              await handle.read(last, 0, 1, size - 1)
              if (last[0] !== 10) {
                const tail = Buffer.alloc(Math.min(size, 32768))
                await handle.read(tail, 0, tail.length, size - tail.length)
                const newline = tail.lastIndexOf(10)
                await handle.truncate(newline < 0 ? 0 : size - tail.length + newline + 1)
              }
            }
          } finally {
            await handle.close()
          }
        }
        await fs.promises.appendFile(this.file(0), line, { mode: 0o600 })
        this.error = undefined
      })
      .catch((e: unknown) => {
        this.error = redactDiagnosticText(String(e))
        this.dropped++
      })
      .finally(() => {
        this.queued--
      })
  }

  async fingerprint(filePath: string): Promise<Record<string, unknown>> {
    if (this.fingerprints >= 2) return { status: 'busy' }
    this.fingerprints++
    try {
      await this.initialize()
      const before = await fs.promises.stat(filePath)
      const pathId = await this.identity(path.resolve(filePath).toLowerCase())
      if (!before.isFile() || before.size > INPUT_LIMIT)
        return { pathId, bytes: before.size, status: 'size-limit' }
      const handle = await fs.promises.open(filePath, 'r')
      const header = Buffer.alloc(Math.min(before.size, 65536))
      try {
        await handle.read(header, 0, header.length, 0)
      } finally {
        await handle.close()
      }
      const dimensions = queryImageDimensions(header)
      const hash = crypto.createHash('sha256')
      let bytes = 0
      for await (const chunk of fs.createReadStream(filePath)) {
        bytes += chunk.length
        if (bytes > INPUT_LIMIT) return { pathId, status: 'size-limit' }
        hash.update(chunk)
      }
      const after = await fs.promises.stat(filePath)
      return {
        pathId,
        bytes,
        ...dimensions,
        sha256: hash.digest('hex'),
        status:
          before.size === after.size && before.mtimeMs === after.mtimeMs
            ? 'stable'
            : 'changed-during-read',
      }
    } catch (e) {
      return { status: 'unavailable', error: redactDiagnosticText(String(e)) }
    } finally {
      this.fingerprints--
    }
  }

  track<T>(operation: Promise<T>): void {
    const safe = operation.catch(() => {
      this.dropped++
    })
    this.observations.add(safe)
    void safe.finally(() => this.observations.delete(safe))
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.observations])
    await this.queue
  }

  async snapshot(): Promise<Record<string, unknown>> {
    await this.flush()
    const records: unknown[] = []
    for (let i = FILES - 1; i >= 0; i--) {
      const stat = await fs.promises.stat(this.file(i)).catch(() => null)
      if (!stat || stat.size > this.limit || Date.now() - stat.mtimeMs > RETENTION) continue
      const text = await fs.promises.readFile(this.file(i), 'utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          records.push(JSON.parse(line))
        } catch {
          /* interrupted final record */
        }
      }
    }
    return {
      schema: 1,
      exportedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      version: this.version,
      dropped: this.dropped,
      error: this.error,
      limits: {
        totalBytes: FILES * this.limit,
        retentionDays: 14,
        candidatesPerStage: 50,
      },
      containsImageBytes: false,
      records,
    }
  }

  async saveQueryCopy(traceId: string, filePath: string, expectedHash: string): Promise<boolean> {
    if (!/^[a-f0-9-]{36}$/.test(traceId)) return false
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return false
    const bytes = await fs.promises.readFile(filePath)
    if (
      bytes.length > 2 * 1024 * 1024 ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash
    )
      return false
    const text = JSON.stringify({
      traceId,
      sha256: expectedHash,
      ...queryImageDimensions(bytes.subarray(0, 65536)),
      bytes: bytes.length,
      base64: bytes.toString('base64'),
    })
    const write = this.queue.then(async () => {
      await this.initialize()
      const copies = await this.queryCopies()
      let total = copies.reduce((sum, item) => sum + item.size, 0)
      while (
        copies.length &&
        (copies.length >= 4 || total + Buffer.byteLength(text) > 8 * 1024 * 1024)
      ) {
        const oldest = copies.shift()!
        await fs.promises.rm(path.join(this.directory, oldest.name), { force: true })
        total -= oldest.size
      }
      await fs.promises.writeFile(path.join(this.directory, `copy-${traceId}.json`), text, {
        mode: 0o600,
      })
    })
    this.queue = write.catch((error: unknown) => {
      this.error = redactDiagnosticText(String(error))
      this.dropped++
    })
    await write
    this.append(traceId, 'query-copy-saved', { sha256: expectedHash, bytes: bytes.length })
    return true
  }

  private async queryCopies(): Promise<Array<{ name: string; size: number; time: number }>> {
    const files = await fs.promises.readdir(this.directory).catch(() => [])
    const valid = []
    for (const name of files.filter((name) => /^copy-[a-f0-9-]{36}\.json$/.test(name))) {
      const stat = await fs.promises.lstat(path.join(this.directory, name))
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if (Date.now() - stat.mtimeMs > RETENTION) {
        await fs.promises.rm(path.join(this.directory, name), { force: true })
        continue
      }
      valid.push({ name, size: stat.size, time: stat.mtimeMs })
    }
    return valid.sort((a, b) => a.time - b.time)
  }

  async exportQueryCopies(): Promise<unknown[]> {
    await this.flush()
    const copies = await this.queryCopies()
    const result: unknown[] = []
    let bytes = 0
    for (const copy of copies.slice(-4)) {
      bytes += copy.size
      if (copy.size > 3 * 1024 * 1024 || bytes > 8 * 1024 * 1024) break
      try {
        result.push(
          JSON.parse(await fs.promises.readFile(path.join(this.directory, copy.name), 'utf8')),
        )
      } catch {
        /* interrupted explicit capture */
      }
    }
    return result
  }

  async clear(): Promise<void> {
    await this.flush()
    this.queue = this.queue.then(async () => {
      for (let i = 0; i < FILES; i++) await fs.promises.rm(this.file(i), { force: true })
      for (const copy of await this.queryCopies())
        await fs.promises.rm(path.join(this.directory, copy.name), { force: true })
    })
    await this.queue
  }
}

/** Header-only dimensions: never decode a large customer image just to log it. */
export function queryImageDimensions(bytes: Buffer): {
  format: string
  width?: number
  height?: number
} {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break
      const marker = bytes[offset++]
      if (marker === 255) {
        offset--
        continue
      }
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) break
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        size >= 7
      )
        return {
          format: 'jpeg',
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        }
      offset += size
    }
    return { format: 'jpeg' }
  }
  return { format: 'unknown' }
}
