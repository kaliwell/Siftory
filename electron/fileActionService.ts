// ── Unified file actions (Phase 2, design 9.3 actionToken) ──
// One main-process entry point for open / reveal / drag-out of originals.
// Every action resolves the reference (AssetId or path) to the *original*
// member through the identity service first: a preview proxy is never
// executed, revealed or dragged out as if it were the user's original file.
// Shell access itself still goes through the existing pathGuards validation.

import type { AssetFileActionResult } from '../shared/ipc/asset-identity'
import { isAssetId, originalMemberPath, classifyMemberRole } from './assetIdentityResolver'
import type { AssetIdentityService } from './assetIdentityService'
import { openSafeShellPath, revealSafeShellPath } from './pathGuards'

interface ShellPathApi {
  openPath(targetPath: string): Promise<string>
  showItemInFolder(targetPath: string): void
}

/**
 * Resolve a user-supplied reference to the user-visible original path.
 * Returns null (with an error) when the reference only names a non-original
 * member such as a preview proxy.
 */
export async function resolveOriginalActionPath(
  service: AssetIdentityService,
  ref: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, error: 'Invalid reference' }
  if (isAssetId(ref)) {
    const identity = await service.getByAssetId(ref)
    if (!identity) return { ok: false, error: 'Unknown asset id' }
    const original = originalMemberPath(identity.members) ?? identity.path
    if (!original) return { ok: false, error: 'Asset has no original member' }
    return { ok: true, path: original }
  }
  const role = classifyMemberRole(ref, { previewDirs: service.previewDirectoryList() })
  if (role === 'preview-proxy') {
    return { ok: false, error: 'Preview proxies are never opened as original files' }
  }
  return { ok: true, path: ref }
}

export async function openOriginalFile(
  service: AssetIdentityService,
  shellApi: ShellPathApi,
  ref: string,
): Promise<AssetFileActionResult> {
  const resolved = await resolveOriginalActionPath(service, ref)
  if (!resolved.ok || !resolved.path) return resolved
  return openSafeShellPath(shellApi, resolved.path)
}

export async function revealOriginalFile(
  service: AssetIdentityService,
  shellApi: ShellPathApi,
  ref: string,
): Promise<AssetFileActionResult> {
  const resolved = await resolveOriginalActionPath(service, ref)
  if (!resolved.ok || !resolved.path) return resolved
  return revealSafeShellPath(shellApi, resolved.path)
}
