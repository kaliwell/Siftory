/**
 * 库级近重复分组（路线图 24 阶段 C 的纯逻辑部分）。
 *
 * 输入为素材记录自带的 64 位感知哈希（dHash，16 位十六进制字符串）——
 * Image Search 扫描时已写入 assets.jsonl，无需重新解码任何图片。
 * 近重复 = 哈希汉明距离 <= 阈值的素材并查集分组。
 *
 * 全库两两比较不可行（18 万 × 18 万），采用 16 段 banding（每段 4 bit）：
 * 任意汉明距离 <= T 的对至少有 16-T 段完全一致（鸽笼：T 个差异最多
 * 落在 T 个段上），T <= 8 时必有 >= 8 段一致。因此按"段值"分桶，
 * 只在同桶内做精确汉明比较即可覆盖全部近重复对。
 * 超大桶（常见段值聚集）按确定性抽样截断，控制 O(n²) 爆炸。
 *
 * 本模块只依赖 node: 内置模块，可在主进程、worker 或纯 Node 测试运行。
 */

export interface NearDuplicateInput {
  id: number
  /** 16 位十六进制 dHash；非法/缺失的记录由调用方先行过滤。 */
  diffHash64: string
}

export interface NearDuplicateGroup {
  /** 组内素材 id，升序。 */
  memberIds: number[]
  /** 组内实际观测到的最大成对汉明距离（并查路径上可能大于阈值的间接关联取最小观测）。 */
  maxDistance: number
}

export interface NearDuplicateOptions {
  /** 汉明距离阈值（含），默认 8。 */
  threshold?: number
  /** 每桶参与两两比较的最大成员数，超出按 id 升序截断（确定性），默认 200。 */
  maxBucketSize?: number
  /** 取消回调。 */
  isCancelled?: () => boolean
  /** 进度回调（已完成条数, 总条数），每条记录每段调用一次。 */
  onProgress?: (done: number, total: number) => void
}

function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`)
}

function popcount64(n: bigint): number {
  let count = 0
  let v = n
  while (v) {
    count++
    v &= v - 1n
  }
  return count
}

export function hamming64(a: string, b: string): number {
  return popcount64(hexToBigInt(a) ^ hexToBigInt(b))
}

class UnionFind {
  private parent: number[]
  private rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.rank = new Array(size).fill(0)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[x] !== root) {
      const next = this.parent[x]
      this.parent[x] = root
      x = next
    }
    return root
  }

  union(a: number, b: number): void {
    let ra = this.find(a)
    let rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra]
    this.parent[rb] = ra
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++
  }
}

const BANDS = 16
const BAND_BITS = 4
const BAND_MASK = 0xfn

export function findNearDuplicateGroups(
  inputs: readonly NearDuplicateInput[],
  options: NearDuplicateOptions = {},
): { groups: NearDuplicateGroup[]; cancelled: boolean } {
  const threshold = Math.max(0, Math.min(32, Math.floor(options.threshold ?? 8)))
  const maxBucketSize = Math.max(8, Math.floor(options.maxBucketSize ?? 200))
  const isCancelled = options.isCancelled ?? (() => false)
  const onProgress = options.onProgress

  // 排序保证确定性；为每个条目预计算 BigInt 与段值
  const entries = inputs
    .map((input, index) => ({
      id: input.id,
      index,
      hash: hexToBigInt(input.diffHash64),
      bands: Array.from({ length: BANDS }, (_, band) =>
        Number((hexToBigInt(input.diffHash64) >> BigInt(band * BAND_BITS)) & BAND_MASK),
      ),
    }))
    .sort((a, b) => a.id - b.id)

  const uf = new UnionFind(entries.length)
  const total = entries.length * BANDS
  let done = 0

  for (let band = 0; band < BANDS; band++) {
    if (isCancelled()) return { groups: [], cancelled: true }
    const buckets = new Map<number, number[]>()
    for (let i = 0; i < entries.length; i++) {
      const value = entries[i].bands[band]
      const bucket = buckets.get(value)
      if (bucket) bucket.push(i)
      else buckets.set(value, [i])
      done++
      if (onProgress && done % 5000 === 0) onProgress(done, total)
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      // 确定性截断：按 id 升序保留前 maxBucketSize 个（entries 已按 id 排序）
      const members = bucket.length > maxBucketSize ? bucket.slice(0, maxBucketSize) : bucket
      for (let i = 0; i < members.length; i++) {
        if (isCancelled()) return { groups: [], cancelled: true }
        for (let j = i + 1; j < members.length; j++) {
          const a = entries[members[i]]
          const b = entries[members[j]]
          const distance = popcount64(a.hash ^ b.hash)
          if (distance <= threshold) {
            uf.union(a.index, b.index)
          }
        }
      }
    }
  }
  onProgress?.(total, total)

  // 汇总：根 → 成员（升序），输出按首成员 id 排序
  // 注意：uf 按原始输入下标建立，聚合必须用 entry.index 而非排序后位置
  const byRoot = new Map<number, number[]>()
  for (const entry of entries) {
    const root = uf.find(entry.index)
    const list = byRoot.get(root)
    if (list) list.push(entry.id)
    else byRoot.set(root, [entry.id])
  }
  const hashById = new Map(entries.map((e) => [e.id, e.hash]))
  const groups: NearDuplicateGroup[] = []
  for (const memberIds of byRoot.values()) {
    if (memberIds.length < 2) continue
    memberIds.sort((a, b) => a - b)
    // 组内最大成对距离（链式并查可能超过阈值）；大组按前 50 个成员截断估算
    const probe = memberIds.slice(0, 50).map((id) => hashById.get(id)!)
    let maxDistance = 0
    for (let i = 0; i < probe.length; i++) {
      for (let j = i + 1; j < probe.length; j++) {
        const d = popcount64(probe[i] ^ probe[j])
        if (d > maxDistance) maxDistance = d
      }
    }
    groups.push({ memberIds, maxDistance })
  }
  groups.sort((a, b) => a.memberIds[0] - b.memberIds[0])
  return { groups, cancelled: false }
}
