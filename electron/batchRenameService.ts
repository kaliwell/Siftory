// ── Batch Rename Recovery Service ─────────────────────────
// Matches modified images to originals via perceptual hash
// and copies them with original names to an output directory.
//
// Uses fast_scanner's hashImageFileAsync (C++ addon) for hashing
// and JS-side Hamming distance for matching — never touches
// the live search index.

import path from 'path'
import fs from 'fs'
import { hashImageFileAsync } from './imageSearchService'
import { combinedScore, isImageFile } from './perceptualHashMatch'
import {
  batchRenameSourceFingerprintMatches,
  captureBatchRenameSourceFingerprint,
  copyBatchRenameCandidate,
  selectBatchRenameCandidates,
  type BatchRenameCandidate,
} from './batchRenamePolicy'
import type {
  BatchRenameProgress,
  BatchRenameResult,
  BatchRenameStartRequest,
} from '../shared/ipc-contract'

// ── Types ──────────────────────────────────────────────────

type ProgressCallback = (progress: BatchRenameProgress) => void

interface ImageHashEntry {
  path: string
  name: string
  diffHash64: string
  dctHash64: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function canonicalDirectoryPath(dirPath: string): string {
  let resolved: string
  try {
    resolved = fs.realpathSync.native(dirPath)
  } catch {
    resolved = path.resolve(dirPath)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// ── Image discovery ────────────────────────────────────────

function listImageFiles(dirPath: string): string[] {
  const result: string[] = []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && isImageFile(entry.name)) {
      result.push(path.join(dirPath, entry.name))
    }
  }
  return result
}

// ── State ──────────────────────────────────────────────────

let currentProgress: BatchRenameProgress | null = null
let currentResult: BatchRenameResult | null = null
let stopRequested = false

// ── Main orchestrator ──────────────────────────────────────

export async function startBatchRename(
  req: BatchRenameStartRequest,
  onProgress: ProgressCallback,
): Promise<{
  ok: boolean
  taskId?: string
  originCount?: number
  modifiedCount?: number
  error?: string
}> {
  // Refuse concurrent runs: progress/result state is module-level and a
  // second start would clobber the running task's state.
  if (
    currentProgress &&
    currentProgress.state !== 'done' &&
    currentProgress.state !== 'stopped' &&
    currentProgress.state !== 'error'
  ) {
    return { ok: false, error: 'A batch rename task is already running' }
  }

  const taskId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  stopRequested = false
  currentResult = null

  const threshold =
    typeof req.threshold === 'number' && req.threshold > 0 && req.threshold <= 1
      ? req.threshold
      : 0.85

  const conflictPolicy =
    req.conflictPolicy === 'skip' || req.conflictPolicy === 'keep-both'
      ? req.conflictPolicy
      : 'keep-best'

  // Validate dirs
  for (const dir of [req.originDir, req.modifiedDir]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: `Directory not found: ${dir}` }
    }
  }

  // Create output dir
  try {
    fs.mkdirSync(req.outputDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `Cannot create output directory: ${errorMessage(err)}` }
  }

  const outputDirectory = canonicalDirectoryPath(req.outputDir)
  if (
    outputDirectory === canonicalDirectoryPath(req.originDir) ||
    outputDirectory === canonicalDirectoryPath(req.modifiedDir)
  ) {
    return { ok: false, error: 'Output directory must be separate from both source directories' }
  }

  // Discover images
  const originFiles = listImageFiles(req.originDir)
  const modifiedFiles = listImageFiles(req.modifiedDir)

  if (originFiles.length === 0) {
    return { ok: false, error: 'No image files found in origin directory' }
  }
  if (modifiedFiles.length === 0) {
    return { ok: false, error: 'No image files found in modified directory' }
  }

  currentProgress = {
    taskId,
    state: 'scanning-origin',
    originTotal: originFiles.length,
    modifiedTotal: modifiedFiles.length,
    matched: 0,
    unmatched: 0,
    conflicts: 0,
    copied: 0,
    percent: 0,
    elapsedMs: 0,
  }
  onProgress({ ...currentProgress })

  const startedAt = Date.now()

  const emit = (patch: Partial<BatchRenameProgress>) => {
    if (!currentProgress) return
    currentProgress = { ...currentProgress, ...patch, elapsedMs: Date.now() - startedAt }
    onProgress({ ...currentProgress })
  }

  const originHashes: ImageHashEntry[] = []
  const modifiedImagePaths: string[] = []
  const candidates: BatchRenameCandidate[] = []
  const matched: BatchRenameResult['matched'] = []
  const unmatched: string[] = []
  const conflicts: string[] = []
  const originUsed = new Set<string>()

  const publishTerminalResult = (
    state: BatchRenameResult['state'],
    pending: string[],
    error?: string,
    pendingOriginals: string[] = [],
  ): void => {
    const pendingOriginalSet = new Set(pendingOriginals)
    currentResult = {
      taskId,
      state,
      matched: matched.map((item) => ({ ...item })),
      unmatched: [...unmatched],
      pending: [...new Set(pending)],
      pendingOriginals: [...pendingOriginalSet],
      conflicts: [...conflicts],
      skippedOriginals: originFiles.filter(
        (originPath) => !originUsed.has(originPath) && !pendingOriginalSet.has(originPath),
      ),
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    }
    emit({
      state,
      matched: matched.length,
      unmatched: unmatched.length,
      conflicts: conflicts.length,
      copied: matched.length,
      ...(state === 'done' ? { percent: 100 } : {}),
      ...(error ? { error } : {}),
    })
  }

  // Phase 1: hash origin images
  for (let i = 0; i < originFiles.length; i++) {
    if (stopRequested) {
      publishTerminalResult('stopped', modifiedFiles, undefined, originFiles.slice(i))
      return { ok: true, taskId }
    }
    const filePath = originFiles[i]
    try {
      const result = await hashImageFileAsync(filePath)
      if (result.ok && result.diffHash64 && result.dctHash64) {
        originHashes.push({
          path: filePath,
          name: path.basename(filePath),
          diffHash64: result.diffHash64,
          dctHash64: result.dctHash64,
        })
      }
    } catch {
      // skip unreadable files
    }
    if (i % 10 === 0) {
      emit({ currentFile: filePath, elapsedMs: Date.now() - startedAt })
    }
  }

  if (originHashes.length === 0) {
    const message = 'No origin images could be hashed'
    publishTerminalResult('error', modifiedFiles, message)
    return { ok: false, taskId, error: message }
  }

  // Phase 2: scan modified images
  emit({ state: 'scanning-modified', originTotal: originHashes.length })
  for (const fp of modifiedFiles) {
    if (stopRequested) {
      publishTerminalResult('stopped', modifiedFiles)
      return { ok: true, taskId }
    }
    modifiedImagePaths.push(fp)
  }

  // Phase 3: match each modified image
  emit({ state: 'matching' })
  for (let i = 0; i < modifiedImagePaths.length; i++) {
    if (stopRequested) {
      publishTerminalResult('stopped', [
        ...candidates.map((candidate) => candidate.modifiedPath),
        ...modifiedImagePaths.slice(i),
      ])
      return { ok: true, taskId }
    }
    const modPath = modifiedImagePaths[i]
    emit({
      currentFile: modPath,
      matched: matched.length,
      unmatched: unmatched.length,
      percent: Math.floor((i / modifiedImagePaths.length) * 70),
    })

    try {
      const beforeHash = captureBatchRenameSourceFingerprint(modPath)
      if (!beforeHash) {
        unmatched.push(modPath)
        conflicts.push(`${path.basename(modPath)}: source-unavailable-or-symbolic-link`)
        continue
      }
      const result = await hashImageFileAsync(modPath)
      if (!result.ok || !result.diffHash64) {
        unmatched.push(modPath)
        continue
      }
      const afterHash = captureBatchRenameSourceFingerprint(modPath)
      if (!batchRenameSourceFingerprintMatches(beforeHash, afterHash)) {
        unmatched.push(modPath)
        conflicts.push(`${path.basename(modPath)}: source-changed-during-hash`)
        continue
      }

      let bestScore = 0
      let bestOrigin: ImageHashEntry | null = null
      for (const origin of originHashes) {
        const score = combinedScore(
          result.diffHash64,
          origin.diffHash64,
          result.dctHash64 ?? '0',
          origin.dctHash64,
        )
        if (score > bestScore) {
          bestScore = score
          bestOrigin = origin
        }
      }

      if (bestOrigin && bestScore >= threshold) {
        const origExt = path.extname(bestOrigin.name)
        const origBase = path.basename(bestOrigin.name, origExt)
        const modExt = path.extname(modPath)
        candidates.push({
          originPath: bestOrigin.path,
          originalName: bestOrigin.name,
          modifiedPath: modPath,
          desiredOutputPath: path.join(req.outputDir, `${origBase}${modExt}`),
          score: bestScore,
          sourceFingerprint: afterHash ?? undefined,
        })
      } else {
        unmatched.push(modPath)
      }
    } catch {
      unmatched.push(modPath)
    }
  }

  const selection = selectBatchRenameCandidates(candidates, conflictPolicy)
  for (const rejected of selection.rejected) {
    unmatched.push(rejected.candidate.modifiedPath)
    conflicts.push(`${path.basename(rejected.candidate.modifiedPath)}: ${rejected.reason}`)
  }

  // Phase 4: copy only the final selected candidates. This keeps keep-best
  // deterministic and avoids replacing an earlier copy if a better match is
  // discovered later in the scan.
  const claimedOutputPaths = new Set<string>()
  for (let i = 0; i < selection.selected.length; i++) {
    const candidate = selection.selected[i]
    if (stopRequested) {
      publishTerminalResult(
        'stopped',
        selection.selected.slice(i).map((item) => item.modifiedPath),
      )
      return { ok: true, taskId }
    }

    emit({
      state: 'copying',
      currentFile: candidate.modifiedPath,
      matched: matched.length,
      unmatched: unmatched.length,
      conflicts: conflicts.length,
      copied: matched.length,
      percent: 70 + Math.floor((i / Math.max(1, selection.selected.length)) * 30),
    })

    try {
      const copyResult = await copyBatchRenameCandidate(
        candidate,
        conflictPolicy,
        claimedOutputPaths,
      )
      if (!copyResult.ok) {
        unmatched.push(candidate.modifiedPath)
        conflicts.push(
          `${path.basename(candidate.modifiedPath)} -> ${path.basename(copyResult.outputPath)}: ${copyResult.reason ?? 'existing-output-preserved'}`,
        )
        continue
      }

      if (copyResult.collision) {
        conflicts.push(
          `${path.basename(candidate.modifiedPath)} -> ${path.basename(copyResult.outputPath)}: kept-both`,
        )
      }
      originUsed.add(candidate.originPath)
      matched.push({
        originalName: candidate.originalName,
        modifiedPath: candidate.modifiedPath,
        outputPath: copyResult.outputPath,
        score: Math.round(candidate.score * 1000) / 1000,
        ...(copyResult.publishMode ? { publishMode: copyResult.publishMode } : {}),
      })
    } catch (copyError) {
      const message = `Copy failed for ${path.basename(candidate.modifiedPath)}: ${errorMessage(copyError)}`
      publishTerminalResult(
        'error',
        selection.selected.slice(i).map((item) => item.modifiedPath),
        message,
      )
      return { ok: false, taskId, error: message }
    }
  }

  publishTerminalResult('done', [])

  return {
    ok: true,
    taskId,
    originCount: originHashes.length,
    modifiedCount: modifiedImagePaths.length,
  }
}

export function stopBatchRename(): void {
  stopRequested = true
}

export function getBatchRenameProgress(): BatchRenameProgress | null {
  return currentProgress ? { ...currentProgress } : null
}

export function getBatchRenameResult(): BatchRenameResult | null {
  return currentResult
    ? {
        ...currentResult,
        matched: currentResult.matched.map((item) => ({ ...item })),
        unmatched: [...currentResult.unmatched],
        pending: [...currentResult.pending],
        pendingOriginals: [...currentResult.pendingOriginals],
        conflicts: [...currentResult.conflicts],
        skippedOriginals: [...currentResult.skippedOriginals],
      }
    : null
}
