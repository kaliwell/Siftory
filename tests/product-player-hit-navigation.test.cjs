const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const { computeMediaContainRect, normalizeMediaPlayerHitContext, stepMediaPlayerHitIndex } =
  loadTsModule('shared/mediaPlayerNavigation.ts')

test('player hit context is ordered, bounded, and selects the nearest authoritative time', () => {
  const context = normalizeMediaPlayerHitContext(
    {
      query: ` door ${'x'.repeat(700)} `,
      selectedIndex: 99,
      hits: [
        {
          startMs: 30_000,
          endMs: 31_000,
          kind: 'subtitle',
          text: 'the door opens',
          evidenceSources: ['transcript-reference'],
        },
        { startMs: 10_000, kind: 'visual', evidenceSources: ['cached-frame'] },
        { startMs: -1, kind: 'visual', evidenceSources: [] },
      ],
    },
    60_000,
    28_000,
  )
  assert.deepEqual(
    context.hits.map((hit) => hit.startMs),
    [10_000, 30_000],
  )
  assert.equal(context.selectedIndex, 1)
  assert.equal(context.query.length, 500)
  assert.equal(stepMediaPlayerHitIndex(context, 1, -1), 0)
  assert.equal(stepMediaPlayerHitIndex(context, 0, -1), 0)
  assert.equal(stepMediaPlayerHitIndex(context, 0, 1), 1)
  assert.equal(stepMediaPlayerHitIndex(context, 1, 1), 1)
})

test('contain layout preserves landscape, portrait, square, and ultra-wide media without cropping', () => {
  const fixtures = [
    { media: [1920, 1080], expected: [1000, 562.5] },
    { media: [1080, 1920], expected: [337.5, 600] },
    { media: [1000, 1000], expected: [600, 600] },
    { media: [3840, 720], expected: [1000, 187.5] },
  ]
  for (const fixture of fixtures) {
    const rect = computeMediaContainRect(1000, 600, fixture.media[0], fixture.media[1])
    assert.equal(rect.width, fixture.expected[0])
    assert.equal(rect.height, fixture.expected[1])
    assert.ok(rect.left >= 0 && rect.top >= 0)
    assert.ok(rect.width <= 1000 && rect.height <= 600)
    assert.ok(Math.abs(rect.width / rect.height - fixture.media[0] / fixture.media[1]) < 1e-9)
  }
})

test('sandboxed player exposes range, context, navigation, subtitles, and keyboard controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'media-player.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'src', 'mediaPlayer.ts'), 'utf8')
  assert.match(html, /id="previous-hit"/)
  assert.match(html, /id="next-hit"/)
  assert.match(html, /id="hit-text"/)
  assert.match(html, /id="hit-range-marker"/)
  assert.match(html, /id="selection-track"/)
  assert.match(html, /id="loop-selection"/)
  assert.match(html, /object-fit:\s*contain/)
  assert.match(script, /stepMediaPlayerHitIndex/)
  assert.match(script, /event\.altKey/)
  assert.match(script, /ArrowLeft/)
  assert.match(script, /ArrowRight/)
  assert.match(script, /hitText\.textContent/)
  assert.match(script, /enforceSelectionLoop/)
  assert.match(script, /selectionPlayhead\.style\.left/)
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|eval\(/)
})

test('unified search sends all bounded hit evidence to the controlled player', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  assert.match(ui, /function mediaPlayerHitContext/)
  assert.match(ui, /item\.videoHits\.slice\(0, 32\)/)
  assert.match(ui, /evidenceSources: \[\.\.\.hit\.evidenceSources\]/)
  assert.match(ui, /hitContext: mediaPlayerHitContext/)
})
