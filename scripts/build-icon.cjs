// Build build/icon.ico from the rounded-corner PNG logo set (PNG-payload ICO, Vista+).
// Uses the project's sharp dependency. Usage: node scripts/build-icon.cjs

const path = require('node:path')
const fs = require('node:fs')
const sharp = require('sharp')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SRC_DIR = path.resolve(__dirname, '..', 'logo', 'rounded-corner-icon2-png-sizes')
const OUT_FILE = path.resolve(__dirname, '..', 'build', 'icon.ico')

async function main() {
  const payloads = []
  for (const size of SIZES) {
    const src = path.join(SRC_DIR, `${size}x${size}.png`)
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`)
    const png = await sharp(src).ensureAlpha().png().toBuffer()
    payloads.push({ size, png })
  }

  const headerSize = 6 + payloads.length * 16
  const icon = Buffer.alloc(headerSize)
  icon.writeUInt16LE(0, 0) // reserved
  icon.writeUInt16LE(1, 2) // type: icon
  icon.writeUInt16LE(payloads.length, 4)

  let offset = headerSize
  const blobs = []
  payloads.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    icon.writeUInt8(size >= 256 ? 0 : size, entry) // 0 means 256
    icon.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    icon.writeUInt8(0, entry + 2) // palette
    icon.writeUInt8(0, entry + 3) // reserved
    icon.writeUInt16LE(1, entry + 4) // planes
    icon.writeUInt16LE(32, entry + 6) // bpp
    icon.writeUInt32LE(png.length, entry + 8)
    icon.writeUInt32LE(offset, entry + 12)
    blobs.push(png)
    offset += png.length
  })

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, Buffer.concat([icon, ...blobs]))
  console.log(`wrote ${OUT_FILE} (${offset} bytes, ${payloads.length} sizes)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
