import fs from 'node:fs/promises'
import path from 'node:path'
import type { OpenThirdPartyLicensesResult } from '../shared/ipc/app-core'
import { openSafeShellPath } from './pathGuards'

interface LicenseDirectoryOptions {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

/** Only main-process application roots may be supplied here; never renderer paths. */
export async function openThirdPartyLicenseDirectory(
  options: LicenseDirectoryOptions,
  shell: Parameters<typeof openSafeShellPath>[0],
  requestArguments: readonly unknown[] = [],
): Promise<OpenThirdPartyLicensesResult> {
  if (requestArguments.length !== 0) return { ok: false, reason: 'invalid-request' }

  let directory: string
  try {
    const root = await fs.realpath(options.isPackaged ? options.resourcesPath : options.appPath)
    directory = await fs.realpath(path.join(root, 'legal'))
    // Reject junctions/symlinks that redirect the fixed entry point elsewhere.
    if (path.relative(root, directory) !== 'legal') {
      return { ok: false, reason: 'unavailable' }
    }
    if (!(await fs.stat(directory)).isDirectory() || (await fs.readdir(directory)).length === 0) {
      return { ok: false, reason: 'unavailable' }
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }

  try {
    const result = await openSafeShellPath(shell, directory, { requireExists: true })
    return result.ok ? { ok: true } : { ok: false, reason: 'open-failed' }
  } catch {
    return { ok: false, reason: 'open-failed' }
  }
}
