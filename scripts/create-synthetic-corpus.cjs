// Phase 0 synthetic corpus generator.
// Creates a fixed-structure synthetic image corpus OUTSIDE the repository
// (default: %TEMP%/phase0-corpus-100k) so it can never be git-tracked.
// Usage: node scripts/create-synthetic-corpus.cjs [--count=100000] [--root=<dir>] [--clean]

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function option(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const count = Math.max(1, Number(option('count', '100000')) || 100000)
const root = path.resolve(
  option('root', path.join(os.tmpdir(), `phase0-corpus-${Math.max(1, Math.round(count / 1000))}k`)),
)
const clean = process.argv.includes('--clean')

// Eight distinct tiny valid PNG buffers (1x1, varying color) so files are not
// byte-identical and decoders treat them as real images.
const COLORS = [
  [0x66, 0x33, 0x99],
  [0xd9, 0x42, 0x42],
  [0x42, 0xd9, 0x66],
  [0x42, 0x66, 0xd9],
  [0xd9, 0xd9, 0x42],
  [0x42, 0xd9, 0xd9],
  [0xd9, 0x42, 0xd9],
  [0x80, 0x80, 0x80],
]

function png1x1(r, g, b) {
  // Minimal 1x1 truecolor PNG built by hand (uncompressed zlib stream inside IDAT).
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, r, g, b]) // filter byte + RGB pixel
  const compressed = zlib.deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const VARIANTS = COLORS.map(([r, g, b]) => png1x1(r, g, b))
const FILES_PER_DIR = 500

function main() {
  const startedAt = Date.now()
  if (clean && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  fs.mkdirSync(root, { recursive: true })
  let written = 0
  let dirIndex = 0
  while (written < count) {
    const group = String(Math.floor(dirIndex / 10) % 10)
    const dir = path.join(root, `g${group}`, `d${String(dirIndex).padStart(5, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    const batch = Math.min(FILES_PER_DIR, count - written)
    for (let i = 0; i < batch; i += 1) {
      const variant = (written + i) % VARIANTS.length
      fs.writeFileSync(
        path.join(dir, `img_${String(i).padStart(4, '0')}_v${variant}.png`),
        VARIANTS[variant],
      )
    }
    written += batch
    dirIndex += 1
  }
  const elapsedMs = Date.now() - startedAt
  const bytes = fs.readdirSync(root).length // touch root for metadata
  console.log(
    JSON.stringify({
      root,
      requested: count,
      written,
      filesPerDirectory: FILES_PER_DIR,
      directories: dirIndex,
      variants: VARIANTS.length,
      elapsedMs,
      rootEntries: bytes,
    }),
  )
}

main()
