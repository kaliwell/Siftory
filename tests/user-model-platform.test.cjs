const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.resolve(__dirname, '..')
const {
  USER_MODEL_SLOTS,
  getUserModelProfileDefinition,
  getUserModelSlotDefinition,
  normalizeUserModelSlotId,
} = loadTsModule('shared/userModelPlatform.ts')
const {
  getImageAdapterSpec,
  imageTensorDimensions,
  inspectUserModelContract,
  parseFaceDetections,
  parseObjectDetections,
  parseRetinaFaceDetections,
  parseScrfdFaceDetections,
  parseSplitDetections,
  preprocessRgb,
  resolveTensorName,
} = loadTsModule('electron/userModelRuntimeAdapters.ts')

const riskyComponentIds = [
  'ultralytics-yolov8n-coco-onnx',
  'lindevs-yolov8n-face-onnx',
  'cvlface-adaface-ir101-webface12m-onnx',
  'osnet-ain-x1-msmt17-onnx',
  'pulpcut-mobilesam-onnx',
]

test('user model platform exposes six bounded ONNX compatibility slots', () => {
  assert.equal(USER_MODEL_SLOTS.length, 6)
  assert.equal(new Set(USER_MODEL_SLOTS.map((slot) => slot.id)).size, 6)
  for (const slot of USER_MODEL_SLOTS) {
    assert.match(slot.targetFileName, /\.onnx$/)
    assert.match(slot.compatibility, /ONNX/i)
    assert.ok(slot.maxSizeBytes >= 1024 * 1024)
    assert.ok(slot.profiles.length >= 1)
    assert.equal(getUserModelProfileDefinition(slot.id)?.id, slot.defaultProfileId)
    assert.equal(new Set(slot.profiles.map((profile) => profile.id)).size, slot.profiles.length)
    assert.equal(getUserModelSlotDefinition(slot.id)?.id, slot.id)
  }
  assert.equal(normalizeUserModelSlotId('../model'), null)
  assert.equal(normalizeUserModelSlotId('unknown'), null)
})

test('compatibility profiles cover common detector, embedding, ReID and SAM exports', () => {
  const adapters = new Set(
    USER_MODEL_SLOTS.flatMap((slot) => slot.profiles.map((profile) => profile.adapter)),
  )
  for (const adapter of [
    'yolov8-detection',
    'yolov5-detection',
    'nms-detection',
    'split-detection',
    'split-face',
    'scrfd-face',
    'scrfd-face-ordered',
    'retinaface-priorbox',
    'arcface-112',
    'facenet-160',
    'reid-256x128',
    'reid-384x128',
    'sam-hwc-1024',
    'sam-nchw-1024',
  ]) {
    assert.ok(adapters.has(adapter), adapter)
  }
  assert.equal(getUserModelProfileDefinition('subject-detector', 'face-arcface-112'), undefined)
})

test('RGB preprocessing supports NCHW/HWC and selectable normalization', () => {
  const hwc = preprocessRgb([255, 128, 0], {
    width: 1,
    height: 1,
    layout: 'hwc',
    normalization: 'zero-to-one',
  })
  assert.ok(Math.abs(hwc[0] - 1) < 1e-6)
  assert.ok(Math.abs(hwc[1] - 128 / 255) < 1e-6)
  const nchw = preprocessRgb([255, 0, 128], {
    width: 1,
    height: 1,
    layout: 'nchw',
    normalization: 'minus-one-to-one',
  })
  assert.ok(Math.abs(nchw[0] - 1) < 1e-6)
  assert.ok(Math.abs(nchw[1] + 1) < 1e-6)
  assert.ok(Math.abs(nchw[2] - (128 / 127.5 - 1)) < 1e-6)

  const retinaFace = preprocessRgb([123, 117, 104], {
    width: 1,
    height: 1,
    layout: 'nchw',
    normalization: 'retinaface-bgr-mean',
  })
  assert.deepEqual(Array.from(retinaFace), [0, 0, 0])
})

test('fixed ONNX input metadata overrides profile fallback resolution safely', () => {
  const detectorProfile = getUserModelProfileDefinition('subject-detector', 'subject-yolov8-640')
  const detector = getImageAdapterSpec(detectorProfile, {
    isTensor: true,
    shape: [1, 3, 416, 320],
  })
  assert.deepEqual(imageTensorDimensions(detector), [1, 3, 416, 320])
  const rejectedOversize = getImageAdapterSpec(detectorProfile, {
    isTensor: true,
    shape: [1, 3, 8192, 8192],
  })
  assert.deepEqual(imageTensorDimensions(rejectedOversize), [1, 3, 640, 640])

  const samProfile = getUserModelProfileDefinition('segment-encoder', 'sam-encoder-hwc-1024')
  const sam = getImageAdapterSpec(samProfile, {
    isTensor: true,
    shape: [1, 768, 512, 3],
  })
  assert.deepEqual(imageTensorDimensions(sam), [1, 768, 512, 3])
})

test('detector adapters parse transposed YOLOv8, YOLOv5 and NMS outputs', () => {
  const yolo8Data = new Array(6 * 10).fill(0)
  ;[10, 11, 4, 8, 0.1, 0.8].forEach((value, feature) => {
    yolo8Data[feature * 10] = value
  })
  const yolo8 = parseObjectDetections('yolov8-detection', {
    dims: [1, 6, 10],
    data: yolo8Data,
  })
  assert.equal(yolo8.length, 10)
  assert.equal(yolo8[0].classIndex, 1)
  assert.equal(yolo8[0].confidence, 0.8)

  const yolo5 = parseObjectDetections('yolov5-detection', {
    dims: [1, 10, 7],
    data: [10, 11, 4, 8, 0.5, 0.2, 0.8, ...new Array(63).fill(0)],
  })
  assert.equal(yolo5[0].classIndex, 1)
  assert.equal(yolo5[0].confidence, 0.4)

  const nms = parseObjectDetections('nms-detection', {
    dims: [1, 1, 6],
    data: [1, 2, 9, 10, 0.75, 3],
  })
  assert.deepEqual(nms[0], {
    x1: 1,
    y1: 2,
    x2: 9,
    y2: 10,
    confidence: 0.75,
    classIndex: 3,
  })
})

test('face output and tensor-name adapters tolerate common export naming', () => {
  const faceData = new Array(15 * 20).fill(0)
  ;[10, 11, 4, 8, 0.9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach((value, feature) => {
    faceData[feature * 20] = value
  })
  const face = parseFaceDetections('yolov8-face', {
    dims: [1, 15, 20],
    data: faceData,
  })
  assert.equal(face[0].landmarks.length, 5)
  assert.equal(
    resolveTensorName(['serving_default_images'], ['images', 'input']),
    'serving_default_images',
  )
  assert.throws(
    () => resolveTensorName(['unrelated'], ['orig_im_size'], false),
    /no compatible tensor/,
  )
})

test('separate-output detection adapter aligns boxes, scores and optional labels', () => {
  const detections = parseSplitDetections({
    boxes: { dims: [1, 2, 4], data: [1, 2, 9, 10, 11, 12, 19, 20] },
    scores: { dims: [1, 2, 3], data: [0.1, 0.8, 0.2, 0.7, 0.2, 0.1] },
  })
  assert.equal(detections.length, 2)
  assert.equal(detections[0].classIndex, 1)
  assert.equal(detections[0].confidence, 0.8)
  assert.equal(detections[1].x1, 11)

  const profile = getUserModelProfileDefinition('subject-detector', 'subject-split-output')
  const mismatch = inspectUserModelContract(
    profile,
    [{ name: 'images', type: 'float32', shape: [1, 640, 640, 3] }],
    [
      { name: 'boxes', type: 'float32', shape: [1, 100, 5] },
      { name: 'scores', type: 'float32', shape: [1, 100] },
    ],
  )
  assert.equal(mismatch.compatible, false)
  assert.ok(mismatch.warnings.some((warning) => /channel dimension 3 at axis 1/.test(warning)))
  assert.ok(mismatch.warnings.some((warning) => /dimension 4/.test(warning)))
})

test('named SCRFD adapter decodes stride outputs and graph inspection rejects mismatches', () => {
  const tensors = {}
  for (const [stride, anchors] of [
    [8, 32],
    [16, 8],
    [32, 2],
  ]) {
    tensors[`score_${stride}`] = { dims: [1, anchors, 1], data: new Array(anchors).fill(0.9) }
    tensors[`bbox_${stride}`] = { dims: [1, anchors, 4], data: new Array(anchors * 4).fill(1) }
  }
  const detections = parseScrfdFaceDetections(tensors, 32, 32)
  assert.equal(detections.length, 42)
  assert.equal(detections[0].x1, -8)
  assert.equal(detections[0].x2, 8)

  const orderedNames = ['448', '471', '494', '451', '474', '497']
  const orderedTensors = {
    448: tensors.score_8,
    471: tensors.score_16,
    494: tensors.score_32,
    451: tensors.bbox_8,
    474: tensors.bbox_16,
    497: tensors.bbox_32,
  }
  assert.equal(parseScrfdFaceDetections(orderedTensors, 32, 32, orderedNames).length, 42)

  const profile = getUserModelProfileDefinition('face-detector', 'face-scrfd-named')
  const good = inspectUserModelContract(
    profile,
    [{ name: 'input.1', type: 'float32', shape: [1, 3, 32, 32] }],
    Object.keys(tensors).map((name) => ({ name, type: 'float32', shape: [] })),
  )
  assert.equal(good.compatible, true)
  const bad = inspectUserModelContract(
    profile,
    [{ name: 'input.1', type: 'float32', shape: [1, 3, 32, 32] }],
    [{ name: 'output', type: 'float32', shape: [] }],
  )
  assert.equal(bad.compatible, false)
  assert.ok(bad.warnings.length >= 6)

  const orderedProfile = getUserModelProfileDefinition('face-detector', 'face-scrfd-ordered')
  const orderedInspection = inspectUserModelContract(
    orderedProfile,
    [{ name: 'input.1', type: 'float32', shape: [1, 3, 32, 32] }],
    orderedNames.map((name) => ({ name, type: 'float32', shape: [] })),
  )
  assert.equal(orderedInspection.compatible, true)
})

test('RetinaFace adapter decodes priors and validates loc/conf/landms graphs', () => {
  const anchors = 42
  const confidenceData = new Array(anchors * 2).fill(0)
  for (let anchor = 0; anchor < anchors; anchor++) {
    confidenceData[anchor * 2] = 0.1
    confidenceData[anchor * 2 + 1] = 0.9
  }
  const tensors = {
    loc: { dims: [1, anchors, 4], data: new Array(anchors * 4).fill(0) },
    conf: { dims: [1, anchors, 2], data: confidenceData },
    landms: { dims: [1, anchors, 10], data: new Array(anchors * 10).fill(0) },
  }
  const detections = parseRetinaFaceDetections(tensors, 32, 32)
  assert.equal(detections.length, anchors)
  assert.equal(detections[0].x1, -0.125)
  assert.equal(detections[0].y1, -0.125)
  assert.equal(detections[0].x2, 0.375)
  assert.equal(detections[0].y2, 0.375)
  assert.equal(detections[0].confidence, 0.9)
  assert.equal(detections[0].coordinateSpace, 'normalized')
  assert.deepEqual(detections[0].landmarks, new Array(5).fill({ x: 0.125, y: 0.125 }))

  const profile = getUserModelProfileDefinition('face-detector', 'face-retinaface-priorbox')
  const good = inspectUserModelContract(
    profile,
    [{ name: 'input', type: 'float32', shape: [1, 3, 32, 32] }],
    [
      { name: 'loc', type: 'float32', shape: [1, anchors, 4] },
      { name: 'conf', type: 'float32', shape: [1, anchors, 2] },
      { name: 'landms', type: 'float32', shape: [1, anchors, 10] },
    ],
  )
  assert.equal(good.compatible, true)
  const bad = inspectUserModelContract(
    profile,
    [{ name: 'input', type: 'float32', shape: [1, 3, 32, 32] }],
    [
      { name: 'loc', type: 'float32', shape: [1, anchors, 5] },
      { name: 'conf', type: 'float32', shape: [1, anchors, 3] },
      { name: 'landms', type: 'float32', shape: [1, anchors, 8] },
    ],
  )
  assert.equal(bad.compatible, false)
  assert.equal(bad.warnings.length, 3)
})

test('installation metadata and renderer import preserve the selected profile', () => {
  const service = fs.readFileSync(path.join(root, 'electron/userModelPlatformService.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron/preload.ts'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'src/components/SettingsPanel.tsx'), 'utf8')
  assert.match(service, /schemaVersion: 3/)
  assert.match(service, /profileId: profile\.id/)
  assert.match(service, /inspectPreparedModel/)
  assert.match(service, /MAX_METADATA_BYTES = 256 \* 1024/)
  assert.match(service, /normalizeStoredInspection/)
  assert.match(service, /commitPreparedPath\(preparedDirectory, finalDirectory\)/)
  assert.match(preload, /importUserModel', slotId, acknowledgement, profileId/)
  assert.match(settings, /selectedProfiles\[slotId\]/)
})

test('commercial package config ships only the safe download manifest from models', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const modelEntries = packageJson.build.extraResources.filter(
    (entry) => entry.from === 'models' || entry.from.startsWith('models/'),
  )
  assert.deepEqual(modelEntries, [{ from: 'models/manifest.json', to: 'models/manifest.json' }])
})

test('five unresolved candidate models are not bundled by the default profile', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  const components = new Map(manifest.components.map((component) => [component.id, component]))
  for (const id of riskyComponentIds) {
    assert.equal(components.get(id)?.distribution.defaultBundled, false, id)
    assert.equal(components.get(id)?.license.reviewStatus, 'legal-review-required', id)
  }
})

test('runtime adapters resolve user slots instead of repository model directories', () => {
  const serviceFiles = [
    'electron/subjectSearchService.ts',
    'electron/faceMatchService.ts',
    'electron/personReidService.ts',
    'electron/samSegmentService.ts',
  ]
  for (const file of serviceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(source, /userModelPlatformService/)
    assert.doesNotMatch(source, /process\.resourcesPath[^\n]+models/)
  }
})
