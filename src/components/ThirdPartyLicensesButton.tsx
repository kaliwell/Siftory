import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

type LicenseFolderState = 'idle' | 'opening' | 'opened' | 'unavailable' | 'open-failed'

export default function ThirdPartyLicensesButton() {
  const { t } = useTranslation()
  const [state, setState] = useState<LicenseFolderState>('idle')

  const openLicenses = async () => {
    if (state === 'opening') return
    setState('opening')
    try {
      const result = await window.electronAPI?.openThirdPartyLicenses()
      setState(
        result?.ok ? 'opened' : result?.reason === 'unavailable' ? 'unavailable' : 'open-failed',
      )
    } catch {
      setState('open-failed')
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="settings-third-party-licenses"
        aria-describedby="third-party-licenses-description"
        disabled={state === 'opening'}
        onClick={() => void openLicenses()}
        style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
      >
        {state === 'opening' ? t('Opening license folder...') : t('Third-party licenses')}
      </button>
      <div
        id="third-party-licenses-description"
        style={{ fontSize: 10, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}
      >
        {t('Open the folder containing third-party licenses and notices.')}
      </div>
      <div role="status" aria-live="polite" style={{ fontSize: 10, marginTop: 4 }}>
        {state === 'opened' && t('License folder opened.')}
        {state === 'unavailable' &&
          t(
            'The license folder is missing or unavailable. Restore the application files and try again.',
          )}
        {state === 'open-failed' && t('Could not open the license folder. Please try again.')}
      </div>
    </div>
  )
}
