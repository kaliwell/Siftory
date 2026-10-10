const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { sortImageSearchResults } = loadTsModule('src/components/imageSearchSort.ts')

const results = [
  { path: 'raster-high.jpg', score: 0.99, sourceKind: undefined },
  { path: 'project-high.psd', score: 0.91, sourceKind: 'project' },
  { path: 'raster-low.png', score: 0.8, sourceKind: undefined },
  { path: 'project-low.ai', score: 0.75, sourceKind: 'project' },
]

test('project-first sorting groups project files ahead while preserving relevance order', () => {
  const sorted = sortImageSearchResults(results, 'projectFirst')

  assert.deepEqual(
    sorted.map((result) => result.path),
    ['project-high.psd', 'project-low.ai', 'raster-high.jpg', 'raster-low.png'],
  )
  assert.deepEqual(
    results.map((result) => result.path),
    ['raster-high.jpg', 'project-high.psd', 'raster-low.png', 'project-low.ai'],
  )
})

test('score sorting remains available for mixed project and raster results', () => {
  const sorted = sortImageSearchResults(results, 'score')
  assert.deepEqual(
    sorted.map((result) => result.path),
    ['raster-high.jpg', 'project-high.psd', 'raster-low.png', 'project-low.ai'],
  )
})
