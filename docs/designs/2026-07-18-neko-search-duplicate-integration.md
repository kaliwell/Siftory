# NekoSearch × Duplicate Finder 集成方案

> 状态：已实施（阶段 A/B/C 全部完成 2026-07-26，见[交接 §17–§19](../current/2026-07-24-feature-implementation-handoff.md)；阶段 B 未采用 suggestions 承载（CHECK 约束冲突），改由 cluster_groups.status；阶段 C 阈值 8 待真实库抽检校准）  
> 更新日期：2026-07-26  
> 范围：NekoSearch 重复素材检测与处置（路线图第 24 项）  
> 前置：SQLite 关系迁移阶段 3 落地后实施（写 `cluster_groups` 的入口届时统一切换）

## 1. 目标与非目标

目标：在 NekoSearch 内检测完全重复与近重复素材组，并提供安全处置（归档保留一份）。非目标：不做物理删除（与"移除素材不删原文件"红线一致）、不做跨库重复（只管 NekoSearch 素材库内）、本阶段不改 Duplicate Finder 面板本身。

## 2. 当前能力复用

1. **完全重复**：`duplicateFinderWorker.ts` 的分组逻辑（大小预分组 + SHA-256 全文哈希），worker 线程隔离。输入从"目录递归"改为"`AssetMetadataStore` 的 187k 路径清单"，避免重复扫盘 stat（复用 `imageIndexAssetSource` 的 24 路有界 stat 校验模式）。
2. **近重复**：Image Search native 索引已持有全部已索引图片的感知哈希（dHash），`fast_scanner` 支持按图搜索——近重复检测等价于"全库 dHash 自相似聚类"，可复用 native 的哈希表而无需重新解码 18 万张图。未索引素材按既有同步流程先入索引。
3. **处置**：`archiveAssetLibraryAssets` / `restoreAssetLibraryAssets` 软归档覆盖层（`archived-assets.json`）已存在，归档不删原文件、保留全部分类/标签关系、可恢复——这就是唯一处置动作。
4. **审核框架**：AI Suggestions 的逐条 Accept/Reject/Ignore 审核流可直接套用到"重复组处置建议"：每组生成一条处置建议（保留代表图，归档其余），用户确认才执行。
5. **数据槽位**：`suggestions.source` 枚举已预留 `'duplicate'`（当前无生产器）；`cluster_groups.algorithm` 可新增 `'duplicate_exact' | 'duplicate_near'`（类型标注 compatibility）。

## 3. 架构与数据流

```text
AssetMetadataStore 路径清单（只读）
  ├─ 完全重复：大小预分组 → SHA-256 分组（worker，复用 duplicateFinderWorker 核心）
  └─ 近重复：native dHash 表 → 组内两两汉明距离 ≤ 阈值并查集分组（worker）
        ↓
duplicate_groups（落 cluster_groups/cluster_group_assets，algorithm='duplicate_exact|near'）
        ↓
每组生成处置建议（suggestions.source='duplicate'，默认保留体积最大/最早入库的一份）
        ↓
Review 工作区逐组 Accept（→ archiveAssetLibraryAssets 软归档其余成员）
Reject/Ignore（组保留，不再重复建议）
```

## 4. 数据结构与 IPC 契约

- 组与成员复用 `cluster_groups` / `cluster_group_assets`（SQLite 迁移后为新表）；`representativeAssetId` = 建议保留份。
- 处置建议复用 `AssetClassificationSuggestion` 结构（`source='duplicate'`，`evidenceAssetIds` = 组内其余成员）。
- 新 IPC（遵守 IPC 检查清单）：`duplicates:buildLibraryGroups`（任务型，可取消，单长任务）、`duplicates:listLibraryGroups`、`duplicates:reviewGroup`（accept → 归档，reject/ignore → 标记）。归档走既有 `archiveAssetLibraryAssets` 的 mutation 通道，不新增删除类能力。
- 阈值：近重复汉明距离阈值默认与 Image Search 一致，可调不入持久化（首版）。

## 5. UI 与状态设计

- Clusters 工作区新增 `Duplicates` 标签页（与 Visual/Semantic/Category 组并列）：组卡片 = 代表图 + 成员数 + 总冗余字节 + 成员缩略图条。
- 操作：Accept（归档其余，两次确认 armed 模式）、Reject、Ignore、View members。
- 归档后成员卡片显示 archived 徽标（现有 Removed 视图语义），处置动作写入删除历史之外——归档本身已有审计轨迹。

## 6. 性能、安全和失败恢复

- 完全重复哈希：187k 文件全量 SHA-256 为长任务，worker 线程执行 + 进度事件 + 可取消；按大小预分组跳过唯一大小文件（预计绝大多数）。
- 近重复：native 哈希表已在内存映射，组内比较限定同大小桶/分片，控制 O(n²) 爆炸（>64 成员的桶只取代表抽样）。
- 安全：全部输入为主进程权威路径清单，无 Renderer 路径传入；处置为软归档可恢复，无物理删除。
- 失败恢复：组与建议写入走 SQLite 事务（阶段 3 后）或 JSONL 事务（当前）；归档操作复用现有 fail-closed mutation；中断后重跑任务幂等（同算法组原子替换）。

## 7. 实施阶段与验收标准

1. 阶段 A：完全重复组构建（worker + 组落库 + 列表 IPC）+ Duplicates 页只读浏览。验收：合成 fixture（含跨目录同内容文件）分组正确；10 万路径构建 < 60s。
2. 阶段 B：处置建议与 Accept/Reject/Ignore 审核流。验收：Accept 后成员归档、关系保留、可恢复；重复建议幂等。
3. 阶段 C：近重复（native dHash）。验收：已知近重复对（旋转/缩放/轻微编辑）同组，误组率人工抽检 < 5%。

## 8. 风险与边界

- 近重复阈值需要真实库抽检校准（与准确率门禁同流程，先记录再定默认）。
- 与 Category Group 的 `Apply matches` 无交互；重复组不参与分类。
- SQLite 阶段 3 前实施则组写走 JSONL 事务，阶段 3 后随迁移切换，无需返工。
