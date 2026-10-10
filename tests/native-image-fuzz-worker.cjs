'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function isWithin(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function main() {
  const [rootArgument, fileArgument, expectation] = process.argv.slice(2)
  if (!rootArgument || !fileArgument || !['accept', 'reject'].includes(expectation)) {
    fail('usage: native-image-fuzz-worker.cjs <temporary-root> <image> <accept|reject>')
    return
  }

  const systemTemp = fs.realpathSync(os.tmpdir())
  const corpusRoot = fs.realpathSync(rootArgument)
  const imagePath = fs.realpathSync(fileArgument)
  if (!isWithin(corpusRoot, systemTemp) || corpusRoot === systemTemp) {
    fail('fuzz corpus root must be a dedicated directory below the system temp directory')
    return
  }
  if (!isWithin(imagePath, corpusRoot) || imagePath === corpusRoot) {
    fail('fuzz input escaped the temporary corpus root')
    return
  }

  const addonPath = path.join(__dirname, '..', 'native', 'build', 'Release', 'fast_scanner.node')
  const addon = require(addonPath)
  const syncResult = addon.hashImage(imagePath)
  const syncAccepted = syncResult?.ok === true

  let asyncAccepted = false
  let asyncRejected
  try {
    const asyncResult = await addon.hashImageAsync(imagePath)
    asyncAccepted = asyncResult?.ok === true
    asyncRejected = asyncResult?.ok === false
  } catch {
    asyncRejected = true
  }

  const passed =
    expectation === 'accept'
      ? syncAccepted && asyncAccepted
      : syncResult?.ok === false && asyncRejected

  process.stdout.write(
    `${JSON.stringify({
      passed,
      expectation,
      syncAccepted,
      asyncAccepted,
      asyncRejected,
      syncError: typeof syncResult?.error === 'string' ? syncResult.error.slice(0, 160) : '',
    })}\n`,
  )
  if (!passed) process.exitCode = 2
}

main().catch((error) => {
  fail(error?.stack || String(error))
})
