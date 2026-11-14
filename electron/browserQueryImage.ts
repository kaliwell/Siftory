import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import sharp from 'sharp'
import type { BrowserImageImportSource } from '../shared/ipc/browser-image'

export const MAX_BROWSER_IMAGE_BYTES = 16 * 1024 * 1024
const blockedV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) return !blockedV4.check(address, 'ipv4')
  return isIP(address) === 6 && globalV6.check(address, 'ipv6')
}

function imageUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Invalid browser image URL.')
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only public HTTP or HTTPS images can be downloaded.')
  url.hash = ''
  return url
}

async function resolveImageAddress(hostname: string, signal: AbortSignal) {
  const host = hostname.replace(/^\[|\]$/g, '')
  let stop: () => void = () => {}
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        stop = () => reject(new Error('Browser image download timed out.'))
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      }),
    ])
    if (!addresses.length || addresses.some((item) => !isPublicImageAddress(item.address)))
      throw new Error('Only public HTTP or HTTPS images can be downloaded.')
    return addresses[0]
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** No browser cookies or credentials; pin each redirect to its validated DNS result. */
export async function downloadBrowserImage(
  raw: string,
  signal = AbortSignal.timeout(20000),
): Promise<Buffer> {
  let url = imageUrl(raw)
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted()
    const address = await resolveImageAddress(url.hostname, signal)
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          family: address.family,
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
          headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' },
        },
        resolve,
      )
      request.once('error', reject)
      request.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
      const location = response.headers.location
      response.destroy()
      if (!location || redirect === 5) throw new Error('Too many browser image redirects.')
      url = imageUrl(new URL(location, url).href)
      continue
    }
    if (response.statusCode !== 200) {
      response.destroy()
      throw new Error(
        'The browser image could not be downloaded. Try copying and pasting the image.',
      )
    }
    if (Number(response.headers['content-length']) > MAX_BROWSER_IMAGE_BYTES) {
      response.destroy()
      throw new Error('The dropped image exceeds the 16 MiB limit.')
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of response) {
      bytes += chunk.length
      if (bytes > MAX_BROWSER_IMAGE_BYTES) {
        response.destroy()
        throw new Error('The dropped image exceeds the 16 MiB limit.')
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Too many browser image redirects.')
}

let importActive = false

export async function importBrowserQueryImage(
  source: BrowserImageImportSource,
  userData: string,
): Promise<string> {
  if (importActive) throw new Error('A browser image is already being imported.')
  importActive = true
  try {
    return await saveBrowserQueryImage(source, userData)
  } finally {
    importActive = false
  }
}

async function saveBrowserQueryImage(
  source: BrowserImageImportSource,
  userData: string,
): Promise<string> {
  let input: Buffer
  if (source?.kind === 'url') input = await downloadBrowserImage(source.url)
  else if (
    source?.kind === 'bytes' &&
    source.bytes instanceof Uint8Array &&
    source.bytes.byteLength <= MAX_BROWSER_IMAGE_BYTES
  )
    input = Buffer.from(source.bytes)
  else throw new Error('Invalid browser image payload.')
  if (!input.length || input.length > MAX_BROWSER_IMAGE_BYTES)
    throw new Error('The dropped image exceeds the 16 MiB limit.')
  const image = sharp(input, { limitInputPixels: 40_000_000, animated: false })
  const metadata = await image.metadata()
  if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format || ''))
    throw new Error('The dropped content is not a supported image.')
  const png = await image
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  const directory = path.join(userData, 'image-search-queries')
  await fs.mkdir(directory, { recursive: true })
  const target = path.join(directory, `browser-${crypto.randomUUID()}.png`)
  // Only prune this importer's old query copies, never original files or clipboard images.
  const entries = await fs.readdir(directory)
  const files = await Promise.all(
    entries
      .filter((name) => /^browser-[a-f0-9-]+\.png$/.test(name))
      .map(async (name) => {
        const file = path.join(directory, name)
        const stat = await fs.stat(file)
        return { file, bytes: stat.size, at: stat.mtimeMs }
      }),
  )
  let total = files.reduce((sum, file) => sum + file.bytes, png.length)
  for (const file of files.sort((a, b) => a.at - b.at)) {
    if (total <= 128 * 1024 * 1024 && Date.now() - file.at < 86400000) break
    await fs.unlink(file.file).catch(() => {})
    total -= file.bytes
  }
  await fs.writeFile(target, png, { flag: 'wx' })
  return target
}
