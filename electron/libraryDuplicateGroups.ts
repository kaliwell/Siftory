/**
 * 库级完全重复分组（路线图 24 阶段 A 的纯逻辑部分）。
 *
 * 与 electron/duplicateFinderWorker.ts 的关系：两者使用同一套分组语义——
 * 按文件大小预分组（唯一大小直接排除）→ 同大小组内计算 SHA-256 全文哈希 →
 * 按哈希归并出成员数 >= 2 的重复组。duplicateFinderWorker 的实现与 worker 线程
 * 设施深度耦合（SharedArrayBuffer/Atomics 停止标志、同步 readSync 逐块读取、
 * 100ms 进度节流、目录递归收集），无法直接 import 复用于"权威路径清单 + 异步
 * 并发"的场景，因此这里实现同语义的精简版：输入改为调用方给出的路径清单
 * （AssetMetadataStore 的权威清单，不做目录递归），stat/哈希改为异步流式 +
 * 定宽 worker 池，取消改为 isCancelled 回调。若未来 worker 侧逻辑演化出可复用
 * 的纯函数，应优先合并回单一实现，避免两套逻辑漂移。
 *
 * 本模块只依赖 node: 内置模块，不 import electron，可在主进程、worker 线程或
 * 纯 Node 测试（tests/guard-utils.cjs 的 loadTsModule）中运行。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

export interface LibraryDuplicateGroup {
  /** 组内文件内容的 SHA-256（完整 64 位十六进制，不做截断）。 */
  hash: string
  /** 单个文件的字节数（组内所有文件大小相同）。 */
  sizeBytes: number
  /** 组内路径，按字符串升序排序，保证输出确定性。 */
  paths: string[]
}

export interface LibraryDuplicateScanResult {
  /** 完全重复组，按 (sizeBytes desc, hash asc) 排序。 */
  groups: LibraryDuplicateGroup[]
  /** 成功 stat 为常规文件且大小 >= minSizeBytes 的路径数（进入大小预分组的数量）。 */
  scannedFiles: number
  /** 被跳过的路径数：不存在、不可读、不是常规文件（如目录）、或大小低于 minSizeBytes。 */
  skippedMissing: number
  /** 实际完成内容哈希的文件数（大小预分组后候选数，扣除哈希阶段失败/取消未完成的）。 */
  hashedFiles: number
  /** 冗余字节数 = sum((paths.length - 1) * sizeBytes per group)。 */
  totalBytes: number
  /** isCancelled 触发时为 true，此时返回的是已扫部分的快照。 */
  cancelled: boolean
}

export interface LibraryDuplicateScanOptions {
  /** 参与检测的最小文件大小，默认 1（0 字节文件不参与）。 */
  minSizeBytes?: number
  /** stat / 哈希阶段的并发上限，默认 16。 */
  concurrency?: number
  /** 取消回调：返回 true 后尽快停止，已扫部分照常汇总返回。 */
  isCancelled?: () => boolean
  /**
   * 进度回调：stat 阶段为 (已 stat 数, 去重后路径总数)，
   * 哈希阶段为 (已哈希数, 哈希候选总数)。每个文件调用一次，不做节流，
   * 需要节流的调用方（如 IPC 进度事件）自行处理。
   */
  onProgress?: (done: number, total: number) => void
}

const DEFAULT_MIN_SIZE_BYTES = 1
const DEFAULT_CONCURRENCY = 16

interface SizedFile {
  path: string
  sizeBytes: number
}

/**
 * 流式计算文件 SHA-256。文件在哈希期间消失/不可读时返回 null（由调用方计入
 * skippedMissing），不抛错。流式读取保证大文件（数百 MB 素材）内存有界。
 */
function hashFileSha256(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => {
      stream.destroy()
      finish(null)
    })
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
    })
    stream.on('end', () => {
      finish(hash.digest('hex'))
    })
  })
}

/**
 * 定宽 worker 池：对 items 并发执行 worker，结果按完成顺序收集。
 * shouldStop 返回 true 时不再领取新任务（进行中的任务正常跑完）。
 */
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const lane = async () => {
    while (nextIndex < items.length && !shouldStop()) {
      const index = nextIndex
      nextIndex += 1
      const result = await worker(items[index])
      if (result !== undefined) results.push(result)
    }
  }
  const laneCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: laneCount }, () => lane()))
  return results
}

/**
 * 在权威路径清单上构建完全重复组。输入不做目录递归；每条路径恰好落入
 * scannedFiles 或 skippedMissing 之一。重复输入路径先按字符串去重。
 */
export async function findExactDuplicateGroups(
  paths: readonly string[],
  options: LibraryDuplicateScanOptions = {},
): Promise<LibraryDuplicateScanResult> {
  const minSizeBytes = options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const isCancelled = options.isCancelled ?? (() => false)
  const onProgress = options.onProgress

  const uniquePaths = [...new Set(paths)]
  let skippedMissing = 0

  // 阶段 1：并发 stat，得到 (路径, 大小) 清单。
  let statDone = 0
  const sizedFiles = await runPool(uniquePaths, concurrency, isCancelled, async (filePath) => {
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      skippedMissing += 1
      statDone += 1
      onProgress?.(statDone, uniquePaths.length)
      return undefined
    }
    statDone += 1
    onProgress?.(statDone, uniquePaths.length)
    if (!stat.isFile() || stat.size < minSizeBytes) {
      skippedMissing += 1
      return undefined
    }
    const sized: SizedFile = { path: filePath, sizeBytes: stat.size }
    return sized
  })
  const scannedFiles = sizedFiles.length

  // 阶段 2：按大小预分组，唯一大小的文件直接排除，不进入哈希阶段。
  const bySize = new Map<number, SizedFile[]>()
  for (const file of sizedFiles) {
    const bucket = bySize.get(file.sizeBytes)
    if (bucket) bucket.push(file)
    else bySize.set(file.sizeBytes, [file])
  }
  const candidates = [...bySize.values()].filter((bucket) => bucket.length >= 2).flat()

  // 阶段 3：候选文件并发流式哈希。
  let hashDone = 0
  const hashed = await runPool(candidates, concurrency, isCancelled, async (file) => {
    const hash = await hashFileSha256(file.path)
    hashDone += 1
    onProgress?.(hashDone, candidates.length)
    if (hash === null) {
      skippedMissing += 1
      return undefined
    }
    return { file, hash }
  })
  const hashedFiles = hashed.length

  // 阶段 4：按哈希归并，成员数 >= 2 的成为重复组。
  const byHash = new Map<string, SizedFile[]>()
  for (const { file, hash } of hashed) {
    const bucket = byHash.get(hash)
    if (bucket) bucket.push(file)
    else byHash.set(hash, [file])
  }
  const groups: LibraryDuplicateGroup[] = [...byHash.entries()]
    .filter(([, bucket]) => bucket.length >= 2)
    .map(([hash, bucket]) => ({
      hash,
      sizeBytes: bucket[0].sizeBytes,
      paths: bucket.map((file) => file.path).sort(),
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

  const totalBytes = groups.reduce(
    (sum, group) => sum + (group.paths.length - 1) * group.sizeBytes,
    0,
  )

  return {
    groups,
    scannedFiles,
    skippedMissing,
    hashedFiles,
    totalBytes,
    cancelled: isCancelled(),
  }
}
