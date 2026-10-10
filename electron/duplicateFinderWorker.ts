import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parentPort, workerData } from 'worker_threads'
import type { DupGroup, DupScanProgress, LargestFile } from '../shared/ipc-contract'

type FileCandidate = LargestFile
type WorkerRequest =
  | { kind: 'duplicates'; dirPath: string; minSize: number }
  | { kind: 'largest'; dirPath: string; topN: number }
type WorkerInput = { request: WorkerRequest; stopBuffer: SharedArrayBuffer }

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '__pycache__',
  '.git',
  '.vs',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'cache',
  'caches',
  'code cache',
  'gpucache',
  'shadercache',
  'thumbcache',
  'crashpad',
  'temp',
  'tmp',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
])

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('.') || SKIPPED_DIRECTORIES.has(lower)
}

function stopped(stopView: Int32Array): boolean {
  return Atomics.load(stopView, 0) === 1
}

function collectFiles(
  dirPath: string,
  minSize: number,
  stopView: Int32Array,
  emit: (progress: DupScanProgress) => void,
): { files: FileCandidate[]; totalBytes: number } {
  const files: FileCandidate[] = []
  const dirs = [dirPath]
  let totalBytes = 0
  let lastUpdate = 0

  while (dirs.length > 0 && !stopped(stopView)) {
    const dir = dirs.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (stopped(stopView)) break
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) dirs.push(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(entryPath)
        if (stat.size < minSize) continue
        files.push({ path: entryPath, name: entry.name, size: stat.size, mtime: stat.mtimeMs })
        totalBytes += stat.size
      } catch {
        continue
      }
      const now = Date.now()
      if (now - lastUpdate >= 100) {
        lastUpdate = now
        emit({
          state: 'scanning',
          scanned: files.length,
          totalBytes,
          duplicates: 0,
          currentPath: entryPath,
        })
      }
    }
  }
  return { files, totalBytes }
}

function computeSHA256(filePath: string, stopView: Int32Array): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const hash = crypto.createHash('sha256')
    let bytesRead = 0
    while (
      !stopped(stopView) &&
      (bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0
    ) {
      hash.update(buffer.subarray(0, bytesRead))
    }
    return stopped(stopView) ? null : hash.digest('hex')
  } catch {
    return null
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

export function runDuplicateTask(
  dirPath: string,
  minSize: number,
  stopView: Int32Array,
  emit: (progress: DupScanProgress) => void,
): { stopped: boolean; groups: DupGroup[]; progress?: DupScanProgress } {
  const startedAt = Date.now()
  const { files, totalBytes } = collectFiles(dirPath, minSize, stopView, emit)
  if (stopped(stopView)) return { stopped: true, groups: [] }

  const sizeMap = new Map<number, FileCandidate[]>()
  for (const file of files) {
    const matches = sizeMap.get(file.size)
    if (matches) matches.push(file)
    else sizeMap.set(file.size, [file])
  }
  const candidates = [...sizeMap.values()].filter((items) => items.length > 1).flat()
  const hashMap = new Map<string, FileCandidate[]>()
  let lastUpdate = 0
  for (let index = 0; index < candidates.length && !stopped(stopView); index++) {
    const file = candidates[index]
    const hash = computeSHA256(file.path, stopView)
    if (hash) {
      const matches = hashMap.get(hash)
      if (matches) matches.push(file)
      else hashMap.set(hash, [file])
    }
    const now = Date.now()
    if (now - lastUpdate >= 100 || index + 1 === candidates.length) {
      lastUpdate = now
      emit({
        state: 'hashing',
        scanned: index + 1,
        totalBytes,
        duplicates: 0,
        candidates: candidates.length,
        currentPath: file.path,
      })
    }
  }
  if (stopped(stopView)) return { stopped: true, groups: [] }

  const groups = [...hashMap.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([hash, matches]) => ({ hash: hash.slice(0, 16), size: matches[0].size, files: matches }))
    .sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1))
  const finalProgress: DupScanProgress = {
    state: 'done',
    scanned: files.length,
    totalBytes,
    duplicates: groups.length,
    durationMs: Date.now() - startedAt,
  }
  return { stopped: false, groups, progress: finalProgress }
}

export function runLargestTask(
  dirPath: string,
  topN: number,
  stopView: Int32Array,
  emit: (progress: DupScanProgress) => void,
): { stopped: boolean; files: LargestFile[]; progress?: DupScanProgress } {
  const startedAt = Date.now()
  const result = collectFiles(dirPath, 0, stopView, emit)
  if (stopped(stopView)) return { stopped: true, files: [] }
  result.files.sort((a, b) => b.size - a.size)
  const finalProgress: DupScanProgress = {
    state: 'done',
    scanned: result.files.length,
    totalBytes: result.totalBytes,
    duplicates: 0,
    durationMs: Date.now() - startedAt,
  }
  return { stopped: false, files: result.files.slice(0, topN), progress: finalProgress }
}

if (parentPort && workerData) {
  const port = parentPort
  const input = workerData as WorkerInput
  const stopView = new Int32Array(input.stopBuffer)
  const emit = (progress: DupScanProgress) => port.postMessage({ type: 'progress', progress })
  try {
    if (input.request.kind === 'duplicates') {
      const result = runDuplicateTask(input.request.dirPath, input.request.minSize, stopView, emit)
      port.postMessage(
        result.stopped
          ? { type: 'stopped' }
          : { type: 'duplicates-result', groups: result.groups, progress: result.progress },
      )
    } else {
      const result = runLargestTask(input.request.dirPath, input.request.topN, stopView, emit)
      port.postMessage(
        result.stopped
          ? { type: 'stopped' }
          : { type: 'largest-result', files: result.files, progress: result.progress },
      )
    }
  } catch (error) {
    port.postMessage({ type: 'error', error: String(error) })
  }
}
