import path from 'path'
import type {
  AssetClusterGroup,
  AssetClusterLineageEvent,
  AssetClusterMember,
  AssetLibraryCategoryClusterRequest,
  AssetLibraryClusterRequest,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetRecord,
} from '../shared/ipc/asset-library'
import { getQueryTextEmbeddings } from './semanticSearchService'
import { loadClipEmbeddingsForPaths } from './clipEmbeddingCacheReader'
import { CLUSTER_LABEL_CANDIDATES, rankClusterLabels } from './clusterLabeling'
import { getVisionModelCapability } from './modelRegistry'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import { runAssetTaskWorker } from './assetTaskWorkerHost'
import type {
  AssetClusteringWorkerInput,
  AssetClusteringWorkerProgress,
  AssetClusteringWorkerResult,
} from './assetClusteringWorker'
import {
  categoryReviewStates,
  runCategoryFeedbackSearchWorker,
} from './assetCategorySampleSearchService'
import {
  getAssetFeedbackModelStatus,
  getAssetFeedbackTargetContext,
  rebuildAssetFeedbackModel,
} from './assetFeedbackModelService'
import { normalizeClusterScopePaths, pathMatchesClusterScope } from './assetClusterUtilities'
import { computeClusterInheritance } from './assetClusterInheritance'
import { runJsonLinesTransaction } from './jsonLinesTransaction'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withSqliteWrite,
} from './assetLibraryStorageContext'
import type { AssetLibraryRunningTask } from './assetLibraryTaskController'

const DINO_MODEL = 'dinov2_vitb14'
const DINO_DIM = getVisionModelCapability(DINO_MODEL).dim

export interface AssetClusterBuildHost {
  startTask(
    type: 'clustering',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

function recordClusterLineage(event: Omit<AssetClusterLineageEvent, 'id'>): void {
  const stores = requireAssetLibraryStores()
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.insertClusterLineage(event))
    return
  }
  stores.clusterLineage.insert(event)
  void stores.clusterLineage.flush()
}

export async function generateClusterSemanticLabels(
  clusters: ReadonlyArray<{ members: ReadonlyArray<{ assetId: number }> }>,
  options: { isCancelled: () => boolean; percent?: number },
  host: AssetClusterBuildHost,
): Promise<Map<number, string[]>> {
  const stores = requireAssetLibraryStores()
  const labelsByCluster = new Map<number, string[]>()
  if (clusters.length === 0) return labelsByCluster
  const percent = options.percent ?? 98
  host.publishProgress({
    current: 0,
    total: clusters.length,
    percent,
    message: `Generating semantic labels for ${clusters.length} groups...`,
  })
  const samplePathsByCluster = clusters.map((cluster) =>
    cluster.members
      .slice(0, 8)
      .map((member) => stores.assets.getById(member.assetId)?.path)
      .filter((filePath): filePath is string => !!filePath),
  )
  const clipImageVectors = await loadClipEmbeddingsForPaths(
    path.join(path.dirname(getAssetLibraryBaseDir()), 'vector-db'),
    samplePathsByCluster.flat(),
  )
  const textEmbeddingValues = await getQueryTextEmbeddings(
    CLUSTER_LABEL_CANDIDATES.map((candidate) => candidate.prompt),
  )
  const textVectors = new Map(
    [...textEmbeddingValues].map(([prompt, values]) => [prompt, Float32Array.from(values)]),
  )
  for (let index = 0; index < clusters.length; index++) {
    if (options.isCancelled()) throw new Error('Asset library task cancelled')
    const vectors = samplePathsByCluster[index]
      .map((filePath) => clipImageVectors.get(path.resolve(filePath).toLowerCase()))
      .filter((vector): vector is Float32Array => !!vector)
    const labels = rankClusterLabels(vectors, textVectors, 5)
    if (labels.length > 0) labelsByCluster.set(index, labels)
    if (index % 16 === 0 || index + 1 === clusters.length) {
      host.publishProgress({
        current: index + 1,
        total: clusters.length,
        percent:
          percent + Math.round(((index + 1) / Math.max(1, clusters.length)) * (99 - percent)),
        message: `Generating semantic labels: ${index + 1}/${clusters.length} groups...`,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return labelsByCluster
}

export function buildCategoryAssetClusterTask(
  request: AssetLibraryCategoryClusterRequest,
  host: AssetClusterBuildHost,
): AssetLibraryTaskResult {
  const category = requireAssetLibraryStores().categories.getById(request.categoryId)
  if (!category) return { ok: false, error: 'Category not found' }

  return host.startTask('clustering', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const topK = Math.max(10, Math.min(5000, Math.floor(request.topK ?? 500)))
    const minScore = Math.max(0, Math.min(1, request.minScore ?? 0.55))
    const includeReviewed = request.includeReviewed === true
    const scopePaths = normalizeClusterScopePaths(request.scopePaths)

    const feedbackStatus = await getAssetFeedbackModelStatus()
    if (
      feedbackStatus.state !== 'ready' ||
      feedbackStatus.builtRevision !== feedbackStatus.revision
    ) {
      host.publishProgress({
        current: 0,
        total: 100,
        percent: 0,
        message: `Updating reviewed samples for ${category.name}...`,
      })
      await rebuildAssetFeedbackModel({
        isCancelled: () => task.cancelled,
        onProgress: (progress) => {
          const percent = Math.round(progress.percent * 0.2)
          host.publishProgress({
            current: percent,
            total: 100,
            percent,
            message: progress.message,
          })
        },
      })
    }
    if (task.cancelled) throw new Error('Category cluster search cancelled')

    const feedback = await getAssetFeedbackTargetContext('category', category.id)
    const target = feedback.targets[0]?.target
    if (!target) {
      throw new Error(
        'This category has no accepted assets with CLIP embeddings. Add references or classify samples first.',
      )
    }

    const reviewStates = categoryReviewStates(category.id)
    const clipCandidateK = Math.min(20_000, Math.max(1000, topK * 8))
    const result = await runCategoryFeedbackSearchWorker(
      {
        target,
        eligibleAssets: stores.assets
          .activePathIndexEntries()
          .filter((asset) => {
            if (!pathMatchesClusterScope(asset.path, scopePaths)) return false
            const reviewState = reviewStates.get(asset.id)
            if (reviewState === 'negative') return false
            return includeReviewed || reviewState !== 'positive'
          })
          .map(({ id, pathKey }) => ({ id, pathKey })),
        clipCandidateK,
        topK,
      },
      (progress) => {
        const percent = Math.round(
          progress.stage === 'dino' ? 65 + progress.percent * 0.3 : 20 + progress.percent * 0.45,
        )
        host.publishProgress({
          current: percent,
          total: 100,
          percent,
          message:
            progress.stage === 'clip'
              ? `Category recall for ${category.name}: ${progress.message}`
              : progress.message,
        })
      },
      { isCancelled: () => task.cancelled },
    )
    if (task.cancelled) throw new Error('Category cluster search cancelled')

    const scoreByAsset = new Map<number, number>()
    for (const hit of result.hits) {
      if (hit.score < minScore) continue
      const asset = stores.assets.getById(hit.assetId)
      if (!isActiveAsset(asset)) continue
      const previous = scoreByAsset.get(asset.id)
      if (previous === undefined || hit.score > previous) scoreByAsset.set(asset.id, hit.score)
    }
    const members = [...scoreByAsset]
      .map(([assetId, similarity]) => ({ assetId, similarity }))
      .sort((left, right) => right.similarity - left.similarity || left.assetId - right.assetId)
    if (members.length === 0) {
      throw new Error(
        `No ${category.name} matches reached ${(minScore * 100).toFixed(0)}%. Lower Min score or add more reviewed samples.`,
      )
    }

    host.publishProgress({
      current: 97,
      total: 100,
      percent: 97,
      message: `Saving ${members.length.toLocaleString()} category matches as an independent group...`,
    })
    const existingGroups = stores.clusters.getAll()
    const replacedGroupIds = new Set(
      existingGroups
        .filter(
          (group) =>
            group.algorithm === 'category_feedback' && group.sourceCategoryId === category.id,
        )
        .map((group) => group.id),
    )
    const retainedGroups = existingGroups.filter((group) => !replacedGroupIds.has(group.id))
    const retainedMembers = stores.clusterMembers
      .getAll()
      .filter((member) => !replacedGroupIds.has(member.clusterGroupId))
    const now = Date.now()
    let createdGroup: AssetClusterGroup | undefined
    if (sqliteWriteDb()) {
      const newGroupFields = {
        name: `${category.name} matches`,
        algorithm: 'category_feedback' as const,
        status: 'suggested' as const,
        assetCount: members.length,
        avgSimilarity:
          members.reduce((total, member) => total + member.similarity, 0) / members.length,
        representativeAssetId: members[0].assetId,
        sourceCategoryId: category.id,
        labels: [
          category.name,
          'Category search',
          result.mode === 'clip_dino' ? 'CLIP + DINO' : 'CLIP',
        ],
        createdAt: now,
        updatedAt: now,
      }
      const created = withSqliteWrite((db) => {
        db.deleteClusterGroupsByIds([...replacedGroupIds])
        const group: AssetClusterGroup = { id: db.allocateId('cluster_groups'), ...newGroupFields }
        db.insertClusterGroups([group])
        const memberRows = members.map((member) => ({
          id: db.allocateId('cluster_members'),
          clusterGroupId: group.id,
          assetId: member.assetId,
          similarity: member.similarity,
          createdAt: now,
        }))
        db.insertClusterMembers(memberRows)
        return { group, memberRows }
      })
      createdGroup = created.group
      stores.clusters.replaceAll([...retainedGroups, created.group])
      stores.clusterMembers.replaceAll([...retainedMembers, ...created.memberRows])
    } else {
      await runJsonLinesTransaction(
        getAssetLibraryBaseDir(),
        [stores.clusters, stores.clusterMembers],
        () => {
          const storedGroups = stores.clusters.replaceAll([
            ...retainedGroups,
            {
              name: `${category.name} matches`,
              algorithm: 'category_feedback' as const,
              status: 'suggested' as const,
              assetCount: members.length,
              avgSimilarity:
                members.reduce((total, member) => total + member.similarity, 0) / members.length,
              representativeAssetId: members[0].assetId,
              sourceCategoryId: category.id,
              labels: [
                category.name,
                'Category search',
                result.mode === 'clip_dino' ? 'CLIP + DINO' : 'CLIP',
              ],
              createdAt: now,
              updatedAt: now,
            },
          ])
          createdGroup = storedGroups[storedGroups.length - 1]
          stores.clusterMembers.replaceAll([
            ...retainedMembers,
            ...members.map((member) => ({
              clusterGroupId: createdGroup!.id,
              assetId: member.assetId,
              similarity: member.similarity,
              createdAt: now,
            })),
          ])
        },
      )
    }
    const scopeLabel = scopePaths.length > 0 ? `${scopePaths.length} selected roots` : 'all data'
    return `Created ${category.name} category group with ${members.length.toLocaleString()} matches from ${result.scanned.toLocaleString()} CLIP vectors over ${scopeLabel}; minimum score ${(minScore * 100).toFixed(0)}%, ${result.mode === 'clip_dino' ? 'CLIP + DINO' : 'CLIP fallback'}.`
  })
}

export function buildAssetClustersTask(
  request: AssetLibraryClusterRequest = {},
  host: AssetClusterBuildHost,
): AssetLibraryTaskResult {
  return host.startTask('clustering', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const requestedMaxClusters = Math.max(2, Math.min(256, Math.floor(request.maxClusters ?? 96)))
    const autoClusters = request.autoClusters !== false
    const maxAssets = Math.max(100, Math.min(500_000, Math.floor(request.maxAssets ?? 500_000)))
    const minClusterSize = Math.max(2, Math.min(10_000, Math.floor(request.minClusterSize ?? 5)))
    const minSimilarity = Math.max(0, Math.min(1, request.minSimilarity ?? 0.76))
    const semanticRefine = request.semanticRefine !== false
    const semanticSimilarity = Math.max(0.6, Math.min(0.99, request.semanticSimilarity ?? 0.86))
    const semanticMaxSplits = Math.max(1, Math.min(8, Math.floor(request.semanticMaxSplits ?? 4)))
    const scopePaths = normalizeClusterScopePaths(request.scopePaths)
    const sourcePaths = getEmbeddingStorePaths(DINO_MODEL, 'global')
    if (sourcePaths.length === 0) throw new Error('Build DINO embeddings before clustering')
    // 人工干预组（origin !== 'auto'）在重算中保留：其成员不参与自动重算
    const manualGroups = stores.clusters
      .getAll()
      .filter(
        (group) =>
          group.algorithm === 'compressed_kmeans' &&
          group.origin !== undefined &&
          group.origin !== 'auto',
      )
    const manualGroupIds = new Set(manualGroups.map((group) => group.id))
    const manualMemberIds = new Set(
      stores.clusterMembers
        .getAll()
        .filter((member) => manualGroupIds.has(member.clusterGroupId))
        .map((member) => member.assetId),
    )
    const clusterableAssets = stores.assets
      .activePathIndexEntries()
      .filter((entry) => !manualMemberIds.has(entry.id))
    const pipeline = await runAssetTaskWorker<
      AssetClusteringWorkerProgress,
      AssetClusteringWorkerResult
    >({
      workerFile: 'assetClusteringWorker.js',
      input: {
        cacheDir: path.join(path.dirname(getAssetLibraryBaseDir()), 'vector-db', 'embedding-cache'),
        modelName: DINO_MODEL,
        embeddingType: 'global',
        dim: DINO_DIM,
        sourcePaths,
        clipVectorDir: path.join(path.dirname(getAssetLibraryBaseDir()), 'vector-db'),
        scopePaths,
        maxAssets,
        minClusterSize,
        minSimilarity,
        autoClusters,
        requestedMaxClusters,
        semanticRefine,
        semanticSimilarity,
        semanticMaxSplits,
        assets: clusterableAssets,
      } satisfies AssetClusteringWorkerInput,
      onProgress: (progress) => {
        const stagePercent = (() => {
          switch (progress.stage) {
            case 'cache':
              return Math.round(progress.percent * 0.3)
            case 'routing':
              return 30 + Math.round(progress.percent * 0.22)
            case 'centers':
              return 52
            case 'clustering':
              return 52 + Math.round(progress.percent * 18)
            case 'routing-prep':
              return 70 + Math.round(progress.percent * 4)
            case 'purifying':
              return 74 + Math.round(progress.percent * (autoClusters ? 0.1 : 0.22))
            case 'residual-centers':
              return 84
            case 'residual-clustering':
              return 84 + Math.round(progress.percent * 6)
            case 'residual-prep':
              return 90 + Math.round(progress.percent * 2)
            case 'residual-purify':
              return 92 + Math.round(progress.percent * 0.04)
            case 'semantic-seeds':
              return 96
            case 'semantic-assign':
              return 97
            default:
              return undefined
          }
        })()
        host.publishProgress({
          current: progress.current,
          total: progress.total,
          ...(stagePercent !== undefined ? { percent: stagePercent } : {}),
          message: progress.message,
        })
      },
    })
    if (task.cancelled) throw new Error('Asset library task cancelled')
    const viable = pipeline.viable
    const eligibleCount = pipeline.eligibleCount
    const maxClusters = pipeline.maxClusters
    const residualCenterCount = pipeline.residualCenterCount
    const semanticEmbeddedCount = pipeline.semanticEmbeddedCount
    const semanticSplitCount = pipeline.semanticSplitCount
    const now = Date.now()
    let labelsByCluster = new Map<number, string[]>()
    try {
      labelsByCluster = await generateClusterSemanticLabels(
        viable,
        {
          isCancelled: () => task.cancelled,
          percent: 98,
        },
        host,
      )
    } catch {
      // Semantic labels are optional; DINO clustering remains usable without CLIP.
    }
    // 保留：非 compressed_kmeans 组 + 人工干预组
    const preservedSpecialGroups = stores.clusters
      .getAll()
      .filter(
        (group) =>
          group.algorithm !== 'compressed_kmeans' ||
          (group.origin !== undefined && group.origin !== 'auto'),
      )
    const preservedSpecialGroupIds = new Set(preservedSpecialGroups.map((group) => group.id))
    const preservedSpecialMembers = stores.clusterMembers
      .getAll()
      .filter((member) => preservedSpecialGroupIds.has(member.clusterGroupId))

    // 阶段 B：旧自动组按成员 Jaccard ≥ 0.5 继承 lineage_key / 状态 / 人工命名
    const oldAutoGroups = stores.clusters
      .getAll()
      .filter(
        (group) =>
          group.algorithm === 'compressed_kmeans' &&
          (group.origin === undefined || group.origin === 'auto'),
      )
    const oldMemberSets = new Map<number, Set<number>>()
    for (const group of oldAutoGroups) {
      oldMemberSets.set(
        group.id,
        new Set(
          stores.clusterMembers
            .getAll()
            .filter((member) => member.clusterGroupId === group.id)
            .map((member) => member.assetId),
        ),
      )
    }
    const inheritance = computeClusterInheritance(
      oldAutoGroups,
      oldMemberSets,
      viable.map((cluster) => cluster.members.map((member) => member.assetId)),
    )

    const buildNewGroup = (
      cluster: (typeof viable)[number],
      index: number,
      id?: number,
    ): Omit<AssetClusterGroup, 'id'> & { id?: number } => {
      const inherit = inheritance.get(index)
      const generatedName = labelsByCluster.has(index)
        ? `${labelsByCluster.get(index)![0]} ${index + 1}`
        : `AI Group ${index + 1}`
      return {
        ...(id !== undefined ? { id } : {}),
        name: inherit?.name ?? generatedName,
        algorithm: 'compressed_kmeans' as const,
        status: inherit?.status ?? ('suggested' as const),
        assetCount: cluster.members.length,
        avgSimilarity: cluster.avgSimilarity,
        representativeAssetId: cluster.representativeAssetId,
        ...(labelsByCluster.has(index) ? { labels: labelsByCluster.get(index) } : {}),
        ...(inherit ? { lineageKey: inherit.lineageKey } : {}),
        createdAt: now,
        updatedAt: now,
      }
    }

    let groups: AssetClusterGroup[] = []
    const members: Array<Omit<AssetClusterMember, 'id'>> = []
    if (sqliteWriteDb()) {
      const created = withSqliteWrite((db) => {
        // 只删除旧自动组，人工干预组保留
        db.deleteClusterGroupsByIds(oldAutoGroups.map((group) => group.id))
        const newGroups: AssetClusterGroup[] = viable.map(
          (cluster, index) =>
            buildNewGroup(cluster, index, db.allocateId('cluster_groups')) as AssetClusterGroup,
        )
        db.insertClusterGroups(newGroups)
        const newMembers: AssetClusterMember[] = []
        for (let index = 0; index < newGroups.length; index++) {
          for (const member of viable[index].members) {
            newMembers.push({
              id: db.allocateId('cluster_members'),
              clusterGroupId: newGroups[index].id,
              assetId: member.assetId,
              similarity: member.similarity,
              createdAt: now,
            })
          }
        }
        db.insertClusterMembers(newMembers)
        for (const [index, inherit] of inheritance) {
          db.insertClusterLineage({
            event: 'recalc_map',
            groupIds: [newGroups[index].id],
            fromGroupIds: [inherit.fromGroupId],
            createdAt: now,
          })
        }
        return { newGroups, newMembers }
      })
      groups = created.newGroups
      members.push(...created.newMembers)
      stores.clusters.replaceAll([...preservedSpecialGroups, ...created.newGroups])
      stores.clusterMembers.replaceAll([...preservedSpecialMembers, ...created.newMembers])
    } else {
      await runJsonLinesTransaction(
        getAssetLibraryBaseDir(),
        [stores.clusters, stores.clusterMembers],
        () => {
          const storedGroups = stores.clusters.replaceAll([
            ...preservedSpecialGroups,
            ...viable.map((cluster, index) => buildNewGroup(cluster, index)),
          ])
          groups = storedGroups.slice(preservedSpecialGroups.length)
          for (let index = 0; index < groups.length; index++) {
            for (const member of viable[index].members) {
              members.push({
                clusterGroupId: groups[index].id,
                assetId: member.assetId,
                similarity: member.similarity,
                createdAt: now,
              })
            }
          }
          stores.clusterMembers.replaceAll([...preservedSpecialMembers, ...members])
        },
      )
      for (const [index, inherit] of inheritance) {
        recordClusterLineage({
          event: 'recalc_map',
          groupIds: [groups[index].id],
          fromGroupIds: [inherit.fromGroupId],
          createdAt: now,
        })
      }
    }
    const ungrouped = Math.max(0, eligibleCount - members.length)
    const scopeLabel = scopePaths.length > 0 ? `${scopePaths.length} selected roots` : 'all assets'
    const semanticSummary = semanticEmbeddedCount
      ? ` CLIP semantic refinement matched ${semanticEmbeddedCount.toLocaleString()} images and added ${semanticSplitCount.toLocaleString()} subgroups at ${(semanticSimilarity * 100).toFixed(0)}% split similarity.`
      : semanticRefine
        ? ' CLIP semantic refinement found no matching cached embeddings.'
        : ' CLIP semantic refinement was disabled.'
    return `Created ${groups.length} purified groups from ${members.length.toLocaleString()} assets using ${maxClusters} ${autoClusters ? `adaptive + ${residualCenterCount} residual` : 'manual'} centers over ${scopeLabel} at ${(minSimilarity * 100).toFixed(0)}% minimum DINO similarity; ${ungrouped.toLocaleString()} left ungrouped.${semanticSummary}`
  })
}
