import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export type BatchRenameConflictPolicy = 'keep-best' | 'skip' | 'keep-both'

export interface BatchRenameSourceFingerprint {
  device: string
  inode: string
  size: string
  modifiedNs: string
  changedNs: string
}

export interface BatchRenameCandidate {
  originPath: string
  originalName: string
  modifiedPath: string
  desiredOutputPath: string
  score: number
  sourceFingerprint?: BatchRenameSourceFingerprint
}

export interface RejectedBatchRenameCandidate {
  candidate: BatchRenameCandidate
  reason:
    | 'same-origin-lower-score'
    | 'same-origin-conflict'
    | 'same-output-lower-score'
    | 'same-output-conflict'
}

export interface BatchRenameCandidateSelection {
  selected: BatchRenameCandidate[]
  rejected: RejectedBatchRenameCandidate[]
}

export interface BatchRenameCopyResult {
  ok: boolean
  outputPath: string
  collision: boolean
  reason?: 'existing-output' | 'source-changed'
  publishMode?: 'atomic-link' | 'exclusive-copy'
}

type LinkPreparedPath = (preparedPath: string, outputPath: string) => Promise<void>

function outputPathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function captureBatchRenameSourceFingerprint(
  filePath: string,
): BatchRenameSourceFingerprint | null {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
      modifiedNs: stat.mtimeNs.toString(),
      changedNs: stat.ctimeNs.toString(),
    }
  } catch {
    return null
  }
}

export function batchRenameSourceFingerprintMatches(
  expected: BatchRenameSourceFingerprint | undefined,
  actual: BatchRenameSourceFingerprint | null,
): boolean {
  if (!expected || !actual) return false
  return (
    expected.device === actual.device &&
    expected.inode === actual.inode &&
    expected.size === actual.size &&
    expected.modifiedNs === actual.modifiedNs &&
    expected.changedNs === actual.changedNs
  )
}

export function selectBatchRenameCandidates(
  candidates: BatchRenameCandidate[],
  policy: BatchRenameConflictPolicy,
): BatchRenameCandidateSelection {
  if (policy === 'keep-both') return { selected: [...candidates], rejected: [] }

  const selected: BatchRenameCandidate[] = []
  const rejected: RejectedBatchRenameCandidate[] = []
  const claimedOrigins = new Set<string>()
  const claimedOutputs = new Set<string>()
  const ordered =
    policy === 'keep-best'
      ? [...candidates].sort(
          (left, right) =>
            right.score - left.score ||
            left.modifiedPath.localeCompare(right.modifiedPath, 'en', { sensitivity: 'base' }),
        )
      : candidates

  for (const candidate of ordered) {
    const originConflict = claimedOrigins.has(candidate.originPath)
    const outputKey = outputPathKey(candidate.desiredOutputPath)
    const outputConflict = claimedOutputs.has(outputKey)
    if (!originConflict && !outputConflict) {
      claimedOrigins.add(candidate.originPath)
      claimedOutputs.add(outputKey)
      selected.push(candidate)
      continue
    }

    rejected.push({
      candidate,
      reason: originConflict
        ? policy === 'keep-best'
          ? 'same-origin-lower-score'
          : 'same-origin-conflict'
        : policy === 'keep-best'
          ? 'same-output-lower-score'
          : 'same-output-conflict',
    })
  }

  return { selected, rejected }
}

function suffixedOutputPath(desiredOutputPath: string, counter: number): string {
  const extension = path.extname(desiredOutputPath)
  const basename = path.basename(desiredOutputPath, extension)
  return path.join(path.dirname(desiredOutputPath), `${basename}_${counter}${extension}`)
}

function isAlreadyOccupied(filePath: string, claimedOutputPaths: Set<string>): boolean {
  return claimedOutputPaths.has(outputPathKey(filePath)) || fs.existsSync(filePath)
}

function isFilesystemCapabilityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return (
    code === 'EPERM' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS' ||
    code === 'EXDEV' ||
    code === 'EINVAL'
  )
}

/**
 * Copies to a hidden sibling, then atomically publishes it through
 * a no-replace hard link. Existing final paths are never replaced, and a
 * crash can expose at most a hidden prepared file rather than a partial final.
 */
export async function copyBatchRenameCandidate(
  candidate: BatchRenameCandidate,
  policy: BatchRenameConflictPolicy,
  claimedOutputPaths: Set<string>,
  linkPreparedPath: LinkPreparedPath = fs.promises.link.bind(fs.promises),
): Promise<BatchRenameCopyResult> {
  if (
    !batchRenameSourceFingerprintMatches(
      candidate.sourceFingerprint,
      captureBatchRenameSourceFingerprint(candidate.modifiedPath),
    )
  ) {
    return {
      ok: false,
      outputPath: candidate.desiredOutputPath,
      collision: false,
      reason: 'source-changed',
    }
  }

  let outputPath = candidate.desiredOutputPath
  let counter = 2
  let collision = false
  const preparedPath = path.join(
    path.dirname(candidate.desiredOutputPath),
    `.${path.basename(candidate.desiredOutputPath)}.siftory-batch-${crypto.randomUUID()}.part`,
  )

  try {
    await fs.promises.copyFile(candidate.modifiedPath, preparedPath, fs.constants.COPYFILE_EXCL)
    if (
      !batchRenameSourceFingerprintMatches(
        candidate.sourceFingerprint,
        captureBatchRenameSourceFingerprint(candidate.modifiedPath),
      )
    ) {
      return {
        ok: false,
        outputPath: candidate.desiredOutputPath,
        collision: false,
        reason: 'source-changed',
      }
    }

    for (let attempts = 0; attempts < 10_000; attempts += 1) {
      if (isAlreadyOccupied(outputPath, claimedOutputPaths)) {
        collision = true
        if (policy !== 'keep-both') {
          return { ok: false, outputPath, collision, reason: 'existing-output' }
        }
        outputPath = suffixedOutputPath(candidate.desiredOutputPath, counter)
        counter += 1
        continue
      }

      try {
        await linkPreparedPath(preparedPath, outputPath)
        claimedOutputPaths.add(outputPathKey(outputPath))
        return { ok: true, outputPath, collision, publishMode: 'atomic-link' }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          collision = true
          if (policy !== 'keep-both') {
            return { ok: false, outputPath, collision, reason: 'existing-output' }
          }
          outputPath = suffixedOutputPath(candidate.desiredOutputPath, counter)
          counter += 1
          continue
        }
        if (!isFilesystemCapabilityError(error)) throw error

        try {
          await fs.promises.copyFile(preparedPath, outputPath, fs.constants.COPYFILE_EXCL)
          claimedOutputPaths.add(outputPathKey(outputPath))
          return { ok: true, outputPath, collision, publishMode: 'exclusive-copy' }
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== 'EEXIST') throw fallbackError
          collision = true
          if (policy !== 'keep-both') {
            return { ok: false, outputPath, collision, reason: 'existing-output' }
          }
          outputPath = suffixedOutputPath(candidate.desiredOutputPath, counter)
          counter += 1
        }
      }
    }

    throw new Error('Unable to allocate a non-conflicting output filename')
  } finally {
    await fs.promises.rm(preparedPath, { force: true }).catch(() => {})
  }
}
