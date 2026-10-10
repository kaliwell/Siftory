'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  assertEvidenceComparable,
  buildEvidence,
  collectEnvironmentFingerprint,
  collectExecutionDependencyClosure,
  collectImplementationRevision,
  compareEvidence,
  fingerprint,
  freezeDatasetManifest,
  hashStableFile,
  parseNvidiaSmiDevices,
  parseWmicVideoControllers,
  readStableJson,
  validateDatasetManifest,
  verifyDatasetManifest,
} = require('../scripts/fixed-hardware-baseline-evidence.cjs')
const {
  createFixedWindowsSystemEnvironment,
} = require('../scripts/fixed-hardware-system-tools.cjs')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}

function makeTempRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-evidence-' + label + '-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function createDataset(root) {
  const datasetRoot = path.join(root, 'dataset')
  write(datasetRoot, 'a-dir/c.png', 'nested-c')
  write(datasetRoot, 'a-dir/d.webp', 'nested-d')
  write(datasetRoot, 'b.JPG', 'root-b')
  write(datasetRoot, 'c.gif', 'root-c')
  write(datasetRoot, 'z-dir/a.bmp', 'nested-z')
  write(datasetRoot, 'ignored.txt', 'not-an-image')
  return datasetRoot
}

test('WMIC and nvidia-smi GPU output parsers enforce the fixed schemas', () => {
  const wmicRaw =
    '\r\r\nAdapterCompatibility=Intel Corporation\r\r\n' +
    'DriverVersion=31.0.101.2115\r\r\nName=Intel(R) Iris(R) Xe Graphics\r\r\n' +
    'PNPDeviceID=PCI\\VEN_8086&amp;DEV_9A49\r\r\n\r\r\n' +
    'AdapterCompatibility=NVIDIA\r\r\nDriverVersion=32.0.15.6094\r\r\n' +
    'Name=NVIDIA GeForce RTX 3050 Laptop GPU\r\r\n' +
    'PNPDeviceID=PCI\\VEN_10DE&amp;DEV_25A2\r\r\n'
  assert.deepEqual(parseWmicVideoControllers(wmicRaw), [
    {
      name: 'Intel(R) Iris(R) Xe Graphics',
      driverVersion: '31.0.101.2115',
      deviceId: 'PCI\\VEN_8086&amp;DEV_9A49',
      adapterCompatibility: 'Intel Corporation',
    },
    {
      name: 'NVIDIA GeForce RTX 3050 Laptop GPU',
      driverVersion: '32.0.15.6094',
      deviceId: 'PCI\\VEN_10DE&amp;DEV_25A2',
      adapterCompatibility: 'NVIDIA',
    },
  ])
  assert.deepEqual(
    parseNvidiaSmiDevices(
      'NVIDIA GeForce RTX 3050 Laptop GPU, 560.94, GPU-fixture, 00000000:01:00.0, 4096\r\n',
    ),
    [
      {
        name: 'NVIDIA GeForce RTX 3050 Laptop GPU',
        driverVersion: '560.94',
        uuid: 'GPU-fixture',
        busId: '00000000:01:00.0',
        memoryTotalMiB: 4096,
      },
    ],
  )
  assert.throws(
    () =>
      parseWmicVideoControllers(
        'Name=one\nName=two\nDriverVersion=1\nPNPDeviceID=id\nAdapterCompatibility=vendor',
      ),
    /duplicate field/,
  )
  assert.throws(
    () =>
      parseWmicVideoControllers(
        'Name=one\nDriverVersion=1\nPNPDeviceID=id\nUnexpected=value\nAdapterCompatibility=vendor',
      ),
    /unknown field/,
  )
})

test('evidence collection rejects every ambient Node startup override case-insensitively', async () => {
  const rejectedKeys = [
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_COMPILE_CACHE',
    'NODE_V8_COVERAGE',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'NODE_REDIRECT_WARNINGS',
    'NODE_ICU_DATA',
    'NODE_EXTRA_CA_CERTS',
  ]
  for (const key of rejectedKeys) {
    const mixedCaseKey = key
      .toLowerCase()
      .replace(/^node/, 'NoDe')
    await assert.rejects(
      collectExecutionDependencyClosure({
        repoRoot: process.cwd(),
        parentEnvironment: { [mixedCaseKey]: 'injected' },
        parentExecArgv: [],
      }),
      new RegExp(`contaminated by ${mixedCaseKey}`, 'i'),
    )
  }
  await assert.rejects(
    collectExecutionDependencyClosure({
      repoRoot: process.cwd(),
      parentEnvironment: {},
      parentExecArgv: ['--require=untrusted-hook.cjs'],
    }),
    /process\.execArgv must be empty/,
  )
})

function descriptor(filename, contents) {
  const bytes = Buffer.from(contents)
  return {
    filename,
    contents: bytes,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  }
}

function createRuntimeFixture(root) {
  const repoRoot = path.join(root, 'repo')
  fs.mkdirSync(repoRoot, { recursive: true })
  const nodeExecutable = write(root, 'runtime/fake-node.exe', 'node-runtime')
  const systemToolsRoot = path.join(root, 'system-tools')
  const systemTools = {
    schemaVersion: 1,
    policy: 'fixed-windows-system32-v1',
    systemRoot: systemToolsRoot,
    powershell: write(
      systemToolsRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
      'powershell-runtime',
    ),
    taskkill: write(systemToolsRoot, 'System32/taskkill.exe', 'taskkill-runtime'),
    nvidiaSmi: write(systemToolsRoot, 'System32/nvidia-smi.exe', 'nvidia-smi-runtime'),
    wmic: write(systemToolsRoot, 'System32/Wbem/WMIC.exe', 'wmic-runtime'),
    comSpec: write(systemToolsRoot, 'System32/cmd.exe', 'cmd-runtime'),
  }
  const actualWindowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const runtimeResolverEnvironment = createFixedWindowsSystemEnvironment({
    systemRoot: actualWindowsRoot,
    comSpec: path.win32.join(actualWindowsRoot, 'System32', 'cmd.exe'),
  })

  const onnxRoot = path.join(repoRoot, 'node_modules', 'onnxruntime-node')
  write(
    onnxRoot,
    'package.json',
    JSON.stringify({
      name: 'onnxruntime-node',
      version: '9.8.7-fixture',
      binary: { napi_versions: [6] },
      main: 'dist/index.js',
    }),
  )
  const onnxEntry = write(
    onnxRoot,
    'dist/index.js',
    "onnx-entry-v1; require('onnxruntime-common')",
  )
  const onnxRuntime = write(onnxRoot, 'dist/session.js', 'onnx-session-v1')
  const nativeRoot = path.join(onnxRoot, 'bin', 'napi-v6', 'win32', 'x64')
  const binding = write(nativeRoot, 'onnxruntime_binding.node', 'native-binding')
  for (const name of ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll', 'onnxruntime.dll']) {
    write(nativeRoot, name, `${name}-runtime-library`)
  }

  const transformersRoot = path.join(repoRoot, 'node_modules', '@huggingface', 'transformers')
  write(
    transformersRoot,
    'package.json',
    JSON.stringify({
      name: '@huggingface/transformers',
      version: '7.6.5-fixture',
      main: './dist/transformers.node.cjs',
      exports: {
        node: {
          import: './dist/transformers.node.mjs',
          require: './dist/transformers.node.cjs',
        },
      },
    }),
  )
  const transformersImportEntry = write(
    transformersRoot,
    'dist/transformers.node.mjs',
    "import 'sharp'; import 'onnxruntime-node'; import 'onnxruntime-common'; // transformers-import-v1",
  )
  const transformersRequireEntry = write(
    transformersRoot,
    'dist/transformers.node.cjs',
    "transformers-require-v1; require('sharp')",
  )
  const transformersRuntime = write(
    transformersRoot,
    'dist/runtime/shared.js',
    'transformers-shared-v1',
  )

  const onnxCommonRoot = path.join(repoRoot, 'node_modules', 'onnxruntime-common')
  write(
    onnxCommonRoot,
    'package.json',
    JSON.stringify({
      name: 'onnxruntime-common',
      version: '9.8.7-fixture',
      main: 'dist/cjs/index.js',
      exports: {
        require: './dist/cjs/index.js',
        import: './dist/esm/index.js',
      },
    }),
  )
  const onnxCommonRuntime = write(onnxCommonRoot, 'dist/cjs/index.js', 'onnx-common-cjs-v1')
  write(onnxCommonRoot, 'dist/esm/index.js', 'onnx-common-esm-v1')
  write(onnxCommonRoot, 'dist/esm/tensor.js', 'onnx-common-tensor-v1')

  const sharpRoot = path.join(repoRoot, 'node_modules', 'sharp')
  write(
    sharpRoot,
    'package.json',
    JSON.stringify({
      name: 'sharp',
      version: '1.2.3-fixture',
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
      },
      dependencies: {
        '@img/colour': '1.1.0-fixture',
        'detect-libc': '2.1.2-fixture',
        semver: '7.8.5-fixture',
      },
      optionalDependencies: { '@img/sharp-win32-x64': '1.2.3-fixture' },
    }),
  )
  const sharpRuntime = write(sharpRoot, 'dist/index.cjs', "module.exports = require('./sharp.cjs')")
  write(sharpRoot, 'dist/index.mjs', "import sharp from './sharp.mjs'; export default sharp")
  write(
    sharpRoot,
    'dist/sharp.cjs',
    [
      "require('@img/colour')",
      "require('detect-libc')",
      "require('semver')",
      "require('../src/build/Release/sharp-win32-x64-1.2.3-fixture.node')",
      "require('../src/build/Release/sharp-wasm32-1.2.3-fixture.node')",
      "require('@img/sharp-win32-x64/sharp.node')",
    ].join('; '),
  )
  write(
    sharpRoot,
    'dist/sharp.mjs',
    [
      "import '@img/colour'",
      "import 'detect-libc'",
      "import 'semver'",
      "require('../src/build/Release/sharp-win32-x64-1.2.3-fixture.node')",
      "require('../src/build/Release/sharp-wasm32-1.2.3-fixture.node')",
      "require('@img/sharp-win32-x64/sharp.node')",
    ].join('; '),
  )

  const colourRoot = path.join(repoRoot, 'node_modules', '@img', 'colour')
  write(
    colourRoot,
    'package.json',
    JSON.stringify({
      name: '@img/colour',
      version: '1.1.0-fixture',
      main: 'index.cjs',
      exports: { '.': { require: './index.cjs', default: './index.cjs' } },
    }),
  )
  const colourRuntime = write(colourRoot, 'index.cjs', 'colour-entry-v1')
  write(colourRoot, 'color.cjs', 'colour-runtime-v1')

  const detectLibcRoot = path.join(repoRoot, 'node_modules', 'detect-libc')
  write(
    detectLibcRoot,
    'package.json',
    JSON.stringify({
      name: 'detect-libc',
      version: '2.1.2-fixture',
      main: 'lib/detect-libc.js',
    }),
  )
  const detectLibcRuntime = write(
    detectLibcRoot,
    'lib/detect-libc.js',
    'detect-libc-entry-v1',
  )
  write(detectLibcRoot, 'lib/filesystem.js', 'detect-libc-runtime-v1')

  const nestedSemverRoot = path.join(sharpRoot, 'node_modules', 'semver')
  write(
    nestedSemverRoot,
    'package.json',
    JSON.stringify({ name: 'semver', version: '7.8.5-fixture', main: 'index.js' }),
  )
  const nestedSemverRuntime = write(nestedSemverRoot, 'index.js', 'nested-semver-entry-v1')
  write(nestedSemverRoot, 'classes/range.js', 'nested-semver-runtime-v1')

  const topLevelSemverRoot = path.join(repoRoot, 'node_modules', 'semver')
  write(
    topLevelSemverRoot,
    'package.json',
    JSON.stringify({ name: 'semver', version: '0.0.1-decoy', main: 'index.js' }),
  )
  write(topLevelSemverRoot, 'index.js', 'top-level-semver-decoy')

  const sharpPlatformName = '@img/sharp-win32-x64'
  const sharpPlatformRoot = path.join(repoRoot, 'node_modules', '@img', 'sharp-win32-x64')
  write(
    sharpPlatformRoot,
    'package.json',
    JSON.stringify({
      name: sharpPlatformName,
      version: '1.2.3-fixture',
      type: 'commonjs',
      exports: {
        './sharp.node': './index.cjs',
        './package': './package.json',
      },
    }),
  )
  const sharpPlatformLoader = write(sharpPlatformRoot, 'index.cjs', 'sharp-platform-loader-v1')
  const sharpPlatformNode = write(
    sharpPlatformRoot,
    'lib/sharp-win32-x64-fixture.node',
    'sharp-native-v1',
  )
  const sharpPlatformLibvips = write(
    sharpPlatformRoot,
    'lib/libvips-42.dll',
    'libvips-runtime-v1',
  )
  const sharpPlatformLibvipsCpp = write(
    sharpPlatformRoot,
    'lib/libvips-cpp-8.18.3.dll',
    'libvips-cpp-runtime-v1',
  )

  const typescriptRoot = path.join(repoRoot, 'node_modules', 'typescript')
  write(
    typescriptRoot,
    'package.json',
    JSON.stringify({ name: 'typescript', version: '5.9.3-fixture', main: 'lib/typescript.js' }),
  )
  const typescriptEntry = write(
    typescriptRoot,
    'lib/typescript.js',
    [
      "exports.ModuleKind = { CommonJS: 1 }",
      "exports.ScriptTarget = { ES2022: 9 }",
      'exports.transpileModule = (source) => ({ outputText: source })',
    ].join('; '),
  )
  const typescriptRuntime = write(typescriptRoot, 'lib/compiler-runtime.js', 'ts-runtime-v1')

  const guardUtilsPath = write(
    repoRoot,
    'tests/guard-utils.cjs',
    "const ts = require('typescript'); function loadTsModule(value) { return value }; module.exports = { loadTsModule, ts }",
  )
  const e2eBenchmarkPath = write(
    repoRoot,
    'tests/image-search-simple-e2e-benchmark.cjs',
    "loadTsModule('electron/projectPreviewService.ts')",
  )
  const projectPreviewServicePath = write(
    repoRoot,
    'electron/projectPreviewService.ts',
    "require('sharp'); require('./projectPreviewProviders')",
  )
  const projectPreviewProvidersPath = write(
    repoRoot,
    'electron/projectPreviewProviders.ts',
    "require('@napi-rs/canvas'); async function pdf() { return import('pdfjs-dist/legacy/build/pdf.mjs') }",
  )

  const pdfjsRoot = path.join(repoRoot, 'node_modules', 'pdfjs-dist')
  write(
    pdfjsRoot,
    'package.json',
    JSON.stringify({
      name: 'pdfjs-dist',
      version: '5.4.54-fixture',
      exports: { './legacy/build/pdf.mjs': './legacy/build/pdf.mjs' },
    }),
  )
  const pdfjsEntry = write(pdfjsRoot, 'legacy/build/pdf.mjs', 'export const getDocument = 1')
  const pdfjsRuntime = write(pdfjsRoot, 'legacy/build/pdf.worker.mjs', 'pdf-worker-runtime-v1')

  const canvasRoot = path.join(repoRoot, 'node_modules', '@napi-rs', 'canvas')
  write(
    canvasRoot,
    'package.json',
    JSON.stringify({ name: '@napi-rs/canvas', version: '1.0.3-fixture', main: 'index.js' }),
  )
  const canvasEntry = write(canvasRoot, 'index.js', "module.exports = require('./js-binding')")
  const canvasBinding = write(
    canvasRoot,
    'js-binding.js',
    [
      'process.env.NAPI_RS_NATIVE_LIBRARY_PATH',
      'process.env.NAPI_RS_FORCE_WASI',
      "require('./skia.win32-x64-msvc.node')",
      "module.exports = require('@napi-rs/canvas-win32-x64-msvc')",
    ].join('; '),
  )
  write(canvasRoot, 'geometry.js', 'canvas-runtime-v1')
  const canvasPlatformName = '@napi-rs/canvas-win32-x64-msvc'
  const canvasPlatformRoot = path.join(
    repoRoot,
    'node_modules',
    '@napi-rs',
    'canvas-win32-x64-msvc',
  )
  write(
    canvasPlatformRoot,
    'package.json',
    JSON.stringify({
      name: canvasPlatformName,
      version: '1.0.3-fixture',
      main: 'skia.win32-x64-msvc.node',
    }),
  )
  const canvasNative = write(
    canvasPlatformRoot,
    'skia.win32-x64-msvc.node',
    'canvas-native-v1',
  )
  const canvasIcu = write(canvasPlatformRoot, 'icudtl.dat', 'canvas-icu-v1')

  const dinoPrimary = descriptor('Xenova/dino/onnx/model_q4.onnx', 'dino-primary')
  const dinoConfig = descriptor('Xenova/dino/config.json', 'dino-config')
  const clipPrimary = descriptor('Xenova/clip/onnx/model_q4.onnx', 'clip-primary')
  const clipConfig = descriptor('Xenova/clip/config.json', 'clip-config')
  const modelsRoot = path.join(repoRoot, 'ai-models')
  for (const [modelName, file] of [
    ['dinov2_vitb14', dinoPrimary],
    ['dinov2_vitb14', dinoConfig],
    ['clip_vit_base_patch32', clipPrimary],
    ['clip_vit_base_patch32', clipConfig],
  ]) {
    write(modelsRoot, path.join(modelName, file.filename), file.contents)
  }
  const modelsManifestPath = write(
    repoRoot,
    'models/manifest.json',
    JSON.stringify({
      version: 2,
      models: [
        {
          name: 'dinov2_vitb14',
          version: 'dino-revision',
          filename: dinoPrimary.filename,
          sizeBytes: dinoPrimary.sizeBytes,
          sha256: dinoPrimary.sha256,
          requiredFiles: [
            {
              filename: dinoConfig.filename,
              sizeBytes: dinoConfig.sizeBytes,
              sha256: dinoConfig.sha256,
            },
          ],
        },
        {
          name: 'clip_vit_base_patch32',
          version: 'clip-revision',
          filename: clipPrimary.filename,
          sizeBytes: clipPrimary.sizeBytes,
          sha256: clipPrimary.sha256,
          requiredFiles: [
            {
              filename: clipConfig.filename,
              sizeBytes: clipConfig.sizeBytes,
              sha256: clipConfig.sha256,
            },
          ],
        },
      ],
    }),
  )

  const sourceFiles = ['fixture/source-a.ts', 'fixture/source-b.ts']
  write(repoRoot, sourceFiles[0], 'source-a')
  write(repoRoot, sourceFiles[1], 'source-b')
  const addonPath = write(repoRoot, 'fixture/fast_scanner.node', 'scanner-build')
  const childSharedChunk = write(
    repoRoot,
    'fixture/index-fixture-A1b2.js',
    [
      "module.exports = require('./child-shared-nested.js')",
      '/* ../src/build/Release/sharp-win32-x64-1.2.3-fixture.node */',
      '/* ../src/build/Release/sharp-wasm32-1.2.3-fixture.node */',
      "require('@img/sharp-libvips-dev/cplusplus')",
      "require('@img/sharp-libvips-dev/include')",
    ].join('; '),
  )
  const childNestedChunk = write(repoRoot, 'fixture/child-shared-nested.js', 'module.exports = 1')
  const children = [
    {
      name: 'dinoEmbeddingChild',
      source: 'fixture/dino-child.ts',
      built: 'fixture/dino-child.js',
    },
    {
      name: 'clipEmbeddingChild',
      source: 'fixture/clip-child.ts',
      built: 'fixture/clip-child.js',
    },
    {
      name: 'embeddingPreparationChild',
      source: 'fixture/preparation-child.ts',
      built: 'fixture/preparation-child.js',
    },
  ]
  for (const child of children) {
    write(repoRoot, child.source, child.name + '-source')
    const loader =
      child.name === 'dinoEmbeddingChild'
          ? [
            `${child.name}-build`,
            "import('@huggingface/transformers')",
            '/* ../src/build/Release/sharp-win32-x64-1.2.3-fixture.node */',
            '/* ../src/build/Release/sharp-wasm32-1.2.3-fixture.node */',
            "require('@img/sharp-libvips-dev/cplusplus')",
            "require('@img/sharp-libvips-dev/include')",
          ].join('; ')
        : child.name === 'clipEmbeddingChild'
          ? `${child.name}-build; import('@huggingface/transformers'); require('./index-fixture-A1b2.js')`
          : `${child.name}-build`
    write(repoRoot, child.built, loader)
  }

  const environmentOptions = {
    parentExecArgv: [],
    nodeExecutable,
    nodeVersion: 'v99.1.0-fixture',
    nodeModulesVersion: '999',
    nodeNapiVersion: 6,
    systemTools,
    systemToolsRoot,
    runtimeResolverEnvironment,
    platform: 'win32',
    arch: 'x64',
    systemInfo: {
      platform: 'win32',
      arch: 'x64',
      type: 'Windows_NT',
      release: '1.2.3',
      version: 'FixtureOS 1.2.3',
    },
    hardwareInfo: {
      cpuModel: 'Fixture CPU',
      logicalProcessors: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    },
    packageRoots: {
      'onnxruntime-node': onnxRoot,
      '@huggingface/transformers': transformersRoot,
      'onnxruntime-common': onnxCommonRoot,
      sharp: sharpRoot,
      [sharpPlatformName]: sharpPlatformRoot,
    },
    sharpPlatformPackage: sharpPlatformName,
    canvasPlatformPackage: canvasPlatformName,
    canvasRuntimePlatform: 'win32-x64-msvc',
    e2eBenchmarkPath,
    guardUtilsPath,
    canvasResolverParent: projectPreviewProvidersPath,
    mlChildResolverParents: children
      .filter((child) => child.name !== 'embeddingPreparationChild')
      .map((child) => ({ name: child.name, path: path.join(repoRoot, child.built) })),
    moduleResolverExecutable: process.execPath,
    gpuProbe: () => ({
      source: 'fixture-cim+nvidia',
      controllers: [
        {
          name: 'Fixture GPU',
          driverVersion: '555.42',
          deviceId: 'PCI\\VEN_FIXTURE',
          adapterCompatibility: 'Fixture Vendor',
        },
      ],
      nvidiaDevices: [
        {
          name: 'Fixture GPU',
          driverVersion: '555.42',
          uuid: 'GPU-fixture',
          busId: '0000:01:00.0',
          memoryTotalMiB: 4096,
        },
      ],
    }),
  }
  const executionClosureEntries = {
    'onnxruntime-common': {
      import: 'dist/esm/index.js',
      require: 'dist/cjs/index.js',
    },
    sharp: {
      import: 'dist/index.mjs',
      require: 'dist/index.cjs',
    },
    [sharpPlatformName]: {
      import: 'index.cjs',
      require: 'index.cjs',
    },
  }
  const implementationOptions = {
    parentExecArgv: [],
    sourceFiles,
    addonPath,
    children,
    sharpVersion: '1.2.3-fixture',
    sharpPlatformPackage: sharpPlatformName,
  }
  return {
    repoRoot,
    modelsRoot,
    modelsManifestPath,
    binding,
    onnxEntry,
    onnxRuntime,
    transformersImportEntry,
    transformersRequireEntry,
    transformersRuntime,
    transformersRoot,
    onnxCommonRuntime,
    sharpRuntime,
    colourRuntime,
    colourRoot,
    detectLibcRuntime,
    detectLibcRoot,
    nestedSemverRuntime,
    nestedSemverRoot,
    typescriptEntry,
    typescriptRuntime,
    typescriptRoot,
    pdfjsEntry,
    pdfjsRuntime,
    pdfjsRoot,
    guardUtilsPath,
    e2eBenchmarkPath,
    projectPreviewServicePath,
    projectPreviewProvidersPath,
    canvasEntry,
    canvasBinding,
    canvasRoot,
    canvasNative,
    canvasIcu,
    canvasPlatformRoot,
    sharpPlatformLoader,
    sharpPlatformNode,
    sharpPlatformLibvips,
    sharpPlatformLibvipsCpp,
    sharpPlatformRoot,
    childSharedChunk,
    childNestedChunk,
    executionClosureEntries,
    clipPrimaryPath: path.join(modelsRoot, 'clip_vit_base_patch32', clipPrimary.filename),
    environmentOptions,
    implementationOptions,
  }
}

function fixedConfig(sample = 3) {
  return {
    sample,
    runs: 3,
    pipeline: 'overlap',
    backend: 'gpu',
    jobs: 2,
    batchSize: 4,
    scanWorkers: 3,
    tensorPrefetch: false,
  }
}

function controlLimits() {
  return {
    libraryReadyP95Ms: 250000,
    mainPeakRssP95MiB: 1024,
    childPeakAggregateRssP95MiB: 4096,
    combinedPeakRssP95MiB: 5120,
    systemMinFreeFloorMiB: 256,
  }
}

function reidentify(section) {
  const core = { ...section }
  delete core.identity
  section.identity = fingerprint(core)
}

function rebindResolvedRuntimePackage(value) {
  const runtimeCore = {
    directory: value.runtime.directory,
    fileCount: value.runtime.files.length,
    totalBytes: value.runtime.files.reduce((total, file) => total + file.size, 0),
    files: value.runtime.files,
  }
  value.runtime.fileCount = runtimeCore.fileCount
  value.runtime.totalBytes = runtimeCore.totalBytes
  value.runtime.manifestSha256 = fingerprint(runtimeCore)
  const kind = Object.keys(value.entries)[0]
  const entry = value.entries[kind]
  value.contentIdentity = fingerprint({
    packageName: value.packageName,
    version: value.version,
    packageLocation: value.packageLocation,
    packageManifest: value.packageManifest,
    entry: { kind, path: entry.path, size: entry.size, sha256: entry.sha256 },
    runtime: value.runtime,
  })
  reidentify(value)
}

async function createEvidenceFixture(t, label) {
  const root = makeTempRoot(t, label)
  const datasetRoot = createDataset(root)
  const runtime = createRuntimeFixture(root)
  const options = {
    repoRoot: runtime.repoRoot,
    datasetRoot,
    modelsRoot: runtime.modelsRoot,
    modelsManifestPath: runtime.modelsManifestPath,
    config: fixedConfig(),
    controlLimits: controlLimits(),
    environmentOptions: runtime.environmentOptions,
    implementationOptions: runtime.implementationOptions,
  }
  return {
    root,
    datasetRoot,
    runtime,
    options,
    evidence: await buildEvidence(options),
  }
}

test('dataset manifest uses the E2E BFS order, bounded selection and streamed content identity', async (t) => {
  const root = makeTempRoot(t, 'dataset')
  const datasetRoot = createDataset(root)
  const manifest = await freezeDatasetManifest(datasetRoot, { limit: 3 })

  assert.equal(manifest.selection.algorithm, 'image-search-simple-e2e-bfs-localeCompare-first-v1')
  assert.equal(manifest.selectedImageCount, 3)
  assert.equal(manifest.supportedImageCount, 5)
  assert.deepEqual(
    manifest.entries.map((entry) => entry.path),
    ['b.JPG', 'c.gif', 'a-dir/c.png'],
  )
  assert.deepEqual(manifest.entries[0], {
    path: 'b.JPG',
    size: Buffer.byteLength('root-b'),
    sha256: sha256('root-b'),
  })
  validateDatasetManifest(manifest)

  const repeated = await freezeDatasetManifest(datasetRoot, { limit: 3 })
  assert.deepEqual(repeated, manifest)
  const clamped = await freezeDatasetManifest(datasetRoot, { limit: 5000 })
  assert.equal(clamped.selection.limit, 1000)
  assert.equal(clamped.selectedImageCount, 5)
})

test('dataset verification fails closed on content changes and symlink or junction entries', async (t) => {
  const root = makeTempRoot(t, 'dataset-safety')
  const datasetRoot = createDataset(root)
  const manifest = await freezeDatasetManifest(datasetRoot, { limit: 3 })
  fs.writeFileSync(path.join(datasetRoot, 'a-dir', 'c.png'), 'changed!')
  await assert.rejects(verifyDatasetManifest(datasetRoot, manifest), /Dataset manifest changed/)

  const linkedDataset = path.join(root, 'linked-dataset')
  const outside = path.join(root, 'outside')
  write(linkedDataset, 'safe.png', 'safe')
  write(outside, 'escape.png', 'escape')
  try {
    fs.symlinkSync(outside, path.join(linkedDataset, 'linked'), 'junction')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic('symlink/junction creation is unavailable; mutation assertion still ran')
      return
    }
    throw error
  }
  await assert.rejects(freezeDatasetManifest(linkedDataset), /symlinks or junctions/)
})

test('single-descriptor reads bind parsed bytes, size limits and the final path', async (t) => {
  const root = makeTempRoot(t, 'descriptor-binding')
  const jsonBytes = '{"value":"same-stream"}'
  const jsonPath = write(root, 'evidence.json', jsonBytes)
  const parsed = await readStableJson(jsonPath, { root, label: 'fixture JSON' })
  assert.deepEqual(parsed.value, { value: 'same-stream' })
  assert.deepEqual(parsed.proof, {
    size: Buffer.byteLength(jsonBytes),
    sha256: sha256(jsonBytes),
  })

  const growing = write(root, 'growing.bin', '1234')
  await assert.rejects(
    hashStableFile(growing, {
      root,
      maxBytes: 4,
      afterOpen: () => fs.appendFileSync(growing, '5'),
    }),
    /(?:bounded-read limit|changed)/,
  )

  const replaceable = write(root, 'replaceable.bin', 'trusted-content')
  const displaced = path.join(root, 'displaced.bin')
  let replacementSupported = true
  await assert.rejects(
    hashStableFile(replaceable, {
      root,
      afterOpen: () => {
        try {
          fs.renameSync(replaceable, displaced)
          fs.writeFileSync(replaceable, 'attacker-content')
        } catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
          replacementSupported = false
          fs.appendFileSync(replaceable, '!')
        }
      },
    }),
    /(?:binding|changed|regular non-symlink)/,
  )
  if (!replacementSupported) {
    t.diagnostic('open-file rename is unavailable; same-descriptor mutation fallback was verified')
  }
})

test('environment evidence hashes the actual runtime, native binding, dependencies and pinned models', async (t) => {
  const root = makeTempRoot(t, 'environment')
  const runtime = createRuntimeFixture(root)
  const environment = await collectEnvironmentFingerprint({
    repoRoot: runtime.repoRoot,
    modelsRoot: runtime.modelsRoot,
    modelsManifestPath: runtime.modelsManifestPath,
    ...runtime.environmentOptions,
  })

  assert.equal(environment.node.version, 'v99.1.0-fixture')
  assert.deepEqual(environment.hardwareSnapshot, {
    cpuModel: 'Fixture CPU',
    logicalProcessors: 8,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  })
  assert.equal(environment.node.executable.sha256, sha256('node-runtime'))
  assert.equal(environment.onnxruntimeNode.version, '9.8.7-fixture')
  assert.equal(environment.onnxruntimeNode.nativeBinary.sha256, sha256('native-binding'))
  assert.equal(environment.onnxruntimeNode.nativeDependencies.length, 4)
  assert.equal(environment.onnxruntimeNode.entries.import.path, 'dist/index.js')
  assert.equal(
    environment.onnxruntimeNode.entries.import.resolution,
    'node-import-meta-resolve-from-transformers-entry',
  )
  assert.equal(environment.onnxruntimeNode.runtime.directory, 'dist')
  assert.equal(environment.onnxruntimeNode.runtime.fileCount, 2)
  assert.match(environment.onnxruntimeNode.runtime.manifestSha256, /^[a-f0-9]{64}$/)
  assert.equal(environment.transformers.version, '7.6.5-fixture')
  assert.equal(environment.transformers.entries.import.path, 'dist/transformers.node.mjs')
  assert.equal(
    environment.transformers.entries.import.resolution,
    'node-import-meta-resolve-from-embedding-child',
  )
  assert.equal(environment.transformers.runtime.directory, 'dist')
  assert.equal(environment.transformers.runtime.fileCount, 3)
  assert.match(environment.transformers.runtime.manifestSha256, /^[a-f0-9]{64}$/)
  assert.equal(environment.executionClosure.onnxruntimeCommon.packageName, 'onnxruntime-common')
  assert.equal(environment.executionClosure.sharp.packageName, 'sharp')
  assert.equal(environment.executionClosure.sharpRuntime.packages.length, 2)
  assert.deepEqual(
    environment.executionClosure.sharpRuntime.packages
      .map((bundle) => [bundle.loader.resolverKind, bundle.loader.carrier.path])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['import', 'node_modules/sharp/dist/sharp.mjs'],
      ['require', 'node_modules/sharp/dist/sharp.cjs'],
    ],
  )
  assert.deepEqual(
    environment.executionClosure.e2eTypeScript.externalRuntime.packages.map(
      (runtime) => runtime.packageName,
    ),
    ['pdfjs-dist'],
  )
  assert.deepEqual(
    environment.executionClosure.sharpDependencies.packages.map((dependency) => [
      dependency.packageName,
      dependency.version,
    ]),
    [
      ['@img/colour', '1.1.0-fixture'],
      ['detect-libc', '2.1.2-fixture'],
      ['semver', '7.8.5-fixture'],
    ],
  )
  assert.equal(
    environment.executionClosure.sharpDependencies.packages.find(
      (dependency) => dependency.packageName === 'semver',
    ).packageLocation,
    'node_modules/sharp/node_modules/semver',
  )
  assert.equal(environment.executionClosure.sharpPlatform.packageName, '@img/sharp-win32-x64')
  assert.ok(
    environment.executionClosure.sharpPlatform.runtime.files.some((file) =>
      file.path.endsWith('.node'),
    ),
  )
  assert.ok(
    environment.executionClosure.sharpPlatform.runtime.files.some((file) =>
      /(?:^|\/)libvips-[0-9]+\.dll$/i.test(file.path),
    ),
  )
  assert.ok(
    environment.executionClosure.sharpPlatform.runtime.files.some((file) =>
      /(?:^|\/)libvips-cpp-[0-9]+(?:\.[0-9]+)+\.dll$/i.test(file.path),
    ),
  )
  assert.deepEqual(
    environment.models.models.map((model) => [model.name, model.files.length]),
    [
      ['dinov2_vitb14', 2],
      ['clip_vit_base_patch32', 2],
    ],
  )
  assert.deepEqual(environment.gpu.devices[0], {
    name: 'Fixture GPU',
    driverVersion: '555.42',
    uuid: '',
    busId: '',
    deviceId: 'PCI\\VEN_FIXTURE',
    adapterCompatibility: 'Fixture Vendor',
  })
  assert.deepEqual(environment.gpu.nvidiaDevices[0], {
    name: 'Fixture GPU',
    driverVersion: '555.42',
    uuid: 'GPU-fixture',
    busId: '0000:01:00.0',
    deviceId: '',
    adapterCompatibility: '',
    memoryTotalMiB: 4096,
  })
  const expectedProgramFiles = path.win32.join(
    path.win32.parse(environment.systemTools.systemRoot).root,
    'Program Files',
  )
  assert.equal(environment.systemTools.executionEnvironment.ProgramFiles, expectedProgramFiles)
  assert.equal(environment.systemTools.executionEnvironment.ProgramW6432, expectedProgramFiles)
  assert.equal(
    environment.executionClosure.runtimeEnvironmentDecision.resolverProcessEnvironment
      .ProgramFiles,
    expectedProgramFiles,
  )

  fs.writeFileSync(runtime.clipPrimaryPath, 'bad-content!')
  await assert.rejects(
    collectEnvironmentFingerprint({
      repoRoot: runtime.repoRoot,
      modelsRoot: runtime.modelsRoot,
      modelsManifestPath: runtime.modelsManifestPath,
      ...runtime.environmentOptions,
    }),
    /model file (size|SHA-256) does not match/,
  )
})

test('package runtime JS changes identity and bounded traversal fails closed', async (t) => {
  const root = makeTempRoot(t, 'package-runtime')
  const runtime = createRuntimeFixture(root)
  const collect = (extra = {}) =>
    collectEnvironmentFingerprint({
      repoRoot: runtime.repoRoot,
      modelsRoot: runtime.modelsRoot,
      modelsManifestPath: runtime.modelsManifestPath,
      ...runtime.environmentOptions,
      ...extra,
    })

  const first = await collect()
  fs.writeFileSync(runtime.transformersRuntime, 'transformers-shared-v2')
  const transformersChanged = await collect()
  assert.equal(transformersChanged.transformers.version, first.transformers.version)
  assert.deepEqual(
    transformersChanged.transformers.packageManifest,
    first.transformers.packageManifest,
  )
  assert.deepEqual(transformersChanged.transformers.entries, first.transformers.entries)
  assert.notEqual(
    transformersChanged.transformers.runtime.manifestSha256,
    first.transformers.runtime.manifestSha256,
  )
  assert.notEqual(transformersChanged.identity, first.identity)

  fs.writeFileSync(runtime.onnxRuntime, 'onnx-session-v2')
  const onnxChanged = await collect()
  assert.equal(onnxChanged.onnxruntimeNode.version, transformersChanged.onnxruntimeNode.version)
  assert.deepEqual(
    onnxChanged.onnxruntimeNode.packageManifest,
    transformersChanged.onnxruntimeNode.packageManifest,
  )
  assert.notEqual(
    onnxChanged.onnxruntimeNode.runtime.manifestSha256,
    transformersChanged.onnxruntimeNode.runtime.manifestSha256,
  )
  assert.notEqual(onnxChanged.identity, transformersChanged.identity)

  fs.writeFileSync(runtime.pdfjsRuntime, 'pdf-worker-runtime-v2')
  const pdfjsChanged = await collect()
  assert.notEqual(
    pdfjsChanged.executionClosure.e2eTypeScript.externalRuntime.identity,
    onnxChanged.executionClosure.e2eTypeScript.externalRuntime.identity,
  )
  assert.notEqual(pdfjsChanged.identity, onnxChanged.identity)

  await assert.rejects(
    collect({
      packageRuntimeLimits: {
        '@huggingface/transformers': { maxFiles: 2 },
      },
    }),
    /file-count hard limit/,
  )
  await assert.rejects(
    collect({
      packageRuntimeLimits: {
        '@huggingface/transformers': { maxTotalBytes: 8 },
      },
    }),
    /total-byte hard limit/,
  )

  const outside = path.join(root, 'outside-runtime')
  write(outside, 'escape.js', 'escape')
  try {
    fs.symlinkSync(outside, path.join(runtime.transformersRoot, 'dist', 'linked'), 'junction')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic('symlink/junction creation is unavailable; runtime limits still ran')
      return
    }
    throw error
  }
  await assert.rejects(collect(), /symlink or junction/)
})

test('execution dependency closure detects every ORT Common and Sharp payload mutation or omission', async (t) => {
  const root = makeTempRoot(t, 'execution-closure')
  const runtime = createRuntimeFixture(root)
  const collect = () =>
    collectExecutionDependencyClosure({
      repoRoot: runtime.repoRoot,
      ...runtime.environmentOptions,
      packageEntries: runtime.executionClosureEntries,
    })

  const first = await collect()
  const dependency = (closure, packageName) =>
    closure.sharpDependencies.packages.find((item) => item.packageName === packageName)
  assert.equal(dependency(first, 'semver').version, '7.8.5-fixture')
  assert.equal(
    dependency(first, 'semver').packageLocation,
    'node_modules/sharp/node_modules/semver',
  )

  fs.writeFileSync(runtime.colourRuntime, 'colour-entry-v2')
  const colourChanged = await collect()
  assert.notEqual(
    dependency(colourChanged, '@img/colour').identity,
    dependency(first, '@img/colour').identity,
  )

  fs.writeFileSync(runtime.detectLibcRuntime, 'detect-libc-entry-v2')
  const detectLibcChanged = await collect()
  assert.notEqual(
    dependency(detectLibcChanged, 'detect-libc').identity,
    dependency(colourChanged, 'detect-libc').identity,
  )

  fs.writeFileSync(runtime.nestedSemverRuntime, 'nested-semver-entry-v2')
  const semverChanged = await collect()
  assert.notEqual(
    dependency(semverChanged, 'semver').identity,
    dependency(detectLibcChanged, 'semver').identity,
  )

  fs.writeFileSync(runtime.onnxCommonRuntime, 'onnx-common-cjs-v2')
  const commonChanged = await collect()
  assert.notEqual(commonChanged.onnxruntimeCommon.identity, first.onnxruntimeCommon.identity)
  assert.equal(commonChanged.onnxruntimeCommon.version, first.onnxruntimeCommon.version)

  fs.writeFileSync(runtime.sharpRuntime, "module.exports = require('./sharp.cjs'); // v2")
  const sharpChanged = await collect()
  assert.notEqual(sharpChanged.sharp.identity, commonChanged.sharp.identity)

  fs.writeFileSync(runtime.sharpPlatformLoader, 'sharp-platform-loader-v2')
  const loaderChanged = await collect()
  assert.notEqual(loaderChanged.sharpPlatform.identity, sharpChanged.sharpPlatform.identity)

  fs.writeFileSync(runtime.sharpPlatformNode, 'sharp-native-v2')
  const nativeChanged = await collect()
  assert.notEqual(nativeChanged.sharpPlatform.identity, loaderChanged.sharpPlatform.identity)

  fs.writeFileSync(runtime.sharpPlatformLibvips, 'libvips-runtime-v2')
  const libvipsChanged = await collect()
  assert.notEqual(libvipsChanged.sharpPlatform.identity, nativeChanged.sharpPlatform.identity)

  fs.writeFileSync(runtime.sharpPlatformLibvipsCpp, 'libvips-cpp-runtime-v2')
  const libvipsCppChanged = await collect()
  assert.notEqual(
    libvipsCppChanged.sharpPlatform.identity,
    libvipsChanged.sharpPlatform.identity,
  )

  fs.rmSync(runtime.onnxCommonRuntime)
  await assert.rejects(collect(), /onnxruntime-common.*(?:missing|resolve)/i)
  fs.writeFileSync(runtime.onnxCommonRuntime, 'onnx-common-cjs-v2')

  fs.rmSync(runtime.sharpRuntime)
  await assert.rejects(collect(), /sharp.*(?:missing|resolve)/i)
  fs.writeFileSync(runtime.sharpRuntime, "module.exports = require('./sharp.cjs'); // v2")

  fs.rmSync(runtime.sharpPlatformNode)
  await assert.rejects(collect(), /must contain exactly one native \.node payload/)
  fs.writeFileSync(runtime.sharpPlatformNode, 'sharp-native-v2')

  fs.rmSync(runtime.sharpPlatformLibvips)
  await assert.rejects(collect(), /exactly one libvips ABI DLL/)

  fs.writeFileSync(runtime.sharpPlatformLibvips, 'libvips-runtime-v2')
  fs.rmSync(runtime.sharpPlatformLibvipsCpp)
  await assert.rejects(collect(), /exactly one libvips ABI DLL/)
  fs.writeFileSync(runtime.sharpPlatformLibvipsCpp, 'libvips-cpp-runtime-v2')

  const unexpectedSharpDll = write(
    runtime.sharpPlatformRoot,
    'lib/unexpected-runtime.dll',
    'unexpected-runtime-v1',
  )
  await assert.rejects(collect(), /exactly one libvips ABI DLL/)
  fs.rmSync(unexpectedSharpDll)
  for (const [packageName, entryPath, contents] of [
    ['@img/colour', runtime.colourRuntime, 'colour-entry-v2'],
    ['detect-libc', runtime.detectLibcRuntime, 'detect-libc-entry-v2'],
    ['semver', runtime.nestedSemverRuntime, 'nested-semver-entry-v2'],
  ]) {
    fs.rmSync(entryPath)
    await assert.rejects(
      collect(),
      new RegExp(
        packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '.*(?:find|missing|resolve)',
        'i',
      ),
    )
    fs.writeFileSync(entryPath, contents)
  }
})

test('model manifest path escape is rejected before any outside file can be trusted', async (t) => {
  const root = makeTempRoot(t, 'model-escape')
  const runtime = createRuntimeFixture(root)
  const manifest = JSON.parse(fs.readFileSync(runtime.modelsManifestPath, 'utf8'))
  manifest.models[0].filename = '../outside.onnx'
  fs.writeFileSync(runtime.modelsManifestPath, JSON.stringify(manifest))

  await assert.rejects(
    collectEnvironmentFingerprint({
      repoRoot: runtime.repoRoot,
      modelsRoot: runtime.modelsRoot,
      modelsManifestPath: runtime.modelsManifestPath,
      ...runtime.environmentOptions,
    }),
    /unsafe or duplicate filename/,
  )
})

test('implementation revision separates source, scanner binary and actual child build proofs', async (t) => {
  const root = makeTempRoot(t, 'implementation')
  const runtime = createRuntimeFixture(root)
  const first = await collectImplementationRevision({
    repoRoot: runtime.repoRoot,
    ...runtime.implementationOptions,
  })
  assert.equal(first.sources.length, 2)
  assert.equal(first.fastScanner.sha256, sha256('scanner-build'))
  assert.equal(first.children.length, 3)
  assert.equal(first.children[0].source.sha256, sha256('clipEmbeddingChild-source'))
  assert.equal(
    first.children[0].built.sha256,
    sha256(
      "clipEmbeddingChild-build; import('@huggingface/transformers'); require('./index-fixture-A1b2.js')",
    ),
  )
  const clip = first.children.find((child) => child.name === 'clipEmbeddingChild')
  const dino = first.children.find((child) => child.name === 'dinoEmbeddingChild')
  const preparation = first.children.find(
    (child) => child.name === 'embeddingPreparationChild',
  )
  assert.equal(clip.runtimeClosure.fileCount, 3)
  assert.ok(clip.runtimeClosure.files.some((file) => file.path.endsWith('index-fixture-A1b2.js')))
  assert.ok(
    clip.runtimeClosure.files.some((file) => file.path.endsWith('child-shared-nested.js')),
  )
  assert.equal(dino.runtimeClosure.fileCount, 1)
  assert.equal(preparation.runtimeClosure.fileCount, 1)
  assert.equal(first.bundledSharpLoaders.contexts.length, 2)
  assert.deepEqual(
    first.bundledSharpLoaders.contexts.map((context) => context.children),
    [['dinoEmbeddingChild'], ['clipEmbeddingChild']],
  )

  fs.writeFileSync(
    runtime.childSharedChunk,
    [
      "module.exports = require('./child-shared-nested.js')",
      '/* ../src/build/Release/sharp-win32-x64-1.2.3-fixture.node */',
      '/* ../src/build/Release/sharp-wasm32-1.2.3-fixture.node */',
      "require('@img/sharp-libvips-dev/cplusplus')",
      "require('@img/sharp-libvips-dev/include')",
      '// v2',
    ].join('; '),
  )
  const second = await collectImplementationRevision({
    repoRoot: runtime.repoRoot,
    ...runtime.implementationOptions,
  })
  assert.notEqual(second.identity, first.identity)

  fs.rmSync(runtime.childNestedChunk)
  await assert.rejects(
    collectImplementationRevision({
      repoRoot: runtime.repoRoot,
      ...runtime.implementationOptions,
    }),
    /local runtime (?:reference|dependency).*(?:missing|resolve)/i,
  )
  fs.writeFileSync(runtime.childNestedChunk, 'module.exports = 1')

  for (const child of runtime.implementationOptions.children) {
    const childPath = path.join(runtime.repoRoot, child.built)
    const contents = fs.readFileSync(childPath)
    fs.rmSync(childPath)
    await assert.rejects(
      collectImplementationRevision({
        repoRoot: runtime.repoRoot,
        ...runtime.implementationOptions,
      }),
      /(?:missing|could not be opened)/i,
    )
    fs.writeFileSync(childPath, contents)
  }
})

test('evidence capture verifies the dataset again after environment collection', async (t) => {
  const root = makeTempRoot(t, 'before-after')
  const datasetRoot = createDataset(root)
  const runtime = createRuntimeFixture(root)
  let mutated = false
  const gpuProbe = () => {
    if (!mutated) {
      mutated = true
      fs.writeFileSync(path.join(datasetRoot, 'b.JPG'), 'mutated-during-capture')
    }
    return runtime.environmentOptions.gpuProbe()
  }
  await assert.rejects(
    buildEvidence({
      repoRoot: runtime.repoRoot,
      datasetRoot,
      modelsRoot: runtime.modelsRoot,
      modelsManifestPath: runtime.modelsManifestPath,
      config: fixedConfig(),
      environmentOptions: { ...runtime.environmentOptions, gpuProbe },
      implementationOptions: runtime.implementationOptions,
    }),
    /Dataset manifest changed/,
  )
})

test('comparison rejects environment, dataset, config, implementation and incomplete control lines', async (t) => {
  const fixture = await createEvidenceFixture(t, 'compare')
  const control = fixture.evidence
  const candidate = await buildEvidence(fixture.options)
  const matching = compareEvidence(control, candidate)
  assert.equal(matching.ok, true, matching.failures.join('\n'))
  assert.doesNotThrow(() => assertEvidenceComparable(control, candidate))

  const forgedModelSet = structuredClone(candidate)
  const forgedModels = forgedModelSet.environment.models
  forgedModels.models[0].files.pop()
  forgedModels.manifestDescriptors[0].files.pop()
  forgedModels.models[0].identity = fingerprint(forgedModels.models[0].files)
  reidentify(forgedModels)
  reidentify(forgedModelSet.environment)
  assert.match(
    compareEvidence(control, forgedModelSet).failures.join('\n'),
    /model manifest\/file binding is invalid/,
  )

  const forgedPdfClosure = structuredClone(candidate)
  const forgedExecution = forgedPdfClosure.environment.executionClosure
  forgedExecution.e2eTypeScript.externalRuntime.packages = []
  forgedExecution.e2eTypeScript.externalRuntime.resolutions = []
  reidentify(forgedExecution.e2eTypeScript.externalRuntime)
  reidentify(forgedExecution.e2eTypeScript)
  reidentify(forgedExecution)
  reidentify(forgedPdfClosure.environment)
  const forgedSource = forgedPdfClosure.implementation.e2eTypeScript.sourceClosure
  forgedSource.externalSpecifiers = forgedSource.externalSpecifiers.filter(
    (descriptor) => descriptor.packageName !== 'pdfjs-dist',
  )
  reidentify(forgedSource)
  reidentify(forgedPdfClosure.implementation.e2eTypeScript)
  reidentify(forgedPdfClosure.implementation)
  assert.match(
    compareEvidence(control, forgedPdfClosure).failures.join('\n'),
    /exactly pdfjs-dist|pdfjs-dist runtime edge is not exact/,
  )

  const forgedSharpCrossBinding = structuredClone(candidate)
  const forgedSharpExecution = forgedSharpCrossBinding.environment.executionClosure
  const transformerSharp = forgedSharpExecution.sharpRuntime.resolutions.find(
    (resolution) => resolution.name === 'transformers-node-runtime-1',
  )
  transformerSharp.resolverParent = 'fixture/forged-transformers-entry.mjs'
  reidentify(transformerSharp)
  reidentify(forgedSharpExecution.sharpRuntime)
  reidentify(forgedSharpExecution)
  reidentify(forgedSharpCrossBinding.environment)
  assert.match(
    compareEvidence(control, forgedSharpCrossBinding).failures.join('\n'),
    /Transformers Sharp resolution is not bound|Sharp importer resolution is invalid/,
  )

  const forgedOrtPayload = structuredClone(candidate)
  const forgedOrtExecution = forgedOrtPayload.environment.executionClosure
  for (const runtime of [
    forgedOrtPayload.environment.onnxruntimeNode,
    forgedOrtExecution.mlRuntime.onnxruntimeNodePackages[0],
  ]) {
    runtime.nativeDependencies = runtime.nativeDependencies.filter(
      (dependency) => !dependency.path.endsWith('/DirectML.dll'),
    )
    reidentify(runtime)
  }
  reidentify(forgedOrtExecution.mlRuntime)
  reidentify(forgedOrtExecution)
  reidentify(forgedOrtPayload.environment)
  assert.match(
    compareEvidence(control, forgedOrtPayload).failures.join('\n'),
    /native DirectML payload set is invalid/,
  )

  const forgedCommonKinds = structuredClone(candidate)
  const forgedCommonExecution = forgedCommonKinds.environment.executionClosure
  const commonImport = structuredClone(
    forgedCommonExecution.mlRuntime.onnxruntimeCommonPackages.find(
      (runtime) => runtime.entries.import,
    ),
  )
  forgedCommonExecution.mlRuntime.onnxruntimeCommonPackages[1] = commonImport
  const commonEdge = forgedCommonExecution.mlRuntime.dependencyResolutions.find(
    (resolution) => resolution.name === 'onnxruntime-node-to-common',
  )
  commonEdge.packageName = commonImport.packageName
  commonEdge.packageLocation = commonImport.packageLocation
  commonEdge.packageIdentity = commonImport.contentIdentity
  commonEdge.resolvedEntry = undefined
  reidentify(commonEdge)
  reidentify(forgedCommonExecution.mlRuntime)
  forgedCommonExecution.onnxruntimeCommon = commonImport
  reidentify(forgedCommonExecution)
  reidentify(forgedCommonKinds.environment)
  assert.match(
    compareEvidence(control, forgedCommonKinds).failures.join('\n'),
    /package kind\/identity set is not exact|resolution edge is invalid/,
  )

  const forgedTranspilerEntry = structuredClone(candidate)
  const forgedTranspilerExecution = forgedTranspilerEntry.environment.executionClosure
  forgedTranspilerExecution.e2eTypeScript.transpiler.entries.require.path =
    'lib/forged-typescript.js'
  rebindResolvedRuntimePackage(forgedTranspilerExecution.e2eTypeScript.transpiler)
  reidentify(forgedTranspilerExecution.e2eTypeScript)
  reidentify(forgedTranspilerExecution)
  reidentify(forgedTranspilerEntry.environment)
  assert.match(
    compareEvidence(control, forgedTranspilerEntry).failures.join('\n'),
    /entry is not bound to its runtime manifest/,
  )

  const forgedCanvasPayload = structuredClone(candidate)
  const forgedCanvasExecution = forgedCanvasPayload.environment.executionClosure
  const forgedCanvas = forgedCanvasExecution.canvas
  forgedCanvas.platformPackage.runtime.files = forgedCanvas.platformPackage.runtime.files.filter(
    (file) => !file.path.endsWith('.node'),
  )
  rebindResolvedRuntimePackage(forgedCanvas.platformPackage)
  forgedCanvas.candidates[1].payloadIdentity = forgedCanvas.platformPackage.identity
  forgedCanvas.selected.payloadIdentity = forgedCanvas.platformPackage.identity
  reidentify(forgedCanvas)
  reidentify(forgedCanvasExecution)
  reidentify(forgedCanvasPayload.environment)
  assert.match(
    compareEvidence(control, forgedCanvasPayload).failures.join('\n'),
    /Canvas resolver\/carrier\/platform binding is invalid/,
  )

  const environmentMismatch = structuredClone(candidate)
  environmentMismatch.environment.os.release = 'different'
  reidentify(environmentMismatch.environment)
  assert.match(
    compareEvidence(control, environmentMismatch).failures.join('\n'),
    /environment fingerprint differs/,
  )

  for (const key of ['ProgramFiles', 'ProgramW6432']) {
    const forgedProgramFiles = structuredClone(candidate)
    const forgedExecution = forgedProgramFiles.environment.executionClosure
    forgedExecution.runtimeEnvironmentDecision.resolverProcessEnvironment[key] =
      'D:\\Program Files'
    reidentify(forgedExecution)
    reidentify(forgedProgramFiles.environment)
    assert.match(
      compareEvidence(control, forgedProgramFiles).failures.join('\n'),
      /resolver process environment differs from system tools/,
      key,
    )
  }

  const datasetMismatch = structuredClone(candidate)
  datasetMismatch.dataset.entries[0].sha256 = '0'.repeat(64)
  reidentify(datasetMismatch.dataset)
  assert.match(
    compareEvidence(control, datasetMismatch).failures.join('\n'),
    /dataset identity differs/,
  )

  const configMismatch = structuredClone(candidate)
  configMismatch.config.jobs = 1
  assert.match(
    compareEvidence(control, configMismatch).failures.join('\n'),
    /fixed benchmark config differs/,
  )

  const implementationMismatch = structuredClone(candidate)
  implementationMismatch.implementation.fastScanner.sha256 = '1'.repeat(64)
  reidentify(implementationMismatch.implementation)
  assert.match(
    compareEvidence(control, implementationMismatch).failures.join('\n'),
    /implementation revision differs/,
  )
  const tracked = compareEvidence(control, implementationMismatch, {
    implementationMode: 'track',
  })
  assert.equal(tracked.ok, true, tracked.failures.join('\n'))
  assert.equal(tracked.implementation.changed, true)

  const incompleteControl = structuredClone(control)
  delete incompleteControl.controlLimits.systemMinFreeFloorMiB
  const incomplete = compareEvidence(incompleteControl, candidate)
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.failures.join('\n'), /systemMinFreeFloorMiB/)
  assert.throws(
    () => assertEvidenceComparable(incompleteControl, candidate),
    /control line field is missing/,
  )

  const incompleteEnvironment = structuredClone(candidate)
  delete incompleteEnvironment.environment.node.executable.sha256
  reidentify(incompleteEnvironment.environment)
  assert.match(
    compareEvidence(control, incompleteEnvironment).failures.join('\n'),
    /Node executable proof is missing/,
  )
})
