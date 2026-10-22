// Canonical settings/config persistence helpers.
// Used by electron/main.ts and tests/settings-store.test.cjs.

import fs from 'fs'
import { redactDiagnosticError } from './diagnosticRedaction'

export function readJSON(filePath: string, strict = false): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error(`[Siftory] settings read error: ${redactDiagnosticError(e)}`)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = filePath + '.corrupted-' + ts
      fs.copyFileSync(filePath, backup)
      console.error('[Siftory] corrupted settings file was backed up')
    } catch (_) {
      // best-effort
    }
    if (strict) throw new Error('Could not read local settings', { cause: e })
  }
  return null
}

export function writeJSON(filePath: string, data: unknown): boolean {
  try {
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
    return true
  } catch (e) {
    console.error(`[Siftory] settings write error: ${redactDiagnosticError(e)}`)
    return false
  }
}
