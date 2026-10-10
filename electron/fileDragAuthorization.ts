import crypto from 'crypto'
import path from 'path'

const PHOTOSHOP_COMPATIBILITY_PREVIEW_EXTENSIONS = new Set([
  '.ai',
  '.avif',
  '.cdr',
  '.clip',
  '.eps',
  '.indd',
  '.kra',
  '.pdf',
  '.svg',
  '.webp',
])

export function shouldPreferPhotoshopCompatibilityPreview(filePath: string): boolean {
  return PHOTOSHOP_COMPATIBILITY_PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export interface AuthorizedFileDrag {
  filePath: string
  size: number
  mtimeMs: number
}

interface FileDragGrant extends AuthorizedFileDrag {
  senderId: number
  expiresAt: number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_GRANTS = 4096

/**
 * Keeps renderer paths out of the privileged drag operation. Tokens are
 * issued only for paths returned by a main-process search and are scoped to
 * the WebContents that received the result.
 */
export class FileDragAuthorizer {
  private readonly grants = new Map<string, FileDragGrant>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = crypto.randomUUID,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxGrants = DEFAULT_MAX_GRANTS,
  ) {}

  issue(senderId: number, file: AuthorizedFileDrag): string {
    this.prune()
    while (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value
      if (typeof oldest !== 'string') break
      this.grants.delete(oldest)
    }
    const token = this.createToken()
    this.grants.set(token, {
      ...file,
      senderId,
      expiresAt: this.now() + this.ttlMs,
    })
    return token
  }

  resolve(senderId: number, token: string): AuthorizedFileDrag | null {
    this.prune()
    const grant = this.grants.get(token)
    if (!grant || grant.senderId !== senderId) return null
    return { filePath: grant.filePath, size: grant.size, mtimeMs: grant.mtimeMs }
  }

  clearSender(senderId: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.senderId === senderId) this.grants.delete(token)
    }
  }

  private prune(): void {
    const current = this.now()
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= current) this.grants.delete(token)
    }
  }
}
