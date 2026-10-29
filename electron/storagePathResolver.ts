// Resolves only historical application-data paths. Original media paths outside
// those roots are unchanged. Keep this boundary filesystem/transport independent.
import path from 'node:path'

let activeRoot = ''
let previousRoots: string[] = []

export function configureStoragePathResolver(root: string, aliases: string[]): void {
  activeRoot = path.resolve(root)
  previousRoots = aliases.map((alias) => path.resolve(alias)).sort((a, b) => b.length - a.length)
}

export function resolveDataPathInRoots(
  root: string,
  aliases: readonly string[],
  storedPath: string,
): string {
  if (!path.isAbsolute(storedPath)) return storedPath
  const currentRelative = path.relative(root, storedPath)
  if (
    currentRelative === '' ||
    (currentRelative !== '..' &&
      !currentRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(currentRelative))
  )
    return storedPath
  for (const alias of aliases) {
    const relative = path.relative(alias, storedPath)
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    )
      return path.join(root, relative)
  }
  return storedPath
}

export function resolveStoredDataPath(storedPath: string): string {
  return activeRoot ? resolveDataPathInRoots(activeRoot, previousRoots, storedPath) : storedPath
}
