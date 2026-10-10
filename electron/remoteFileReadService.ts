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

export async function readRemoteFileBounded(
  profile: RemoteTerminalProfile,
  request: {
    profileId: string
    remotePath: string
    maxBytes: number
    timeoutMs: number
    password?: string
    passphrase?: string
  },
): Promise<Buffer> {
  const remotePath = normalizeRemotePath(request.remotePath)
  if (!remotePath || !remotePath.startsWith('/')) throw new Error('Invalid remote file path')
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new Error('Invalid remote read limit')
  }
  const client = new Client()
  const { config, hostKeyState } = buildSshConfig(profile)
  const authError = await prepareAuthConfig(client, config, profile, request)
  if (authError) throw new Error(authError)

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false
    let stream: Readable | null = null
    const finish = (error?: Error, data?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream?.destroy()
      try {
        client.end()
      } catch {
        // Best effort.
      }
      if (error) reject(error)
      else resolve(data ?? Buffer.alloc(0))
    }
    const timer = setTimeout(
      () => finish(new Error('Remote preview read timed out')),
      Math.max(1000, Math.min(request.timeoutMs, 120_000)),
    )

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) {
          finish(new Error(`SFTP unavailable: ${sftpError.message}`))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        stream = sftp.createReadStream(remotePath)
        stream.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > request.maxBytes) {
            finish(new Error('Remote file exceeds preview read limit'))
            return
          }
          chunks.push(buffer)
        })
        stream.once('error', (error) => finish(error))
        stream.once('end', () => finish(undefined, Buffer.concat(chunks, bytes)))
      })
    })
    client.on('error', (error: Error) => {
      const hostError = hostKeyFailure(hostKeyState)
      finish(new Error(hostError?.message || normalizeSshError(error.message)))
    })
    client.on('close', () => finish(new Error('Connection closed before preview completed')))
    try {
      client.connect(config)
    } catch (error) {
      finish(new Error(normalizeSshError(error instanceof Error ? error.message : String(error))))
    }
  })
}
