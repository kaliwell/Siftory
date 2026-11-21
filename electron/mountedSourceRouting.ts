import { hasControlChars } from './imageSearchGuards'
import path from 'node:path'
import type { LibraryAssetLocation } from '../shared/ipc/storage-location'

export interface MountedSourceRoute {
  sourceId: string
  root: string
  previousRoot: string
}

let routes: readonly MountedSourceRoute[] = []
let retiredKeys: readonly string[] = []
let routingRevision = 0

export function setMountedSourceRoutes(snapshot: readonly MountedSourceRoute[]): void {
  routes = snapshot
  retiredKeys = snapshot.map((route) => mountedSourcePathKey(route.previousRoot))
  routingRevision += 1
}

function pathFlavor(value: string): typeof path.win32 {
  return process.platform === 'win32' || /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value)
    ? path.win32
    : path.posix
}

export function mountedSourcePathKey(value: string): string {
  const flavor = pathFlavor(value)
  const normalized =
    flavor.resolve(regularPath(value)).replace(/[\\/]+$/, '') || flavor.parse(value).root
  return flavor === path.win32 ? normalized.toLowerCase() : normalized
}

function regularPath(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return '\\\\' + value.slice(8)
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return value.slice(4)
  return value
}

export function isMountedUncPath(value: string): boolean {
  const normalized = value.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\')
  if (!normalized.startsWith('\\\\')) return false
  const [host, share, ...parts] = normalized.slice(2).split('\\')
  return Boolean(
    host &&
    share &&
    !/^(?:pipe|mailslot|ipc\$)$/i.test(share) &&
    [host, share, ...parts].every(
      (part) => part !== '.' && part !== '..' && !hasControlChars(part) && !/[:?*"<>|]/.test(part),
    ),
  )
}

export function mountedSourceRoutingRevision(): number {
  return routingRevision
}

export function retiredMountedSourceRoots(): string[] {
  return routes.map((route) => route.previousRoot)
}

export function mountedRelativePath(root: string, candidate: string): string | null {
  const flavor = pathFlavor(root)
  if (flavor !== pathFlavor(candidate) || !flavor.isAbsolute(candidate) || !flavor.isAbsolute(root))
    return null
  const relative = flavor.relative(regularPath(root), regularPath(candidate))
  return relative === '..' || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)
    ? null
    : relative
}

export function resolveMountedScanRoots(roots: readonly string[]): string[] {
  const result = new Map<string, string>()
  for (const root of roots) {
    let current = root
    if (path.isAbsolute(root)) {
      for (const route of routes) {
        const relative = mountedRelativePath(route.previousRoot, root)
        if (relative === null) continue
        current = path.resolve(route.root, relative)
        break
      }
    }
    result.set(path.isAbsolute(current) ? mountedSourcePathKey(current) : current, current)
  }
  return [...result.values()]
}

export function isRetiredMountedSourcePath(candidate: string): boolean {
  if (retiredKeys.length === 0 || !pathFlavor(candidate).isAbsolute(candidate)) return false
  const key = mountedSourcePathKey(candidate)
  const sep = pathFlavor(candidate).sep
  return retiredKeys.some((root) => key === root || key.startsWith(`${root}${sep}`))
}

export function resolveMountedAssetLocation(
  location: LibraryAssetLocation,
  libraryId: string,
  root: string,
): string | null {
  if (
    location.libraryId !== libraryId ||
    !location.relativePath ||
    hasControlChars(location.relativePath) ||
    location.relativePath.includes(':')
  )
    return null
  const relative = location.relativePath.replace(/\\/g, '/')
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) return null
  const resolved = path.resolve(root, relative)
  return mountedRelativePath(root, resolved) ? resolved : null
}
