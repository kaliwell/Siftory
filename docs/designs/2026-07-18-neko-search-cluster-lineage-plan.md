# NekoSearch 聚类人工干预与稳定 Lineage 方案

> 状态：已实施（阶段 A/B/C 全部完成 2026-07-26，见[交接 §20](../current/2026-07-24-feature-implementation-handoff.md)）  
> 更新日期：2026-07-26  
> 范围：NekoSearch 聚类人工合并、拆分、成员纠错、稳定 lineage 与跨重算历史（路线图第 23 项）  
> 前置：SQLite 关系迁移阶段 3 落地后实施（组/成员写入口统一）

## 1. 目标与非目标

目标：用户能对 AI 聚类结果做人工修正（合并误拆的组、拆分误混的组、移动错误成员），且修正结果在后续全量重算中不被静默抹掉（稳定 lineage + 跨重算历史）。非目标：不做自动合并策略调整、不改聚类算法本身、不影响 Category Group 与 Semantic 人群组的既有语义。

## 2. 现状与问题

- `Recalculate clusters` 原子替换全部 `compressed_kmeans` 视觉组（保留 `category_feedback` 组），组 id 重新分配；用户对旧组的人工命名、confirmed 状态和成员修正全部丢失。
- 组目前只有 `suggested/confirmed/ignored` 状态与零样本标签命名，无人工编辑入口。
- 审计 NKS-P2-04 指出聚类缺少 lineage、人工合并/拆分、成员纠错。

## 3. 数据模型

在 `cluster_groups`（SQLite 阶段 3 后为表）增加：

- `origin: 'auto' | 'manual_merge' | 'manual_split' | 'manual_edit'`——人工干预标记，重算时作为保留依据。
- `lineage_key: string`——稳定身份键（见第 5 节）。
- 新 store/table `cluster_lineage.jsonl`（迁移后为 `cluster_lineage` 表）：`{id, event: 'merge'|'split'|'move'|'recalc_map', groupIds, fromGroupIds, toGroupId?, memberAssetIds?, createdAt}`——跨重算历史与撤销依据。

## 4. 人工操作（全部走既有 mutation 通道 + 两次确认）

1. **合并**：多选组 → `mergeAssetClusters(groupIds)`：成员并集，`avgSimilarity` 加权重算，代表图取最大组成员代表，`origin='manual_merge'`，记录 lineage 事件。
2. **拆分**：组内多选成员 → `splitAssetCluster(groupId, memberAssetIds)`：选中成员成为新组（`origin='manual_split'`），原组移除这些成员并重算统计；少于 min size 的原组提示但不阻止。
3. **成员纠错**：组成员多选 → `moveAssetClusterMembers(fromGroupId, toGroupId | null, assetIds)`：`null` 目标 = 移出聚类（回到未分组）；记录 lineage 事件。
- 三个操作都使受影响组的 `updatedAt` 更新；confirmed 状态不被操作降级。

## 5. 稳定 Lineage 与跨重算历史

- `lineage_key`：组的稳定身份。自动生成组以"最大成员交集"原则在重算后继承：新组与旧组的成员集合 Jaccard ≥ 0.5 时继承旧组的 `lineage_key`、`name`（若人工命名过）、`status`（confirmed/ignored）和 `origin`。
- 人工干预组（origin 非 auto）在重算时**不删除**：先执行成员级重映射（成员仍在库中则保留组骨架，空组才清理），再让自动重算处理剩余未覆盖素材。
- 重算映射事件以 `recalc_map` 写入 `cluster_lineage`，Clusters 页可查看"上次重算各组去向"。
- 冲突规则：人工组与自动组高度重叠时，人工组优先，自动组跳过这些成员。

## 6. IPC 与 UI

- IPC（遵守检查清单）：`assetLibrary:mergeClusters`、`splitCluster`、`moveClusterMembers`、`listClusterLineage`；全部 ID 参数、数量上限、经 guards。
- Clusters 页：组卡片多选模式 → Merge；组详情内成员多选 → Split/Move（目标组下拉 + "移出聚类"）；组卡片显示 origin 徽标（Manual）与 lineage 来源提示。
- 历史：组详情侧栏显示该组 lineage 事件（来自哪些旧组、被哪些操作改过）。

## 7. 实施阶段与验收

1. 阶段 A：合并/拆分/移动三操作 + lineage 事件记录（合成 fixture 测试成员并集/统计重算/事件内容）。
2. 阶段 B：重算继承（Jaccard ≥ 0.5 继承身份/命名/状态；人工组保留）。验收：构造旧组 → 重算 → 身份与状态保留；人工组合并不被自动重算覆盖。
3. 阶段 C：UI 与历史视图。验收：UI smoke 覆盖合并→拆分→恢复浏览。

## 8. 风险与边界

- Jaccard 阈值 0.5 为初始值，需真实库抽检校准（与准确率门禁同流程）。
- 大组拆分后两组的 `avgSimilarity` 用现有成员 similarity 直接重算，不重新取向量（成员行已存 similarity）。
- SQLite 阶段 3 前实施则写 JSONL 事务，迁移随阶段 3 自动覆盖。
