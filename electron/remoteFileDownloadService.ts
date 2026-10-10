import fs from 'fs'
import { Client } from 'ssh2'
import type { Readable } from 'stream'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import {
  buildSshConfig,
  hostKeyFailure,
  normalizeSshError,
  prepareAuthConfig,
} from './remoteTerminalService'
import { normalizeRemotePath } from './remoteSftpService'

export async function downloadRemoteFileBounded(
  profile: RemoteTerminalProfile,
  request: {
    remotePath: string
    destinationPath: string
    maxBytes: number
    timeoutMs: number
    password?: string
    passphrase?: string
  },
): Promise<{ transferredBytes: number; elapsedMs: number }> {
  const remotePath = normalizeRemotePath(request.remotePath)
  if (!remotePath?.startsWith('/')) throw new Error('Invalid remote file path')
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new Error('Invalid remote download limit')
  }
  const client = new Client()
  const { config, hostKeyState } = buildSshConfig(profile)
  const authError = await prepareAuthConfig(client, config, profile, request)
  if (authError) throw new Error(authError)

  return new Promise((resolve, reject) => {
    let settled = false
    let input: Readable | null = null
    const output = fs.createWriteStream(request.destinationPath, { flags: 'wx', mode: 0o600 })
    let transferredBytes = 0
    const startedAt = Date.now()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input?.destroy()
      output.destroy()
      try {
        client.end()
      } catch {
        // Best effort.
      }
      if (error) reject(error)
      else resolve({ transferredBytes, elapsedMs: Math.max(1, Date.now() - startedAt) })
    }
    const timer = setTimeout(
      () => finish(new Error('Remote video retrieval timed out')),
      Math.max(10_000, Math.min(request.timeoutMs, 24 * 60 * 60_000)),
    )
    output.once('error', finish)
    output.once('close', () => finish())
    client.once('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) return finish(new Error(`SFTP unavailable: ${sftpError.message}`))
        input = sftp.createReadStream(remotePath)
        input.on('data', (chunk: Buffer | string) => {
          transferredBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
          if (transferredBytes > request.maxBytes) {
            finish(new Error('Remote video exceeds retrieval limit'))
          }
        })
        input.once('error', finish)
        input.pipe(output)
      })
    })
    client.once('error', (error: Error) => {
      const hostError = hostKeyFailure(hostKeyState)
      finish(new Error(hostError?.message || normalizeSshError(error.message)))
    })
    client.once('close', () => finish(new Error('Connection closed before retrieval completed')))
    try {
      client.connect(config)
    } catch (error) {
      finish(new Error(normalizeSshError(error instanceof Error ? error.message : String(error))))
    }
  })
}
