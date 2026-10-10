const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { scaleSamPromptsToInput } = loadTsModule('electron/samPromptCoordinates.ts')

test('SAM prompts scale from original portrait pixels to the resized encoder input', () => {
  assert.deepEqual(
    scaleSamPromptsToInput(
      [
        { x: 540, y: 960, label: 1 },
        { x: 135, y: 240, label: 2 },
        { x: 945, y: 1680, label: 3 },
      ],
      1080,
      1920,
      576,
      1024,
    ),
    [
      { x: 288, y: 512, label: 1 },
      { x: 72, y: 128, label: 2 },
      { x: 504, y: 896, label: 3 },
    ],
  )
})

test('SAM prompts preserve coordinates when the source already matches the encoder input', () => {
  const points = [{ x: 400, y: 300, label: 0 }]
  assert.deepEqual(scaleSamPromptsToInput(points, 1024, 768, 1024, 768), points)
})

test('SAM prompt scaling rejects invalid image dimensions', () => {
  assert.throws(
    () => scaleSamPromptsToInput([{ x: 1, y: 2 }], 0, 100, 10, 10),
    /Invalid SAM coordinate dimensions/,
  )
})
