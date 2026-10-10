const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { WindowVisibilityMachine } = loadTsModule('electron/windowVisibilityState.ts')

test('window visibility state machine follows the complete hide and show transaction', () => {
  const machine = new WindowVisibilityMachine()
  assert.deepEqual(
    { state: machine.current().state, generation: machine.current().generation },
    { state: 'visible', generation: 0 },
  )

  const hiding = machine.begin(false, 'hotkey')
  assert.equal(hiding.state, 'preparing-hide')
  assert.equal(hiding.generation, 1)
  assert.equal(machine.wantsVisible(), false)
  assert.equal(machine.acceptsRendererMutation(1), false)
  assert.equal(machine.completeHidden(0), null)
  assert.equal(machine.completeHidden(1).state, 'hidden')
  assert.equal(machine.begin(false, 'settings'), null)

  const showing = machine.begin(true, 'second-instance')
  assert.equal(showing.state, 'preparing-show')
  assert.equal(showing.generation, 2)
  assert.equal(machine.acceptsRendererMutation(1), false)
  assert.equal(machine.acceptsRendererMutation(2), true)
  assert.equal(machine.completeVisible(1), null)
  assert.equal(machine.completeVisible(2).state, 'visible')
  assert.equal(machine.begin(true, 'recovery'), null)
})

test('a newer visibility request invalidates an unfinished renderer generation', () => {
  const machine = new WindowVisibilityMachine()
  const hiding = machine.begin(false, 'hotkey')
  machine.completeHidden(hiding.generation)
  const showing = machine.begin(true, 'hotkey')
  const interrupted = machine.begin(false, 'hotkey')

  assert.equal(interrupted.state, 'preparing-hide')
  assert.ok(interrupted.generation > showing.generation)
  assert.equal(machine.acceptsRendererMutation(showing.generation), false)
  assert.equal(machine.completeVisible(showing.generation), null)
  assert.equal(machine.completeHidden(interrupted.generation).state, 'hidden')
})

test('duplicate requests are idempotent while a transition is in flight', () => {
  const machine = new WindowVisibilityMachine()
  const hiding = machine.begin(false, 'settings')
  assert.equal(machine.begin(false, 'settings'), null)
  machine.completeHidden(hiding.generation)

  const showing = machine.begin(true, 'ai-control')
  assert.equal(machine.begin(true, 'second-instance'), null)
  assert.equal(machine.current().generation, showing.generation)
})

test('a natively hidden visible window can restart the guarded show transaction', () => {
  const machine = new WindowVisibilityMachine()
  const restarted = machine.restartVisible('recovery')
  assert.equal(restarted.state, 'preparing-show')
  assert.equal(restarted.generation, 1)
  assert.equal(machine.restartVisible('recovery'), null)
  assert.equal(machine.completeVisible(restarted.generation).state, 'visible')
})

test('topology invalidation fences visible, preparing-show and hidden generations', () => {
  const machine = new WindowVisibilityMachine()
  const recovery = machine.invalidate()
  assert.equal(recovery.state, 'preparing-show')
  assert.equal(machine.acceptsRendererMutation(0), false)
  const interrupted = machine.invalidate()
  assert.equal(machine.completeVisible(recovery.generation), null)
  assert.equal(machine.completeVisible(interrupted.generation).state, 'visible')
  const hiding = machine.begin(false, 'hotkey')
  machine.completeHidden(hiding.generation)
  const hidden = machine.invalidate()
  assert.equal(hidden.state, 'hidden')
  assert.equal(machine.wantsVisible(), false)
  assert.equal(machine.acceptsRendererMutation(hidden.generation), false)
})

test('suspend holds user intent through topology changes and in-suspend visibility requests', () => {
  const machine = new WindowVisibilityMachine()
  const held = machine.suspend()
  assert.equal(held.state, 'hidden')
  assert.equal(machine.wantsVisible(), true)
  assert.equal(machine.acceptsRendererMutation(held.generation), false)
  assert.equal(machine.suspend(), null)
  assert.equal(machine.invalidate().state, 'hidden')
  const hiding = machine.begin(false, 'settings')
  machine.completeHidden(hiding.generation)
  assert.equal(machine.resume().state, 'hidden')
  assert.equal(machine.resume(), null)
  machine.suspend()
  const showingIntent = machine.begin(true, 'second-instance')
  assert.equal(showingIntent.state, 'preparing-hide')
  machine.completeHidden(showingIntent.generation)
  const resumed = machine.resume()
  assert.equal(resumed.state, 'preparing-show')
  assert.equal(machine.completeVisible(resumed.generation).state, 'visible')
})
