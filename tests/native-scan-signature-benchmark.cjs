const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const addonPath = path.resolve(argument('--addon', 'native/build/Release/fast_scanner.node'))
const fakeCount = Math.max(1, Number(argument('--count', '256')))
const fakeSizeMiB = Math.max(1, Number(argument('--size-mib', '16')))
const rounds = Math.max(1, Number(argument('--rounds', '3')))
const addon = require(addonPath)

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-signature-benchmark-'))
  const validPath = path.join(root, 'valid.png')
  const fakeSource = path.join(root, 'fake-0000.jpg')
  try {
    fs.writeFileSync(validPath, Buffer.from(PNG_1PX, 'base64'))
    const handle = fs.openSync(fakeSource, 'w')
    fs.writeSync(handle, Buffer.from('not-an-image'), 0, 12, 0)
    fs.writeSync(handle, Buffer.alloc(1), 0, 1, fakeSizeMiB * 1024 * 1024 - 1)
    fs.closeSync(handle)
    for (let index = 1; index < fakeCount; index++) {
      fs.linkSync(fakeSource, path.join(root, `fake-${String(index).padStart(4, '0')}.jpg`))
    }

    addon.configureScanThumbnails('', false, 6)
    const samples = []
    for (let round = 0; round < rounds; round++) {
      addon.clearIndex()
      const started = addon.scanDirectory(root, 'full')
      if (!started.ok) throw new Error(started.error || 'scan did not start')
      const progress = await waitForScan()
      const indexedCount = addon.getIndexStats().indexedCount
      if (progress.state !== 'idle' || indexedCount !== 1) {
        throw new Error(`unexpected result: ${JSON.stringify({ progress, indexedCount })}`)
      }
      samples.push({
        durationMs: progress.totalScanMs || progress.durationMs,
        skippedCount: progress.skippedCount,
        signatureRejectedCount: progress.signatureRejectedCount,
      })
    }
    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        version: addon.getNativeVersion(),
        fakeCount,
        fakeSizeMiB,
        avoidableLogicalReadMiB: fakeCount * fakeSizeMiB,
        medianMs: durations[Math.floor(durations.length / 2)],
        samples,
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
