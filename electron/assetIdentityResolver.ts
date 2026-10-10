// ── Stable asset identity resolution (Phase 2, design 7.2) ──
// Pure resolution functions, no I/O: the strategy ladder is
//   1. filesystem identity (volume serial + file index / FRN) when the
//      platform stat exposes it — stable across same-volume renames;
//   2. path strategy (source-normalized absolute path, win32 lowercase) as
//      the Phase 1 fallback.
// Content hashing is intentionally NOT part of the identity basis (design
// 7.2 rule 4): hashes confirm content for duplicate merging and migration
// repair, never gate identity creation.

import crypto from 'node:crypto'
import path from 'node:path'
import type {
  AssetIdStrategy,
  AssetIdentityResolveInput,
  AssetMember,
  AssetMemberRole,
} from '../shared/ipc/asset-identity'
import { discoveryPathKey } from './discoveryCatalogDatabase'

export interface FilesystemStatLike {
  dev: number
  ino: number
}

const ASSET_ID_PREFIX = 'asset_'

// RAW formats that act as companions to a developed JPEG/PNG original.
const RAW_COMPANION_EXTENSIONS = new Set([
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raf',
  '.pef',
  '.srw',
])
// Edit-decision sidecars that describe, but are not, the original file.
const SIDECAR_EXTENSIONS = new Set(['.xmp', '.aae', '.pp3', '.dop', '.cos', '.on1'])
const ORIGINAL_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.psd',
])

/**
 * Filesystem identity from a platform stat. On Windows/NTFS libuv fills
 * `dev` with the volume serial number and `ino` with the file index (FRN),
 * both stable across renames on the same volume. Returns null when the
 * filesystem cannot provide a usable identity (dev/ino zero or negative).
 */
export function filesystemIdentityFromStat(stat: FilesystemStatLike | null): string | null {
  if (!stat) return null
  if (!Number.isFinite(stat.dev) || !Number.isFinite(stat.ino)) return null
  if (stat.dev <= 0 || stat.ino <= 0) return null
  return `fs:${Math.trunc(stat.dev).toString(16)}:${Math.trunc(stat.ino).toString(16)}`
}

export function assetIdFromIdentityKey(identityKey: string): string {
  const digest = crypto.createHash('sha256').update(identityKey, 'utf8').digest('hex')
  return `${ASSET_ID_PREFIX}${digest.slice(0, 24)}`
}

export function isAssetId(value: string): boolean {
  return typeof value === 'string' && /^asset_[0-9a-f]{24}$/.test(value)
}

/**
 * Resolve the stable identity for one physical file. The caller supplies
 * either a platform stat (dev/ino) or an already-known filesystem identity;
 * without either, resolution falls back to the path strategy.
 */
export function resolveAssetIdentity(
  input: AssetIdentityResolveInput,
  stat?: FilesystemStatLike | null,
): { assetId: string; strategy: AssetIdStrategy; identityKey: string } {
  const filesystemIdentity = input.filesystemIdentity ?? filesystemIdentityFromStat(stat ?? null)
  if (filesystemIdentity) {
    return {
      assetId: assetIdFromIdentityKey(filesystemIdentity),
      strategy: 'filesystem',
      identityKey: filesystemIdentity,
    }
  }
  const pathKey = `path:${discoveryPathKey(input.absolutePath)}`
  return { assetId: assetIdFromIdentityKey(pathKey), strategy: 'path', identityKey: pathKey }
}

function isInsideDirectory(rootDir: string, candidate: string): boolean {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  return relative !== '' && !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export interface MemberRoleContext {
  /** Directories whose contents are generated preview proxies. */
  previewDirs?: readonly string[]
  /** True when a same-stem original (JPEG/PNG/…) sits next to the file. */
  hasOriginalSibling?: boolean
}

/**
 * Classify what a physical file is relative to its logical asset. Rule from
 * the Phase 2 brief: a preview proxy only ever participates in decoding and
 * feature computation — it is never the user-visible original.
 */
export function classifyMemberRole(
  filePath: string,
  context: MemberRoleContext = {},
): AssetMemberRole {
  for (const previewDir of context.previewDirs ?? []) {
    if (isInsideDirectory(previewDir, filePath)) return 'preview-proxy'
  }
  const extension = path.extname(filePath).toLowerCase()
  if (SIDECAR_EXTENSIONS.has(extension)) return 'sidecar'
  if (RAW_COMPANION_EXTENSIONS.has(extension) && context.hasOriginalSibling) {
    return 'raw-companion'
  }
  return 'original'
}

/** Whether an extension is a user-visible original image format. */
export function isOriginalImageExtension(extension: string): boolean {
  return ORIGINAL_IMAGE_EXTENSIONS.has(extension.toLowerCase())
}

/**
 * User-visible members of an asset: original members only (Phase 2 rule —
 * any query that returns user-visible results defaults to originals, so a
 * preview proxy can never appear as the original file in search, the asset
 * library or duplicate groups).
 */
export function userVisibleMembers(members: readonly AssetMember[]): AssetMember[] {
  return members.filter((member) => member.role === 'original')
}

/** Resolve the path of the original member; null when none is recorded. */
export function originalMemberPath(members: readonly AssetMember[]): string | null {
  const originals = userVisibleMembers(members)
  return originals.length > 0 ? originals[0].path : null
}
