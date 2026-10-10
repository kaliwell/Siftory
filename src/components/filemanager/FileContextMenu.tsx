import React, { useState } from 'react'
import { useFMStore } from '../../stores/useFMStore'
import { useFileOperations } from '../../hooks/useFileOperations'
import ConfirmDialog from './ConfirmDialog'
import type { FileEntry } from './types'
import { useTranslation } from '../../i18n/useTranslation'

interface FileContextMenuProps {
  x: number
  y: number
  file: FileEntry | null
  currentDir: string
  selectedPaths: string[]
  onClose: () => void
  onRefresh: () => void
  onNavigate: (path: string) => void
}

const FileContextMenu: React.FC<FileContextMenuProps> = ({
  x,
  y,
  file,
  currentDir,
  selectedPaths,
  onClose,
  onRefresh,
  onNavigate,
}) => {
  const { t } = useTranslation()
  const setFMClipboard = useFMStore((s) => s.setFMClipboard)
  const fmClipboard = useFMStore((s) => s.fmClipboard)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showRename, setShowRename] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { copyFiles, moveFiles, confirmReq } = useFileOperations()

  const targetPaths = selectedPaths.length > 0 ? selectedPaths : file ? [file.path] : []

  const handleOpen = async () => {
    if (file) {
      if (file.isDirectory) {
        onNavigate(file.path)
      } else {
        await window.electronAPI.fmOpenFile(file.path)
      }
    }
    onClose()
  }

  const handleOpenInExplorer = async () => {
    const p = file ? file.path : currentDir
    await window.electronAPI.fmOpenInExplorer(p)
    onClose()
  }

  const handleCopy = () => {
    setFMClipboard({ paths: targetPaths, operation: 'copy' })
    onClose()
  }

  const handleCut = () => {
    setFMClipboard({ paths: targetPaths, operation: 'cut' })
    onClose()
  }

  const handlePaste = async () => {
    if (!fmClipboard) return
    if (fmClipboard.operation === 'cut') {
      await moveFiles(fmClipboard.paths, currentDir, () => {
        onRefresh()
        onClose()
      })
      setFMClipboard(null)
    } else {
      await copyFiles(fmClipboard.paths, currentDir, () => {
        onRefresh()
        onClose()
      })
    }
  }

  const handleDelete = () => {
    setShowDeleteConfirm(true)
  }

  const confirmDelete = async () => {
    await window.electronAPI.fmDeleteFiles(targetPaths)
    setShowDeleteConfirm(false)
    onRefresh()
    onClose()
  }

  const handleNewFolder = async () => {
    if (newFolderName.trim()) {
      await window.electronAPI.fmCreateDirectory(currentDir, newFolderName.trim())
      setShowNewFolder(false)
      setNewFolderName('')
      onRefresh()
    }
    onClose()
  }

  const handleRenameStart = () => {
    if (file) {
      setRenameName(file.name)
      setRenameError('')
      setShowRename(true)
    }
  }

  const handleRenameOk = async () => {
    if (renameBusy || !file || !renameName.trim()) return
    if (renameName.trim() === file.name) {
      setShowRename(false)
      onClose()
      return
    }
    setRenameBusy(true)
    setRenameError('')
    try {
      const result = await window.electronAPI.fmRenameFile(file.path, renameName.trim())
      if (!result.success) {
        setRenameError(result.error || t('Rename failed'))
        return
      }
      setShowRename(false)
      onRefresh()
      onClose()
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenameBusy(false)
    }
  }

  const handleBrowse = async () => {
    const folder = await window.electronAPI.browseFolder()
    if (folder) onNavigate(folder)
    onClose()
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={onClose} />
      <div className="context-menu" style={{ left: x, top: y, zIndex: 1000 }}>
        {file && (
          <>
            <div className="context-menu-item" onClick={handleOpen}>
              {t('Open')}
            </div>
            <div className="context-menu-item" onClick={handleCopy}>
              {t('Copy')}
            </div>
            <div className="context-menu-item" onClick={handleCut}>
              {t('Cut')}
            </div>
            <div className="context-menu-item" onClick={handleRenameStart}>
              <span style={{ flex: 1 }}>{t('Rename')}</span>
              <span style={{ opacity: 0.35, fontSize: 9 }}>F2</span>
            </div>
            <div
              className="context-menu-item"
              onClick={handleDelete}
              style={{ color: 'rgb(255, 100, 100)' }}
            >
              {t('Delete')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={handleOpenInExplorer}>
              {t('Show in Explorer')}
            </div>
          </>
        )}
        {!file && (
          <>
            <div className="context-menu-item" onClick={() => setShowNewFolder(true)}>
              {t('New Folder')}
            </div>
            {selectedPaths.length > 0 && (
              <>
                <div className="context-menu-item" onClick={handleCopy}>
                  {t('Copy')}
                </div>
                <div className="context-menu-item" onClick={handleCut}>
                  {t('Cut')}
                </div>
              </>
            )}
            {fmClipboard && (
              <div className="context-menu-item" onClick={handlePaste}>
                {t('Paste')} ({t(fmClipboard.operation === 'cut' ? 'Move' : 'Copy')})
              </div>
            )}
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={onRefresh}>
              {t('Refresh')}
            </div>
            <div className="context-menu-item" onClick={handleBrowse}>
              {t('Choose Folder...')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={handleOpenInExplorer}>
              {t('Open in Explorer')}
            </div>
          </>
        )}
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1001 }}
            onClick={() => setShowNewFolder(false)}
          />
          <div
            style={{
              position: 'fixed',
              top: y + 100,
              left: x,
              zIndex: 1002,
              background: 'rgba(var(--bg), 0.97)',
              border: '1px solid rgba(var(--date), 0.5)',
              borderRadius: 4,
              padding: 8,
              display: 'flex',
              gap: 4,
            }}
          >
            <input
              autoFocus
              placeholder={t('Folder name')}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewFolder()
                if (e.key === 'Escape') setShowNewFolder(false)
              }}
              style={{ width: 160 }}
            />
            <button onClick={handleNewFolder}>{t('Create')}</button>
          </div>
        </>
      )}

      {/* Rename input */}
      {showRename && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1001 }}
            onClick={() => {
              if (!renameBusy) setShowRename(false)
            }}
          />
          <div
            style={{
              position: 'fixed',
              top: y + 100,
              left: x,
              zIndex: 1002,
              background: 'rgba(var(--bg), 0.97)',
              border: '1px solid rgba(var(--date), 0.5)',
              borderRadius: 4,
              padding: 8,
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
            }}
          >
            <input
              autoFocus
              value={renameName}
              disabled={renameBusy}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameOk()
                if (e.key === 'Escape') setShowRename(false)
              }}
              style={{ width: 200 }}
            />
            <button disabled={renameBusy} onClick={handleRenameOk}>
              {t('OK')}
            </button>
            {renameError && (
              <div role="alert" style={{ width: '100%' }}>
                {t('Rename failed')}: {renameError}
              </div>
            )}
          </div>
        </>
      )}

      {/* Paste overwrite confirm (from useFileOperations hook) */}
      {confirmReq && <ConfirmDialog request={confirmReq} />}

      {/* Delete confirm */}
      {showDeleteConfirm && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(0,0,0,0.3)' }}
            onClick={() => setShowDeleteConfirm(false)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1002,
              background: 'rgba(var(--bg), 0.97)',
              border: '1px solid rgba(var(--date), 0.5)',
              borderRadius: 6,
              padding: 16,
              minWidth: 300,
            }}
          >
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              {t('Delete {count} items?', { count: targetPaths.length })}
              <br />
              <span style={{ fontSize: 10, opacity: 0.5 }}>
                {t('(files will be moved to Recycle Bin)')}
              </span>
            </div>
            {targetPaths.slice(0, 5).map((p, i) => (
              <div key={i} style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>
                • {p.replace(/\\/g, '/').split('/').pop()}
              </div>
            ))}
            {targetPaths.length > 5 && (
              <div style={{ fontSize: 10, opacity: 0.5 }}>
                ...{t('and {count} more', { count: targetPaths.length - 5 })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={confirmDelete} style={{ background: 'rgba(255, 80, 80, 0.35)' }}>
                {t('Delete')}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)}>{t('Cancel')}</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export default FileContextMenu
