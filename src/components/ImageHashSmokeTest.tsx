import React from 'react'
import type { ImageHashResult } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

interface ImageHashSmokeTestProps {
  testImagePath: string | null
  hashing: boolean
  hashResult: ImageHashResult | null
  onSelectTestImage: () => void
}

const ImageHashSmokeTest: React.FC<ImageHashSmokeTestProps> = ({
  testImagePath,
  hashing,
  hashResult,
  onSelectTestImage,
}) => {
  const { t } = useTranslation()
  return (
    <div
      style={{
        padding: '4px 6px',
        borderTop: '1px solid rgba(var(--date),0.15)',
        flexShrink: 0,
        fontSize: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.7 }}>
        <button
          onClick={onSelectTestImage}
          disabled={hashing}
          style={{ fontSize: 10, padding: '2px 8px' }}
        >
          {hashing ? t('Hashing...') : t('Test Image')}
        </button>
        {testImagePath && (
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.5,
            }}
          >
            {testImagePath.split('\\').pop()}
          </span>
        )}
      </div>
      {hashResult && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {hashResult.ok ? (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>
                  {hashResult.width}x{hashResult.height}
                </span>
                <span>{t('{count} ch', { count: hashResult.channels ?? '-' })}</span>
                <span>{((hashResult.fileSize || 0) / 1024).toFixed(1)} KB</span>
                <span>
                  {t('Decode {milliseconds} ms', {
                    milliseconds: hashResult.decodeMs?.toFixed(1) ?? '-',
                  })}
                </span>
                <span>
                  {t('Hash {milliseconds} ms', {
                    milliseconds: hashResult.hashMs?.toFixed(1) ?? '-',
                  })}
                </span>
              </div>
              <div
                style={{
                  fontFamily: 'Consolas, monospace',
                  fontSize: 10,
                  wordBreak: 'break-all',
                  background: 'rgba(var(--date),0.12)',
                  padding: '2px 6px',
                  borderRadius: 2,
                }}
              >
                DiffHash64: {hashResult.diffHash64}
              </div>
              {hashResult.dctHash64 && (
                <div
                  style={{
                    fontFamily: 'Consolas, monospace',
                    fontSize: 10,
                    wordBreak: 'break-all',
                    background: 'rgba(var(--date),0.08)',
                    padding: '2px 6px',
                    borderRadius: 2,
                    opacity: 0.85,
                  }}
                >
                  DctHash64: {hashResult.dctHash64}
                </div>
              )}
              {hashResult.diffHash256 && (
                <div
                  style={{
                    fontFamily: 'Consolas, monospace',
                    fontSize: 8,
                    wordBreak: 'break-all',
                    background: 'rgba(var(--date),0.05)',
                    padding: '2px 6px',
                    borderRadius: 2,
                    opacity: 0.7,
                  }}
                >
                  Diff256: {hashResult.diffHash256.slice(0, 16)}...
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'rgb(255,100,100)' }}>
              {t('Error')}: {hashResult.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ImageHashSmokeTest
