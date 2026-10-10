import { useCallback, useEffect, useRef, useState } from 'react'
import { useFMStore } from '../stores/useFMStore'
import type { ConfirmRequest } from '../components/filemanager/ConfirmDialog'
import type { ProgressInfo } from '../components/filemanager/types'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeProgressStatus(status: string): ProgressInfo['status'] {
  return status === 'paused' ||
    status === 'done' ||
    status === 'partial' ||
    status === 'error' ||
    status === 'cancelled'
    ? status
    : 'running'
}

/**
 * Hook that wraps file copy/move operations with:
 * - Overwrite conflict resolution
 * - Progress tracking
 * - Path existence checks
 */
export function useFileOperations() {
  const setFMProgress = useFMStore((s) => s.setFMProgress)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)

  // Register progress listener
  const progressUnsub = useRef<(() => void) | null>(null)

  const ensureProgressListener = useCallback(() => {
    if (progressUnsub.current) return
    progressUnsub.current = window.electronAPI.onFMCopyProgress((info) => {
      setFMProgress({
        currentFile: info.currentFile || '',
        completed: info.completed || 0,
        total: info.total || 0,
        percentage: info.percentage || 0,
        status: normalizeProgressStatus(info.status),
      })
    })
  }, [setFMProgress])

  const cleanupProgress = useCallback(() => {
    if (progressUnsub.current) {
      progressUnsub.current()
      progressUnsub.current = null
    }
  }, [])

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (progressUnsub.current) {
        progressUnsub.current()
        progressUnsub.current = null
      }
    }
  }, [])

  const askOverwrite = useCallback((srcName: string): Promise<string> => {
    return new Promise((resolve) => {
      setConfirmReq({
        message: `"${srcName}" already exists in the destination.`,
        detail: 'What would you like to do?',
        options: [
          { label: 'Overwrite', value: 'overwrite' },
          { label: 'Skip', value: 'skip' },
          { label: 'Rename', value: 'rename' },
          { label: 'Cancel All', value: 'cancel' },
        ],
        onResolve: (v) => {
          setConfirmReq(null)
          resolve(v)
        },
      })
    })
  }, [])

  const copyFiles = useCallback(
    async (sources: string[], destDir: string, onComplete?: () => void) => {
      ensureProgressListener()
      setFMProgress({
        currentFile: '',
        completed: 0,
        total: sources.length,
        percentage: 0,
        status: 'running',
      })

      // Check for existing files
      const existing: string[] = []
      for (const src of sources) {
        const name = src.replace(/\\/g, '/').split('/').pop() || src
        const destPath = destDir + '\\' + name
        const exists = await window.electronAPI.fmPathExists(destPath)
        if (exists) existing.push(name)
      }

      let conflict: 'overwrite' | 'rename' = 'overwrite'
      if (existing.length > 0) {
        const choice = await askOverwrite(
          existing.length === 1 ? existing[0] : `${existing.length} files`,
        )
        if (choice === 'cancel') {
          setFMProgress(null)
          return
        }
        if (choice === 'skip') {
          // Filter out files that already exist in destination
          const filtered = sources.filter((src) => {
            const name = src.replace(/\\/g, '/').split('/').pop() || src
            return !existing.includes(name)
          })
          if (filtered.length === 0) {
            setFMProgress(null)
            return
          }
          sources = filtered
        }
        if (choice === 'rename') {
          conflict = 'rename'
        }
      }

      try {
        const results = await window.electronAPI.fmCopyFiles(sources, destDir, { conflict })
        const failed = results.filter((r) => !r.success)
        if (failed.length > 0) {
          const failedNames = failed.map(
            (r) => r.path.replace(/\\/g, '/').split('/').pop() || r.path,
          )
          setFMProgress({
            currentFile: '',
            completed: sources.length - failed.length,
            total: sources.length,
            percentage: 100,
            status: failed.length < sources.length ? 'partial' : 'error',
            error: `${failed.length} of ${sources.length} file(s) failed`,
            failedFiles: failedNames,
          })
        } else {
          setFMProgress({
            currentFile: '',
            completed: sources.length,
            total: sources.length,
            percentage: 100,
            status: 'done',
          })
        }
      } catch (e: unknown) {
        setFMProgress({
          currentFile: '',
          completed: 0,
          total: sources.length,
          percentage: 0,
          status: 'error',
          error: errorMessage(e),
        })
      }

      onComplete?.()
    },
    [ensureProgressListener, setFMProgress, askOverwrite],
  )

  const moveFiles = useCallback(
    async (sources: string[], destDir: string, onComplete?: () => void) => {
      ensureProgressListener()
      setFMProgress({
        currentFile: '',
        completed: 0,
        total: sources.length,
        percentage: 0,
        status: 'running',
      })

      // Check for existing files at destination
      const existing: string[] = []
      for (const src of sources) {
        const name = src.replace(/\\/g, '/').split('/').pop() || src
        const destPath = destDir + '\\' + name
        const exists = await window.electronAPI.fmPathExists(destPath)
        if (exists) existing.push(name)
      }

      let conflict: 'overwrite' | 'rename' = 'overwrite'
      if (existing.length > 0) {
        const choice = await askOverwrite(
          existing.length === 1 ? existing[0] : `${existing.length} files`,
        )
        if (choice === 'cancel') {
          setFMProgress(null)
          return
        }
        if (choice === 'skip') {
          const filtered = sources.filter((src) => {
            const name = src.replace(/\\/g, '/').split('/').pop() || src
            return !existing.includes(name)
          })
          if (filtered.length === 0) {
            setFMProgress(null)
            return
          }
          sources = filtered
        }
        if (choice === 'rename') conflict = 'rename'
      }

      try {
        const results = await window.electronAPI.fmMoveFiles(sources, destDir, { conflict })
        const failed = results.filter((r) => !r.success)
        if (failed.length > 0) {
          const failedNames = failed.map(
            (r) => r.path.replace(/\\/g, '/').split('/').pop() || r.path,
          )
          setFMProgress({
            currentFile: '',
            completed: sources.length - failed.length,
            total: sources.length,
            percentage: 100,
            status: failed.length < sources.length ? 'partial' : 'error',
            error: `${failed.length} of ${sources.length} file(s) failed`,
            failedFiles: failedNames,
          })
        } else {
          setFMProgress({
            currentFile: '',
            completed: sources.length,
            total: sources.length,
            percentage: 100,
            status: 'done',
          })
        }
      } catch (e: unknown) {
        setFMProgress({
          currentFile: '',
          completed: 0,
          total: sources.length,
          percentage: 0,
          status: 'error',
          error: errorMessage(e),
        })
      }

      onComplete?.()
    },
    [ensureProgressListener, setFMProgress, askOverwrite],
  )

  return { copyFiles, moveFiles, cleanupProgress, confirmReq, setConfirmReq }
}
