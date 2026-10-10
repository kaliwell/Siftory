const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const addonPath = path.resolve(argument('--addon', 'native/build/Release/fast_scanner.node'))
const filesPerDirectory = Math.max(1, Number(argument('--files-per-directory', '512')))
const addon = require(addonPath)
const excluded = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function waitForScan() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (progress.state !== 'scanning') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  addon.stopScan()
  throw new Error('scan benchmark timed out')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-fallback-benchmark-'))
  try {
    const pictures = path.join(root, 'Pictures')
    fs.mkdirSync(pictures)
    fs.writeFileSync(path.join(pictures, 'visible.png'), png)
    for (const directory of excluded) {
      const target = path.join(root, directory)
      fs.mkdirSync(target)
      for (let index = 0; index < filesPerDirectory; index++) {
        fs.writeFileSync(path.join(target, `${String(index).padStart(4, '0')}.png`), png)
      }
    }
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    const started = addon.scanDirectory(root, 'full')
    if (!started.ok) throw new Error(started.error || 'scan did not start')
    const progress = await waitForScan()
    console.log(
      JSON.stringify({
        version: addon.getNativeVersion(),
        excludedDirectories: excluded.length,
        excludedCandidateFiles: excluded.length * filesPerDirectory,
        indexedCount: addon.getIndexStats().indexedCount,
        durationMs: progress.totalScanMs || progress.durationMs,
        enumFileCount: progress.enumFileCount,
        enumSkippedDirCount: progress.enumSkippedDirCount,
        fallbackCode: progress.fallbackCode,
      }),
    )
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
