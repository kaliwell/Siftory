// ── Shared exact CLIP F16 scan (VAL-028) ──
// The candidate heap and the streaming exact scan used by
// semanticSearchService live here (free of electron imports) so the semantic
// vector search worker can reuse the exact same selection arithmetic and the
// parity fixtures can exercise the reference path directly. Do not change the
// scoring, tie-break, or iteration semantics without updating the worker.

import {
  embeddingCachePathKey,
  streamEmbeddingF16Cache,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'

export interface SemanticClipCandidate {
  path: string
  score: number
  reasons: string[]
  cacheRow?: number
  baseScore?: number
  feedbackBoost?: number
}

interface SemanticCandidateHeapNode {
  key: string
  candidate: SemanticClipCandidate
  index: number
}

export function clipCacheCandidate(
  pathValue: string,
  score: number,
  dot: number,
  cacheRow: number,
): SemanticClipCandidate {
  return {
    path: pathValue,
    score,
    reasons: [`CLIP embedding cache cosine ${dot.toFixed(3)}`],
    cacheRow,
  }
}

function isWorseCandidate(
  left: SemanticCandidateHeapNode,
  right: SemanticCandidateHeapNode,
): boolean {
  if (left.candidate.score !== right.candidate.score) {
    return left.candidate.score < right.candidate.score
  }
  return left.key.localeCompare(right.key) > 0
}

export class BoundedSemanticCandidateHeap {
  private readonly heap: SemanticCandidateHeapNode[] = []
  private readonly byKey = new Map<string, SemanticCandidateHeapNode>()

  constructor(private readonly limit: number) {}

  offer(key: string, pathValue: string, score: number, dot: number, cacheRow: number): void {
    const existing = this.byKey.get(key)
    if (existing) {
      if (score <= existing.candidate.score) return
      existing.candidate = clipCacheCandidate(pathValue, score, dot, cacheRow)
      this.bubbleDown(existing.index)
      return
    }

    if (this.heap.length < this.limit) {
      const candidate = clipCacheCandidate(pathValue, score, dot, cacheRow)
      const node: SemanticCandidateHeapNode = { key, candidate, index: this.heap.length }
      this.heap.push(node)
      this.byKey.set(key, node)
      this.bubbleUp(node.index)
      return
    }

    const worst = this.heap[0]
    if (
      !worst ||
      score < worst.candidate.score ||
      (score === worst.candidate.score && key.localeCompare(worst.key) >= 0)
    ) {
      return
    }
    const candidate = clipCacheCandidate(pathValue, score, dot, cacheRow)
    const node: SemanticCandidateHeapNode = { key, candidate, index: 0 }
    this.byKey.delete(worst.key)
    this.heap[0] = node
    this.byKey.set(key, node)
    this.bubbleDown(0)
  }

  values(): SemanticClipCandidate[] {
    return this.heap.map((node) => node.candidate)
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!isWorseCandidate(this.heap[index], this.heap[parent])) break
      this.swap(index, parent)
      index = parent
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex
    let moved = true
    while (moved) {
      moved = false
      const left = index * 2 + 1
      const right = left + 1
      let worst = index
      if (left < this.heap.length && isWorseCandidate(this.heap[left], this.heap[worst])) {
        worst = left
      }
      if (right < this.heap.length && isWorseCandidate(this.heap[right], this.heap[worst])) {
        worst = right
      }
      if (worst !== index) {
        this.swap(index, worst)
        index = worst
        moved = true
      }
    }
  }

  private swap(left: number, right: number): void {
    const leftNode = this.heap[left]
    const rightNode = this.heap[right]
    this.heap[left] = rightNode
    this.heap[right] = leftNode
    rightNode.index = left
    leftNode.index = right
  }
}

export interface SemanticClipScanProgress {
  scanned: number
  total: number
  percent: number
}

export interface SemanticClipScanOptions {
  /** Normalized query embedding (length = cache.meta.dim). */
  query: readonly number[]
  /** Bounded heap limit (topK, or the enlarged candidateK when feedback reranks). */
  candidateK: number
  /** Normalized scope keys (embeddingCachePathKey). Null/empty accepts every row. */
  acceptPathKeys?: ReadonlySet<string> | null
  /** Normalized feedback prototype paths; matching rows are also collected. */
  feedbackPrototypeKeys?: ReadonlySet<string>
  isCancelled?: () => boolean
  onProgress?: (progress: SemanticClipScanProgress) => void
}

export interface SemanticClipScanResult {
  scanned: number
  total: number
  /** Heap values ordered by score descending (stable among equal scores). */
  baseCandidates: SemanticClipCandidate[]
  /** baseCandidates keyed by normalized path, with prototype candidates merged in. */
  candidateByPath: Map<string, SemanticClipCandidate>
}

/**
 * Reference exact scan: streams the F16 cache row by row, scores each row
 * against the query, and keeps the bounded top-candidateK heap. This is the
 * fallback for the worker path and the parity baseline of VAL-028.
 */
export async function scanSemanticClipCache(
  cache: EmbeddingF16CacheHandle,
  options: SemanticClipScanOptions,
): Promise<SemanticClipScanResult> {
  const bestCandidates = new BoundedSemanticCandidateHeap(options.candidateK)
  const prototypeCandidates = new Map<string, SemanticClipCandidate>()
  const acceptPathKeys = options.acceptPathKeys ?? null
  const feedbackPrototypeKeys = options.feedbackPrototypeKeys
  let scanned = 0
  let total = cache.meta.count
  await streamEmbeddingF16Cache(cache, {
    isCancelled: options.isCancelled,
    onVector: (pathValue, vector, row) => {
      scanned += 1
      const candidateKey = embeddingCachePathKey(pathValue)
      if (acceptPathKeys && acceptPathKeys.size > 0 && !acceptPathKeys.has(candidateKey)) return
      let dot = 0
      for (let index = 0; index < cache.meta.dim; index++)
        dot += options.query[index] * vector[index]
      const score = Math.max(0, Math.min(1, (dot + 1) / 2))
      bestCandidates.offer(candidateKey, pathValue, score, dot, row)
      if (feedbackPrototypeKeys?.has(candidateKey)) {
        const previous = prototypeCandidates.get(candidateKey)
        if (!previous || score > previous.score) {
          prototypeCandidates.set(candidateKey, clipCacheCandidate(pathValue, score, dot, row))
        }
      }
    },
    onProgress: (progress) => {
      total = progress.total
      options.onProgress?.({
        scanned: progress.current,
        total: progress.total,
        percent: progress.percent,
      })
    },
  })

  const baseCandidates = bestCandidates.values().sort((a, b) => b.score - a.score)
  const candidateByPath = new Map(
    baseCandidates.map((candidate) => [embeddingCachePathKey(candidate.path), candidate]),
  )
  for (const [prototypePath, candidate] of prototypeCandidates) {
    candidateByPath.set(prototypePath, candidate)
  }
  return { scanned, total, baseCandidates, candidateByPath }
}
