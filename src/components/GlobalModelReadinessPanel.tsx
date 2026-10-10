import React from 'react'
import { useTranslation } from '../i18n/useTranslation'
import type {
  GlobalModelGroup,
  GlobalModelId,
  GlobalModelReadinessSnapshot,
  GlobalModelReadinessState,
} from '../services/globalModelReadiness'

const MODEL_LABELS: Record<GlobalModelId, string> = {
  dinov2_vitb14: 'DINO',
  clip_vit_base_patch32: 'CLIP',
  clip_vit_b32_multilingual_v1_text: 'Multilingual CLIP',
  'qwen3-vl': 'Qwen3-VL',
  sensevoice: 'SenseVoice',
  'fsmn-vad': 'FSMN VAD',
  'campplus-speaker': 'CAMPPlus Speaker',
  'subject-detector': 'Subject detector',
  'face-detector': 'Face detector',
  'face-embedder': 'Face embedder',
  'person-reid': 'Person ReID embedder',
  'segment-encoder': 'Segmentation encoder',
  'segment-decoder': 'Segmentation decoder',
}

const GROUP_LABELS: Record<GlobalModelGroup, string> = {
  image: 'Image search models',
  video: 'Video semantic models',
  audio: 'Audio semantic models',
  subject: 'Subject and segmentation models',
}

const STATE_LABELS: Record<GlobalModelReadinessState, string> = {
  checking: 'Checking models',
  ready: 'Model ready',
  busy: 'Model busy',
  'not-installed': 'Model not installed',
  unavailable: 'Model unavailable',
  error: 'Model error',
}

const GROUP_ORDER: readonly GlobalModelGroup[] = ['image', 'video', 'audio', 'subject']

interface GlobalModelReadinessPanelProps {
  snapshot: GlobalModelReadinessSnapshot
  checking: boolean
  deepChecking: boolean
  onRefresh: () => void
  onManage: () => void
}

const GlobalModelReadinessPanel: React.FC<GlobalModelReadinessPanelProps> = ({
  snapshot,
  checking,
  deepChecking,
  onRefresh,
  onManage,
}) => {
  const { t } = useTranslation()

  return (
    <section
      className={`global-model-readiness is-${snapshot.state}`}
      data-testid="global-model-readiness"
      aria-label={t('Model status')}
      aria-busy={checking || deepChecking}
    >
      <div className="global-model-readiness__header">
        <strong>{t('Model status')}</strong>
        <span data-testid="global-model-readiness-summary">
          {t('{ready}/{total} models available', {
            ready: snapshot.readyCount,
            total: snapshot.totalCount,
          })}
          {snapshot.busyCount > 0 ? ` · ${t('{count} busy', { count: snapshot.busyCount })}` : ''}
        </span>
        <button type="button" disabled={deepChecking} onClick={onRefresh}>
          {t(deepChecking ? 'Checking models' : 'Deep model check')}
        </button>
        <button type="button" onClick={onManage}>
          {t('Model settings')}
        </button>
      </div>

      <div className="global-model-readiness__groups" aria-live="polite">
        {GROUP_ORDER.map((group) => {
          const items = snapshot.items.filter((item) => item.group === group)
          return (
            <section key={group} className="global-model-readiness__group">
              <h3>{t(GROUP_LABELS[group])}</h3>
              <div className="global-model-readiness__grid">
                {items.map((item) => (
                  <article
                    key={item.id}
                    className={`is-${item.state}`}
                    data-testid={`global-model-${item.id}`}
                    data-model-ready={item.state === 'ready'}
                    data-runtime-checked={item.runtimeChecked}
                    title={item.detail}
                  >
                    <strong>{t(MODEL_LABELS[item.id])}</strong>
                    <span>{t(STATE_LABELS[item.state])}</span>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {snapshot.issues.length > 0 && (
        <p className="global-model-readiness__issues">
          {t('{count} model checks could not be completed', { count: snapshot.issues.length })}
        </p>
      )}
    </section>
  )
}

export default React.memo(GlobalModelReadinessPanel)
