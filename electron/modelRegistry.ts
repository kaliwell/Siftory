export type VisionModelName = 'dinov2_vitb14' | 'clip_vit_base_patch32'

export interface VisionModelCapability {
  name: VisionModelName
  label: string
  dim: number
  childEntry: string
  defaultBackend: 'cpu' | 'gpu'
  supportsTextQuery: boolean
  supportsImageQuery: boolean
}

export const VISION_MODEL_REGISTRY: Record<VisionModelName, VisionModelCapability> = {
  dinov2_vitb14: {
    name: 'dinov2_vitb14',
    label: 'DINO',
    dim: 768,
    childEntry: 'dinoEmbeddingChild.js',
    defaultBackend: 'gpu',
    supportsTextQuery: false,
    supportsImageQuery: true,
  },
  clip_vit_base_patch32: {
    name: 'clip_vit_base_patch32',
    label: 'CLIP',
    dim: 512,
    childEntry: 'clipEmbeddingChild.js',
    defaultBackend: 'gpu',
    supportsTextQuery: true,
    supportsImageQuery: true,
  },
}

export function isVisionModelName(value: unknown): value is VisionModelName {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(VISION_MODEL_REGISTRY, value)
  )
}

export function getVisionModelCapability(modelName: VisionModelName): VisionModelCapability {
  return VISION_MODEL_REGISTRY[modelName]
}
