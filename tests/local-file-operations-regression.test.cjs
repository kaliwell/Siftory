const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { Readable } = require('node:stream')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

const handlers = new Map()
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    shell: {
      async trashItem(source) {
        // A real move into the isolated fixture's recycle folder, never system data.
        await fsp.rename(source, source + '.recycled')
      },
    },
  },
}
loadTsModule('electron/ipcAuthorization.ts').secureIpcMain = {
  handle: (name, handler) => handlers.set(name, handler),
}
loadTsModule('electron/fileManagerIpc.ts').registerFileManagerIpc(() => null)
const event = { sender: { id: 81, send() {}, once() {} } }
const noReplace = loadTsModule('electron/localFileNoReplace.ts')
const nativeMoves = require(
  path.join(
    __dirname,
    '..',
    'native',
    process.versions.electron ? 'build-electron' : 'build-node',
    'Release',
    'fast_scanner.node',
  ),
)
assert.equal(
  typeof nativeMoves.movePathWithoutOverwriteAsync,
  'function',
  'Rebuild the native addon before testing atomic moves',
)

async function fixture(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siftory-operation-test-'))
  try {
    await run(dir)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('siftory-operation-test-'))
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('rename IPC preserves existing files, accepts same name and case-only Windows names', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'draft.psd'),
      dst = path.join(dir, 'final.psd')
    await fsp.writeFile(src, 'source')
    await fsp.writeFile(dst, 'valuable-target')
    const rename = handlers.get('fm-rename-file')
    assert.equal((await rename(event, src, 'final.psd')).success, false)
    assert.equal(await fsp.readFile(src, 'utf8'), 'source')
    assert.equal(await fsp.readFile(dst, 'utf8'), 'valuable-target')
    assert.equal((await rename(event, src, 'draft.psd')).success, true)
    if (process.platform === 'win32') {
      assert.equal((await rename(event, src, 'DRAFT.psd')).success, true)
      assert.ok((await fsp.readdir(dir)).includes('DRAFT.psd'))
    }
  })
})

test('rename publication cannot replace a file created after the existence check', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'source.txt'),
      dst = path.join(dir, 'target.txt')
    await fsp.writeFile(src, 'source')
    const originalMove = nativeMoves.movePathWithoutOverwriteAsync
    nativeMoves.movePathWithoutOverwriteAsync = async (from, to) => {
      if (to === path.toNamespacedPath(dst)) await fsp.writeFile(dst, 'late-target', { flag: 'wx' })
      return originalMove(from, to)
    }
    try {
      assert.equal((await handlers.get('fm-rename-file')(event, src, 'target.txt')).success, false)
    } finally {
      nativeMoves.movePathWithoutOverwriteAsync = originalMove
    }
    assert.equal(await fsp.readFile(src, 'utf8'), 'source')
    assert.equal(await fsp.readFile(dst, 'utf8'), 'late-target')
  })
})

test(
  'Windows directory rename keeps existing directories and moves a fresh destination',
  { skip: process.platform !== 'win32' },
  async () => {
    await fixture(async (dir) => {
      const src = path.join(dir, 'source'),
        dst = path.join(dir, 'target')
      await fsp.mkdir(src)
      await fsp.mkdir(dst)
      await fsp.writeFile(path.join(src, 'a.txt'), 'source')
      assert.equal((await handlers.get('fm-rename-file')(event, src, 'target')).success, false)
      assert.equal(await fsp.readFile(path.join(src, 'a.txt'), 'utf8'), 'source')
      assert.equal((await handlers.get('fm-rename-file')(event, src, 'fresh')).success, true)
      assert.equal(await fsp.readFile(path.join(dir, 'fresh', 'a.txt'), 'utf8'), 'source')
    })
  },
)

for (const scenario of ['absent', 'existing', 'cross-volume']) {
  test(`default cross-directory move succeeds: ${scenario}`, async () => {
    await fixture(async (dir) => {
      const from = path.join(dir, 'from'),
        to = path.join(dir, 'to')
      await fsp.mkdir(from)
      await fsp.mkdir(to)
      const src = path.join(from, 'asset.txt'),
        dst = path.join(to, 'asset.txt')
      await fsp.writeFile(src, 'source')
      if (scenario === 'existing') await fsp.writeFile(dst, 'old-target')
      const originalMove = nativeMoves.movePathWithoutOverwriteAsync
      if (scenario === 'cross-volume')
        nativeMoves.movePathWithoutOverwriteAsync = async () => {
          throw Object.assign(new Error('different volume'), { code: 'EXDEV' })
        }
      let result
      try {
        result = await handlers.get('fm-move-files')(event, [src], to)
      } finally {
        nativeMoves.movePathWithoutOverwriteAsync = originalMove
      }
      assert.equal(result[0].success, true, JSON.stringify(result))
      assert.equal(await fsp.readFile(dst, 'utf8'), 'source')
      assert.equal(fs.existsSync(src), false)
      if (scenario !== 'absent')
        assert.equal(await fsp.readFile(src + '.recycled', 'utf8'), 'source')
    })
  })
}

test('replacement commit failure retains both original source and previous destination', async () => {
  await fixture(async (dir) => {
    const from = path.join(dir, 'from'),
      to = path.join(dir, 'to')
    await fsp.mkdir(from)
    await fsp.mkdir(to)
    const src = path.join(from, 'asset.txt'),
      dst = path.join(to, 'asset.txt')
    await fsp.writeFile(src, 'source')
    await fsp.writeFile(dst, 'old-target')
    const originalRename = fsp.rename
    fsp.rename = async (a, b) => {
      if (a.endsWith('.part') && b === dst)
        throw Object.assign(new Error('commit fault'), { code: 'EIO' })
      return originalRename(a, b)
    }
    let result
    try {
      result = await handlers.get('fm-move-files')(event, [src], to)
    } finally {
      fsp.rename = originalRename
    }
    assert.equal(result[0].success, false)
    assert.equal(await fsp.readFile(src, 'utf8'), 'source')
    assert.equal(await fsp.readFile(dst, 'utf8'), 'old-target')
    assert.deepEqual(await fsp.readdir(to), ['asset.txt'])
  })
})

test('atomic native moves never call JS link, unlink, rename or copy fallback, including case-only rename', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'draft.psd'),
      dst = path.join(dir, 'final.psd')
    await fsp.writeFile(src, 'latest source')
    const identity = await fsp.stat(src, { bigint: true })
    const originals = new Map(
      ['link', 'unlink', 'rename', 'copyFile'].map((name) => [name, fsp[name]]),
    )
    for (const name of originals.keys()) {
      fsp[name] = async () => {
        throw Object.assign(new Error('JS mutation must not be reached'), { code: 'EPERM' })
      }
    }
    try {
      await noReplace.movePathWithoutOverwrite(src, dst, true)
      assert.equal(fs.existsSync(src), false)
      assert.equal(await fsp.readFile(dst, 'utf8'), 'latest source')
      assert.equal((await fsp.stat(dst, { bigint: true })).ino, identity.ino)
      await noReplace.movePathWithoutOverwrite(dst, path.join(dir, 'FINAL.psd'), true)
      assert.ok((await fsp.readdir(dir)).includes('FINAL.psd'))
    } finally {
      for (const [name, original] of originals) fsp[name] = original
    }
  })
})

test('an atomic save recreated at the old path after native move is never unlinked', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'draft.psd'),
      dst = path.join(dir, 'final.psd')
    await fsp.writeFile(src, 'moved revision')
    const originalMove = nativeMoves.movePathWithoutOverwriteAsync
    nativeMoves.movePathWithoutOverwriteAsync = async (from, to) => {
      await originalMove(from, to)
      // Equivalent to an editor publishing a new save at the previous name,
      // after the OS move but before its JS caller resumes.
      await fsp.writeFile(src, 'newly saved revision', { flag: 'wx' })
    }
    try {
      await noReplace.movePathWithoutOverwrite(src, dst, true)
    } finally {
      nativeMoves.movePathWithoutOverwriteAsync = originalMove
    }
    assert.equal(await fsp.readFile(dst, 'utf8'), 'moved revision')
    assert.equal(await fsp.readFile(src, 'utf8'), 'newly saved revision')
  })
})

test('competing native publishers have one winner and preserve the losing source', async () => {
  await fixture(async (dir) => {
    const first = path.join(dir, 'one.txt'),
      second = path.join(dir, 'two.txt'),
      target = path.join(dir, 'target.txt')
    await fsp.writeFile(first, 'one')
    await fsp.writeFile(second, 'two')
    const outcomes = await Promise.allSettled([
      nativeMoves.movePathWithoutOverwriteAsync(first, target),
      nativeMoves.movePathWithoutOverwriteAsync(second, target),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    assert.equal(failed.reason.code, 'EEXIST')
    const winner = await fsp.readFile(target, 'utf8')
    assert.equal(
      await fsp.readFile(winner === 'one' ? second : first, 'utf8'),
      winner === 'one' ? 'two' : 'one',
    )
    assert.equal(fs.existsSync(winner === 'one' ? first : second), false)
  })
})

test('native failure preserves the source and leaves no partial target', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'source.txt'),
      target = path.join(dir, 'missing-parent', 'target.txt')
    await fsp.writeFile(src, 'preserved source')
    await assert.rejects(nativeMoves.movePathWithoutOverwriteAsync(src, target), { code: 'ENOENT' })
    assert.equal(await fsp.readFile(src, 'utf8'), 'preserved source')
    assert.equal(fs.existsSync(target), false)
    assert.deepEqual(await fsp.readdir(dir), ['source.txt'])
  })
})

test('copy fallback for no-replace publication preserves existing targets', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'source'),
      dst = path.join(dir, 'target')
    await fsp.writeFile(src, 'source')
    const originalLink = fsp.link
    fsp.link = async () => {
      throw Object.assign(new Error('links unsupported'), { code: 'ENOTSUP' })
    }
    try {
      await noReplace.publishFileWithoutOverwrite(src, dst)
      await assert.rejects(noReplace.publishFileWithoutOverwrite(src, dst), { code: 'EEXIST' })
    } finally {
      fsp.link = originalLink
    }
    assert.equal(await fsp.readFile(dst, 'utf8'), 'source')
    assert.equal(await fsp.readFile(src, 'utf8'), 'source')
  })
})

test('download finalization rejects a target created during transfer', async () => {
  await fixture(async (dir) => {
    const filename = path.resolve(__dirname, '../electron/remoteTransferService.ts')
    const source = fs.readFileSync(filename, 'utf8') + '\nexport const testDownload = runDownload;'
    const mod = new Module(filename, module)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    const originalRequire = mod.require.bind(mod)
    mod.require = (id) =>
      id === './localFileNoReplace' ? noReplace : id.startsWith('./') ? {} : originalRequire(id)
    mod._compile(
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    )
    const target = path.join(dir, 'asset.txt')
    const job = {
      localPath: target,
      remotePath: '/fixture/asset.txt',
      profile: {},
      task: mod.exports.createTransferTask(
        'fixture',
        'download',
        'asset.txt',
        'asset.txt',
        6,
        'ask',
      ),
    }
    const sftp = {
      createReadStream() {
        fs.writeFileSync(target, 'local-created-during-transfer')
        return Readable.from(['remote'])
      },
    }
    await assert.rejects(mod.exports.testDownload(job, sftp), { code: 'EEXIST' })
    assert.equal(await fsp.readFile(target, 'utf8'), 'local-created-during-transfer')
    assert.deepEqual(await fsp.readdir(dir), ['asset.txt'])
  })
})
