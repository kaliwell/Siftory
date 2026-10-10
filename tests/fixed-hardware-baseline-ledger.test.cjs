const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { IMAGE_EXTENSIONS, fingerprint } = require('../scripts/fixed-hardware-baseline-evidence.cjs')

const {
  ACCEPTED_POINTER_FILE_NAME,
  LOCK_FILE_NAME,
  MAX_ACCEPTED_POINTER_BYTES,
  MAX_ACCEPTED_REPORT_BYTES,
  acquireManagedRunWorkspace,
  commitAcceptedBaseline,
  commitPromotedBaseline,
  readStableJsonFile,
  resolveAcceptedBaseline,
  validateManagedRunPaths,
  withManagedRunWorkspace,
} = require('../scripts/fixed-hardware-baseline-ledger.cjs')

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-fixed-ledger-'))
  t.after(() => {
    const temporaryRoot = path.resolve(os.tmpdir())
    assert.ok(path.resolve(root).startsWith(`${temporaryRoot}${path.sep}`))
    assert.match(path.basename(root), /^siftory-fixed-ledger-/)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const managedRoot = path.join(root, 'managed')
  const dataset = path.join(root, 'dataset')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  return { root, managedRoot, dataset }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function fileProof(label) {
  return { size: Buffer.byteLength(label), sha256: sha256(label) }
}

function runtimeProof(label) {
  const files = [{ path: `${label}.bin`, ...fileProof(`${label}-runtime`) }]
  const core = {
    directory: `fixture/${label}`,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
  }
  return {
    limits: { maxDirectories: 1024, maxFiles: 4096, maxTotalBytes: 256 * 1024 * 1024 },
    ...core,
    manifestSha256: fingerprint(core),
  }
}

function packageProof(packageName, kind = 'require', suffix = kind) {
  const packageLocation = `node_modules/${packageName}`
  const entry = {
    resolution: `fixture-${kind}-resolution`,
    resolvedFrom: `fixture/importers/${suffix}.js`,
    path: `dist/${suffix}.js`,
    ...fileProof(`${packageName}-${suffix}`),
  }
  const runtime = runtimeProof(`${packageName.replaceAll('/', '-')}-${suffix}`)
  runtime.files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 })
  runtime.files.sort((left, right) => left.path.localeCompare(right.path))
  runtime.fileCount = runtime.files.length
  runtime.totalBytes = runtime.files.reduce((total, file) => total + file.size, 0)
  runtime.manifestSha256 = fingerprint({
    directory: runtime.directory,
    fileCount: runtime.fileCount,
    totalBytes: runtime.totalBytes,
    files: runtime.files,
  })
  const packageManifest = fileProof(`${packageName}-manifest`)
  const version = '1.0.0-fixture'
  const contentIdentity = fingerprint({
    packageName,
    version,
    packageLocation,
    packageManifest,
    entry: { kind, path: entry.path, size: entry.size, sha256: entry.sha256 },
    runtime,
  })
  return withIdentity({
    packageName,
    version,
    packageLocation,
    packageManifest,
    entries: { [kind]: entry },
    runtime,
    contentIdentity,
  })
}

function refreshPackageProof(value) {
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
  value.identity = fingerprint(withoutIdentity(value))
  return value
}

function sharpPlatformProof() {
  const packageName = '@img/sharp-fixture-x64'
  const files = [
    { path: 'loader.js', ...fileProof('sharp-platform-loader') },
    { path: 'sharp.node', ...fileProof('sharp-platform-native') },
  ]
  const runtimeCore = {
    directory: 'fixture/sharp-platform',
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
  }
  const packageManifest = fileProof('sharp-platform-manifest')
  const entry = {
    resolution: 'node-create-require-resolve-from-sharp-loader',
    resolvedFrom: 'node_modules/sharp/dist/sharp.cjs',
    path: 'loader.js',
    ...fileProof('sharp-platform-loader'),
  }
  const runtime = {
    limits: { maxDirectories: 1024, maxFiles: 4096, maxTotalBytes: 256 * 1024 * 1024 },
    ...runtimeCore,
    manifestSha256: fingerprint(runtimeCore),
  }
  const version = '1.0.0-fixture'
  const packageLocation = 'node_modules/@img/sharp-fixture-x64'
  const contentIdentity = fingerprint({
    packageName,
    version,
    packageLocation,
    packageManifest,
    entry: { kind: 'require', path: entry.path, size: entry.size, sha256: entry.sha256 },
    runtime,
  })
  return withIdentity({
    packageName,
    version,
    packageLocation,
    packageManifest,
    entries: { require: entry },
    runtime,
    contentIdentity,
  })
}

function executionClosureProof() {
  const transformers = packageProof('@huggingface/transformers', 'import', 'transformers-node')
  const onnxCommonImport = packageProof('onnxruntime-common', 'import', 'common-import')
  const onnxCommonRequire = packageProof('onnxruntime-common', 'require', 'common-require')
  const onnxBase = packageProof('onnxruntime-node', 'import', 'onnx-node')
  const nativePrefix = 'bin/napi-v6/win32/x64'
  const onnxruntimeNode = withIdentity({
    ...withoutIdentity(onnxBase),
    nativeBinary: {
      path: `${nativePrefix}/onnxruntime_binding.node`,
      ...fileProof('onnxruntime-native'),
    },
    nativeDependencies: ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll', 'onnxruntime.dll'].map(
      (name) => ({ path: `${nativePrefix}/${name}`, ...fileProof(`onnxruntime-${name}`) }),
    ),
    napiVersion: 6,
    platform: 'win32',
    arch: 'x64',
  })
  const transformerDescriptor = withIdentity({
    packageLocation: transformers.packageLocation,
    package: transformers,
  })
  const childResolutions = ['clipEmbeddingChild', 'dinoEmbeddingChild'].map((child) =>
    withIdentity({
      child,
      resolverParent: `dist/${child}.js`,
      packageLocation: transformers.packageLocation,
      packageIdentity: transformers.contentIdentity,
      resolvedEntry: transformers.entries.import.path,
    }),
  )
  const dependencyResolutions = [
    [
      'transformers-to-onnxruntime-node',
      `${transformers.packageLocation}/${transformers.entries.import.path}`,
      onnxruntimeNode,
      'import',
    ],
    [
      'transformers-to-onnxruntime-common',
      `${transformers.packageLocation}/${transformers.entries.import.path}`,
      onnxCommonImport,
      'import',
    ],
    [
      'onnxruntime-node-to-common',
      `${onnxruntimeNode.packageLocation}/${onnxruntimeNode.entries.import.path}`,
      onnxCommonRequire,
      'require',
    ],
  ].map(([name, resolverParent, runtime, resolutionKind]) =>
    withIdentity({
      name,
      resolverParent,
      resolutionKind,
      packageName: runtime.packageName,
      packageLocation: runtime.packageLocation,
      packageIdentity: runtime.contentIdentity,
      resolvedEntry: runtime.entries[resolutionKind].path,
    }),
  )
  const mlRuntime = withIdentity({
    algorithm: 'embedding-child-import-resolution-closure-v1',
    childResolutions,
    transformerPackages: [transformerDescriptor],
    onnxruntimeNodePackages: [onnxruntimeNode],
    onnxruntimeCommonPackages: [onnxCommonImport, onnxCommonRequire],
    dependencyResolutions,
  })
  const absence = (name) => ({
    status: 'absent',
    path: `node_modules/sharp/src/build/Release/${name}`,
    missingAt: 'node_modules/sharp/src/build',
    parent: { path: 'node_modules/sharp/src', entryCount: 1, listingSha256: sha256(name) },
  })
  const makeSharpBundle = (kind, resolverParent, suffix) => {
    const sharp = packageProof('sharp', kind, `index.${suffix}`)
    sharp.entries[kind].resolution =
      kind === 'import'
        ? 'node-import-meta-resolve-from-sharp-importer'
        : 'node-create-require-resolve-from-sharp-importer'
    sharp.entries[kind].resolvedFrom = resolverParent
    const carrierName = `sharp.${suffix}`
    const carrierProof = fileProof(`sharp-loader-carrier-${kind}`)
    const sharpRuntimeCore = {
      directory: 'dist',
      fileCount: 2,
      totalBytes: sharp.entries[kind].size + carrierProof.size,
      files: [
        {
          path: sharp.entries[kind].path,
          size: sharp.entries[kind].size,
          sha256: sharp.entries[kind].sha256,
        },
        { path: `dist/${carrierName}`, ...carrierProof },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    }
    sharp.runtime = {
      limits: { maxDirectories: 1024, maxFiles: 4096, maxTotalBytes: 256 * 1024 * 1024 },
      ...sharpRuntimeCore,
      manifestSha256: fingerprint(sharpRuntimeCore),
    }
    refreshPackageProof(sharp)
    const sharpEntryParent = `${sharp.packageLocation}/${sharp.entries[kind].path}`
    const packages = ['@img/colour', 'detect-libc', 'semver'].map((name) => {
      const dependency = packageProof(name, 'require', `${kind}-${name.replaceAll('/', '-')}`)
      dependency.entries.require.resolution = 'node-create-require-resolve-from-sharp-entry'
      dependency.entries.require.resolvedFrom = sharpEntryParent
      return refreshPackageProof(dependency)
    })
    const dependencies = withIdentity({
      discovery: {
        algorithm: 'sharp-declared-plus-static-literal-dependencies-v2',
        declared: ['@img/colour', 'detect-libc', 'semver'],
        staticSpecifiers: [],
        resolvedPackageNames: ['@img/colour', 'detect-libc', 'semver'],
      },
      packages,
    })
    const platform = sharpPlatformProof()
    platform.entries.require.resolvedFrom = `${sharp.packageLocation}/dist/${carrierName}`
    refreshPackageProof(platform)
    const candidates = [
      { kind: 'local-platform-native', priority: 1, ...absence(`sharp-${suffix}.node`) },
      { kind: 'local-wasm-native', priority: 2, ...absence(`sharp-${suffix}-wasm.node`) },
      {
        kind: 'platform-package',
        priority: 3,
        status: 'present',
        packageName: platform.packageName,
        packageLocation: platform.packageLocation,
        payloadIdentity: platform.identity,
      },
    ]
    const loader = withIdentity({
      algorithm: 'sharp-native-loader-win32-priority-v2',
      resolverKind: kind,
      resolverParent,
      resolvedEntry: sharp.entries[kind].path,
      carrier: {
        path: `${sharp.packageLocation}/dist/${carrierName}`,
        ...carrierProof,
      },
      runtimePlatform: 'fixture-x64',
      version: sharp.version,
      candidates,
      selected: { kind: 'platform-package', priority: 3, payloadIdentity: platform.identity },
      platformPackage: platform,
    })
    return withIdentity({
      packageLocation: sharp.packageLocation,
      contentIdentity: sharp.contentIdentity,
      sharp,
      dependencies,
      platform,
      loader,
    })
  }
  const transformerEntry = `${transformers.packageLocation}/${transformers.entries.import.path}`
  const requireSharpBundle = makeSharpBundle('require', 'electron/projectPreviewService.ts', 'cjs')
  const importSharpBundle = makeSharpBundle('import', transformerEntry, 'mjs')
  const sharp = requireSharpBundle.sharp
  const sharpDependencies = requireSharpBundle.dependencies
  const sharpLoader = requireSharpBundle.loader
  const sharpPlatform = requireSharpBundle.platform
  const sharpResolutions = [
    withIdentity({
      name: 'e2e-project-preview',
      resolverParent: 'electron/projectPreviewService.ts',
      packageLocation: requireSharpBundle.packageLocation,
      packageIdentity: requireSharpBundle.contentIdentity,
      resolutionKind: 'require',
      resolvedEntry: requireSharpBundle.sharp.entries.require.path,
    }),
    withIdentity({
      name: 'transformers-node-runtime-1',
      resolverParent: transformerEntry,
      packageLocation: importSharpBundle.packageLocation,
      packageIdentity: importSharpBundle.contentIdentity,
      resolutionKind: 'import',
      resolvedEntry: importSharpBundle.sharp.entries.import.path,
    }),
  ]
  const sharpRuntime = withIdentity({
    algorithm: 'sharp-explicit-importer-resolution-v1',
    resolutions: sharpResolutions,
    packages: [requireSharpBundle, importSharpBundle],
  })
  const typescript = packageProof('typescript', 'require', 'typescript')
  typescript.entries.require.resolution = 'node-create-require-resolve-from-guard-utils'
  typescript.entries.require.resolvedFrom = 'tests/guard-utils.cjs'
  refreshPackageProof(typescript)
  const pdfjs = packageProof('pdfjs-dist', 'require', 'legacy-pdf')
  pdfjs.entries.require.resolution = 'node-create-require-resolve-from-guard-loaded-ts-importer'
  pdfjs.entries.require.resolvedFrom = 'electron/projectPreviewProviders.ts'
  refreshPackageProof(pdfjs)
  const pdfjsResolution = withIdentity({
    importer: 'electron/projectPreviewProviders.ts',
    specifier: 'pdfjs-dist/legacy/build/pdf.mjs',
    packageName: 'pdfjs-dist',
    packageLocation: pdfjs.packageLocation,
    packageIdentity: pdfjs.contentIdentity,
    resolvedEntry: pdfjs.entries.require.path,
  })
  const externalRuntime = withIdentity({
    algorithm: 'guard-loaded-ts-explicit-runtime-packages-v1',
    resolutions: [pdfjsResolution],
    packages: [pdfjs],
  })
  const e2eTypeScript = withIdentity({ transpiler: typescript, externalRuntime })
  const canvasPackage = packageProof('@napi-rs/canvas', 'require', 'canvas')
  canvasPackage.entries.require.resolution = 'node-create-require-resolve-from-canvas-importer'
  canvasPackage.entries.require.resolvedFrom = 'electron/projectPreviewProviders.ts'
  const canvasCarrierProof = fileProof('canvas-carrier')
  const canvasRuntimeCore = {
    directory: '.',
    fileCount: 2,
    totalBytes: canvasPackage.entries.require.size + canvasCarrierProof.size,
    files: [
      {
        path: canvasPackage.entries.require.path,
        size: canvasPackage.entries.require.size,
        sha256: canvasPackage.entries.require.sha256,
      },
      { path: 'js-binding.js', ...canvasCarrierProof },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  }
  canvasPackage.runtime = {
    limits: { maxDirectories: 1024, maxFiles: 4096, maxTotalBytes: 256 * 1024 * 1024 },
    ...canvasRuntimeCore,
    manifestSha256: fingerprint(canvasRuntimeCore),
  }
  refreshPackageProof(canvasPackage)
  const canvasPlatform = packageProof('@napi-rs/canvas-win32-x64-msvc', 'require', 'canvas-native')
  canvasPlatform.entries.require = {
    resolution: 'node-create-require-resolve-from-canvas-loader',
    resolvedFrom: 'node_modules/@napi-rs/canvas/js-binding.js',
    path: 'skia.win32-x64-msvc.node',
    ...fileProof('canvas-native'),
  }
  const canvasIcuProof = fileProof('canvas-icu')
  const canvasPlatformRuntimeCore = {
    directory: '.',
    fileCount: 2,
    totalBytes: canvasPlatform.entries.require.size + canvasIcuProof.size,
    files: [
      { path: 'icudtl.dat', ...canvasIcuProof },
      {
        path: canvasPlatform.entries.require.path,
        size: canvasPlatform.entries.require.size,
        sha256: canvasPlatform.entries.require.sha256,
      },
    ],
  }
  canvasPlatform.runtime = {
    limits: { maxDirectories: 1024, maxFiles: 4096, maxTotalBytes: 256 * 1024 * 1024 },
    ...canvasPlatformRuntimeCore,
    manifestSha256: fingerprint(canvasPlatformRuntimeCore),
  }
  refreshPackageProof(canvasPlatform)
  const canvasAbsence = {
    ...absence('canvas-local.node'),
    path: 'skia.win32-x64-msvc.node',
  }
  const canvasPlatformCandidate = {
    kind: 'platform-package',
    priority: 2,
    status: 'present',
    packageName: canvasPlatform.packageName,
    packageLocation: canvasPlatform.packageLocation,
    payloadIdentity: canvasPlatform.identity,
  }
  const canvas = withIdentity({
    algorithm: 'napi-rs-canvas-native-loader-win32-priority-v1',
    resolverParent: 'electron/projectPreviewProviders.ts',
    canvas: canvasPackage,
    carrier: { path: 'node_modules/@napi-rs/canvas/js-binding.js', ...canvasCarrierProof },
    environmentDecision: {
      NAPI_RS_NATIVE_LIBRARY_PATH: 'required-unset',
      NAPI_RS_FORCE_WASI: 'required-unset',
      NODE_PATH: 'required-unset',
      DISABLE_SYSTEM_FONTS_LOAD: 'required-1',
    },
    runtimePlatform: 'win32-x64-msvc',
    candidates: [{ kind: 'local-native', priority: 1, ...canvasAbsence }, canvasPlatformCandidate],
    selected: {
      kind: 'platform-package',
      priority: 2,
      payloadIdentity: canvasPlatform.identity,
    },
    wasiFallbackCandidates: [
      { kind: 'local-wasi', priority: 1, ...absence('skia.wasi.cjs'), path: 'skia.wasi.cjs' },
      {
        kind: 'external-wasi-package',
        priority: 2,
        status: 'absent',
        packageName: '@napi-rs/canvas-wasm32-wasi',
        searchPathProofs: [absence('canvas-wasi-package')],
      },
    ],
    platformPackage: canvasPlatform,
    icuDecision: {
      algorithm: 'skia-windows-executable-then-native-directory-v1',
      candidates: [
        { kind: 'executable-directory-icu', priority: 1, ...absence('icudtl.dat') },
        {
          kind: 'native-library-directory-icu',
          priority: 2,
          status: 'present',
          packageLocation: canvasPlatform.packageLocation,
          path: 'icudtl.dat',
          ...canvasIcuProof,
        },
      ],
      selected: {
        kind: 'native-library-directory-icu',
        priority: 2,
        sha256: canvasIcuProof.sha256,
      },
    },
  })
  const resolverProcessEnvironment = {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH:
      'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;' +
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    ProgramFiles: 'C:\\Program Files',
    ProgramW6432: 'C:\\Program Files',
    NODE_OPTIONS: '',
    NODE_DISABLE_COMPILE_CACHE: '1',
    DISABLE_SYSTEM_FONTS_LOAD: '1',
  }
  return withIdentity({
    runtimeEnvironmentDecision: {
      NODE_OPTIONS: 'required-empty',
      NODE_PATH: 'required-unset',
      NODE_COMPILE_CACHE: 'required-unset',
      NODE_DISABLE_COMPILE_CACHE: 'required-1',
      DISABLE_SYSTEM_FONTS_LOAD: 'required-1',
      NODE_V8_COVERAGE: 'required-unset',
      NODE_DEBUG: 'required-unset',
      NODE_DEBUG_NATIVE: 'required-unset',
      NODE_REDIRECT_WARNINGS: 'required-unset',
      NODE_ICU_DATA: 'required-unset',
      NODE_EXTRA_CA_CERTS: 'required-unset',
      parentPreflight: {
        environmentRejectedKeys: [
          'node_compile_cache',
          'node_debug',
          'node_debug_native',
          'node_extra_ca_certs',
          'node_icu_data',
          'node_options',
          'node_path',
          'node_redirect_warnings',
          'node_v8_coverage',
        ],
        execArgv: [],
      },
      resolverProcessEnvironment,
    },
    onnxruntimeCommon: onnxCommonImport,
    mlRuntime,
    e2eTypeScript,
    canvas,
    sharpRuntime,
    sharp,
    sharpDependencies,
    sharpLoader,
    sharpPlatform,
  })
}

function withIdentity(value) {
  return { ...value, identity: fingerprint(value) }
}

function withoutIdentity(value) {
  const clone = { ...value }
  delete clone.identity
  return clone
}

function evidenceDataset() {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    path: `image-${String(index).padStart(4, '0')}.jpg`,
    size: 1,
    sha256: sha256(`dataset-${index}`),
  }))
  return withIdentity({
    schemaVersion: 1,
    selection: {
      algorithm: 'image-search-simple-e2e-bfs-localeCompare-first-v1',
      limit: 1000,
      extensions: [...IMAGE_EXTENSIONS],
      locale: 'en',
    },
    selectedImageCount: entries.length,
    supportedImageCount: entries.length,
    totalBytes: entries.length,
    entries,
  })
}

function evidenceEnvironment() {
  const executionClosure = executionClosureProof()
  const onnxruntimeNode = executionClosure.mlRuntime.onnxruntimeNodePackages[0]
  const transformers = executionClosure.mlRuntime.transformerPackages[0].package
  const systemRoot = 'C:\\Windows'
  const executionEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: `${systemRoot}\\System32\\cmd.exe`,
    PATH:
      `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem;` +
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    ProgramFiles: 'C:\\Program Files',
    ProgramW6432: 'C:\\Program Files',
  }
  const tool = (name, toolPath) => ({ path: toolPath, ...fileProof(`system-${name}`) })
  const systemTools = withIdentity({
    schemaVersion: 1,
    policy: 'fixed-windows-system32-v1',
    systemRoot,
    tools: {
      powershell: tool(
        'powershell',
        `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ),
      taskkill: tool('taskkill', `${systemRoot}\\System32\\taskkill.exe`),
      nvidiaSmi: tool('nvidia-smi', `${systemRoot}\\System32\\nvidia-smi.exe`),
      wmic: tool('wmic', `${systemRoot}\\System32\\Wbem\\WMIC.exe`),
      comSpec: tool('cmd', `${systemRoot}\\System32\\cmd.exe`),
    },
    executionEnvironment,
  })
  const modelDefinitions = [
    ['dinov2_vitb14', 'dino-fixture', 'dino'],
    ['clip_vit_base_patch32', 'clip-fixture', 'clip'],
  ].map(([name, version, label]) => {
    const files = [
      { role: 'primary', path: `${name}/model.onnx`, ...fileProof(`${label}-model`) },
      { role: 'required', path: `${name}/config.json`, ...fileProof(`${label}-config`) },
    ]
    return { name, version, files, identity: fingerprint(files) }
  })
  return withIdentity({
    node: {
      version: 'v99.0.0-fixture',
      modules: '999',
      napi: '6',
      executable: fileProof('node-executable'),
    },
    os: {
      platform: 'win32',
      arch: 'x64',
      type: 'Windows_NT',
      release: '1.0.0',
      version: 'Windows fixture 1.0.0',
    },
    hardwareSnapshot: {
      cpuModel: 'Fixture CPU',
      logicalProcessors: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    },
    locale: 'en',
    onnxruntimeNode,
    transformers,
    executionClosure,
    systemTools,
    models: withIdentity({
      manifestSchemaVersion: 2,
      manifest: fileProof('models-manifest'),
      manifestDescriptors: modelDefinitions.map(({ name, version, files }) => ({
        name,
        version,
        files: structuredClone(files),
      })),
      models: modelDefinitions,
    }),
    gpu: {
      source: 'win32-wmic+nvidia-smi',
      controllerProbe: {
        tool: 'wmic',
        args: [
          'path',
          'Win32_VideoController',
          'get',
          'Name,DriverVersion,PNPDeviceID,AdapterCompatibility',
          '/format:list',
        ],
        schema: ['AdapterCompatibility', 'DriverVersion', 'Name', 'PNPDeviceID'],
      },
      nvidiaProbe: {
        tool: 'nvidia-smi',
        args: [
          '--query-gpu=name,driver_version,uuid,pci.bus_id,memory.total',
          '--format=csv,noheader,nounits',
        ],
      },
      devices: [
        {
          name: 'Fixture GPU',
          driverVersion: '999.1',
          uuid: '',
          busId: '',
          deviceId: 'PCI\\VEN_FIXTURE',
          adapterCompatibility: 'Fixture Vendor',
        },
      ],
      nvidiaDevices: [
        {
          name: 'Fixture GPU',
          driverVersion: '999.1',
          uuid: 'GPU-fixture',
          busId: '0000:01:00.0',
          deviceId: '',
          adapterCompatibility: '',
          memoryTotalMiB: 4096,
        },
      ],
    },
  })
}

function evidenceImplementation() {
  const platform = sharpPlatformProof()
  const absence = (name) => ({
    status: 'absent',
    path: `dist/${name}`,
    missingAt: `dist/${name}`,
    parent: { path: 'dist', entryCount: 3, listingSha256: sha256(name) },
  })
  const children = ['embeddingPreparationChild', 'dinoEmbeddingChild', 'clipEmbeddingChild'].map(
    (name) => {
      const built = { path: `dist/${name}.js`, ...fileProof(`${name}-built`) }
      const externalSpecifiers = []
      if (name !== 'embeddingPreparationChild') {
        externalSpecifiers.push({
          importer: built.path,
          specifier: '@huggingface/transformers',
          packageName: '@huggingface/transformers',
        })
        externalSpecifiers.push({
          importer: built.path,
          specifier: '@img/sharp-libvips-dev/cplusplus',
          packageName: '@img/sharp-libvips-dev',
        })
        externalSpecifiers.push({
          importer: built.path,
          specifier: '@img/sharp-libvips-dev/include',
          packageName: '@img/sharp-libvips-dev',
        })
      }
      const closureCore = {
        entry: built.path,
        buildRoot: 'dist',
        fileCount: 1,
        totalBytes: built.size,
        files: [{ ...built }],
        externalSpecifiers,
      }
      return {
        name,
        source: { path: `electron/${name}.ts`, ...fileProof(`${name}-source`) },
        built,
        runtimeClosure: { ...closureCore, identity: fingerprint(closureCore) },
      }
    },
  )
  const contexts = children
    .filter((child) => child.name !== 'embeddingPreparationChild')
    .map((child) => {
      const candidates = [
        { kind: 'local-platform-native', priority: 1, ...absence(`${child.name}.node`) },
        { kind: 'local-wasm-native', priority: 2, ...absence(`${child.name}-wasm.node`) },
        {
          kind: 'platform-package',
          priority: 3,
          status: 'present',
          packageName: platform.packageName,
          packageLocation: platform.packageLocation,
          payloadIdentity: platform.identity,
        },
      ]
      return withIdentity({
        children: [child.name],
        carrier: child.built,
        runtimePlatform: 'fixture-x64',
        version: '1.0.0-fixture',
        candidates,
        selected: {
          kind: 'platform-package',
          priority: 3,
          payloadIdentity: platform.identity,
        },
        platformPackage: platform,
      })
    })
  const bundledSharpLoaders = withIdentity({
    algorithm: 'bundled-sharp-loader-contexts-v1',
    contexts,
  })
  const previewServiceProof = {
    path: 'electron/projectPreviewService.ts',
    ...fileProof('e2e-source'),
  }
  const previewProvidersProof = {
    path: 'electron/projectPreviewProviders.ts',
    ...fileProof('e2e-providers-source'),
  }
  const sourceClosure = withIdentity({
    algorithm: 'guard-utils-transpileModule-cjs-recursive-v1',
    roots: ['electron/projectPreviewService.ts'],
    limits: { maxFiles: 256, maxTotalBytes: 64 * 1024 * 1024 },
    fileCount: 2,
    totalBytes: previewServiceProof.size + previewProvidersProof.size,
    files: [previewProvidersProof, previewServiceProof],
    externalSpecifiers: [
      {
        importer: 'electron/projectPreviewProviders.ts',
        specifier: '@napi-rs/canvas',
        packageName: '@napi-rs/canvas',
      },
      {
        importer: 'electron/projectPreviewProviders.ts',
        specifier: 'pdfjs-dist/legacy/build/pdf.mjs',
        packageName: 'pdfjs-dist',
      },
      {
        importer: 'electron/projectPreviewService.ts',
        specifier: 'sharp',
        packageName: 'sharp',
      },
    ],
  })
  const e2eTypeScript = withIdentity({
    benchmark: { path: 'tests/image-search-simple-e2e-benchmark.cjs', ...fileProof('e2e') },
    guardUtils: { path: 'tests/guard-utils.cjs', ...fileProof('guard') },
    sourceClosure,
  })
  return withIdentity({
    sources: [fileProof('source-proof')],
    fastScanner: fileProof('fast-scanner'),
    children,
    bundledSharpLoaders,
    e2eTypeScript,
  })
}

const EVIDENCE_SECTIONS = {
  dataset: evidenceDataset(),
  environment: evidenceEnvironment(),
  implementation: evidenceImplementation(),
}

function rounded(value) {
  return Number(Number(value).toFixed(2))
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (ratio) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted.at(-1),
  }
}

function bindPerformanceProof(report) {
  const metric = (field) => summarize(report.rounds.map((round) => round[field]))
  report.metrics = {
    libraryReadyMs: metric('libraryReadyMs'),
    mainPeakRssMiB: metric('mainPeakRssMiB'),
    childPeakAggregateRssMiBApprox: metric('childPeakAggregateRssMiBApprox'),
    combinedPeakRssMiBApprox: metric('combinedPeakRssMiBApprox'),
    systemMinFreeMiB: metric('systemMinFreeMiB'),
  }
  report.metrics.libraryReadyMs.spreadPercent = Number(
    (
      ((report.metrics.libraryReadyMs.max - report.metrics.libraryReadyMs.min) /
        report.metrics.libraryReadyMs.p50) *
      100
    ).toFixed(2),
  )
  report.controlLimits = {
    libraryReadyP95Ms: rounded(report.metrics.libraryReadyMs.p95 * 1.1),
    mainPeakRssP95MiB: rounded(
      report.metrics.mainPeakRssMiB.p95 + Math.max(64, report.metrics.mainPeakRssMiB.p95 * 0.15),
    ),
    childPeakAggregateRssP95MiB: rounded(
      report.metrics.childPeakAggregateRssMiBApprox.p95 +
        Math.max(128, report.metrics.childPeakAggregateRssMiBApprox.p95 * 0.15),
    ),
    combinedPeakRssP95MiB: rounded(
      report.metrics.combinedPeakRssMiBApprox.p95 +
        Math.max(192, report.metrics.combinedPeakRssMiBApprox.p95 * 0.15),
    ),
    systemMinFreeFloorMiB: rounded(Math.max(256, report.metrics.systemMinFreeMiB.min * 0.75)),
    readySpreadPercent: 15,
  }
  if (report.evidence) report.evidence.controlLimits = { ...report.controlLimits }
}

function formalReport() {
  const config = {
    sample: 1000,
    runs: 3,
    pipeline: 'overlap',
    backend: 'gpu',
    jobs: 2,
    batchSize: 4,
    requestedScanWorkers: 2,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: 8 * 1024 * 1024,
    timelineMaxEvents: 50_000,
  }
  const userDataIdentity = 'a'.repeat(64)
  const hardwareCore = {
    platform: 'win32',
    release: '1.0.0',
    architecture: 'x64',
    cpuModel: 'Fixture CPU',
    logicalProcessors: 8,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    controllers: [
      {
        name: 'Fixture GPU',
        driverVersion: '999.1',
        deviceId: 'PCI\\VEN_FIXTURE',
        adapterCompatibility: 'Fixture Vendor',
      },
    ],
    gpus: [
      {
        uuid: 'GPU-fixture',
        name: 'Fixture GPU',
        memoryTotalMiB: 4096,
        driverVersion: '999.1',
        busId: '0000:01:00.0',
      },
    ],
  }
  const report = {
    schemaVersion: 1,
    kind: 'fixed-hardware-first-build-baseline',
    ok: true,
    status: 'passed',
    mode: 'establish',
    generatedAt: '2026-08-25T00:00:00.000Z',
    config,
    hardware: { ...hardwareCore, id: fingerprint(hardwareCore) },
    evidence: {
      schemaVersion: 1,
      kind: 'fixed-hardware-baseline-evidence',
      config: { ...config },
      ...structuredClone(EVIDENCE_SECTIONS),
    },
    software: { after: structuredClone(EVIDENCE_SECTIONS.implementation) },
    dataset: {
      identity: EVIDENCE_SECTIONS.dataset.identity,
      contentManifestSha256: EVIDENCE_SECTIONS.dataset.identity,
      selectedImageCount: 1000,
      unchanged: true,
    },
    safety: {
      realLibraryWritten: false,
      noBenchmarkChildrenAtEnd: true,
      realUserDataProof: {
        ok: true,
        changed: false,
        fail: false,
        beforeIdentity: userDataIdentity,
        afterIdentity: userDataIdentity,
      },
    },
    rounds: [1, 2, 3].map((round) => {
      const main = 100 + round
      const child = 200 + round
      return {
        round,
        runNonce: `round-nonce-${round}-${'x'.repeat(16)}`,
        tempDirectoryId: `fixed-round-temp-${round}`,
        startedAt: `2026-08-25T00:0${round}:00.000Z`,
        finishedAt: `2026-08-25T00:0${round}:30.000Z`,
        parentStartedAt: `2026-08-25T00:0${round}:00.000Z`,
        parentFinishedAt: `2026-08-25T00:0${round}:31.000Z`,
        libraryReadyMs: 100_000 + round * 500,
        totalMs: 110_000 + round * 500,
        mainPeakRssMiB: main,
        childPeakAggregateRssMiBApprox: child,
        combinedPeakRssMiBApprox: rounded(main + child),
        systemMinFreeMiB: 1000 - round * 10,
        nativeDigest: sha256('native'),
        dinoDigest: sha256('dino'),
        clipDigest: sha256('clip'),
        gpuPeakDeltaUsedMiB: null,
        reportSha256: sha256(`round-report-${round}`),
      }
    }),
    failures: [],
  }
  bindPerformanceProof(report)
  return report
}

function providerEvidence(model) {
  return {
    schemaVersion: 1,
    model,
    reports: 1,
    requestedBackends: ['gpu'],
    selectedProviders: ['dml'],
    fallbackDetected: false,
    reasons: ['directml-selected'],
  }
}

function writeRoundArtifacts(directory, name, report) {
  for (const round of report.rounds) {
    const effectiveProviders = {
      dino: providerEvidence('dino'),
      clip: providerEvidence('clip'),
    }
    const terminal = {
      runNonce: round.runNonce,
      pipeline: 'overlap',
      backend: 'gpu',
      tensorPrefetch: false,
      stage: 'complete',
      ok: true,
      libraryReadyMs: round.libraryReadyMs,
      totalMs: round.totalMs,
      schemaVersion: 1,
      timestamp: round.finishedAt,
      atMs: round.totalMs,
      event: 'benchmark-end',
    }
    const timelineBytes = Buffer.from(`${JSON.stringify(terminal)}\n`)
    const timeline = {
      bytes: timelineBytes.length,
      sha256: crypto.createHash('sha256').update(timelineBytes).digest('hex'),
      events: 1,
      terminal,
      truncated: false,
    }
    const run = {
      schemaVersion: 1,
      generatedAt: round.startedAt,
      execution: {
        runNonce: round.runNonce,
        startedAt: round.startedAt,
        finishedAt: round.finishedAt,
        durationMs: round.totalMs,
        tempDirectoryId: round.tempDirectoryId,
      },
      safety: {
        sourceDatasetReadOnly: true,
        isolatedUserData: true,
        tempDirectoryId: round.tempDirectoryId,
        sourceSnapshot: { count: 1000, totalBytes: 1000, sha256: sha256('source') },
        sourceUnchanged: true,
        noBenchmarkChildProcessesAtStop: true,
      },
      config: {
        imageCount: 1000,
        sourceImageCount: 1000,
        backend: 'gpu',
        pipeline: 'overlap',
        jobs: 2,
        batchSize: 4,
        requestedScanWorkers: 2,
        tensorPrefetch: false,
        deferThumbnails: true,
        verifyWarm: true,
        stageMetrics: true,
        timelineMaxBytes: 8 * 1024 * 1024,
        timelineMaxEvents: 50_000,
      },
      timeline: {
        enabled: true,
        maxBytes: 8 * 1024 * 1024,
        maxEvents: 50_000,
        bytesWritten: timeline.bytes,
        eventsWritten: timeline.events,
        truncated: false,
      },
      phases: { libraryReadyMs: round.libraryReadyMs, totalMs: round.totalMs },
      scan: {
        digest: { count: 1000, sha256: round.nativeDigest },
        progress: { scanWorkerCount: 2 },
      },
      vectorIndex: { status: { built: true, count: 1000 } },
      embeddingDigests: {
        dino: { count: 1000, stableSha256: round.dinoDigest },
        clip: { count: 1000, stableSha256: round.clipDigest },
      },
      providerEvidence: effectiveProviders,
      pipeline: { result: { commitFeedDropped: 0 } },
      warmVerification: { ok: true },
      resources: {
        sampling: {
          errors: 0,
          samples: 1,
          sampleCount: 1,
          failureCode: null,
          observedChildProcesses: 1,
          observedChildEvidence: {
            lifecycleTracked: 1,
            samplerObserved: 1,
            lifecycleAccounted: true,
          },
        },
        memory: {
          mainPeakRssMiB: round.mainPeakRssMiB,
          childPeakAggregateRssMiBApprox: round.childPeakAggregateRssMiBApprox,
          systemMinFreeMiB: round.systemMinFreeMiB,
        },
        processes: {
          spawned: 1,
          observedChildProcesses: 1,
          releasedChildProcesses: 1,
          activeAtStop: 0,
          noResidualAtStop: true,
          lifecycleAccounted: true,
          exitEvents: 1,
          errorEvents: 0,
        },
        gpu: { deviceCount: 1, totalMiB: 4096, peakDeltaUsedMiB: null },
      },
      ok: true,
    }
    const roundBytes = Buffer.from(`${JSON.stringify(run)}\n`)
    const reportName = `round-${round.round}.json`
    const timelineName = `round-${round.round}.timeline.ndjson`
    fs.writeFileSync(path.join(directory, reportName), roundBytes)
    fs.writeFileSync(path.join(directory, timelineName), timelineBytes)
    round.effectiveProviders = effectiveProviders
    round.reportSha256 = crypto.createHash('sha256').update(roundBytes).digest('hex')
    round.reportBytes = roundBytes.length
    round.reportFile = `${name}/${reportName}`
    round.timelineFile = `${name}/${timelineName}`
    round.timelineSha256 = timeline.sha256
    round.timelineBytes = timeline.bytes
    round.timeline = timeline
    round.sandbox = {
      schemaVersion: 1,
      environmentPolicy: 'minimal-allowlist-v1',
      rootId: `siftory-fixed-baseline-r${round.round}-${String(round.round).padStart(6, '0')}`,
      rootScope: 'exclusive-os-temp',
      rootPathOmitted: true,
      networkModelFetchDisabled: true,
      nodeOptionsCleared: true,
      nodeInheritedOverridesDropped: true,
      nodeCompileCacheDisabled: true,
      systemFontsDisabled: true,
      performanceOverridesCleared: true,
      effectiveEnvironment: {
        NODE_OPTIONS: '',
        NODE_PATH: null,
        NODE_COMPILE_CACHE: null,
        NODE_DISABLE_COMPILE_CACHE: '1',
        DISABLE_SYSTEM_FONTS_LOAD: '1',
        NODE_V8_COVERAGE: null,
        NODE_DEBUG: null,
        NODE_DEBUG_NATIVE: null,
        NODE_REDIRECT_WARNINGS: null,
        NODE_ICU_DATA: null,
        NODE_EXTRA_CA_CERTS: null,
        ProgramFiles: 'C:\\Program Files',
        ProgramW6432: 'C:\\Program Files',
      },
      fixedHarnessOverrides: { scanWorkers: 2, stageMetrics: true, tensorPrefetch: false },
    }
  }
}

function writePassingReport(managedRoot, name, mutate) {
  const directory = path.join(managedRoot, name)
  fs.mkdirSync(directory)
  const reportPath = path.join(directory, 'report.json')
  const report = formalReport()
  writeRoundArtifacts(directory, name, report)
  if (mutate) mutate(report)
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8')
  return reportPath
}

function writePromotionReport(managedRoot, name, previous, mutate) {
  const reportPath = writePassingReport(managedRoot, name)
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  report.mode = 'promote'
  report.comparison = {
    status: 'passed',
    baseline: previous.reportPath,
    failures: [],
  }
  report.promotion = {
    schemaVersion: 1,
    previousAcceptedAt: previous.pointer.acceptedAt,
    previousReportFile: previous.pointer.reportFile,
    previousReportSha256: previous.reportSha256,
  }
  report.formalPreflights = [1, 2, 3].map((round) => ({
    round,
    gpuBaseline: {
      schema: 'siftory-accepted-gpu-baseline/v1',
      usedMiB: 700,
      rounds: 3,
      reportSha256: previous.reportSha256,
    },
    snapshot: {
      power: { onAc: true },
      memory: {
        freePhysicalMemoryBytes: 8 * 1024 ** 3,
        committedBytes: 8 * 1024 ** 3,
        commitLimitBytes: 32 * 1024 ** 3,
      },
      residualProductProcesses: 0,
      gpu: { usedMiB: 700 },
      quietWindow: {
        durationMs: 600_000,
        cpuP95Percent: 1,
        diskP95Percent: 1,
        gpuP95Percent: 1,
      },
    },
    evaluation: {
      status: 'passed',
      formal: true,
      failures: [],
      incomplete: [],
      controls: { quietWindowMs: 600_000 },
      observed: {
        freePhysicalMemoryBytes: 8 * 1024 ** 3,
        commitRatio: 0.25,
        gpuInitialUsedMiB: 700,
        gpuBaselineUsedMiB: 700,
      },
    },
  }))
  mutate?.(report)
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return reportPath
}

function mutateReport(reportPath, mutate) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  mutate(report)
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8')
}

function mutateRawRoundAndRebind(reportPath, roundIndex, mutate) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const managedRoot = path.dirname(path.dirname(reportPath))
  const round = report.rounds[roundIndex]
  const rawPath = path.join(managedRoot, ...round.reportFile.split('/'))
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
  mutate(raw, round, report)
  const bytes = Buffer.from(`${JSON.stringify(raw)}\n`)
  fs.writeFileSync(rawPath, bytes)
  round.reportBytes = bytes.length
  round.reportSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8')
}

test('managed workspace is exclusively created and its root lock releases in finally', async (t) => {
  const { managedRoot, dataset } = sandbox(t)
  const outputDirectory = path.join(managedRoot, 'run-1')
  await assert.rejects(
    withManagedRunWorkspace({ managedRoot, dataset, outputDirectory }, async (workspace) => {
      assert.equal(fs.realpathSync(workspace.outputDirectory), fs.realpathSync(outputDirectory))
      assert.equal(fs.existsSync(path.join(managedRoot, LOCK_FILE_NAME)), true)
      throw new Error('candidate failed')
    }),
    /candidate failed/,
  )
  assert.equal(fs.existsSync(path.join(managedRoot, LOCK_FILE_NAME)), false)
  assert.equal(fs.existsSync(outputDirectory), true)
})

test('canonical validation rejects root escape, dataset overlap, and junction escape', (t) => {
  const { root, managedRoot, dataset } = sandbox(t)
  assert.throws(
    () =>
      validateManagedRunPaths({
        managedRoot,
        dataset,
        outputDirectory: path.join(root, 'outside-run'),
      }),
    (error) => error.code === 'OUTPUT_ESCAPED_ROOT',
  )

  const nestedDataset = path.join(managedRoot, 'nested-dataset')
  fs.mkdirSync(nestedDataset)
  assert.throws(
    () =>
      validateManagedRunPaths({
        managedRoot,
        dataset: nestedDataset,
        outputDirectory: path.join(nestedDataset, 'run'),
      }),
    (error) => error.code === 'DATASET_OUTPUT_OVERLAP',
  )

  const outsideTarget = path.join(root, 'junction-target')
  const junction = path.join(managedRoot, 'escaped-junction')
  fs.mkdirSync(outsideTarget)
  fs.symlinkSync(outsideTarget, junction, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(
    () =>
      validateManagedRunPaths({
        managedRoot,
        dataset,
        outputDirectory: path.join(junction, 'run'),
      }),
    (error) => error.code === 'OUTPUT_ESCAPED_ROOT',
  )
})

test('existing or non-empty output is rejected and does not strand the lock', (t) => {
  const { managedRoot, dataset } = sandbox(t)
  const outputDirectory = path.join(managedRoot, 'existing-run')
  fs.mkdirSync(outputDirectory)
  fs.writeFileSync(path.join(outputDirectory, 'stale.json'), '{}\n', 'utf8')
  assert.throws(
    () => acquireManagedRunWorkspace({ managedRoot, dataset, outputDirectory }),
    (error) => error.code === 'OUTPUT_NOT_FRESH',
  )
  assert.equal(fs.existsSync(path.join(managedRoot, LOCK_FILE_NAME)), false)
  assert.equal(fs.existsSync(path.join(outputDirectory, 'stale.json')), true)

  const emptyOutput = path.join(managedRoot, 'existing-empty-run')
  fs.mkdirSync(emptyOutput)
  assert.throws(
    () => acquireManagedRunWorkspace({ managedRoot, dataset, outputDirectory: emptyOutput }),
    (error) => error.code === 'OUTPUT_NOT_FRESH',
  )
  assert.equal(fs.existsSync(path.join(managedRoot, LOCK_FILE_NAME)), false)
})

test('root lock rejects concurrent outputs before creating the second directory', (t) => {
  const { managedRoot, dataset } = sandbox(t)
  const first = acquireManagedRunWorkspace({
    managedRoot,
    dataset,
    outputDirectory: path.join(managedRoot, 'run-1'),
  })
  const secondOutput = path.join(managedRoot, 'run-2')
  assert.throws(
    () => acquireManagedRunWorkspace({ managedRoot, dataset, outputDirectory: secondOutput }),
    (error) => error.code === 'LOCK_CONFLICT',
  )
  assert.equal(fs.existsSync(secondOutput), false)
  assert.equal(first.release(), true)
  assert.equal(first.release(), false)

  const second = acquireManagedRunWorkspace({ managedRoot, dataset, outputDirectory: secondOutput })
  assert.equal(second.release(), true)
})

test('explicit establish creates the first accepted pointer and compare resolves it', (t) => {
  const { managedRoot } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  const initial = resolveAcceptedBaseline({ managedRoot, mode: 'establish' })
  assert.equal(initial.reportPath, null)

  const committed = commitAcceptedBaseline({
    managedRoot,
    mode: 'establish',
    reportPath,
    now: new Date('2026-08-25T01:02:03.000Z'),
  })
  assert.equal(fs.existsSync(path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)), true)
  assert.equal(committed.pointer.acceptedAt, '2026-08-25T01:02:03.000Z')
  assert.match(committed.pointer.reportSha256, /^[a-f0-9]{64}$/)

  const comparison = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  assert.equal(fs.realpathSync(comparison.reportPath), fs.realpathSync(reportPath))
  assert.equal(comparison.report.ok, true)
})

test('fresh compare plan reads an accepted pointer without a circular dependency', (t) => {
  const { managedRoot, dataset } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
  const outputDirectory = path.join(managedRoot, 'fresh-compare-plan')
  const runnerPath = path.resolve(
    __dirname,
    '..',
    'scripts',
    'run-fixed-hardware-performance-baseline.cjs',
  )
  const childScript = `
    const { runMain } = require(${JSON.stringify(runnerPath)});
    runMain({
      argv: [
        '--plan',
        ${JSON.stringify(`--dataset=${dataset}`)},
        ${JSON.stringify(`--output-dir=${outputDirectory}`)},
      ],
      baselineRoot: ${JSON.stringify(managedRoot)},
      environment: {},
      execArgv: [],
    }).catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
  `
  const result = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'compare')
  assert.equal(fs.realpathSync(plan.acceptedReport), fs.realpathSync(reportPath))
  assert.equal(plan.writesArtifacts, false)
  assert.equal(fs.existsSync(outputDirectory), false)
})

test('a second establish is rejected and never overwrites the accepted pointer', (t) => {
  const { managedRoot } = sandbox(t)
  const firstReport = writePassingReport(managedRoot, 'first-run')
  const secondReport = writePassingReport(managedRoot, 'second-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: firstReport })
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  const before = fs.readFileSync(pointerPath, 'utf8')

  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'establish' }),
    (error) => error.code === 'ACCEPTED_POINTER_EXISTS',
  )
  assert.throws(
    () => commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: secondReport }),
    (error) => error.code === 'ACCEPTED_POINTER_EXISTS',
  )
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), before)
})

test('compare requires an accepted pointer', (t) => {
  const { managedRoot } = sandbox(t)
  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'ACCEPTED_BASELINE_REQUIRED',
  )
})

test('successful compare is read-only and cannot roll the accepted pointer', (t) => {
  const { managedRoot } = sandbox(t)
  const acceptedReport = writePassingReport(managedRoot, 'accepted-run')
  const candidateReport = writePassingReport(managedRoot, 'candidate-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: acceptedReport })
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  const before = fs.readFileSync(pointerPath, 'utf8')

  const comparison = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  assert.equal(comparison.report.ok, true)
  assert.throws(
    () =>
      commitAcceptedBaseline({
        managedRoot,
        mode: 'compare',
        reportPath: candidateReport,
      }),
    (error) => error.code === 'COMPARE_IS_READ_ONLY',
  )
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), before)
  assert.equal(
    fs.realpathSync(resolveAcceptedBaseline({ managedRoot, mode: 'compare' }).reportPath),
    fs.realpathSync(acceptedReport),
  )
})

test('explicit promotion atomically advances the pointer and preserves the previous report chain', (t) => {
  const { managedRoot } = sandbox(t)
  const firstReport = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({
    managedRoot,
    mode: 'establish',
    reportPath: firstReport,
    now: new Date('2026-08-25T01:02:03.000Z'),
  })
  const previous = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  const promotedReport = writePromotionReport(managedRoot, 'promoted-run', previous)
  const promoted = commitPromotedBaseline({
    managedRoot,
    reportPath: promotedReport,
    expectedPreviousReportSha256: previous.reportSha256,
    now: new Date('2026-08-26T01:02:03.000Z'),
  })
  assert.equal(promoted.pointer.sequence, 2)
  assert.deepEqual(promoted.pointer.previous, {
    acceptedAt: previous.pointer.acceptedAt,
    reportFile: previous.pointer.reportFile,
    reportSha256: previous.reportSha256,
  })
  const current = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  assert.equal(fs.realpathSync(current.reportPath), fs.realpathSync(promotedReport))
  assert.equal(current.report.mode, 'promote')
  assert.equal(fs.existsSync(firstReport), true)
})

test('promotion refuses a changed accepted pointer and leaves the current pointer byte-identical', (t) => {
  const { managedRoot } = sandbox(t)
  const firstReport = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: firstReport })
  const previous = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  const promotedReport = writePromotionReport(managedRoot, 'promoted-run', previous)
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  const before = fs.readFileSync(pointerPath)
  assert.throws(
    () =>
      commitPromotedBaseline({
        managedRoot,
        reportPath: promotedReport,
        expectedPreviousReportSha256: 'f'.repeat(64),
      }),
    (error) => error.code === 'PROMOTION_BASELINE_CHANGED',
  )
  assert.deepEqual(fs.readFileSync(pointerPath), before)
})

test('promoted pointer rejects a detached or altered previous-report chain', (t) => {
  const { managedRoot } = sandbox(t)
  const firstReport = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: firstReport })
  const previous = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  const promotedReport = writePromotionReport(managedRoot, 'promoted-run', previous)
  commitPromotedBaseline({
    managedRoot,
    reportPath: promotedReport,
    expectedPreviousReportSha256: previous.reportSha256,
  })
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
  pointer.previous.reportSha256 = 'f'.repeat(64)
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`)
  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'INVALID_ACCEPTED_POINTER',
  )
})

test('promotion fails closed when provenance is missing or a control limit is loosened', (t) => {
  const { managedRoot } = sandbox(t)
  const firstReport = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: firstReport })
  const previous = resolveAcceptedBaseline({ managedRoot, mode: 'compare' })
  const missingProvenance = writePromotionReport(
    managedRoot,
    'missing-provenance',
    previous,
    (report) => delete report.promotion,
  )
  assert.throws(
    () =>
      commitPromotedBaseline({
        managedRoot,
        reportPath: missingProvenance,
        expectedPreviousReportSha256: previous.reportSha256,
      }),
    /promotion provenance/,
  )
  const loosened = writePromotionReport(managedRoot, 'loosened', previous, (report) => {
    report.rounds.forEach((round) => {
      round.libraryReadyMs -= 1000
      round.totalMs -= 1000
    })
    bindPerformanceProof(report)
    report.controlLimits.libraryReadyP95Ms = previous.report.controlLimits.libraryReadyP95Ms + 1
    report.evidence.controlLimits.libraryReadyP95Ms = report.controlLimits.libraryReadyP95Ms
  })
  assert.throws(
    () =>
      commitPromotedBaseline({
        managedRoot,
        reportPath: loosened,
        expectedPreviousReportSha256: previous.reportSha256,
      }),
    /controlLimits must be derived|cannot loosen/,
  )
  const shortPreflight = writePromotionReport(
    managedRoot,
    'short-preflight',
    previous,
    (report) => {
      report.formalPreflights[1].snapshot.quietWindow.durationMs = 599_999
    },
  )
  assert.throws(
    () =>
      commitPromotedBaseline({
        managedRoot,
        reportPath: shortPreflight,
        expectedPreviousReportSha256: previous.reportSha256,
      }),
    /formal environment gate/,
  )
})

test('commit rejects every non-formal passing report shape', (t) => {
  const { managedRoot } = sandbox(t)
  const invalidReports = [
    ['diagnostic-mode', (report) => (report.mode = 'diagnostic')],
    ['small-sample', (report) => (report.config.sample = 64)],
    ['wrong-runs', (report) => (report.config.runs = 2)],
    ['serial-pipeline', (report) => (report.config.pipeline = 'serial')],
    ['missing-control', (report) => delete report.controlLimits.libraryReadyP95Ms],
    ['zero-control', (report) => (report.controlLimits.systemMinFreeFloorMiB = 0)],
    ['missing-evidence', (report) => delete report.evidence],
    ['shallow-evidence', (report) => delete report.evidence.environment],
    [
      'stale-evidence-identity',
      (report) => (report.evidence.environment.gpu.devices[0].name = 'Forged GPU'),
    ],
    ['wrong-evidence-schema', (report) => (report.evidence.schemaVersion = 2)],
    ['wrong-evidence-kind', (report) => (report.evidence.kind = 'diagnostic-evidence')],
    ['different-evidence-config', (report) => (report.evidence.config.jobs = 1)],
    [
      'different-evidence-control',
      (report) => (report.evidence.controlLimits.libraryReadyP95Ms += 1),
    ],
    ['changed-dataset', (report) => (report.dataset.unchanged = false)],
    ['real-library-written', (report) => (report.safety.realLibraryWritten = true)],
    ['child-left-running', (report) => (report.safety.noBenchmarkChildrenAtEnd = false)],
    ['missing-user-data-proof', (report) => delete report.safety.realUserDataProof],
    ['duplicate-round-nonce', (report) => (report.rounds[2].runNonce = report.rounds[1].runNonce)],
    [
      'duplicate-round-temp',
      (report) => (report.rounds[2].tempDirectoryId = report.rounds[1].tempDirectoryId),
    ],
    [
      'duplicate-outer-sandbox',
      (report) => (report.rounds[2].sandbox.rootId = report.rounds[1].sandbox.rootId),
    ],
    [
      'duplicate-round-report',
      (report) => (report.rounds[2].reportSha256 = report.rounds[1].reportSha256),
    ],
    ['missing-parent-start', (report) => delete report.rounds[0].parentStartedAt],
    [
      'nonconsecutive-parent-time',
      (report) => (report.rounds[1].parentStartedAt = report.rounds[0].parentStartedAt),
    ],
    ['unbound-report-bytes', (report) => (report.rounds[0].reportBytes += 1)],
    ['unbound-timeline-bytes', (report) => (report.rounds[0].timelineBytes += 1)],
    ['unbound-gpu-delta', (report) => (report.rounds[0].gpuPeakDeltaUsedMiB = 1)],
    [
      'prefixed-artifact-declaration',
      (report) => (report.rounds[0].reportFile = `forged/${report.rounds[0].reportFile}`),
    ],
    [
      'inherited-node-debug',
      (report) => (report.rounds[0].sandbox.effectiveEnvironment.NODE_DEBUG = 'module'),
    ],
    [
      'reidentified-hardware-controller',
      (report) => {
        report.hardware.controllers[0].driverVersion = 'forged'
        const core = { ...report.hardware }
        delete core.id
        report.hardware.id = fingerprint(core)
      },
    ],
    [
      'reidentified-duplicate-nvidia-device',
      (report) => {
        report.evidence.environment.gpu.nvidiaDevices.push(
          structuredClone(report.evidence.environment.gpu.nvidiaDevices[0]),
        )
        report.evidence.environment.identity = fingerprint(
          withoutIdentity(report.evidence.environment),
        )
        report.hardware.gpus.push(structuredClone(report.hardware.gpus[0]))
        const hardwareCore = { ...report.hardware }
        delete hardwareCore.id
        report.hardware.id = fingerprint(hardwareCore)
      },
    ],
    ['unbound-metrics', (report) => (report.metrics.libraryReadyMs.p95 += 1)],
    [
      'inflated-controls',
      (report) => {
        report.controlLimits.libraryReadyP95Ms += 1
        report.evidence.controlLimits.libraryReadyP95Ms += 1
      },
    ],
  ]

  for (const [name, mutate] of invalidReports) {
    const reportPath = writePassingReport(managedRoot, name, mutate)
    assert.throws(
      () => commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath }),
      (error) => error.code === 'INVALID_BASELINE_REPORT',
      name,
    )
    assert.equal(fs.existsSync(path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)), false)
  }
})

test('commit rejects rehashed raw round and timeline forgeries', (t) => {
  const { managedRoot } = sandbox(t)
  const rawCases = [
    ['raw-source-count', (run) => (run.config.sourceImageCount = 999)],
    ['raw-source-snapshot', (run) => (run.safety.sourceSnapshot.count = 999)],
    ['raw-sampling-count', (run) => (run.resources.sampling.sampleCount = 2)],
    ['raw-process-release', (run) => (run.resources.processes.releasedChildProcesses = 0)],
    ['raw-gpu-telemetry', (run) => (run.resources.gpu.totalMiB = 0)],
    [
      'raw-provider-fallback',
      (run, round) => {
        run.providerEvidence.dino.fallbackDetected = true
        round.effectiveProviders = structuredClone(run.providerEvidence)
      },
    ],
    ['raw-timeline-bound', (run) => (run.timeline.maxBytes -= 1)],
  ]
  for (const [name, mutate] of rawCases) {
    const reportPath = writePassingReport(managedRoot, name)
    mutateRawRoundAndRebind(reportPath, 0, mutate)
    assert.throws(
      () => commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath }),
      (error) => error.code === 'INVALID_BASELINE_REPORT',
      name,
    )
    assert.equal(fs.existsSync(path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)), false)
  }

  const timelineReportPath = writePassingReport(managedRoot, 'raw-timeline-terminal')
  const timelineReport = JSON.parse(fs.readFileSync(timelineReportPath, 'utf8'))
  const timelineRound = timelineReport.rounds[0]
  const timelinePath = path.join(managedRoot, ...timelineRound.timelineFile.split('/'))
  const terminal = JSON.parse(fs.readFileSync(timelinePath, 'utf8').trim())
  terminal.ok = false
  const timelineBytes = Buffer.from(`${JSON.stringify(terminal)}\n`)
  fs.writeFileSync(timelinePath, timelineBytes)
  timelineRound.timelineSha256 = crypto.createHash('sha256').update(timelineBytes).digest('hex')
  timelineRound.timelineBytes = timelineBytes.length
  timelineRound.timeline = {
    bytes: timelineBytes.length,
    sha256: timelineRound.timelineSha256,
    events: 1,
    terminal,
    truncated: false,
  }
  mutateRawRoundAndRebind(timelineReportPath, 0, (raw, reboundRound, reboundReport) => {
    Object.assign(reboundRound, timelineRound)
    raw.timeline.bytesWritten = timelineBytes.length
    reboundReport.rounds[0] = reboundRound
  })
  assert.throws(
    () =>
      commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: timelineReportPath }),
    (error) => error.code === 'INVALID_BASELINE_REPORT',
  )
})

test('accepted pointer refuses a report changed to diagnostic after commit', (t) => {
  const { managedRoot } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
  mutateReport(reportPath, (report) => {
    report.mode = 'diagnostic'
  })

  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'ACCEPTED_REPORT_HASH_MISMATCH',
  )
})

test('accepted pointer refuses a report whose evidence is removed after commit', (t) => {
  const { managedRoot } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
  mutateReport(reportPath, (report) => {
    delete report.evidence
  })

  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'ACCEPTED_REPORT_HASH_MISMATCH',
  )
})

test('accepted pointer binds the exact report bytes even when replacement is formally valid', (t) => {
  const { managedRoot } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
  mutateReport(reportPath, (report) => {
    for (const round of report.rounds) {
      round.libraryReadyMs += 1_000
      round.totalMs += 1_000
    }
    bindPerformanceProof(report)
  })

  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'ACCEPTED_REPORT_HASH_MISMATCH',
  )
})

test('accepted pointer schema requires a SHA-256 report digest', (t) => {
  const { managedRoot } = sandbox(t)
  const reportPath = writePassingReport(managedRoot, 'accepted-run')
  commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
  delete pointer.reportSha256
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer)}\n`, 'utf8')

  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'INVALID_ACCEPTED_POINTER',
  )
})

test('accepted pointer and report reads reject oversized files before parsing', (t) => {
  const { managedRoot } = sandbox(t)
  const pointerPath = path.join(managedRoot, ACCEPTED_POINTER_FILE_NAME)
  fs.writeFileSync(pointerPath, Buffer.alloc(MAX_ACCEPTED_POINTER_BYTES + 1, 0x20))
  assert.throws(
    () => resolveAcceptedBaseline({ managedRoot, mode: 'compare' }),
    (error) => error.code === 'FILE_TOO_LARGE',
  )

  fs.unlinkSync(pointerPath)
  const reportPath = writePassingReport(managedRoot, 'oversized-report')
  fs.truncateSync(reportPath, MAX_ACCEPTED_REPORT_BYTES + 1)
  assert.throws(
    () => commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath }),
    (error) => error.code === 'FILE_TOO_LARGE',
  )
  assert.equal(fs.existsSync(pointerPath), false)
})

test('stable JSON read hashes and parses the same exact bytes', (t) => {
  const { root } = sandbox(t)
  const filePath = path.join(root, 'stable.json')
  const bytes = Buffer.from('  {"value":42}\r\n', 'utf8')
  fs.writeFileSync(filePath, bytes)

  const result = readStableJsonFile(filePath, { label: 'stable fixture', maxBytes: 1024 })
  assert.deepEqual(result.value, { value: 42 })
  assert.deepEqual(result.bytes, bytes)
  assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
})

test('stable JSON read rejects metadata changed during the read window', (t) => {
  const { root } = sandbox(t)
  const filePath = path.join(root, 'racing.json')
  fs.writeFileSync(filePath, '{"value":42}\n', 'utf8')
  const before = fs.statSync(filePath)
  const changedTime = new Date(before.mtimeMs + 10_000)

  assert.throws(
    () =>
      readStableJsonFile(filePath, {
        label: 'racing fixture',
        maxBytes: 1024,
        afterRead: () => fs.utimesSync(filePath, changedTime, changedTime),
      }),
    (error) => error.code === 'FILE_CHANGED_DURING_READ',
  )
})

test('accepted report must be a passing regular file inside the managed root', (t) => {
  const { root, managedRoot } = sandbox(t)
  const outsideReport = path.join(root, 'outside-report.json')
  fs.writeFileSync(
    outsideReport,
    `${JSON.stringify({ schemaVersion: 1, kind: 'fixed-hardware-first-build-baseline', ok: true })}\n`,
    'utf8',
  )
  assert.throws(
    () => commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath: outsideReport }),
    (error) => error.code === 'BASELINE_ESCAPED_ROOT',
  )
})
