const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

const { getIpcCapabilityDeclaration } = loadTsModule('shared/ipc-capabilities.ts')
const { IPC_PAYLOAD_LIMITS, validateIpcPayloadArguments } = loadTsModule(
  'shared/ipc-payload-validation.ts',
)

const root = path.resolve(__dirname, '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function collectChannelConstants() {
  const constants = new Map()
  const ipcDir = path.join(root, 'shared', 'ipc')
  for (const entry of fs.readdirSync(ipcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const source = ts.createSourceFile(
      entry.name,
      fs.readFileSync(path.join(ipcDir, entry.name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        let initializer = declaration.initializer
        while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
          initializer = initializer.expression
        }
        if (!ts.isObjectLiteralExpression(initializer)) continue
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
          if (!ts.isStringLiteral(property.initializer)) continue
          constants.set(`${declaration.name.text}.${property.name.text}`, property.initializer.text)
        }
      }
    }
  }
  return constants
}

const channelConstants = collectChannelConstants()

function collectCalls(sourceText, targetCall) {
  const channels = new Set()
  const source = ts.createSourceFile(
    'ipc-source.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === targetCall &&
      node.arguments.length > 0
    ) {
      const channel = node.arguments[0]
      if (ts.isStringLiteral(channel) || ts.isNoSubstitutionTemplateLiteral(channel)) {
        channels.add(channel.text)
      } else {
        const resolved = channelConstants.get(channel.getText(source))
        assert.ok(resolved, `cannot resolve IPC channel expression: ${channel.getText(source)}`)
        channels.add(resolved)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return channels
}

function collectMainChannels() {
  const channels = new Set()
  const electronDir = path.join(root, 'electron')
  for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    for (const channel of collectCalls(
      fs.readFileSync(path.join(electronDir, entry.name), 'utf8'),
      'secureIpcMain.handle',
    )) {
      channels.add(channel)
    }
  }
  return channels
}

function collectPreloadInvokeChannels() {
  const channels = new Set()
  for (const preload of [
    'electron/preload.ts',
    'electron/mediaPlayerPreload.ts',
    'electron/endUserTermsPreload.ts',
  ]) {
    for (const channel of collectCalls(readText(preload), 'ipcRenderer.invoke'))
      channels.add(channel)
  }
  return channels
}

test('preload invoke channels have matching main-process handlers', () => {
  const mainChannels = collectMainChannels()
  const preloadChannels = collectPreloadInvokeChannels()
  const missing = [...preloadChannels].filter((channel) => !mainChannels.has(channel)).sort()
  assert.deepEqual(missing, [])
})

test('main-process handlers exposed to renderer are intentionally represented in preload', () => {
  const mainChannels = collectMainChannels()
  const preloadChannels = collectPreloadInvokeChannels()
  const intentionallyInternal = new Set()
  const unexposed = [...mainChannels]
    .filter((channel) => !preloadChannels.has(channel) && !intentionallyInternal.has(channel))
    .sort()
  assert.deepEqual(unexposed, [])
})

test('every renderer invoke has capabilities and a bounded payload validator', () => {
  const preloadChannels = collectPreloadInvokeChannels()
  const missing = []
  for (const channel of preloadChannels) {
    const declaration = getIpcCapabilityDeclaration(channel)
    if (!declaration) {
      missing.push(channel)
      continue
    }
    assert.ok(declaration.capabilities.includes('R'), `${channel} must declare read capability`)
    assert.equal(declaration.validator, 'bounded-structured-clone-v1')
  }
  assert.deepEqual(missing.sort(), [])

  assert.deepEqual(getIpcCapabilityDeclaration('remoteTerminal:saveCredential').capabilities, [
    'R',
    'W',
    'FS',
    'PROC',
    'NET',
    'SECRET',
  ])
  assert.ok(getIpcCapabilityDeclaration('fm-delete-files').capabilities.includes('FS'))
  assert.ok(getIpcCapabilityDeclaration('imageSearch:openFile').capabilities.includes('EXT'))
  assert.ok(
    getIpcCapabilityDeclaration('imageSearch:executeFolderDataEdit').capabilities.includes('W'),
  )
  assert.equal(getIpcCapabilityDeclaration('undeclared:newChannel'), null)
})

test('all renderer IPC registrations use the centralized authorization wrapper', () => {
  const electronDir = path.join(root, 'electron')
  for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('Ipc.ts')) continue
    const text = fs.readFileSync(path.join(electronDir, entry.name), 'utf8')
    assert.doesNotMatch(text, /\bipcMain\.(?:handle|on)\(/, entry.name)
  }
  const authorization = readText('electron/ipcAuthorization.ts')
  assert.match(authorization, /authorizedWebContents\.has\(event\.sender\.id\)/)
  assert.match(authorization, /event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(authorization, /isTrustedFrame\(event\.sender\.id, event\.senderFrame\.url\)/)
  assert.match(authorization, /validateIpcPayloadArguments\(args\)/)
  assert.match(
    readText('electron/main.ts'),
    /authorizeIpcWebContents\(\s*mainWindow\.webContents,\s*createRendererFrameUrlTrust\(/,
  )
})

test('common IPC payload validator rejects oversized and malformed structured data', () => {
  assert.doesNotThrow(() =>
    validateIpcPayloadArguments(['path', 12, true, { nested: ['safe', new Uint8Array(8)] }]),
  )
  assert.throws(
    () => validateIpcPayloadArguments(Array(IPC_PAYLOAD_LIMITS.arguments + 1).fill(null)),
    /Too many IPC arguments/,
  )
  assert.throws(
    () => validateIpcPayloadArguments(['x'.repeat(IPC_PAYLOAD_LIMITS.stringLength + 1)]),
    /string payload is too large/,
  )
  assert.throws(
    () => validateIpcPayloadArguments([Array(IPC_PAYLOAD_LIMITS.collectionItems + 1)]),
    /array payload is too large/,
  )
  assert.throws(() => validateIpcPayloadArguments([Number.NaN]), /non-finite number/)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => validateIpcPayloadArguments([cyclic]), /contains a cycle/)
})

test('renderer loads only after IPC registration and remote profile handlers share readiness', () => {
  const mainSource = readText('electron/main.ts')
  const readyStart = mainSource.indexOf('void app.whenReady().then')
  const readyEnd = mainSource.indexOf("screen.on('display-metrics-changed'", readyStart)
  assert.notEqual(readyStart, -1)
  assert.notEqual(readyEnd, -1)
  const readyBlock = mainSource.slice(readyStart, readyEnd)
  const createWindowAt = readyBlock.indexOf('createWindow()')
  assert.notEqual(createWindowAt, -1)

  for (const registration of [
    'registerImageSearchIpc(',
    'registerMediaSearchCoreIpc(',
    'registerAssetLibraryIpc(',
    'registerRemoteTerminalProfileIpc(',
    'registerRemoteTerminalSftpIpc(',
    'registerRemoteTerminalTransferIpc(',
    'registerRemoteTerminalConnectionIpc(',
    'registerFileManagerIpc(',
    'registerFileDragIpc(',
    'registerVectorIpc(',
  ]) {
    const registrationAt = readyBlock.indexOf(registration)
    assert.notEqual(registrationAt, -1, `${registration} must be registered during startup`)
    assert.ok(registrationAt < createWindowAt, `${registration} must precede createWindow()`)
  }

  assert.match(readyBlock, /const profilesReady = loadProfiles\(/)
  for (const file of [
    'electron/remoteTerminalProfileIpc.ts',
    'electron/remoteTerminalSftpIpc.ts',
    'electron/remoteTerminalTransferIpc.ts',
    'electron/remoteTerminalConnectionIpc.ts',
  ]) {
    assert.match(readText(file), /await profilesReady/, `${file} must await profile initialization`)
  }
})

test('MediaSearch status waits for asynchronous FFmpeg discovery', () => {
  const source = readText('electron/mediaSearchIpc.ts')
  const handlerStart = source.indexOf("secureIpcMain.handle('mediaSearch:getStatus'")
  const handlerEnd = source.indexOf(
    "secureIpcMain.handle('mediaSearch:getCacheStats'",
    handlerStart,
  )
  assert.notEqual(handlerStart, -1)
  assert.notEqual(handlerEnd, -1)
  const handler = source.slice(handlerStart, handlerEnd)
  assert.match(handler, /await warmFfmpegStatusCache\(\)/)
  assert.ok(
    handler.indexOf('await warmFfmpegStatusCache()') < handler.indexOf('getMediaSearchStatus('),
  )

  const mainSource = readText('electron/main.ts')
  const configAt = mainSource.indexOf('initMediaToolConfig()')
  const warmAt = mainSource.indexOf('void warmFfmpegStatusCache()', configAt)
  const windowAt = mainSource.indexOf('createWindow()', warmAt)
  assert.notEqual(configAt, -1)
  assert.ok(warmAt > configAt, 'FFmpeg warmup must start after persisted tool config is loaded')
  assert.ok(windowAt > warmAt, 'FFmpeg warmup must run in parallel with renderer startup')

  const apiSource = readText('electron/aiControlApi.ts')
  const apiStatusStart = apiSource.indexOf("case 'mediaSearch.status':")
  const apiStatusEnd = apiSource.indexOf("case 'mediaSearch.search':", apiStatusStart)
  assert.notEqual(apiStatusStart, -1)
  assert.notEqual(apiStatusEnd, -1)
  const apiStatusHandler = apiSource.slice(apiStatusStart, apiStatusEnd)
  assert.ok(
    apiStatusHandler.indexOf('await warmFfmpegStatusCache()') <
      apiStatusHandler.indexOf('getMediaSearchStatus()'),
    'AI Control status must await FFmpeg discovery before taking its snapshot',
  )
})
