const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { SessionSearchResultCache } = loadTsModule('electron/assetSearchResultCache.ts')

test('session search results resolve exact task/result identities and latest result', () => {
  const cache = new SessionSearchResultCache(3)
  const first = { taskId: 'task-1', resultId: 'result-1', value: 'first' }
  const second = { taskId: 'task-2', resultId: 'result-2', value: 'second' }
  cache.put(first)
  cache.put(second)

  assert.equal(cache.get({ taskId: 'task-1' }), first)
  assert.equal(cache.get({ resultId: 'result-2' }), second)
  assert.equal(cache.get({ taskId: 'task-1', resultId: 'result-2' }), null)
  assert.equal(cache.get(), second)
  assert.equal(cache.get({ taskId: 'missing' }), null)
})

test('session search result history replaces task results and evicts stale identities', () => {
  const cache = new SessionSearchResultCache(2)
  cache.put({ taskId: 'task-1', resultId: 'result-1' })
  cache.put({ taskId: 'task-1', resultId: 'result-1b' })
  assert.equal(cache.get({ resultId: 'result-1' }), null)
  assert.equal(cache.get({ taskId: 'task-1' }).resultId, 'result-1b')

  cache.put({ taskId: 'task-2', resultId: 'result-2' })
  cache.put({ taskId: 'task-3', resultId: 'result-3' })
  assert.equal(cache.get({ taskId: 'task-1' }), null)
  assert.equal(cache.get().resultId, 'result-3')

  cache.clear()
  assert.equal(cache.get(), null)
})
