import type { BrowserImageImportSource } from '../../shared/ipc/browser-image'

const MAX_BYTES = 16 * 1024 * 1024

function imageSourceUrl(value: string): string | null {
  const text = value.trim()
  if (text.startsWith('data:image/')) return text
  try {
    const url = new URL(text.startsWith('//') ? `https:${text}` : text)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Read drag data synchronously: browsers clear protected data after the drop callback. */
export function readBrowserImageDrop(
  transfer: DataTransfer,
): Promise<BrowserImageImportSource | null> {
  const file = transfer.files[0]
  if (file?.type.startsWith('image/') && file.size > 0) {
    if (file.size > MAX_BYTES)
      return Promise.reject(new Error('The dropped image exceeds the 16 MiB limit.'))
    return file.arrayBuffer().then((buffer) => ({ kind: 'bytes', bytes: new Uint8Array(buffer) }))
  }
  const html = transfer.getData('text/html')
  const candidates: string[] = []
  if (html && html.length <= 1024 * 1024) {
    const template = document.createElement('template')
    template.innerHTML = html
    const image = template.content.querySelector('img[src]')
    if (image) candidates.push(image.getAttribute('src') || '')
  }
  for (const type of ['text/uri-list', 'text/x-moz-url', 'text/plain']) {
    const text = transfer.getData(type)
    if (text.length > Math.ceil((MAX_BYTES * 4) / 3) + 256) continue
    candidates.push(
      ...text
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith('#'))
        .slice(0, 8),
    )
  }
  const source = candidates.map(imageSourceUrl).find((value) => value !== null)
  if (!source) return Promise.resolve(null)
  if (source.startsWith('data:')) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(source)
    if (!match || match[1].length > Math.ceil((MAX_BYTES * 4) / 3) + 4)
      return Promise.reject(new Error('The dropped content is not a supported image.'))
    try {
      const decoded = atob(match[1].replace(/\s/g, ''))
      if (decoded.length > MAX_BYTES) throw new Error('The dropped image exceeds the 16 MiB limit.')
      return Promise.resolve({
        kind: 'bytes',
        bytes: Uint8Array.from(decoded, (char) => char.charCodeAt(0)),
      })
    } catch {
      return Promise.reject(new Error('The dropped content is not a supported image.'))
    }
  }
  return Promise.resolve({ kind: 'url', url: source })
}

export function isPotentialImageDrag(transfer: DataTransfer | null): boolean {
  return Boolean(
    transfer &&
    ['Files', 'text/html', 'text/uri-list', 'text/x-moz-url', 'text/plain'].some((type) =>
      transfer.types.includes(type),
    ),
  )
}
