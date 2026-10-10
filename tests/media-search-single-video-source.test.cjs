const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('video sources expose separate single-video, multi-video, and folder pickers', () => {
  const controls = read('src/components/MediaSearchControls.tsx')
  const panel = read('src/components/MediaSearchPanel.tsx')

  assert.match(controls, /data-testid="media-search-select-single-video"/)
  assert.match(controls, /onClick=\{onChooseSingleVideo\}/)
  assert.match(controls, /data-testid="media-search-select-videos"/)
  assert.match(controls, /data-testid="media-search-select-folders"/)
  assert.match(panel, /choosePaths\('single-video'\)/)
  assert.match(panel, /choosePaths\('videos'\)/)
  assert.match(panel, /choosePaths\('folders'\)/)
})

test('single-video IPC uses a file-only dialog and validates the selected video', () => {
  const contract = read('shared/ipc/media-search.ts')
  const preload = read('electron/preload.ts')
  const ipc = read('electron/mediaSearchIpc.ts')

  assert.match(contract, /'single-video' \| 'videos' \| 'folders'/)
  assert.match(preload, /selectVideoPaths: \(mode\).*selectVideoPaths', mode/s)
  assert.match(ipc, /mode === 'single-video'[\s\S]*?\['openFile'\]/)
  assert.match(ipc, /mode === 'folders'[\s\S]*?stat\.isDirectory\(\)/)
  assert.match(ipc, /stat\.isFile\(\) && isVideoPath\(filePath\)/)
  assert.match(ipc, /mode === 'single-video' && paths\.length > 1/)
})
