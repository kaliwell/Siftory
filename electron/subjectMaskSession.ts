import crypto from 'crypto'

export interface SubjectMaskBBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SubjectMaskFingerprint {
  imagePath: string
  size: number
  mtimeMs: number
}

export interface SubjectMaskSessionData extends SubjectMaskFingerprint {
  width: number
  height: number
  bbox: SubjectMaskBBox
  maskPng: Buffer
}

interface StoredSubjectMaskSession extends SubjectMaskSessionData {
  senderId: number
  expiresAt: number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 16
const MAX_MASK_BYTES = 16 * 1024 * 1024

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right
}

/**
 * Keeps full-resolution SAM masks in the main process. The renderer receives
 * only an opaque capability scoped to its WebContents and the source file
 * fingerprint.
 */
export class SubjectMaskSessionStore {
  private readonly sessions = new Map<string, StoredSubjectMaskSession>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = crypto.randomUUID,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {}

  issue(senderId: number, data: SubjectMaskSessionData): string | null {
    if (
      data.maskPng.length === 0 ||
      data.maskPng.length > MAX_MASK_BYTES ||
      data.width <= 0 ||
      data.height <= 0
    ) {
      return null
    }
    this.prune()
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (typeof oldest !== 'string') break
      this.sessions.delete(oldest)
    }
    const token = this.createToken()
    this.sessions.set(token, {
      ...data,
      maskPng: Buffer.from(data.maskPng),
      senderId,
      expiresAt: this.now() + this.ttlMs,
    })
    return token
  }

  resolve(
    senderId: number,
    token: string,
    fingerprint: SubjectMaskFingerprint,
  ): SubjectMaskSessionData | null {
    this.prune()
    const session = this.sessions.get(token)
    if (
      !session ||
      session.senderId !== senderId ||
      !samePath(session.imagePath, fingerprint.imagePath) ||
      session.size !== fingerprint.size ||
      Math.abs(session.mtimeMs - fingerprint.mtimeMs) > 1
    ) {
      return null
    }
    return {
      imagePath: session.imagePath,
      size: session.size,
      mtimeMs: session.mtimeMs,
      width: session.width,
      height: session.height,
      bbox: { ...session.bbox },
      maskPng: Buffer.from(session.maskPng),
    }
  }

  clearSender(senderId: number): void {
    for (const [token, session] of this.sessions) {
      if (session.senderId === senderId) this.sessions.delete(token)
    }
  }

  private prune(): void {
    const current = this.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= current) this.sessions.delete(token)
    }
  }
}

export const subjectMaskSessions = new SubjectMaskSessionStore()
