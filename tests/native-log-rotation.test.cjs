const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const addonPath = path.resolve('native', 'build', 'Release', 'fast_scanner.node')
const secretPath = 'C:\\Users\\Private Person\\Pictures\\sensitive-name.png'

function runLogProbe(directory, overrides = {}, threads = 8, writes = 100) {
  const script = `
    const addon = require(${JSON.stringify(addonPath)})
    const result = addon.runNativeLogTest(
      ${JSON.stringify(secretPath)},
      ${threads},
      ${writes}
    )
    process.stdout.write(JSON.stringify(result))
  `
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLOATING_CLOCK_NATIVE_LOG_TEST: '1',
      FLOATING_CLOCK_NATIVE_LOG_DIR: directory,
      FLOATING_CLOCK_NATIVE_LOG_MAX_BYTES: '512',
      FLOATING_CLOCK_NATIVE_LOG_BACKUPS: '2',
      IMAGESEARCH_VERBOSE_LOG: '1',
      IMAGESEARCH_VERBOSE_PATHS: '',
      ...overrides,
    },
  })
}

test('native logger serializes concurrent writes, rotates at the boundary, and redacts paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-log-'))
  const probe = runLogProbe(directory)
  assert.equal(probe.status, 0, probe.stderr)
  const result = JSON.parse(probe.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.maxBytes, 512)
  assert.equal(result.backupCount, 2)
  assert.equal(result.verbosePaths, false)

  const files = fs
    .readdirSync(directory)
    .filter((name) => /^image-search-scan\.log(?:\.\d+)?$/.test(name))
    .sort()
  assert.deepEqual(files, [
    'image-search-scan.log',
    'image-search-scan.log.1',
    'image-search-scan.log.2',
  ])
  for (const name of files) {
    assert.ok(fs.statSync(path.join(directory, name)).size <= 512)
  }

  const contents = files
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('')
  assert.doesNotMatch(contents, /Private Person|sensitive-name\.png/)
  assert.match(contents, /<path#[0-9a-f]{16}>/)
  for (const line of contents.trim().split(/\r?\n/)) {
    assert.match(
      line,
      /^\[[^\]]+\]\[[^\]]+\] (?:TEST_WRITE worker=\d+ index=\d+ path=<path#[0-9a-f]{16}>|CLEANUP fast_scanner shutdown complete)$/,
    )
  }
})

test('native logger shows a privacy warning before explicitly enabled absolute paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-paths-'))
  const probe = runLogProbe(
    directory,
    {
      FLOATING_CLOCK_NATIVE_LOG_MAX_BYTES: '4096',
      IMAGESEARCH_VERBOSE_PATHS: '1',
    },
    1,
    1,
  )
  assert.equal(probe.status, 0, probe.stderr)
  const contents = fs.readFileSync(path.join(directory, 'image-search-scan.log'), 'utf8')
  assert.match(contents, /PRIVACY_WARNING absolute paths enabled by explicit/)
  assert.match(contents, /C:\\Users\\Private Person\\Pictures\\sensitive-name\.png/)
})

test('native logger centrally redacts unexpected raw absolute paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-raw-'))
  const probe = runLogProbe(
    directory,
    { FLOATING_CLOCK_NATIVE_LOG_MAX_BYTES: '4096' },
    1,
    1,
  )
  assert.equal(probe.status, 0, probe.stderr)
  const contents = fs.readFileSync(path.join(directory, 'image-search-scan.log'), 'utf8')
  assert.doesNotMatch(contents, /Private Person|sensitive-name\.png/)
  assert.match(contents, /TEST_RAW <absolute-path-redacted>/)
})

test('native logger failures remain fail-open when the configured directory is unusable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-fail-'))
  const unusableDirectory = path.join(root, 'not-a-directory')
  fs.writeFileSync(unusableDirectory, 'occupied', 'utf8')
  const probe = runLogProbe(unusableDirectory, {}, 2, 20)
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(JSON.parse(probe.stdout).ok, true)
  assert.equal(fs.readFileSync(unusableDirectory, 'utf8'), 'occupied')
})

test('native logger simulated disk-full writes remain fail-open', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-full-'))
  const probe = runLogProbe(
    directory,
    { FLOATING_CLOCK_NATIVE_LOG_FORCE_WRITE_FAILURE: '1' },
    2,
    20,
  )
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(JSON.parse(probe.stdout).ok, true)
  assert.deepEqual(fs.readdirSync(directory), [])
})
