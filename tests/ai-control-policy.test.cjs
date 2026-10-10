const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  AI_CONTROL_CAPABILITIES,
  AI_CONTROL_SCOPES,
  AiControlAuthFailureGuard,
  AiControlSseLimiter,
  hasAiControlScopes,
  isAllowedLoopbackHost,
  isAllowedLoopbackOrigin,
  isLoopbackAddress,
  normalizeAiControlPort,
  normalizeAiControlScopes,
  redactAiControlValue,
  tokensEqual,
  validateCapabilityInput,
} = loadTsModule('electron/aiControlPolicy.ts')

const root = path.resolve(__dirname, '..')

test('AI control capability registry is explicit, versioned, scoped, and non-destructive', () => {
  const ids = AI_CONTROL_CAPABILITIES.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('system.capabilities'))
  assert.ok(ids.includes('window.listDisplays'))
  assert.ok(ids.includes('imageSearch.search'))
  assert.ok(ids.includes('mediaSearch.search'))
  assert.ok(ids.includes('folder.sources'))
  assert.ok(ids.includes('folder.stats'))
  assert.ok(ids.includes('storage.largeFiles'))
  assert.ok(ids.includes('folder.largeFiles'))
  assert.ok(ids.includes('assetLibrary.search'))
  for (const capability of AI_CONTROL_CAPABILITIES) {
    assert.equal(capability.version, 1)
    assert.notEqual(capability.risk, 'destructive')
    assert.ok(capability.requiredScopes.length > 0)
    assert.equal(capability.confirmationRequired, capability.risk === 'write')
    assert.ok(capability.outputSchema)
    assert.ok(['cooperative', 'not_applicable'].includes(capability.cancellation))
    assert.ok(['none', 'redacted'].includes(capability.pathPolicy))
    assert.equal(capability.idempotency, capability.risk === 'write' ? 'required' : 'not_required')
    assert.ok(capability.timeoutMs > 0)
    assert.equal(capability.concurrency, 1)
  }
})

test('AI control token scopes are normalized and enforced per capability', () => {
  assert.deepEqual(normalizeAiControlScopes(['search', 'unknown', 'search']), ['read', 'search'])
  assert.deepEqual(normalizeAiControlScopes(undefined), AI_CONTROL_SCOPES)
  assert.equal(hasAiControlScopes(['search'], ['read', 'search']), true)
  assert.equal(hasAiControlScopes(['window'], ['read', 'search']), false)
})

test('AI control accepts only loopback peers, Host values, and matching origins', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.20'), false)
  assert.equal(isAllowedLoopbackHost('127.0.0.1:32145', 32145), true)
  assert.equal(isAllowedLoopbackHost('localhost:32145', 32145), true)
  assert.equal(isAllowedLoopbackHost('0.0.0.0:32145', 32145), false)
  assert.equal(isAllowedLoopbackOrigin(undefined, 32145), true)
  assert.equal(isAllowedLoopbackOrigin('http://localhost:32145', 32145), true)
  assert.equal(isAllowedLoopbackOrigin('http://localhost:8080', 32145), false)
})

test('AI control normalizes ports and compares tokens without direct string equality', () => {
  assert.equal(normalizeAiControlPort(45000), 45000)
  assert.equal(normalizeAiControlPort(80), 32145)
  assert.equal(normalizeAiControlPort('bad'), 32145)
  assert.equal(tokensEqual('secret-a', 'secret-a'), true)
  assert.equal(tokensEqual('secret-a', 'secret-b'), false)
})

test('AI control schema validation rejects missing, unknown, oversized, and invalid fields', () => {
  const search = AI_CONTROL_CAPABILITIES.find((entry) => entry.id === 'mediaSearch.search')
  assert.equal(validateCapabilityInput(search, { text: 'city', topK: 20 }), null)
  assert.equal(validateCapabilityInput(search, {}), 'missing_property:text')
  assert.equal(
    validateCapabilityInput(search, { text: 'city', path: 'C:\\private' }),
    'unexpected_property:path',
  )
  assert.equal(validateCapabilityInput(search, { text: 'city', topK: 200 }), 'too_large:topK')

  const folderStats = AI_CONTROL_CAPABILITIES.find((entry) => entry.id === 'folder.stats')
  assert.equal(validateCapabilityInput(folderStats, { sourceId: 'src-1' }), null)
  assert.equal(validateCapabilityInput(folderStats, {}), 'missing_property:sourceId')
  assert.equal(
    validateCapabilityInput(folderStats, { sourceId: 'src-1', path: 'C:\\private' }),
    'unexpected_property:path',
  )
  assert.equal(folderStats.risk, 'read')
  assert.equal(folderStats.cancellation, 'cooperative')
  assert.equal(folderStats.timeoutMs, 300_000)

  const largeFiles = AI_CONTROL_CAPABILITIES.find((entry) => entry.id === 'folder.largeFiles')
  assert.equal(
    validateCapabilityInput(largeFiles, {
      sourceId: 'src-1',
      minBytes: 1024 ** 3,
      topN: 100,
      olderThanDays: 30,
      assessment: 'low-risk',
    }),
    null,
  )
  assert.equal(validateCapabilityInput(largeFiles, {}), 'missing_property:sourceId')
  assert.equal(
    validateCapabilityInput(largeFiles, { sourceId: 'src-1', topN: 201 }),
    'too_large:topN',
  )
  assert.equal(
    validateCapabilityInput(largeFiles, { sourceId: 'src-1', assessment: 'delete-now' }),
    'invalid_value:assessment',
  )
  assert.equal(largeFiles.risk, 'read')
  assert.deepEqual(largeFiles.requiredScopes, ['search'])
  assert.equal(largeFiles.cancellation, 'cooperative')

  const directLargeFiles = AI_CONTROL_CAPABILITIES.find(
    (entry) => entry.id === 'storage.largeFiles',
  )
  assert.equal(
    validateCapabilityInput(directLargeFiles, {
      scope: 'computer',
      rootId: 'drive-c',
      maxEntries: 5_000_000,
      minBytes: 1024 ** 3,
      topN: 100,
      olderThanDays: 30,
      assessment: 'all',
    }),
    null,
  )
  assert.equal(validateCapabilityInput(directLargeFiles, {}), 'missing_property:scope')
  assert.equal(
    validateCapabilityInput(directLargeFiles, { scope: 'computer', sourceId: 'src-1' }),
    'unexpected_property:sourceId',
  )
  assert.equal(
    validateCapabilityInput(directLargeFiles, { scope: 'network' }),
    'invalid_value:scope',
  )
  assert.equal(
    validateCapabilityInput(directLargeFiles, { scope: 'computer', rootId: 'C:\\' }),
    'invalid_value:rootId',
  )
  assert.equal(
    validateCapabilityInput(directLargeFiles, { scope: 'computer', maxEntries: 5_000_001 }),
    'too_large:maxEntries',
  )
  assert.equal(directLargeFiles.risk, 'read')
  assert.deepEqual(directLargeFiles.requiredScopes, ['search'])
  assert.equal(directLargeFiles.cancellation, 'cooperative')
  assert.equal(directLargeFiles.timeoutMs, 1_800_000)
})

test('AI control output redaction removes paths, credentials, commands, and tokens', () => {
  assert.deepEqual(
    redactAiControlValue({
      path: 'C:\\private\\image.jpg',
      nested: { token: 'secret', count: 2 },
      command: 'dangerous',
      label: 'safe',
      message: 'Model failed at C:\\private\\model.onnx',
    }),
    {
      path: '[redacted]',
      nested: { token: '[redacted]', count: 2 },
      command: '[redacted]',
      label: 'safe',
      message: '[redacted-path]',
    },
  )
})

test('AI control server defaults closed and binds only to IPv4 loopback', () => {
  const source = fs.readFileSync(path.join(root, 'electron/aiControlApi.ts'), 'utf8')
  assert.match(source, /enabled:\s*false/)
  assert.match(source, /listen\(config\.port, '127\.0\.0\.1'/)
  assert.doesNotMatch(source, /listen\([^\n]*(?:0\.0\.0\.0|::)/)
  assert.match(source, /safeStorage\.encryptString/)
  assert.match(source, /BODY_LIMIT\s*=\s*64 \* 1024/)
  assert.match(source, /confirmation_required/)
  assert.match(source, /confirmation_pending/)
  assert.match(source, /idempotency_conflict/)
  assert.match(source, /JOB_TTL_MS/)
  assert.match(source, /SSE_HEARTBEAT_MS/)
  assert.match(source, /jobControllers\.get\(job\.id\)\?\.abort\(\)/)
  assert.match(source, /createHash\('sha256'\)\.update\(result\.path\)/)
  assert.match(source, /case 'folder\.sources'/)
  assert.match(source, /case 'folder\.stats'/)
  assert.match(source, /case 'storage\.largeFiles'/)
  assert.match(source, /case 'folder\.largeFiles'/)
  assert.match(source, /scanSourceFolderStats/)
  assert.match(source, /scanSourceLargeFiles/)
  assert.match(source, /scanStorageLargeFiles/)
})

test('AI control server enforces auth lockout and SSE concurrency limits', () => {
  const source = fs.readFileSync(path.join(root, 'electron/aiControlApi.ts'), 'utf8')
  assert.match(source, /AUTH_FAILURE_LIMIT\s*=\s*8/)
  assert.match(source, /AUTH_LOCKOUT_MS\s*=\s*5 \* 60_000/)
  assert.match(source, /SSE_MAX_STREAMS\s*=\s*8/)
  assert.match(source, /SSE_MAX_STREAMS_PER_ADDRESS\s*=\s*4/)
  assert.match(source, /authFailureGuard\.recordAuthFailure\(/)
  assert.match(source, /authFailureGuard\.recordAuthSuccess\(/)
  assert.match(source, /auth_locked/)
  assert.match(source, /sseStreamLimiter\.acquire\(/)
  assert.match(source, /sseStreamLimiter\.release\(/)
  assert.match(source, /sseStreamLimiter\.reset\(\)/)
  assert.match(source, /sse_concurrency_limit/)
})

test('auth failure guard locks an address after the threshold and releases after lockout', () => {
  let now = 1_000_000
  const guard = new AiControlAuthFailureGuard({
    maxFailures: 8,
    windowMs: 600_000,
    lockoutMs: 300_000,
    now: () => now,
  })
  for (let attempt = 0; attempt < 7; attempt += 1) {
    assert.equal(guard.recordAuthFailure('127.0.0.1'), 0)
  }
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 0)
  assert.equal(guard.recordAuthFailure('127.0.0.1'), 300_000)
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 300_000)
  now += 100_000
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 200_000)
  now += 200_000
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 0)
  // Other addresses are unaffected by one peer's lockout.
  assert.equal(guard.lockedRetryAfterMs('::1'), 0)
})

test('auth failure guard expires failures outside the window and clears on success', () => {
  let now = 5_000_000
  const guard = new AiControlAuthFailureGuard({
    maxFailures: 3,
    windowMs: 60_000,
    lockoutMs: 30_000,
    now: () => now,
  })
  guard.recordAuthFailure('127.0.0.1')
  guard.recordAuthFailure('127.0.0.1')
  now += 61_000 // both failures leave the sliding window
  assert.equal(guard.recordAuthFailure('127.0.0.1'), 0)
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 0)

  guard.recordAuthFailure('127.0.0.1')
  guard.recordAuthSuccess('127.0.0.1')
  assert.equal(guard.recordAuthFailure('127.0.0.1'), 0)
  assert.equal(guard.lockedRetryAfterMs('127.0.0.1'), 0)

  const defaults = new AiControlAuthFailureGuard({ now: () => now })
  for (let attempt = 0; attempt < 7; attempt += 1) {
    assert.equal(defaults.recordAuthFailure('127.0.0.1'), 0)
  }
  assert.equal(defaults.recordAuthFailure('127.0.0.1'), 5 * 60_000)
})

test('SSE limiter enforces per-address and global caps with paired release', () => {
  const limiter = new AiControlSseLimiter(8, 4)
  for (let stream = 0; stream < 4; stream += 1) {
    assert.equal(limiter.acquire('127.0.0.1'), true)
  }
  assert.equal(limiter.acquire('127.0.0.1'), false, 'per-address cap')
  assert.equal(limiter.activeCount, 4)
  for (let stream = 0; stream < 4; stream += 1) {
    assert.equal(limiter.acquire('::1'), true)
  }
  assert.equal(limiter.acquire('::ffff:127.0.0.1'), false, 'global cap')
  assert.equal(limiter.activeCount, 8)

  limiter.release('127.0.0.1')
  assert.equal(limiter.activeCount, 7)
  assert.equal(limiter.acquire('::ffff:127.0.0.1'), true)
  limiter.release('10.0.0.9') // unknown address is a no-op
  assert.equal(limiter.activeCount, 8)

  limiter.reset()
  assert.equal(limiter.activeCount, 0)
  assert.equal(limiter.acquire('127.0.0.1'), true)
})

test('AI control publishes a bearer-protected OpenAPI contract for registered capabilities', () => {
  const { buildAiControlOpenApi } = loadTsModule('electron/aiControlOpenApi.ts')
  const document = buildAiControlOpenApi(AI_CONTROL_CAPABILITIES)
  assert.equal(document.openapi, '3.1.0')
  assert.equal(document.components.securitySchemes.bearerAuth.scheme, 'bearer')
  assert.ok(document.paths['/v1/openapi.json'])
  assert.ok(document.paths['/v1/actions/imageSearch.search'])
  assert.ok(document.paths['/v1/actions/folder.sources'])
  assert.equal(
    document.paths['/v1/actions/folder.stats'].post['x-reasonix-cancellation'],
    'cooperative',
  )
  assert.equal(document.paths['/v1/actions/folder.stats'].post['x-reasonix-timeout-ms'], 300_000)
  assert.equal(
    document.paths['/v1/actions/folder.largeFiles'].post['x-reasonix-cancellation'],
    'cooperative',
  )
  assert.equal(
    document.paths['/v1/actions/folder.largeFiles'].post.requestBody.content['application/json']
      .schema.properties.topN.maximum,
    200,
  )
  assert.equal(
    document.paths['/v1/actions/storage.largeFiles'].post['x-reasonix-cancellation'],
    'cooperative',
  )
  assert.equal(
    document.paths['/v1/actions/storage.largeFiles'].post['x-reasonix-timeout-ms'],
    1_800_000,
  )
  assert.deepEqual(
    document.paths['/v1/actions/storage.largeFiles'].post.requestBody.content['application/json']
      .schema.properties.scope.enum,
    ['computer', 'user', 'downloads', 'temporary'],
  )
  assert.equal(
    document.paths['/v1/actions/window.show'].post['x-reasonix-confirmation-required'],
    true,
  )
  const confirmationHeader = document.paths['/v1/actions/window.show'].post.parameters.find(
    (parameter) => parameter.name === 'X-Reasonix-Confirm',
  )
  assert.equal(confirmationHeader.required, false)
  assert.equal(confirmationHeader.schema.format, 'uuid')
  assert.equal(
    buildAiControlOpenApi(AI_CONTROL_CAPABILITIES, 45678).servers[0].variables.port.default,
    '45678',
  )
  assert.equal(
    document.paths['/v1/actions/window.show'].post.responses['202'].content['application/json']
      .schema.properties.jobId.format,
    'uuid',
  )
})
