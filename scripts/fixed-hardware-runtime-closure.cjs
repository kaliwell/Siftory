'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { builtinModules } = require('node:module')
const { fileURLToPath } = require('node:url')

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name.slice(5) : `node:${name}`]),
)
const DEFAULT_MAX_TS_FILES = 256
const DEFAULT_MAX_TS_BYTES = 64 * 1024 * 1024

function createRuntimeClosureTools(api) {
  const {
    assertPlainRoot,
    assertSafePathChain,
    assertSameStat,
    canonicalJson,
    choosePackageRuntimeDirectory,
    collectBoundedRuntimeManifest,
    collectOnnxRuntimeFromResolvedContext,
    fail,
    fileRevision,
    fingerprint,
    hashStableFile,
    isPathInside,
    maxPackageRuntimeBytes,
    maxPackageRuntimeDirectories,
    maxPackageRuntimeFiles,
    normalizePackageRuntimeLimits,
    normalizedRelativePath,
    readDirectoryEntriesBounded,
    readStableFileDescriptor,
    readStableJson,
    samePath,
  } = api

  function extractLiteralModuleSpecifiers(bytes) {
    const source = bytes.toString('utf8')
    const specifiers = new Set()
    for (const pattern of [
      /\b(?:require|import)\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
      /\b(?:from|import)\s*(['"])([^'"\r\n]+)\1/g,
    ]) {
      for (const match of source.matchAll(pattern)) specifiers.add(match[2])
    }
    return [...specifiers].sort((left, right) => left.localeCompare(right))
  }

  function packageNameFromSpecifier(specifier, label = 'runtime') {
    if (
      !specifier ||
      specifier.startsWith('.') ||
      path.isAbsolute(specifier) ||
      BUILTIN_MODULES.has(specifier) ||
      BUILTIN_MODULES.has(specifier.replace(/^node:/, ''))
    ) {
      return null
    }
    const parts = specifier.split('/')
    if (specifier.startsWith('@')) {
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        fail('runtime-dependency', `${label} contains an invalid scoped module specifier`)
      }
      return parts.slice(0, 2).join('/')
    }
    return parts[0]
  }

  async function findPackageContextFromResolved(packageName, resolvedEntry, options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const entryPath = path.resolve(resolvedEntry)
    if (!isPathInside(repoRoot, entryPath, false)) {
      fail('path-escape', `${packageName} resolved outside the repository dependency root`)
    }
    let directory = path.dirname(entryPath)
    while (isPathInside(repoRoot, directory, true)) {
      const manifestPath = path.join(directory, 'package.json')
      if (fs.existsSync(manifestPath)) {
        const packageRoot = assertPlainRoot(directory, `${packageName} resolved package root`)
        const packageManifest = await readStableJson(path.join(packageRoot, 'package.json'), {
          root: packageRoot,
          label: `${packageName} resolved package manifest`,
        })
        if (packageManifest.value?.name === packageName) {
          return { packageRoot, packageManifest }
        }
      }
      const parent = path.dirname(directory)
      if (samePath(parent, directory)) break
      directory = parent
    }
    fail('missing-package', `Cannot bind resolved package root: ${packageName}`)
  }

  async function collectResolvedRuntimePackageFromParent({
    packageName,
    moduleSpecifier = packageName,
    resolverParent,
    options,
    kind = 'require',
    resolution,
  }) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const parent = path.resolve(resolverParent)
    assertSafePathChain(repoRoot, parent, 'file', `${packageName} resolver parent`)
    let resolvedEntry
    try {
      if (kind === 'require' || kind === 'import') {
        const executable = path.resolve(
          options.moduleResolverExecutable || options.nodeExecutable || process.execPath,
        )
        const source = kind === 'import'
          ? "import {pathToFileURL} from 'node:url'; " +
            'console.log(import.meta.resolve(process.argv[2], pathToFileURL(process.argv[1]).href))'
          : "import {createRequire} from 'node:module'; " +
            'console.log(createRequire(process.argv[1]).resolve(process.argv[2]))'
        const result = spawnSync(
          executable,
          ['--input-type=module', '--eval', source, parent, moduleSpecifier],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10_000,
            windowsHide: true,
            maxBuffer: 64 * 1024,
            shell: false,
            env: options.runtimeResolverEnvironment,
          },
        )
        const lines = String(result.stdout || '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
        if (result.error || result.status !== 0 || lines.length !== 1) {
          throw new Error(
            String(result.error?.message || result.stderr || 'resolver produced no unique path').trim(),
          )
        }
        resolvedEntry = lines[0].startsWith('file:')
          ? fileURLToPath(lines[0])
          : path.resolve(lines[0])
      } else {
        fail('runtime-dependency', `Unsupported package resolution kind: ${kind}`)
      }
    } catch (error) {
      fail(
        'runtime-dependency-missing',
        `${packageName} cannot be resolved from ${normalizedRelativePath(repoRoot, parent)} via ` +
          `${moduleSpecifier} (${error.message})`,
      )
    }
    const context = await findPackageContextFromResolved(packageName, resolvedEntry, options)
    const version = context.packageManifest.value?.version
    if (typeof version !== 'string' || !version) {
      fail('package-version', `${packageName} version is missing`)
    }
    const resolvedKind = kind === 'import' ? 'import' : 'require'
    const resolutionLabel =
      resolution ||
      (kind === 'import'
        ? 'node-import-meta-resolve-from-explicit-parent'
        : 'node-create-require-resolve-from-explicit-parent')
    const resolvedEntries = {
      [resolvedKind]: { resolved: resolvedEntry, resolution: resolutionLabel },
    }
    const entries = {
      [resolvedKind]: {
        resolution: resolutionLabel,
        resolvedFrom: normalizedRelativePath(repoRoot, parent),
        ...(await fileRevision(context.packageRoot, resolvedEntry, `${packageName} resolved entry`)),
      },
    }
    const runtimeDirectory = choosePackageRuntimeDirectory(
      packageName,
      context.packageRoot,
      context.packageManifest.value,
      resolvedEntries,
      options,
    )
    const runtime = await collectBoundedRuntimeManifest(
      packageName,
      context.packageRoot,
      runtimeDirectory,
      normalizePackageRuntimeLimits(options, packageName),
    )
    const contentIdentity = fingerprint({
      packageName,
      version,
      packageLocation: normalizedRelativePath(repoRoot, context.packageRoot),
      packageManifest: context.packageManifest.proof,
      entry: {
        kind: resolvedKind,
        path: entries[resolvedKind].path,
        size: entries[resolvedKind].size,
        sha256: entries[resolvedKind].sha256,
      },
      runtime,
    })
    const core = {
      packageName,
      version,
      packageLocation: normalizedRelativePath(repoRoot, context.packageRoot),
      packageManifest: context.packageManifest.proof,
      entries,
      runtime,
      contentIdentity,
    }
    return {
      packageRoot: context.packageRoot,
      packageManifestValue: context.packageManifest.value,
      resolvedEntry,
      fingerprint: { ...core, identity: fingerprint(core) },
    }
  }

  async function recaptureRuntimePackage(context, options, label) {
    const runtime = context.fingerprint.runtime
    const directory =
      runtime.directory === '.'
        ? context.packageRoot
        : path.resolve(context.packageRoot, ...runtime.directory.split('/'))
    const after = await collectBoundedRuntimeManifest(
      context.fingerprint.packageName,
      context.packageRoot,
      directory,
      runtime.limits,
    )
    if (canonicalJson(after) !== canonicalJson(runtime)) {
      fail('file-mutated', `${label} runtime changed during closure collection`)
    }
  }

  async function discoverSharpRuntimeDependencies(sharpContext, options) {
    const sharp = sharpContext.fingerprint
    const sharpRoot = sharpContext.packageRoot
    const sharpRequireEntry = sharpContext.resolvedEntry
    const staticSpecifiers = []
    for (const file of sharp.runtime.files) {
      if (!/\.(?:c?js|mjs)$/i.test(file.path)) continue
      const captured = await readStableFileDescriptor(path.resolve(sharpRoot, file.path), {
        root: sharpRoot,
        label: 'Sharp runtime dependency discovery file',
        collectBytes: true,
        maxBytes: file.size,
      })
      if (captured.proof.size !== file.size || captured.proof.sha256 !== file.sha256) {
        fail('file-mutated', 'Sharp runtime changed between manifest and dependency discovery')
      }
      for (const specifier of extractLiteralModuleSpecifiers(captured.bytes)) {
        const packageName = packageNameFromSpecifier(specifier, 'Sharp runtime')
        if (packageName) staticSpecifiers.push({ file: file.path, specifier, packageName })
      }
    }
    staticSpecifiers.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    const declared = Object.keys(sharpContext.packageManifestValue?.dependencies || {}).sort(
      (left, right) => left.localeCompare(right),
    )
    const packageNames = new Set(declared)
    for (const discovered of staticSpecifiers) {
      if (discovered.packageName.startsWith('@img/sharp-')) continue
      packageNames.add(discovered.packageName)
    }
    const packages = []
    for (const packageName of [...packageNames].sort((left, right) => left.localeCompare(right))) {
      packages.push(
        (
          await collectResolvedRuntimePackageFromParent({
            packageName,
            resolverParent: sharpRequireEntry,
            options,
            resolution: 'node-create-require-resolve-from-sharp-entry',
          })
        ).fingerprint,
      )
    }
    await recaptureRuntimePackage(sharpContext, options, 'Sharp')
    const discovery = {
      algorithm: 'sharp-declared-plus-static-literal-dependencies-v2',
      declared,
      staticSpecifiers,
      resolvedPackageNames: packages.map((dependency) => dependency.packageName),
    }
    const core = { discovery, packages }
    return { ...core, identity: fingerprint(core) }
  }

  function selectedSharpPlatformPackage(options) {
    if (options.sharpPlatformPackage) return String(options.sharpPlatformPackage)
    const platform = options.platform || process.platform
    const arch = options.arch || process.arch
    if (platform === 'win32') return `@img/sharp-win32-${arch}`
    if (platform === 'darwin') return `@img/sharp-darwin-${arch}`
    if (platform === 'linux') {
      const report = process.report?.getReport?.()
      const libc = options.libc || (report?.header?.glibcVersionRuntime ? 'glibc' : 'musl')
      return `@img/sharp-${libc === 'musl' ? 'linuxmusl' : 'linux'}-${arch}`
    }
    fail('sharp-platform', `Unsupported Sharp platform fingerprint: ${platform}-${arch}`)
  }

  function sharpRuntimePlatform(options) {
    const packageName = selectedSharpPlatformPackage(options)
    const runtimePlatform = packageName.replace(/^@img\/sharp-/, '')
    if (!runtimePlatform || !/^[a-z0-9-]+$/.test(runtimePlatform)) {
      fail('sharp-loader', 'Cannot derive the Sharp native runtime platform')
    }
    return runtimePlatform
  }

  async function collectStableDirectoryListingProof(root, directory, label) {
    const before = assertSafePathChain(root, directory, 'directory', label)
    const entries = await readDirectoryEntriesBounded(
      directory,
      maxPackageRuntimeFiles + maxPackageRuntimeDirectories,
      label,
    )
    const names = entries.map((entry) => entry.name)
    const after = assertSafePathChain(root, directory, 'directory', `${label} post-check`)
    assertSameStat(before, after, label)
    const namesAfter = (
      await readDirectoryEntriesBounded(directory, names.length, `${label} post-check`)
    ).map((entry) => entry.name)
    if (canonicalJson(namesAfter) !== canonicalJson(names)) {
      fail('file-mutated', `${label} listing changed while proving payload absence`)
    }
    return {
      path: samePath(root, directory) ? '.' : normalizedRelativePath(root, directory),
      entryCount: names.length,
      listingSha256: fingerprint(names),
    }
  }

  async function probeLocalPayload(root, candidatePath, label, expectedKind = 'file') {
    const candidate = path.resolve(candidatePath)
    if (!isPathInside(root, candidate, false)) {
      fail('path-escape', `${label} escaped its approved root`)
    }
    const relative = path.relative(root, candidate)
    let current = root
    for (const segment of relative.split(path.sep)) {
      const parent = current
      current = path.join(current, segment)
      let stats
      try {
        stats = fs.lstatSync(current, { bigint: true })
      } catch (error) {
        if (error.code !== 'ENOENT') fail('runtime-loader', `${label} probe failed: ${error.message}`)
        return {
          status: 'absent',
          path: normalizedRelativePath(root, candidate),
          missingAt: normalizedRelativePath(root, current),
          parent: await collectStableDirectoryListingProof(root, parent, `${label} absence parent`),
        }
      }
      if (stats.isSymbolicLink()) {
        fail('reparse-point', `${label} path contains a symlink or junction`)
      }
      const real = fs.realpathSync(current)
      if (!isPathInside(root, real, true)) {
        fail('path-escape', `${label} resolves outside its approved root`)
      }
      const isFinal = samePath(current, candidate)
      if (!isFinal && !stats.isDirectory()) {
        fail('runtime-loader', `${label} path has a non-directory ancestor`)
      }
      if (isFinal) {
        if (expectedKind === 'directory') {
          if (!stats.isDirectory()) fail('runtime-loader', `${label} must be a directory`)
          return { status: 'present-directory', path: normalizedRelativePath(root, candidate) }
        }
        if (!stats.isFile()) fail('runtime-loader', `${label} must be a regular file`)
        return {
          status: 'present',
          path: normalizedRelativePath(root, candidate),
          ...(await hashStableFile(candidate, {
            root,
            label,
            maxBytes: maxPackageRuntimeBytes,
          })),
        }
      }
    }
    fail('runtime-loader', `${label} probe did not reach a terminal state`)
  }

  function assertSharpPlatformPayload(packageName, runtime) {
    const paths = runtime?.runtime?.files?.map((file) => file.path) || []
    const entryPaths = Object.values(runtime?.entries || {}).map((entry) => entry.path)
    if (
      !paths.some((filePath) => /\.(?:c?js|mjs)$/i.test(filePath)) ||
      entryPaths.some((entryPath) => !paths.includes(entryPath))
    ) {
      fail('sharp-platform', `${packageName} runtime JS loader is missing`)
    }
    const nativePayloads = paths.filter((filePath) => /\.node$/i.test(filePath))
    if (nativePayloads.length !== 1) {
      fail('sharp-platform', `${packageName} must contain exactly one native .node payload`)
    }
    if (packageName.includes('-win32-')) {
      const dllPayloads = paths.filter((filePath) => /\.dll$/i.test(filePath))
      const libvipsAbiPayloads = dllPayloads.filter((filePath) =>
        /(?:^|\/)libvips-[0-9]+\.dll$/i.test(filePath),
      )
      const libvipsCppPayloads = dllPayloads.filter((filePath) =>
        /(?:^|\/)libvips-cpp-[0-9]+(?:\.[0-9]+)+\.dll$/i.test(filePath),
      )
      if (
        dllPayloads.length !== 2 ||
        libvipsAbiPayloads.length !== 1 ||
        libvipsCppPayloads.length !== 1
      ) {
        fail(
          'sharp-platform',
          `${packageName} must contain exactly one libvips ABI DLL and one libvips-cpp version DLL`,
        )
      }
    }
  }

  function resolvePackageLocalRuntimeFile(packageRoot, importer, specifier, runtimeFiles) {
    if (!specifier.startsWith('.')) return null
    const unresolved = path.resolve(path.dirname(importer), specifier)
    if (!isPathInside(packageRoot, unresolved, false)) {
      fail('path-escape', 'Package-local runtime reference escaped its package root')
    }
    const candidates = [
      unresolved,
      `${unresolved}.cjs`,
      `${unresolved}.mjs`,
      `${unresolved}.js`,
      path.join(unresolved, 'index.cjs'),
      path.join(unresolved, 'index.mjs'),
      path.join(unresolved, 'index.js'),
    ]
    return (
      candidates.find((candidate) =>
        runtimeFiles.has(normalizedRelativePath(packageRoot, candidate)),
      ) || null
    )
  }

  async function findSharpLoaderCarrier(sharpContext) {
    const runtimeFiles = new Map(
      sharpContext.fingerprint.runtime.files.map((file) => [file.path, file]),
    )
    const queue = [sharpContext.resolvedEntry]
    const queued = new Set(queue.map((filePath) => normalizedRelativePath(sharpContext.packageRoot, filePath)))
    const matches = []
    for (let index = 0; index < queue.length; index += 1) {
      const filePath = queue[index]
      const relative = normalizedRelativePath(sharpContext.packageRoot, filePath)
      const file = runtimeFiles.get(relative)
      if (!file || !/\.(?:c?js|mjs)$/i.test(file.path)) {
        fail('sharp-loader', `Sharp resolved entry closure is missing: ${relative}`)
      }
      const captured = await readStableFileDescriptor(filePath, {
        root: sharpContext.packageRoot,
        label: 'Sharp native loader reachable file',
        collectBytes: true,
        maxBytes: file.size,
      })
      if (captured.proof.size !== file.size || captured.proof.sha256 !== file.sha256) {
        fail('file-mutated', 'Sharp runtime changed during native loader discovery')
      }
      const source = captured.bytes.toString('utf8')
      if (
        source.includes('src/build/Release/sharp-') &&
        source.includes('src/build/Release/sharp-wasm32-') &&
        source.includes('@img/sharp-')
      ) {
        matches.push(filePath)
      }
      for (const specifier of extractLiteralModuleSpecifiers(captured.bytes)) {
        const resolved = resolvePackageLocalRuntimeFile(
          sharpContext.packageRoot,
          filePath,
          specifier,
          runtimeFiles,
        )
        if (!resolved) continue
        const key = normalizedRelativePath(sharpContext.packageRoot, resolved)
        if (!queued.has(key)) {
          queued.add(key)
          queue.push(resolved)
        }
      }
    }
    if (matches.length !== 1) {
      const entryKind = Object.keys(sharpContext.fingerprint.entries)[0] || 'unknown'
      fail(
        'sharp-loader',
        `Sharp ${entryKind} entry must reach exactly one native loader carrier, found ${matches.length}`,
      )
    }
    return matches[0]
  }

  async function collectSharpLoaderDecision(sharpContext, options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const carrier = await findSharpLoaderCarrier(sharpContext)
    const runtimePlatform = sharpRuntimePlatform(options)
    const version = sharpContext.fingerprint.version
    const localPlatform = {
      kind: 'local-platform-native',
      priority: 1,
      ...(await probeLocalPayload(
        repoRoot,
        path.resolve(
          path.dirname(carrier),
          '..',
          'src',
          'build',
          'Release',
          `sharp-${runtimePlatform}-${version}.node`,
        ),
        'Sharp local platform native candidate',
      )),
    }
    const localWasm = {
      kind: 'local-wasm-native',
      priority: 2,
      ...(await probeLocalPayload(
        repoRoot,
        path.resolve(
          path.dirname(carrier),
          '..',
          'src',
          'build',
          'Release',
          `sharp-wasm32-${version}.node`,
        ),
        'Sharp local WASM native candidate',
      )),
    }
    const platformName = selectedSharpPlatformPackage(options)
    const platformContext = await collectResolvedRuntimePackageFromParent({
      packageName: platformName,
      moduleSpecifier: `${platformName}/sharp.node`,
      resolverParent: carrier,
      options,
      resolution: 'node-create-require-resolve-from-sharp-loader',
    })
    assertSharpPlatformPayload(platformName, platformContext.fingerprint)
    const platform = {
      kind: 'platform-package',
      priority: 3,
      status: 'present',
      packageName: platformName,
      packageLocation: platformContext.fingerprint.packageLocation,
      payloadIdentity: platformContext.fingerprint.identity,
    }
    const candidates = [localPlatform, localWasm, platform]
    const selectedCandidate = candidates.find((candidate) => candidate.status === 'present')
    if (!selectedCandidate) fail('sharp-loader', 'Sharp native loader has no selected payload')
    const selected = {
      kind: selectedCandidate.kind,
      priority: selectedCandidate.priority,
      payloadIdentity: selectedCandidate.payloadIdentity || selectedCandidate.sha256,
    }
    const entryKind = Object.keys(sharpContext.fingerprint.entries)[0]
    const entry = sharpContext.fingerprint.entries[entryKind]
    const core = {
      algorithm: 'sharp-native-loader-win32-priority-v2',
      resolverKind: entryKind,
      resolverParent: entry.resolvedFrom,
      resolvedEntry: entry.path,
      carrier: await fileRevision(repoRoot, carrier, 'Sharp native loader carrier'),
      runtimePlatform,
      version,
      candidates,
      selected,
      platformPackage: platformContext.fingerprint,
    }
    return { ...core, identity: fingerprint(core) }
  }

  async function collectSharpPackageBundle(sharpContext, options) {
    const dependencies = await discoverSharpRuntimeDependencies(sharpContext, options)
    const loader = await collectSharpLoaderDecision(sharpContext, options)
    await recaptureRuntimePackage(sharpContext, options, 'Sharp')
    const core = {
      packageLocation: sharpContext.fingerprint.packageLocation,
      contentIdentity: sharpContext.fingerprint.contentIdentity,
      sharp: sharpContext.fingerprint,
      dependencies,
      platform: loader.platformPackage,
      loader,
    }
    return { ...core, identity: fingerprint(core) }
  }

  async function proveSpecifierInFile(repoRoot, filePath, specifier, label) {
    const captured = await readStableFileDescriptor(filePath, {
      root: repoRoot,
      label,
      collectBytes: true,
      maxBytes: maxPackageRuntimeBytes,
    })
    if (!extractLiteralModuleSpecifiers(captured.bytes).includes(specifier)) {
      fail('runtime-dependency', `${label} does not contain the expected ${specifier} import`)
    }
    return captured.proof
  }

  async function collectSharpResolutionClosure(options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const parents = options.sharpResolverParents || [
      {
        name: 'e2e-project-preview',
        path: path.join(repoRoot, 'electron', 'projectPreviewService.ts'),
        kind: 'require',
      },
      {
        name: 'transformers-node-runtime',
        path: options.transformersRequireEntry,
        kind: 'require',
      },
    ]
    const resolutions = []
    const packagesByLocation = new Map()
    for (const descriptor of parents) {
      if (!descriptor?.name || !descriptor.path) {
        fail('sharp-resolution', 'Sharp resolver parent descriptor is incomplete')
      }
      const parent = path.resolve(descriptor.path)
      await proveSpecifierInFile(repoRoot, parent, 'sharp', `${descriptor.name} Sharp resolver parent`)
      const context = await collectResolvedRuntimePackageFromParent({
        packageName: 'sharp',
        resolverParent: parent,
        options,
        kind: descriptor.kind || 'require',
        resolution:
          descriptor.kind === 'import'
            ? 'node-import-meta-resolve-from-sharp-importer'
            : 'node-create-require-resolve-from-sharp-importer',
      })
      const resolutionKind = descriptor.kind === 'import' ? 'import' : 'require'
      const packageKey =
        `${context.fingerprint.packageLocation}:${context.fingerprint.contentIdentity}:` +
        resolutionKind
      let packageBundle = packagesByLocation.get(packageKey)
      if (!packageBundle) {
        packageBundle = await collectSharpPackageBundle(context, options)
        packagesByLocation.set(packageKey, packageBundle)
      }
      const resolutionCore = {
        name: String(descriptor.name),
        resolverParent: normalizedRelativePath(repoRoot, parent),
        packageLocation: context.fingerprint.packageLocation,
        packageIdentity: context.fingerprint.contentIdentity,
        resolutionKind,
        resolvedEntry: context.fingerprint.entries[resolutionKind].path,
      }
      resolutions.push({ ...resolutionCore, identity: fingerprint(resolutionCore) })
    }
    resolutions.sort((left, right) => left.name.localeCompare(right.name))
    const packages = [...packagesByLocation.values()].sort((left, right) =>
      `${left.packageLocation}:${left.contentIdentity}`.localeCompare(
        `${right.packageLocation}:${right.contentIdentity}`,
      ),
    )
    const core = {
      algorithm: 'sharp-explicit-importer-resolution-v1',
      resolutions,
      packages,
    }
    return { ...core, identity: fingerprint(core) }
  }

  function extractLoadTsModuleRoots(bytes) {
    const roots = new Set()
    const source = bytes.toString('utf8')
    for (const match of source.matchAll(/\bloadTsModule\s*\(\s*(['"])([^'"\r\n]+\.ts)\1\s*\)/g)) {
      roots.add(match[2])
    }
    return [...roots].sort((left, right) => left.localeCompare(right))
  }

  function resolveGuardTsImport(repoRoot, importer, specifier) {
    const fromDirectory = path.dirname(importer)
    const candidates = [
      path.resolve(fromDirectory, `${specifier}.ts`),
      path.resolve(fromDirectory, specifier),
      path.resolve(fromDirectory, specifier, 'index.ts'),
      path.resolve(fromDirectory, '..', 'shared', `${path.basename(specifier)}.ts`),
    ]
    for (const candidate of candidates) {
      if (!isPathInside(repoRoot, candidate, false)) {
        fail('path-escape', 'TypeScript load closure candidate escaped the repository')
      }
      if (!fs.existsSync(candidate)) continue
      assertSafePathChain(repoRoot, candidate, 'file', 'TypeScript load closure dependency')
      return candidate
    }
    return null
  }

  async function collectE2eTypeScriptClosure(options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const benchmarkPath = path.resolve(
      options.e2eBenchmarkPath || path.join(repoRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs'),
    )
    const guardPath = path.resolve(
      options.guardUtilsPath || path.join(repoRoot, 'tests', 'guard-utils.cjs'),
    )
    const benchmark = await readStableFileDescriptor(benchmarkPath, {
      root: repoRoot,
      label: 'E2E benchmark loader source',
      collectBytes: true,
      maxBytes: maxPackageRuntimeBytes,
    })
    const guard = await readStableFileDescriptor(guardPath, {
      root: repoRoot,
      label: 'TypeScript guard loader source',
      collectBytes: true,
      maxBytes: maxPackageRuntimeBytes,
    })
    if (!extractLiteralModuleSpecifiers(guard.bytes).includes('typescript')) {
      fail('typescript-closure', 'guard-utils does not load TypeScript')
    }
    const transpilerContext = await collectResolvedRuntimePackageFromParent({
      packageName: 'typescript',
      resolverParent: guardPath,
      options,
      resolution: 'node-create-require-resolve-from-guard-utils',
    })
    let typescript
    try {
      typescript = require(transpilerContext.resolvedEntry)
    } catch (error) {
      fail('typescript-closure', `Resolved TypeScript runtime could not be loaded: ${error.message}`)
    }
    if (
      typeof typescript?.transpileModule !== 'function' ||
      !typescript.ModuleKind ||
      !typescript.ScriptTarget
    ) {
      fail('typescript-closure', 'Resolved TypeScript runtime lacks the guard-utils compiler API')
    }
    const roots = extractLoadTsModuleRoots(benchmark.bytes)
    if (roots.length === 0) fail('typescript-closure', 'E2E benchmark has no loadTsModule roots')
    const queue = roots.map((relativePath) => path.resolve(repoRoot, relativePath))
    const queued = new Set(queue.map((filePath) => filePath.toLowerCase()))
    const files = []
    const externals = []
    let totalBytes = 0
    const maxFiles = Number(options.maxTsClosureFiles || DEFAULT_MAX_TS_FILES)
    const maxBytes = Number(options.maxTsClosureBytes || DEFAULT_MAX_TS_BYTES)
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > DEFAULT_MAX_TS_FILES) {
      fail('typescript-closure-limit', 'TypeScript closure file limit is invalid')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_TS_BYTES) {
      fail('typescript-closure-limit', 'TypeScript closure byte limit is invalid')
    }
    for (let index = 0; index < queue.length; index += 1) {
      if (files.length + 1 > maxFiles) {
        fail('typescript-closure-limit', 'TypeScript closure exceeds its file hard limit')
      }
      const filePath = queue[index]
      assertSafePathChain(repoRoot, filePath, 'file', 'TypeScript closure source')
      const captured = await readStableFileDescriptor(filePath, {
        root: repoRoot,
        label: 'TypeScript closure source',
        collectBytes: true,
        maxBytes: maxBytes - totalBytes,
      })
      totalBytes += captured.proof.size
      if (totalBytes > maxBytes) {
        fail('typescript-closure-limit', 'TypeScript closure exceeds its byte hard limit')
      }
      let output
      try {
        output = typescript.transpileModule(captured.bytes.toString('utf8'), {
          compilerOptions: {
            module: typescript.ModuleKind.CommonJS,
            target: typescript.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: filePath,
        }).outputText
      } catch (error) {
        fail('typescript-closure', `TypeScript closure transpilation failed: ${error.message}`)
      }
      const imports = extractLiteralModuleSpecifiers(Buffer.from(output))
      for (const specifier of imports) {
        const local = resolveGuardTsImport(repoRoot, filePath, specifier)
        if (local) {
          const key = process.platform === 'win32' ? local.toLowerCase() : local
          if (!queued.has(key)) {
            queued.add(key)
            queue.push(local)
          }
          continue
        }
        const packageName = packageNameFromSpecifier(specifier, 'TypeScript closure')
        if (packageName) {
          externals.push({
            importer: normalizedRelativePath(repoRoot, filePath),
            specifier,
            packageName,
          })
        }
      }
      files.push({
        path: normalizedRelativePath(repoRoot, filePath),
        size: captured.proof.size,
        sha256: captured.proof.sha256,
      })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    externals.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    // These are literal imports in the emitted CommonJS, so type-only imports have
    // already disappeared. Electron is supplied by the host, Sharp and Canvas are
    // bound by their dedicated loader closures, and every other reachable package
    // must be resolved from the exact TypeScript importer below.
    const hostExternalPackages = new Set(options.e2eHostExternalPackages || ['electron'])
    const separatelyBoundPackages = new Set(['sharp', '@napi-rs/canvas'])
    const explicitRuntimePackageNames = new Set(
      options.e2eExplicitRuntimePackageNames || ['pdfjs-dist'],
    )
    const unexpectedExternal = externals.find(
      (descriptor) =>
        !hostExternalPackages.has(descriptor.packageName) &&
        !separatelyBoundPackages.has(descriptor.packageName) &&
        !explicitRuntimePackageNames.has(descriptor.packageName),
    )
    if (unexpectedExternal) {
      fail(
        'typescript-closure',
        `TypeScript closure has an unbound external package: ${unexpectedExternal.packageName}`,
      )
    }
    const exactExternalImporters = {
      sharp: normalizedRelativePath(
        repoRoot,
        path.resolve(
          options.sharpE2eResolverParent ||
            path.join(repoRoot, 'electron', 'projectPreviewService.ts'),
        ),
      ),
      '@napi-rs/canvas': normalizedRelativePath(
        repoRoot,
        path.resolve(
          options.canvasResolverParent ||
            path.join(repoRoot, 'electron', 'projectPreviewProviders.ts'),
        ),
      ),
    }
    const mismatchedBoundExternal = externals.find(
      (descriptor) =>
        exactExternalImporters[descriptor.packageName] &&
        descriptor.importer !== exactExternalImporters[descriptor.packageName],
    )
    if (mismatchedBoundExternal) {
      fail(
        'typescript-closure',
        `TypeScript external ${mismatchedBoundExternal.packageName} has an unbound importer: ` +
          mismatchedBoundExternal.importer,
      )
    }
    const packageContexts = new Map()
    const externalResolutions = []
    for (const descriptor of externals) {
      if (!explicitRuntimePackageNames.has(descriptor.packageName)) continue
      const importer = path.resolve(repoRoot, descriptor.importer)
      const context = await collectResolvedRuntimePackageFromParent({
        packageName: descriptor.packageName,
        moduleSpecifier: descriptor.specifier,
        resolverParent: importer,
        options,
        kind: 'require',
        resolution: 'node-create-require-resolve-from-guard-loaded-ts-importer',
      })
      const packageKey = `${context.fingerprint.packageLocation}:${context.fingerprint.contentIdentity}`
      packageContexts.set(packageKey, context)
      const resolutionCore = {
        importer: descriptor.importer,
        specifier: descriptor.specifier,
        packageName: descriptor.packageName,
        packageLocation: context.fingerprint.packageLocation,
        packageIdentity: context.fingerprint.contentIdentity,
        resolvedEntry: context.fingerprint.entries.require.path,
      }
      externalResolutions.push({ ...resolutionCore, identity: fingerprint(resolutionCore) })
    }
    externalResolutions.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    const externalPackages = [...packageContexts.values()]
      .map((context) => context.fingerprint)
      .sort((left, right) =>
        `${left.packageLocation}:${left.contentIdentity}`.localeCompare(
          `${right.packageLocation}:${right.contentIdentity}`,
        ),
      )
    for (const context of packageContexts.values()) {
      await recaptureRuntimePackage(context, options, context.fingerprint.packageName)
    }
    const externalRuntimeCore = {
      algorithm: 'guard-loaded-ts-explicit-runtime-packages-v1',
      resolutions: externalResolutions,
      packages: externalPackages,
    }
    await recaptureRuntimePackage(transpilerContext, options, 'TypeScript')
    const sourceCore = {
      algorithm: 'guard-utils-transpileModule-cjs-recursive-v1',
      roots,
      limits: { maxFiles, maxTotalBytes: maxBytes },
      fileCount: files.length,
      totalBytes,
      files,
      externalSpecifiers: externals,
    }
    const core = {
      benchmark: {
        path: normalizedRelativePath(repoRoot, benchmarkPath),
        ...benchmark.proof,
      },
      guardUtils: {
        path: normalizedRelativePath(repoRoot, guardPath),
        ...guard.proof,
      },
      transpiler: transpilerContext.fingerprint,
      externalRuntime: {
        ...externalRuntimeCore,
        identity: fingerprint(externalRuntimeCore),
      },
      sourceClosure: { ...sourceCore, identity: fingerprint(sourceCore) },
    }
    return { ...core, identity: fingerprint(core) }
  }

  function selectedCanvasPlatform(options) {
    if (options.canvasPlatformPackage && options.canvasRuntimePlatform) {
      return {
        packageName: String(options.canvasPlatformPackage),
        runtimePlatform: String(options.canvasRuntimePlatform),
      }
    }
    const platform = options.platform || process.platform
    const arch = options.arch || process.arch
    if (platform === 'win32' && arch === 'x64') {
      const gnu =
        process.config?.variables?.shlib_suffix === 'dll.a' ||
        process.config?.variables?.node_target_type === 'shared_library'
      return {
        packageName: `@napi-rs/canvas-win32-x64-${gnu ? 'gnu' : 'msvc'}`,
        runtimePlatform: `win32-x64-${gnu ? 'gnu' : 'msvc'}`,
      }
    }
    if (platform === 'win32' && arch === 'arm64') {
      return {
        packageName: '@napi-rs/canvas-win32-arm64-msvc',
        runtimePlatform: 'win32-arm64-msvc',
      }
    }
    fail('canvas-platform', `Unsupported Canvas platform fingerprint: ${platform}-${arch}`)
  }

  async function findCanvasBindingCarrier(canvasContext) {
    const matches = []
    for (const file of canvasContext.fingerprint.runtime.files) {
      if (!/\.(?:c?js|mjs)$/i.test(file.path)) continue
      const captured = await readStableFileDescriptor(
        path.resolve(canvasContext.packageRoot, file.path),
        {
          root: canvasContext.packageRoot,
          label: 'Canvas native loader discovery file',
          collectBytes: true,
          maxBytes: file.size,
        },
      )
      if (captured.proof.size !== file.size || captured.proof.sha256 !== file.sha256) {
        fail('file-mutated', 'Canvas runtime changed during native loader discovery')
      }
      const source = captured.bytes.toString('utf8')
      if (
        source.includes('NAPI_RS_NATIVE_LIBRARY_PATH') &&
        source.includes('NAPI_RS_FORCE_WASI') &&
        source.includes('@napi-rs/canvas-')
      ) {
        matches.push(path.resolve(canvasContext.packageRoot, file.path))
      }
    }
    if (matches.length !== 1) {
      fail('canvas-loader', `Expected exactly one Canvas native loader carrier, found ${matches.length}`)
    }
    return matches[0]
  }

  async function collectExternalPackageAbsence(resolverParent, packageName, options, label) {
    const searchPaths = []
    let directory = path.dirname(path.resolve(resolverParent))
    while (isPathInside(options.repoRoot, directory, true)) {
      searchPaths.push(path.join(directory, 'node_modules'))
      const parent = path.dirname(directory)
      if (samePath(parent, directory)) break
      directory = parent
    }
    const segments = packageName.split('/')
    const proofs = []
    for (const searchPath of searchPaths) {
      const localSearchPath = path.resolve(searchPath)
      if (!isPathInside(options.repoRoot, localSearchPath, true)) continue
      const proof = await probeLocalPayload(
        options.repoRoot,
        path.join(localSearchPath, ...segments),
        label,
        'directory',
      )
      if (proof.status !== 'absent') {
        fail('runtime-loader', `${label} exists but its package entry did not resolve`)
      }
      proofs.push(proof)
    }
    if (proofs.length === 0) {
      fail('runtime-loader', `${label} has no repository-local resolution absence proof`)
    }
    proofs.sort((left, right) => left.path.localeCompare(right.path))
    return { status: 'absent', packageName, searchPathProofs: proofs }
  }

  async function collectCanvasRuntimeClosure(options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const importer = path.resolve(
      options.canvasResolverParent || path.join(repoRoot, 'electron', 'projectPreviewProviders.ts'),
    )
    await proveSpecifierInFile(repoRoot, importer, '@napi-rs/canvas', 'Canvas resolver parent')
    const canvasContext = await collectResolvedRuntimePackageFromParent({
      packageName: '@napi-rs/canvas',
      resolverParent: importer,
      options,
      resolution: 'node-create-require-resolve-from-canvas-importer',
    })
    const carrier = await findCanvasBindingCarrier(canvasContext)
    const platform = selectedCanvasPlatform(options)
    const canvasEnvironment = options.canvasEnvironment || process.env
    for (const variable of ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI']) {
      if (canvasEnvironment?.[variable]) {
        fail('canvas-loader', `${variable} must be unset for fixed-hardware evidence`)
      }
    }
    if (canvasEnvironment?.DISABLE_SYSTEM_FONTS_LOAD !== '1') {
      fail('canvas-loader', 'DISABLE_SYSTEM_FONTS_LOAD must be 1 for fixed-hardware evidence')
    }
    const localNative = {
      kind: 'local-native',
      priority: 1,
      ...(await probeLocalPayload(
        canvasContext.packageRoot,
        path.join(canvasContext.packageRoot, `skia.${platform.runtimePlatform}.node`),
        'Canvas local native candidate',
      )),
    }
    const platformContext = await collectResolvedRuntimePackageFromParent({
      packageName: platform.packageName,
      resolverParent: carrier,
      options,
      resolution: 'node-create-require-resolve-from-canvas-loader',
    })
    const platformFiles = platformContext.fingerprint.runtime.files
    if (!platformFiles.some((file) => /\.node$/i.test(file.path))) {
      fail('canvas-loader', `${platform.packageName} native .node payload is missing`)
    }
    const icuFile = platformFiles.find((file) => /(?:^|\/)icudtl\.dat$/i.test(file.path))
    if (!icuFile) fail('canvas-loader', `${platform.packageName} icudtl.dat payload is missing`)
    const platformCandidate = {
      kind: 'platform-package',
      priority: 2,
      status: 'present',
      packageName: platform.packageName,
      packageLocation: platformContext.fingerprint.packageLocation,
      payloadIdentity: platformContext.fingerprint.identity,
    }
    const candidates = [localNative, platformCandidate]
    const selectedCandidate = candidates.find((candidate) => candidate.status === 'present')
    if (!selectedCandidate) fail('canvas-loader', 'Canvas native loader has no selected payload')
    const selected = {
      kind: selectedCandidate.kind,
      priority: selectedCandidate.priority,
      payloadIdentity: selectedCandidate.payloadIdentity || selectedCandidate.sha256,
    }
    const localWasi = {
      kind: 'local-wasi',
      priority: 1,
      ...(await probeLocalPayload(
        canvasContext.packageRoot,
        path.join(canvasContext.packageRoot, 'skia.wasi.cjs'),
        'Canvas local WASI fallback',
      )),
    }
    let externalWasi
    try {
      const wasiContext = await collectResolvedRuntimePackageFromParent({
        packageName: '@napi-rs/canvas-wasm32-wasi',
        resolverParent: carrier,
        options,
        resolution: 'node-create-require-resolve-from-canvas-loader',
      })
      externalWasi = {
        kind: 'external-wasi-package',
        priority: 2,
        status: 'present',
        payload: wasiContext.fingerprint,
      }
    } catch (error) {
      if (error.code !== 'runtime-dependency-missing') {
        fail('canvas-loader', `Canvas WASI fallback resolution failed: ${error.message}`)
      }
      externalWasi = {
        kind: 'external-wasi-package',
        priority: 2,
        ...(await collectExternalPackageAbsence(
          carrier,
          '@napi-rs/canvas-wasm32-wasi',
          options,
          'Canvas external WASI fallback',
        )),
      }
    }
    const executable = path.resolve(options.canvasExecutablePath || options.nodeExecutable || process.execPath)
    const executableRoot = assertPlainRoot(
      path.dirname(executable),
      'Canvas executable directory for ICU resolution',
    )
    const executableIcu = {
      kind: 'executable-directory-icu',
      priority: 1,
      ...(await probeLocalPayload(
        executableRoot,
        path.join(executableRoot, 'icudtl.dat'),
        'Canvas executable-directory ICU data',
      )),
    }
    const platformIcu = {
      kind: 'native-library-directory-icu',
      priority: 2,
      status: 'present',
      packageLocation: platformContext.fingerprint.packageLocation,
      path: icuFile.path,
      size: icuFile.size,
      sha256: icuFile.sha256,
    }
    const icuCandidates = [executableIcu, platformIcu]
    const selectedIcu = icuCandidates.find((candidate) => candidate.status === 'present')
    await recaptureRuntimePackage(canvasContext, options, 'Canvas')
    const core = {
      algorithm: 'napi-rs-canvas-native-loader-win32-priority-v1',
      resolverParent: normalizedRelativePath(repoRoot, importer),
      canvas: canvasContext.fingerprint,
      carrier: await fileRevision(repoRoot, carrier, 'Canvas native loader carrier'),
      environmentDecision: {
        NAPI_RS_NATIVE_LIBRARY_PATH: 'required-unset',
        NAPI_RS_FORCE_WASI: 'required-unset',
        NODE_PATH: 'required-unset',
        DISABLE_SYSTEM_FONTS_LOAD: 'required-1',
      },
      runtimePlatform: platform.runtimePlatform,
      candidates,
      selected,
      wasiFallbackCandidates: [localWasi, externalWasi],
      platformPackage: platformContext.fingerprint,
      icuDecision: {
        algorithm: 'skia-windows-executable-then-native-directory-v1',
        candidates: icuCandidates,
        selected: {
          kind: selectedIcu.kind,
          priority: selectedIcu.priority,
          sha256: selectedIcu.sha256,
        },
      },
    }
    return { ...core, identity: fingerprint(core) }
  }

  async function collectBundledSharpLoaderClosure(repoRoot, children, version, options) {
    if (typeof version !== 'string' || !version) {
      fail('sharp-loader', 'Bundled Sharp loader version is missing')
    }
    const carriers = new Map()
    for (const child of children) {
      for (const file of child.runtimeClosure.files) {
        if (!/\.(?:c?js|mjs)$/i.test(file.path)) continue
        const filePath = path.resolve(repoRoot, file.path)
        const captured = await readStableFileDescriptor(filePath, {
          root: repoRoot,
          label: `${child.name} bundled Sharp loader discovery`,
          collectBytes: true,
          maxBytes: file.size,
        })
        if (captured.proof.size !== file.size || captured.proof.sha256 !== file.sha256) {
          fail('file-mutated', `${child.name} runtime changed during Sharp loader discovery`)
        }
        const source = captured.bytes.toString('utf8')
        if (
          source.includes('src/build/Release/sharp-') &&
          source.includes('src/build/Release/sharp-wasm32-') &&
          source.includes('@img/sharp-')
        ) {
          if (!source.includes(version)) {
            fail('sharp-loader', `${child.name} embedded Sharp version does not match ${version}`)
          }
          const relative = normalizedRelativePath(repoRoot, filePath)
          const existing = carriers.get(relative) || { path: filePath, children: [] }
          existing.children.push(child.name)
          carriers.set(relative, existing)
        }
      }
    }
    if (carriers.size === 0) {
      fail('sharp-loader', 'No bundled child Sharp loader carrier was discovered')
    }
    const contexts = []
    for (const carrier of carriers.values()) {
      carrier.children.sort((left, right) => left.localeCompare(right))
      const runtimePlatform = sharpRuntimePlatform(options)
      const localPlatform = {
        kind: 'local-platform-native',
        priority: 1,
        ...(await probeLocalPayload(
          repoRoot,
          path.resolve(
            path.dirname(carrier.path),
            '..',
            'src',
            'build',
            'Release',
            `sharp-${runtimePlatform}-${version}.node`,
          ),
          'Bundled Sharp local platform native candidate',
        )),
      }
      const localWasm = {
        kind: 'local-wasm-native',
        priority: 2,
        ...(await probeLocalPayload(
          repoRoot,
          path.resolve(
            path.dirname(carrier.path),
            '..',
            'src',
            'build',
            'Release',
            `sharp-wasm32-${version}.node`,
          ),
          'Bundled Sharp local WASM native candidate',
        )),
      }
      const platformName = selectedSharpPlatformPackage(options)
      const platformContext = await collectResolvedRuntimePackageFromParent({
        packageName: platformName,
        moduleSpecifier: `${platformName}/sharp.node`,
        resolverParent: carrier.path,
        options,
        resolution: 'node-create-require-resolve-from-bundled-sharp-loader',
      })
      assertSharpPlatformPayload(platformName, platformContext.fingerprint)
      const platformCandidate = {
        kind: 'platform-package',
        priority: 3,
        status: 'present',
        packageName: platformName,
        packageLocation: platformContext.fingerprint.packageLocation,
        payloadIdentity: platformContext.fingerprint.identity,
      }
      const candidates = [localPlatform, localWasm, platformCandidate]
      const selectedCandidate = candidates.find((candidate) => candidate.status === 'present')
      const contextCore = {
        children: carrier.children,
        carrier: await fileRevision(repoRoot, carrier.path, 'Bundled Sharp loader carrier'),
        runtimePlatform,
        version,
        candidates,
        selected: {
          kind: selectedCandidate.kind,
          priority: selectedCandidate.priority,
          payloadIdentity: selectedCandidate.payloadIdentity || selectedCandidate.sha256,
        },
        platformPackage: platformContext.fingerprint,
      }
      contexts.push({ ...contextCore, identity: fingerprint(contextCore) })
    }
    contexts.sort((left, right) => left.carrier.path.localeCompare(right.carrier.path))
    const core = { algorithm: 'bundled-sharp-loader-contexts-v1', contexts }
    return { ...core, identity: fingerprint(core) }
  }

  async function collectMlRuntimeResolutionClosure(options) {
    const repoRoot = assertPlainRoot(options.repoRoot, 'Repository root')
    const childParents = options.mlChildResolverParents || [
      {
        name: 'clipEmbeddingChild',
        path: path.join(repoRoot, 'dist-electron', 'clipEmbeddingChild.js'),
      },
      {
        name: 'dinoEmbeddingChild',
        path: path.join(repoRoot, 'dist-electron', 'dinoEmbeddingChild.js'),
      },
    ]
    const childResolutions = []
    const transformerContexts = new Map()
    for (const descriptor of childParents) {
      if (!descriptor?.name || !descriptor.path) {
        fail('ml-runtime', 'ML child resolver descriptor is incomplete')
      }
      const parent = path.resolve(descriptor.path)
      await proveSpecifierInFile(
        repoRoot,
        parent,
        '@huggingface/transformers',
        `${descriptor.name} Transformers importer`,
      )
      const context = await collectResolvedRuntimePackageFromParent({
        packageName: '@huggingface/transformers',
        resolverParent: parent,
        kind: 'import',
        options,
        resolution: 'node-import-meta-resolve-from-embedding-child',
      })
      const resolutionCore = {
        child: String(descriptor.name),
        resolverParent: normalizedRelativePath(repoRoot, parent),
        packageLocation: context.fingerprint.packageLocation,
        packageIdentity: context.fingerprint.contentIdentity,
        resolvedEntry: context.fingerprint.entries.import.path,
      }
      childResolutions.push({ ...resolutionCore, identity: fingerprint(resolutionCore) })
      const existing = transformerContexts.get(context.fingerprint.packageLocation)
      if (existing && existing.fingerprint.contentIdentity !== context.fingerprint.contentIdentity) {
        fail('file-mutated', 'Transformers changed between embedding child resolver contexts')
      }
      transformerContexts.set(context.fingerprint.packageLocation, context)
    }
    childResolutions.sort((left, right) => left.child.localeCompare(right.child))

    const transformerPackages = []
    const onnxruntimeNodePackages = new Map()
    const onnxruntimeCommonPackages = new Map()
    const dependencyResolutions = []
    for (const transformerContext of transformerContexts.values()) {
      const transformerEntry = transformerContext.resolvedEntry
      for (const specifier of ['onnxruntime-node', 'onnxruntime-common', 'sharp']) {
        await proveSpecifierInFile(
          repoRoot,
          transformerEntry,
          specifier,
          `Transformers ${specifier} importer`,
        )
      }
      const onnxContext = await collectResolvedRuntimePackageFromParent({
        packageName: 'onnxruntime-node',
        resolverParent: transformerEntry,
        kind: 'import',
        options,
        resolution: 'node-import-meta-resolve-from-transformers-entry',
      })
      const transformerCommon = await collectResolvedRuntimePackageFromParent({
        packageName: 'onnxruntime-common',
        resolverParent: transformerEntry,
        kind: 'import',
        options,
        resolution: 'node-import-meta-resolve-from-transformers-entry',
      })
      await proveSpecifierInFile(
        repoRoot,
        onnxContext.resolvedEntry,
        'onnxruntime-common',
        'onnxruntime-node common importer',
      )
      const onnxCommon = await collectResolvedRuntimePackageFromParent({
        packageName: 'onnxruntime-common',
        resolverParent: onnxContext.resolvedEntry,
        kind: 'require',
        options,
        resolution: 'node-create-require-resolve-from-onnxruntime-node-entry',
      })
      const onnxFingerprint = await collectOnnxRuntimeFromResolvedContext(onnxContext, options)
      const transformerCore = {
        packageLocation: transformerContext.fingerprint.packageLocation,
        package: transformerContext.fingerprint,
      }
      transformerPackages.push({ ...transformerCore, identity: fingerprint(transformerCore) })
      const onnxExisting = onnxruntimeNodePackages.get(onnxContext.fingerprint.packageLocation)
      if (onnxExisting && onnxExisting.contentIdentity !== onnxFingerprint.contentIdentity) {
        fail('file-mutated', 'onnxruntime-node changed between Transformers resolver contexts')
      }
      onnxruntimeNodePackages.set(onnxContext.fingerprint.packageLocation, onnxFingerprint)
      for (const commonContext of [transformerCommon, onnxCommon]) {
        const key = `${commonContext.fingerprint.packageLocation}:${commonContext.fingerprint.contentIdentity}`
        onnxruntimeCommonPackages.set(key, commonContext.fingerprint)
      }
      for (const [name, parent, context, kind] of [
        ['transformers-to-onnxruntime-node', transformerEntry, onnxContext, 'import'],
        ['transformers-to-onnxruntime-common', transformerEntry, transformerCommon, 'import'],
        ['onnxruntime-node-to-common', onnxContext.resolvedEntry, onnxCommon, 'require'],
      ]) {
        const resolutionCore = {
          name,
          resolverParent: normalizedRelativePath(repoRoot, parent),
          resolutionKind: kind,
          packageName: context.fingerprint.packageName,
          packageLocation: context.fingerprint.packageLocation,
          packageIdentity: context.fingerprint.contentIdentity,
          resolvedEntry: context.fingerprint.entries[kind].path,
        }
        dependencyResolutions.push({ ...resolutionCore, identity: fingerprint(resolutionCore) })
      }
    }
    transformerPackages.sort((left, right) => left.packageLocation.localeCompare(right.packageLocation))
    dependencyResolutions.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    const commonPackages = [...onnxruntimeCommonPackages.values()].sort((left, right) =>
      `${left.packageLocation}:${left.contentIdentity}`.localeCompare(
        `${right.packageLocation}:${right.contentIdentity}`,
      ),
    )
    const nodePackages = [...onnxruntimeNodePackages.values()].sort((left, right) =>
      left.packageLocation.localeCompare(right.packageLocation),
    )
    const core = {
      algorithm: 'embedding-child-import-resolution-closure-v1',
      childResolutions,
      transformerPackages,
      onnxruntimeNodePackages: nodePackages,
      onnxruntimeCommonPackages: commonPackages,
      dependencyResolutions,
    }
    return { ...core, identity: fingerprint(core) }
  }

  return {
    collectBundledSharpLoaderClosure,
    collectCanvasRuntimeClosure,
    collectE2eTypeScriptClosure,
    collectMlRuntimeResolutionClosure,
    collectResolvedRuntimePackageFromParent,
    collectSharpResolutionClosure,
    extractLiteralModuleSpecifiers,
    packageNameFromSpecifier,
    selectedSharpPlatformPackage,
  }
}

module.exports = { createRuntimeClosureTools }
