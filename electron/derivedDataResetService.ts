import fs from 'fs'
import path from 'path'
import { clearAnnPrewarmHistory } from './annPrewarmService'
import { clearImageIndex } from './imageSearchService'
import { invalidateClipEmbeddingCacheMemory } from './semanticSearchService'
import { disposeSemanticVectorSearchWorker } from './semanticVectorSearchWorkerHost'
import { disposeVectorAnnWorker } from './vectorAnnWorkerHost'
import type {
  ProcessedImageDataCategory,
  ProcessedImageDataPreview,
  ProcessedImageDataResetResult,
} from '../shared/ipc-contract'

export type {
  ProcessedImageDataCategory,
  ProcessedImageDataPreview,
  ProcessedImageDataResetResult,
} from '../shared/ipc-contract'

interface ProcessedDataFile {
  path: string
  sizeBytes: number
}

interface CategoryTarget {
  id: ProcessedImageDataCategory['id']
  label: string
  directories: string[]
  rootFilePattern?: RegExp
}

const CATEGORY_TARGETS: CategoryTarget[] = [
  {
    id: 'image-search-index',
    label: 'Image Search index',
    directories: ['image-search-index'],
  },
  {
    id: 'thumbnails',
    label: 'Derived thumbnails',
    directories: ['thumbcache'],
  },
  {
    id: 'scan-logs',
    label: 'Scan logs',
    directories: [],
    rootFilePattern: /^image-search-scan\.log(\.\d+)?$/,
  },
  {
    id: 'vector-db',
    label: 'Vector database',
    directories: ['vector-db'],
  },
]

const MAX_ERRORS = 20

function runBestEffort(action: () => unknown): void {
  try {
    action()
  } catch {
    // Cleanup continues and reports any files that remain locked below.
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function collectFiles(root: string): Promise<ProcessedDataFile[]> {
  const results: ProcessedDataFile[] = []
  const queue = [root]
  while (queue.length > 0) {
    const batch = queue.splice(0, 64)
    const entries = await Promise.all(
      batch.map(async (target) => {
        try {
          return { target, stat: await fs.promises.lstat(target) }
        } catch {
          return undefined
        }
      }),
    )
    const directories: string[] = []
    for (const entry of entries) {
      if (!entry || entry.stat.isSymbolicLink()) continue
      if (entry.stat.isFile()) {
        results.push({ path: entry.target, sizeBytes: entry.stat.size })
      } else if (entry.stat.isDirectory()) {
        directories.push(entry.target)
      }
    }
    const children = await Promise.all(
      directories.map(async (directory) => {
        try {
          return (await fs.promises.readdir(directory)).map((name) => path.join(directory, name))
        } catch {
          return []
        }
      }),
    )
    for (const group of children) {
      for (const child of group) queue.push(child)
    }
  }
  return results
}

async function directFiles(
  directory: string,
  predicate: (name: string) => boolean,
): Promise<ProcessedDataFile[]> {
  try {
    const names = (await fs.promises.readdir(directory)).filter(predicate)
    const targets = await Promise.all(
      names.map(async (name): Promise<ProcessedDataFile | undefined> => {
        const target = path.join(directory, name)
        try {
          const stat = await fs.promises.lstat(target)
          return stat.isFile() && !stat.isSymbolicLink()
            ? { path: target, sizeBytes: stat.size }
            : undefined
        } catch {
          return undefined
        }
      }),
    )
    return targets.filter((target): target is ProcessedDataFile => Boolean(target))
  } catch {
    return []
  }
}

async function collectCategoryFiles(
  userDataPath: string,
  target: CategoryTarget,
): Promise<ProcessedDataFile[]> {
  const files: ProcessedDataFile[] = []
  for (const directory of target.directories) {
    // Do not spread a large cache into Array#push. Real thumbnail/vector
    // stores can contain hundreds of thousands of entries, and forwarding
    // that many arguments overflows V8's call stack before cleanup starts.
    for (const file of await collectFiles(path.join(userDataPath, directory))) files.push(file)
  }
  if (target.rootFilePattern) {
    for (const file of await directFiles(userDataPath, (name) =>
      target.rootFilePattern!.test(name),
    )) {
      files.push(file)
    }
  }
  return files
}

export async function previewProcessedImageData(
  userDataPath: string,
): Promise<ProcessedImageDataPreview> {
  const categories: ProcessedImageDataCategory[] = []
  for (const target of CATEGORY_TARGETS) {
    const files = await collectCategoryFiles(userDataPath, target)
    const estimatedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
    if (estimatedBytes === 0) continue
    categories.push({
      id: target.id,
      label: target.label,
      estimatedBytes,
      fileCount: files.length,
    })
  }
  return {
    categories,
    estimatedBytes: categories.reduce((sum, category) => sum + category.estimatedBytes, 0),
    fileCount: categories.reduce((sum, category) => sum + category.fileCount, 0),
  }
}

async function deleteFile(
  userDataPath: string,
  file: ProcessedDataFile,
  errors: string[],
): Promise<{ deleted: boolean; freedBytes: number }> {
  const skipped = { deleted: false, freedBytes: 0 }
  if (!isContained(userDataPath, file.path)) return skipped
  try {
    const realTarget = await fs.promises.realpath(file.path)
    const realRoot = await fs.promises.realpath(userDataPath)
    if (!isContained(realRoot, realTarget)) return skipped
    const stat = await fs.promises.lstat(file.path)
    if (!stat.isFile() || stat.isSymbolicLink()) return skipped
    await fs.promises.unlink(file.path)
    return { deleted: true, freedBytes: stat.size }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && errors.length < MAX_ERRORS) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    return skipped
  }
}

async function removeEmptyRoot(
  userDataPath: string,
  directory: string,
  errors: string[],
): Promise<void> {
  const target = path.join(userDataPath, directory)
  if (!isContained(userDataPath, target)) return
  try {
    const realTarget = await fs.promises.realpath(target)
    const realRoot = await fs.promises.realpath(userDataPath)
    if (!isContained(realRoot, realTarget)) return
    const stat = await fs.promises.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await fs.promises.rm(target, { recursive: true, force: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && errors.length < MAX_ERRORS) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
}

export async function clearProcessedImageData(
  userDataPath: string,
): Promise<ProcessedImageDataResetResult> {
  const errors: string[] = []
  let freedBytes = 0
  let deletedFiles = 0
  // Release native file locks before deleting: the ANN worker may hold vector
  // snapshots, and the FastScanner index keeps segment files memory-mapped
  // (Windows EBUSY on unlink). clearImageIndex unmaps the segments; each hook
  // is isolated so a missing/idle dependency never fails the reset.
  runBestEffort(disposeVectorAnnWorker)
  runBestEffort(clearAnnPrewarmHistory)
  runBestEffort(disposeSemanticVectorSearchWorker)
  // Best-effort at the native boundary: a refusal is harmless here — any
  // file that stays locked surfaces as its own unlink error below.
  runBestEffort(clearImageIndex)
  for (const target of CATEGORY_TARGETS) {
    const files = await collectCategoryFiles(userDataPath, target)
    for (const file of files) {
      const outcome = await deleteFile(userDataPath, file, errors)
      if (outcome.deleted) {
        freedBytes += outcome.freedBytes
        deletedFiles += 1
      }
    }
    for (const directory of target.directories) {
      await removeEmptyRoot(userDataPath, directory, errors)
    }
  }
  runBestEffort(disposeVectorAnnWorker)
  runBestEffort(disposeSemanticVectorSearchWorker)
  runBestEffort(invalidateClipEmbeddingCacheMemory)
  return {
    ok: errors.length === 0,
    freedBytes,
    deletedFiles,
    error: errors[0],
    errors,
  }
}
