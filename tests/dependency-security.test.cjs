const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const nodeTsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.node.json'), 'utf8'))

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split('.').map(Number)
  const minimumParts = minimum.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true
    if (actualParts[index] < minimumParts[index]) return false
  }
  return true
}

test('production and build dependency remediations stay locked above advisory floors', () => {
  const expectedFloors = {
    sharp: '0.35.5',
    electron: '42.11.12',
    'http-cache-semantics': '4.3.0',
    'source-map-js': '1.2.2',
    'adm-zip': '0.6.1',
    protobufjs: '7.6.5',
    tar: '7.5.21',
    'fast-uri': '3.1.8',
    'js-yaml': '4.3.2',
    nanoid: '3.3.17',
    postcss: '8.5.18',
    undici: '7.29.1',
  }

  assert.equal(packageJson.overrides.sharp, '0.35.5')
  assert.equal(packageJson.overrides['adm-zip'], '0.6.1')
  assert.deepEqual(nodeTsconfig.compilerOptions.paths.sharp, ['node_modules/sharp/lib/index.d.ts'])
  for (const [name, minimum] of Object.entries(expectedFloors)) {
    const locked = packageLock.packages[`node_modules/${name}`]?.version
    assert.ok(locked, `${name} must exist in package-lock.json`)
    assert.ok(versionAtLeast(locked, minimum), `${name} ${locked} must be at least ${minimum}`)
  }
})

test('nested build HTTP clients and XML parser remain above advisory floors', () => {
  const minimumByMajor = new Map([
    [6, '6.28.1'],
    [7, '7.29.1'],
    [8, '8.10.2'],
  ])
  const clients = Object.entries(packageLock.packages).filter(([key]) =>
    key.endsWith('node_modules/undici'),
  )
  assert.ok(clients.length > 0)
  for (const [key, metadata] of clients) {
    const minimum = minimumByMajor.get(Number(metadata.version.split('.')[0]))
    assert.ok(minimum, `${key} requires review for major ${metadata.version}`)
    assert.ok(
      versionAtLeast(metadata.version, minimum),
      `${key} ${metadata.version} must be at least ${minimum}`,
    )
  }
  const parsers = Object.entries(packageLock.packages).filter(([key]) =>
    key.endsWith('node_modules/@xmldom/xmldom'),
  )
  assert.ok(parsers.length > 0)
  for (const [key, metadata] of parsers) {
    assert.ok(versionAtLeast(metadata.version, '0.8.15'), `${key} must be at least 0.8.15`)
  }
})

test('project preview PDF renderer stays on the reviewed runtime pair', () => {
  assert.equal(packageJson.dependencies['pdfjs-dist'], '6.2.108')
  assert.equal(packageJson.dependencies['@napi-rs/canvas'], '1.0.3')
  assert.equal(packageLock.packages['node_modules/pdfjs-dist']?.version, '6.2.108')
  assert.equal(packageLock.packages['node_modules/@napi-rs/canvas']?.version, '1.0.3')
  assert.equal(
    packageLock.packages['node_modules/@napi-rs/canvas-win32-x64-msvc']?.version,
    '1.0.3',
  )
})

test('remote terminal uses the scoped xterm package and keeps SSH types development-only', () => {
  assert.equal(packageJson.dependencies.xterm, undefined)
  assert.equal(packageJson.dependencies['@xterm/xterm'], '^5.5.0')
  assert.equal(packageLock.packages['node_modules/xterm'], undefined)
  assert.equal(packageLock.packages['node_modules/@xterm/xterm']?.version, '5.5.0')
  assert.equal(packageJson.dependencies['@types/ssh2'], undefined)
  assert.equal(packageJson.devDependencies['@types/ssh2'], '^1.15.5')
  assert.equal(packageLock.packages['node_modules/@types/ssh2']?.dev, true)
})

test('lint toolchain stays on the reviewed ESLint 10 flat-config stack', () => {
  assert.equal(fs.existsSync(path.join(root, '.eslintrc.cjs')), false)
  assert.equal(fs.existsSync(path.join(root, 'eslint.config.cjs')), true)
  assert.equal(packageJson.devDependencies.eslint, '^10.8.0')
  assert.equal(packageJson.devDependencies['@typescript-eslint/parser'], '^8.65.0')
  assert.equal(packageJson.devDependencies['@typescript-eslint/eslint-plugin'], '^8.65.0')
  assert.equal(packageLock.packages['node_modules/eslint']?.version, '10.8.0')
  assert.equal(packageLock.packages['node_modules/@typescript-eslint/parser']?.version, '8.65.0')
  assert.doesNotMatch(packageJson.scripts.lint, /--ext/)
})

test('Vite 7 build plugins stay on the warning-free reviewed combination', () => {
  assert.equal(packageJson.devDependencies.vite, '^7.3.1')
  assert.equal(packageJson.devDependencies['@vitejs/plugin-react'], '^5.1.4')
  assert.equal(packageJson.devDependencies['vite-plugin-electron'], '^0.29.1')
  assert.equal(packageJson.devDependencies['vite-plugin-electron-renderer'], '^1.0.0')
  assert.equal(packageLock.packages['node_modules/vite']?.version, '7.3.6')
  assert.equal(packageLock.packages['node_modules/@vitejs/plugin-react']?.version, '5.2.0')
  assert.equal(packageLock.packages['node_modules/vite-plugin-electron']?.version, '0.29.1')
  assert.equal(packageLock.packages['node_modules/vite-plugin-electron-renderer']?.version, '1.0.0')
})

test('React 19 and Zustand 5 stay on the reviewed state stack', () => {
  assert.equal(packageJson.dependencies.react, '^19.2.8')
  assert.equal(packageJson.dependencies['react-dom'], '^19.2.8')
  assert.equal(packageJson.dependencies.zustand, '^5.0.14')
  assert.equal(packageJson.devDependencies['@types/react'], '^19.2.18')
  assert.equal(packageJson.devDependencies['@types/react-dom'], '^19.2.4')
  assert.equal(packageLock.packages['node_modules/react']?.version, '19.2.8')
  assert.equal(packageLock.packages['node_modules/react-dom']?.version, '19.2.8')
  assert.equal(packageLock.packages['node_modules/zustand']?.version, '5.0.14')
  assert.equal(packageLock.packages['node_modules/@types/react']?.version, '19.2.18')
  assert.equal(packageLock.packages['node_modules/@types/react-dom']?.version, '19.2.4')
})

test('native build and formatter stay on the verified maintenance releases', () => {
  assert.equal(packageJson.devDependencies['node-gyp'], '^13.0.1')
  assert.equal(packageJson.devDependencies.prettier, '^3.8.4')
  assert.equal(packageLock.packages['node_modules/node-gyp']?.version, '13.0.1')
  assert.equal(packageLock.packages['node_modules/prettier']?.version, '3.8.4')
})

test('all brace-expansion lines use the bounded patched releases', () => {
  const minimumByMajor = new Map([
    [1, '1.1.18'],
    [2, '2.1.4'],
    [5, '5.0.9'],
  ])
  const entries = Object.entries(packageLock.packages).filter(([key]) =>
    key.endsWith('node_modules/brace-expansion'),
  )

  assert.ok(entries.length > 0)
  for (const [key, metadata] of entries) {
    const minimum = minimumByMajor.get(Number(metadata.version.split('.')[0]))
    assert.ok(minimum, `${key} uses an unexpected brace-expansion line: ${metadata.version}`)
    assert.ok(
      versionAtLeast(metadata.version, minimum),
      `${key} ${metadata.version} must be at least ${minimum}`,
    )
  }
})

test('Transformers image decode and resize remain compatible with overridden sharp', async () => {
  const sharp = require('sharp')
  const png = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 3,
      background: { r: 12, g: 34, b: 56 },
    },
  })
    .png()
    .toBuffer()
  const { RawImage } = await import('@huggingface/transformers')
  const decoded = await RawImage.fromBlob(new Blob([png], { type: 'image/png' }))
  const resized = await decoded.resize(2, 2, { resample: 'lanczos' })

  assert.deepEqual(decoded.size, [4, 3])
  assert.equal(decoded.channels, 3)
  assert.deepEqual(resized.size, [2, 2])
  assert.equal(resized.channels, 3)
  assert.equal(resized.data.length, 12)
})
