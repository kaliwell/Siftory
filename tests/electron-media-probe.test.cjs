const assert = require('node:assert/strict')
const test = require('node:test')
const { loopbackEndpoint } = require('./electron-media-probe.cjs')

test('media debugger is restricted to the launched loopback port without credentials', () => {
  assert.equal(
    loopbackEndpoint('ws://127.0.0.1:43210/devtools/page/test', 'ws:', '43210').port,
    '43210',
  )
  for (const value of [
    'ws://example.com:43210/devtools/page/test',
    'ws://127.0.0.1:43211/devtools/page/test',
    'ws://user:password@127.0.0.1:43210/devtools/page/test',
    'wss://127.0.0.1:43210/devtools/page/test',
    'file:///devtools/page/test',
  ])
    assert.throws(() => loopbackEndpoint(value, 'ws:', '43210'))
})
