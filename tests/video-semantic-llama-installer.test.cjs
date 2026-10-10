const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const AdmZip = require('adm-zip')
const {
  ARTIFACTS,
  assertPinnedDownloadUrl,
  cachePathFor,
  downloadWithWindowsBits,
  extractRuntimeArchive,
  install,
  parseArgs,
  safeZipEntryPath,
} = require('../scripts/install-video-semantic-llama-runtime.cjs')

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-llama-installer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('requires explicit local-evaluation consent and the pinned Vulkan variant', () => {
  assert.throws(() => parseArgs([]), /variant=vulkan/)
  assert.throws(() => parseArgs(['--variant=cpu']), /variant=vulkan/)
  assert.throws(() => parseArgs(['--variant=vulkan']), /consent/)
  assert.throws(
    () => parseArgs(['--variant=vulkan', '--accept-local-evaluation', '--target-dir=elsewhere']),
    /Unknown argument/,
  )
  const accepted = parseArgs(['--variant=vulkan', '--accept-local-evaluation'])
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.variant, 'vulkan')
  const verifyOnly = parseArgs(['--variant=vulkan', '--verify-only'])
  assert.equal(verifyOnly.verifyOnly, true)
})

test('normalizes safe ZIP paths and rejects traversal or absolute paths', () => {
  assert.equal(safeZipEntryPath('bin\\llama-server.exe'), 'bin/llama-server.exe')
  for (const candidate of [
    '../escape.exe',
    'bin/../../escape.exe',
    '/absolute.exe',
    'C:/absolute.exe',
    'bin/./server.exe',
    'bad\0name.exe',
  ]) {
    assert.throws(() => safeZipEntryPath(candidate), /unsafe entry path/)
  }
})

test('extracts a bounded runtime archive and records deterministic file digests', async (t) => {
  const root = temporaryRoot(t)
  const archivePath = path.join(root, 'runtime.zip')
  const destination = path.join(root, 'destination')
  const archive = new AdmZip()
  archive.addFile('llama-server.exe', Buffer.from('server-fixture'))
  archive.addFile('ggml-vulkan.dll', Buffer.from('vulkan-fixture'))
  archive.writeZip(archivePath)
  fs.mkdirSync(destination)

  const files = await extractRuntimeArchive(archivePath, destination)
  assert.deepEqual(
    files.map((file) => file.path),
    ['ggml-vulkan.dll', 'llama-server.exe'],
  )
  assert.equal(
    files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    true,
  )
  assert.equal(
    fs.readFileSync(path.join(destination, 'llama-server.exe'), 'utf8'),
    'server-fixture',
  )
})

test('refuses to replace an existing directory without a valid local receipt', async (t) => {
  const root = temporaryRoot(t)
  const installRoot = path.join(root, 'runtime')
  fs.mkdirSync(installRoot)
  await assert.rejects(
    install({
      accepted: true,
      variant: 'vulkan',
      installRoot,
      cacheRoot: path.join(root, 'cache'),
    }),
    /already exists but is not verified/,
  )
})

test('uses content-addressed cache names for every pinned artifact', () => {
  const root = path.resolve('cache-fixture')
  for (const artifact of Object.values(ARTIFACTS)) {
    assert.equal(cachePathFor(root, artifact), path.join(root, 'sha256', `${artifact.sha256}.blob`))
  }
})

test('BITS downloader is pinned to approved HTTPS hosts and publishes only exact content', async (t) => {
  for (const sourceUrl of ['http://github.com/file', 'https://example.com/file']) {
    assert.throws(() => assertPinnedDownloadUrl(sourceUrl), /approved HTTPS host/)
  }
  const root = temporaryRoot(t)
  const destination = path.join(root, 'artifact.blob')
  const payload = Buffer.from('complete pinned fixture')
  const artifact = {
    id: 'fixture',
    sourceUrl: 'https://github.com/owner/release/download/v1/artifact.bin',
    sizeBytes: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
  }
  const calls = []
  await downloadWithWindowsBits(artifact, destination, {
    runProcess: async (executable, args, options) => {
      calls.push({ executable, args, options })
      fs.writeFileSync(args.at(-1), payload)
    },
  })
  assert.equal(fs.readFileSync(destination).equals(payload), true)
  assert.equal(calls[0].executable.toLowerCase().endsWith('powershell.exe'), true)
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.shell, false)
})

test('BITS downloader rejects a truncated artifact without publishing it', async (t) => {
  const root = temporaryRoot(t)
  const destination = path.join(root, 'artifact.blob')
  const payload = Buffer.from('complete pinned fixture')
  const artifact = {
    id: 'fixture',
    sourceUrl: 'https://huggingface.co/repository/resolve/revision/artifact.gguf',
    sizeBytes: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
  }
  await assert.rejects(
    downloadWithWindowsBits(artifact, destination, {
      runProcess: async (_executable, args) =>
        fs.writeFileSync(args.at(-1), payload.subarray(0, 5)),
    }),
    /size-mismatch/,
  )
  assert.equal(fs.existsSync(destination), false)
})
