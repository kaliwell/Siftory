const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const { createSubjectDisplayPreview } = loadTsModule('electron/subjectDisplayPreview.ts')

test('subject display preview decodes the source above thumbnail-cache resolution', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-original-preview-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const imagePath = path.join(tmpDir, 'large.png')
  await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: { r: 50, g: 100, b: 150 },
    },
  })
    .png()
    .toFile(imagePath)

  const result = await createSubjectDisplayPreview(imagePath, 1440, 1000)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sourceWidth, 1600)
  assert.equal(result.sourceHeight, 1200)
  assert.equal(result.width, 1333)
  assert.equal(result.height, 1000)
  assert.ok(result.width > 256)
  assert.match(result.dataUrl, /^data:image\/webp;base64,/)
})

test('subject display preview preserves a smaller original without enlargement', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-small-preview-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const imagePath = path.join(tmpDir, 'small.png')
  await sharp({
    create: { width: 320, height: 200, channels: 3, background: 'red' },
  })
    .png()
    .toFile(imagePath)
  const result = await createSubjectDisplayPreview(imagePath, 1400, 1000)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.width, 320)
  assert.equal(result.height, 200)
})

test('Subject Picker requests an original-file DPI preview with thumbnail fallback', () => {
  const root = path.resolve(__dirname, '..')
  const picker = fs.readFileSync(path.join(root, 'src/components/SubjectPickerModal.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(root, 'electron/samSegmentIpc.ts'), 'utf8')
  assert.match(picker, /window\.electronAPI\.sam[\s\S]*\.preview\(/)
  assert.match(picker, /window\.devicePixelRatio/)
  assert.match(picker, /originalPreviewUrl \?/)
  assert.match(picker, /<ThumbnailImage/)
  assert.match(ipc, /MAX_PREVIEW_DIMENSION = 2048/)
  assert.match(ipc, /isAuthorizedSender\(event, getMainWindow\)/)
})
