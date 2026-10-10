// ── fileManagerIpc watcher lifecycle test ───────────────────
// Verifies createDirChangeSender (isolated) AND the wiring that
// connects it to the real fs.watch entry object.
//
// No real fs.watch, no real Electron BrowserWindow — fast & deterministic.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const fmIpc = loadTsModule('electron/fileManagerIpc.ts')

describe('createDirChangeSender (isolated)', () => {
  it('sends fm:dir-changed to the current window', () => {
    const sent = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (ch, d) => sent.push({ channel: ch, dir: d }) },
    }
    const sender = fmIpc.createDirChangeSender(() => win, 'C:\\test', 0)
    const entry = { timer: null }

    sender(entry)
    assert.strictEqual(sent.length, 0, 'scheduled, not sent synchronously')

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 1)
        assert.strictEqual(sent[0].channel, 'fm:dir-changed')
        assert.strictEqual(sent[0].dir, 'C:\\test')
        resolve()
      }, 10)
    })
  })

  it('does NOT send when getter returns null (window closed)', () => {
    const sender = fmIpc.createDirChangeSender(() => null, 'C:\\test', 0)
    const entry = { timer: null }

    sender(entry)

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(entry.timer, null, 'timer should be cleared')
        resolve()
      }, 10)
    })
  })

  it('does NOT send when window is destroyed', () => {
    const sent = []
    const win = {
      isDestroyed: () => true,
      webContents: { send: () => sent.push(1) },
    }
    const sender = fmIpc.createDirChangeSender(() => win, 'C:\\test', 0)
    const entry = { timer: null }

    sender(entry)

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 0)
        resolve()
      }, 10)
    })
  })

  it('getter is called at send-time — closed window before timer fires', () => {
    let currentWindow = null
    const sender = fmIpc.createDirChangeSender(() => currentWindow, 'C:\\test', 0)

    const sent = []
    currentWindow = {
      isDestroyed: () => false,
      webContents: { send: () => sent.push(1) },
    }
    const entry = { timer: null }
    sender(entry)

    // Window closes before the timeout fires
    currentWindow = null

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 0,
          'should NOT send to a closed window')
        resolve()
      }, 10)
    })
  })

  it('delivers to the window that is current when timer fires', () => {
    let currentWindow = null
    const sender = fmIpc.createDirChangeSender(() => currentWindow, 'C:\\test', 0)

    const sent = []
    currentWindow = {
      isDestroyed: () => false,
      webContents: { send: () => sent.push(1) },
    }
    const entry = { timer: null }
    sender(entry)

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 1)
        resolve()
      }, 10)
    })
  })

  it('debounces — only one send per window', () => {
    const sent = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: () => sent.push(1) },
    }
    const sender = fmIpc.createDirChangeSender(() => win, 'C:\\test', 300)
    const entry = { timer: null }

    for (let i = 0; i < 5; i++) {
      sender(entry)
    }
    assert.strictEqual(sent.length, 0, 'no immediate send')
    assert.ok(entry.timer !== null, 'entry.timer should be set by first call')

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 1, 'exactly one send after debounce')
        assert.strictEqual(entry.timer, null, 'entry.timer should be cleared')
        resolve()
      }, 350)
    })
  })
})

// ═════════════════════════════════════════════════════════════
// Wiring-layer tests — verify that createDirChangeSender
// correctly mutates entry.timer (the bug fixed in this PR)
// ═════════════════════════════════════════════════════════════

describe('createDirChangeSender wiring (entry.timer mutation)', () => {
  it('mutates entry.timer (not a copy) so debounce survives across calls', () => {
    const sent = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: () => sent.push(1) },
    }
    const sender = fmIpc.createDirChangeSender(() => win, 'C:\\test', 300)

    // Simulate the real entry object from fm-watch-dir
    const entry = { watcher: null, count: 1, timer: null }

    // First call: should set entry.timer
    sender(entry)
    const firstTimer = entry.timer
    assert.ok(firstTimer !== null, 'entry.timer should be set after first call')

    // Second call: entry.timer is still set → debounce kicks in, no new timer
    const beforeSecond = entry.timer
    sender(entry)
    assert.strictEqual(entry.timer, beforeSecond,
      'entry.timer should NOT change (debounce active)')

    // After debounce fires
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(sent.length, 1, 'exactly one event sent')
        assert.strictEqual(entry.timer, null, 'entry.timer cleared after firing')
        resolve()
      }, 350)
    })
  })

  it('entry.timer can be cleared by clearTimeout (fm-unwatch-dir compat)', () => {
    const sender = fmIpc.createDirChangeSender(() => null, 'C:\\test', 5000)
    const entry = { timer: null }

    sender(entry)
    assert.ok(entry.timer !== null, 'timer set')

    clearTimeout(entry.timer)
    entry.timer = null

    // No-op — timer already cleared, sender should not crash
    sender(entry)
    assert.ok(entry.timer !== null, 're-scheduled after manual clear')
    clearTimeout(entry.timer)
  })
})

describe('directory watcher disposal', () => {
  it('clears the debounce timer and closes the watcher exactly once', () => {
    let closeCount = 0
    const entry = {
      watcher: { close: () => closeCount++ },
      timer: setTimeout(() => assert.fail('disposed timer must not fire'), 5000),
      closed: false,
    }

    fmIpc.disposeDirWatcherEntry(entry)
    fmIpc.disposeDirWatcherEntry(entry)

    assert.equal(entry.timer, null)
    assert.equal(entry.closed, true)
    assert.equal(closeCount, 1)
  })

  it('tolerates an operating-system watcher that is already closed', () => {
    const entry = {
      watcher: {
        close: () => {
          throw new Error('already closed')
        },
      },
      timer: null,
      closed: false,
    }
    assert.doesNotThrow(() => fmIpc.disposeDirWatcherEntry(entry))
    assert.equal(entry.closed, true)
  })

  it('wires error, renderer destruction, ownership and application-exit cleanup', () => {
    const root = path.resolve(__dirname, '..')
    const source = fs.readFileSync(path.join(root, 'electron', 'fileManagerIpc.ts'), 'utf8')
    const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8')
    assert.match(source, /watcher\.on\('error',[\s\S]*removeDirWatcher\(normalizedDir, entry\)/)
    assert.match(source, /owners: new Map\(\[\[event\.sender\.id, 1\]\]\)/)
    assert.match(source, /sender\.once\('destroyed'/)
    assert.match(source, /releaseDirWatcherOwner\(normalizedDir, entry, sender\.id, true\)/)
    assert.match(main, /disposeFileManagerWatchers\(\)/)
  })
})
