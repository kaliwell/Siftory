import type {
  UserModelAdapterId,
  UserModelInspection,
  UserModelProfileDefinition,
  UserModelTensorDescriptor,
} from '../shared/userModelPlatform'

export interface ImageAdapterSpec {
  width: number
  height: number
  layout: 'nchw' | 'hwc'
  normalization: 'zero-to-one' | 'minus-one-to-one' | 'imagenet' | 'retinaface-bgr-mean'
  batchDimension: boolean
}

interface TensorMetadataLike {
  isTensor: boolean
  shape?: readonly (number | string)[]
}

export interface AdapterDetection {
  cx?: number
  cy?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  width?: number
  height?: number
  confidence: number
  classIndex: number
  coordinateSpace?: 'normalized' | 'input-pixels'
  landmarks?: Array<{ x: number; y: number }>
}

interface TensorLike {
  data: ArrayLike<unknown>
  dims: readonly number[]
}

type TensorMapLike = Record<string, TensorLike>

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

export function getImageAdapterSpec(
  profile: UserModelProfileDefinition,
  metadata?: TensorMetadataLike,
): ImageAdapterSpec {
  let spec: ImageAdapterSpec
  switch (profile.adapter) {
    case 'arcface-112':
      spec = {
        width: 112,
        height: 112,
        layout: 'nchw',
        normalization: 'minus-one-to-one',
        batchDimension: true,
      }
      break
    case 'facenet-160':
      spec = {
        width: 160,
        height: 160,
        layout: 'nchw',
        normalization: 'minus-one-to-one',
        batchDimension: true,
      }
      break
    case 'scrfd-face':
    case 'scrfd-face-ordered':
      spec = {
        width: 640,
        height: 640,
        layout: 'nchw',
        normalization: 'minus-one-to-one',
        batchDimension: true,
      }
      break
    case 'retinaface-priorbox':
      spec = {
        width: 640,
        height: 640,
        layout: 'nchw',
        normalization: 'retinaface-bgr-mean',
        batchDimension: true,
      }
      break
    case 'reid-384x128':
      spec = {
        width: 128,
        height: 384,
        layout: 'nchw',
        normalization: 'imagenet',
        batchDimension: true,
      }
      break
    case 'reid-256x128':
      spec = {
        width: 128,
        height: 256,
        layout: 'nchw',
        normalization: 'imagenet',
        batchDimension: true,
      }
      break
    case 'sam-hwc-1024':
      spec = {
        width: 1024,
        height: 1024,
        layout: 'hwc',
        normalization: 'imagenet',
        batchDimension: false,
      }
      break
    case 'sam-nchw-1024':
      spec = {
        width: 1024,
        height: 1024,
        layout: 'nchw',
        normalization: 'imagenet',
        batchDimension: true,
      }
      break
    default:
      spec = {
        width: 640,
        height: 640,
        layout: 'nchw',
        normalization: 'zero-to-one',
        batchDimension: true,
      }
  }
  const shape = metadata?.isTensor ? metadata.shape : undefined
  if (!shape) return spec
  const positive = (value: number | string | undefined): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 16 && value <= 2048
      ? value
      : null
  if (spec.layout === 'nchw' && shape.length === 4) {
    return {
      ...spec,
      height: positive(shape[2]) ?? spec.height,
      width: positive(shape[3]) ?? spec.width,
    }
  }
  if (spec.layout === 'hwc' && (shape.length === 3 || shape.length === 4)) {
    const offset = shape.length === 4 ? 1 : 0
    return {
      ...spec,
      height: positive(shape[offset]) ?? spec.height,
      width: positive(shape[offset + 1]) ?? spec.width,
      batchDimension: shape.length === 4,
    }
  }
  return spec
}

export function imageTensorDimensions(spec: ImageAdapterSpec, batchSize = 1): number[] {
  if (spec.layout === 'nchw') return [batchSize, 3, spec.height, spec.width]
  const dimensions = [spec.height, spec.width, 3]
  return spec.batchDimension ? [batchSize, ...dimensions] : dimensions
}

export function preprocessRgb(rgb: ArrayLike<number>, spec: ImageAdapterSpec): Float32Array {
  const area = spec.width * spec.height
  if (rgb.length < area * 3) throw new Error('RGB input is smaller than the selected profile')
  const output = new Float32Array(area * 3)
  const normalize = (value: number, channel: number): number => {
    if (spec.normalization === 'retinaface-bgr-mean') {
      return value - [104, 117, 123][channel]
    }
    const unit = value / 255
    if (spec.normalization === 'minus-one-to-one') return (unit - 0.5) / 0.5
    if (spec.normalization === 'imagenet') {
      return (unit - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel]
    }
    return unit
  }
  for (let pixel = 0; pixel < area; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const sourceChannel = spec.normalization === 'retinaface-bgr-mean' ? 2 - channel : channel
      const value = normalize(rgb[pixel * 3 + sourceChannel], channel)
      if (spec.layout === 'hwc') output[pixel * 3 + channel] = value
      else output[channel * area + pixel] = value
    }
  }
  return output
}

function featureView(tensor: TensorLike): {
  anchors: number
  features: number
  value: (anchor: number, feature: number) => number
} {
  const dims = tensor.dims.filter((dimension) => Number.isFinite(dimension) && dimension > 0)
  if (dims.length < 2) throw new Error('Detection output must have at least two dimensions')
  const first = dims[dims.length - 2]
  const second = dims[dims.length - 1]
  const featuresFirst = first <= second
  const features = featuresFirst ? first : second
  const anchors = featuresFirst ? second : first
  if (features < 5 || features > 1024 || anchors < 1 || anchors > 1_000_000) {
    throw new Error(`Unsupported detection output shape: ${tensor.dims.join('x')}`)
  }
  return {
    anchors,
    features,
    value: featuresFirst
      ? (anchor, feature) => Number(tensor.data[feature * anchors + anchor])
      : (anchor, feature) => Number(tensor.data[anchor * features + feature]),
  }
}

function nmsRows(tensor: TensorLike): AdapterDetection[] {
  const values = Array.from(tensor.data, Number)
  if (values.length % 6 !== 0) throw new Error('NMS output must contain six values per row')
  if (values.length > 6_000_000) throw new Error('NMS output exceeds the adapter safety limit')
  const detections: AdapterDetection[] = []
  for (let offset = 0; offset < values.length; offset += 6) {
    const confidence = values[offset + 4]
    if (!Number.isFinite(confidence)) continue
    detections.push({
      x1: values[offset],
      y1: values[offset + 1],
      x2: values[offset + 2],
      y2: values[offset + 3],
      confidence,
      classIndex: Math.max(0, Math.round(values[offset + 5])),
    })
  }
  return detections
}

export function parseObjectDetections(
  adapter: UserModelAdapterId,
  tensor: TensorLike,
): AdapterDetection[] {
  if (adapter === 'nms-detection') return nmsRows(tensor)
  if (adapter !== 'yolov8-detection' && adapter !== 'yolov5-detection') {
    throw new Error(`Profile ${adapter} is not an object detector`)
  }
  const view = featureView(tensor)
  const classStart = adapter === 'yolov5-detection' ? 5 : 4
  if (view.features <= classStart) throw new Error('Detection output has no class scores')
  const detections: AdapterDetection[] = []
  for (let anchor = 0; anchor < view.anchors; anchor++) {
    let classScore = -Infinity
    let classIndex = 0
    for (let feature = classStart; feature < view.features; feature++) {
      const score = view.value(anchor, feature)
      if (score > classScore) {
        classScore = score
        classIndex = feature - classStart
      }
    }
    const objectness = adapter === 'yolov5-detection' ? view.value(anchor, 4) : 1
    detections.push({
      cx: view.value(anchor, 0),
      cy: view.value(anchor, 1),
      width: view.value(anchor, 2),
      height: view.value(anchor, 3),
      confidence: objectness * classScore,
      classIndex,
    })
  }
  return detections
}

export function parseFaceDetections(
  adapter: UserModelAdapterId,
  tensor: TensorLike,
): AdapterDetection[] {
  if (adapter === 'nms-face') return nmsRows(tensor)
  if (adapter !== 'yolov8-face') throw new Error(`Profile ${adapter} is not a face detector`)
  const view = featureView(tensor)
  const landmarkValues = view.features - 5
  const landmarkStride = landmarkValues >= 15 ? 3 : 2
  const detections: AdapterDetection[] = []
  for (let anchor = 0; anchor < view.anchors; anchor++) {
    const landmarks: Array<{ x: number; y: number }> = []
    for (let point = 0; point < 5; point++) {
      const base = 5 + point * landmarkStride
      if (base + 1 >= view.features) break
      landmarks.push({ x: view.value(anchor, base), y: view.value(anchor, base + 1) })
    }
    detections.push({
      cx: view.value(anchor, 0),
      cy: view.value(anchor, 1),
      width: view.value(anchor, 2),
      height: view.value(anchor, 3),
      confidence: view.value(anchor, 4),
      classIndex: 0,
      coordinateSpace: 'input-pixels',
      landmarks,
    })
  }
  return detections
}

function findTensorByAliases(
  tensors: TensorMapLike,
  aliases: readonly string[],
  required = true,
): TensorLike | undefined {
  const names = Object.keys(tensors)
  const name = names.find((candidate) => {
    const normalized = candidate.toLowerCase()
    return aliases.some((alias) => normalized === alias || normalized.includes(alias))
  })
  if (!name && required)
    throw new Error(`Model exposes no compatible tensor for: ${aliases.join(', ')}`)
  return name ? tensors[name] : undefined
}

export function parseSplitDetections(tensors: TensorMapLike): AdapterDetection[] {
  const boxes = findTensorByAliases(tensors, ['detection_boxes', 'bboxes', 'boxes'])!
  const scores = findTensorByAliases(tensors, ['detection_scores', 'scores', 'confidence'])!
  const labels = findTensorByAliases(
    tensors,
    ['detection_classes', 'class_ids', 'labels', 'classes'],
    false,
  )
  const boxValues = Array.from(boxes.data, Number)
  const scoreValues = Array.from(scores.data, Number)
  const labelValues = labels ? Array.from(labels.data, Number) : []
  if (boxValues.length % 4 !== 0) throw new Error('Boxes tensor must contain four values per box')
  const count = boxValues.length / 4
  if (count < 1 || count > 1_000_000)
    throw new Error('Boxes tensor exceeds the adapter safety limit')
  if (scoreValues.length % count !== 0) {
    throw new Error('Scores tensor does not align with the boxes tensor')
  }
  const classCount = scoreValues.length / count
  const detections: AdapterDetection[] = []
  for (let index = 0; index < count; index++) {
    let classIndex = labelValues.length > index ? Math.max(0, Math.round(labelValues[index])) : 0
    let confidence = scoreValues[index]
    if (classCount > 1) {
      confidence = -Infinity
      for (let classOffset = 0; classOffset < classCount; classOffset++) {
        const score = scoreValues[index * classCount + classOffset]
        if (score > confidence) {
          confidence = score
          classIndex = classOffset
        }
      }
    }
    const offset = index * 4
    detections.push({
      x1: boxValues[offset],
      y1: boxValues[offset + 1],
      x2: boxValues[offset + 2],
      y2: boxValues[offset + 3],
      confidence,
      classIndex,
    })
  }
  return detections
}

function findStrideTensor(
  tensors: TensorMapLike,
  stride: number,
  pattern: RegExp,
): TensorLike | undefined {
  const stridePattern = new RegExp(`(?:^|[^0-9])${stride}(?:[^0-9]|$)`)
  const name = Object.keys(tensors).find(
    (candidate) => pattern.test(candidate.toLowerCase()) && stridePattern.test(candidate),
  )
  return name ? tensors[name] : undefined
}

export function parseScrfdFaceDetections(
  tensors: TensorMapLike,
  inputWidth: number,
  inputHeight: number,
  orderedNames?: readonly string[],
): AdapterDetection[] {
  const detections: AdapterDetection[] = []
  const strides = [8, 16, 32]
  if (orderedNames && orderedNames.length !== 6 && orderedNames.length !== 9) {
    throw new Error('Ordered SCRFD adapter requires six or nine outputs')
  }
  for (let strideIndex = 0; strideIndex < strides.length; strideIndex++) {
    const stride = strides[strideIndex]
    const scores = orderedNames
      ? tensors[orderedNames[strideIndex]]
      : findStrideTensor(tensors, stride, /score|cls|conf/)
    const boxes = orderedNames
      ? tensors[orderedNames[3 + strideIndex]]
      : findStrideTensor(tensors, stride, /bbox|box/)
    const keypoints = orderedNames
      ? orderedNames.length === 9
        ? tensors[orderedNames[6 + strideIndex]]
        : undefined
      : findStrideTensor(tensors, stride, /kps|landmark|keypoint/)
    if (!scores || !boxes) throw new Error(`SCRFD stride ${stride} outputs are missing`)
    const scoreValues = Array.from(scores.data, Number)
    const boxValues = Array.from(boxes.data, Number)
    const keypointValues = keypoints ? Array.from(keypoints.data, Number) : []
    if (boxValues.length % 4 !== 0) throw new Error(`SCRFD stride ${stride} bbox shape is invalid`)
    const anchors = boxValues.length / 4
    const featureWidth = Math.ceil(inputWidth / stride)
    const featureHeight = Math.ceil(inputHeight / stride)
    if (anchors !== featureWidth * featureHeight * 2) {
      throw new Error(`SCRFD stride ${stride} anchor count does not match the input shape`)
    }
    if (scoreValues.length !== anchors && scoreValues.length !== anchors * 2) {
      throw new Error(`SCRFD stride ${stride} score shape is invalid`)
    }
    if (keypointValues.length > 0 && keypointValues.length !== anchors * 10) {
      throw new Error(`SCRFD stride ${stride} landmark shape is invalid`)
    }
    for (let anchor = 0; anchor < anchors; anchor++) {
      const cell = Math.floor(anchor / 2)
      const centerX = (cell % featureWidth) * stride
      const centerY = Math.floor(cell / featureWidth) * stride
      const boxOffset = anchor * 4
      const landmarks: Array<{ x: number; y: number }> = []
      for (let point = 0; point < 5 && keypointValues.length > 0; point++) {
        const offset = anchor * 10 + point * 2
        landmarks.push({
          x: centerX + keypointValues[offset] * stride,
          y: centerY + keypointValues[offset + 1] * stride,
        })
      }
      detections.push({
        x1: centerX - boxValues[boxOffset] * stride,
        y1: centerY - boxValues[boxOffset + 1] * stride,
        x2: centerX + boxValues[boxOffset + 2] * stride,
        y2: centerY + boxValues[boxOffset + 3] * stride,
        confidence:
          scoreValues.length === anchors * 2 ? scoreValues[anchor * 2 + 1] : scoreValues[anchor],
        classIndex: 0,
        coordinateSpace: 'input-pixels',
        landmarks,
      })
    }
  }
  return detections
}

export function parseRetinaFaceDetections(
  tensors: TensorMapLike,
  inputWidth: number,
  inputHeight: number,
  orderedNames?: readonly string[],
): AdapterDetection[] {
  const names = orderedNames ?? Object.keys(tensors)
  let locations = findTensorByAliases(tensors, ['bbox_regressions', 'locations', 'loc'], false)
  let confidences = findTensorByAliases(tensors, ['classifications', 'scores', 'conf'], false)
  let landmarks = findTensorByAliases(tensors, ['landmarks', 'landms'], false)
  if (!locations || !confidences || !landmarks) {
    if (names.length !== 3)
      throw new Error('RetinaFace adapter requires loc, conf and landms outputs')
    ;[locations, confidences, landmarks] = names.map((name) => tensors[name])
  }
  if (!locations || !confidences || !landmarks) {
    throw new Error('RetinaFace outputs are missing')
  }
  const locationValues = Array.from(locations.data, Number)
  const confidenceValues = Array.from(confidences.data, Number)
  const landmarkValues = Array.from(landmarks.data, Number)
  if (locationValues.length % 4 !== 0) throw new Error('RetinaFace loc shape is invalid')
  const anchors = locationValues.length / 4
  if (anchors < 1 || anchors > 1_000_000) {
    throw new Error('RetinaFace anchor count exceeds the adapter safety limit')
  }
  if (confidenceValues.length !== anchors && confidenceValues.length !== anchors * 2) {
    throw new Error('RetinaFace conf shape is invalid')
  }
  if (landmarkValues.length !== anchors * 10) {
    throw new Error('RetinaFace landms shape is invalid')
  }

  const priors: Array<{ cx: number; cy: number; width: number; height: number }> = []
  const minSizes = [
    [16, 32],
    [64, 128],
    [256, 512],
  ]
  const steps = [8, 16, 32]
  for (let level = 0; level < steps.length; level++) {
    const step = steps[level]
    const featureWidth = Math.ceil(inputWidth / step)
    const featureHeight = Math.ceil(inputHeight / step)
    for (let y = 0; y < featureHeight; y++) {
      for (let x = 0; x < featureWidth; x++) {
        for (const minSize of minSizes[level]) {
          priors.push({
            cx: ((x + 0.5) * step) / inputWidth,
            cy: ((y + 0.5) * step) / inputHeight,
            width: minSize / inputWidth,
            height: minSize / inputHeight,
          })
        }
      }
    }
  }
  if (priors.length !== anchors) {
    throw new Error('RetinaFace prior count does not match the input shape')
  }

  return priors.map((prior, anchor) => {
    const boxOffset = anchor * 4
    const centerX = prior.cx + locationValues[boxOffset] * 0.1 * prior.width
    const centerY = prior.cy + locationValues[boxOffset + 1] * 0.1 * prior.height
    const boxWidth = prior.width * Math.exp(locationValues[boxOffset + 2] * 0.2)
    const boxHeight = prior.height * Math.exp(locationValues[boxOffset + 3] * 0.2)
    const points: Array<{ x: number; y: number }> = []
    for (let point = 0; point < 5; point++) {
      const offset = anchor * 10 + point * 2
      points.push({
        x: prior.cx + landmarkValues[offset] * 0.1 * prior.width,
        y: prior.cy + landmarkValues[offset + 1] * 0.1 * prior.height,
      })
    }
    return {
      x1: centerX - boxWidth / 2,
      y1: centerY - boxHeight / 2,
      x2: centerX + boxWidth / 2,
      y2: centerY + boxHeight / 2,
      confidence:
        confidenceValues.length === anchors * 2
          ? confidenceValues[anchor * 2 + 1]
          : confidenceValues[anchor],
      classIndex: 0,
      coordinateSpace: 'normalized',
      landmarks: points,
    }
  })
}

export function resolveTensorName(
  availableNames: readonly string[],
  preferredNames: readonly string[],
  allowFirstFallback = true,
): string {
  for (const preferred of preferredNames) {
    const exact = availableNames.find((name) => name === preferred)
    if (exact) return exact
  }
  for (const preferred of preferredNames) {
    const partial = availableNames.find((name) => name.toLowerCase().includes(preferred))
    if (partial) return partial
  }
  if (allowFirstFallback && availableNames.length > 0) return availableNames[0]
  throw new Error(`Model exposes no compatible tensor for: ${preferredNames.join(', ')}`)
}

function hasNamedTensor(tensors: readonly UserModelTensorDescriptor[], aliases: readonly string[]) {
  return tensors.some((tensor) => {
    const name = tensor.name.toLowerCase()
    return aliases.some((alias) => name === alias || name.includes(alias))
  })
}

function findNamedDescriptor(
  tensors: readonly UserModelTensorDescriptor[],
  aliases: readonly string[],
): UserModelTensorDescriptor | undefined {
  return tensors.find((tensor) => {
    const name = tensor.name.toLowerCase()
    return aliases.some((alias) => name === alias || name.includes(alias))
  })
}

function fixedLastDimension(tensor: UserModelTensorDescriptor | undefined): number | null {
  const value = tensor?.shape[tensor.shape.length - 1]
  return typeof value === 'number' && value > 0 ? value : null
}

/** Static graph checks only; successful inspection is not an inference/accuracy guarantee. */
export function inspectUserModelContract(
  profile: UserModelProfileDefinition,
  inputs: UserModelTensorDescriptor[],
  outputs: UserModelTensorDescriptor[],
): UserModelInspection {
  const warnings: string[] = []
  let compatible = true
  if (inputs.length === 0) {
    compatible = false
    warnings.push('Model exposes no inputs')
  }
  if (outputs.length === 0) {
    compatible = false
    warnings.push('Model exposes no outputs')
  }
  const imageInput = inputs[0]
  if (imageInput && !/float/i.test(imageInput.type)) {
    compatible = false
    warnings.push(`Expected a float image input, received ${imageInput.type}`)
  }

  const adapter = profile.adapter
  if (imageInput && adapter !== 'sam-original-size-decoder') {
    const spec = getImageAdapterSpec(profile)
    const shape = imageInput.shape
    if (spec.layout === 'nchw') {
      if (shape.length > 0 && shape.length !== 4) {
        compatible = false
        warnings.push('Selected NCHW profile requires a four-dimensional image input')
      } else if (typeof shape[1] === 'number' && shape[1] !== 3) {
        compatible = false
        warnings.push('Selected NCHW profile requires channel dimension 3 at axis 1')
      }
    } else if (shape.length > 0) {
      if (shape.length !== 3 && shape.length !== 4) {
        compatible = false
        warnings.push('Selected HWC profile requires a three- or four-dimensional image input')
      } else if (typeof shape[shape.length - 1] === 'number' && shape[shape.length - 1] !== 3) {
        compatible = false
        warnings.push('Selected HWC profile requires channel dimension 3 at the last axis')
      }
    }
  }
  if (adapter === 'split-detection' || adapter === 'split-face') {
    const boxes = findNamedDescriptor(outputs, ['boxes', 'bboxes', 'detection_boxes'])
    if (!boxes) {
      compatible = false
      warnings.push('Separate-output adapter requires a boxes tensor')
    } else if (fixedLastDimension(boxes) !== null && fixedLastDimension(boxes) !== 4) {
      compatible = false
      warnings.push('Separate-output boxes tensor must end with dimension 4')
    }
    if (!hasNamedTensor(outputs, ['scores', 'confidence', 'detection_scores'])) {
      compatible = false
      warnings.push('Separate-output adapter requires a scores tensor')
    }
  } else if (adapter === 'scrfd-face') {
    const names = outputs.map((output) => output.name.toLowerCase())
    for (const stride of [8, 16, 32]) {
      if (!names.some((name) => /score|cls|conf/.test(name) && name.includes(String(stride)))) {
        compatible = false
        warnings.push(`SCRFD output is missing a named score tensor for stride ${stride}`)
      }
      if (!names.some((name) => /bbox|box/.test(name) && name.includes(String(stride)))) {
        compatible = false
        warnings.push(`SCRFD output is missing a named bbox tensor for stride ${stride}`)
      }
    }
  } else if (adapter === 'scrfd-face-ordered') {
    if (outputs.length !== 6 && outputs.length !== 9) {
      compatible = false
      warnings.push('Ordered SCRFD adapter requires six or nine outputs')
    } else {
      for (const tensor of outputs.slice(3, 6)) {
        if (fixedLastDimension(tensor) !== null && fixedLastDimension(tensor) !== 4) {
          compatible = false
          warnings.push(`Ordered SCRFD bbox tensor ${tensor.name} must end with dimension 4`)
        }
      }
      for (const tensor of outputs.slice(6, 9)) {
        if (fixedLastDimension(tensor) !== null && fixedLastDimension(tensor) !== 10) {
          compatible = false
          warnings.push(`Ordered SCRFD landmark tensor ${tensor.name} must end with dimension 10`)
        }
      }
    }
  } else if (adapter === 'retinaface-priorbox') {
    if (outputs.length !== 3) {
      compatible = false
      warnings.push('RetinaFace adapter requires exactly three outputs')
    } else {
      const named = [
        findNamedDescriptor(outputs, ['bbox_regressions', 'locations', 'loc']),
        findNamedDescriptor(outputs, ['classifications', 'scores', 'conf']),
        findNamedDescriptor(outputs, ['landmarks', 'landms']),
      ]
      const tensors = named.every(Boolean) ? (named as UserModelTensorDescriptor[]) : outputs
      const expectedLastDimensions = [4, 2, 10]
      tensors.forEach((tensor, index) => {
        const dimension = fixedLastDimension(tensor)
        const valid =
          dimension === null ||
          dimension === expectedLastDimensions[index] ||
          (index === 1 && dimension === 1)
        if (!valid) {
          compatible = false
          warnings.push(
            index === 1
              ? `RetinaFace output ${tensor.name} must end with dimension 1 or 2`
              : `RetinaFace output ${tensor.name} must end with dimension ${expectedLastDimensions[index]}`,
          )
        }
      })
    }
  } else if (adapter === 'sam-original-size-decoder') {
    for (const name of [
      'image_embeddings',
      'point_coords',
      'point_labels',
      'mask_input',
      'has_mask_input',
      'orig_im_size',
    ]) {
      if (!hasNamedTensor(inputs, [name])) {
        compatible = false
        warnings.push(`SAM decoder input is missing ${name}`)
      }
    }
    if (!hasNamedTensor(outputs, ['masks', 'mask'])) {
      compatible = false
      warnings.push('SAM decoder output is missing masks')
    }
    if (!hasNamedTensor(outputs, ['iou_predictions', 'iou'])) {
      compatible = false
      warnings.push('SAM decoder output is missing IoU predictions')
    }
  }

  return {
    inspectedAt: new Date().toISOString(),
    compatible,
    inputs,
    outputs,
    warnings,
  }
}
