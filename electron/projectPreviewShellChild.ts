import { app, nativeImage } from 'electron'
import { extractShellThumbnail } from './projectPreviewShellExtract'

export async function startShellPreviewChild(): Promise<void> {
  const nonce = process.env.SIFTORY_SHELL_PREVIEW_NONCE
  const expectedArg = `--siftory-shell-preview=${nonce}`
  if (
    !nonce ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !process.argv.includes(expectedArg) ||
    typeof process.send !== 'function' ||
    !process.connected ||
    !process.env.SIFTORY_SHELL_PREVIEW_PROFILE
  ) {
    app.exit(1)
    return
  }
  // Never share the parent's movable data root or single-instance lock.
  app.setPath('userData', process.env.SIFTORY_SHELL_PREVIEW_PROFILE)
  if (!app.isReady()) app.disableHardwareAcceleration()
  process.on('disconnect', () => app.exit(0))
  await app.whenReady()
  let busy = false
  process.on('message', async (message: unknown) => {
    const request = message as { nonce?: string; source?: string; requestId?: number }
    if (
      busy ||
      request?.nonce !== nonce ||
      typeof request.source !== 'string' ||
      request.source.length > 32768 ||
      request.source.includes('\0') ||
      !Number.isSafeInteger(request.requestId)
    ) {
      app.exit(1)
      return
    }
    busy = true
    const result = await extractShellThumbnail(request.source, {
      step: (name) =>
        new Promise<void>((resolve, reject) => {
          if (!process.connected) {
            reject(new Error('Parent disconnected'))
            return
          }
          process.send!({ kind: 'step', nonce, requestId: request.requestId, name }, (error) =>
            error ? reject(error) : resolve(),
          )
        }),
      thumbnail: (source, size) => nativeImage.createThumbnailFromPath(source, size),
      icon: (source) => app.getFileIcon(source, { size: 'large' }),
    })
    busy = false
    process.send?.({ kind: 'result', nonce, requestId: request.requestId, ...result })
  })
  process.send?.({ kind: 'ready', nonce })
}
