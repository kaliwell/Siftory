import React from 'react'
import { assetLibraryButtonStyle } from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

interface AssetLibraryModeTabsProps<T extends string> {
  value: T
  tabs: Array<[T, string]>
  onChange(value: T): void
  children: React.ReactNode
}

const AssetLibraryModeTabs = <T extends string>({
  value,
  tabs,
  onChange,
  children,
}: AssetLibraryModeTabsProps<T>) => {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 3,
          alignItems: 'center',
          borderBottom: '1px solid rgba(var(--date),0.12)',
          paddingBottom: 3,
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            data-testid={`asset-mode-${id}`}
            onClick={() => onChange(id)}
            style={{
              ...assetLibraryButtonStyle,
              color: value === id ? 'rgb(85,220,160)' : undefined,
              borderColor: value === id ? 'rgb(85,220,160)' : undefined,
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {children}
    </div>
  )
}

export default AssetLibraryModeTabs
