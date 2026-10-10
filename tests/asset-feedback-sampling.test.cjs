const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  addBoundedFeedbackSample,
  assignmentFeedbackWeight,
  feedbackPathHash,
  feedbackPathKey,
} = loadTsModule('electron/assetFeedbackSampling.ts')

test('feedback path keys normalize separators, case, and trailing separators', () => {
  assert.equal(feedbackPathKey('C:/Media/Cat.JPG///'), 'c:\\media\\cat.jpg')
  assert.equal(feedbackPathKey('c:\\media\\cat.jpg'), 'c:\\media\\cat.jpg')
})

test('feedback path hash is stable and path-sensitive', () => {
  assert.equal(feedbackPathHash('c:\\media\\cat.jpg'), feedbackPathHash('c:\\media\\cat.jpg'))
  assert.notEqual(feedbackPathHash('c:\\media\\cat.jpg'), feedbackPathHash('c:\\media\\dog.jpg'))
})

test('bounded feedback samples deduplicate paths and keep the stronger weight', () => {
  const samples = new Map()
  addBoundedFeedbackSample(samples, { path: 'C:/Media/Cat.jpg', weight: 0.75 }, 4)
  addBoundedFeedbackSample(samples, { path: 'c:\\media\\cat.jpg\\', weight: 0.5 }, 4)

  assert.equal(samples.size, 1)
  assert.equal(samples.get('c:\\media\\cat.jpg').weight, 0.75)

  addBoundedFeedbackSample(samples, { path: 'c:\\media\\cat.jpg', weight: 1 }, 4)
  assert.equal(samples.size, 1)
  assert.equal(samples.get('c:\\media\\cat.jpg').weight, 1)
})

test('bounded feedback samples retain the highest-priority candidates at capacity', () => {
  const samples = new Map()
  addBoundedFeedbackSample(samples, { path: 'C:\\a.jpg', weight: 0.1 }, 2)
  addBoundedFeedbackSample(samples, { path: 'C:\\b.jpg', weight: 0.5 }, 2)
  addBoundedFeedbackSample(samples, { path: 'C:\\c.jpg', weight: 1 }, 2)

  assert.deepEqual(
    [...samples.values()]
      .map(({ path, weight }) => ({ path, weight }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: 'C:\\b.jpg', weight: 0.5 },
      { path: 'C:\\c.jpg', weight: 1 },
    ],
  )
})

test('assignment feedback weights preserve manual and cluster confidence policy', () => {
  assert.equal(assignmentFeedbackWeight('manual'), 1)
  assert.equal(assignmentFeedbackWeight('cluster'), 0.75)
  assert.equal(assignmentFeedbackWeight('reference_image'), 0.85)
  assert.equal(assignmentFeedbackWeight('ocr'), 0.85)
})
