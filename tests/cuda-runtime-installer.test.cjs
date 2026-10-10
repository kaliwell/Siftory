const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const manifest = require('../resources/runtime-manifest.json')
const {
  CUDA_RUNTIME_COMPONENT_IDS,
  NVIDIA_COMPONENT_IDS,
  artifactByRole,
  parseInstallerArgs,
} = require('../scripts/install-cuda-runtime.cjs')
const { createProfileManifest } = require('../scripts/package-profile.cjs')

test('CUDA installer fixes component scope and requires an explicit target root', () => {
  assert.throws(() => parseInstallerArgs(['--verify-only']), /--target-dir is required/)
  assert.throws(
    () => parseInstallerArgs(['--target-dir=fixture', '--component=unexpected']),
    /components and license identifiers are fixed/,
  )
  const parsed = parseInstallerArgs([
    '--target-dir=fixture',
    '--cache-dir=cache',
    '--offline',
    '--accept-nvidia-license',
  ])
  assert.deepEqual(parsed.options.componentIds, CUDA_RUNTIME_COMPONENT_IDS)
  assert.deepEqual(parsed.options.acceptedLicenses, NVIDIA_COMPONENT_IDS)
  assert.equal(parsed.options.offline, true)
})

test('CUDA runtime remains optional in both package profiles and pins only HTTPS archives', () => {
  for (const profile of ['offline', 'online']) {
    const profileManifest = createProfileManifest(manifest, profile)
    const components = profileManifest.components.filter((component) =>
      CUDA_RUNTIME_COMPONENT_IDS.includes(component.id),
    )
    assert.equal(components.length, CUDA_RUNTIME_COMPONENT_IDS.length)
    for (const component of components) {
      assert.equal(component.componentType, 'optional-runtime')
      assert.equal(component.distribution.defaultBundled, false)
      for (const artifact of component.artifacts) {
        if (artifact.archive) {
          assert.equal(new URL(artifact.sourceUrl).protocol, 'https:')
          assert.match(artifact.archive.sha256, /^[a-f0-9]{64}$/)
          assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
        }
      }
    }
  }
  const components = manifest.components.filter((component) =>
    CUDA_RUNTIME_COMPONENT_IDS.includes(component.id),
  )
  for (const id of NVIDIA_COMPONENT_IDS) {
    const component = components.find((candidate) => candidate.id === id)
    assert.equal(component.license.acceptanceRequired, true)
    assert.equal(new URL(component.license.sourceUrl).protocol, 'https:')
  }
})

test('worker and provider gate inputs are exact local-build artifacts', () => {
  const worker = artifactByRole(manifest, 'cuda-embedding-worker')
  const gates = artifactByRole(manifest, 'cuda-provider-gates')
  assert.equal(worker.fetchPolicy, 'local-build')
  assert.equal(gates.fetchPolicy, 'local-build')
  assert.equal(path.basename(worker.targetPath), 'floating_clock_cuda_embedding_worker.exe')
  assert.equal(path.basename(gates.targetPath), 'provider-gates.json')
})
