import path from 'node:path'
import { isImageDataPathWithin, normalizedImageDataPathKey } from './imageSearchDataPathUtils'

export interface CatalogFolderPath {
  key: string
  display: string
  parentKey: string | null
  depth: number
}

export function cleanCatalogDisplayPath(value: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/\//g, '\\')
  if (!normalized) return ''
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('\\\\')) {
    const resolved = path.win32.resolve(normalized)
    return /^[a-zA-Z]:\\$/.test(resolved) ? resolved : resolved.replace(/\\+$/, '')
  }
  return path.resolve(normalized).replace(/\//g, '\\').replace(/\\+$/, '')
}

function sourceRootForPath(
  directoryDisplay: string,
  roots: Array<{ key: string; display: string }>,
): { key: string; display: string } {
  const directoryKey = normalizedImageDataPathKey(directoryDisplay)
  const configured = roots
    .filter((root) => isImageDataPathWithin(directoryKey, root.key))
    .sort((left, right) => right.key.length - left.key.length)[0]
  if (configured) return configured
  const parsedRoot = path.win32.parse(directoryDisplay).root
  const display = cleanCatalogDisplayPath(parsedRoot || directoryDisplay)
  return { key: normalizedImageDataPathKey(display), display }
}

export function catalogFolderChain(
  fileDisplayPath: string,
  roots: Array<{ key: string; display: string }>,
): CatalogFolderPath[] {
  let currentDisplay = cleanCatalogDisplayPath(path.win32.dirname(fileDisplayPath))
  let currentKey = normalizedImageDataPathKey(currentDisplay)
  if (!currentKey) return []
  const root = sourceRootForPath(currentDisplay, roots)
  const descending: Array<{ key: string; display: string }> = []
  for (let guard = 0; guard < 64 && currentKey; guard++) {
    descending.push({ key: currentKey, display: currentDisplay })
    if (currentKey === root.key) break
    const parentDisplay = cleanCatalogDisplayPath(path.win32.dirname(currentDisplay))
    const parentKey = normalizedImageDataPathKey(parentDisplay)
    if (!parentKey || parentKey === currentKey || !isImageDataPathWithin(currentKey, root.key)) {
      break
    }
    currentDisplay = parentDisplay
    currentKey = parentKey
  }
  if (!descending.some((item) => item.key === root.key)) {
    descending.push({ key: root.key, display: root.display })
  }
  const ascending = descending.reverse()
  return ascending.map((item, index) => ({
    ...item,
    parentKey: index === 0 ? null : ascending[index - 1].key,
    depth: index,
  }))
}

export function catalogFolderName(displayPath: string): string {
  return path.win32.basename(displayPath) || displayPath
}
