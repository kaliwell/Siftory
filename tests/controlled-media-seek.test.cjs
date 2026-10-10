const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { loadTsModule } = require('./guard-utils.cjs')

const { MAX_CONTROLLED_MEDIA_SEEK_MS, resolveControlledMediaSeek } = loadTsModule(
  'electron/controlledMediaSeek.ts',
)

const fixture = {
  videoId: 'video-fixture',
  path: path.join(process.cwd(), 'fixtures', 'clip.mp4'),
  name: 'clip <fixture>.mp4',
  ext: '.mp4',
  sizeBytes: 100,
  mtimeMs: 1,
  durationMs: 90_000,
  discoveredAt: 1,
  updatedAt: 1,
}

test('controlled media seek accepts only manifest-owned ids and bounded integer timestamps', () => {
  const resolved = resolveControlledMediaSeek({ videoId: fixture.videoId, timestampMs: 42_125 }, [
    fixture,
  ])
  assert.equal(resolved.ok, true)
  assert.equal(resolved.value.timestampMs, 42_125)
  assert.equal(resolved.value.videoPath, path.resolve(fixture.path))

  assert.deepEqual(resolveControlledMediaSeek({ videoId: 'unknown', timestampMs: 0 }, [fixture]), {
    ok: false,
    error: 'Video not found in manifest',
  })
  for (const timestampMs of [-1, 1.25, Number.NaN, Number.POSITIVE_INFINITY, '1200']) {
    assert.equal(
      resolveControlledMediaSeek({ videoId: fixture.videoId, timestampMs }, [fixture]).ok,
      false,
    )
  }
  assert.equal(
    resolveControlledMediaSeek(
      { videoId: fixture.videoId, timestampMs: MAX_CONTROLLED_MEDIA_SEEK_MS + 1 },
      [fixture],
    ).ok,
    false,
  )
})

test('controlled media seek validates and bounds the optional hit context', () => {
  const resolved = resolveControlledMediaSeek(
    {
      videoId: fixture.videoId,
      timestampMs: 42_125,
      hitContext: {
        query: 'door opens',
        selectedIndex: 99,
        hits: [
          {
            startMs: 50_000,
            endMs: 55_000,
            kind: 'subtitle',
            text: 'Please open the door.',
            evidenceSources: ['transcript-reference', 'hostile-source'],
          },
          {
            startMs: 40_000,
            kind: 'visual',
            evidenceSources: ['cached-frame'],
          },
          { startMs: fixture.durationMs + 1, kind: 'visual', evidenceSources: [] },
        ],
      },
    },
    [fixture],
  )
  assert.equal(resolved.ok, true)
  assert.equal(resolved.value.hitContext.selectedIndex, 0)
  assert.deepEqual(
    resolved.value.hitContext.hits.map((hit) => hit.startMs),
    [40_000, 50_000],
  )
  assert.deepEqual(resolved.value.hitContext.hits[1].evidenceSources, ['transcript-reference'])

  assert.deepEqual(
    resolveControlledMediaSeek(
      { videoId: fixture.videoId, timestampMs: 0, hitContext: { hits: [{ startMs: -1 }] } },
      [fixture],
    ),
    { ok: false, error: 'Invalid media hit context' },
  )
})

test('controlled media seek rejects positions beyond the authoritative duration', () => {
  const result = resolveControlledMediaSeek(
    { videoId: fixture.videoId, timestampMs: fixture.durationMs + 1 },
    [fixture],
  )
  assert.deepEqual(result, {
    ok: false,
    error: 'Media timestamp exceeds the indexed duration',
  })
})

test('internal player receives an exact numeric seek without command-line construction', () => {
  const script = fs.readFileSync('src/mediaPlayer.ts', 'utf8')
  assert.match(script, /timestampMs \/ 1_?000/)
  assert.match(script, /Number\.isSafeInteger\(timestampMs\)/)
  assert.doesNotMatch(script, /child_process|spawn\(|exec\(|shell\.openExternal|video-fixture/)
})

test('media action resolves manifest data before opening the internal player', () => {
  const ipc = fs.readFileSync('electron/mediaSearchIpc.ts', 'utf8')
  assert.match(ipc, /resolveControlledMediaSeek\(input, loadVideoManifest\(\)\)/)
  assert.match(ipc, /openControlledMediaPlayer\(resolved\.value/)
  assert.doesNotMatch(ipc, /openMediaAtTime[\s\S]{0,900}openSafeShellPath\(shell,\s*video\.path/)
})
