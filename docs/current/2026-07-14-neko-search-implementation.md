# NekoSearch 智能素材分类实施基线

> 状态：当前  
> 更新日期：2026-07-18  
> 范围：`electron/assetLibrary*`、`electron/assetClustering.ts`、`src/components/AssetLibrary*`、`shared/ipc/asset-library.ts`  
> 关联方案：[智能素材分类方案](../designs/2026-07-09-neko-search-classification-plan.md)  
> 关联方案：[AI 审核反馈驱动个性化搜索](../designs/2026-07-15-neko-search-feedback-search-plan.md)  
> 当前进度：[2026-07-18 NekoSearch 当前优化进度](2026-07-18-neko-search-optimization-progress.md)  
> 专项审计：[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)  
> 数据恢复：[2026-07-18 分类数据丢失恢复记录](2026-07-18-neko-search-category-data-recovery.md)  
> 替代文档：无

## 快速结论

NekoSearch 第一条可用纵向链路已经落地。用户可以复用 Image Search 的索引和现有 DINO/CLIP 向量，将图片同步为素材库，进行手动分类、标签管理、参考图分类、文本标签推荐、AI 建议审核和自动聚类。新功能使用独立面板、独立 IPC 命名空间和独立数据目录，没有继续扩大 `ImageSearchPanel.tsx`。

`Accept/Reject` 驱动的 CLIP 文本搜索多中心补召回和有界重排已完成 P0/P1 首轮工程接入；新资料库默认关闭，并由用户通过 `Learning` 显式开启。DINO 以图搜图反馈和真实标注集 A/B 仍未完成，因此该能力是“部分实施”，不能宣称准确率已达到发布标准。

本轮用户指定的四项能力均已有可操作入口：

| 能力       | 当前状态 | 已实现边界                                                                                         |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| 智能分类   | 部分可用 | 手动分类和建议审核可用；删除撤销和核心事务已具备，批量改类仍需补齐                                 |
| 标签       | 部分可用 | 基础管理和 CLIP 建议可用；中文准确率和固定样本门禁未完成                                           |
| 参考图分类 | 部分可用 | 外部参考图、多 prototype 和分类专属阈值可用；固定样本校准和大库 worker/ANN 仍需完成                |
| 聚类       | 优化可用 | DINO Float16 两阶段聚类和逐图纯度过滤已验证；用户实测效果明显改善，lineage 与人工合并/拆分仍未完成 |

## 0. 2026-07-18 当前审计校准

最新专项审计给出的综合健康度为 **83/100**，当前纵向功能闭环约 **86%**，完整智能分类方案约 **69%**。基础功能可继续内部使用，事务、删除回收和整库备份恢复已有保护；以下项目仍是十万级素材库发布阻断项：

1. 分类、标签、建议和聚类成员关系仍是主进程全量 JSONL，尚未迁入带 schema migration 的 SQLite。
2. 参考图、标签建议和部分长向量任务仍在 Electron 主进程，完整 worker/utility process 隔离尚未完成。
3. 缺固定人工标注的真实图片、中文文本、主体检索和聚类质量发布门禁。
4. `adm-zip` 间接依赖仍有高危审计告警，需要验证运行时可达性和兼容升级方案。
5. 聚类重算 lineage、人工合并/拆分和成员纠错仍未完成。
6. 真实磁盘满、权限撤销和 I/O 设备故障尚未执行系统级注入；备份也尚无跨电脑便携导入/导出。

完整证据、真实库规模、风险分级和验收指标以[专项审计](../audits/2026-07-18-neko-search-complete-audit.md)为准。

### 0.1 2026-07-16 第一批整改

1. 同步在临时 Map 和临时文件中计算，取消/失败不再修改活动内存；成功提交后才一次替换。
2. NekoSearch 普通写 IPC 使用单队列串行保存，并与同步、建议、聚类、反馈构建等长任务互斥。
3. 审核严格验证 suggestion、active 素材和分类/标签；AI assignment 保存 `suggestionId`，撤销不再误删后来生成的同类关系。
4. 新资料库的 Search Learning 默认关闭；UI 新增 `Learning` checkbox，关闭时不会自动后台重建。
5. Image Search index parser 限制 100 万记录、256MiB 路径区、单 segment/总字节和 manifest/overlay 大小，拒绝 manifest 目录逃逸。
6. Assets 文本筛选增加 200ms 去抖和请求序号；旧 IPC 响应不能覆盖新筛选。
7. 列表排序改为有界候选堆。真实 180,034 active 素材名称排序由约 493.4ms 降至平均 55.3ms，大小排序由约 126.7ms 降至 8.9ms。
8. NekoSearch 专项测试增至 16/16；IPC、preload、typecheck、lint、format、Renderer build 和 Electron UI smoke 均通过。

第一批整改后健康度估算为 74/100。跨 JSONL 崩溃事务、SQLite catalog、向量 worker/ANN 和准确率算法仍未完成。

### 0.2 2026-07-16 第二批整改

1. DINO/CLIP JSONL 采用逆序分块流读取，同一路径使用最新追加有效 embedding；单行限制为 4MiB。
2. 参考图分类由单 centroid 改为多 prototype 最佳模式匹配，建议 evidence 只记录实际命中的代表图。
3. Reference/Tag 候选 TopK 由线性寻找最差项改为最小堆，单次命中更新由 `O(K)` 降为 `O(log K)`。
4. 手动参考图在分类任务前重新验证；文件修改会失效旧 embedding，文件删除会持久化为 missing。
5. 聚类 `maxAssets` 改为只统计 active 素材，索引中的无关或 missing 项不再占用处理上限。
6. NekoSearch 长任务增加平滑 ETA，并在进度条右侧显示。
7. 真实 3.81GiB DINO 文件读取最新 2,000 个唯一向量耗时 187ms，处理 31.56MiB，heap 增量约 0.22MiB。
8. NekoSearch 专项测试增至 19/19；Vector 16/16、typecheck、lint、format、Renderer build 和六面板 UI smoke 均通过。

第二批整改后健康度估算为 77/100。该段保留当时状态；聚类质量算法已于 2026-07-18 替换，剩余 lineage、人工编辑和分类阈值 A/B。

### 0.3 2026-07-16 第三批整改

1. 分类新增持久化 `referenceThreshold`；旧记录按 0.82 兼容读取，UI 切换分类时加载各自阈值。
2. 全分类参考建议按分类阈值判定 `suggested/low_confidence`，单次请求可显式覆盖。
3. `JsonLinesStore` 增加事务期延迟写入和内存回滚快照。
4. 核心多 store 写入先生成同盘 staged snapshots，再发布 journal 并逐个替换；启动时自动完成未结束提交。
5. 分类/标签删除、AI 建议确认与撤销、聚类结果替换和聚类转分类已接入恢复事务。
6. 聚类创建新分类与 assignment/cluster 状态在同一提交边界，不再先留下空分类。
7. 新增正常提交、action 异常、模拟半提交重启恢复和 journal 路径逃逸测试；专项测试增至 23/23。
8. Renderer/Electron build 与六面板 UI smoke 通过，3646ms、0 console error。

第三批整改后健康度估算为 80/100。该段保留当时状态；事务 journal 已解决核心 JSONL 半提交，聚类质量算法也已于 2026-07-18 整改，SQLite 查询层、跨 `AssetMetadataStore` 事务、向量 worker/ANN、聚类 lineage 和真实标注 A/B 仍未完成。

### 0.4 2026-07-17 样本搜索准确率校准

本轮完成了 Category 显式样本搜索的第二版修复，但用户在真实全库检索中确认：结果比旧版改善，仍不能稳定识别目标主体。因此当前状态是“工程闭环通过、主体准确率未验收”，不能宣称 Sample Search 已达到发布准确率。

| 项目                  | 状态   | 当前边界                                                                 |
| --------------------- | ------ | ------------------------------------------------------------------------ |
| Category 正负样本检索 | 已实现 | 从 AI Suggestions 的 Accept/Reject 读取目标级样本并扫描全库 CLIP         |
| 全量有界样本参与精排  | 已实现 | 最多 128 个去重正样本和 128 个目标级负样本，不再压缩为 `3 + 3` 原型      |
| 算法版本迁移          | 已实现 | `algorithmVersion: 2`；旧 manifest 在下一次 Sample Search 自动失效并重建 |
| 工程回归              | 通过   | TypeScript、lint、format、26/26 专项测试、IPC、preload 和 UI smoke 通过  |
| 真实全库主体识别      | 未通过 | 全局 CLIP 容易被背景、风格、文字和通用类别语义主导                       |
| DINO + CLIP Hybrid    | 未实现 | DINO 仍是约 4GiB JSONL，缺少低延迟随机访问缓存                           |
| 主体区域参考图        | 未实现 | 目前只使用整图 embedding，没有人工框选主体或局部 crop 特征               |

真实审核数据诊断使用一个已有 Category，得到 82 个去重正样本和 98 个去重负样本。旧模型只保留 `3 + 3` 个离群 prototype；v2 改为保留全部有界样本，并采用正样本 Top-2 支持及最近负样本 `0.65` 抑制。留一法样本区分 AUC 约为 `0.97`，但这个指标只说明已审核样本之间可分，不代表在约 18 万张未标注全库中的 `Precision@50/100`，也不能证明目标主体已被正确识别。

当前主要误差来源：

1. CLIP 全局向量表达整张图的综合语义，不保证把用户关心的角色、产品或局部主体作为主特征。
2. 同一主体跨背景、姿态、裁剪和画风时，整图 CLIP 距离可能大于同背景的错误主体。
3. 当前多中心解决的是类别多样性，不等价于主体身份识别。
4. 只在已审核样本上做留一法会高估真实全库精度，必须建立包含 hard negatives 的独立查询集。

下一阶段按以下顺序实施：

1. P0：把 DINO 768 维 JSONL 离线压缩为 Float16 连续向量文件和 path-to-row 索引，支持 mmap/分块随机读取及可重建版本校验。
2. P1：CLIP 负责全库粗召回 3,000-5,000 项，DINO 使用 Category 正负样本做主体外观精排；初始融合权重建议 DINO 75%、CLIP 25%，最终由固定标注集校准。
3. P2：允许外部参考图框选主体区域，生成独立 `object_crop` embedding；整图只作为上下文辅助。
4. P3：对精排 Top 100-200 做局部 crop 验证并缓存结果，避免每次查询重复解码原图。
5. P4：建立固定人工标注集，记录 `Precision@20/50/100`、主体 Recall、Reject intrusion、P95 延迟、峰值内存和 UI 掉帧。

禁止直接在交互搜索中再次流式解析完整 DINO JSONL。DINO Hybrid 必须先完成二进制随机访问缓存和失败回退，避免恢复窗口卡顿和数 GB 重扫问题。

### 0.5 2026-07-17 DINO Hybrid 第一阶段

0.4 节列出的 P0/P1 已完成首轮实现，当前 Category Sample Search 数据流为：

```text
全库 CLIP 扫描
  -> 1,000-5,000 个有界候选
  -> DINO Float16 候选与正负样本读取
  -> CLIP 25% + DINO 75% 主体精排
  -> TopK
```

已完成：

1. 新增 `electron/embeddingF16Cache.ts`，把 latest-wins DINO JSONL 转换为可删除、可重建的 Float16 连续向量文件和 `path -> row` JSONL 索引。
2. 缓存校验模型名、embedding 类型、维度、源路径、源文件大小、mtime、向量文件精确字节数和最大行数。
3. 构建使用独立临时文件，元数据最后发布；成功、取消和失败会清理临时行文件。
4. 新增 `electron/dinoCategoryRerankService.ts`，复用 Category 的全部有界正负样本进行 DINO 评分。
5. 至少需要 2 个 DINO 正样本和 60% 候选覆盖；否则完整回退 CLIP，并在 UI 显示原因。
6. Sample Search 显示 `CLIP + DINO`、DINO 候选数、正负样本数、持续进度和降级 warning。
7. 缺少 DINO 向量的候选在 Hybrid 模式只保留 CLIP 分量，不能以未融合分数压过已精排候选。

真实数据验证：

| 项目                    | 结果                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| DINO 源记录             | 247,052                                                               |
| latest-wins 唯一向量    | 228,618                                                               |
| 缓存构建时间            | 35 秒                                                                 |
| Float16 向量文件        | 351,157,248 bytes，约 334.9MiB                                        |
| 路径索引                | 35,467,005 bytes，约 33.8MiB                                          |
| 当前 Category DINO 覆盖 | 正样本 96/96；负样本 128/128                                          |
| DINO 留一法 AUC         | 约 0.9982，仅作审核集链路诊断                                         |
| DINO 精排吞吐           | 1,000 候选约 163ms；约 6,126 candidates/s；5,000 候选评分推算约 816ms |

仍未完成：主体框选和 `object_crop` 特征、独立于审核样本的全库 `Precision@20/50/100`、真实查询集 A/B、融合权重校准，以及候选索引从顺序路径表升级为更低延迟的二进制哈希索引。

### 0.6 2026-07-18 数据安全加固

最新完整审计中的数据安全阶段已完成第一轮实现：

1. `JsonLinesStore` 只有在文件确实不存在时初始化空库；读取失败进入 unavailable，禁止 insert、update、replaceAll、clear 和事务写入。
2. 含畸形行的 JSONL 仍可读取有效行并生成 corruption report，但整个 store 进入只读状态，避免下一次全量保存丢弃坏行。
3. JSONL transaction journal 升级到 v2，保存 staged snapshot 的字节数和 SHA-256；替换前后都执行完整性校验。
4. journal 恢复连续失败时，所有参与 store 回滚到事务前内存快照并锁定写入；journal 保留供重启恢复。
5. NekoSearch 启动恢复失败时直接保持 unavailable，不再只记录错误后继续创建空 store。
6. 新增 `electron/assetLibraryBackup.ts`：应用启动后延迟创建每日元数据快照，默认保留 7 份，逐文件 SHA-256 校验。
7. 自动备份运行在 NekoSearch mutation queue 内，先刷新所有关系 store 写队列；长任务运行时会延后，不阻塞软件首屏挂载。
8. 备份位置为 `%APPDATA%/floating-clock-electron/asset-library-backups/backup-*`；SQLite catalog 是派生数据，不重复备份。

验证结果：NekoSearch `49/49`、Vector Pipeline `17/17`、IPC `4/4`、preload `1/1`、TypeScript、Lint、format 和 UI smoke 全部通过。真实资料库 9 个关系 store 只读检查全部 `readOnly=false`、`corruptedRows=0`。

当前剩余边界：尚无备份管理 UI、手动立即备份、选择恢复、恢复前保护快照和导出/导入；也未执行真实磁盘满、权限错误和 packaged 安装环境故障测试。

## 1. 用户流程

1. 在 Image Search 中完成图片扫描，并按需要构建 DINO/CLIP embedding。
2. 打开 `NekoSearch` 面板，点击 `Sync Image Index`，同步当前 Image Search manifest。
3. 在 `Categories & Tags` 创建分类树和标签。
4. 在 `Assets` 分页筛选素材，批量分类、打标签或加入分类参考图。
5. 使用 `Build reference AI` 生成 DINO 参考图分类建议。
6. 使用 `Build tag AI` 生成 CLIP 文本标签建议。
7. 在 `AI Suggestions` 按状态和来源分页审核建议。
8. 在 `Clusters` 自动分组，并将确认的分组转为正式分类。
9. 在 `Assets` 勾选素材后使用 `Remove from Assets` 软删除；可立即 `Undo remove`，或打开 `Removed` 视图稍后恢复。

同步动作只读取 Image Search 索引元数据，不重复扫描原盘，也不移动、复制或删除原素材。

## 2. 架构与复用

### 2.1 数据流

```text
Image Search manifest / v1-v4 segments
  -> imageIndexAssetSource
  -> AssetMetadataStore
  -> NekoSearch asset records

DINO global embeddings
  -> per-category reference prototypes + persisted threshold
  -> reference-image suggestions
  -> Float16 cache + 12-bit rough routing
  -> per-image exact purity filtering clusters

CLIP text embedding + CLIP image embeddings
  -> text-tag similarity
  -> tag suggestions

Renderer
  -> preload typed API
  -> assetLibrary:* IPC guards
  -> AssetLibraryService
  -> JSONL metadata / existing vector shards
```

### 2.2 关键文件

| 层       | 文件                                            | 职责                                              |
| -------- | ----------------------------------------------- | ------------------------------------------------- |
| Shared   | `shared/ipc/asset-library.ts`                   | 数据模型、任务状态和 IPC 常量                     |
| Main     | `electron/assetLibraryService.ts`               | 分类、标签、建议、审核和聚类编排                  |
| Main     | `electron/imageIndexAssetSource.ts`             | 安全解析 Image Search manifest 和 native segments |
| Main     | `electron/assetMetadataStore.ts`                | 稳定素材 ID、增量同步、缺失标记和原子持久化       |
| Main     | `electron/assetLibraryEmbeddingSource.ts`       | 流式读取 DINO/CLIP embedding shards               |
| Main     | `electron/embeddingF16Cache.ts`                 | 构建和顺序读取 DINO Float16 路径/向量缓存         |
| Main     | `electron/assetClustering.ts`                   | 粗聚类、原始 cosine 纯度评分和代表图选择          |
| Main     | `electron/assetLibraryGuards.ts`                | IPC 类型、文本、ID、数量和阈值限制                |
| Main     | `electron/assetLibraryIpc.ts`                   | `assetLibrary:*` handler 和进度事件               |
| Renderer | `src/components/AssetLibraryPanel.tsx`          | NekoSearch 工作流和状态编排                       |
| Renderer | `src/components/AssetLibraryAssetGrid.tsx`      | 分页、虚拟化、懒缩略图素材网格                    |
| Renderer | `src/components/AssetLibrarySuggestionGrid.tsx` | 虚拟化 AI 建议审核网格                            |

## 3. 数据与状态

数据目录固定为：

```text
app.getPath('userData')/asset-library/
  assets.jsonl
  asset-catalog.sqlite
  archived-assets.json
  state.json
  categories.jsonl
  tags.jsonl
  asset_categories.jsonl
  asset_tags.jsonl
  category_references.jsonl
  reference_embeddings.jsonl
  reference-images/
  suggestions.jsonl
  cluster_groups.jsonl
  cluster_group_assets.jsonl
```

原始 DINO/CLIP 向量继续复用现有 Vector Database shards，不复制进素材库目录。素材重新同步时路径对应的 ID 保持稳定；不再存在于最新 Image Search 索引中的记录会标记 `missing`，不会立即删除历史分类关系。

用户移除的素材路径单独保存在 `archived-assets.json`，不重写十万级 `assets.jsonl` 主快照。软删除保留分类、标签、参考图和稳定素材 ID；重新同步 Image Search 索引不会让它自动复活，恢复后原关系继续生效。

正式关系优先级为用户手动分类/标签最高。AI 只生成 `suggested` 或 `low_confidence`；用户确认后才写入正式关系。被拒绝或忽略的同来源、同目标建议不会在普通重算中反复出现。

## 4. 算法边界

### 4.1 参考图分类

- 使用 `dinov2_vitb14` 全局向量。
- 按参考图权重计算分类中心。
- 参考图自身不会再次被推荐到同一分类。
- 已人工分类或已审核的相同素材/分类组合会跳过。
- 默认建议阈值 `0.82`，低置信度阈值 `0.70`，均可通过 IPC/UI 调整。

### 4.2 文本标签建议

- 使用 `clip_vit_base_patch32` 文本和图片向量。
- 每个标签保留有界 Top 候选，避免建议无限增长。
- 默认建议阈值 `0.70`，低置信度阈值 `0.60`。
- 中文准确率仍受当前 CLIP 模型能力限制，未加入不可靠的自动翻译层。

### 4.3 聚类

- 直接复用已有 DINO Float16 缓存，避免每次重新解析数 GiB JSONL。
- 先用 12-bit 微桶和加权 K-Means 做有界粗路由，再顺序读取每张图片的真实 DINO 向量做第二阶段纯度过滤。
- 单图与目标中心的原始 cosine 低于 `Purity` 时不会硬塞进最近分组，而是保留为未分组素材。
- 分组平均相似度来自实际保留成员；代表图选择最接近组中心的成员，不再使用桶内首图。
- 两阶段均支持取消、进度反馈和事件循环让出；默认 `Groups 96`、`Min size 5`、`Purity 0.76`。
- 当前是素材整理分组，不是训练监督分类器。

## 5. 性能与安全

1. 素材列表每页 100 条，服务端最大 200 条；AI 建议每页 100 条。
2. 素材和建议网格使用 `useVirtualGrid`，屏幕外卡片不挂载缩略图。
3. 参考分类和标签任务按 JSONL shard 流式读取，相关解析和打分仍可能占用 Electron 主进程；Clusters 已改用紧凑 DINO Float16 缓存和两阶段扫描，但完整 worker/utility process 隔离仍有价值。
4. 同一时间只允许一个 NekoSearch 长任务；普通分类、标签、审核和归档写操作尚未纳入同一事务协调器。
5. 单个素材元数据文件使用临时文件加 rename 的原子快照写入；建议、关系、反馈和聚类等跨文件更新尚不具备整体事务性。
6. Renderer 不直接访问文件系统；IPC 入参先经过 main process guard。
7. 打开素材和定位文件夹复用 `openSafeShellPath` / `revealSafeShellPath`。
8. `Remove from Assets` 只写入软删除覆盖层，不会删除、移动或覆盖磁盘上的原素材；本版本仍没有物理删除原文件的 IPC。

## 5.1 参考图导入与失效缩略图修复

2026-07-14 补充完成：

1. NekoSearch 同步不再只信任 native index 元数据。读取索引后使用 24 路有界异步 `stat` 校验真实文件，失效路径不进入活动素材列表，文件大小和修改时间以磁盘现状为准。
2. segment metadata stride 改为根据 header 的 `metadataOffset` / `diffHashOffset` 推导，并限制在 24–64 bytes，避免未来结构扩展造成字段错位。
3. 分类页新增 `+ Local images`，可一次选择最多 50 张本地图片作为当前分类的参考图。
4. 分类页新增 `Paste image`，可把剪贴板截图保存到 `asset-library/reference-images/` 并直接设为参考图。
5. Assets 工具栏同样提供 `+ Local reference` 和 `Paste reference`。先在 `Choose category` 选择目标分类，即可直接导入外部代表图，不需要从同步数据库中勾选素材；原 `Use as references` 仅保留为数据库素材入口。
6. 手动导入图片使用稳定素材 ID，来源记为 `manual`；后续 Image Search 同步只会更新 `image_search` 来源的缺失状态，不会删除手动参考图。
7. 参考图列表改为真实缩略图展示，可逐张移除；不再要求参考图恰好位于当前 Assets 分页。
8. 外部参考图没有现成 DINO shard 向量时，按需使用 CPU 推理并缓存到 `reference_embeddings.jsonl`，后续重算复用缓存。
9. AI Suggestions 状态筛选新增 `Accepted`；已接受卡片提供 `Undo Accept`。撤销会移除该建议生成的分类/标签关系并将建议恢复为 `suggested`，但不会删除来源为 `manual` 的用户分类。

对当前真实索引的只读验证：187,370 条记录中 180,039 个文件存在，7,331 条路径已失效；解析耗时约 0.29 秒，24 路文件核验约 24.6 秒。修复前截图中的 Autodesk GIF 属于这批失效记录。

## 5.2 Assets 软删除与撤销

2026-07-15 补充完成：

1. Assets 工具栏新增 `Remove from Assets`，支持当前页多选批量移除；原始磁盘文件不受影响。
2. 最近一次批量移除可使用 `Undo remove` 立即恢复。
3. Assets 筛选区新增 `Removed` 视图，支持跨重启查看并批量 `Restore selected`，不依赖会话内撤销状态。
4. 移除状态按规范化路径持久化到独立原子文件 `archived-assets.json`，不会为了移除少量素材重写约十万条主素材记录。
5. 已移除素材不计入活动、已分类和未分类统计，也不参与参考图 AI、文本标签 AI、AI 建议列表和新聚类计算。
6. 分类、标签、参考图关系不被删除；恢复素材后原关系和稳定 ID 保持不变。
7. 本地参考图重新导入已移除的同一路径时，会显式恢复该素材，避免同一路径生成重复记录。

## 5.3 AI 审核反馈驱动搜索

2026-07-15 完成 P0/P1 首轮实现，详细算法和验收边界见 [AI 审核反馈驱动个性化搜索方案](../designs/2026-07-15-neko-search-feedback-search-plan.md)。

当前闭环：

1. 继续复用 AI Suggestions 的 `Accept`、`Reject`、`Ignore` 和 `Undo Accept`，不在搜索结果中复制另一套相关/不相关审核按钮。
2. 用户确认的分类、标签、参考图和聚类作为目标级正样本；Reject 只作为该分类或标签的负样本。未确认、忽略、missing 和 removed 素材不参与。
3. 审核事实成功写盘后才递增 feedback revision。15 秒无其他 NekoSearch 长任务时自动重建；也可点击 `Build Search Learning` 立即执行。
4. 模型状态显示为 `Search learning: state r{built}/{revision} ({targets} targets)`。`ready` 表示当前 revision 已构建；`dirty` 表示仍使用旧模型等待更新；`error` 不影响原始分类和审核数据。
5. 反馈模型保存到 `asset-library/search-feedback/`，只存有界 CLIP 正负原型和状态；它是可删除、可重建的派生缓存，不复制全库 embedding。
6. Image Search 的 Semantic 查询可靠匹配分类/标签名称时，先执行全库 CLIP 扫描，再补入目标原型并进行最大 `±0.12` 的有界精排。未匹配目标、无模型或模型失败时保持原 CLIP 搜索。
7. 搜索结果指标会显示 `CLIP+feedback rN`，响应同时记录 revision、stale、反馈耗时、目标和单结果 `feedbackBoost`。
8. 全库向量仍全部参与基础打分，但内存中只保留有界唯一候选堆和目标原型，不再创建并排序 18 万级全库候选对象。
9. NekoSearch 新增独立 `Sample Search` 页。用户直接选择 Category 后，即可用该分类下已确认素材和明确 Reject 对全库 CLIP 向量检索，不需要输入分类名或文本查询。
10. Category 样本搜索会在模型 missing/dirty 时自动重建当前 feedback revision；`Learning` 开关只控制 Image Search 文本反馈，不会关闭显式 Category 样本搜索。
11. 全库召回阶段使用由全部正样本聚合出的最多 4 个受支持聚类中心覆盖不同视觉模式；候选集再使用最多 128 个去重正样本和 128 个目标级 Reject 负样本精排。正样本需要最近两个样本共同支持，最近 Reject 使用 `0.65` 权重抑制。默认排除已审核素材，保证 TopK 优先展示尚未判断的新候选；可用 `Include reviewed` 检查训练样本排序。
12. 每次搜索显示百分比、ETA、正负样本数、模型 revision、扫描总量、耗时和单项 Match/positive/negative 分数；结果可多选并用 `Classify selected` 写入当前 Category。

2026-07-16 准确率修复：旧算法对 75 个以上有效正样本和 64 个负样本只生成了 `3 + 3` 个离群代表原型，导致绝大多数人工审核结果未参与最终评分，并产生单一离群样本主导结果的问题。反馈模型算法版本已升级为 `2`，旧 manifest 会自动失效并在下一次 Sample Search 时重建。使用当前本机已审核 Category 的正负样本做留一法诊断，全部样本双近邻加最近负样本的区分 AUC 约为 `0.97`；该数值只用于本机回归诊断，不等同于独立测试集发布指标。

审计校准：新资料库当前默认 `enabled: false`；NekoSearch 顶部 `Learning` checkbox 控制是否把反馈应用到 Image Search。关闭时仍可手动构建派生模型，但不会自动后台重建。已有 userData 中明确保存的 `enabled` 值继续兼容。

使用顺序：

```text
AI Suggestions 中 Accept / Reject
  -> 等待约 15 秒后台重建，或点击 Build Search Learning
  -> 确认 Search learning 为 ready
  -> Image Search / Semantic 输入对应分类名或标签名
  -> 查看 CLIP+feedback rN 结果
```

不依赖文本的多样本搜索顺序：

```text
AI Suggestions 按 Category 执行 Accept / Reject
  -> 打开 Sample Search
  -> 选择同一个 Category 和 TopK
  -> 点击 Search category samples
  -> 自动重建最新样本模型并扫描全库 CLIP 向量
  -> 查看匹配分数；确认结果可用 Classify selected 归入该分类
```

当前已接入 CLIP 文本语义反馈和显式 Category 全样本搜索。DINO embedding 当前仍是约 4 GB JSONL 流式存储，缺少可随机访问的二进制/ANN 缓存；直接在交互搜索中叠加 DINO 会重新引入长时间磁盘扫描和窗口卡顿，因此本轮不伪装成 Hybrid。后续必须先建立 DINO 随机访问缓存，再做 CLIP 召回、DINO 外观精排和独立人工标注 A/B。当前可以确认工程闭环和本机审核集回归明显改善，但仍不能把本机留一法结果当成发布准确率。

## 5.4 SQLite 素材目录投影

2026-07-16 完成第一阶段：

1. `asset-catalog.sqlite` 只保存 `assets.jsonl` 的查询投影，不取代 JSONL 权威数据，也不删除用户原图。
2. 启动时校验 JSONL、state、archive 文件指纹和行数；一致才启用 SQLite，不一致则后台分批重建。
3. 普通 Assets 最近/名称/大小/归档/路径查询下推 SQLite；分类、标签、未分类筛选继续走内存回退。
4. 每 2048 行提交一次并让出事件循环；投影错误会记录 warning 并自动退回已有 Map 列表。
5. 18 万条合成基准：首建约 2.17s、投影 50.73 MiB，最新页中位 2.45ms，深名称页 9.78ms，路径子串 30.89ms。
6. FTS5 trigram 因首建约 14.9s且查询无收益已撤销，继续使用严格路径子串语义。

## 5.5 AI Suggestions 审核卡顿修复

2026-07-17 完成审核交互和写入链路修复：

1. 根因不是当前建议库过大：实测 `suggestions.jsonl` 为 500 条、约 99 KB，分类关系为 106 条、约 20 KB。
2. 原实现没有逐项提交状态；连续点击 Accept、Reject 或 Ignore 会把多个互相冲突的状态变更排入全局 mutation queue，最终状态由最后执行的点击决定。
3. 原实现每次审核均事务性重写 suggestions、category assignments 和 tag assignments，并在完成后串行刷新建议页、全库统计、分类、标签和反馈模型状态。事务包含主进程同步序列化、写入、fsync 和 rename，因此写入期间 Open 等其他 IPC 也可能短暂无响应。
4. 前端现在一次只允许一个建议审核操作；当前卡片显示 `Saving review...`，其他审核按钮在提交完成前禁用，防止重复排队和状态覆盖。Open 保持可用。
5. 建议列表先刷新；较重的基础统计在后台刷新，不再阻塞卡片解除保存状态。
6. Reject 和 Ignore 只提交 suggestions；Accept 仅额外提交实际涉及的 category 或 tag assignment，不再无条件重写三份存储。
7. 只有正负学习含义实际变化时才标记反馈模型 dirty；普通 suggested -> ignored 不再触发无意义的 15 秒后台重建。
8. AI Suggestions 增加 Rejected 和 Ignored 独立筛选，便于检查误操作和后续撤销。
9. 重复提交同一状态现在是幂等操作，不再写盘；Accepted 不能被 Reject/Ignore 直接覆盖，必须先执行 Undo Accept，避免建议状态和正式分类关系分叉。

仍保留的边界：JSONL 跨 store 事务为了崩溃恢复仍使用同步 durable write。当前小型审核文件下影响已受控；如果建议和关系数据增长到十万级，应迁移至 SQLite 事务或 utility process，不能依赖 UI 防重复作为长期性能方案。

## 5.6 Clusters 单图纯度优化

2026-07-18 替换旧的桶级共享分数方案：

1. 旧实现只读取 DINO 向量的 10 个维度符号，将全库压成最多 1,024 个桶；桶内不同图片共享同一个中心和相似度，默认平移 cosine 0.58 实际只约等于原始 cosine 0.16，容易形成大杂组。
2. 新实现读取已有 DINO Float16 缓存，使用 12-bit 微桶完成快速粗路由，不再重复解析约 4 GB embedding JSONL。
3. 粗聚类完成后第二遍逐张读取真实 DINO 向量，并与路由到的组中心计算原始 cosine。只有达到 `Purity` 的单图才写入组，其余素材留在未分组区。
4. 组内平均相似度改为单图真实分数；代表图改为最接近组中心的实际成员，不再使用粗桶中的第一张图片。
5. 默认参数改为 `Groups 96`、`Min size 5`、`Purity 0.76`；Groups 上限提高到 256。内容仍杂时可将 Purity 提高到 0.80–0.85。
6. 真实缓存只读基准：200,000 个 DINO 向量、3,864 个微桶，96 个粗中心，最终 60 个有效组；保留 35,258 个高置信成员（17.63%），真实平均 cosine 0.8531，最低 0.76，总耗时约 28.3 秒。最大组由 64/0.72 配置的 12,361 张降至 4,907 张。
7. 聚类结果仍是可删除重建的 AI 建议，不移动、删除或改写原始素材；只有用户点击 Convert to category 后才生成正式分类关系。
8. 2026-07-18 用户在实际素材库重算后反馈“效果好多了”。该结论证明旧大杂组问题明显缓解，但属于定性验收，不能替代固定标注集上的 purity、coverage 和重算稳定性指标。

## 5.7 Clusters 范围与自适应组数

2026-07-18 增加大图库自适应分类：

1. `Scope` 为空时处理全部已索引 active 素材；`+ Folders / Drives` 可多选文件夹或盘符根目录，多个根目录按并集过滤。范围过滤只读取已有素材记录和 DINO embedding，不扫描或移动原文件。
2. `Auto groups` 默认开启。算法综合符合范围的素材数量、DINO 微桶数量和桶分布归一化熵，在 2-256 个中心之间自动选择；规模曲线使用素材数平方根，内容越杂、分布越均匀，中心越多，内容越集中则越少。
3. 关闭 `Auto groups` 后恢复手动 `Groups` 数值；`Min size` 和逐图 `Purity` 在两种模式下都继续生效。
4. 默认全库安全上限由 200,000 提高到 500,000 个 active embedding；进度信息会显示实际匹配素材数、视觉桶数和自动选择的中心数。
5. 重算只替换当前 AI Cluster 建议及其成员，不删除已经 Convert to category 的正式分类关系。
6. 新增范围 IPC、preload 契约和输入 guard；最多接受 64 个去重范围根目录，每个路径最多 4,096 字符。
7. 逐图纯度阶段不再只继承一个微桶粗中心。每个微桶预选 4 个近似中心并保留原路由中心，每张图片再以完整 DINO 向量选择真实最佳中心，减少“选错中心后被判未分组”的漏分。
8. 多候选精排会增加重算时间，但保持顺序缓存读取，不会把全库向量同时驻留内存；它优先修复覆盖率，而不是通过降低 Purity 强行收图。
9. `Auto groups` 增加高纯度残差二次聚类：第一轮未达到 Purity 的素材重新建立微桶，最多增加 128 个残差中心，再按相同 Purity 逐图验证。它用于发现被主流大组忽略的小众视觉模式，不直接降低阈值。
10. 每个有效组抽取最多 4 个高置信成员，随机读取已有 CLIP Float32 缓存；内置词库批量生成媒介、主体、场景和风格四个维度的标签。组名默认采用最高相关标签加序号，卡片显示最多 4 个标签；CLIP 不可用时安全回退到 `AI Group`。
11. 当前内置标签覆盖 photo、screenshot、document、meme、illustration、anime、3D render、人物、动物、产品、设备、场景、构图和视觉风格等 67 类概念。真人摄影新增 `real-person photo`、`portrait photo`、`fashion model`、男女模特、影棚、秀场、街拍、写真、商业时尚大片、自拍、Cosplay、泳装、婚礼和生活方式肖像等标签。标签用于解释和命名建议组，不会自动写入正式 Asset Tags。
12. 专项测试增加自适应多样性、范围去重、多中心路由、标签维度和 CLIP 缓存随机读取回归。
13. `Semantic refine` 默认开启。DINO 完成视觉外观聚类和逐图 Purity 校验后，系统复用现有 CLIP 图片缓存，在每个 DINO 组内学习最多 4 个语义中心，再执行第二遍精确语义归组。默认 `Semantic purity` 为 `0.86`，该值来自当前真实 CLIP 缓存样本分布校准。
14. CLIP 语义细分只拆分已通过 DINO Purity 的组，不会降低 DINO 纯度，也不会把未通过 DINO 校验的图片强行加入。小于 `Min size` 的语义子组会合并到最近的有效语义中心；缺少 CLIP embedding 的成员保留在原 DINO 主组。
15. 写入聚类结果前强制检查成员数量守恒。语义扫描不可用、异常或成员数不一致时，整轮语义细分自动回退到原 DINO 分组，不写入不完整结果。
16. Clusters 页可关闭语义细分，或调整 `Semantic purity`（0.60-0.99）和单个 DINO 组的 `Max splits`（1-8）。每组最多显示 5 个不同维度的语义标签。
17. 真实库复测发现旧排序会无条件从每个维度选一个标签，导致 209 组中 `wedding portrait` 错标 60 组，而 `fashion model` 为 0。现已改为相对置信度门槛和真人证据门控：写真、模特、自拍等细分类只有在 `person/woman/man/people` 分数接近全局最佳时才参与；模特身份独立为 `role` 维度，可与 `woman/man` 同时输出，并优先作为自动组名。
18. 新增 `Refresh labels`：每组读取最多 8 张现有代表图，仅重算群组名称和标签，不重跑 DINO/CLIP 聚类、不改变成员，并保留用户手动修改过的群组名称。专项测试当前为 39/39 通过。

2026-07-18 优化前真实库基线：180,016 active 素材中 176,386 个具有 DINO（97.98%）；98 个建议组包含 32,580 个唯一素材，DINO coverage 18.47%。残差聚类上线后需要由用户重新执行 `Recalculate clusters`，再以页面 `Grouped` 数值复测；实现不会自动覆盖已有聚类结果。

## 6. 验证

| 项目               | 命令                                  | 结果                                                                                                    |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| TypeScript         | `npm.cmd run typecheck`               | 通过                                                                                                    |
| Lint               | `npm.cmd run lint`                    | 通过                                                                                                    |
| 格式               | `npm.cmd run format:check`            | 通过                                                                                                    |
| NekoSearch 专项    | `npm.cmd run test:asset-library`      | 39/39 通过；覆盖逐图纯度、真人门控、错误写真抑制、CLIP 缓存流读取、语义细分和事务恢复                   |
| IPC 入参           | `npm.cmd run test:ipc-validation`     | 4/4 通过                                                                                                |
| IPC 注册           | `npm.cmd run test:ipc-registration`   | 4/4 通过                                                                                                |
| Preload 契约       | `npm.cmd run test:preload-contract`   | 1/1 通过                                                                                                |
| Vector 回归        | `npm.cmd run test:vector-pipeline`    | 16/16 通过；363ms                                                                                       |
| Renderer 构建      | `npm.cmd run build:renderer`          | 通过；NekoSearch lazy chunk 40.30 kB，gzip 10.35 kB                                                     |
| Electron UI smoke  | `npm.cmd run smoke:ui`                | 通过；3784 ms，无 console error，6 个面板均正常挂载                                                     |
| 多 store 恢复      | 临时 JSONL 事务回归                   | 通过；正常全提交、action 异常全回滚、模拟半提交重启恢复                                                 |
| 取消一致性回归     | 临时素材库中途取消同步                | 通过：内存、磁盘和 next ID 保持上次提交状态                                                             |
| 真实库只读规模基准 | 180,034 active assets                 | 首次载入 827.8ms；名称排序平均 55.3ms，大小排序平均 8.9ms                                               |
| DINO 逆序流短基准  | 3.81GiB JSONL，最新 2,000 唯一路径    | 187ms；处理 31.56MiB；heap 增量约 0.22MiB                                                               |
| NSIS 归档完整性    | `npm.cmd run smoke:installer:archive` | 通过；572.83 MiB、176 files、SHA-256 `FC88D99B2CCFADB51C778386AE02947B2A1921304550023AFBC93600B3018BDD` |

本轮已重打 NSIS 并验证归档完整性，但没有执行 packaged UI 和干净 Windows VM 安装。聚类已完成真实 DINO 缓存 200,000 向量的只读性能/纯度统计和用户实际库定性验证；尚未执行会写入结果的固定标注全量质量基准。专项测试已覆盖 native segment 同步、稳定 ID、损坏/删除语义、IPC guard、取消回滚、索引预算、审核身份和逐图离群素材剔除。

## 7. 剩余项

已完成三批整改：同步取消回滚、IPC 写队列、审核严格校验、反馈默认门禁、索引预算、列表有界排序、向量 latest-wins、多 prototype 参考分类、分类阈值持久化、核心 JSONL 恢复事务、外部参考图失效和 ETA。

仍需完成的审计阻断项：

1. SQLite Catalog 第一阶段已完成普通分页；仍需迁移分类、标签、建议等关系筛选，统一 schema migration、跨域事务并逐步移除全量 Map。
2. 向量任务迁移 worker/utility process，并复用 compact binary/ANN，不再重复解析数 GB JSONL。
3. 建立固定人工标注集 A/B，校准反馈模型和分类阈值。
4. 聚类补齐用户组 lineage、重算稳定 ID 和人工合并/拆分；参考分类继续完成固定样本校准。
5. CLIP binary cache 离线 compact、orphan repair 工具和跨 store 故障恢复。

产品能力剩余项：

1. P2 重复/近重复素材组及安全批量处理。
2. 聚类组手动合并、拆分和成员级调整。
3. 分类参考图权重的可视化编辑和完整分类详情页。
4. AI 建议批量审核及“改到其他分类”。
5. 标签/分类统计图、批量导出和文件夹整理动作。
6. Media Search 视频关键帧接入统一素材库。
7. 中文多语义模型或经过标注验证的中文标签方案。
8. 分类、标签和建议的导入、导出、迁移与一致性修复工具。
9. 真实素材集上的聚类纯度、覆盖率和人工分类准确率基线。
10. 反馈搜索的独立 train/test 标注集、A/B 指标和阈值校准。
11. DINO 以图搜图反馈精排、高 margin 目标激活和 hard negatives。
12. 分类/标签别名、描述词和经过验证的多语目标激活。
13. 主体感知检索：DINO Float16 随机访问缓存、CLIP 粗召回 + DINO 精排、主体 crop 参考图和固定全库准确率门禁。

在进入磁盘原文件删除/移动功能前，仍必须单独完成事务、系统回收站和失败恢复审计；当前软删除不触碰原文件。

## 2026-07-18 真人素材逐图语义分组

### 根因结论

此前新增真人、模特、写真等标签后，Clusters 仍难以出现可用真人组。实际数据审计证明，问题不在提示词数量，而在处理层级：DINO 视觉组可能同时包含真人、图标、截图、纹理和游戏素材。对每组最多 8 张代表图取 CLIP 中心并贴标签，无法把组内真人图片分离出来，还会产生 `performer`、`selfie` 等假阳性组名。

### 当前实现

1. Clusters 新增 `Build people groups`，直接扫描现有 CLIP Float32 二进制缓存，不重建 DINO/CLIP embedding，也不解析数 GB JSONL。
2. 每张图片先经过“真人照片”与图标、UI 截图、文档、动漫、游戏、商品、动物、风景、Logo、纹理和 3D 渲染的对比门控。
3. 只有真人分数、绝对阈值和相对非真人 margin 同时通过，才继续分类为：`Real model photos`、`Portrait photography`、`Selfies`、`Cosplay photos`、`Stage performers`、`Wedding portraits`、`Group photos` 或 `People and lifestyle`。
4. 每张通过门控的图片只进入一个人物语义组；重复 CLIP 路径按稳定 Asset ID 去重。
5. 人物组使用 `semantic_zero_shot` 算法标记，并在 UI 显示 `Semantic`；原 DINO 分组显示 `Visual`。人物组可以继续使用 `Convert to category` 转成正式分类。
6. 人物语义组与 DINO 视觉组允许重叠，因此“Grouped/remaining”覆盖率只统计 DINO 视觉组，避免重复成员导致覆盖率超过 100%。
7. `Recalculate clusters` 会保留已生成人物语义组；`Refresh labels` 只更新 DINO 组，不覆盖人物语义组的稳定名称。
8. 支持当前 Clusters 的文件夹/盘符 Scope；`All data` 时扫描全部活动素材对应的 CLIP 缓存。

### 使用顺序

```text
Image Search 完成 Build CLIP / Build CLIP GPU
  -> 打开 NekoSearch / Clusters
  -> 选择 + Folders / Drives，或保持 All data
  -> 点击 Build people groups
  -> 等待逐图百分比进度完成
  -> 在列表顶部查看 Semantic 真人组
  -> 需要长期管理时点击 Convert to category
```

### 本机只读验证

- CLIP 缓存：246,534 条，逐图分类约 2.4 秒。
- 高置信真人候选：6,225 条。
- 分组计数：模特 373、肖像 940、自拍 1,462、Cosplay 738、舞台人物 551、婚礼 358、多人合照 761、生活人物 1,042。
- 人工抽查最高分代表图：真人模特、Cosplay 和多人群像均匹配；肖像组可能包含带文字/界面的真人主体截图，这是主体语义分类的已知边界。
- 工程验证：NekoSearch 41/41、IPC registration、preload contract、typecheck、lint、Renderer/Electron build 全部通过。

## 2026-07-18 NekoSearch 工作区合并与 Similar 反馈闭环

### 界面收敛

顶层导航由五个页面收敛为三个工作区：

1. `Library`：合并 `Assets` 与 `Categories & Tags`。素材筛选、批量分类、标签、参考图和分类维护共享同一个工作区。
2. `Review`：合并 `AI Suggestions` 与 `Sample Search`，并增加 `Similar Results`。
3. `Clusters`：继续独立，避免大规模聚类参数和日常素材审核互相干扰。

原功能没有删除，只从顶层标签移动到对应工作区内的紧凑分段控件。素材和审核网格继续使用可视区域虚拟化，Top 500 不会同时挂载全部缩略图。

### Similar 搜索

1. Sample Search 和 AI Suggestions 的每张结果卡新增 `Similar`。
2. 点击后使用该素材现有 DINO 向量作为查询，在完整 DINO Float16 缓存中流式扫描。
3. 搜索过程只保留 TopK 小顶堆，不全量加载约 22 万条向量；活动素材、归档状态和 Category 审核状态在返回前统一过滤。
4. 支持 Top 50/100/200/500、Include reviewed、继续对结果点击 Similar，以及分页展示。
5. Suggestion 属于 Category 时自动沿用该 Category；Tag Suggestion 或无 Category 上下文时，可在 Similar Results 中选择目标 Category。
6. 返回结果保留素材分类、标签、DINO 匹配分数和正负样本状态，可以直接批量审核。

### 准确率反馈

`Sample Search` 和 `Similar Results` 都支持：

- `Relevant`：写入用户确认的 Category 正样本。
- `Not relevant`：移除该 Category 的冲突关系，并写入 `manual_review` 负样本。

正负样本写入同一个跨 store JSONL 事务，并标记 Search Learning revision 为 dirty。后续 Category Sample Search、CLIP+DINO 重排和启用后的 Image Search Learning 会复用这些反馈。

### 验证

- TypeScript、lint、format：通过。
- NekoSearch 专项：41/41。
- IPC registration：4/4。
- preload contract：1/1。
- Electron UI smoke：通过；新增断言覆盖 `Library / Review` 合并导航、`Similar Results` 入口、分类创建/删除/撤销和返回 Assets。

## 2026-07-18 Clusters 按 Category 建立独立候选组

### 功能定位

Clusters 新增 `Category group`。它不是重新执行无监督聚类，而是把已经人工维护的 Category 当作检索目标：复用该分类的参考图、已确认素材、Relevant 正样本以及 Reject/Not relevant 负样本，在素材库中搜索同类图片，并把命中结果保存为一个独立候选组。

### 数据与算法

1. 全库召回使用当前 Category 的 Search Learning CLIP 多原型，覆盖分类内不同视觉模式。
2. 候选集使用 DINO 进行主体重排，最终分数为现有 Category Sample Search 的 CLIP + DINO 组合分数。
3. 明确 Reject/Not relevant 的图片始终排除；默认也排除已经确认的正样本，使候选组优先包含尚未审核的新素材。
4. `Include reviewed` 开启后允许已确认正样本进入结果，适合检查分类内部一致性；Rejected 负样本仍不会进入。
5. 支持当前 Clusters 的文件夹/盘符 Scope。Scope 为空时搜索全部 active 素材。
6. `Results` 范围为 10-5000；`Min score` 范围为 0-1，默认分别为 500 和 0.55。
7. 重复运行同一个 Category 会原子替换该 Category 的旧候选组及成员，不会累积重复组。

### 写入边界

1. `Build category group` 只写入 `cluster_groups.jsonl` 和 `cluster_group_assets.jsonl`，不会直接修改正式分类关系。
2. Category 候选组在列表中显示为 `Category`，并排在普通 Visual 和 Semantic 组之前。
3. 用户确认候选质量后点击 `Apply matches`，才把组内素材正式加入来源 Category。
4. 普通 `Recalculate clusters` 只替换 `compressed_kmeans` 视觉组，会保留 Category Group、人物语义组和旧版特殊组。
5. `Refresh labels` 不覆盖 Category Group 的稳定分类名称与标签。

### 推荐顺序

```text
Library 创建 Category 并添加代表图
  -> Review / Sample Search 标记 Relevant 与 Not relevant
  -> Build Search Learning
  -> Clusters 选择 Category、Results 和 Min score
  -> 可选设置文件夹/盘符 Scope
  -> Build category group
  -> 检查独立候选组
  -> 确认无误后 Apply matches
  -> 新反馈积累后再次 Build Search Learning
```

### 验证

- TypeScript、lint、format：通过。
- NekoSearch 专项：42/42。
- IPC registration：4/4。
- preload contract：1/1。

## 2026-07-18 搜索结果 Shift 范围选择

1. `Library / Assets`、`Review / Sample Search` 和 `Review / Similar Results` 共用的素材网格支持 Shift 范围选择。
2. 普通点击 checkbox 会设置选择锚点；按住 Shift 点击另一张图片的 checkbox，会按当前结果顺序处理首尾之间的完整区间。
3. Shift 终点原本未选中时，区间统一选中；终点原本已选中时，区间统一取消，适合快速撤销误选。
4. 虚拟滚动不会丢失锚点；切换分页、搜索条件或结果批次后自动清除旧锚点，避免跨结果误选。
5. AI Suggestions 仍保持逐条 Accept/Reject/Ignore。本轮不把 Shift 点击映射为批量审核，避免无确认地批量写入正式分类或负样本。
6. Electron UI smoke 在隔离库有至少 4 张素材时覆盖“第1张到第4张范围选中，再按同一区间范围取消”的真实 DOM 交互；隔离库为空时明确跳过该项，不把无素材误报为失败。
7. `asset-selection-range.test.cjs` 固定验证正向范围、反向范围、包含首尾以及锚点/目标失效时的安全回退；NekoSearch 专项当前 44/44 通过。

## 2026-07-18 元数据备份与选择恢复闭环

### 用户入口

NekoSearch 顶部新增 `Backups`：

1. `Back up now`：等待当前写队列落盘后立即生成手动快照。
2. `Verify`：逐文件重新计算 SHA-256 和字节数，损坏备份不能恢复。
3. `Restore`：第一次点击进入 5 秒确认状态，第二次才执行恢复。
4. `Open folder`：打开 `%APPDATA%/floating-clock-electron/asset-library-backups`。
5. 列表显示创建时间、来源、文件数和体积；来源分为 `automatic`、`manual`、`pre_restore`。

### 数据安全逻辑

1. 每份快照保存素材元数据、分类、标签、关系、建议、聚类、参考图关系、删除回收记录和 Search Learning 状态。
2. `asset-catalog.sqlite` 是可重建投影，不进入备份；恢复时清除 SQLite/WAL/SHM 后从 `assets.jsonl` 重建。
3. 恢复前先完整校验目标备份，再强制创建 `pre_restore` 保护快照，避免用户选错历史版本后无法回到恢复前状态。
4. 恢复文件先复制到资产目录内的独立 stage，逐文件核对字节数和 SHA-256 后才发布 restore journal。
5. journal 发布后所有替换和删除都可重复执行；若程序中断，下一次服务初始化会继续完成。
6. stage 被篡改、journal 路径越界或目标校验失败时，服务保持 unavailable，不创建空 store，也不继续写入。
7. 恢复成功后重新初始化 AssetMetadataStore、关系 stores 和 Search Learning 服务，清除界面中的旧搜索结果并刷新统计。
8. 自动备份仍在启动 30 秒后调度，默认每天一次、保留最近 7 份；手动与恢复前快照通过同一写队列串行化。

### 当前边界

1. 备份位于本机用户数据目录，尚无跨电脑便携导出/导入。
2. 尚无删除单份备份入口；保留策略会自动清理旧快照。
3. 已覆盖内容篡改、路径逃逸和中断续做；真实磁盘满、权限撤销、I/O 设备错误和断电仍需系统级故障注入。

### 验证

- TypeScript：通过。
- Lint：通过。
- NekoSearch 专项：54/54。
- IPC registration：4/4。
- IPC validation：4/4。
- preload contract：1/1。
- Electron UI smoke：通过，4245ms，无 panel crash 或 console error。

## 2026-07-18 主素材元数据 fail-closed 统一

### 读取边界

1. 只有 `assets.jsonl`、`state.json` 或 `archived-assets.json` 确实不存在时，才按首次初始化处理。
2. 现有 `state.json` 读取失败、JSON 损坏或字段非法时，素材存储进入 `unavailable`，不再回退到 `nextId=1`。
3. 现有 `archived-assets.json` 读取失败、JSON 损坏、条目非法或路径重复时进入 `unavailable`，不再把已移除素材误当成活动素材。
4. `assets.jsonl` 中的合法记录仍可读取；畸形 JSON、非法 ID/路径、重复 ID 或重复路径会写入 corruption report，并把整个主素材存储切换为 `read_only`。
5. `read_only` 和 `unavailable` 都拒绝同步、归档、恢复、手动参考图导入、手动素材校验和显式持久化，避免后续操作覆盖仍可恢复的原始文件。

### 写入边界

1. 归档操作使用独立 archive 快照，落盘成功后才替换活动 Map 和素材状态。
2. 手动参考图导入在暂存 records、path index、state 和 archive overlay 中完成，必要快照全部落盘后才提交内存状态。
3. 素材同步和手动素材校验延续暂存 Map 语义，持久化成功前不替换活动状态。
4. 非取消类写盘失败会把当前进程锁为 `unavailable`；后续写入全部拒绝，读取中的内存状态不会伪装成已提交。
5. NekoSearch 顶部会显示 `Data read-only` 或 `Data unavailable`，并显示损坏行数和详细原因；即使启动加载失败，统计接口也只返回明确的 unavailable 诊断，不把不可信的部分素材记录计入总数。
6. IPC 服务已有统一 mutation queue，普通修改串行执行；长任务与普通写入互斥，避免两个旧快照并发覆盖。

### 兼容与验证

- 真实资料库只读检查：187,370 条素材、0 个坏行、`nextId=187371`、11 条归档记录。
- TypeScript：通过。
- Lint 与 format：通过。
- NekoSearch 专项：59/59；新增素材坏行只读、损坏 state 停机、损坏 archive 停机、归档写失败内存回滚和 unavailable 诊断统计测试。
- Vector Pipeline：17/17。
- IPC registration：4/4。
- IPC validation：4/4。
- preload contract：1/1。
- Electron UI smoke：通过，4252ms，无 panel crash 或 console error。

### 剩余边界

本节记录时 `assets.jsonl` 与 `state.json` 仍存在双 rename 崩溃窗口；该边界已经由下一节的专用事务解决。archive overlay 的跨文件边界也已在同一事务中补齐；当前剩余边界是尚未执行真实磁盘满、权限撤销和设备 I/O 故障的系统级注入。

## 2026-07-18 主素材校验事务（含可选归档 overlay）

### 提交流程

1. `persistSnapshot()` 不再直接 rename `assets.jsonl.tmp` 和 `state.json.tmp`。
2. 新模块 `assetMetadataTransaction.ts` 为 `assets.jsonl`、`state.json` 两个必需目标生成同目录、随机命名的 stage；重新导入已归档参考图时增加 `archived-assets.json` stage。
3. 素材流写入时同步累计字节数和 SHA-256，避免为 journal 额外完整读取一次约 70MB 的快照。
4. 两个或三个 stage 写完后等待句柄 `close` 并执行 fsync；随后把目标、stage、字节数和 SHA-256 写入并 fsync 专用 journal。
5. journal 发布后，先校验全部可恢复文件，再依次替换 target，最后重新校验全部 target；全部成功才删除 journal。
6. journal 发布前收到取消会删除 stage，不改变现有 target；journal 发布后不再回退，必须完成提交或保持 journal 等待重启恢复。

### 启动恢复与安全

1. 服务初始化顺序为：备份恢复 journal -> 主素材校验 journal -> 关系 JSONL journal -> 创建 stores。
2. 第一个 target 已替换、第二个 stage 尚存时，启动恢复会分别使用已替换 target 和剩余 stage 完成同一事务。
3. journal 只允许固定目标 `assets.jsonl`、`state.json` 和可选 `archived-assets.json`；前两个必须各出现一次。所有文件名必须是同目录 basename，stage 必须使用固定前缀。
4. journal、stage 和 target 都拒绝符号链接；缺失文件、超大 journal、重复目标、路径逃逸、非法哈希或内容篡改都会阻止服务初始化。
5. 无 pending journal 时会清理专用孤立 stage、journal 临时文件、旧版 `assets.jsonl.tmp/state.json.tmp` 和中断遗留的 `archived-assets.json.tmp`。
6. 长快照背压等待现在会移除临时 `drain/error` 监听器，避免十万级写入累积监听器；取消和错误路径会等待文件句柄关闭后再清理 stage。
7. 普通归档和恢复仍只写小型 `archived-assets.json`，使用临时文件、文件 fsync、原子 rename 和目录同步，不会为单个归档操作重写主素材库。

### 验证

- NekoSearch 专项：66/66；覆盖双/三文件部分替换续做、归档 stage 篡改、路径逃逸、服务启动锁定、重新导入一致性和取消后无事务残留。
- TypeScript、Lint、Format：通过。
- IPC registration：4/4；IPC validation：4/4；preload contract：1/1；guards：7/7。
- Vector Pipeline：17/17。
- 18 万素材基准：构建 2276.90ms，SQLite 50.73MiB，普通更新页中位 2.81ms，深层名称页中位 11.08ms。
- Electron UI smoke：通过，4233ms，无 panel crash 或 console error。

### 当前剩余边界

主素材、状态和重新导入时的 archive overlay 已进入同一可恢复事务。剩余数据持久化风险主要是尚未执行真实磁盘满、权限撤销、设备 I/O 故障和安装包环境故障注入；长期扩展到更大关系规模时，仍应评估迁移到单一 SQLite 权威库。

## 2026-07-18 删除历史容量治理与指定恢复

### 数据策略

1. `metadata_deletion_trash.jsonl` 默认最多保留 50 条或 32 MiB，避免分类关系快照无限增长。
2. 保留顺序优先未恢复记录，再按删除时间从新到旧保留已恢复历史；即使最新单条记录超过容量限制，也至少保留该条，保证刚删除的内容仍可撤销。
3. 新删除记录插入、旧记录裁剪、分类/标签和关系删除继续由同一个 `runJsonLinesTransaction()` 提交，不会出现“对象已删但回收记录未保存”。
4. 已有真实回收文件不会在启动时自动裁剪；保留策略只在用户下一次删除分类或标签时生效，避免后台无提示修改历史。

### IPC 与界面

1. 新增 `listMetadataDeletions()`，按页返回轻量摘要：名称、类型、删除/恢复时间、关系数量、估算字节数和总容量；完整 assignment/reference/suggestion 快照不跨 IPC。总容量直接读取文件 stat，只序列化当前页记录计算逐条体积。
2. 新增 `restoreMetadataDeletion(id)`，可以恢复指定的分类或标签；恢复前继续检查同名冲突，恢复对象、关系、建议和回收状态在同一个事务中提交。
3. 原 `undoLastMetadataDeletion()` 保留，并改为调用同一指定恢复实现，避免两套恢复逻辑漂移。
4. Categories & Tags 顶部新增 `History`，支持 8 条一页浏览、容量显示和逐条 Restore。

### 验证

- NekoSearch 专项：69/69；新增未恢复优先、字节上限、指定分类/标签恢复和 50 条上限淘汰测试。
- TypeScript、Lint、Format：通过。
- IPC registration：4/4；preload contract：1/1。
- Electron UI smoke：通过，4671ms；已验证 History 入口、删除记录可见和 UI 指定恢复，无 panel crash 或 console error。

### 剩余边界

回收历史仍以包含完整关系快照的 JSONL 单行保存；单次超大分类删除仍可能产生大记录。后续关系迁移 SQLite 时，应将回收项和关系快照拆表或压缩，并补充导出与手动永久清理能力。

## 2026-07-18 素材 Shell 操作改为权威 ID

### 问题与修复

1. 旧版 NekoSearch 的 `openAsset(filePath)` 和 `revealAsset(filePath)` 允许 renderer 提交任意字符串路径；通用 guard 能拒绝协议和不存在路径，但不能证明路径属于资料库。
2. 新契约改为 `openAsset(assetId)` / `revealAsset(assetId)`。IPC 首先用 `positiveId()` 拒绝路径字符串、非整数和非正数。
3. `resolveAssetLibraryAssetPath()` 等待权威素材 store 加载，按 ID 查回路径；未知 ID 和 `missing=true` 记录直接拒绝，不调用 Electron shell。
4. 已归档素材仍保留在权威 store，因此 Removed 视图中的 Open/Folder 不受影响；实际文件后来被外部删除时，后续 `requireExists` 校验仍会拒绝。
5. Assets、分类详情、Sample Search、Similar Search 和 AI Suggestions 的 Grid 回调全部迁移为 asset ID，文件路径仅继续用于缩略图和显示。

### 验证

- NekoSearch 专项：70/70；新增归档素材 ID 可解析、missing/未知 ID 拒绝和路径字符串 guard 测试。
- TypeScript、Lint、Format：通过。
- IPC registration：4/4；preload contract：1/1。
- Electron UI smoke：通过，4513ms；6 个面板无 crash 或 console error。

### 剩余边界

本轮只收紧 NekoSearch 的 shell 执行边界；Image Search、Media Search、File Manager 和 Duplicate Finder 各自仍有独立路径型 IPC，其来源和操作语义不同，应分别做所有权审计，不能直接机械改成 NekoSearch asset ID。
