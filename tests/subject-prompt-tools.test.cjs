const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.resolve(__dirname, '..')
const {
  MAX_SAM_PROMPTS,
  appendSubjectCorrection,
  buildSubjectBoxPrompts,
  clampSubjectPoint,
  subjectBoxFromPoints,
  subjectBoxPercentStyle,
} = loadTsModule('src/components/subjectPromptTools.ts')

test('subject prompt coordinates clamp into oriented source pixels', () => {
  assert.deepEqual(clampSubjectPoint({ x: -4.7, y: 999 }, 640, 480), { x: 0, y: 479 })
  assert.deepEqual(clampSubjectPoint({ x: 10.4, y: 20.6 }, 640, 480), { x: 10, y: 21 })
})

test('subject box overlay uses percentages instead of pixel-valued React styles', () => {
  assert.deepEqual(subjectBoxPercentStyle({ x: 700, y: 450 }, { x: 300, y: 150 }, 1000, 600), {
    left: '30%',
    top: '25%',
    width: '40%',
    height: '50%',
  })
  assert.equal(subjectBoxPercentStyle({ x: 1, y: 1 }, { x: 2, y: 2 }, 0, 100), null)
})

test('subject box converts to a bounded crop without a segmentation model', () => {
  assert.deepEqual(subjectBoxFromPoints({ x: 80, y: 70 }, { x: 10, y: 20 }), {
    x: 10,
    y: 20,
    w: 70,
    h: 50,
  })
  assert.equal(subjectBoxFromPoints({ x: 1, y: 1 }, { x: 3, y: 3 }), null)
})

test('box prompt uses SAM corner labels and preserves positive/negative corrections', () => {
  const prompts = [
    { x: 4, y: 5, label: 2 },
    { x: 90, y: 95, label: 3 },
    { x: 20, y: 25, label: 1 },
    { x: 30, y: 35, label: 0 },
  ]
  assert.deepEqual(buildSubjectBoxPrompts(prompts, { x: 80, y: 70 }, { x: 10, y: 20 }), [
    { x: 10, y: 20, label: 2 },
    { x: 80, y: 70, label: 3 },
    { x: 20, y: 25, label: 1 },
    { x: 30, y: 35, label: 0 },
  ])
  assert.equal(buildSubjectBoxPrompts([], { x: 1, y: 1 }, { x: 3, y: 3 }), null)
})

test('foreground/background corrections remain bounded', () => {
  let prompts = []
  for (let index = 0; index < MAX_SAM_PROMPTS + 10; index += 1) {
    prompts = appendSubjectCorrection(prompts, { x: index, y: index }, index % 2 ? 0 : 1)
  }
  assert.equal(prompts.length, MAX_SAM_PROMPTS)
  assert.equal(prompts.at(-1).x, MAX_SAM_PROMPTS + 9)
  assert.equal(
    prompts.some((prompt) => prompt.label === 0),
    true,
  )
  assert.equal(
    prompts.some((prompt) => prompt.label === 1),
    true,
  )
})

test('picker and IPC expose box, add, subtract, undo, and redo contracts', () => {
  const picker = fs.readFileSync(path.join(root, 'src/components/SubjectPickerModal.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(root, 'electron/samSegmentIpc.ts'), 'utf8')
  const subjectSearch = fs.readFileSync(path.join(root, 'electron/subjectSearchService.ts'), 'utf8')
  for (const marker of [
    "'box'",
    "'add'",
    "'subtract'",
    'restoreHistory(historyIndex - 1)',
    'restoreHistory(historyIndex + 1)',
  ]) {
    assert.match(picker, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(ipc, /MAX_POINTS = 32/)
  assert.match(ipc, /p\.label === 2/)
  assert.match(ipc, /p\.label === 3/)
  assert.match(picker, /\.sam\s*\.status\(\)/)
  assert.match(picker, /samReady !== true/)
  assert.match(picker, /label: 'manual'/)
  assert.match(subjectSearch, /bbox\.label === 'sam' \|\| bbox\.label === 'manual'/)
})
