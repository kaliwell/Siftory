import type {
  AssetCategory,
  AssetClusterGroup,
  AssetClusterLineageEvent,
  AssetClusterMember,
  AssetLibraryClusterSummary,
  AssetRecord,
} from '../shared/ipc/asset-library'
import { setAssetsArchived, upsertCategoryAssignments } from './assetLibraryAssignmentService'
import { assetCategoryRecordFields, insertAssetCategoryRecord } from './assetLibraryTaxonomyCatalog'
import { clusterStats, ensureLineageKey } from './assetClusterUtilities'
import { runJsonLinesTransaction } from './jsonLinesTransaction'
import {
  getAssetLibraryBaseDir,
  getAssetLibraryShadowDatabase,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
} from './assetLibraryStorageContext'

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export async function listAssetClusterSummaries(): Promise<AssetLibraryClusterSummary[]> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  const dbSummaries = withShadowRead(
    (db) => {
      const inactiveAssetIds = stores.assets.inactiveIds()
      const summaries = new Map(
        db
          .clusterMemberAggregates(inactiveAssetIds)
          .map((summary) => [summary.clusterGroupId, summary]),
      )
      return db
        .listClusterGroups()
        .filter((group) => group.status !== 'ignored' && summaries.has(group.id))
        .map((group) => {
          const summary = summaries.get(group.id)!
          const representativeAsset = stores.assets.getById(group.representativeAssetId)
          const previewAssets: Array<{ asset: AssetRecord; similarity: number }> = []
          for (const member of db.iterateClusterMembersBySimilarity(group.id)) {
            const asset = stores.assets.getById(member.assetId)
            if (!isActiveAsset(asset)) continue
            previewAssets.push({ asset, similarity: member.similarity })
            if (previewAssets.length >= 8) break
          }
          return {
            group: {
              ...group,
              assetCount: summary.count,
              avgSimilarity: summary.similarityTotal / summary.count,
            },
            ...(isActiveAsset(representativeAsset) ? { representativeAsset } : {}),
            previewAssets,
          }
        })
        .sort((a, b) => {
          const categoryDelta =
            Number(b.group.algorithm === 'category_feedback') -
            Number(a.group.algorithm === 'category_feedback')
          const semanticDelta =
            Number(b.group.algorithm === 'semantic_zero_shot') -
            Number(a.group.algorithm === 'semantic_zero_shot')
          return categoryDelta || semanticDelta || b.group.assetCount - a.group.assetCount
        })
    },
    () => null,
  )
  if (dbSummaries) return dbSummaries
  const members = stores.clusterMembers.getAll()
  const membersByCluster = new Map<
    number,
    {
      count: number
      similarityTotal: number
      preview: Array<{ asset: AssetRecord; similarity: number }>
    }
  >()
  for (const member of members) {
    const asset = stores.assets.getById(member.assetId)
    if (!isActiveAsset(asset)) continue
    const summary = membersByCluster.get(member.clusterGroupId) || {
      count: 0,
      similarityTotal: 0,
      preview: [],
    }
    summary.count += 1
    summary.similarityTotal += member.similarity
    if (summary.preview.length < 8) summary.preview.push({ asset, similarity: member.similarity })
    membersByCluster.set(member.clusterGroupId, summary)
  }
  return stores.clusters
    .getAll()
    .filter((group) => group.status !== 'ignored' && membersByCluster.has(group.id))
    .map((group) => {
      const summary = membersByCluster.get(group.id)!
      const representativeAsset = stores.assets.getById(group.representativeAssetId)
      return {
        group: {
          ...group,
          assetCount: summary.count,
          avgSimilarity: summary.similarityTotal / summary.count,
        },
        ...(isActiveAsset(representativeAsset) ? { representativeAsset } : {}),
        previewAssets: summary.preview,
      }
    })
    .sort((a, b) => {
      const categoryDelta =
        Number(b.group.algorithm === 'category_feedback') -
        Number(a.group.algorithm === 'category_feedback')
      const semanticDelta =
        Number(b.group.algorithm === 'semantic_zero_shot') -
        Number(a.group.algorithm === 'semantic_zero_shot')
      return categoryDelta || semanticDelta || b.group.assetCount - a.group.assetCount
    })
}

/**
 * Duplicate disposition (集成方案阶段 B): archive every member of a
 * duplicate group except the representative copy (soft archive, fully
 * restorable via the existing Removed view), then mark the group
 * confirmed. Reject/Ignore reuse the plain updateCluster status path.
 */
export async function applyDuplicateClusterGroup(
  clusterId: number,
  markFeedbackDirty: (reason: string) => Promise<void>,
): Promise<{ ok: boolean; archived?: number; error?: string }> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  const cluster = stores.clusters.getById(clusterId)
  if (!cluster) return { ok: false, error: 'Cluster not found' }
  if (cluster.algorithm !== 'duplicate_exact' && cluster.algorithm !== 'duplicate_near') {
    return { ok: false, error: 'Not a duplicate group' }
  }
  if (cluster.status === 'confirmed') return { ok: false, error: 'Duplicate group already applied' }
  const targets = stores.clusterMembers
    .find((member) => member.clusterGroupId === clusterId)
    .map((member) => member.assetId)
    .filter((assetId) => assetId !== cluster.representativeAssetId)
    .filter((assetId) => isActiveAsset(stores.assets.getById(assetId)))
  if (targets.length === 0) return { ok: false, error: 'No active duplicate copies to archive' }
  const archived = await setAssetsArchived(targets, true, markFeedbackDirty)
  if (!archived.ok) return { ok: false, error: archived.error || 'Archive failed' }
  await updateAssetClusterGroup(clusterId, { status: 'confirmed' })
  return { ok: true, archived: archived.affected }
}

// ── Cluster lineage & manual operations (路线图 23 阶段 A) ──

function recordClusterLineage(event: Omit<AssetClusterLineageEvent, 'id'>): void {
  const stores = requireAssetLibraryStores()
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.insertClusterLineage(event))
    return
  }
  stores.clusterLineage.insert(event)
  void stores.clusterLineage.flush()
}

export function listAssetClusterLineage(options?: {
  groupId?: number
  limit?: number
}): AssetClusterLineageEvent[] {
  const stores = requireAssetLibraryStores()
  const limit = Math.max(1, Math.min(5000, Math.floor(options?.limit ?? 200)))
  let events: AssetClusterLineageEvent[]
  const db = sqliteWriteDb() ?? getAssetLibraryShadowDatabase()
  if (db) {
    events =
      withShadowRead(
        (shadow) => shadow.listClusterLineage(500) as AssetClusterLineageEvent[],
        () => null,
      ) ?? stores.clusterLineage.getAll()
  } else {
    events = stores.clusterLineage.getAll()
  }
  const filtered = options?.groupId
    ? events.filter(
        (e) => e.groupIds.includes(options.groupId!) || e.fromGroupIds.includes(options.groupId!),
      )
    : events
  return filtered.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, limit)
}

/**
 * Merge several clusters into one (成员并集，每素材保留最高 similarity，
 * 代表图取最大组成员代表，状态不降级，origin='manual_merge')。
 */
export async function mergeAssetClusterGroups(
  groupIds: number[],
): Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }> {
  const stores = requireAssetLibraryStores()
  const ids = [...new Set(groupIds)]
  if (ids.length < 2) return { ok: false, error: 'Select at least two groups to merge' }
  const groups = ids.map((id) => stores.clusters.getById(id))
  if (groups.some((g) => !g)) return { ok: false, error: 'One or more groups no longer exist' }
  const sources = groups as AssetClusterGroup[]

  const now = Date.now()
  const membersByAsset = new Map<number, number>()
  for (const source of sources) {
    for (const member of stores.clusterMembers.find((m) => m.clusterGroupId === source.id)) {
      const prev = membersByAsset.get(member.assetId)
      if (prev === undefined || member.similarity > prev) {
        membersByAsset.set(member.assetId, member.similarity)
      }
    }
  }
  const members = [...membersByAsset.entries()].map(([assetId, similarity]) => ({
    assetId,
    similarity,
  }))
  if (members.length === 0) return { ok: false, error: 'Selected groups have no members' }

  const largest = [...sources].sort((a, b) => b.assetCount - a.assetCount)[0]
  const status = sources.some((g) => g.status === 'confirmed')
    ? 'confirmed'
    : sources.every((g) => g.status === 'ignored')
      ? 'ignored'
      : 'suggested'
  const merged: Omit<AssetClusterGroup, 'id'> = {
    name: largest.name,
    algorithm: largest.algorithm,
    status,
    ...clusterStats(members),
    representativeAssetId: largest.representativeAssetId,
    ...(largest.sourceCategoryId ? { sourceCategoryId: largest.sourceCategoryId } : {}),
    ...(largest.labels ? { labels: largest.labels } : {}),
    origin: 'manual_merge',
    lineageKey: ensureLineageKey(largest),
    createdAt: now,
    updatedAt: now,
  }

  let createdGroup: AssetClusterGroup | undefined
  if (sqliteWriteDb()) {
    const created = withSqliteWrite((db) => {
      db.deleteClusterGroupsByIds(ids)
      const group: AssetClusterGroup = { id: db.allocateId('cluster_groups'), ...merged }
      db.insertClusterGroups([group])
      db.insertClusterMembers(
        members.map((m) => ({
          id: db.allocateId('cluster_members'),
          clusterGroupId: group.id,
          assetId: m.assetId,
          similarity: m.similarity,
          createdAt: now,
        })),
      )
      return group
    })
    createdGroup = created
    stores.clusters.replaceAll([
      ...stores.clusters.getAll().filter((g) => !ids.includes(g.id)),
      created,
    ])
    stores.clusterMembers.replaceAll([
      ...stores.clusterMembers.getAll().filter((m) => !ids.includes(m.clusterGroupId)),
      ...members.map((m) => ({
        id: 0,
        clusterGroupId: created.id,
        assetId: m.assetId,
        similarity: m.similarity,
        createdAt: now,
      })),
    ])
    withSqliteWrite((db) =>
      db.insertClusterLineage({
        event: 'merge',
        groupIds: [created.id],
        fromGroupIds: ids,
        memberAssetIds: members.map((m) => m.assetId),
        createdAt: now,
      }),
    )
  } else {
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [stores.clusters, stores.clusterMembers],
      () => {
        const storedGroups = stores.clusters.replaceAll([
          ...stores.clusters.getAll().filter((g) => !ids.includes(g.id)),
          merged,
        ])
        createdGroup = storedGroups[storedGroups.length - 1]
        stores.clusterMembers.replaceAll([
          ...stores.clusterMembers.getAll().filter((m) => !ids.includes(m.clusterGroupId)),
          ...members.map((m) => ({
            clusterGroupId: createdGroup!.id,
            assetId: m.assetId,
            similarity: m.similarity,
            createdAt: now,
          })),
        ])
      },
    )
    recordClusterLineage({
      event: 'merge',
      groupIds: [createdGroup!.id],
      fromGroupIds: ids,
      memberAssetIds: members.map((m) => m.assetId),
      createdAt: now,
    })
  }
  return { ok: true, group: createdGroup }
}

/**
 * Split selected members out of a cluster into a new group
 * (origin='manual_split')，原组移除这些成员并重算统计。
 */
export async function splitAssetClusterGroup(
  groupId: number,
  assetIds: number[],
): Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }> {
  const stores = requireAssetLibraryStores()
  const source = stores.clusters.getById(groupId)
  if (!source) return { ok: false, error: 'Cluster not found' }
  const wanted = new Set(assetIds)
  if (wanted.size === 0) return { ok: false, error: 'No members selected' }
  const sourceMembers = stores.clusterMembers.find((m) => m.clusterGroupId === groupId)
  const moving = sourceMembers.filter((m) => wanted.has(m.assetId))
  if (moving.length === 0) return { ok: false, error: 'Selected assets are not in this group' }
  const remaining = sourceMembers.filter((m) => !wanted.has(m.assetId))

  const now = Date.now()
  const splitGroup: Omit<AssetClusterGroup, 'id'> = {
    name: `${source.name} split`,
    algorithm: source.algorithm,
    status: source.status,
    ...clusterStats(moving),
    representativeAssetId: moving[0].assetId,
    ...(source.labels ? { labels: source.labels } : {}),
    origin: 'manual_split',
    lineageKey: `${ensureLineageKey(source)}-s${now.toString(36)}`,
    createdAt: now,
    updatedAt: now,
  }

  let createdGroup: AssetClusterGroup | undefined
  if (sqliteWriteDb()) {
    createdGroup = withSqliteWrite((db) => {
      const group: AssetClusterGroup = { id: db.allocateId('cluster_groups'), ...splitGroup }
      db.insertClusterGroups([group])
      for (const m of moving) {
        db.deleteClusterMember(groupId, m.assetId)
        db.insertClusterMembers([
          {
            id: db.allocateId('cluster_members'),
            clusterGroupId: group.id,
            assetId: m.assetId,
            similarity: m.similarity,
            createdAt: now,
          },
        ])
      }
      const stats = clusterStats(remaining)
      db.updateClusterGroup(groupId, {
        assetCount: stats.assetCount,
        avgSimilarity: stats.avgSimilarity,
        origin: 'manual_edit',
        lineageKey: ensureLineageKey(source),
        updatedAt: now,
      })
      db.insertClusterLineage({
        event: 'split',
        groupIds: [group.id],
        fromGroupIds: [groupId],
        memberAssetIds: moving.map((m) => m.assetId),
        createdAt: now,
      })
      return group
    })
    applyToMemorySplitMirror(groupId, source, createdGroup, moving, remaining, now)
  } else {
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [stores.clusters, stores.clusterMembers],
      () => {
        const storedGroups = stores.clusters.replaceAll([
          ...stores.clusters.getAll().map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  ...clusterStats(remaining),
                  origin: 'manual_edit' as const,
                  lineageKey: ensureLineageKey(g),
                  updatedAt: now,
                }
              : g,
          ),
          splitGroup,
        ])
        createdGroup = storedGroups[storedGroups.length - 1]
        stores.clusterMembers.replaceAll([
          ...stores.clusterMembers.getAll().filter((m) => m.clusterGroupId !== groupId),
          ...remaining,
          ...moving.map((m) => ({ ...m, clusterGroupId: createdGroup!.id })),
        ])
      },
    )
    recordClusterLineage({
      event: 'split',
      groupIds: [createdGroup!.id],
      fromGroupIds: [groupId],
      memberAssetIds: moving.map((m) => m.assetId),
      createdAt: now,
    })
  }
  return { ok: true, group: createdGroup }
}

function applyToMemorySplitMirror(
  groupId: number,
  source: AssetClusterGroup,
  created: AssetClusterGroup,
  moving: AssetClusterMember[],
  remaining: AssetClusterMember[],
  now: number,
): void {
  const stores = requireAssetLibraryStores()
  stores.clusters.replaceAll([
    ...stores.clusters.getAll().map((g) =>
      g.id === groupId
        ? {
            ...g,
            ...clusterStats(remaining),
            origin: 'manual_edit' as const,
            lineageKey: ensureLineageKey(g),
            updatedAt: now,
          }
        : g,
    ),
    created,
  ])
  stores.clusterMembers.replaceAll([
    ...stores.clusterMembers.getAll().filter((m) => m.clusterGroupId !== groupId),
    ...remaining,
    ...moving.map((m) => ({ ...m, clusterGroupId: created.id })),
  ])
}

/**
 * Move members between clusters, or out of clustering entirely
 * (toGroupId = null → 回到未分组)。origin 不降级，记录 lineage 事件。
 */
export async function moveAssetClusterGroupMembers(
  fromGroupId: number,
  toGroupId: number | null,
  assetIds: number[],
): Promise<{ ok: boolean; error?: string }> {
  const stores = requireAssetLibraryStores()
  const source = stores.clusters.getById(fromGroupId)
  if (!source) return { ok: false, error: 'Source cluster not found' }
  const target = toGroupId !== null ? stores.clusters.getById(toGroupId) : null
  if (toGroupId !== null && !target) return { ok: false, error: 'Target cluster not found' }
  if (toGroupId === fromGroupId) return { ok: false, error: 'Source and target are the same group' }
  const wanted = new Set(assetIds)
  if (wanted.size === 0) return { ok: false, error: 'No members selected' }
  const sourceMembers = stores.clusterMembers.find((m) => m.clusterGroupId === fromGroupId)
  const moving = sourceMembers.filter((m) => wanted.has(m.assetId))
  if (moving.length === 0)
    return { ok: false, error: 'Selected assets are not in the source group' }
  const remaining = sourceMembers.filter((m) => !wanted.has(m.assetId))
  const targetMembers = target
    ? stores.clusterMembers.find((m) => m.clusterGroupId === target.id)
    : []
  const movingIds = new Set(moving.map((m) => m.assetId))
  const mergedTarget = [...targetMembers.filter((m) => !movingIds.has(m.assetId)), ...moving]

  const now = Date.now()
  const sourceStats = clusterStats(remaining)
  const targetStats = target ? clusterStats(mergedTarget) : null

  const updateMirrors = (): void => {
    stores.clusters.replaceAll(
      stores.clusters.getAll().map((g) => {
        if (g.id === fromGroupId) {
          return {
            ...g,
            ...sourceStats,
            origin: 'manual_edit' as const,
            lineageKey: ensureLineageKey(g),
            updatedAt: now,
          }
        }
        if (target && g.id === target.id) {
          return {
            ...g,
            ...targetStats!,
            origin: g.origin && g.origin !== 'auto' ? g.origin : ('manual_edit' as const),
            lineageKey: ensureLineageKey(g),
            updatedAt: now,
          }
        }
        return g
      }),
    )
    stores.clusterMembers.replaceAll([
      ...stores.clusterMembers
        .getAll()
        .filter(
          (m) => m.clusterGroupId !== fromGroupId && (!target || m.clusterGroupId !== target.id),
        ),
      ...remaining,
      ...(target ? mergedTarget.map((m) => ({ ...m, clusterGroupId: target.id })) : []),
    ])
  }

  if (sqliteWriteDb()) {
    withSqliteWrite((db) => {
      for (const m of moving) {
        db.deleteClusterMember(fromGroupId, m.assetId)
        if (target) {
          db.insertClusterMembers([
            {
              id: db.allocateId('cluster_members'),
              clusterGroupId: target.id,
              assetId: m.assetId,
              similarity: m.similarity,
              createdAt: now,
            },
          ])
        }
      }
      db.updateClusterGroup(fromGroupId, {
        assetCount: sourceStats.assetCount,
        avgSimilarity: sourceStats.avgSimilarity,
        origin: 'manual_edit',
        lineageKey: ensureLineageKey(source),
        updatedAt: now,
      })
      if (target) {
        db.updateClusterGroup(target.id, {
          assetCount: targetStats!.assetCount,
          avgSimilarity: targetStats!.avgSimilarity,
          origin: target.origin && target.origin !== 'auto' ? target.origin : 'manual_edit',
          lineageKey: ensureLineageKey(target),
          updatedAt: now,
        })
      }
      db.insertClusterLineage({
        event: 'move',
        groupIds: target ? [target.id] : [],
        fromGroupIds: [fromGroupId],
        ...(target ? { toGroupId: target.id } : {}),
        memberAssetIds: moving.map((m) => m.assetId),
        createdAt: now,
      })
    })
    updateMirrors()
  } else {
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [stores.clusters, stores.clusterMembers],
      () => {
        updateMirrors()
      },
    )
    recordClusterLineage({
      event: 'move',
      groupIds: target ? [target.id] : [],
      fromGroupIds: [fromGroupId],
      ...(target ? { toGroupId: target.id } : {}),
      memberAssetIds: moving.map((m) => m.assetId),
      createdAt: now,
    })
  }
  return { ok: true }
}

export async function updateAssetClusterGroup(
  id: number,
  patch: { name?: string; status?: AssetClusterGroup['status'] },
): Promise<AssetClusterGroup> {
  const stores = requireAssetLibraryStores()
  const existing = stores.clusters.getById(id)
  if (!existing) throw new Error('Cluster not found')
  const update = {
    ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    updatedAt: Date.now(),
  }
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.updateClusterGroup(id, update))
    stores.clusters.update(id, update)
    return stores.clusters.getById(id)!
  }
  stores.clusters.update(id, update)
  await stores.clusters.flush()
  return stores.clusters.getById(id)!
}

export async function promoteAssetClusterGroup(
  clusterId: number,
  categoryId: number | undefined,
  markFeedbackDirty: (reason: string) => Promise<void>,
): Promise<{ ok: boolean; category?: AssetCategory; error?: string }> {
  const stores = requireAssetLibraryStores()
  const cluster = stores.clusters.getById(clusterId)
  if (!cluster) return { ok: false, error: 'Cluster not found' }
  const members = stores.clusterMembers
    .find((member) => member.clusterGroupId === clusterId)
    .filter((member) => isActiveAsset(stores.assets.getById(member.assetId)))
  if (members.length === 0) return { ok: false, error: 'Cluster has no active assets' }
  let category = categoryId ? stores.categories.getById(categoryId) : undefined
  if (categoryId && !category) return { ok: false, error: 'Category not found' }
  if (!category)
    category = stores.categories.find(
      (item) => item.name.toLowerCase() === cluster.name.toLowerCase(),
    )[0]
  const confidence = new Map(members.map((member) => [member.assetId, member.similarity]))
  if (sqliteWriteDb()) {
    const shouldLinkCluster =
      cluster.algorithm !== 'category_feedback' && category?.sourceClusterGroupId !== cluster.id
    const assetIds = members.map((member) => member.assetId)
    const promoted = withSqliteWrite((db) => {
      let targetCategory = category
      if (!targetCategory) {
        targetCategory = {
          id: db.allocateId('categories'),
          ...assetCategoryRecordFields({ name: cluster.name, color: '#7aa7ff' }),
        }
        db.insertCategory(targetCategory)
      }
      if (shouldLinkCluster) {
        db.updateCategory(targetCategory.id, {
          sourceClusterGroupId: cluster.id,
          updatedAt: Date.now(),
        })
      }
      const subset = upsertCategoryAssignments(
        db.listCategoryAssignments({ categoryId: targetCategory.id, assetIds }),
        assetIds,
        targetCategory.id,
        'cluster',
        confidence,
      )
      const finalRows = subset.map((item) =>
        item.id > 0 ? item : { ...item, id: db.allocateId('asset_categories') },
      )
      db.upsertCategoryAssignments(finalRows)
      db.updateClusterGroup(clusterId, { status: 'confirmed', updatedAt: Date.now() })
      return { targetCategory, finalRows }
    })
    category = promoted.targetCategory
    if (!stores.categories.getById(category.id)) {
      stores.categories.insert(category)
    }
    if (shouldLinkCluster) {
      stores.categories.update(category.id, {
        sourceClusterGroupId: cluster.id,
        updatedAt: Date.now(),
      })
      category = stores.categories.getById(category.id)!
    }
    const assetIdSet = new Set(assetIds)
    stores.categoryAssignments.deleteWhere(
      (item) => item.categoryId === category!.id && assetIdSet.has(item.assetId),
    )
    stores.categoryAssignments.insertMany(promoted.finalRows)
    stores.clusters.update(clusterId, { status: 'confirmed', updatedAt: Date.now() })
    await markFeedbackDirty('Cluster promoted to a confirmed category')
    return { ok: true, category: category! }
  }
  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.categories, stores.categoryAssignments, stores.clusters],
    () => {
      const targetCategory =
        category ||
        insertAssetCategoryRecord(stores.categories, { name: cluster.name, color: '#7aa7ff' })
      if (
        cluster.algorithm !== 'category_feedback' &&
        targetCategory.sourceClusterGroupId !== cluster.id
      ) {
        stores.categories.update(targetCategory.id, {
          sourceClusterGroupId: cluster.id,
          updatedAt: Date.now(),
        })
      }
      category = targetCategory
      const records = upsertCategoryAssignments(
        stores.categoryAssignments.getAll(),
        members.map((member) => member.assetId),
        targetCategory.id,
        'cluster',
        confidence,
      )
      stores.categoryAssignments.replaceAll(
        records.map((item) => (item.id > 0 ? item : { ...item, id: undefined })),
      )
      stores.clusters.update(clusterId, { status: 'confirmed', updatedAt: Date.now() })
    },
  )
  await markFeedbackDirty('Cluster promoted to a confirmed category')
  return { ok: true, category: category! }
}
