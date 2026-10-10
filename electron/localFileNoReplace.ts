import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function collision(): NodeJS.ErrnoException {
  return Object.assign(new Error('Destination already exists; overwrite blocked'), {
    code: 'EEXIST',
  })
}

interface NativeFileMoves {
  movePathWithoutOverwriteAsync(source: string, destination: string): Promise<void>
}

let nativeFileMoves: NativeFileMoves | undefined

function requireNativeFileMoves(): NativeFileMoves {
  if (nativeFileMoves) return nativeFileMoves
  const runtimeBuild = process.versions.electron ? 'build-electron' : 'build-node'
  const candidates = [
    path.join(process.resourcesPath || '', 'fast_scanner.node'),
    ...[path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')].flatMap((root) => [
      path.join(root, 'native', runtimeBuild, 'Release', 'fast_scanner.node'),
      path.join(root, 'native', 'build', 'Release', 'fast_scanner.node'),
    ]),
  ]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const addon = require(candidate) as Partial<NativeFileMoves>
      if (typeof addon.movePathWithoutOverwriteAsync === 'function') {
        nativeFileMoves = addon as NativeFileMoves
        return nativeFileMoves
      }
    } catch {
      // Try the next packaged/development binary. Never substitute link+unlink.
    }
  }
  throw Object.assign(
    new Error('Atomic file move is unavailable; rebuild or update the native module'),
    {
      code: 'ENATIVE',
    },
  )
}

/** Publish a file without ever replacing a destination created by another writer. */
export async function publishFileWithoutOverwrite(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await fsp.link(source, destination)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(code(error) || '')) {
      throw error
    }
    // FAT/network volumes may not support links. COPYFILE_EXCL retains the
    // no-replace contract even if the destination appears after inspection.
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
  }
}

/** Same-volume rename/move, preserving any existing destination. */
export async function movePathWithoutOverwrite(
  source: string,
  destination: string,
  _allowCopyFallback = false,
): Promise<void> {
  const from = path.resolve(source)
  const to = path.resolve(destination)
  const stat = await fsp.lstat(from)
  if (from === to) return
  if (stat.isSymbolicLink()) throw new Error('Move symbolic links using the system file manager')
  let target: fs.Stats | undefined
  try {
    target = await fsp.lstat(to)
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error
  }
  if (target) {
    // Windows permits case-only renames; a case-sensitive directory may contain
    // two distinct files with these names, so identity must also match.
    if (
      process.platform === 'win32' &&
      from.toLowerCase() === to.toLowerCase() &&
      stat.dev === target.dev &&
      stat.ino === target.ino &&
      !target.isSymbolicLink()
    ) {
      // The OS must also handle case-only renames atomically without replacing
      // a different target that appears after this identity check.
    } else {
      throw collision()
    }
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('Unsupported source file type')
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Atomic no-replace move requires Windows'), { code: 'ENATIVE' })
  }
  // No REPLACE_EXISTING and no COPY_ALLOWED: one OS rename, no separate source
  // unlink that could delete a newer save at the same path. EXDEV is left to
  // the caller's explicit prepared-copy and recycle-bin workflow.
  await requireNativeFileMoves().movePathWithoutOverwriteAsync(
    path.toNamespacedPath(from),
    path.toNamespacedPath(to),
  )
}
