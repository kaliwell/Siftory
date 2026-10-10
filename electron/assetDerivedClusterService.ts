import type {
  AssetClusterGroup,
  AssetClusterMember,
  AssetLibraryClusterRequest,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetRecord,
} from '../shared/ipc/asset-library'
import { findExactDuplicateGroups } from './libraryDuplicateGroups'
import { findNearDuplicateGroups } from './libraryNearDuplicates'
import { scanClipPersonSemanticGroups } from './semanticSearchService'
import { generateClusterSemanticLabels } from './assetClusterBuildService'
import { normalizeClusterScopePaths, pathMatchesClusterScope } from './assetClusterUtilities'
import { runJsonLinesTransaction } from './jsonLinesTransaction'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
} from './assetLibraryStorageContext'
import type { AssetLibraryRunningTask } from './assetLibraryTaskController'

export interface AssetDerivedClusterHost {
  startTask(
    type: 'duplicate_scan' | 'clustering',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

interface DuplicateGroupInput {
  name: string
  assetIds: number[]
  avgSimilarity: number
  memberSimilarity: number
  labels: string[]
}

/**
 * Atomically replace all cluster groups of one duplicate algorithm with
 * the newly built set (other algorithms' groups are preserved).
 * Shared by exact (SHA-256) and near (dHash) duplicate builds.
 */
async function persistDuplicateGroups(
  algorithm: 'duplicate_exact' | 'duplicate_near',
  inputs: DuplicateGroupInput[],
): Promise<{ groups: AssetClusterGroup[]; memberCount: number }> {
  const stores = requireAssetLibraryStores()
  const now = Date.now()
  const preservedGroups = stores.clusters.getAll().filter((group) => group.algorithm !== algorithm)
  const preservedGroupIds = new Set(preservedGroups.map((group) => group.id))
  const preservedMembers = stores.clusterMembers
    .getAll()
    .filter((member) => preservedGroupIds.has(member.clusterGroupId))

  let newGroups: AssetClusterGroup[] = []
  const newMembers: Array<Omit<AssetClusterMember, 'id'>> = []
  if (sqliteWriteDb()) {
    const created = withSqliteWrite((db) => {
      db.deleteClusterGroupsByAlgorithm(algorithm)
      const groups: AssetClusterGroup[] = inputs.map((g) => ({
        id: db.allocateId('cluster_groups'),
        name: g.name,
        algorithm,
        status: 'suggested' as const,
        assetCount: g.assetIds.length,
        avgSimilarity: g.avgSimilarity,
        // representative = earliest-ingested copy (smallest asset id)
        representativeAssetId: Math.min(...g.assetIds),
        labels: g.labels,
        createdAt: now,
        updatedAt: now,
      }))
      db.insertClusterGroups(groups)
      const members: AssetClusterMember[] = []
      groups.forEach((group, index) => {
        for (const assetId of inputs[index].assetIds) {
          members.push({
            id: db.allocateId('cluster_members'),
            clusterGroupId: group.id,
            assetId,
            similarity: inputs[index].memberSimilarity,
            createdAt: now,
          })
        }
      })
      db.insertClusterMembers(members)
      return { groups, members }
    })
    newGroups = created.groups
    newMembers.push(...created.members)
    stores.clusters.replaceAll([...preservedGroups, ...created.groups])
    stores.clusterMembers.replaceAll([...preservedMembers, ...created.members])
  } else {
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [stores.clusters, stores.clusterMembers],
      () => {
        const storedGroups = stores.clusters.replaceAll([
          ...preservedGroups,
          ...inputs.map((g) => ({
            name: g.name,
            algorithm,
            status: 'suggested' as const,
            assetCount: g.assetIds.length,
            avgSimilarity: g.avgSimilarity,
            representativeAssetId: Math.min(...g.assetIds),
            labels: g.labels,
            createdAt: now,
            updatedAt: now,
          })),
        ])
        newGroups = storedGroups.slice(preservedGroups.length)
        newGroups.forEach((group, index) => {
          for (const assetId of inputs[index].assetIds) {
            newMembers.push({
              clusterGroupId: group.id,
              assetId,
              similarity: inputs[index].memberSimilarity,
              createdAt: now,
            })
          }
        })
        stores.clusterMembers.replaceAll([...preservedMembers, ...newMembers])
      },
    )
  }
  return { groups: newGroups, memberCount: newMembers.length }
}

export function buildLibraryDuplicateGroupsTask(
  host: AssetDerivedClusterHost,
): AssetLibraryTaskResult {
  return host.startTask('duplicate_scan', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const entries = stores.assets.activePathIndexEntries()
    const scan = await findExactDuplicateGroups(
      entries.map((e) => e.path),
      {
        isCancelled: () => task.cancelled,
        onProgress: (done, total) => {
          host.publishProgress({
            current: done,
            total,
            percent: total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0,
            message: `Hashing files ${done.toLocaleString()}/${total.toLocaleString()}...`,
          })
        },
      },
    )
    if (task.cancelled) throw new Error('Asset library task cancelled')

    const idByPath = new Map(entries.map((e) => [e.path, e.id]))
    const mapped = scan.groups
      .map((g) => ({
        name: `Duplicate ${g.hash.slice(0, 8)}`,
        assetIds: g.paths
          .map((p) => idByPath.get(p))
          .filter((id): id is number => typeof id === 'number'),
        sizeBytes: g.sizeBytes,
      }))
      .filter((g) => g.assetIds.length >= 2)

    const persisted = await persistDuplicateGroups(
      'duplicate_exact',
      mapped.map((g) => ({
        name: `${g.name} (${g.assetIds.length})`,
        assetIds: g.assetIds,
        avgSimilarity: 1,
        memberSimilarity: 1,
        labels: ['duplicate', 'exact'],
      })),
    )

    const redundantMiB = (scan.totalBytes / (1024 * 1024)).toFixed(1)
    return `Found ${persisted.groups.length} exact duplicate groups covering ${persisted.memberCount.toLocaleString()} assets (${redundantMiB} MiB redundant); hashed ${scan.hashedFiles.toLocaleString()} of ${scan.scannedFiles.toLocaleString()} files, skipped ${scan.skippedMissing.toLocaleString()}.`
  })
}

export function buildLibraryNearDuplicateGroupsTask(
  request: { threshold?: number } | undefined,
  host: AssetDerivedClusterHost,
): AssetLibraryTaskResult {
  return host.startTask('duplicate_scan', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const threshold = Math.max(1, Math.min(16, Math.floor(request?.threshold ?? 8)))

    // Perceptual hashes were written by the Image Search scan — no re-decode
    const inputs: Array<{ id: number; diffHash64: string }> = []
    for (const entry of stores.assets.activePathIndexEntries()) {
      const record = stores.assets.getById(entry.id)
      const hash = record?.diffHash64
      if (typeof hash === 'string' && /^[0-9a-fA-F]{16}$/.test(hash)) {
        inputs.push({ id: entry.id, diffHash64: hash.toLowerCase() })
      }
    }
    if (inputs.length === 0) {
      throw new Error('No perceptual hashes available; run an Image Search scan first')
    }

    const { groups, cancelled } = findNearDuplicateGroups(inputs, {
      threshold,
      isCancelled: () => task.cancelled,
      onProgress: (done, total) => {
        host.publishProgress({
          current: done,
          total,
          percent: total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0,
          message: `Comparing hashes ${done.toLocaleString()}/${total.toLocaleString()}...`,
        })
      },
    })
    if (task.cancelled || cancelled) throw new Error('Asset library task cancelled')

    const persisted = await persistDuplicateGroups(
      'duplicate_near',
      groups.map((g, index) => ({
        name: `Near duplicate ${index + 1} (${g.memberIds.length})`,
        assetIds: g.memberIds,
        avgSimilarity: 1 - g.maxDistance / 64,
        memberSimilarity: 1 - g.maxDistance / 64,
        labels: ['duplicate', 'near', `d≤${g.maxDistance}`],
      })),
    )
    return `Found ${persisted.groups.length} near-duplicate groups covering ${persisted.memberCount.toLocaleString()} assets (threshold ${threshold}, ${inputs.length.toLocaleString()} hashed assets).`
  })
}

export function refreshAssetClusterLabelsTask(
  host: AssetDerivedClusterHost,
): AssetLibraryTaskResult {
  return host.startTask('clustering', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const groups = stores.clusters
      .getAll()
      .filter(
        (group) =>
          group.status !== 'ignored' &&
          group.algorithm !== 'semantic_zero_shot' &&
          group.algorithm !== 'category_feedback',
      )
    if (groups.length === 0) return 'No cluster groups to relabel.'
    const membersByCluster = new Map<number, Array<{ assetId: number; similarity: number }>>()
    const memberRows = withShadowRead(
      (db) => db.listClusterMembersOrdered(),
      () => stores.clusterMembers.getAll(),
    )
    for (const member of memberRows) {
      if (!isActiveAsset(stores.assets.getById(member.assetId))) continue
      const members = membersByCluster.get(member.clusterGroupId) || []
      members.push({ assetId: member.assetId, similarity: member.similarity })
      membersByCluster.set(member.clusterGroupId, members)
    }
    const labelInputs = groups.map((group) => ({
      members: (membersByCluster.get(group.id) || [])
        .sort((left, right) => right.similarity - left.similarity)
        .map((member) => ({ assetId: member.assetId })),
    }))
    const labelsByIndex = await generateClusterSemanticLabels(
      labelInputs,
      {
        isCancelled: () => task.cancelled,
        percent: 75,
      },
      host,
    )
    const now = Date.now()
    let labeled = 0
    const updatedGroups = stores.clusters.getAll().map((group) => {
      const activeIndex = groups.findIndex((candidate) => candidate.id === group.id)
      if (activeIndex < 0) return group
      const labels = labelsByIndex.get(activeIndex) || []
      if (labels.length > 0) labeled += 1
      const suffix = group.name.match(/\s(\d+)$/)?.[1] || String(group.id)
      const oldLabels = group.labels || []
      const generatedName =
        group.name === `AI Group ${suffix}` ||
        oldLabels.some((label) => group.name === `${label} ${suffix}`)
      return {
        ...group,
        ...(generatedName && labels.length > 0 ? { name: `${labels[0]} ${suffix}` } : {}),
        labels,
        updatedAt: now,
      }
    })
    if (sqliteWriteDb()) {
      withSqliteWrite((db) => {
        for (const group of updatedGroups) {
          const activeIndex = groups.findIndex((candidate) => candidate.id === group.id)
          if (activeIndex < 0) continue
          db.updateClusterGroup(group.id, {
            name: group.name,
            labels: group.labels ?? null,
            updatedAt: now,
          })
        }
      })
      stores.clusters.replaceAll(updatedGroups)
      return `Refreshed semantic labels for ${labeled}/${groups.length} cluster groups without rebuilding members.`
    }
    await runJsonLinesTransaction(getAssetLibraryBaseDir(), [stores.clusters], () => {
      stores.clusters.replaceAll(updatedGroups)
    })
    return `Refreshed semantic labels for ${labeled}/${groups.length} cluster groups without rebuilding members.`
  })
}

export function buildSemanticPeopleClustersTask(
  request: AssetLibraryClusterRequest = {},
  host: AssetDerivedClusterHost,
): AssetLibraryTaskResult {
  return host.startTask('clustering', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const scopePaths = normalizeClusterScopePaths(request.scopePaths)
    const minClusterSize = Math.max(1, Math.min(10_000, Math.floor(request.minClusterSize ?? 2)))
    const seenAssetIds = new Set<number>()
    const buckets = new Map<
      string,
      {
        label: string
        members: Array<{ assetId: number; similarity: number }>
        similarityTotal: number
        representativeAssetId: number
        representativeScore: number
      }
    >()

    const scan = await scanClipPersonSemanticGroups({
      isCancelled: () => task.cancelled,
      isEligiblePath: (filePath) => {
        if (!pathMatchesClusterScope(filePath, scopePaths)) return false
        return isActiveAsset(stores.assets.getByPath(filePath))
      },
      onProgress: (current, total, matched, message) => {
        host.publishProgress({
          current,
          total,
          percent: total > 0 ? Math.min(98, Math.round((current / total) * 98)) : 0,
          message: `${message}; ${matched.toLocaleString()} people candidates`,
        })
      },
      onMatch: (filePath, match) => {
        const asset = stores.assets.getByPath(filePath)
        if (!isActiveAsset(asset) || seenAssetIds.has(asset.id)) return
        seenAssetIds.add(asset.id)
        let bucket = buckets.get(match.key)
        if (!bucket) {
          bucket = {
            label: match.label,
            members: [],
            similarityTotal: 0,
            representativeAssetId: asset.id,
            representativeScore: -1,
          }
          buckets.set(match.key, bucket)
        }
        bucket.members.push({ assetId: asset.id, similarity: match.confidence })
        bucket.similarityTotal += match.confidence
        const representativeScore = match.margin * 2 + match.subtypeScore
        if (representativeScore > bucket.representativeScore) {
          bucket.representativeScore = representativeScore
          bucket.representativeAssetId = asset.id
        }
      },
    })

    const semanticBuckets = [...buckets.entries()]
      .filter(([, bucket]) => bucket.members.length >= minClusterSize)
      .map(([key, bucket]) => ({ key, ...bucket }))
      .sort((left, right) => right.members.length - left.members.length)
    if (semanticBuckets.length === 0) {
      throw new Error(
        `No reliable real-person groups found in ${scan.eligible.toLocaleString()} eligible CLIP images`,
      )
    }
    for (const bucket of semanticBuckets) {
      bucket.members.sort((left, right) => right.similarity - left.similarity)
    }

    const existingVisualGroups = stores.clusters
      .getAll()
      .filter((group) => group.algorithm !== 'semantic_zero_shot')
    const visualGroupIds = new Set(existingVisualGroups.map((group) => group.id))
    const existingVisualMembers = stores.clusterMembers
      .getAll()
      .filter((member) => visualGroupIds.has(member.clusterGroupId))
    const now = Date.now()
    let createdGroups: AssetClusterGroup[] = []
    if (sqliteWriteDb()) {
      const created = withSqliteWrite((db) => {
        db.deleteClusterGroupsByAlgorithm('semantic_zero_shot')
        const newGroups: AssetClusterGroup[] = semanticBuckets.map((bucket) => ({
          id: db.allocateId('cluster_groups'),
          name: bucket.label,
          algorithm: 'semantic_zero_shot' as const,
          status: 'suggested' as const,
          assetCount: bucket.members.length,
          avgSimilarity: bucket.similarityTotal / bucket.members.length,
          representativeAssetId: bucket.representativeAssetId,
          labels: ['real people', bucket.label, 'CLIP semantic'],
          createdAt: now,
          updatedAt: now,
        }))
        db.insertClusterGroups(newGroups)
        const newMembers: AssetClusterMember[] = []
        for (let index = 0; index < newGroups.length; index++) {
          for (const member of semanticBuckets[index].members) {
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
        return { newGroups, newMembers }
      })
      createdGroups = created.newGroups
      stores.clusters.replaceAll([...existingVisualGroups, ...created.newGroups])
      stores.clusterMembers.replaceAll([...existingVisualMembers, ...created.newMembers])
    } else {
      await runJsonLinesTransaction(
        getAssetLibraryBaseDir(),
        [stores.clusters, stores.clusterMembers],
        () => {
          const storedGroups = stores.clusters.replaceAll([
            ...existingVisualGroups,
            ...semanticBuckets.map((bucket) => ({
              name: bucket.label,
              algorithm: 'semantic_zero_shot' as const,
              status: 'suggested' as const,
              assetCount: bucket.members.length,
              avgSimilarity: bucket.similarityTotal / bucket.members.length,
              representativeAssetId: bucket.representativeAssetId,
              labels: ['real people', bucket.label, 'CLIP semantic'],
              createdAt: now,
              updatedAt: now,
            })),
          ])
          createdGroups = storedGroups.slice(existingVisualGroups.length)
          const semanticMembers: Array<Omit<AssetClusterMember, 'id'>> = []
          for (let index = 0; index < createdGroups.length; index++) {
            for (const member of semanticBuckets[index].members) {
              semanticMembers.push({
                clusterGroupId: createdGroups[index].id,
                assetId: member.assetId,
                similarity: member.similarity,
                createdAt: now,
              })
            }
          }
          stores.clusterMembers.replaceAll([...existingVisualMembers, ...semanticMembers])
        },
      )
    }
    const retained = semanticBuckets.reduce((total, bucket) => total + bucket.members.length, 0)
    const scopeLabel = scopePaths.length > 0 ? `${scopePaths.length} selected roots` : 'all data'
    return `Created ${createdGroups.length} dedicated people groups with ${retained.toLocaleString()} images from ${scan.eligible.toLocaleString()} eligible CLIP records over ${scopeLabel}.`
  })
}
