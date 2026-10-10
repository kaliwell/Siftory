const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  CORE_RESOURCES,
  LEGACY_DUPLICATE_PATHS,
  OFFLINE_ONLY_RESOURCES,
  REQUIRED_RESOURCES,
  inspectPackagedResources,
  isInside,
  requiredResourcesForProfile,
} = require('../scripts/verify-packaged-resources.cjs')
const runtimeManifest = require('../resources/runtime-manifest.json')
const modelManifest = require('../models/manifest.json')
const {
  createProfileManifest,
  createProfileModelManifest,
} = require('../scripts/package-profile.cjs')

function createFixture(resources = REQUIRED_RESOURCES, profile = 'offline') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-packaged-resources-'))
  for (const [, relativePath] of resources) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fixture')
  }
  fs.writeFileSync(
    path.join(root, 'runtime-manifest.json'),
    JSON.stringify(createProfileManifest(runtimeManifest, profile)),
  )
  fs.writeFileSync(
    path.join(root, 'models', 'manifest.json'),
    JSON.stringify(createProfileModelManifest(modelManifest, profile)),
  )
  fs.cpSync(
    path.join(__dirname, '..', 'legal', 'third-party'),
    path.join(root, 'legal', 'third-party'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(__dirname, '..', 'legal', 'covered-source'),
    path.join(root, 'legal', 'covered-source'),
    { recursive: true },
  )
  return root
}

test('packaged resource inventory accepts one complete canonical resources tree', () => {
  const root = createFixture()
  try {
    const report = inspectPackagedResources(root)
    assert.equal(report.ok, true)
    assert.equal(report.requiredCount, REQUIRED_RESOURCES.length)
    assert.deepEqual(report.missing, [])
    assert.deepEqual(report.legacyDuplicates, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('online resource inventory accepts core resources without bundled models or FFmpeg', () => {
  const root = createFixture(CORE_RESOURCES, 'online')
  try {
    const report = inspectPackagedResources(root)
    assert.equal(report.ok, true)
    assert.equal(report.profile, 'online')
    assert.equal(report.requiredCount, CORE_RESOURCES.length)
    for (const [, relativePath] of OFFLINE_ONLY_RESOURCES) {
      assert.equal(fs.existsSync(path.join(root, relativePath)), false)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resource inspection defaults to online when no manifest profile is available', () => {
  const root = createFixture(CORE_RESOURCES, 'online')
  try {
    fs.rmSync(path.join(root, 'runtime-manifest.json'))
    const report = inspectPackagedResources(root)
    assert.equal(report.profile, 'online')
    assert.equal(report.requiredCount, CORE_RESOURCES.length)
    assert.equal(report.ok, false)
    assert.ok(report.missing.includes('runtimeManifest'))
    assert.deepEqual(requiredResourcesForProfile(), CORE_RESOURCES)
    assert.deepEqual(requiredResourcesForProfile('offline'), REQUIRED_RESOURCES)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid manifest and explicit profiles cannot silently select offline resource rules', () => {
  const root = createFixture(CORE_RESOURCES, 'online')
  try {
    assert.throws(
      () => inspectPackagedResources(root, { profile: 'portable' }),
      /Unknown package profile/,
    )
    const manifest = createProfileManifest(runtimeManifest, 'online')
    manifest.distributionProfile = 'portable'
    fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
    assert.throws(() => inspectPackagedResources(root), /Unknown package profile/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('packaged resource inventory reports missing files and legacy duplicates', () => {
  const root = createFixture()
  try {
    fs.rmSync(path.join(root, REQUIRED_RESOURCES[0][1]))
    const duplicatePath = path.join(root, LEGACY_DUPLICATE_PATHS[0])
    fs.mkdirSync(path.dirname(duplicatePath), { recursive: true })
    fs.writeFileSync(duplicatePath, 'duplicate')
    const report = inspectPackagedResources(root)
    assert.equal(report.ok, false)
    assert.deepEqual(report.missing, [REQUIRED_RESOURCES[0][0]])
    assert.deepEqual(report.legacyDuplicates, [LEGACY_DUPLICATE_PATHS[0].split(path.sep).join('/')])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('online resource inventory rejects model, tool, secret, and profile-confusion payloads', () => {
  const root = createFixture(CORE_RESOURCES, 'online')
  try {
    for (const relativePath of [
      path.join('ai-models', 'unexpected', 'model.onnx'),
      path.join('tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join('credentials', 'publisher.pfx'),
    ]) {
      const filePath = path.join(root, relativePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, 'forbidden')
    }
    const manifest = createProfileManifest(runtimeManifest, 'offline')
    fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
    fs.writeFileSync(
      path.join(root, 'models', 'manifest.json'),
      JSON.stringify(createProfileModelManifest(modelManifest, 'offline')),
    )
    const report = inspectPackagedResources(root, { profile: 'online' })
    assert.equal(report.ok, false)
    assert.deepEqual(report.forbiddenPayloads, [
      'ai-models/unexpected/model.onnx',
      'tools/ffmpeg/bin/ffmpeg.exe',
    ])
    assert.deepEqual(report.sensitivePayloads, ['credentials/publisher.pfx'])
    assert.match(report.manifestProblems.join('\n'), /expected online/)
    assert.match(report.modelManifestProblems.join('\n'), /expected online/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('offline resource inventory rejects tools outside the explicit FFmpeg allowlist', () => {
  const root = createFixture()
  try {
    const filePath = path.join(root, 'tools', 'video-semantic-review', 'index.html')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'review tool')
    const report = inspectPackagedResources(root)
    assert.equal(report.ok, false)
    assert.deepEqual(report.forbiddenPayloads, ['tools/video-semantic-review/index.html'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resource containment rejects sibling-prefix and parent traversal paths', () => {
  const root = path.resolve('C:\\release\\resources')
  assert.equal(isInside(root, path.join(root, 'models', 'model.onnx')), true)
  assert.equal(isInside(root, path.resolve(root, '..', 'resources-copy', 'model.onnx')), false)
  assert.equal(isInside(root, path.resolve(root, '..', 'outside.txt')), false)
})

// Both distribution profiles use sharp, including the two unpacked shared libraries.
// Use the actual package paths independently of CORE_RESOURCES to catch omissions.
for (const profile of ['online', 'offline']) {
  for (const [id, filename] of [
    ['sharpVipsLibrary', 'libvips-42.dll'],
    ['sharpVipsCppLibrary', 'libvips-cpp-8.18.6.dll'],
  ]) {
    for (const condition of ['missing', 'empty']) {
      test(`${profile} rejects ${condition} ${filename} even when the sharp binding exists`, () => {
        const root = createFixture(
          profile === 'online' ? CORE_RESOURCES : REQUIRED_RESOURCES,
          profile,
        )
        try {
          const library = path.join(
            root,
            'app.asar.unpacked',
            'node_modules',
            '@img',
            'sharp-win32-x64',
            'lib',
            filename,
          )
          if (condition === 'missing') fs.rmSync(library, { force: true })
          else fs.writeFileSync(library, '')
          const report = inspectPackagedResources(root, { profile })
          assert.equal(report.files.sharpBinding.exists, true)
          assert.equal(report.ok, false)
          assert.ok(report.missing.includes(id))
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }
}

for (const profile of ['online', 'offline']) {
  for (const mutation of ['missing-text', 'changed-text', 'self-consistent-replacement']) {
    test(`${profile} rejects ${mutation} in the actual license payload`, () => {
      const root = createFixture(
        profile === 'online' ? CORE_RESOURCES : REQUIRED_RESOURCES,
        profile,
      )
      try {
        const payload = path.join(root, 'legal', 'third-party')
        const manifestPath = path.join(payload, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const entry = manifest.files[0]
        const target = path.join(payload, entry.path)
        if (mutation === 'missing-text') fs.rmSync(target)
        else {
          const bytes = Buffer.from('replaced license evidence')
          fs.writeFileSync(target, bytes)
          if (mutation === 'self-consistent-replacement') {
            entry.bytes = bytes.length
            entry.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
            entry.source.sha256 = entry.sha256
            fs.writeFileSync(manifestPath, JSON.stringify(manifest))
          }
        }
        const report = inspectPackagedResources(root, { profile })
        assert.equal(report.ok, false)
        assert.equal(report.licensePayload.ok, false)
        if (mutation === 'self-consistent-replacement') {
          assert.ok(
            report.licensePayload.errors.some((error) =>
              error.includes('trusted expected manifest'),
            ),
          )
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
