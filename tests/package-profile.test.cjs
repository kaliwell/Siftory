const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')
const runtimeManifest = require('../resources/runtime-manifest.json')
const modelManifest = require('../models/manifest.json')
const { runtimePackageExclusions } = require('../scripts/runtime-package-pruning.cjs')
const {
  createBuilderConfig,
  createProfileManifest,
  createProfileModelManifest,
  expectedInstallerName,
  normalizePackageProfile,
  packageProfileFromArgs,
} = require('../scripts/package-profile.cjs')

test('package profile defaults to online and rejects unknown values', () => {
  assert.equal(packageProfileFromArgs([], {}), 'online')
  assert.equal(packageProfileFromArgs(['--profile=ONLINE'], {}), 'online')
  assert.throws(() => normalizePackageProfile('portable'), /expected offline or online/)
})

test('package profile gives explicit arguments precedence over environment and shared default', () => {
  assert.equal(packageProfileFromArgs([], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }), 'offline')
  assert.equal(
    packageProfileFromArgs(['--profile=online'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }),
    'online',
  )
  assert.equal(
    packageProfileFromArgs(['--profile=offline'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'online' }),
    'offline',
  )
})

test('online profile excludes heavyweight resources and uses a distinct installer name', () => {
  const stagingDir = path.resolve('artifacts', 'package-profile', 'online')
  const config = createBuilderConfig(packageJson, 'online', stagingDir)
  const destinations = config.extraResources.map((entry) => entry.to)

  assert.equal(destinations.includes('ai-models'), false)
  assert.equal(destinations.includes('tools'), false)
  assert.equal(
    packageJson.build.extraResources.some((entry) => entry.to === 'ai-models'),
    false,
  )
  assert.equal(
    packageJson.build.extraResources.some((entry) => entry.to === 'tools'),
    false,
  )
  assert.equal(destinations.includes('models'), false)
  assert.equal(destinations.includes('models/manifest.json'), true)
  assert.equal(
    config.extraResources.find((entry) => entry.to === 'models/manifest.json').from,
    path.join(stagingDir, 'models-manifest.json'),
  )
  assert.equal(destinations.includes('sensevoice/sensevoice_runner.py'), true)
  assert.equal(
    destinations.some((target) => target.includes('SenseVoiceSmall')),
    false,
  )
  assert.equal(config.artifactName, '${productName} Online Setup ${version}.${ext}')
  assert.equal(expectedInstallerName(packageJson, 'online'), 'Siftory Online Setup 1.0.0.exe')
})

test('offline profile bundles approved embeddings but not user-supplied model slots', () => {
  const config = createBuilderConfig(packageJson, 'offline', path.resolve('artifacts', 'offline'))
  const destinations = config.extraResources.map((entry) => entry.to)

  assert.equal(destinations.includes('models'), false)
  assert.equal(destinations.includes('models/manifest.json'), true)
  assert.equal(destinations.includes('ai-models'), true)
  assert.equal(destinations.includes('tools/ffmpeg'), true)
  const offlineModels = config.extraResources.find((entry) => entry.to === 'ai-models')
  const offlineTools = config.extraResources.find((entry) => entry.to === 'tools/ffmpeg')
  assert.deepEqual(offlineModels.filter, [
    'dinov2_vitb14/**/*',
    'clip_vit_base_patch32/**/*',
    'clip_vit_b32_multilingual_v1_text/**/*',
  ])
  assert.deepEqual(offlineTools.filter, ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'bin/README.md'])
  assert.equal(destinations.includes('sensevoice/sensevoice_runner.py'), true)
  assert.equal(
    destinations.some((target) => target.includes('SenseVoiceSmall')),
    false,
  )
  assert.equal(config.artifactName, undefined)
  assert.equal(expectedInstallerName(packageJson, 'offline'), 'Siftory Setup 1.0.0.exe')
})

test('both installers preserve user data on uninstall', () => {
  for (const profile of ['online', 'offline']) {
    const config = createBuilderConfig(packageJson, profile, path.resolve('artifacts', profile))
    assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  }
})

test('both package profiles omit reviewed legacy runtime code without changing base files', () => {
  const original = structuredClone(packageJson.build.files)
  for (const profile of ['online', 'offline']) {
    const config = createBuilderConfig(packageJson, profile, path.resolve('artifacts', profile))
    assert.deepEqual(config.files, [...original, ...runtimePackageExclusions()])
    assert.equal(
      config.files.some((entry) => entry === '!node_modules/onnxruntime-web/**/*'),
      false,
    )
  }
  assert.deepEqual(packageJson.build.files, original)
})

test('online runtime inventory marks the native addon and UI font as bundled', () => {
  const manifest = createProfileManifest(runtimeManifest, 'online')
  assert.equal(manifest.distributionProfile, 'online')
  assert.deepEqual(
    manifest.components
      .filter((component) => component.distribution.defaultBundled)
      .map((component) => component.id),
    ['floating-clock-fast-scanner-electron', 'adobe-source-han-sans-cn-vf-2-005'],
  )
  assert.equal(runtimeManifest.distributionProfile, undefined)
})

test('model download manifest truthfully reflects the selected package profile', () => {
  const online = createProfileModelManifest(modelManifest, 'online')
  const offline = createProfileModelManifest(modelManifest, 'offline')
  assert.equal(online.distributionProfile, 'online')
  assert.equal(
    online.models.every((model) => model.defaultBundled === false),
    true,
  )
  assert.equal(offline.distributionProfile, 'offline')
  assert.equal(
    offline.models.every((model) => model.defaultBundled === true),
    true,
  )
  assert.equal(modelManifest.distributionProfile, undefined)
})

test('offline runtime inventory is also rebuilt from the fixed component allowlist', () => {
  const manifest = createProfileManifest(runtimeManifest, 'offline')
  assert.deepEqual(
    manifest.components
      .filter((component) => component.distribution.defaultBundled)
      .map((component) => component.id),
    [
      'dinov2-vitb14-xenova-q4',
      'clip-vit-b32-xenova-q4',
      'multilingual-clip-vit-b32-text-quint8',
      'gyan-ffmpeg-full-8-1-2',
      'floating-clock-fast-scanner-electron',
      'adobe-source-han-sans-cn-vf-2-005',
    ],
  )
})

test('pending llama.cpp and GGUF candidates remain unbundled in every package profile', () => {
  const pendingIds = [
    'llama-cpp-b10441-windows-x64-managed-video-runtime-candidate',
    'qwen3-vl-2b-instruct-q4-k-m-gguf-managed-runtime-candidate',
  ]
  for (const profile of ['online', 'offline']) {
    const manifest = createProfileManifest(runtimeManifest, profile)
    for (const id of pendingIds) {
      const component = manifest.components.find((candidate) => candidate.id === id)
      assert.ok(component, `${profile}: missing ${id}`)
      assert.equal(component.distribution.defaultBundled, false, `${profile}: ${id}`)
      assert.equal(component.license.reviewStatus, 'legal-review-required', `${profile}: ${id}`)
      assert.equal(
        component.artifacts.every((artifact) => artifact.fetchPolicy === 'manual-review'),
        true,
      )
    }
  }
})

test('ordinary package builds verify deterministic native resources before packaging', () => {
  const buildSource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'build.cjs'), 'utf8')
  const bindingSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'native', 'binding.gyp'),
    'utf8',
  )
  const nativeBuild = buildSource.indexOf("['run', 'build:native:electron']")
  const resourceVerification = buildSource.indexOf("['run', 'resources:verify'")
  const packagePreparation = buildSource.indexOf('preparePackageProfile(process.cwd(), profile)')

  assert.match(bindingSource, /"VCLinkerTool"[\s\S]*"\/Brepro"/)
  assert.ok(nativeBuild >= 0)
  assert.ok(resourceVerification > nativeBuild)
  assert.ok(packagePreparation > resourceVerification)
})
