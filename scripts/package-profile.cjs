const fs = require('node:fs')
const path = require('node:path')
const { renderThirdPartyComponents } = require('./generate-third-party-components.cjs')
const { runtimePackageExclusions } = require('./runtime-package-pruning.cjs')

const PACKAGE_PROFILES = new Set(['offline', 'online'])
const DEFAULT_PACKAGE_PROFILE = 'online'
const PROFILE_BUNDLED_COMPONENT_IDS = Object.freeze({
  online: new Set(['floating-clock-fast-scanner-electron', 'adobe-source-han-sans-cn-vf-2-005']),
  offline: new Set([
    'dinov2-vitb14-xenova-q4',
    'clip-vit-b32-xenova-q4',
    'multilingual-clip-vit-b32-text-quint8',
    'gyan-ffmpeg-full-8-1-2',
    'floating-clock-fast-scanner-electron',
    'adobe-source-han-sans-cn-vf-2-005',
  ]),
})
const OFFLINE_BUNDLED_MODEL_NAMES = new Set([
  'dinov2_vitb14',
  'clip_vit_base_patch32',
  'clip_vit_b32_multilingual_v1_text',
])
const OFFLINE_EXTRA_RESOURCES = Object.freeze([
  {
    from: 'ai-models',
    to: 'ai-models',
    filter: [
      'dinov2_vitb14/**/*',
      'clip_vit_base_patch32/**/*',
      'clip_vit_b32_multilingual_v1_text/**/*',
    ],
  },
  {
    from: 'tools/ffmpeg',
    to: 'tools/ffmpeg',
    filter: ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'bin/README.md'],
  },
])

function normalizePackageProfile(value) {
  const profile = String(value || DEFAULT_PACKAGE_PROFILE)
    .trim()
    .toLowerCase()
  if (!PACKAGE_PROFILES.has(profile)) {
    throw new Error(`Unknown package profile "${profile}"; expected offline or online`)
  }
  return profile
}

function packageProfileFromArgs(args = process.argv.slice(2), env = process.env) {
  const argument = args.find((value) => value.startsWith('--profile='))
  return normalizePackageProfile(
    argument?.slice('--profile='.length) ||
      env.FLOATING_CLOCK_PACKAGE_PROFILE ||
      DEFAULT_PACKAGE_PROFILE,
  )
}

function bundledComponentIdsForProfile(profile) {
  return PROFILE_BUNDLED_COMPONENT_IDS[normalizePackageProfile(profile)]
}

function createProfileManifest(manifest, profile) {
  const normalized = normalizePackageProfile(profile)
  const result = structuredClone(manifest)
  result.distributionProfile = normalized
  const bundledIds = bundledComponentIdsForProfile(normalized)
  for (const component of result.components) {
    component.distribution.defaultBundled = bundledIds.has(component.id)
  }
  return result
}

function createProfileModelManifest(manifest, profile) {
  const normalized = normalizePackageProfile(profile)
  const result = structuredClone(manifest)
  result.distributionProfile = normalized
  for (const model of result.models || []) {
    model.defaultBundled = normalized === 'offline' && OFFLINE_BUNDLED_MODEL_NAMES.has(model.name)
  }
  return result
}

function createBuilderConfig(packageJson, profile, stagingDir) {
  const normalized = normalizePackageProfile(profile)
  const config = structuredClone(packageJson.build)
  config.files = [...(config.files || []), ...runtimePackageExclusions()]
  const runtimeManifest = path.join(stagingDir, 'runtime-manifest.json')
  const modelManifest = path.join(stagingDir, 'models-manifest.json')
  const componentInventory = path.join(stagingDir, 'THIRD_PARTY_COMPONENTS.md')
  config.extraResources = config.extraResources.flatMap((entry) => {
    if (entry.to === 'runtime-manifest.json') return [{ ...entry, from: runtimeManifest }]
    if (entry.to === 'models/manifest.json') return [{ ...entry, from: modelManifest }]
    if (entry.to === 'legal/THIRD_PARTY_COMPONENTS.md') {
      return [{ ...entry, from: componentInventory }]
    }
    if (entry.to === 'models') {
      return [{ from: 'models/manifest.json', to: 'models/manifest.json' }]
    }
    return [entry]
  })
  if (normalized === 'offline') {
    config.extraResources.push(...structuredClone(OFFLINE_EXTRA_RESOURCES))
  }
  if (normalized === 'online') {
    config.artifactName = '${productName} Online Setup ${version}.${ext}'
  }
  return config
}

function preparePackageProfile(projectRoot, profile) {
  const normalized = normalizePackageProfile(profile)
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  const sourceModelManifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'models', 'manifest.json'), 'utf8'),
  )
  const stagingDir = path.join(projectRoot, 'artifacts', 'package-profile', normalized)
  fs.mkdirSync(stagingDir, { recursive: true })
  const profileManifest = createProfileManifest(manifest, normalized)
  fs.writeFileSync(
    path.join(stagingDir, 'runtime-manifest.json'),
    `${JSON.stringify(profileManifest, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(stagingDir, 'models-manifest.json'),
    `${JSON.stringify(createProfileModelManifest(sourceModelManifest, normalized), null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(stagingDir, 'THIRD_PARTY_COMPONENTS.md'),
    renderThirdPartyComponents(profileManifest),
    'utf8',
  )
  const builderConfig = createBuilderConfig(packageJson, normalized, stagingDir)
  const configPath = path.join(stagingDir, 'electron-builder.json')
  fs.writeFileSync(configPath, `${JSON.stringify(builderConfig, null, 2)}\n`, 'utf8')
  return { profile: normalized, stagingDir, configPath, builderConfig, profileManifest }
}

function expectedInstallerName(packageJson, profile) {
  const productName = packageJson.build?.productName || packageJson.name
  const suffix = normalizePackageProfile(profile) === 'online' ? ' Online' : ''
  return `${productName}${suffix} Setup ${packageJson.version}.exe`
}

module.exports = {
  DEFAULT_PACKAGE_PROFILE,
  OFFLINE_EXTRA_RESOURCES,
  OFFLINE_BUNDLED_MODEL_NAMES,
  PROFILE_BUNDLED_COMPONENT_IDS,
  bundledComponentIdsForProfile,
  createBuilderConfig,
  createProfileModelManifest,
  createProfileManifest,
  expectedInstallerName,
  normalizePackageProfile,
  packageProfileFromArgs,
  preparePackageProfile,
}
