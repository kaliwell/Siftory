export function pruneTopKCandidates<T>(
  candidates: T[],
  topK: number,
  getScore: (candidate: T) => number,
): void {
  const limit = Math.max(1000, topK * 4)
  if (candidates.length < limit) return
  candidates.sort((a, b) => getScore(b) - getScore(a))
  candidates.length = topK
}
