const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')
const { readSharpFileSnapshot } = loadTsModule('electron/sharpFileSnapshot.ts')

test('immutable source bytes preserve thumbnail output after the source is deleted', async () => {
  const cache = sharp.cache()
  sharp.cache(false)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-snapshot-parity-'))
  try {
    for (const format of ['jpeg', 'png', 'webp', 'tiff', 'avif']) {
      const file = path.join(root, `image.${format}`)
      await sharp({ create: { width: 73, height: 41, channels: 4, background: '#147dac99' } })
        .toFormat(format)
        .toFile(file)
      const thumbnail = (input) =>
        sharp(input)
          .rotate()
          .resize(32, 32, { fit: 'inside', withoutEnlargement: true })
          .webp({ effort: 2, quality: 80 })
          .toBuffer()
      const expected = await thumbnail(file)
      const source = await readSharpFileSnapshot(file)
      assert.deepEqual(source, await fs.readFile(file))
      await fs.unlink(file)
      assert.deepEqual(await thumbnail(source), expected)
      await assert.rejects(readSharpFileSnapshot(file), { code: 'ENOENT' })
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    sharp.cache({ memory: cache.memory.max, files: cache.files.max, items: cache.items.max })
  }
})

test('empty files, directories and existing size limits reject before native decoding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-snapshot-limits-'))
  try {
    const file = path.join(root, 'image.png')
    await fs.writeFile(file, '')
    await assert.rejects(readSharpFileSnapshot(file), /Invalid image source size/)
    await fs.writeFile(file, '12345')
    await assert.rejects(readSharpFileSnapshot(file, 4), /Invalid image source size/)
    await assert.rejects(readSharpFileSnapshot(root))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a file changed during a bounded read is rejected and its handle is closed', async (t) => {
  let stats = 0,
    closed = 0,
    reads = 0
  t.mock.method(fs, 'open', async () => ({
    stat: async () => ({ isFile: () => true, size: ++stats === 1 ? 4 : 5, mtimeMs: 1 }),
    read: async (buffer) => {
      reads++
      buffer.fill(1)
      return { bytesRead: 4 }
    },
    close: async () => {
      closed++
    },
  }))
  await assert.rejects(readSharpFileSnapshot('fixture'), /changed while reading/)
  assert.equal(reads, 1)
  assert.equal(closed, 1)
})

test('thousands of disappearing sources fail safely in an isolated decode process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-snapshot-missing-'))
  try {
    const helper = path.resolve(__dirname, 'guard-utils.cjs')
    const script = `const {readSharpFileSnapshot}=require(${JSON.stringify(helper)}).loadTsModule('electron/sharpFileSnapshot.ts');const sharp=require('sharp'),path=require('node:path');let next=0,errors=0,decoded=0;async function work(){for(;;){const id=next++;if(id>=4000)return;try{const bytes=await readSharpFileSnapshot(path.join(${JSON.stringify(root)},'missing-'+id+'.png'));await sharp(bytes).metadata();decoded++}catch{errors++}}}Promise.all(Array.from({length:8},work)).then(()=>console.log(JSON.stringify({errors,decoded})))`
    const result = cp.spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { errors: 4000, decoded: 0 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
