import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { EndUserTerms, TermsAcceptResult } from '../shared/ipc/end-user-terms'

const MAX_BYTES = 512 * 1024
const RECEIPT_NAME = 'end-user-terms-acceptance.json'
const HASH_PATTERN = /^[a-f0-9]{64}$/
export type LoadedEndUserTerms = { status: 'review' } | { status: 'final'; terms: EndUserTerms }

function invalid(): never {
  throw new Error('Invalid end-user terms')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value !== value.trim()) {
    invalid()
  }
  if ([...value].some((character) => character.charCodeAt(0) < 32) || /\{\{[^}]*\}\}/.test(value))
    invalid()
  return value
}

function regularFileBytes(file: string, limit: number): Buffer {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) invalid()
  const bytes = fs.readFileSync(file)
  if (bytes.length > limit) invalid()
  return bytes
}

/** No renderer-selected paths; every directory must resolve inside the supplied resources root. */
export function loadEndUserTerms(resourcesRoot: string): LoadedEndUserTerms {
  const root = fs.realpathSync(resourcesRoot)
  const directory = path.join(root, 'legal', 'end-user-terms')
  if (fs.realpathSync(directory) !== directory) invalid()
  const manifest = record(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        regularFileBytes(path.join(directory, 'manifest.json'), 16384),
      ),
    ),
  )
  if (manifest.schemaVersion !== 1) invalid()
  if (manifest.status === 'review') return { status: 'review' }
  if (manifest.status !== 'final') invalid()
  const title = boundedString(manifest.title, 200)
  const version = boundedString(manifest.version, 80)
  const publisher = boundedString(manifest.publisher, 200)
  const effectiveDate = boundedString(manifest.effectiveDate, 10)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
    !Number.isFinite(Date.parse(effectiveDate)) ||
    new Date(effectiveDate).toISOString().slice(0, 10) !== effectiveDate
  )
    invalid()
  if (
    !Array.isArray(manifest.documents) ||
    !manifest.documents.length ||
    manifest.documents.length > 10
  )
    invalid()
  const seen = new Set<string>()
  let totalBytes = 0
  const documents = manifest.documents.map((entry: unknown) => {
    const doc = record(entry)
    const name = boundedString(doc.path, 120)
    // A flat directory also excludes junctions, traversal, device names and alternate streams.
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:txt|md)$/.test(name) ||
      name.includes('..') ||
      seen.has(name.toLowerCase())
    )
      invalid()
    seen.add(name.toLowerCase())
    if (typeof doc.sha256 !== 'string' || !HASH_PATTERN.test(doc.sha256)) invalid()
    const bytes = regularFileBytes(path.join(directory, name), MAX_BYTES)
    totalBytes += bytes.length
    if (totalBytes > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== doc.sha256)
      invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (
      !text.trim() ||
      text.includes('\0') ||
      /\{\{[^}]*\}\}|DRAFT\s*[—–-]\s*NOT\s+FOR\s+DISTRIBUTION/i.test(text)
    )
      invalid()
    return text
  })
  const text = documents.join('\n\n')
  // Bind the text AND displayed metadata, so changing the publisher also requires a new decision.
  const sha256 = createHash('sha256')
    .update(JSON.stringify({ title, version, publisher, effectiveDate, text }))
    .digest('hex')
  return { status: 'final', terms: { title, version, publisher, effectiveDate, text, sha256 } }
}

export function hasAcceptedEndUserTerms(userDataPath: string, terms: EndUserTerms): boolean {
  try {
    const receipt = record(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          regularFileBytes(path.join(userDataPath, RECEIPT_NAME), 4096),
        ),
      ),
    )
    return (
      receipt.schemaVersion === 1 &&
      receipt.version === terms.version &&
      receipt.sha256 === terms.sha256 &&
      receipt.publisher === terms.publisher &&
      typeof receipt.acceptedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(receipt.acceptedAt) &&
      Number.isFinite(Date.parse(receipt.acceptedAt))
    )
  } catch {
    return false
  }
}

/** Call only from an explicit choice in the dedicated acceptance window. */
export function acceptEndUserTerms(
  resourcesRoot: string,
  userDataPath: string,
  displayed: EndUserTerms,
  identity: unknown,
): TermsAcceptResult {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    return { ok: false, reason: 'invalid-request' }
  const supplied = identity as Record<string, unknown>
  if (supplied.version !== displayed.version || supplied.sha256 !== displayed.sha256)
    return { ok: false, reason: 'invalid-request' }
  try {
    const current = loadEndUserTerms(resourcesRoot)
    if (current.status !== 'final' || current.terms.sha256 !== displayed.sha256)
      return { ok: false, reason: 'stale-terms' }
  } catch {
    return { ok: false, reason: 'stale-terms' }
  }
  let temporary: string | undefined
  try {
    const directory = fs.realpathSync(userDataPath)
    const destination = path.join(directory, RECEIPT_NAME)
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid receipt destination')
    }
    temporary = path.join(directory, `.${RECEIPT_NAME}.${randomBytes(16).toString('hex')}.tmp`)
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            schemaVersion: 1,
            version: displayed.version,
            sha256: displayed.sha256,
            publisher: displayed.publisher,
            acceptedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      )
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, destination)
    temporary = undefined
    return { ok: true }
  } catch {
    return { ok: false, reason: 'save-failed' }
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        /* A failed write must never count as acceptance. */
      }
    }
  }
}
