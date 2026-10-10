import React, { useState } from 'react'
import { useFMStore } from '../../stores/useFMStore'
import { useTranslation } from '../../i18n/useTranslation'

interface QuickAccessProps {
  onSelect: (path: string) => void
}

const QuickAccess: React.FC<QuickAccessProps> = ({ onSelect }) => {
  const { t } = useTranslation()
  const favorites = useFMStore((s) => s.fmFavorites) || []
  const setFMFavorites = useFMStore((s) => s.setFMFavorites)
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addPath, setAddPath] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number } | null>(null)

  const handleBrowse = async () => {
    const folder = await window.electronAPI.browseFolder()
    if (folder) setAddPath(folder)
  }

  const handleAdd = () => {
    if (addName.trim() && addPath.trim()) {
      const updated = [...favorites, { name: addName.trim(), path: addPath.trim() }]
      setFMFavorites(updated)
      setAddName('')
      setAddPath('')
      setShowAdd(false)
    }
  }

  const handleDelete = (idx: number) => {
    const updated = favorites.filter((_, i) => i !== idx)
    setFMFavorites(updated)
    setCtxMenu(null)
  }

  const handleSelect = async (p: string) => {
    const expanded = await window.electronAPI.fmExpandPath(p)
    onSelect(expanded)
  }

  return (
    <div
      style={{
        padding: '4px 6px',
        borderBottom: '1px solid rgba(var(--date), 0.2)',
        contain: 'layout style paint',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginBottom: 4,
          fontSize: 10,
          opacity: 0.5,
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}
      >
        {t('Quick Access')}
        <button
          onClick={() => setShowAdd(!showAdd)}
          style={{ fontSize: 10, padding: '0 4px', marginLeft: 'auto' }}
        >
          {showAdd ? '−' : '+'}
        </button>
      </div>

      {showAdd && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4 }}>
          <input
            placeholder={t('Name')}
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            style={{ fontSize: 10, padding: '2px 4px' }}
          />
          <div style={{ display: 'flex', gap: 2 }}>
            <input
              placeholder={t('Path')}
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              style={{ flex: 1, fontSize: 10, padding: '2px 4px' }}
            />
            <button onClick={handleBrowse} style={{ fontSize: 10, padding: '2px 4px' }}>
              ...
            </button>
          </div>
          <button onClick={handleAdd} style={{ fontSize: 10, padding: '2px 8px' }}>
            {t('Add')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {favorites.map((fav, i) => (
          <button
            key={i}
            onClick={() => handleSelect(fav.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu({ x: e.clientX, y: e.clientY, idx: i })
            }}
            style={{ fontSize: 10, padding: '2px 6px', whiteSpace: 'nowrap' }}
            title={fav.path}
          >
            {t(fav.name)}
          </button>
        ))}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setCtxMenu(null)}
          />
          <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div className="context-menu-item" onClick={() => handleDelete(ctxMenu.idx)}>
              {t('Remove')}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default React.memo(QuickAccess)
