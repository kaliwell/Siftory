const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildAssetFeedbackSourceSnapshot } = loadTsModule('electron/assetFeedbackSnapshot.ts')

const category = (id, name) => ({
  id,
  name,
  color: '#fff',
  parentId: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
})
const tag = (id, name) => ({ id, name, color: '#fff', createdAt: 1, updatedAt: 1 })
const assignment = (assetId, targetId, overrides = {}) => ({
  id: assetId,
  assetId,
  categoryId: targetId,
  confidence: 1,
  source: 'manual',
  status: 'confirmed',
  confirmedByUser: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

test('feedback snapshot builds active positive and rejected negative samples by target', () => {
  const assets = new Map([
    [1, { id: 1, path: 'C:\\one.jpg', size: 1, modifiedTime: 1, missing: false }],
    [2, { id: 2, path: 'C:\\two.jpg', size: 1, modifiedTime: 1, missing: false }],
    [
      3,
      { id: 3, path: 'C:\\archived.jpg', size: 1, modifiedTime: 1, archived: true, missing: false },
    ],
  ])
  const snapshot = buildAssetFeedbackSourceSnapshot({
    categories: [category(10, 'People')],
    tags: [tag(20, 'Favorite')],
    categoryAssignments: [assignment(1, 10), assignment(3, 10)],
    tagAssignments: [
      assignment(2, 0, { tagId: 20, categoryId: undefined, source: 'cluster' }),
    ],
    references: [],
    rejectedSuggestions: [
      {
        id: 1,
        assetId: 2,
        categoryId: 10,
        confidence: 0.2,
        source: 'reference_image',
        status: 'rejected',
        evidenceAssetIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    getAssetById: (id) => assets.get(id),
  })

  assert.deepEqual(
    snapshot.targets.map((target) => ({
      key: target.key,
      positives: target.positiveSamples,
      negatives: target.negativeSamples,
    })),
    [
      {
        key: 'category:10',
        positives: [{ path: 'C:\\one.jpg', weight: 1 }],
        negatives: [{ path: 'C:\\two.jpg', weight: 1 }],
      },
      {
        key: 'tag:20',
        positives: [{ path: 'C:\\two.jpg', weight: 0.75 }],
        negatives: [],
      },
    ],
  )
})

test('feedback snapshot filters unconfirmed assignments and bounds samples deterministically', () => {
  const assets = new Map(
    [1, 2, 3].map((id) => [
      id,
      { id, path: `C:\\${id}.jpg`, size: 1, modifiedTime: 1, missing: false },
    ]),
  )
  const snapshot = buildAssetFeedbackSourceSnapshot({
    categories: [category(10, 'People')],
    tags: [],
    categoryAssignments: [
      assignment(1, 10, { source: 'cluster' }),
      assignment(2, 10, { source: 'manual' }),
      assignment(3, 10, { confirmedByUser: false }),
    ],
    tagAssignments: [],
    references: [],
    rejectedSuggestions: [],
    getAssetById: (id) => assets.get(id),
    maximumPositiveSamples: 1,
  })

  assert.deepEqual(snapshot.targets[0].positiveSamples, [{ path: 'C:\\2.jpg', weight: 1 }])
  assert.equal(snapshot.targets[0].positiveSampleCount, 1)
})
