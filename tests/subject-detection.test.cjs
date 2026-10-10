// Unit tests for subject detection bounding-box helpers
// (electron/subjectBoxes.ts): IoU and non-maximum suppression.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { iou, nms, orientedDimensions, pickPrimarySubject } = loadTsModule(
  'electron/subjectBoxes.ts',
)

const box = (x, y, w, h, confidence, label = 'person') => ({ x, y, w, h, confidence, label })

test('iou is 1 for identical boxes and 0 for disjoint boxes', () => {
  const a = box(0, 0, 10, 10, 0.9)
  assert.equal(iou(a, { ...a }), 1)
  assert.equal(iou(a, box(100, 100, 10, 10, 0.9)), 0)
})

test('iou computes partial overlap correctly', () => {
  const a = box(0, 0, 10, 10, 0.9)
  const b = box(5, 0, 10, 10, 0.9)
  // intersection 5*10=50, union 100+100-50=150
  assert.ok(Math.abs(iou(a, b) - 50 / 150) < 1e-9)
})

test('nms keeps the highest-confidence box among overlaps', () => {
  const boxes = [
    box(0, 0, 10, 10, 0.9, 'person'),
    box(1, 1, 10, 10, 0.5, 'person'), // heavily overlapping, lower conf
    box(100, 100, 10, 10, 0.7, 'dog'), // disjoint
  ]
  const kept = nms(boxes, 0.45)
  assert.equal(kept.length, 2)
  assert.equal(kept[0].confidence, 0.9)
  assert.equal(kept[1].label, 'dog')
})

test('nms respects the iou threshold boundary', () => {
  const a = box(0, 0, 10, 10, 0.9)
  const b = box(5, 0, 10, 10, 0.8) // iou = 1/3
  assert.equal(nms([a, b], 0.5).length, 2) // below threshold → both kept
  assert.equal(nms([a, b], 0.3).length, 1) // above threshold → suppressed
})

test('nms handles empty input', () => {
  assert.deepEqual(nms([], 0.45), [])
})

test('pickPrimarySubject prefers the largest YOLO subject over a small confident one', () => {
  const subjects = [
    box(500, 10, 30, 30, 0.95, 'sports ball'), // small but most confident (the "circle icon" case)
    box(50, 50, 300, 400, 0.6, 'cat'), // the actual main subject
    box(600, 400, 40, 40, 0.5, 'cup'),
  ]
  const picked = pickPrimarySubject(subjects)
  assert.equal(picked.label, 'cat')
})

test('pickPrimarySubject falls back to the pseudo subject when no YOLO detection exists', () => {
  const fallback = box(10, 10, 200, 200, 0.5, 'subject')
  assert.equal(pickPrimarySubject([fallback]), fallback)
  const center = box(0, 0, 100, 100, 0.4, 'subject (center)')
  assert.equal(pickPrimarySubject([center]), center)
})

test('pickPrimarySubject returns null for empty input', () => {
  assert.equal(pickPrimarySubject([]), null)
})

test('orientedDimensions keeps raw dims for non-transposing orientations', () => {
  assert.deepEqual(orientedDimensions(4000, 3000, undefined), { width: 4000, height: 3000 })
  assert.deepEqual(orientedDimensions(4000, 3000, 1), { width: 4000, height: 3000 })
  assert.deepEqual(orientedDimensions(4000, 3000, 3), { width: 4000, height: 3000 }) // 180°
  assert.deepEqual(orientedDimensions(4000, 3000, 4), { width: 4000, height: 3000 }) // flip
})

test('orientedDimensions swaps dims for EXIF 5-8 (90°/270° rotations)', () => {
  for (const orientation of [5, 6, 7, 8]) {
    assert.deepEqual(orientedDimensions(4000, 3000, orientation), { width: 3000, height: 4000 })
  }
})
