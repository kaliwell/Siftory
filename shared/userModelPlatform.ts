export type UserModelSlotId =
  | 'subject-detector'
  | 'face-detector'
  | 'face-embedder'
  | 'person-reid'
  | 'segment-encoder'
  | 'segment-decoder'

export type UserModelAdapterId =
  | 'yolov8-detection'
  | 'yolov5-detection'
  | 'nms-detection'
  | 'split-detection'
  | 'yolov8-face'
  | 'nms-face'
  | 'split-face'
  | 'scrfd-face'
  | 'scrfd-face-ordered'
  | 'retinaface-priorbox'
  | 'arcface-112'
  | 'facenet-160'
  | 'reid-256x128'
  | 'reid-384x128'
  | 'sam-hwc-1024'
  | 'sam-nchw-1024'
  | 'sam-original-size-decoder'

export interface UserModelProfileDefinition {
  id: string
  displayName: string
  adapter: UserModelAdapterId
  compatibility: string
  classLabels?: 'coco' | 'generic'
}

export interface UserModelSlotDefinition {
  id: UserModelSlotId
  capability: 'subject-detection' | 'face-match' | 'person-reid' | 'segmentation'
  displayName: string
  targetFileName: string
  compatibility: string
  maxSizeBytes: number
  defaultProfileId: string
  profiles: readonly UserModelProfileDefinition[]
}

export interface UserModelSlotStatus extends UserModelSlotDefinition {
  installed: boolean
  activeProfileId: string
  activeProfileName: string
  sizeBytes?: number
  sha256?: string
  installedAt?: string
  sourceFileName?: string
  inspection?: UserModelInspection
  responsibility: 'user-supplied-unreviewed'
}

export type UserModelRuntimeState = 'not-installed' | 'ready' | 'error'

export interface UserModelRuntimeStatus {
  slotId: UserModelSlotId
  state: UserModelRuntimeState
  checkedAt: number
  error?: string
}

export interface UserModelTensorDescriptor {
  name: string
  type: string
  shape: Array<number | string>
}

export interface UserModelInspection {
  inspectedAt: string
  compatible: boolean
  inputs: UserModelTensorDescriptor[]
  outputs: UserModelTensorDescriptor[]
  warnings: string[]
}

export interface UserModelMutationResult {
  ok: boolean
  cancelled?: boolean
  error?: string
  status?: UserModelSlotStatus
}

const GIB = 1024 * 1024 * 1024

export const USER_MODEL_SLOTS: readonly UserModelSlotDefinition[] = [
  {
    id: 'subject-detector',
    capability: 'subject-detection',
    displayName: 'Subject detector',
    targetFileName: 'model.onnx',
    compatibility: 'YOLO-family ONNX detector; select the matching output adapter',
    maxSizeBytes: GIB,
    defaultProfileId: 'subject-yolov8-640',
    profiles: [
      {
        id: 'subject-yolov8-640',
        displayName: 'YOLOv8/9 raw · 640',
        adapter: 'yolov8-detection',
        compatibility: 'NCHW RGB 0..1; output [1,4+classes,N] or [1,N,4+classes]',
        classLabels: 'coco',
      },
      {
        id: 'subject-yolov8-generic-640',
        displayName: 'YOLOv8/9 raw · custom classes',
        adapter: 'yolov8-detection',
        compatibility: 'Same YOLOv8 tensor contract; labels are shown as class numbers',
        classLabels: 'generic',
      },
      {
        id: 'subject-yolov5-640',
        displayName: 'YOLOv5/7 raw · 640',
        adapter: 'yolov5-detection',
        compatibility: 'NCHW RGB 0..1; output [1,N,5+classes] with objectness',
        classLabels: 'coco',
      },
      {
        id: 'subject-yolov5-generic-640',
        displayName: 'YOLOv5/7 raw · custom classes',
        adapter: 'yolov5-detection',
        compatibility: 'Same YOLOv5 tensor contract; labels are shown as class numbers',
        classLabels: 'generic',
      },
      {
        id: 'subject-nms-640',
        displayName: 'Detection with NMS · 640',
        adapter: 'nms-detection',
        compatibility: 'NCHW RGB 0..1; output [N,6] or [1,N,6] as x1,y1,x2,y2,score,class',
        classLabels: 'generic',
      },
      {
        id: 'subject-split-output',
        displayName: 'Separate boxes / scores / labels',
        adapter: 'split-detection',
        compatibility: 'Separate boxes and scores tensors; labels optional; boxes use x1,y1,x2,y2',
        classLabels: 'generic',
      },
    ],
  },
  {
    id: 'face-detector',
    capability: 'face-match',
    displayName: 'Face detector',
    targetFileName: 'model.onnx',
    compatibility: 'YOLO-family ONNX face detector; landmarks are optional',
    maxSizeBytes: GIB,
    defaultProfileId: 'face-yolov8-640',
    profiles: [
      {
        id: 'face-yolov8-640',
        displayName: 'YOLOv8 face · 640',
        adapter: 'yolov8-face',
        compatibility: 'NCHW RGB 0..1; bbox/confidence with optional five landmarks',
      },
      {
        id: 'face-nms-640',
        displayName: 'Face detection with NMS · 640',
        adapter: 'nms-face',
        compatibility: 'NCHW RGB 0..1; output [N,6] as x1,y1,x2,y2,score,class',
      },
      {
        id: 'face-split-output',
        displayName: 'Separate face boxes / scores',
        adapter: 'split-face',
        compatibility: 'Separate boxes and scores tensors; boxes use x1,y1,x2,y2',
      },
      {
        id: 'face-scrfd-named',
        displayName: 'SCRFD · named stride outputs',
        adapter: 'scrfd-face',
        compatibility: 'NCHW RGB -1..1; output names contain score/bbox/kps and stride 8/16/32',
      },
      {
        id: 'face-scrfd-ordered',
        displayName: 'SCRFD · numeric/grouped outputs',
        adapter: 'scrfd-face-ordered',
        compatibility: 'Outputs grouped as score 8/16/32, bbox 8/16/32, then optional kps 8/16/32',
      },
      {
        id: 'face-retinaface-priorbox',
        displayName: 'RetinaFace · loc/conf/landms',
        adapter: 'retinaface-priorbox',
        compatibility: 'NCHW BGR with 104/117/123 mean; loc, conf and landms outputs or that order',
      },
    ],
  },
  {
    id: 'face-embedder',
    capability: 'face-match',
    displayName: 'Face embedder',
    targetFileName: 'model.onnx',
    compatibility: 'Face embedding ONNX; output dimension is detected at runtime',
    maxSizeBytes: GIB,
    defaultProfileId: 'face-arcface-112',
    profiles: [
      {
        id: 'face-arcface-112',
        displayName: 'ArcFace / AdaFace · 112',
        adapter: 'arcface-112',
        compatibility: 'NCHW RGB 112×112, normalized to -1..1',
      },
      {
        id: 'face-facenet-160',
        displayName: 'FaceNet · 160',
        adapter: 'facenet-160',
        compatibility: 'NCHW RGB 160×160, normalized to -1..1',
      },
    ],
  },
  {
    id: 'person-reid',
    capability: 'person-reid',
    displayName: 'Person ReID embedder',
    targetFileName: 'model.onnx',
    compatibility: 'Torchreid/FastReID-style ONNX; output dimension is detected at runtime',
    maxSizeBytes: GIB,
    defaultProfileId: 'reid-osnet-256x128',
    profiles: [
      {
        id: 'reid-osnet-256x128',
        displayName: 'OSNet / Torchreid · 256×128',
        adapter: 'reid-256x128',
        compatibility: 'NCHW RGB, ImageNet mean/std, dynamic batch or fixed batch 1',
      },
      {
        id: 'reid-fast-384x128',
        displayName: 'FastReID · 384×128',
        adapter: 'reid-384x128',
        compatibility: 'NCHW RGB, ImageNet mean/std, dynamic batch or fixed batch 1',
      },
    ],
  },
  {
    id: 'segment-encoder',
    capability: 'segmentation',
    displayName: 'Segmentation encoder',
    targetFileName: 'encoder.onnx',
    compatibility: 'SAM/MobileSAM ONNX image encoder; select its tensor layout',
    maxSizeBytes: GIB,
    defaultProfileId: 'sam-encoder-hwc-1024',
    profiles: [
      {
        id: 'sam-encoder-hwc-1024',
        displayName: 'SAM encoder · HWC 1024',
        adapter: 'sam-hwc-1024',
        compatibility: 'Float32 [1024,1024,3], ImageNet mean/std',
      },
      {
        id: 'sam-encoder-nchw-1024',
        displayName: 'SAM encoder · NCHW 1024',
        adapter: 'sam-nchw-1024',
        compatibility: 'Float32 [1,3,1024,1024], ImageNet mean/std',
      },
    ],
  },
  {
    id: 'segment-decoder',
    capability: 'segmentation',
    displayName: 'Segmentation decoder',
    targetFileName: 'decoder.onnx',
    compatibility: 'SAM ONNX decoder that accepts standard point-prompt tensors',
    maxSizeBytes: GIB,
    defaultProfileId: 'sam-decoder-original-size',
    profiles: [
      {
        id: 'sam-decoder-original-size',
        displayName: 'SAM decoder · original-size masks',
        adapter: 'sam-original-size-decoder',
        compatibility: 'Standard SAM inputs plus orig_im_size; masks output in original image size',
      },
    ],
  },
]

export function normalizeUserModelSlotId(value: unknown): UserModelSlotId | null {
  if (typeof value !== 'string') return null
  return USER_MODEL_SLOTS.some((slot) => slot.id === value) ? (value as UserModelSlotId) : null
}

export function getUserModelSlotDefinition(value: unknown): UserModelSlotDefinition | undefined {
  const id = normalizeUserModelSlotId(value)
  return id ? USER_MODEL_SLOTS.find((slot) => slot.id === id) : undefined
}

export function getUserModelProfileDefinition(
  rawSlotId: unknown,
  rawProfileId?: unknown,
): UserModelProfileDefinition | undefined {
  const slot = getUserModelSlotDefinition(rawSlotId)
  if (!slot) return undefined
  const profileId = typeof rawProfileId === 'string' ? rawProfileId : slot.defaultProfileId
  return slot.profiles.find((profile) => profile.id === profileId)
}
