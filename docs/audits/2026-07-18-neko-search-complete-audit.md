# NekoSearch 完整多维审计

> 状态：当前  
> 更新日期：2026-07-18  
> 范围：NekoSearch 前端、IPC、服务、元数据、向量复用、反馈搜索、聚类、测试与真实本地数据  
> 当前进度：[2026-07-18 NekoSearch 当前优化进度](../current/2026-07-18-neko-search-optimization-progress.md)  
> 替代文档：[2026-07-15 NekoSearch 多维审计](2026-07-15-neko-search-multidimensional-audit.md)

## 快速入口

- [当前结论](#当前结论)
- [评分与完成度](#评分与完成度)
- [架构与数据流](#架构与数据流)
- [功能完整性](#功能完整性)
- [逻辑与问题清单](#逻辑与数据一致性)
- [性能与规模](#性能与规模)
- [安全审计](#安全审计)
- [复用与扩展性](#复用与扩展性)
- [优化路线](#优化路线)
- [验证记录](#验证记录)

## 目的与范围

本审计以 2026-07-18 当前代码和真实本地资料库为依据，从以下角度检查 NekoSearch：

1. 功能完整性与实际使用闭环。
2. 模块结构、职责边界和复用情况。
3. 分类、审核、搜索、聚类与持久化逻辑。
4. 十八万素材规模下的性能、内存和磁盘效率。
5. Electron、IPC、本地文件与依赖安全。
6. 数据一致性、失败恢复、备份与可撤销能力。
7. 搜索准确率工程、测试覆盖和发布门槛。
8. 死代码、兼容接口和后续扩展成本。

本轮没有在真实资料库上执行会改写全量建议、聚类或分类关系的长任务，也没有删除或移动任何原始素材。结论来自代码审计、只读数据统计、合成目录基准和隔离 UI 冒烟测试。

## 当前结论

NekoSearch 已经形成可用的素材管理主链路：

```text
Image Search 索引
  -> NekoSearch 素材同步
  -> 分类 / 标签 / 外部参考图
  -> DINO / CLIP 建议与样本搜索
  -> Accept / Reject / Ignore / Undo
  -> 反馈模型重排
  -> 聚类与 Category Group
```

当前优势是复用充分、交互闭环基本成立、普通分页性能较好、原文件操作保守。2026-07-18 本轮已修复 JSONL 整体读取失败被当成空库、事务恢复失败仍提交内存和启动恢复失败仍继续初始化的问题；元数据快照现已具备自动/手动创建、列表、逐文件校验、选择恢复、恢复前保护快照和中断续做。

综合判断：**核心日常流程可用，工程健康度中等偏上；关系数据扩展、依赖安全和固定准确率验收仍是正式发布前的关键缺口。**

## 评分与完成度

评分是本次审计的工程估算，不等同于用户主观效果，也不与旧审计的分母直接等价。本次增加了真实数据丢失事件、生产依赖和故障恢复门槛，因此标准比早期审计更严格。

| 维度             |   评分 | 判断                                                                   |
| ---------------- | -----: | ---------------------------------------------------------------------- |
| 功能纵向闭环     | 85/100 | 分类、标签、参考图、建议审核、样本搜索、聚类和删除历史恢复可用         |
| 结构与职责边界   | 63/100 | 分层清楚，但服务和主面板过大，存在全局单例状态                         |
| 逻辑与数据一致性 | 94/100 | 关系 JSONL、主素材/状态/可选归档事务与备份恢复均 fail closed       |
| 性能与效率       | 73/100 | SQLite 普通分页良好，关系查询和长向量任务仍在主进程                    |
| 搜索与分类准确率 | 66/100 | 多原型和反馈重排已落地，缺少固定真实标注门禁与主体检索                 |
| 安全             | 85/100 | Electron 隔离、IPC guard、权威素材 ID 和数据写保护较完整，依赖仍有缺口 |
| 恢复与可撤销     | 94/100 | 已有软归档、有界删除历史、指定恢复、校验快照和选择备份恢复             |
| 复用             | 92/100 | 大量复用 Image Search、向量缓存、缩略图、虚拟网格和 IPC 基础设施       |
| 可扩展性         | 68/100 | 数据契约具有扩展位，但 JSONL 全量关系和单体服务限制规模                |
| 测试与文档       | 92/100 | 已覆盖素材坏行、三文件事务、删除历史和恢复篡改，缺磁盘满、真实准确率和 packaged 测试 |

**综合健康度：87/100。**

按不同口径估算：

- 当前核心日常工作流完成度：约 **87%**。
- 对照智能素材分类完整产品方案：约 **69%**。
- 面向无人值守大库运行的生产准备度：约 **87%**。

## 架构与数据流

### 当前分层

```text
AssetLibraryPanel / AssetLibraryAssetGrid / AssetLibrarySuggestionGrid
  -> window.electronAPI.assetLibrary
  -> preload + shared/ipc/asset-library
  -> assetLibraryIpc + assetLibraryGuards
  -> assetLibraryService
       -> AssetMetadataStore + AssetCatalogProjection
       -> JsonLinesStore + JsonLinesTransaction + AssetLibraryBackup/RestoreJournal
       -> AssetFeedbackModelService
       -> AssetClustering / semantic refinement
       -> Image Search manifest and DINO/CLIP embedding sources
```

### 代码规模

直接以 `asset*`、NekoSearch UI、IPC 和专项测试命名的 23 个核心文件合计约 **13,599 行、475.5 KiB**。其中：

| 文件                                    |  行数 | 主要职责                                   |
| --------------------------------------- | ----: | ------------------------------------------ |
| `electron/assetLibraryService.ts`       | 3,614 | CRUD、任务、搜索、建议、聚类和跨存储协调   |
| `src/components/AssetLibraryPanel.tsx`  | 2,874 | 三个工作区、备份管理、状态加载和渲染       |
| `tests/asset-library.test.cjs`          | 1,357 | 服务、事务、备份恢复、聚类和反馈专项测试   |
| `electron/assetMetadataStore.ts`        |   759 | 素材事实源、同步、归档和 SQLite 投影       |
| `electron/assetLibraryBackup.ts`        |   657 | 快照、校验、恢复 journal 与中断恢复        |
| `electron/assetFeedbackModelService.ts` |   528 | 审核反馈模型持久化与重建                   |

核心服务与主面板两处合计 6,488 行，占直接核心代码接近一半，是当前最明显的结构集中点。

### 权威数据与派生数据

| 数据             | 当前权威源                                           | 派生或缓存                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------- |
| 素材记录         | `assets.jsonl`、`state.json`                         | `asset-catalog.sqlite`                    |
| 分类、标签、关系 | 多个 `asset-*.jsonl`                                 | UI 统计与反馈模型                         |
| AI 建议          | `suggestions.jsonl`                                  | 列表筛选                                  |
| 聚类             | `cluster_groups.jsonl`、`cluster_group_assets.jsonl` | 聚类摘要                                  |
| 视觉向量         | Image Search 共享 DINO/CLIP JSONL                    | Float16 DINO 与 Float32 CLIP 随机访问缓存 |
| 反馈学习         | 已确认关系和 Reject 建议                             | 可重建的反馈模型                          |

`asset-catalog.sqlite` 当前只是素材目录投影，不是关系数据的权威数据库。损坏时可以从 `assets.jsonl` 重建，但分类、标签、建议和聚类仍依赖 JSONL。

## 功能完整性

### 已具备的主功能

1. 从 Image Search 索引同步素材，保持稳定素材 ID，并标记 missing/archived。
2. 创建、删除、恢复和重命名分类，支持父分类与颜色。
3. 创建标签，批量分类、批量打标签和按条件筛选。
4. 从本地文件或剪贴板导入独立参考图，不要求参考图已在素材库。
5. 使用 DINO 多参考图原型生成分类建议，保留置信度、来源和证据图。
6. 使用 CLIP 文本标签生成标签建议。
7. 对建议执行 Accept、Reject、Ignore、Undo Accept，并区分审核页面。
8. 使用已确认正样本和目标级负样本构建反馈模型，执行 Category 样本搜索。
9. 对搜索结果执行 Similar 搜索，并支持 Shift 连续区间选择和取消。
10. 执行自适应 DINO 聚类、CLIP 语义细分、人物语义组和 Category Group。
11. 将聚类组应用到正式分类，支持重命名、忽略和重算。
12. 软移除素材并撤销，不删除原始文件。
13. 在 NekoSearch 中立即创建、查看和校验元数据备份，并选择历史备份恢复；恢复前自动保存当前状态。

### 对照原始方案的缺口

| 方案能力                     | 当前状态 | 主要缺口                                                               |
| ---------------------------- | -------- | ---------------------------------------------------------------------- |
| P0 手动分类                  | 基本完成 | 缺分类树拖拽、图标/描述编辑、完整重挂父级、标签编辑 UI                 |
| P1 参考图分类                | 主要完成 | 缺参考图权重编辑、建议证据对比和批量改到其他分类                       |
| P2 重复/近重复分类           | 未集成   | hash 已存在，Duplicate Finder 可复用，但 NekoSearch 无重复组和处置闭环 |
| P3 聚类自动分组              | 部分完成 | 缺手动合并、拆分、成员纠错、稳定 lineage 和跨重算历史                  |
| P4 文本标签分类              | 主要完成 | 中文/多语言质量未形成固定样本验收                                      |
| 分类首页与详情               | 部分完成 | 缺最近分类记录、来源统计、标签分布和批量导出                           |
| OCR / filename / video_frame | 契约预留 | 当前没有对应生产管线；视频关键帧尚未并入统一素材库                     |

## 逻辑与数据一致性

### 已正确处理的逻辑

1. 手动确认和手动覆盖优先于 AI 建议，AI 不直接覆盖人工关系。
2. Reject 绑定具体 category/tag，不把某张图传播为全局负样本。
3. 同一路径向量使用最新追加记录，避免旧向量优先。
4. 外部参考图在使用前重新检查文件存在性、大小和修改时间。
5. 分类父子关系拒绝自引用和循环。
6. 长任务与普通写操作经过统一队列互斥，核心多 JSONL 写入使用 journal。
7. 同步在临时 Map 中构造结果，成功持久化后才替换活动状态。
8. 删除分类/标签使用双重确认和回收记录；素材移除采用软归档。
9. 取消任务清理临时缓存文件，搜索和聚类进度包含 ETA。

### P1 高优先级问题

#### NKS-P1-01 JSONL 读取失败会被当成空库（已修复）

- 严重度：高。
- 位置：`electron/vectorDatabaseService.ts:152-190`、`electron/vectorDatabaseService.ts:339`。
- 原缺陷：整体读取异常统一变成空缓存，后续写入可能覆盖原文件。
- 当前修复：只有 `ENOENT` 初始化空库；其他读取异常进入 unavailable。畸形行仍可只读查看并生成报告，但所有 insert/update/replaceAll/clear 和事务写入都会被拒绝。
- 验证：已有文件不可读时，读取、插入、全量替换和清空均 fail closed；原路径保持不变。

#### NKS-P1-02 事务恢复失败后内存仍可能提交（已修复主要缺陷）

- 严重度：高。
- 位置：`electron/jsonLinesTransaction.ts:215-242`、`electron/assetLibraryService.ts:211-229`。
- 当前修复：新 journal 使用 v2，保存每个 staged snapshot 的字节数和 SHA-256；所有 staged/target 先完整预检，替换后再次校验。恢复连续失败时回滚内存、锁定相关 stores 并保留 journal；启动恢复失败时服务保持 unavailable，不再继续创建空 stores。
- 兼容性：旧 v1 journal 仍可恢复，但没有历史 hash，恢复能力与旧格式一致。
- 剩余（已解决，2026-07-18）：真实 `EACCES/EIO/ENOSPC` 故障注入已由 `tests/transaction-fault-injection.test.cjs` 补齐（fs patch 注入 6 项 + 子进程强杀断电 5 项 + 真实只读权限 1 项 + 目录 fsync spy 1 项，共 13 项）；目录 fsync 策略已补齐到 `jsonLinesTransaction.ts`（同步 `syncDirectory`，journal 发布/stage 替换/journal 删除后各一次，失败吞掉不阻断，与 assetMetadataTransaction 同款 Windows 折中）。

#### NKS-P1-03 缺少全量、版本化、可验证的元数据备份（已修复主要缺口）

- 严重度：高。
- 位置：`electron/assetLibraryBackup.ts`、`electron/assetLibraryService.ts:457-480`。
- 当前修复：启动后延迟 30 秒，在任务/写队列互斥下刷新 metadata writes，并创建每日完整元数据快照；每份备份带逐文件 SHA-256、总字节校验和 manifest，默认保留最近 7 份。NekoSearch 顶部 `Backups` 可立即创建、列出、校验和选择恢复。恢复前强制生成 `pre_restore` 保护快照；恢复使用带 SHA-256 的 journal，进程中断后启动时续做，失败时服务保持 unavailable。`asset-catalog.sqlite` 是可重建派生数据，不进入快照并在恢复时清除重建。
- 存储位置：`%APPDATA%/floating-clock-electron/asset-library-backups/backup-*`。
- 剩余：尚未提供跨电脑便携导出/导入、备份删除和远端副本。~~目录级 fsync 与真实 `ENOSPC/EIO/EACCES` 故障注入~~（已解决 2026-07-18：restore journal 断电续做已有子进程强杀测试覆盖，目录 fsync 策略已补齐）。

#### NKS-P1-04 缺少固定人工标注准确率发布门禁（已完成）

- 严重度：高，发布质量阻断。
- 位置：反馈搜索、参考图建议和聚类测试体系。
- 现状：算法已有多原型、CLIP 召回、DINO 重排、负反馈和语义细分，但专项测试主要是合成向量和规则断言。
- 影响：无法客观回答新算法是否改善真实主体识别、中文文本、真人写真等类别，也无法防止回归。
- 进展（2026-07-18）：工具链已建成——`tests/neko-search-annotation.cjs`（固定标注集，候选池 = CLIP/DINO Top60 + 已审核 + 随机负样本，seeded/manual 标签分离）、`tests/neko-search-accuracy-benchmark.cjs`（CLIP/DINO/Hybrid/反馈 4 变体，Precision@K、Recall@K、nDCG@20、Reject intrusion@20、延迟 p95、聚类 purity 中位，`--write-baseline` / `--gate`）、`tests/neko-search-cluster-quality.test.cjs`（聚类确定性/纯度/稳定性合成回归，已入 `npm test`）。真实库只读 prepare 已跑通（563 候选、537 seeded）。用法与阈值见 `docs/benchmark/2026-07-18-neko-search-accuracy-gate.md`。
- 完成（2026-07-20）：标注工具链已兼容 sqlite 权威关系数据（`relationJsonlDir()` 导出后读取）；prepare/基准新增 `--category` 单分类过滤；test01（57 confirmed）候选池 147 张人工标注完成（122 manual），首个正式基线写入 `docs/benchmark/neko-search-accuracy-baseline.json`（hybrid：P@50=1.0、R@50=0.641、nDCG@20=1.0、Reject intrusion=0、聚类 purity 0.8016），`--gate` 可用于后续算法回归对照。边界：候选池含原型自身，P@K 接近满分属预期，基线价值在回归对照而非绝对精度；当前仅 test01 单分类，宏平均代表性有限，后续随新分类扩充。

#### NKS-P1-05 生产依赖存在 3 个高危审计告警（已解决）

- 严重度：高，实际可达性待验证。
- 证据：`npm.cmd audit --omit=dev --audit-level=high`。
- 依赖链：`@huggingface/transformers@4.2.0 -> onnxruntime-node@1.24.3 -> adm-zip@0.5.17`。
- 告警：特制 ZIP 可触发超大内存分配。npm 建议的强制修复会把 Transformers 降到 `3.8.1`，属于破坏性变化，不能直接应用。
- 解决（2026-07-18）：运行时可达性验证为零——`adm-zip` 仅被 `onnxruntime-node/script/install-utils.js`（postinstall 的 CUDA NuGet 下载路径）引用，运行时 `dist/` 无引用；`win32/x64` 默认安装 requirements 为空不触发下载；应用自身无 ZIP 解压代码；packaged 应用不执行 postinstall。已通过 `package.json` 的 `overrides` 将 `adm-zip` 固定到 `^0.6.0`（修复 CVE-2026-39244），`npm ls adm-zip` 确认为 `0.6.0`，`npm rebuild onnxruntime-node` 成功，审计归零。
- 剩余边界：`adm-zip@0.6.0` 的 `extractEntryTo` 改为保留子目录，仅影响 Linux x64 显式 `--onnxruntime-node-install=cuda12` 的 NuGet 解压路径；本项目使用 CPU 后端且 win32 默认安装不走该路径。

### P2 中优先级问题

#### NKS-P2-01 关系数据仍是主进程全量 JSONL（阶段 0-4 全部完成，sqlite 为默认权威）

- 位置：`electron/vectorDatabaseService.ts:131-179`、`electron/assetLibraryService.ts:968-1060`、`electron/assetLibraryService.ts:3334`。
- 进展（2026-07-19）：`asset-library.sqlite` 权威库已建成并打通全部阶段——阶段 0 骨架、阶段 1 dual 影子双写、阶段 2 读路径 SQL 化（分类过滤分页 p95 33.2ms、建议分页 p95 41.1ms 达标）、阶段 3 写路径 SQLite 权威化（`withSqliteWrite` 事务语义、upsert 批量、trash SQL 裁剪、备份 manifest v2 `VACUUM INTO`、v1 备份恢复自动重导入、子进程断电故障注入）。
- 阶段 4（2026-07-19 完成）：真实库 dual 验证通过（9 表计数+哈希与 JSONL 逐表一致，含真实写操作后复验）；默认 storageMode 切到 `'sqlite'`，`'dual'` 退役为非法值自动回退；删除 dual 影子机制（`shadowReloadRelationStores` 及 16 个调用点、`runRelationStoresTransaction` 包装、恢复后 dual 回写分支、无调用方的 `replaceAllRelations`）；`jsonl` 模式保留为应急逃生门（恢复备份或改回 `.jsonl.migrated` 后以 `FLOATING_CLOCK_ASSET_STORAGE_MODE=jsonl` 启动，已演练）。切换演练暴露并修复一个阶段 3 缺陷：dual 影子重灌不推进 `next_id` 序列，切换后首次写会 UNIQUE 失败（fail-closed 无损），修复为 init 时 `reconcileIdSequences()` 提升序列到 MAX(id)+1，附回归测试。270/270 测试通过；sqlite 模式基准：分类过滤分页 p95 45.8ms、建议分页 p95 33.5ms 达标，stats/clusters 未达项与阶段 2 相同（node:sqlite 逐行物化地板）。

#### NKS-P2-02 分类与标签建议复杂度随目标数线性放大（第一批已迁 worker）

- 位置：`electron/assetLibraryService.ts:1924`、`electron/assetLibraryService.ts:2078`。
- 现状：参考图分类近似为素材向量数乘分类原型数；文本标签近似为 CLIP 向量数乘标签数。
- 影响：分类或标签从个位数增长到数百后，任务时间和主进程占用显著增加。
- 进展（2026-07-20）：建议扫描（参考图/文本标签）、Similar Search 与聚类全管线（微桶路由、压缩 k-means、纯度 pass、残差 pass、CLIP 语义细分）的向量计算已迁出主进程——`assetTaskWorkerHost.ts`（worker_threads + SAB 取消 + 进度重放）、`assetSuggestionScanWorker.ts`、`assetSimilarSearchWorker.ts`、`assetClusteringWorker.ts`；写库仍全部在主进程（sqlite/mirror/ID 序列不变）；真实库对照 Similar 逐 hit 一致、建议两次生成逐行一致、聚类两次运行逐组一致（209 组/35,319 成员）。测试 10 项入链。
- 剩余：`startCategorySampleSearch`、`buildCategoryAssetCluster`、feedback 重建仍在主进程（①b 进行中，耦合 feedback 单例与主进程 CLIP 文本模型）；矩阵批处理、ANN/倒排候选和增量计算未实施，目标数增长到数百后的总量放大仍需 ANN 层解决。

#### NKS-P2-03 批量关系更新存在重复线性查找

- 位置：`electron/assetLibraryService.ts:1443`、`electron/assetLibraryService.ts:1592`。
- 现状：批量分类和打标签在数组中反复 `findIndex`。
- 影响：将大型聚类组转分类时可能退化为 `O(选择数 x 关系数)`。
- 建议：使用 `assetId:targetId` Map，或由 SQLite 唯一索引执行 upsert。

#### NKS-P2-04 核心服务和面板职责过度集中

- 位置：`electron/assetLibraryService.ts`、`src/components/AssetLibraryPanel.tsx`。
- 影响：修改聚类、审核或搜索时容易触及同一个大文件，测试隔离和多人协作成本高。
- 建议：服务拆为 catalog、taxonomy、review、search、cluster、task coordinator；前端拆为 Library、Review、Clusters 三个 feature container 和独立 hooks。

#### NKS-P2-05 非素材列表请求缺少过期响应保护（已解决）

- 位置：`src/components/AssetLibraryPanel.tsx:286-365`。
- 现状：`loadAssets()` 使用 request id 丢弃旧响应；suggestions、clusters、references 和 category assets 没有相同保护。
- 解决（2026-07-18）：`loadSuggestions`/`loadClusters`/`loadReferences`/`loadCategoryAssets` 全部接入独立 generation ref（`suggestionRequestId`/`clusterRequestId`/`referenceRequestId`/`categoryAssetRequestId`），与 `loadAssets` 同模式丢弃过期响应与过期错误/加载状态。

#### NKS-P2-06 搜索结果缓存只保存在进程内单例（已解决）

- 位置：`electron/assetLibraryService.ts:146-147`、`electron/assetLibraryService.ts:818-965`。
- 原现状：Category Sample Search 和 Similar Search 只保留最后一次结果，重启即失效，新搜索会覆盖旧搜索。
- 解决（2026-07-22）：Category Sample Search 与 Similar Search 结果新增 task/result ID，每类保留最近 10 份有界会话历史；IPC 支持精确身份查询，Renderer 使用当前 task ID 与独立 generation 丢弃旧任务事件和迟到响应。
- 边界：完整 hit 快照不跨重启持久化，避免恢复已删除、归档或重评分后的陈旧素材；如将来要求跨重启恢复，只持久化查询与摘要并重新验证素材状态。

#### NKS-P2-07 主素材、状态和归档 overlay 跨文件原子性（已解决）

- 位置：`electron/assetMetadataTransaction.ts`、`electron/assetMetadataStore.ts` 的 `persistSnapshot()`、`electron/assetLibraryService.ts` 的启动预检。
- 修复：保存时先生成并 fsync `assets` 和 `state` 两个必需 stage；重新导入已归档参考图时再加入 `archived-assets.json` stage。写入过程同步累计 SHA-256，随后发布包含两个或三个目标字节数和哈希的专用 journal；目标全部替换并复核后才删除 journal。
- 恢复：任一 target 已替换而其他 stage 尚存时，下次启动会在创建 stores、调度 Search Learning 和自动备份之前同步预检；每个目标可从剩余 stage 或已替换 target 恢复，整组校验通过后才解除 journal。
- 安全：journal 只接受固定的 `assets.jsonl`、`state.json` 和可选 `archived-assets.json`，前两个必须各出现一次；stage 必须是同目录本地普通文件。路径逃逸、重复目标、缺失文件、符号链接和 SHA-256 不匹配都会使服务 fail closed。
- 普通归档：单纯移除/恢复素材仍只原子写入并 fsync 小型 archive overlay，不重写约 70MB 主素材库；启动时会清理中断遗留的 `archived-assets.json.tmp`。
- 性能：18 万条合成素材构建 2276.90ms，SQLite 50.73MiB，普通更新页中位 2.81ms。普通主素材同步不创建第三个 stage，归档事务只在重新导入已归档参考图时启用。
- 验证：新增三文件部分替换恢复、归档 stage 篡改拒绝和重新导入跨重启一致性测试；真实用户资料库未执行写入。

#### NKS-P2-08 删除回收文件缺少保留上限和浏览恢复（已解决）

- 位置：`electron/assetMetadataDeletionHistory.ts`、`electron/assetLibraryService.ts`、`AssetLibraryPanel.tsx` 的 Categories & Tags / History。
- 修复：新增 50 条/32 MiB 双上限；未恢复记录优先于已恢复历史，单个最新超大记录至少保留一条。裁剪与分类/标签删除在同一 JSONL 校验事务中提交。
- 浏览：新增轻量分页摘要 IPC，只返回名称、类型、删除/恢复时间、关系数量和估算体积，不把大型关系快照传给 Renderer；可选择任意未恢复记录恢复，原“Undo last”继续兼容。
- UI：Categories & Tags 的 `History` 显示总记录和容量占用、逐条体积、状态及 Restore 操作。
- 安全边界：真实已有回收文件不会在启动时静默裁剪；仅在后续发生新删除时应用保留策略。恢复仍检查同名分类/标签冲突并使用跨 store 事务。
- 剩余边界：暂未提供回收历史导出、手动永久清理和大型单条快照压缩；长期应随关系数据一并迁入 SQLite。

#### NKS-P2-09 shell 打开路径未验证素材归属（已解决）

- 位置：`electron/assetLibraryIpc.ts`、`electron/assetLibraryService.ts` 的 `resolveAssetLibraryAssetPath()`、Asset Grid/Suggestion Grid 和 preload 契约。
- 修复：NekoSearch 的 `Open/Folder` IPC 不再接收 renderer 路径，只接收正整数 asset ID；主进程从权威 `AssetMetadataStore` 查回路径后再执行通用存在性与协议校验。
- 覆盖：Assets、分类详情、Sample Search、Similar Search 和 AI Suggestions 全部迁移为 ID 调用，归档素材仍可打开。
- 拒绝：未知 ID、字符串路径、非法数字和已标记 missing 的素材会在调用 shell 前失败。
- 验证：新增活动/归档/缺失/未知 ID 测试；IPC registration、preload contract、TypeScript 和 UI 构建均通过。

#### NKS-P2-10 主体识别和中文语义仍受基础模型限制

- 现状：原始 CLIP 文本对中文和细粒度主体不稳定；DINO 相似度容易受背景、构图和姿态影响。当前反馈重排改善结果，但没有目标检测或主体 crop。
- 建议：先完成固定样本验收，再评估多语言 CLIP/SigLIP、OCR 辅助和主体检测/crop；不能继续只调阈值。

### P3 低优先级与维护项

1. ~~`updateTag` 已有 IPC/preload 契约，但当前 UI 没有调用入口。~~（已解决 2026-07-18：标签 chip 内联编辑已接线 `assetLibrary:updateTag`。）
2. ~~`AssetLibrarySyncRequest` 是未使用契约；`streaming_centroid` 主要用于旧聚类兼容。~~（已解决 2026-07-18：未使用契约已删除；`streaming_centroid` 在类型定义中标注为旧 store 兼容保留。）
3. `duplicate`、`filename`、`ocr`、`video_frame` 已列入 source 枚举，但没有 NekoSearch 生产器。
4. 参考图即时 embedding 固定调用 CPU 后端，少量参考图可接受，但与 GPU 配置语义不一致。
5. ~~`selectionRange.ts` 专项测试出现 `MODULE_TYPELESS_PACKAGE_JSON` 警告，属于测试加载方式问题，不影响产品运行。~~（已解决 2026-07-18：改用 `loadTsModule` 加载，警告消除。）
6. 没有发现 NekoSearch 路径中的 `dangerouslySetInnerHTML`、`eval` 或 `webview` 使用；预留契约不应直接删除，应先标记 compatibility 或 planned。

## 性能与规模

### 当前真实数据

2026-07-18 对 `%APPDATA%/floating-clock-electron/asset-library` 只读统计：

| 文件                                     |           体积 |     记录数 |
| ---------------------------------------- | -------------: | ---------: |
| `asset-catalog.sqlite`                   |    118.402 MiB | 派生数据库 |
| `assets.jsonl`                           |     70.236 MiB |    187,370 |
| `cluster_group_assets.jsonl`             |      4.189 MiB |     40,570 |
| `metadata_deletion_trash.jsonl`          |      0.599 MiB |          4 |
| `asset_categories.jsonl`                 |      0.096 MiB |        537 |
| `cluster_groups.jsonl`                   |      0.057 MiB |        217 |
| `category_references.jsonl`              |      0.001 MiB |          7 |
| `categories.jsonl`                       | 小于 0.001 MiB |          2 |
| `suggestions.jsonl` / `asset_tags.jsonl` |              0 |          0 |

NekoSearch 自有目录合计 **193.58 MiB**。共享 `vector-db` 递归合计 **7.72 GiB**，主要是：

- DINO JSONL：约 3,900 MiB。
- CLIP JSONL：约 2,628.6 MiB。
- CLIP Float32 cache：约 481.5 MiB。
- DINO Float16 cache：约 334.9 MiB。

这些向量由 Image Search 与 NekoSearch 共同使用，不能全部算作 NekoSearch 独占体积。

### 目录基准

`npm.cmd run benchmark:asset-catalog` 的 180,000 条合成数据结果：

| 指标                   |       结果 |
| ---------------------- | ---------: |
| 初次构建               | 2,312.21ms |
| SQLite 体积            |  50.73 MiB |
| 最近更新页，中位       |     2.71ms |
| 深 offset 名称页，中位 |     9.44ms |
| 路径子串查询，中位     |    30.77ms |

普通素材分页已经达到可用水平。当前主要性能风险不是 Assets 首屏，而是关系数据增长、建议全量排序、聚类摘要扫描和多目标向量计算。

### 关系查询基准（SQLite 迁移阶段 2 后，2026-07-19）

`npm.cmd run benchmark:asset-relation`（187k 素材 + 100k 分类关系 + 50k 建议 + 100k 聚类成员合成数据，读路径 SQL 化后，20 次迭代）：

| 指标 | 中位 | p95 | 目标 | 结果 |
| --- | ---: | ---: | --- | --- |
| 分类过滤分页 | 23.2ms | 33.2ms | <300ms | 达标 |
| 建议分页 | 29.9ms | 41.1ms | <50ms | 达标 |
| 资料库统计 | 109.9ms | 116.6ms | <100ms | 边界未达 |
| 聚类列表 | 122.7ms | 132.8ms | <50ms | 未达 |

stats/clusters 的地板是 `node:sqlite` 逐行物化（约 0.6µs/行），后续可通过覆盖索引或物化聚合计数压缩；关系分页主路径（NKS-P2-01 的核心诉求）已达标。

### 已落地的性能措施

1. NekoSearch 面板延迟挂载，Assets 使用虚拟网格和分页。
2. 普通素材列表由 SQLite 投影查询，不再每次全量排序 Map。
3. DINO 使用 Float16 随机访问缓存；CLIP 使用 Float32 路径映射缓存。
4. 大向量 JSONL 使用分块流和有界 TopK 堆。
5. 聚类使用压缩路由、多中心和语义细分，而不是完整两两相似度矩阵。
6. 长任务主动让出事件循环并提供进度、速度和 ETA。

## 安全审计

### 已具备的防护

1. `BrowserWindow` 启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
2. 新窗口打开被拒绝，跨页面导航受限。
3. Renderer 只通过 preload 暴露的类型化 IPC 调用主进程。
4. NekoSearch guard 限制文本长度、ID 数量、分页上限和 scope path 数量。
5. Image Search 索引读取限制记录数、路径区、文件大小和目录逃逸。
6. 外部参考图使用随机文件名；失败导入会清理临时文件。
7. 移除素材不会删除原文件，降低误操作的破坏面。

### 安全剩余风险

1. `NKS-P1-05` 已解决：`adm-zip` 运行时可达性验证为零，已通过 `overrides` 升级到 `0.6.0`，生产依赖审计归零。
2. JSONL 只验证顶层是对象，没有逐字段 schema、单行长度和总记录数上限；被本地损坏文件可造成内存或逻辑异常。
3. 数据完整性风险已由 fail-closed store、事务 journal 和可恢复备份显著降低；当前主要剩余风险是主素材 store schema 不统一和真实磁盘故障未注入。

## 复用与扩展性

### 复用评价

复用是当前实现最强的部分：

1. 素材事实源直接复用 Image Search manifest，不重复扫描图片库。
2. DINO/CLIP embedding 和缓存与 Image Search 共用，避免重复模型推理和数 GB 数据。
3. 参考图和查询图复用现有 ONNX 推理、模型注册和 GPU/CPU 后端。
4. 缩略图复用 `ThumbnailImage`，大列表复用 `useVirtualGrid`。
5. 面板复用 `DraggablePanel`、全局设置、位置恢复和显隐系统。
6. IPC 复用共享契约、preload 和注册完整性测试。
7. SQLite catalog、JSONL store、事务和路径 guard 均为可复用基础模块。
8. 反馈模型是派生层，可从人工关系和 Reject 记录重建，不污染基础向量。

### 扩展性限制

1. `assetLibraryService` 使用全局 `baseDir`、store、active task 和 last result，天然只支持单资料库单实例。
2. 多数关系没有 schema version 和 migration；类型扩展依赖“旧记录缺字段时兼容”。
3. 聚类重算会替换生成组，缺少稳定 lineage，未来同步云端或多设备时难以追踪。
4. category/tag 数量增长会直接放大向量计算，没有 ANN 或增量调度层。
5. OCR、视频帧、重复组虽有契约位置，但缺统一 `AssetProvider`/`SuggestionProducer` 插件边界。

推荐的长期边界：

```text
AssetProvider -> CatalogRepository
EmbeddingProvider -> VectorRepository
SuggestionProducer -> ReviewRepository
ClusterStrategy -> ClusterRepository
TaskCoordinator -> Worker/Utility Process
```

这样新增 OCR、视频帧、重复检测或新模型时，不需要继续扩大 `assetLibraryService.ts`。

## 测试质量

### 当前覆盖

专项测试已覆盖：

1. 素材同步、外部参考图、归档恢复和路径失效。
2. 分类阈值、多参考图、建议审核与撤销身份。
3. 正负反馈、多中心模型、CLIP cache 和 DINO Float16 cache。
4. 聚类压缩、纯度、语义标签、人物证据和 Category Group guard。
5. JSONL 正常事务、action 回滚、部分替换恢复和目录逃逸。
6. IPC guard、preload/main channel 对齐和 UI 主流程冒烟。

### 缺少的测试

1. `EACCES`、`EIO` 和真实磁盘满故障注入；rename 失败与锁写已经覆盖。
2. 真实 `ENOSPC/EIO/EACCES`、目录 fsync 和恢复时断电的系统级故障注入。
3. 十万级 category/tag/suggestion/cluster relation 的刷新与内存压力测试。
4. 固定人工标注的真实图片、中文文本、主体检索和聚类质量回归。
5. packaged Electron、NSIS 安装后运行和干净 Windows VM 测试。
6. GPU 模型长时间运行、中途退出和系统休眠恢复测试。

## 已完成修复与有效设计

本审计不重复把已解决问题列为待办。当前已经确认有效的整改包括：

1. 同步取消不再替换活动 Map，临时文件会清理。
2. 普通写操作串行化，长任务与写操作互斥。
3. 核心关系操作增加 JSONL journal 事务和启动恢复。
4. 素材目录增加 SQLite 投影，普通分页和排序下推数据库。
5. 参考图从单中心升级为独立多原型并记录真实证据。
6. 审核学习默认显式控制，Reject 为目标级负样本。
7. DINO/CLIP 使用缓存、分块流和有界候选，降低 OOM 风险。
8. 聚类增加多中心、精确纯度、语义细分、人物证据和 Category Group。
9. Assets、Review、Clusters 导航合并简化，并支持 Similar 与 Shift 区间选择。
10. 删除分类/标签可回收，素材可软移除和撤销。
11. JSONL 整体读取错误和畸形行已 fail closed，不再允许覆盖式写入。
12. journal v2 增加 staged/target SHA-256 校验，失败时回滚内存并锁写。
13. 自动元数据快照按日生成、校验并保留最近 7 份，不复制可重建 SQLite catalog。
14. 备份管理 UI 支持立即备份、列表、校验和二次确认恢复；恢复前创建保护快照并用独立 journal 中断续做。
15. 主素材 `assets.jsonl`、`state.json` 和归档 overlay 已统一 fail closed；合法坏行场景可读但不可写，核心状态损坏直接停机，写失败不提交活动内存状态。
16. `assets.jsonl` 与 `state.json` 已纳入带 SHA-256 的专用双文件 journal；启动可续做部分替换，篡改、路径逃逸和缺失 stage 均锁定服务。

## 优化路线

### 阶段 A：数据安全，发布前优先

1. 已完成：修复 `JsonLinesStore.load()` fail-open，只允许 `ENOENT` 初始化空库。
2. 已完成：事务恢复失败时锁定资料库，不提交内存，不继续普通初始化。
3. 已完成（2026-07-18）：关系 store、主素材 store、归档 rename 失败、损坏内容之外，真实 ENOSPC/EIO/EACCES fs patch 注入、子进程断电强杀和只读权限注入已由 `tests/transaction-fault-injection.test.cjs` 补齐（13 项）。
4. 已完成主要闭环：自动/手动快照、保留策略、列表、校验、选择恢复、恢复前保护快照和中断恢复；仍需便携导出/导入。
5. 已完成：主素材 `assets.jsonl + state.json` 使用专用 journal、启动恢复和 staged/target 完整性校验。
6. 已完成：`adm-zip` 依赖告警经 `overrides` 升级到 `0.6.0` 修复，onnxruntime 加载和全量测试验证通过。

验收标准：任意单文件和多文件写入故障不得把现有关系变为空；恢复前后记录数与哈希一致；备份可在空目录恢复完整资料库。

### 阶段 B：关系数据库与主进程减负

> 状态更新（2026-07-22）：以下 1-5 项均已完成；ANN/倒排属于后续独立规模化路线，不是本阶段验收缺口。

1. 将 category/tag assignment、suggestion、cluster/member 和 references 迁入 SQLite。
2. 增加 schema version、migration 和复合唯一索引。
3. 将建议、反馈重建和聚类移入 worker/utility process。
4. 批量 upsert 改为 Map/SQL，非 Assets 请求增加过期响应保护。
5. 为搜索结果引入 task/result ID，避免全局最后结果互相覆盖。

验收标准：18 万素材、10 万关系和 10 万建议时，打开面板和普通筛选 p95 小于 300ms，Renderer 不出现长任务；取消后内存和磁盘状态一致。

### 阶段 C：准确率工程

1. 工具链已建（2026-07-18）：固定标注集工具、4 变体基准和 `--gate` 门禁已就绪；剩余为人工标注执行——建立包含主体、真人写真、截图、产品、背景干扰和中文文本的标注集（当前真实库仅 1 个可评估分类，其余方向随分类建设纳入）。
2. 保存 baseline，并比较 CLIP、DINO、Hybrid、反馈重排和聚类版本（基准脚本已支持 `--write-baseline`，待标注完成后记录）。
3. 只有 Recall@K、Precision@K 和 Reject intrusion 达标后才改变默认算法。
4. 基于实测评估主体 crop、目标检测、多语言 CLIP/SigLIP 和 OCR，而不是继续经验调阈值。

建议门槛：核心分类 Recall@50 不低于基线且提升至少 5 个百分点；Reject intrusion 不高于 5%；聚类人工 purity 中位不低于 0.80；搜索 p95 不超过既有基线 1.5 倍。

### 阶段 D：产品完整性

1. 集成重复/近重复组和 Duplicate Finder 处置能力。
2. 增加聚类合并、拆分、成员纠错和稳定 lineage。
3. 补齐参考图权重、标签编辑、分类树拖拽、批量改分类和证据对比。
4. 增加历史恢复、导出报告和分类来源统计。
5. 最后再统一 OCR 和 Media Search 视频关键帧，不提前扩大数据模型。

## 验证记录

| 项目                | 命令                                          | 结果                                      |
| ------------------- | --------------------------------------------- | ----------------------------------------- |
| TypeScript          | `npm.cmd run typecheck`                       | 通过                                      |
| Lint                | `npm.cmd run lint`                            | 通过                                      |
| NekoSearch 专项测试 | `npm.cmd run test:asset-library`              | 70/70 通过，1 个 ESM 测试警告             |
| Vector Pipeline     | `npm.cmd run test:vector-pipeline`            | 17/17 通过                                |
| IPC 注册            | `npm.cmd run test:ipc-registration`           | 4/4 通过                                  |
| Preload 契约        | `npm.cmd run test:preload-contract`           | 1/1 通过                                  |
| UI 冒烟             | `npm.cmd run smoke:ui`                        | 通过；4513ms，无 panel crash/console error |
| Asset Catalog 基准  | `npm.cmd run benchmark:asset-catalog`         | 通过；180k 构建 2.28s，普通页 2.81ms 中位 |
| 生产依赖安全        | `npm.cmd audit --omit=dev --audit-level=high` | 通过；0 个 high（2026-07-18 adm-zip override 后） |

UI 冒烟在 2560x1392 视口验证了分类创建、删除、History 记录显示、指定恢复、合并导航、Similar 入口、Category Group 入口、标签创建、Sample Search 和返回 Assets。隔离资料库为空，因此 Shift 区间选择只由专项单元测试覆盖，未在该次 UI 冒烟中产生真实选择结果。

## 审计边界与剩余风险

1. 本轮没有对真实 18 万素材执行全量建议或聚类重算，不能由代码审计推导实际准确率。
2. 本轮只在临时目录模拟不可读 store、素材坏行、损坏 state/archive、双/三文件部分替换、内容篡改和 rename 失败，没有破坏真实 JSONL，也没有模拟真实磁盘满。
3. 真实资料库只读格式检查通过：187,370 条素材、0 个坏行、`nextId=187371`、11 条归档记录；该检查不写入用户元数据。
4. `npm audit` 依赖链告警已于 2026-07-18 解决：运行时可达性验证为零，`adm-zip` 经 `overrides` 升级到 `0.6.0`，审计归零。
5. 合成 SQLite 基准证明目录查询能力，不代表复杂关系查询和模型任务性能。
6. 本地原始图片未被删除、移动或改写。

## 下一步建议

SQLite 迁移阶段 4 已完成（2026-07-19：sqlite 默认权威、dual 退役、jsonl 逃生门保留）。下一轮应完成人工标注并记录首个正式准确率基线；同时推进长任务 worker 迁移（NKS-P2-02）与 stats/clusters 聚合计数的覆盖索引或物化优化。在准确率基线建立前，不宜继续通过经验阈值宣称分类精度提升。
