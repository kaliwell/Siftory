const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { mapRemoteEntry, normalizeRemotePath } = loadTsModule('electron/remoteSftpService.ts')

test('SFTP remote paths use POSIX rules and reject unsafe input', () => {
  assert.equal(normalizeRemotePath('/var//log/../tmp'), '/var/tmp')
  assert.equal(normalizeRemotePath('.'), '.')
  assert.equal(normalizeRemotePath('C:\\Windows'), null)
  assert.equal(normalizeRemotePath(`bad\0path`), null)
  assert.equal(normalizeRemotePath(''), null)
  assert.equal(normalizeRemotePath('x'.repeat(4097)), null)
})

test('SFTP entries preserve remote metadata and join paths as POSIX', () => {
  const entry = mapRemoteEntry('/home/demo', {
    filename: '文档.txt',
    longname: '-rw-r--r-- 1 demo demo 42 文档.txt',
    attrs: {
      size: 42,
      uid: 1000,
      gid: 1000,
      mode: 0o100644,
      atime: 100,
      mtime: 200,
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    },
  })
  assert.equal(entry.path, '/home/demo/文档.txt')
  assert.equal(entry.type, 'file')
  assert.equal(entry.size, 42)
  assert.equal(entry.modifiedAt, 200000)
})
