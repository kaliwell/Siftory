// Canonical settings/config persistence helpers.
// Used by electron/main.ts and tests/settings-store.test.cjs.

import fs from 'fs'
import { redactDiagnosticError } from './diagnosticRedaction'

export function readJSON(filePath: string): unknown {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (e) {
    console.error(`[Siftory] settings read error: ${redactDiagnosticError(e)}`)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = filePath + '.corrupted-' + ts
      fs.copyFileSync(filePath, backup)
      console.error('[Siftory] corrupted settings file was backed up')
    } catch (_) {
      // best-effort
    }
  }
  return null
}

export function writeJSON(filePath: string, data: unknown): void {
  try {
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch (e) {
    console.error(`[Siftory] settings write error: ${redactDiagnosticError(e)}`)
  }
}
