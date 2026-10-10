const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { inspectLicensePayload } = require('../scripts/check-license-payload.cjs')
const { renderThirdPartyComponents } = require('../scripts/generate-third-party-components.cjs')
const {
  collectNodeComponents,
  renderNodeComponents,
} = require('../scripts/generate-node-third-party-components.cjs')

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'resources', 'runtime-manifest.json'), 'utf8'),
)

test('generated third-party inventory exactly matches the runtime manifest', () => {
  const inventory = fs.readFileSync(path.join(root, 'THIRD_PARTY_COMPONENTS.md'), 'utf8')
  assert.equal(inventory, renderThirdPartyComponents(manifest))
  for (const component of manifest.components) {
    assert.match(inventory, new RegExp(`\\b${component.id}\\b`))
  }
})

test('generated Node production inventory matches the lockfile and resolves license declarations', () => {
  const components = collectNodeComponents(root)
  const inventory = fs.readFileSync(path.join(root, 'NODE_THIRD_PARTY_COMPONENTS.md'), 'utf8')
  assert.equal(inventory, renderNodeComponents(components))
  assert.ok(components.length > 0)
  assert.equal(components.filter((component) => component.license === 'NOASSERTION').length, 0)
})

test('distribution blockers remain explicit instead of becoming approvals', () => {
  const reviews = new Set(manifest.components.map((component) => component.license.reviewStatus))
  assert.ok(reviews.has('legal-review-required'))
  assert.ok(reviews.has('project-license-pending'))
  assert.ok(manifest.components.some((component) => component.license.spdx === 'AGPL-3.0-only'))
  assert.ok(manifest.components.some((component) => component.license.spdx === 'GPL-3.0-or-later'))
})

test('third-party notice describes the actual bundled distribution', () => {
  const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  assert.doesNotMatch(notice, /Models are NOT bundled/i)
  assert.match(notice, /runtime-manifest\.json/)
  assert.match(notice, /not legal\s+approval/i)
  assert.match(notice, /FFmpeg 8\.1\.2 full build/)
  assert.match(notice, /Source Han Sans CN Variable/)
  assert.match(notice, /OFL-1\.1/)
  assert.match(notice, /not approved for public or commercial distribution/i)
})

test('packaging copies all legal records outside app.asar', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const resources = new Map(packageJson.build.extraResources.map((entry) => [entry.from, entry.to]))
  assert.equal(resources.get('THIRD_PARTY_NOTICES.md'), 'legal/THIRD_PARTY_NOTICES.md')
  assert.equal(resources.get('THIRD_PARTY_COMPONENTS.md'), 'legal/THIRD_PARTY_COMPONENTS.md')
  assert.equal(
    resources.get('NODE_THIRD_PARTY_COMPONENTS.md'),
    'legal/NODE_THIRD_PARTY_COMPONENTS.md',
  )
  assert.equal(resources.get('legal/SourceHanSans-OFL-1.1.txt'), 'legal/SourceHanSans-OFL-1.1.txt')
  assert.equal(resources.get('legal/license-decisions.json'), 'legal/LICENSE_DECISIONS.json')
  assert.equal(resources.get('legal/third-party'), 'legal/third-party')
  assert.equal(resources.get('legal/covered-source'), 'legal/covered-source')
  assert.equal(resources.has('legal/PROPRIETARY-EULA.template.md'), false)
  assert.equal(resources.has('legal/PRIVACY_POLICY.template.md'), false)
  assert.equal(resources.has('legal/SECURITY_AND_SUPPORT_POLICY.template.md'), false)
  assert.equal(resources.has('legal/INDIVIDUAL_PUBLISHER_INTAKE.template.md'), false)
})

const payloadRoot = path.join(root, 'legal', 'third-party')
const payloadHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const payloadManifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf8'))

function withPayloadFixture(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'license-payload-test-'))
  const copy = path.join(scratch, 'payload')
  fs.cpSync(payloadRoot, copy, { recursive: true })
  const manifestPath = path.join(copy, 'manifest.json')
  const bytes = fs.readFileSync(manifestPath)
  const payload = JSON.parse(bytes)
  const save = () => fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`)
  try {
    run({ scratch, copy, payload, save, manifestSha256: payloadHash(bytes) })
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

test('supplemental license payload matches exact texts, scope and source lock versions', () => {
  const report = inspectLicensePayload({ packageLockPath: path.join(root, 'package-lock.json') })
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(
    report.verifiedFiles.map((file) => file.path).sort(),
    payloadManifest.files.map((file) => file.path).sort(),
  )
  assert.ok(
    report.packageBindings.some(
      (binding) => binding.packagePath === 'node_modules/electron' && binding.version === '42.8.0',
    ),
  )
  assert.equal(
    report.unresolved.some((item) => item.id === 'guid-typescript-fixed-license'),
    false,
  )
  assert.ok(
    payloadManifest.resolvedForCurrentDistribution.some(
      (item) =>
        item.id === 'guid-typescript-fixed-license' &&
        item.status === 'excluded-from-reviewed-distribution',
    ),
  )
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
  assert.match(scripts['licenses:check'], /check-license-payload\.cjs/)
  assert.match(scripts['licenses:gate'], /check-license-payload\.cjs/)
})

test('packaged payload validation works without a repository lock or node_modules', () => {
  withPayloadFixture(({ copy, manifestSha256 }) => {
    const report = inspectLicensePayload({
      payloadRoot: copy,
      expectedManifestSha256: manifestSha256,
    })
    assert.equal(report.ok, true, report.errors.join('\n'))
    assert.equal(report.fileCount, payloadManifest.files.length)
  })
})

test('Microsoft runtime texts retain exact version and applicable license evidence', () => {
  const required = [
    [
      'microsoft/directml-1.15.4/LICENSE.txt',
      'a05138e3a085ff60a44881eedfa58dccb03ecc1d7b1f6ae888418e8c2fec4b8d',
      'directml-1.15.4',
    ],
    [
      'microsoft/directml-1.15.4/ThirdPartyNotices.txt',
      '2c95795c13ff48a58b6ed916f37901c23d964b5d9d601af422f17ad2172e7950',
      'directml-1.15.4',
    ],
    [
      'microsoft/dxc-1.8.2502.8/LICENSE-LLVM.txt',
      '729615317e28dd03907e46f0fc3b5e88f7853cee61d1a1471d2749335516b46f',
      'ort-dxc-1.8.2502.8',
    ],
    [
      'microsoft/dawn-dxc-eb67a9085c/LICENSE.TXT',
      '27a49e35d1da96eba18fba54bc882667ff0ff8c0254f16f2b6e165d605ba7df8',
      'dawn-dxc-eb67a9085c',
    ],
  ]
  for (const [file, digest, componentId] of required) {
    const entry = payloadManifest.files.find((item) => item.path === file)
    assert.ok(entry, file)
    assert.deepEqual(entry.appliesTo, [componentId])
    assert.equal(entry.sha256, digest)
    assert.equal(payloadHash(fs.readFileSync(path.join(payloadRoot, file))), digest)
  }
  for (const [directory, packageId, version] of [
    ['directml', 'microsoft.ai.directml', '1.15.4'],
    ['dxc', 'microsoft.direct3d.dxc', '1.8.2502.8'],
  ]) {
    const entries = payloadManifest.files.filter((item) =>
      item.path.startsWith(`microsoft/${directory}-${version}/`),
    )
    assert.ok(entries.length >= 2)
    for (const entry of entries) {
      assert.equal(entry.source.revision, version)
      assert.equal(
        entry.source.officialUrl,
        `https://api.nuget.org/v3-flatcontainer/${packageId}/${version}/${packageId}.${version}.nupkg`,
      )
      assert.equal(entry.source.archiveMember, path.posix.basename(entry.path))
      assert.equal(entry.source.archiveSignatureVerified, false)
    }
  }
  const releaseNotes = fs.readFileSync(
    path.join(payloadRoot, 'microsoft/dxc-1.8.2502.8/ReleaseNotes.md'),
    'utf8',
  )
  assert.match(releaseNotes, /LICENSE-LLVM\.txt/)
  assert.match(releaseNotes, /d3d12shader\.h/)
  assert.equal(
    payloadManifest.files.some((item) => item.path.endsWith('/LICENSE-MS.txt')),
    false,
  )
  for (const name of ['sdk_license.rtf', 'sdk_third_party_notices.rtf']) {
    const entry = payloadManifest.files.find(
      (item) => item.path === `microsoft/windows-sdk-10.0.26100.0/${name}`,
    )
    assert.ok(entry, name)
    assert.equal(entry.source.kind, 'installed-sdk-original-text')
    assert.match(entry.scopeLimitations, /7705 DOES NOT match.*8249/)
    assert.ok(fs.readFileSync(path.join(payloadRoot, entry.path)).toString().startsWith('{\\rtf'))
  }
})

test('canvas license coverage follows observed exact Rust crate versions and source identity', () => {
  const expectedCrates = {
    'aho-corasick': '1.1.4',
    'base64-simd': '0.8.0',
    cfb: '0.14.0',
    color_quant: '1.1.0',
    cssparser: '0.37.0',
    gif: '0.14.2',
    itoa: '1.0.18',
    memchr: '2.8.3',
    napi: '3.11.0',
    'napi-sys': '3.3.0',
    nom: '8.0.0',
    regex: '1.13.1',
    'regex-automata': '0.4.16',
    'regex-syntax': '0.8.11',
    smallvec: '1.15.2',
    tokio: '1.53.1',
    weezl: '0.1.12',
  }
  const vcsCommits = {
    'base64-simd': ['Nugine/simd', 'd74c030d9dc4f3cae02146d1f497ff62726ef09a'],
    napi: ['napi-rs/napi-rs', '679eb79f5cf3c7c6b2850f4ab46092126f23dc5c'],
    'napi-sys': ['napi-rs/napi-rs', '679eb79f5cf3c7c6b2850f4ab46092126f23dc5c'],
  }
  for (const [name, version] of Object.entries(expectedCrates)) {
    const componentId = `canvas-rust-${name}-${version}`
    const component = payloadManifest.components.find((item) => item.id === componentId)
    assert.ok(component, componentId)
    assert.equal(component.revision, version)
    const entries = payloadManifest.files.filter((item) => item.appliesTo.includes(componentId))
    assert.ok(entries.length > 0, componentId)
    for (const entry of entries) {
      assert.ok(entry.path.startsWith(`canvas-1.0.3/rust/${name}-${version}/`))
      const crateUrl = `https://static.crates.io/crates/${name}/${name}-${version}.crate`
      if (vcsCommits[name]) {
        const [repository, commit] = vcsCommits[name]
        assert.equal(entry.source.kind, 'crate-vcs-pinned-upstream-text')
        assert.equal(
          entry.source.officialUrl,
          `https://raw.githubusercontent.com/${repository}/${commit}/LICENSE`,
        )
        assert.equal(entry.source.revision, commit)
        assert.equal(entry.source.crateVersion, version)
        assert.equal(entry.source.crateUrl, crateUrl)
        assert.match(entry.source.crateSha256, /^[a-f0-9]{64}$/)
        assert.equal(entry.source.crateVcsMember, `${name}-${version}/.cargo_vcs_info.json`)
      } else {
        assert.equal(entry.source.kind, 'verified-crates-archive-member')
        assert.equal(entry.source.officialUrl, crateUrl)
        assert.equal(entry.source.revision, version)
        assert.match(entry.source.archiveSha256, /^[a-f0-9]{64}$/)
        assert.equal(entry.source.archiveMember, entry.path.slice('canvas-1.0.3/rust/'.length))
      }
    }
  }
  const mpl = payloadManifest.files.find(
    (item) => item.path === 'canvas-1.0.3/rust/cssparser-0.37.0/LICENSE',
  )
  assert.equal(mpl.sha256, 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85')
  assert.match(fs.readFileSync(path.join(payloadRoot, mpl.path), 'utf8'), /Mozilla Public License/)
  assert.ok(
    payloadManifest.unresolved.some(
      (item) => item.id === 'canvas-native-closure' && /source/i.test(item.detail),
    ),
  )
})

test('missing and altered license text fail actual byte validation', () => {
  withPayloadFixture(({ copy, payload }) => {
    const target = path.join(copy, payload.files[0].path)
    const original = fs.readFileSync(target)
    fs.unlinkSync(target)
    assert.ok(
      inspectLicensePayload({ payloadRoot: copy }).errors.some((error) =>
        error.includes('missing'),
      ),
    )
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('modified')]))
    assert.ok(
      inspectLicensePayload({ payloadRoot: copy }).errors.some((error) =>
        error.includes('SHA-256 differ'),
      ),
    )
  })
})

test('scope notes and undeclared additions are covered by payload verification', () => {
  withPayloadFixture(({ copy }) => {
    fs.appendFileSync(path.join(copy, 'README.md'), '\nChanged scope\n')
    fs.writeFileSync(path.join(copy, 'unlisted.txt'), 'unregistered')
    const report = inspectLicensePayload({ payloadRoot: copy })
    assert.ok(report.errors.some((error) => error.includes('README.md bytes')))
    assert.ok(report.errors.some((error) => error.includes('unlisted payload file')))
  })
})

test('trusted manifest identity rejects self-consistent replacement of a license', () => {
  withPayloadFixture(({ copy, payload, save, manifestSha256 }) => {
    const entry = payload.files[0]
    const replacement = Buffer.from('A replacement with a newly calculated checksum')
    fs.writeFileSync(path.join(copy, entry.path), replacement)
    entry.bytes = replacement.length
    entry.sha256 = payloadHash(replacement)
    entry.source.sha256 = entry.sha256
    save()
    assert.equal(inspectLicensePayload({ payloadRoot: copy }).ok, true)
    const report = inspectLicensePayload({
      payloadRoot: copy,
      expectedManifestSha256: manifestSha256,
    })
    assert.equal(report.ok, false)
    assert.ok(report.errors.some((error) => error.includes('trusted expected manifest')))
  })
})

test('declared paths reject traversal, absolute paths and Windows aliases', () => {
  withPayloadFixture(({ copy, payload, save }) => {
    for (const unsafe of [
      '../outside',
      '/absolute',
      'C:/absolute',
      'directory\\file',
      'NUL',
      'file.',
    ]) {
      payload.files[0].path = unsafe
      save()
      const report = inspectLicensePayload({ payloadRoot: copy })
      assert.equal(report.ok, false, unsafe)
      assert.ok(report.errors.includes('unsafe declared license path'), unsafe)
    }
  })
})

test('duplicate declarations, unsupported scope mappings and false approval fail', () => {
  withPayloadFixture(({ copy, payload, save }) => {
    payload.files.push(structuredClone(payload.files[0]))
    payload.files[1].appliesTo = ['unknown-component']
    payload.approvalGranted = true
    save()
    const report = inspectLicensePayload({ payloadRoot: copy })
    assert.ok(report.errors.some((error) => error.includes('duplicate/reserved')))
    assert.ok(report.errors.some((error) => error.includes('source/scope mapping')))
    assert.ok(report.errors.some((error) => error.includes('partial-evidence boundary')))
  })
})

test('changed dependency versions cannot reuse old source license evidence', () => {
  withPayloadFixture(({ scratch, copy, payload }) => {
    const packages = Object.fromEntries(
      payload.packageBindings.map((item) => [item.packagePath, { version: item.version }]),
    )
    packages[payload.packageBindings[0].packagePath].version = '99.0.0'
    const lockPath = path.join(scratch, 'package-lock.json')
    fs.writeFileSync(lockPath, JSON.stringify({ packages }))
    const report = inspectLicensePayload({ payloadRoot: copy, packageLockPath: lockPath })
    assert.ok(report.errors.some((error) => error.includes('lockfile version does not match')))
  })
})

test('payload directory links are rejected without traversing their target', () => {
  withPayloadFixture(({ scratch, copy }) => {
    const target = path.join(scratch, 'outside')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'unchanged')
    fs.symlinkSync(
      target,
      path.join(copy, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const report = inspectLicensePayload({ payloadRoot: copy })
    assert.equal(report.ok, false)
    assert.ok(report.errors.some((error) => error.includes('symbolic link is forbidden')))
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'unchanged')
  })
})

test('invalid or missing manifests produce a failure report rather than an exception', () => {
  withPayloadFixture(({ copy }) => {
    const file = path.join(copy, 'manifest.json')
    for (const content of ['{', 'null', '{}']) {
      fs.writeFileSync(file, content)
      assert.equal(inspectLicensePayload({ payloadRoot: copy }).ok, false)
    }
    fs.unlinkSync(file)
    assert.equal(inspectLicensePayload({ payloadRoot: copy }).ok, false)
  })
})

test('proprietary EULA template is visibly incomplete and cannot be distributed', () => {
  const template = fs.readFileSync(path.join(root, 'legal', 'PROPRIETARY-EULA.template.md'), 'utf8')
  assert.match(template, /DRAFT — NOT FOR DISTRIBUTION/)
  assert.match(template, /\{\{RIGHTSHOLDER_LEGAL_NAME\}\}/)
  assert.match(template, /\{\{GOVERNING_LAW\}\}/)
  assert.match(template, /authorized legal review/i)
})

test('commercial policy templates remain visibly incomplete and outside distribution', () => {
  for (const fileName of [
    'PRIVACY_POLICY.template.md',
    'SECURITY_AND_SUPPORT_POLICY.template.md',
    'INDIVIDUAL_PUBLISHER_INTAKE.template.md',
  ]) {
    const template = fs.readFileSync(path.join(root, 'legal', fileName), 'utf8')
    assert.match(template, /DRAFT — NOT FOR DISTRIBUTION/)
    assert.match(template, /\{\{[A-Z0-9_]+\}\}/)
  }
})
