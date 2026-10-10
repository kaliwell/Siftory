export type AssetFeedbackMode = 'off' | 'auto' | 'force'

export type AssetFeedbackModelState = 'missing' | 'dirty' | 'building' | 'ready' | 'error'

export interface AssetFeedbackModelStatus {
  enabled: boolean
  state: AssetFeedbackModelState
  modelName: 'clip_vit_base_patch32'
  revision: number
  builtRevision: number
  targetCount: number
  positiveSampleCount: number
  negativeSampleCount: number
  positivePrototypeCount: number
  negativePrototypeCount: number
  embeddedSampleCount: number
  skippedSampleCount: number
  builtAt?: number
  updatedAt: number
  dirtyReason?: string
  error?: string
}

export const ASSET_FEEDBACK_IPC = {
  GET_STATUS: 'assetFeedback:getStatus',
  SET_ENABLED: 'assetFeedback:setEnabled',
  REBUILD: 'assetFeedback:rebuild',
} as const
