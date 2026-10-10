# 项目审计整改进度

> 状态：当前
> 更新日期：2026-08-02
> 执行系统：Codex

## 触发来源

本轮最初依据 `docs/audits/2026-07-27-project-scale-completeness-audit.md` 开始整改。该审计原文已在确认所有权后通过独立提交纳入 Git。

2026-07-28 又完成了[全项目综合审计](../audits/2026-07-28-full-project-audit.md)。下列前三十五批结构整改记录仍然有效；发布门禁、磁盘、依赖、准确率和国际化的当前判断以 2026-07-28 综合审计为准。

2026-08-02 完成新的[全项目多维审计](../audits/2026-08-02-full-project-multidimensional-audit.md)。2026-07-28 审计保留为历史快照；当前验证、真实数据健康、性能和发布判断以 2026-08-02 审计为准。

## 2026-08-02 全项目多维复核：当前整改基线

本次只读复核确认此前大部分结构、安全、依赖和 UI 门禁整改仍然有效，但新增发现以下优先级：

1. P1：Model Platform 迁移后，Face Match、Person ReID、SAM 三组集成测试仍用旧 `models/` 路径判断模型存在，导致完整 `npm test` 失败；先修测试 fixture，不改运行时降级行为。（**已关闭**，见第一百零八批，2026-08-03）
2. P1：关键覆盖率测试 77/77 通过，但 `assetMetadataTransaction.ts` 行覆盖率 83.13% 低于 84% 基线，`coverage:critical` 失败。（**已关闭**，见第一百零八批，2026-08-03：行覆盖率恢复至 93.89%）
3. P1：真实两个向量 shard 共约 12.58 GiB；Vector GC 识别约 5.48 GiB stale/duplicate/malformed 可回收数据，其中 DINO 有 3 条 malformed。任何执行必须保留 active-set 指纹和 GC 恢复备份。（**已执行**，见第一百一十批：压实后 active 数不变、stale/duplicate/malformed 归零；旧 shard 备份保留 7 天）
4. P1：`embedding_jobs.jsonl` 约 97 MB、235,635 行全部为 `pending`；一次全量解析实测约 424 ms、RSS 增量约 341 MiB。需要 epoch/owner/heartbeat 和只读迁移预览，禁止直接清空。（**已执行迁移**，见第一百一十一批：168,886 行归档、66,749 行保留、原文件备份；根治 epoch 账本属阶段 D）
5. P1：Image Search manifest 只引用约 44 MiB 的 3 个 segment，另有约 458 MiB 未引用 segment/staging。需要 manifest-aware、任务空闲和保护窗口约束的孤儿回收。（**已执行**，见第一百一十批：39 个孤儿文件 453.5 MiB 已回收，引用 segment 未动）
6. P1：Storage Inventory 对 Vector GC 固定报告 0 可回收、Media Search 子目录统计为 0、Image Search 不区分孤儿文件，导致维护 UI 低估真实占用。（**已关闭**，见第一百零九批，2026-08-03）
7. P1 发布阻断：项目许可证、最终 EULA、组件批准、签名、ACC-03 和正式 release record 仍未完成；工程准备不能替代授权负责人结论。
8. P2：收紧 Renderer WebSocket CSP、主 session permission deny 和 IPC origin；按 profiling 迁移主进程同步 I/O 热点，并继续按状态所有权拆分大文件。

当前推荐顺序为：恢复模型测试与覆盖率门禁 → 修正只读库存口径 → 生成 jobs/索引/向量清理预览 → 分批确认回收 → 权威二进制向量代际切换 → 发布合规闭环。完整证据、功能影响和回退边界见新审计。

## 第一批：死代码与残留清理

代码引用检查确认以下文件没有任何生产代码或测试引用：

- `electron/localFeatureService.ts`：ORB/SIFT 占位实现，所有入口仅返回空值或零。
- `electron/objectCropService.ts`：未接线的中心裁剪和对象检测占位实现。
- `electron/ocrService.ts`：OCR 占位实现，所有入口仅返回空值或零。
- `native/stb_image_resize.h`：14 字节残留文件；Native 实际使用 `stb_image_resize2.h`。

上述四个文件已删除；`docs/reference/native-build-artifacts.md` 已同步移除过期源码清单项。历史与设计文档保留原始记录，不改写为当前事实。

## 验证

| 命令                          | 结果                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run typecheck`       | 通过，0 错误                                                                                                                                  |
| `npm.cmd run lint`            | 通过，0 错误；保留基线已有的 5 个未使用变量警告                                                                                               |
| `npm.cmd run format:check`    | 通过                                                                                                                                          |
| `npm.cmd run git:hooks:check` | 通过                                                                                                                                          |
| `npm.cmd test`                | 28 个子套件全链通过；干净 worktree 不包含 Git 忽略的 AI 模型，因此 face、ReID、SAM、DINO 的 4 个模型条件套件跳过；Native 重新构建并通过 35/35 |
| `npm.cmd run build:renderer`  | 通过；renderer、主进程、preload 和 8 个 worker 均成功构建                                                                                     |

主工作区在整改前已验证模型实物在位，对应 face、ReID、SAM、DINO 套件均通过。本轮条件跳过来自 worktree 的资源隔离，不是代码回归。

## 第二批：聚类继承纯逻辑拆分

从 `electron/assetLibraryService.ts` 抽离纯函数 `computeClusterInheritance` 及其结果类型到 `electron/assetClusterInheritance.ts`：

- 主服务继续重新导出原有函数和类型，保留外部兼容性。
- 服务内部改为导入独立领域模块，运行行为不变。
- `tests/cluster-inheritance.test.cjs` 直接加载新模块，不再为 6 项纯函数测试解析整个素材库服务。

专项验证：typecheck、相关文件 ESLint/Prettier、聚类继承/手工操作/质量测试 15/15 通过。

## 第三批：存储配置解析拆分

从 `electron/assetLibraryService.ts` 抽离存储配置职责到 `electron/assetLibraryStorageConfig.ts`：

- 集中维护 JSONL/SQLite 模式类型、option > environment > settings > default 的优先级和无效值安全回退。
- 集中维护参考图即时 embedding 的 CPU/GPU 设置解析。
- 主服务继续重新导出原有 `resolveAssetReferenceEmbeddingBackend`，保持现有调用兼容。
- 新增直接配置优先级测试，并保留 JSONL/SQLite 集成路径覆盖。

专项验证：typecheck、相关文件 ESLint/Prettier、存储配置与 SQLite 模式测试 11/11 通过。

## 第四批：素材列表请求规范化拆分

从 `electron/assetLibraryService.ts` 抽离 JSONL/SQLite 共用的列表请求规范化逻辑到 `electron/assetLibraryListRequest.ts`：

- 集中维护 offset/limit 默认值、整数化和 200 条上限。
- 集中维护排序白名单以及 query/category/tag/未分类/归档筛选字段。
- 两条查询实现改为共享显式的 `NormalizedAssetLibraryListRequest` 契约。
- 新增 3 项直接单测，并将其纳入 `test:asset-library` 总链。

专项验证：typecheck、相关文件 ESLint/Prettier、请求规范化与 SQL/JSONL 查询一致性测试 4/4、素材库测试 98/98、SQLite 测试 19/19 通过。

## 第五批：聚类工具拆分

从 `electron/assetLibraryService.ts` 抽离四个无状态聚类辅助函数到 `electron/assetClusterUtilities.ts`：

- 聚类作用域路径清理、绝对化和去重。
- 素材路径是否属于作用域的安全判断，避免字符串前缀误匹配。
- 手工聚类成员数量与平均相似度统计。
- 稳定 lineage key 的保留与回退。

新增 4 项直接边界测试并纳入 `test:neko-search-cluster`。专项验证：typecheck、相关文件 ESLint/Prettier、聚类测试 19/19 通过。

## 第六批：反馈样本筛选拆分

从 `electron/assetLibraryService.ts` 抽离素材反馈模型的纯样本筛选逻辑到 `electron/assetFeedbackSampling.ts`：

- 统一反馈素材路径的分隔符、大小写和尾部分隔符，保证跨来源去重。
- 使用稳定路径哈希为同权重样本提供确定性优先级。
- 在固定容量内保留高权重样本，并允许同路径的更高权重记录替换旧记录。
- 集中维护手工、聚类及其他分配来源的反馈权重策略。

新增 5 项直接边界测试并纳入 `test:asset-library`，覆盖路径规范化、哈希稳定性、去重替换、容量淘汰和来源权重。专项验证：typecheck、全量 ESLint/Prettier、素材库测试 103/103、renderer/主进程/preload/worker 生产构建通过。

## 第七批：素材库任务控制器拆分

从 `electron/assetLibraryService.ts` 抽离任务生命周期与写入串行化状态到 `electron/assetLibraryTaskController.ts`：

- 独立维护任务启动、完成、失败、停止和进度快照。
- 集中计算平滑处理速率与剩余时间。
- 串行执行素材库 mutation，并阻止后台任务与未完成写入相互穿插。
- 通过取消回调保持 worker 停止信号与任务状态同步。

新增任务百分比、并发拒绝、停止传播和 mutation 串行化测试，并纳入 `test:asset-library`。

## 第八批：反馈源快照构建拆分

从 `electron/assetLibraryService.ts` 抽离反馈源的领域聚合到 `electron/assetFeedbackSnapshot.ts`：

- 按分类和标签建立反馈目标。
- 合并正式人工分配、参考图和拒绝建议，生成正负样本。
- 过滤归档、缺失及未确认素材。
- 对样本容量和权重策略使用已拆出的统一实现。

服务层只负责从 JSONL/SQLite 获取关系数据与素材查找函数；新增反馈目标聚合和容量边界测试并纳入 `test:asset-library`。

## 第九批：素材列表读取查询拆分

从 `electron/assetLibraryService.ts` 抽离 JSONL 与 SQLite 两条素材列表查询实现到 `electron/assetLibraryReadQueries.ts`：

- JSONL 路径负责正式分类/标签关系索引、关系筛选与页面关系装配。
- SQLite 路径负责按查询条件建立关系谓词，并仅为当前页面加载关系。
- 两条路径共享结果装配与关系追加逻辑。
- 服务层只规范化请求并选择可用读取后端。

现有请求规范化、JSONL 集成和 SQLite 一致性测试继续固定查询行为。

## 第十批：素材库统计查询拆分

从 `electron/assetLibraryService.ts` 抽离完整统计查询到 `electron/assetLibraryStatsQuery.ts`：

- 统一正常、只读和主素材存储不可用时的统计响应。
- SQLite 路径继续使用标量聚合，避免在主进程物化大规模关系 ID。
- JSONL 路径集中处理正式分类去重、活动素材过滤、建议状态、有效聚类和参考图计数。
- 服务层只提供关系快照、素材活动判断和带故障回退的 SQL 读取回调。

新增关系去重及非活动素材过滤测试，并纳入 `test:asset-library`。

## 第十一批：素材库存储上下文拆分

从 `electron/assetLibraryService.ts` 抽离存储生命周期与后端选择到 `electron/assetLibraryStorageContext.ts`：

- 集中维护素材库存储目录、全部 JSONL/素材 store、初始化错误和 SQLite 数据库句柄。
- 集中执行备份恢复、素材元数据事务恢复与 JSONL 事务恢复，任一恢复失败时继续保持故障关闭。
- 统一 SQLite 导入、ID 序列校准、关系 JSONL 迁移和内存镜像装载。
- 统一 SQL 读取故障回退、SQLite 权威写事务与写失败后的关闭状态。
- 主服务只保留业务计时器、反馈模型接线、备份调度和恢复流程编排。

拆分后主服务由约 4,949 行降至 4,421 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十二批：分类与标签目录拆分

从 `electron/assetLibraryService.ts` 抽离分类与标签的目录职责到 `electron/assetLibraryTaxonomyCatalog.ts`：

- 集中分类字段规范化、默认值和参考阈值解析。
- 集中分类/标签列表排序以及 JSONL/SQLite 读取选择。
- 集中名称唯一性、父分类存在性、分类层级环检测和字段更新校验。
- 集中 JSONL 与 SQLite 两种模式下的分类/标签创建、更新和内存镜像同步。
- 主服务只保留兼容入口，并注入反馈模型失效通知。

拆分后主服务降至约 4,261 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十三批：元数据删除与恢复拆分

从 `electron/assetLibraryService.ts` 抽离分类/标签删除回收领域到 `electron/assetMetadataDeletionService.ts`：

- 集中构建分类与标签删除快照，并在 JSONL/SQLite 事务中同步移除相关分配、参考图和建议。
- 集中删除历史容量与字节预算裁剪，优先保留尚未恢复的记录。
- 集中删除历史分页、状态筛选、关系数量与存储占用统计。
- 集中分类/标签及其关系的恢复、冲突校验、ID 重分配和聚类状态恢复。
- 集中撤销最近删除与永久清理的二次确认逻辑。
- 主服务只保留兼容入口并注入反馈模型失效通知。

拆分后主服务由约 4,261 行降至约 3,824 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十四批：素材分配与归档拆分

从 `electron/assetLibraryService.ts` 抽离人工分类/标签关系和素材状态变更到 `electron/assetLibraryAssignmentService.ts`：

- 集中分类分配 upsert 规则，保持人工覆盖、建议来源、置信度和审核状态语义。
- 集中分类样本相关/无关反馈，并原子同步正式分配与拒绝建议。
- 集中标签人工分配、重复关系更新和关系移除。
- 集中 JSONL/SQLite 两种模式下的权威写入与内存镜像同步。
- 集中素材归档、恢复和权威路径解析。
- 主服务保留兼容入口；建议审核和聚类提升继续复用同一分类 upsert 实现。

拆分后主服务由约 3,824 行降至约 3,488 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十五批：分类参考图目录拆分

从 `electron/assetLibraryService.ts` 抽离分类参考图的目录操作到 `electron/assetLibraryReferenceService.ts`：

- 集中参考图列表与素材关系装配。
- 集中参考权重裁剪、重复关系更新和活动素材校验。
- 集中 JSONL/SQLite 两种模式下的新增、更新、删除和内存镜像同步。
- 集中外部参考图导入、素材 ID 复用及新增关系计数。
- 主服务只保留兼容入口并注入反馈模型失效通知；向量生成仍由后续建议任务编排负责。

拆分后主服务由约 3,488 行降至约 3,382 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十六批：反馈样本与相似素材搜索拆分

从 `electron/assetLibraryService.ts` 抽离两条会话搜索链路：

- `electron/assetCategorySampleSearchService.ts` 负责分类反馈模型就绪检查、正负样本状态、CLIP/DINO 联合检索、命中关系装配和会话结果缓存。
- `electron/assetSimilarSearchService.ts` 负责查询素材校验、DINO Float16 缓存定位、worker 扫描、已审核过滤、分类/标签装配和会话结果缓存。
- 两个模块均通过窄化的任务宿主接口接收任务启动与进度发布能力，主服务只保留兼容入口和生命周期清理。
- 供建议与聚类流程复用的分类审核状态和反馈搜索 worker 入口继续由分类样本搜索模块显式导出。

拆分后主服务由约 3,382 行降至约 3,032 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十七批：分类与标签建议生成拆分

从 `electron/assetLibraryService.ts` 抽离建议生成链路到 `electron/assetSuggestionGenerationService.ts`：

- 集中参考图 DINO 向量加载、本地参考图即时 embedding 与缓存更新。
- 集中参考图原型、分类阈值、已分配/已审核排除集合和 worker 扫描输入构建。
- 集中标签文本 CLIP 向量编码、阈值裁剪和候选生成。
- 集中 JSONL/SQLite 两种模式下旧生成建议替换与 ID 分配。
- 通过窄化任务宿主接口接收任务启动、进度发布和反馈模型失效通知，主服务仅保留兼容入口。

拆分后主服务由约 3,032 行降至约 2,643 行。专项验证：typecheck、素材库测试 110/110、SQLite/存储模式测试 19/19 通过。

## 第十八批：建议查询与审核事务拆分

从 `electron/assetLibraryService.ts` 抽离建议读取和审核写入到 `electron/assetSuggestionReviewService.ts`：

- 集中 SQLite 精确计数/分页与 JSONL 内存筛选两条建议列表路径。
- 集中建议目标、活动素材和状态转换校验。
- 集中确认建议时分类/标签正式关系的 upsert，以及 SQLite/JSONL 原子写入。
- 集中已确认建议撤销、AI 生成关系清理和反馈模型失效通知。
- 新增 `electron/assetSuggestionListRequest.ts`，独立规范化分页与筛选条件，并补充 2 项直接单元测试。
- 主服务仅保留查询、审核与撤销的兼容入口及反馈失效回调注入。

拆分后主服务由约 2,643 行降至约 2,360 行。专项验证：typecheck、素材库测试 112/112、SQLite/存储模式测试 19/19 通过。

## 第十九批：聚类构建与语义标签拆分

从 `electron/assetLibraryService.ts` 抽离聚类构建链路到 `electron/assetClusterBuildService.ts`：

- 集中分类反馈模型就绪、CLIP/DINO 联合召回、作用域过滤和分类匹配组持久化。
- 集中通用 DINO 聚类 worker 输入、阶段进度映射、人工组排除和自动组重算。
- 集中 CLIP 语义细分、语义标签生成、自动组身份继承及重算 lineage 记录。
- 集中 JSONL/SQLite 两种模式下聚类组与成员的原子替换。
- 语义标签生成入口继续供“刷新标签”任务复用；主服务只注入任务与进度宿主。

拆分后主服务由约 2,360 行降至约 1,863 行。专项验证：typecheck、素材库测试 112/112、SQLite/存储模式测试 19/19、聚类质量与人工操作测试 19/19 通过。

## 第二十批：派生聚类任务拆分

从 `electron/assetLibraryService.ts` 抽离派生聚类任务到 `electron/assetDerivedClusterService.ts`：

- 集中精确重复文件哈希扫描、近似重复感知哈希分组和两类重复组持久化。
- 集中现有聚类组的 CLIP 语义标签刷新，复用独立聚类构建模块的标签生成入口。
- 集中真实人物 CLIP 零样本扫描、作用域过滤、语义桶构建和代表素材选择。
- 集中 JSONL/SQLite 两种模式下派生聚类组与成员的原子替换。
- 主服务只保留四个后台任务的兼容入口与任务/进度宿主注入。

拆分后主服务由约 1,863 行降至约 1,458 行。专项验证：typecheck、素材库测试 112/112、SQLite/存储模式测试 19/19、重复项测试 26/26、聚类质量与人工操作测试 19/19 通过。

## 第二十一批：聚类查询与人工操作拆分

从 `electron/assetLibraryService.ts` 抽离聚类读取和人工变更到 `electron/assetClusterManagementService.ts`：

- 集中 SQLite 聚合优先与 JSONL 内存回退的聚类摘要、预览和代表素材装配。
- 集中重复组应用、非代表副本归档与状态确认。
- 集中 lineage 查询与事件写入。
- 集中聚类合并、拆分、跨组移动/移出、名称与状态更新。
- 集中聚类提升为正式分类及分类关系写入，覆盖 JSONL/SQLite 两种事务路径。
- 主服务只保留原有公开入口并注入反馈模型失效回调。

拆分后主服务由约 1,458 行降至约 843 行，主体已收敛为生命周期、备份、同步及领域入口编排。专项验证：typecheck、素材库测试 112/112、SQLite/存储模式测试 19/19、重复项测试 26/26、聚类质量与人工操作测试 19/19 通过。

## 第二十二批：素材索引同步流程拆分

从 `electron/assetLibraryService.ts` 抽离 Image Search 索引同步流程到 `electron/assetLibrarySyncService.ts`：

- 集中索引来源选择、索引记录读取和磁盘文件校验。
- 集中读取、校验、持久化三个阶段的进度区间映射。
- 集中素材元数据替换、陈旧记录统计和反馈模型失效判定。
- 通过窄化宿主与依赖接口隔离任务生命周期、存储和索引来源，主服务只保留兼容入口及宿主注入。
- 新增 3 项直接单元测试，覆盖阶段进度、默认来源、结果摘要、无变化反馈策略和缺少索引错误。

拆分后主服务由约 843 行降至约 718 行，剩余职责为生命周期、反馈模型接线、备份编排和领域兼容入口。专项验证：typecheck、同步流程直接测试 3/3、素材库测试 115/115 通过。

## 第二十三批：素材库备份协调器拆分

从 `electron/assetLibraryService.ts` 抽离备份生命周期和恢复工作流到 `electron/assetLibraryBackupCoordinator.ts`：

- 集中全部素材元数据存储的写入排空、手工备份、定时备份和失败退避调度。
- 集中备份列表、校验与备份根目录查询。
- 集中恢复前保护性备份、Windows SQLite 句柄关闭、恢复后重新初始化和故障关闭。
- 通过窄化宿主接口接收任务忙碌判断、串行 mutation、重新初始化、恢复验证与致命故障处理能力。
- 主服务只保留原公开备份入口和生命周期宿主接线。

拆分后主服务由约 718 行降至约 634 行。最终职责审计确认其剩余主体是任务控制器、反馈模型生命周期接线、JSONL/SQLite 查询选择及各领域模块的兼容门面，符合编排层完成边界。专项验证：typecheck、素材库测试 115/115、SQLite/存储模式测试 19/19 通过。

## 第二十四批：素材库面板基础视图拆分

开始拆分 `src/components/AssetLibraryPanel.tsx`：

- 抽离格式化、文件标签、分类树展平、空状态、共享控件样式和视图模式类型到 `assetLibrary/assetLibraryViewUtils.ts`。
- 抽离完整备份列表与操作栏到 `assetLibrary/AssetLibraryBackupView.tsx`，父面板只保留备份状态和命令协调。
- 新增 3 项直接单元测试，覆盖数值/时长/容量格式、跨平台路径标签和分类层级/孤儿节点展平。
- 保持备份创建、校验、导入、导出、删除与双击确认式恢复的现有交互契约。

按当前工作树行统计，主面板由约 3,678 行降至约 3,493 行。专项验证：typecheck、视图工具直接测试 3/3、素材库测试 118/118、lint 和 format check 通过。

## 第二十五批：素材列表视图拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离素材列表视图到 `assetLibrary/AssetLibraryAssetsView.tsx`：

- 集中查询、分类、标签、未分类、已移除和排序筛选控件。
- 集中页内选择、移除/恢复、撤销移除、批量分类/标签和参考图入口。
- 集中虚拟素材网格装配、打开/定位命令和分页状态展示。
- 父面板保留筛选状态、跨筛选互斥规则、mutation 命令及页码协调，并通过显式回调传入视图。

按当前工作树行统计，主面板由约 3,493 行降至约 3,327 行。专项验证：typecheck、素材库测试 118/118 和 renderer/主进程/preload/worker 生产构建通过。

## 第二十六批：建议审核与模式导航拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离建议审核视图和重复的子模式导航：

- `assetLibrary/AssetLibrarySuggestionsView.tsx` 集中审核状态、建议来源、虚拟建议网格、操作忙碌态和分页展示。
- `assetLibrary/AssetLibraryModeTabs.tsx` 统一素材/分类和建议/搜索两组子模式导航的选中样式与内容容器。
- 父面板保留建议请求条件、分页归零规则、审核 mutation、相似搜索跳转和跨模式选择清理。

按当前工作树行统计，主面板由约 3,327 行降至约 3,214 行。专项验证：typecheck、素材库测试 118/118 和 renderer/主进程/preload/worker 生产构建通过。

## 第二十七批：样本与相似搜索视图拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离样本搜索与相似搜索的共享结果视图到 `assetLibrary/AssetLibrarySearchResultsView.tsx`：

- 统一分类选择、结果数、已审核素材开关、执行/停止操作和错误状态展示。
- 统一相关/不相关反馈操作、搜索摘要、虚拟素材网格和分页展示，同时保留两种搜索的差异化文案与统计。
- 父面板保留请求参数、任务生命周期、过期响应隔离、选择状态和反馈 mutation，只向展示组件传递显式数据与命令回调。

按当前工作树行统计，主面板由约 3,214 行降至约 2,995 行。专项验证：typecheck、素材库测试 118/118、lint 和 renderer/主进程/preload/worker 生产构建通过。

## 第二十八批：分类管理视图拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离分类管理的三个独立交互边界：

- `assetLibrary/AssetLibraryCategorySidebar.tsx` 集中分类树、最近分类、拖放重设父级、分类创建和元数据删除历史。
- `assetLibrary/AssetLibraryCategoryDetailView.tsx` 集中分类编辑、参考图管理、参考建议入口和分类素材预览。
- `assetLibrary/AssetLibraryTagsView.tsx` 集中标签创建/编辑/删除及标签建议阈值与任务入口。
- 父面板继续持有选中状态、加载请求、mutation/task 串行协调和跨视图跳转，只通过显式数据与命令回调装配三个视图。

按当前工作树行统计，主面板由约 2,995 行降至约 2,458 行。专项验证：typecheck、素材库测试 118/118、lint、format check 和 renderer/主进程/preload/worker 生产构建通过。

## 第二十九批：聚类结果网格拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离聚类结果网格到 `assetLibrary/AssetLibraryClusterGrid.tsx`：

- 集中聚类卡片、预览缩略图、类型/相似度/语义标签和空状态展示。
- 集中聚类选择、成员选择及拆分/迁移控件，并保持选择出现时卡片高度稳定的既有布局策略。
- 集中重复组二次确认、普通组提升和忽略操作入口；父面板保留 mutation 串行、数据刷新、跨视图跳转和确认计时状态。

按当前工作树行统计，主面板由约 2,458 行降至约 2,171 行。专项验证：typecheck 和 lint 通过。

## 第三十批：聚类控制区拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离聚类控制与范围摘要到 `assetLibrary/AssetLibraryClusterControls.tsx`：

- 集中分类样本组参数、通用聚类参数、语义细分参数及各类重建入口。
- 集中聚类类型筛选、已选组的合并入口、目录/磁盘范围选择和覆盖率摘要。
- 父面板保留任务生命周期、请求参数组装、范围选择异常处理、合并 mutation 和数据刷新。

按当前工作树行统计，主面板由约 2,171 行降至约 1,933 行。专项验证：typecheck 和 lint 通过。

## 第三十一批：顶部状态与任务视图拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离顶部操作、全局状态和任务进度到 `assetLibrary/AssetLibraryHeader.tsx`：

- 集中同步、刷新、备份、报告、搜索学习开关和停止任务入口。
- 集中素材统计、存储降级告警、搜索学习状态、一级导航和任务进度/ETA/错误展示。
- 父面板保留刷新路由、任务与 mutation 编排、学习状态更新和当前视图切换。

按当前工作树行统计，主面板由约 1,933 行降至约 1,771 行。专项验证：typecheck 和 lint 通过。

## 第三十二批：备份状态与命令控制器拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离备份状态、副作用和命令到 `assetLibrary/useAssetLibraryBackups.ts`：

- 集中备份列表加载、开关状态、忙碌/消息/验证状态和恢复/删除二次确认计时。
- 集中创建、校验、导入、导出、删除和恢复命令的错误与完成消息处理。
- 父面板仅通过恢复完成回调重置跨领域筛选/搜索状态，并刷新当前可见领域数据。

按当前工作树行统计，主面板由约 1,771 行降至约 1,636 行。专项验证：typecheck 和 lint 通过。

## 第三十三批：搜索任务状态与命令控制器拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离样本搜索与相似搜索的状态、副作用和命令到 `assetLibrary/useAssetLibrarySearches.ts`：

- 集中两类搜索的参数、结果、分页、评分映射和选择反馈更新。
- 集中任务身份跟踪、启动中占位、过期响应隔离，以及任务完成后的对应结果加载。
- 集中搜索启动、清空和相关/不相关反馈命令；父面板只提供共享选择、通用任务/mutation 执行器与跨视图跳转回调。
- 备份恢复通过统一重置入口废弃搜索请求和任务身份，避免恢复前的异步响应重新写入界面。

按当前工作树行统计，主面板由约 1,636 行降至约 1,451 行。专项验证：typecheck、lint、format check 和素材库测试 118/118 通过。

## 第三十四批：分类与标签控制器拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离分类、标签、参考图和元数据删除历史控制器到 `assetLibrary/useAssetLibraryTaxonomy.ts`：

- 集中分类选择、最近访问、创建/编辑/删除、拖放重设父级和循环层级防护。
- 集中标签创建/编辑/删除、分类与标签建议阈值，以及建议任务启动。
- 集中分类参考图加载、导入/粘贴/移除、分类素材预览加载和过期响应隔离。
- 集中元数据删除历史分页、恢复/清理/导出、二次确认计时和删除后的分类选择重置。
- 父面板只保留共享素材选择、通用任务/mutation 执行器，以及“查看分类全部素材”和“按分类启动样本搜索”等跨领域跳转。

按当前工作树行统计，主面板由约 1,451 行降至约 1,215 行。专项验证：typecheck、lint、format check 和素材库测试 118/118 通过。

## 第三十五批：素材列表控制器拆分

从 `src/components/AssetLibraryPanel.tsx` 抽离素材列表状态、加载副作用和批量命令到 `assetLibrary/useAssetLibraryAssets.ts`：

- 集中查询防抖、分类/标签/未分类/已移除筛选、排序、分页和过期响应隔离。
- 集中页内选择更新、批量分类/标签、移除/恢复与撤销上次移除命令。
- 列表 mutation 在控制器内统一刷新基础统计和当前列表；父面板只共享跨模式选择，并向分类控制器提供当前批量分类目标。
- 备份恢复通过统一重置入口废弃在途列表请求并归零分页。

按当前工作树行统计，主面板由约 1,215 行降至约 1,141 行。专项验证：typecheck、lint、format check 和素材库测试 118/118 通过。

## 2026-07-28 综合复核：待整改基线

本节是审计后的当前风险基线，不表示已经完成对应代码整改。综合审计对隔离工作树、真实用户数据目录和现有安装器进行了只读复核，结论为“可继续开发和内部使用，暂不满足对外发布门槛”，综合工程健康度为 71/100。

| 领域            | 当前状态           | 复核证据与影响                                                                                                                                          |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心代码门禁    | 基础门禁通过       | `npm.cmd run verify` 共发现 444 项测试：440 通过、0 失败、4 项因隔离工作树没有被忽略的模型实物而跳过；typecheck、build、format 通过，lint 保留 5 条警告 |
| 依赖安全        | P1，未完成         | 生产依赖审计为 2 high、1 moderate；完整依赖树为 1 critical、6 high、1 moderate；Electron 42.4.1 需要在同一受支持分支内评估升级                          |
| 构建复现        | P1，未完成         | `models/manifest.json`、模型目录和 FFmpeg 二进制属于被忽略的本机构建输入，干净 Git 工作树无法独立重建当前完整安装包                                     |
| 磁盘治理        | P1，未完成         | 用户数据约 14.64 GiB；其中向量分片约 8.42 GiB、扫描日志约 800 MiB、失败记录约 170 MiB，且缺少完整轮转、配额和可视化清理闭环                             |
| NekoSearch 门禁 | P1，失败           | test01 指标保持 P@20/P@50/nDCG@20=1.0，但扫描 p95 为 62,507.1ms，相对 36,984.9ms 基线回退约 69%，超过 1.5 倍门槛                                        |
| UI 发布门禁     | P1，无有效当前证据 | `smoke:ui` 仍依赖英文标题；中文默认语言下把实际已加载的界面误判为面板缺失。最新安装器也没有当前版本 packaged UI smoke 结果                              |
| 国际化          | P1，未完成         | 粗略静态检查在 35 个组件中发现 127 行可见英文文本候选；语言切换尚未覆盖完整界面                                                                         |
| 发布与许可证    | P1，未完成         | 安装器未签名；项目缺少 LICENSE/license 字段，随包模型、GPL FFmpeg、AGPL YOLO 的许可证、声明和分发义务尚未闭环                                           |

详细证据、命令、磁盘分项和风险说明见[全项目综合审计](../audits/2026-07-28-full-project-audit.md)。任何单项修复完成后，应在本文件追加整改批次，并保留本节作为 2026-07-28 的复核快照。

## 后续优先级

各事项的任务编号、依赖关系、实施步骤和验收标准统一见[全项目详细优化方案](2026-07-28-project-optimization-plan.md)。

1. 为扫描日志、失败记录、向量分片、诊断备份和缩略图缓存建立轮转、配额、垃圾回收与占用可视化。
2. 用稳定测试标识替代 UI smoke 的语言文本定位，覆盖中文和英文；对当前安装器重新建立 packaged UI 门禁。
3. 处理生产依赖漏洞，并把 Electron 升级到当前受支持分支的最新补丁版本，逐项回归原生模块与打包流程。
4. 优化向量读取、二进制缓存或 ANN 路径，重新通过 NekoSearch 延迟门禁；同时扩充多分类人工标注，避免单分类满分掩盖泛化风险。
5. 清理剩余硬编码英文，建立双语键覆盖与缺失翻译测试。
6. 将完整模型清单和二进制来源纳入可复现构建规范，补齐版本、签名、LICENSE、第三方许可证与发布记录。
7. P1 发布阻断项关闭后，再继续建议/聚类控制器拆分和其他 P2 结构优化。

在上述 P1 项目取得可重复验证证据前，不应创建对外发布标签或把现有安装器标记为正式发布。

## 第三十六批：REL-01 UI smoke 稳定定位与双语门禁

2026-07-28 完成。实际分支为 `task/ui-smoke-stable-locators`，以符合仓库仅允许 `task/`、`fix/`、`perf/`、`docs/`、`experiment/` 前缀的 Git 规则。

1. 面板定位改用稳定 `data-panel`，搜索模式、素材库模式、分类/标签/聚类命令和 Settings 语言控件改用 `data-testid`；测试不再依赖 `Settings`、`Image Search` 等可翻译文本。
2. 增加应用就绪标识和 ErrorBoundary 稳定标识，分别区分 React 尚未挂载、加载未完成和错误边界崩溃。
3. UI smoke 运行器新增 `--locale=zh-CN|en`，为每次执行创建独立临时用户数据并预置语言；产物按语言分目录保存，避免本机设置和上一次执行污染结果。
4. smoke 会验证 7 个稳定面板、关键交互、模型/native/备份状态，并在同一进程内执行“指定语言 → 另一语言 → 指定语言”的往返切换。
5. 新增 `tests/ui-smoke-contract.test.cjs`，防止面板定位、交互定位和双语运行参数退回显示文本耦合；主测试链已纳入该门禁。

验证结果：

- `npm.cmd run smoke:ui:locales`：`zh-CN`、`en` 均通过；7 个面板全部找到，语言往返切换成功，关键素材库检查、模型、`fast_scanner 0.5.1` 和备份检查通过，控制台错误为 0。
- `npm.cmd run test:ui-smoke-contract`：3/3 通过。
- `npm.cmd run verify`：通过；typecheck、format、全部测试、native 测试和生产构建成功；lint 为 0 错误、5 条基线已有警告。
- 隔离 worktree 仅通过未跟踪 junction 只读复用主项目现有 `models/`、`ai-models/` 物料，没有复制、修改或提交大模型文件。

未覆盖边界：本批只恢复开发态双语 UI smoke。当前没有由本提交生成并保留的 `release/win-unpacked`，因此 packaged 双语 smoke 仍由 REL-03 负责；这项剩余边界继续阻断正式发布判断。

## 第三十七批：REL-02 唯一 release gate

2026-07-30 完成。实际分支为 `task/rel-02-release-gate`。

1. 新增 `scripts/release-gate.cjs` 和 `npm.cmd run release:gate`，把干净安装、Git 检查、完整 verify、生产依赖审计、NekoSearch 准确率门禁、打包、双语 packaged smoke、安装包归档检查、签名验证、SBOM/哈希/release record 和清理固定为一个串行入口。
2. 任一步退出非零立即停止；运行报告逐步原子写入起止时间、退出码、提交、命令和可用产物哈希，不允许失败路径生成或保留 `passed` release record。
3. 打包阶段强制保留 `win-unpacked`，中英文 packaged smoke 完成后才允许最后的清理步骤运行。
4. 签名使用显式环境配置并隐藏命令参数；未配置签名、签名无效或清理失败都会阻断发布。
5. 新增 7 个 release gate 专项测试并纳入 `test:model-download` 和完整 `npm test`。

验证结果：

- `npm.cmd run test:model-download`：11/11 通过，其中 release gate 专项 7/7 通过。
- `npm.cmd run verify`：469 项中 465 通过、0 失败、4 跳过；typecheck、format、native 和全部生产构建通过；lint 为 0 错误、5 条既有警告。
- 干净提交 `b2cd34f` 的真实 gate 运行：`clean-install`、`git-preflight`、`verify` 通过，在 `production-audit` 按当前安全基线退出 1；报告准确记录 `failedStep=production-audit`，没有生成 release record。
- 当前生产审计仍为 2 high、1 moderate；完整依赖树仍为 1 critical、6 high、1 moderate。

未覆盖边界：本批只完成发布门禁编排。Electron 补丁升级和依赖安全由 DEP-01/DEP-02 处理；NekoSearch、packaged runtime、签名证书、SBOM 完整性、许可证和正式 release record 仍按后续任务验收，现有安装器仍不得标记为正式发布。

## 第三十八批：DEP-01 Electron 42.x 补丁升级

2026-07-30 完成。实际分支为 `task/dep-01-electron-42-patch`。

1. 依据 npm registry 和 Electron 官方发布信息，把开发依赖和 lockfile 从 `42.4.1` 精确升级到同一 major 的 `42.8.0`。
2. 适配 Electron 新版 npm 包不再自动下载预构建二进制的变化：root postinstall 显式安装，官方端点失败时可在 Electron bundled checksums 校验下重试镜像；显式用户镜像不会被覆盖。
3. 新增版本/安装契约测试；release gate 新增实际 Electron、Chromium、Node、V8 探测并写入 release record。
4. 使用 Electron 42.8.0 headers 重新构建 `fast_scanner.node`，并生成新的 `win-unpacked` 和 NSIS 安装器。
5. 实际运行时为 Electron 42.8.0、Chromium 148.0.7778.280、Node 24.18.0、V8 14.8.178.38-electron.0。

验证结果：

- 全新 `npm.cmd ci`：通过，Electron 二进制安装完成。
- `npm.cmd run verify`：474/474 通过、0 失败、0 跳过；typecheck、format、Node native、Electron native 和全部生产构建通过；lint 为 0 错误、5 条既有警告。
- `npm.cmd run smoke:ui:locales`：开发态 `zh-CN`、`en` 均通过，7 个面板、语言往返、模型、native addon、备份恢复和关键交互正常，控制台错误为 0。
- `npm.cmd run smoke:ui:packaged:locales`：新 `win-unpacked` 的 `zh-CN`、`en` 均通过，`nativeAddonStdoutEvidence=true`。
- `npm.cmd run smoke:installer:archive`：通过；953.03 MiB、309 个文件、SHA-256 `4B60E8356F1FFEAF64EB151D127E9906204F548A7C9147A5A1A2FAB4451CFC90`。
- 验证后执行 `npm.cmd run release:clean`，移除本 worktree 的 `win-unpacked`、blockmap 和 builder debug 文件，保留 ignored 安装器。

未覆盖边界：生产依赖仍为 2 high、1 moderate，完整依赖树仍为 1 critical、6 high、1 moderate；本批未处理漏洞、签名、许可证或正式发布记录，因此不会改变“暂不满足对外发布门槛”的结论。

## 第三十九批：DEP-02 生产与构建依赖安全修复

2026-07-30 完成。实际分支为 `task/dep-02-security-dependencies`。

1. 使用非强制 lockfile 修复升级 `protobufjs` 7.6.5、`tar` 7.5.22、`fast-uri` 3.1.4、`js-yaml` 4.3.0 和 `postcss` 8.5.25，关闭 production moderate 与完整树 critical。
2. `@huggingface/transformers` 4.2.0 暂未放宽 `sharp ^0.34.5`，因此精确 override 到安全版 `sharp` 0.35.0 / libvips 8.18.3；对 0.35.0 的声明导出缺口使用只影响编译期的最小 TypeScript 路径桥接。
3. 新增 3 项依赖安全测试，锁定告警修复下限、三个 `brace-expansion` 修复分支和 Transformers `RawImage` 的真实 PNG 解码/缩放兼容。
4. 完整审计仍把 26 个构建树节点归因于同一 `brace-expansion` GHSA，但 lockfile 中的 1.1.17、2.1.3、5.0.8 均已包含 `EXPANSION_MAX_LENGTH` 有界修复。该 registry 元数据例外由项目依赖维护者负责，2026-08-13 到期复核；构建 glob 仅接受仓库受控输入，契约测试禁止版本回退。

验证结果：

- 全新 `npm.cmd ci`：通过；production audit 为 0 high、0 critical、0 moderate。
- `npm.cmd run test:guards`：18/18 通过，其中新增依赖安全测试 3/3 通过。
- `npm.cmd run verify`：通过；typecheck、format、全部测试、Node native 和生产构建成功；lint 为 0 错误、5 条既有警告。真实 face、ReID、SAM 与图片特征测试通过。
- `npm.cmd run build:native:electron`：Electron 42.8.0 headers 下重建成功。
- `npm.cmd run smoke:ui:locales` 与 `npm.cmd run smoke:ui:packaged:locales`：开发态、packaged 的 `zh-CN`、`en` 均通过；7 个面板、模型、`fast_scanner 0.5.1`、备份恢复和关键交互正常，控制台错误为 0。
- `npm.cmd run smoke:installer:archive`：通过；952.87 MiB、310 个文件、SHA-256 `0268E9F4F072083D2A3ADECFDD6258A4E88B1837F51DFB4BCEB1F14583F689AB`。

未覆盖边界：构建树 registry 报告例外需要按到期日复核；安装器仍未签名，许可证、NekoSearch 门禁和正式 release record 未完成。REL-03 将继续核对 packaged 资源实际加载来源，本批不改变“暂不满足对外发布门槛”的总判断。

## 第四十批：REL-03 当前安装包运行时验证

2026-07-30 完成。实际分支为 `task/rel-03-packaged-runtime`。

1. 新增 packaged resources 清单门禁，核对 `app.asar`、8 个 worker、native addon、模型 manifest、subject/face/ReID/SAM/DINO/CLIP/多语言文本模型、FFmpeg/FFprobe、Sharp 和 ONNX Runtime 绑定共 24 项规范资源。
2. 清单要求文件存在、大小为正且规范路径位于 `resources` 下，同时拒绝 `ai-models/yolov8n`、`resources/ffmpeg/bin` 等历史重复位置。
3. packaged 双语 smoke 不再只看布尔状态：它会执行真实 YOLO 推理、初始化 MobileSAM、探测 FFmpeg/FFprobe，并记录 DINO、CLIP、native addon 和媒体工具的实际加载路径；packaged 模式要求这些路径全部属于 `process.resourcesPath`。
4. release gate 在打包后、启动 UI 前固定执行资源清单，先暴露缺件、空文件、错误路径和重复物料。
5. 新增 `npm.cmd run todo:next`，直接解析优化计划的权威任务表和依赖，输出第一个可执行 TODO、全部就绪项及阻塞依赖；后续任务按该队列逐项使用独立 worktree、完整门禁和 fast-forward 合并。

验证结果：

- `npm.cmd run smoke:packaged:resources`：24/24 规范资源通过，0 缺失、0 历史重复、0 路径越界。
- `npm.cmd run smoke:ui:packaged:locales`：`zh-CN`、`en` 均通过；YOLO、MobileSAM、DINO、CLIP、FFmpeg、FFprobe 与 `fast_scanner 0.5.1` 实际从 packaged resources 加载，7 个面板和备份恢复检查通过，控制台错误为 0。
- `npm.cmd run smoke:installer:archive`：通过；安装器 999,154,080 字节（952.87 MiB），310 个归档文件，SHA-256 `A2AA933695CFED23A9CA437F26F5A44BB9DB93540C148DA9333283DF10A1978A`。
- 资源清单、TODO 依赖解析、release gate 固定顺序和 packaged runtime 来源均有专项契约测试。
- `npm.cmd run verify`：481/481 通过、0 失败、0 跳过；typecheck、format、Node native 和生产构建通过，lint 为 0 错误、5 条既有警告。

未覆盖边界：当前安装器仍未签名；NekoSearch 准确率门禁、可复现物料获取、SBOM、许可证/第三方声明和正式 release record 尚未闭环，因此仍不得标记为公开发布版本。后续首个自动选择 TODO 为 `DSK-01`。

## 第四十一批：DSK-01 native 扫描日志轮转与脱敏

2026-07-30 完成。实际分支为 `fix/native-log-rotation`。

1. 把 `fast_scanner.cc` 的逐条 append 文件写入替换为独立 `rotating_logger`，所有线程经同一互斥入口写入完整日志行。
2. 生产策略固定为单文件 16 MiB、同目录保留 2 个备份；越界前执行 `.1 → .2`、当前文件 → `.1` 的倒序 rename。
3. 日志目录创建、file size、删除、rename、打开和写入失败均被隔离，诊断 I/O 不会让扫描失败。
4. scan/decode/USN state/segment 事件中的绝对路径默认转为稳定匿名指纹；详细路径要求同时显式开启 verbose log 与 verbose paths，并在第一行写入隐私警告。
5. 测试专用环境开关支持小尺寸边界和模拟写入失败，但生产配置不能通过这些变量降低保留策略。

验证结果：

- `npm.cmd run test:native`：40/40 通过，其中日志专项 5/5 通过。
- 8 个 native 线程并发写入没有交错/破损行；512 字节测试上限下只保留当前文件和 `.1`/`.2`，每份均不超过上限。
- 默认日志未出现测试绝对路径、目录名或文件名；显式路径模式先出现 `PRIVACY_WARNING` 再出现原路径。
- 不可用目录与模拟磁盘写满均返回成功且没有改写占位文件，证明日志失败保持 fail-open。
- `npm.cmd run verify`：486/486 通过、0 失败、0 跳过；typecheck、format、Node native 和生产构建通过，lint 为 0 错误、5 条既有警告。

未覆盖边界：本批只治理 `image-search-scan.log`；embedding failure/diagnostic 日志保留策略由下一个自动 TODO `DSK-02` 处理。现有历史大日志不会在本批自动删除，避免未经用户确认的数据清理。

## 紧急回归修复：以图搜图结果空白

2026-07-30 完成。实际分支为 `fix/image-search-empty-results`；该修复优先于自动 TODO 队列执行，不改变 DSK-02 的任务状态或依赖顺序。

1. 每次发起新的图片查询时同步清空旧路径筛选、直接搜索结果和分层搜索结果，避免上一次查询的 UI 状态隐藏新命中或让旧命中回流。
2. 结果网格按过滤后的结果数量判断空态；如果用户主动输入的路径筛选排除了全部命中，会显示明确提示，不再渲染无内容的空白网格。
3. 原始命中数统一使用当前实际展示源 `sortedResults`，兼容快速 hash 搜索和标准/精确分层搜索。
4. 新增 UI 状态回归契约，锁定查询重置、结果源计数和过滤空态三条行为。

验证结果：

- 真实用户索引只读加载成功：184,301 条记录、1 个活动 segment；以索引内真实图片查询，balanced 模式阈值 10 返回 2 条结果，首条得分 1。
- `npm.cmd run test:ui-smoke-contract`：5/5 通过。
- `npm.cmd run verify`：487/487 通过、0 失败；typecheck、format、40 项 native 测试和生产构建通过，lint 为 0 错误、5 条既有警告。

未覆盖边界：本批不重建、不迁移也不删除用户索引；若某张查询图在当前阈值下确实没有相似项，界面会继续显示“降低阈值”的正常空结果提示。完成热修复后继续自动 TODO `DSK-02`。

## 第四十二批：DSK-02 embedding 日志保留策略

2026-07-30 完成。实际分支为 `fix/embedding-log-retention`。

1. `embedding_failures.jsonl` 按模型、imageId 和失败原因去重，保留最新时间与累计次数；默认限制 32 MiB、50,000 个去重键和 30 天 TTL。
2. 第一次 embedding build 会自动压缩历史 failure；压缩后的新唯一失败直接 O(1) 追加，重复键或容量边界才原子重写，避免每个失败都扫描和改写整个文件。
3. `embedding_diagnostics.jsonl` 默认限制 20 MiB、100,000 条和 14 天 TTL，最多保留 3 份备份；同毫秒轮转使用唯一后缀，超大单条事件安全丢弃并计数。
4. job compaction 保留全部 pending/running、30 天内最多 5,000 条失败，不再永久保留 completed/skipped；自动和手动压缩共用 `jobStore`，消除磁盘文件被旧内存缓存恢复的问题。
5. failure/diagnostic 的最近成功、最近错误、压缩和丢弃计数通过维护 IPC 返回；Vector DB 面板在日志写入异常时显示 `Log !n`，而 embedding 主流程继续运行。

验证结果：

- retention 专项 8/8 通过；`npm.cmd run test:vector-pipeline` 31/31 通过。
- 真实 failure 日志只在临时副本测试：199,143,326 bytes / 589,314 行在 1.84 秒内收敛为 17,492,696 bytes / 50,000 条，满足双上限；原始用户文件未被修改。
- 真实 jobs 只读评估：235,686 条全部为 pending，0 条被错误清理，策略计算耗时 0.50 秒。
- `npm.cmd run verify` 通过；typecheck、format、全部测试、40 项 native 测试和生产构建成功，lint 为 0 错误、5 条既有警告。

未覆盖边界：现有用户 failure、diagnostic 备份和 jobs 文件不会在本批安装代码时立即删除；启动下一次 embedding build 后才按策略自动收敛。全数据域占用、可回收估算和安全清理预览由下一个自动 TODO `DSK-03` 统一处理。

## 紧急回归修复：以图搜图向量缓存超时

2026-07-30 完成。实际分支为 `fix/image-search-stale-vector-cache`。

1. 根因是 DINO embedding JSONL 更新后，交互搜索把现有完整 Float16 缓存判为过期，并尝试在 30 秒查询超时内重建 7.25 GiB 源文件；超时后退回 hash-only，普通相似图片因此返回 0。
2. 交互搜索现在优先读取最后一份结构完整的 Float16 缓存；缓存刷新仍由原有维护/构建流程按源文件新鲜度执行，不会把查询请求变成长时间重建任务。
3. 真实缓存验证：295,339 条 DINO 向量可返回 200 条候选，其中 170,812 条仍属于当前 184,301 条 hash 索引。
4. 新增回归测试，证明源 JSONL 更新后交互读取仍使用完整旧缓存，而 `ensureEmbeddingF16Cache` 仍会正确重建为最新缓存。

验证结果：Float16 专项 4/4、`npm.cmd run verify`、40 项 native 测试和生产构建全部通过。

## 第四十三批：DSK-03 全数据域磁盘占用清单

2026-07-30 完成。实际分支为 `task/dsk-03-storage-inventory`。

1. 新增统一 storage inventory，覆盖 Image Search 日志、权威索引和缩略图，CLIP/DINO JSONL、F32/F16 cache 和 ANN，Media Search 帧、向量与 manifest，素材库备份、recovery 和删除历史，以及 embedding failure、diagnostic 和 job。
2. 每项统一报告逻辑路径类别、总大小、活跃大小、可回收估算、最后修改时间、文件数、是否可重建、清理风险和当前任务占用状态。
3. Renderer 只接收并展示逻辑路径类别；清单结构不返回项目真实路径，避免默认暴露个人目录。
4. 回收预览不把权威数据计为可回收；可重建缓存仍标识为当前活跃；素材库备份只把最新备份之外的版本计入估算。
5. 大目录扫描使用 64 路受控异步 I/O，避免统计 10 万级缩略图时同步阻塞 Electron 主进程。

验证结果：

- storage inventory 专项 3/3、`npm.cmd run test:vector-pipeline` 34/34 通过。
- 真实用户数据只读扫描：18,364,391,981 bytes 总量，4,259,518,881 bytes 可回收估算，134,351 个缩略图文件；异步扫描耗时 12.68 秒。
- `npm.cmd run verify`、40 项 native 测试和生产构建通过；lint 为 0 错误、5 条既有警告。

未覆盖边界：本批只提供统计与预览，不执行任何清理。清理前确认、进度、取消、任务互斥和实际释放报告由下一个自动 TODO `DSK-04` 实现。

## 第四十四批：DSK-04 安全磁盘清理工作流

2026-07-30 完成。实际分支为 `task/dsk-04-storage-cleanup`。

1. 清理必须先生成只读预览；短期令牌在主进程内绑定精确文件目标，Renderer 不接收个人路径，也不能提交任意路径。
2. 用户显式勾选并通过二次确认后，主进程检查目标盘空间、写入元数据快照，再启动逐文件异步清理。
3. 允许项严格限制为轮转/过期日志、派生缩略图和向量缓存、媒体帧与 manifest、被最新备份替代的旧备份；权威数据永不进入候选。
4. 每个文件删除前重新验证 realpath 包含关系并拒绝符号链接，避免预览后路径替换越界；取消在文件边界生效。
5. 状态持续报告完成文件数、总文件数、实际释放空间、跳过和最多 20 条错误；完成后 UI 自动重新统计。
6. 清理涉及的数据域会阻止新 Image Search、向量或 Media Search 扫描/构建，且同一时刻只允许一个清理任务。

验证结果：

- 清理专项 3/3、`npm.cmd run test:vector-pipeline` 37/37、IPC 注册和 preload 契约测试通过。
- 真实用户数据只读预览：12.80 秒识别 4,136,783,694 bytes 候选；没有执行真实清理。
- `npm.cmd run verify`、40 项 native 测试和生产构建通过；lint 为 0 错误、5 条既有警告。

未覆盖边界：应用异常退出后不会自动续跑未完成的清理任务；已写入的元数据快照会保留供审计，剩余候选需重新预览。下一自动 TODO 为 `DSK-05` active asset 向量 GC。

## 第四十五批：DSK-05 active asset 向量 GC

2026-07-30 完成。实际分支为 `perf/vector-gc`。

1. active 集合合并 Image Search 当前索引、Media Search 帧 manifest 和素材库权威 JSONL，覆盖共享全局 embedding shard 的全部已知消费者。
2. 双遍流式预览按 shard 统计 active、stale、duplicate、malformed 和精确预测输出字节，不把数 GB vector JSONL 整体加载为 JS 对象。
3. 执行写入独立临时文件并验证记录数、唯一键、模型、类型、维度、抽样向量哈希和余弦排序，验证成功后才原子切换。
4. 磁盘不足、取消和切换故障均保留或恢复旧权威 shard；临时文件会清理，禁止原地截断。
5. 旧 shard 作为带 7 天过期元数据的完整恢复快照保留；到期后进入统一安全清理预览。报告区分当前实际释放和快照到期后的待释放空间。
6. GC 与 embedding、向量索引构建和 Image Search 扫描互斥，且必须先预览再确认。

验证结果：

- GC 专项 4/4、`npm.cmd run test:vector-pipeline` 42/42、IPC 注册和 preload 契约测试通过。
- 真实只读预览：81.76 秒扫描 949,118 行、270,504 个 active 权威路径；预计最终可回收 5,829,735,147 bytes。
- CLIP：263,397 active、183,446 stale、30,952 duplicate、0 malformed；DINO：263,393 active、176,469 stale、31,458 duplicate、3 malformed。
- `npm.cmd run verify`、40 项 native 测试和生产构建通过；lint 为 0 错误、5 条既有警告。

未覆盖边界：真实 shard 未自动改写，因为 GC 必须由用户在 UI 检查预览后明确确认；这是当前 stale 向量保留的安全理由。下一自动 TODO 为 `DSK-06` 权威二进制向量格式迁移。

## 第四十六批：DSK-06 权威二进制向量格式

2026-07-30 完成。实际分支为 `perf/vector-binary-store`。

1. 新增 generation 化连续 F16 权威库；manifest 分离元数据与向量并记录 model、
   embedding type、dim、dtype、row offset、文件尺寸、SHA-256、导入源和 generation。
2. 维护页新增只读预览、确认、进度和取消。迁移按块复制向量、逐行生成路径索引，
   staging 全量校验通过后才切换 `CURRENT`；磁盘预检、取消和任何失败都保留旧提交。
3. `ensureEmbeddingF16Cache` 成为统一路由：源未变化时优先权威 generation；源继续
   增长时安全回退到刷新缓存，重新迁移后再切换，避免新增向量静默不可见。
4. 既有派生 F32/F16 缓存与旧 generation 自动进入安全清理预览；原始 JSONL 在
   Media Search、追加写和诊断/导出兼容入口退出前继续受保护，不提供误删选项。
5. 专项 3/3、向量管线 45/45、IPC 注册和 preload 契约通过。真实数据只读评估：
   13,123,115,303 bytes JSONL，预计 generation 839,015,636 bytes，可用空间
   30,266,146,816 bytes；未执行真实迁移或删除。

下一自动 TODO 为 `ACC-01` 准确率基准读取二进制缓存并恢复延迟门禁。

## 第四十七批：ACC-01 准确率基准二进制读取与延迟门禁

2026-07-30 完成。实际分支为 `perf/neko-accuracy-runtime`。

1. 基准只读选择 authoritative generation、CLIP F32 或 F16 完整快照；不再因
   JSONL 继续增长而重建派生缓存，也不静默回退到数 GB JSONL。
2. 新增 F32/F16 分块精确扫描器，兼容旧 `{path}` 与新 `{row,path,offset}` 路径
   索引；Float16 查表解码，冷样本间释放路径数组，真实运行工作集稳定在约
   400–450 MB。
3. application-cold 与 warm-path-index 各至少 3 次，报告路径 I/O、JSON 解析、
   向量 I/O、相似度与排序；ANN 明确只作候选召回，不进入质量对照。
4. 门禁锁定 annotation 与 active-set 指纹；任一集合变化都拒绝直接比较，防止
   GC 或标注变化掩盖质量回归。
5. 真实只读结果四个变体质量与旧基线完全一致；warm p95 20,065.6ms、
   application-cold p95 19,014.4ms，低于 40,000ms 工程预算和
   55,477.35ms 恢复上限。基线升级为 version 2。

未覆盖边界：真实 Vector GC 仍未执行，不能伪造 GC 后质量结果；用户未来明确
确认 GC 后，必须在相同 annotation/active-set 指纹下复跑。下一自动 TODO 为
`ACC-02` 至少五类真实人工标注集。

## 第四十八批：I18N-01 Renderer 全界面翻译

2026-07-30 完成。实际分支为 `task/i18n-renderer-completion`；由于 `ACC-02`
需要继续补充真实人工标注，本批按依赖队列并行推进已就绪的 `I18N-01`。

1. 完成图片搜索数据管理、缩略图重建、向量维护/GC/迁移、Media Search、
   Asset Library 备份/建议/聚类、Remote Terminal/SFTP、公共进度和错误边界等
   Renderer 表面的中文映射，覆盖按钮、提示、空状态、确认框、进度和错误。
2. 将组件内可见字符串统一改为 `t(...)`，保留 DINO、CLIP、GPU、CPU、SFTP、
   hash、topK 等技术标识；30 个本批修改组件的翻译键审计无未解释缺失项。
3. ErrorBoundary 通过函数式回退视图接入语言上下文，同时保持原有重试按钮样式；
   面板内部稳定英文 `title` 继续只作 `data-panel` 标识，可见标题由
   `DraggablePanel` 翻译，避免语言切换破坏自动化定位。
4. UI smoke 在 `show-all-panels` 后轮询等待 7 个稳定面板挂载，并直接按
   `data-panel` 排列面板，解决 Media Search 懒加载替换节点后丢失临时标记的问题；
   新增契约防止回退到翻译文本或临时序号定位。
5. 新增国际化契约，锁定维护、媒体、素材库、远程终端和带参数确认提示的中文映射。

验证结果：

- `npm.cmd run test:settings`：21/21 通过；`npm.cmd run test:ui-smoke-contract`：
  5/5 通过。
- `zh-CN` 与 `en` 开发态 UI 均为 7/7 面板，无崩溃、控制台错误为 0，语言和材质
  往返切换、图片搜索模式及素材库关键交互全部通过。
- 隔离 worktree 的开发态模型注册表未识别 DINO/CLIP junction，因此两次 smoke
  仅在运行时模型探针处返回非零；native 0.5.1、FFmpeg/FFprobe 和备份恢复正常。
- `npm.cmd run verify` 全部通过：typecheck、format、完整测试、40 项 native 测试
  和生产构建成功；lint 为 0 错误、5 条既有警告。

未覆盖边界：主进程、worker 与 toast 的结构化错误码国际化属于后续 `I18N-02`；
硬编码静态门禁和完整双语可访问性 E2E 分别由 `I18N-03`、`I18N-04` 处理。
`ACC-02` 仍保持进行中，下一项可自动执行的并行 TODO 为 `I18N-02`。

## 紧急性能修复：DINO / CLIP GPU 构建吞吐异常

2026-07-31 完成，提交为 `9b734e5`。完整事件、根因、数据影响与验证证据见
[DINO / CLIP GPU 构建吞吐异常事件](2026-07-31-embedding-gpu-throughput-incident.md)。

1. 构建前不再逐行扫描 5–8 GiB embedding JSONL；改读 F16/F32 路径索引，并只解析缓存快照后的追加尾部。真实 DINO 已有 ID 检查由约 30,111 ms 降至 779 ms，CLIP 为 557 ms。
2. 新增图片文件头预检与带 size/mtime 指纹的负缓存，扩展名伪装图片不再反复进入模型并产生 `unsupported image format`。
3. 主进程按 Batch Size 一次派发完整批次；DINO 修复 batch offset 和 CLS token 池化，CLIP/DINO 子进程增加 stdin、进程崩溃及连续失败保护。
4. Windows DirectML 默认并发与上限均收敛为 2，避免原最高 18 个独立模型进程争抢 4 GiB 显存；界面只提供 1/2 两档。
5. 任务级诊断改为采样或批次记录，构建完成事件只写一次，减少长任务日志 I/O。

验证结果：

- DirectML 真实 batch=4：DINO 4/4 成功、1,983 ms；CLIP 4/4 成功、1,978 ms。
- 新增 6 项回归测试，覆盖伪图片、负缓存、DINO/CLIP 快速已有 ID、DINO 批量池化和 DirectML 派发策略。
- `npm.cmd run verify` 全部通过；42 项 native 测试通过；lint 为 0 错误、5 条既有警告。

未覆盖边界：选择整个 `C:\`、`D:\` 时，文件系统目录枚举仍取决于磁盘文件量，不属于 GPU 推理耗时；本次没有删除、迁移或重建用户向量。

## 第五十批：I18N-02 运行时结构化错误国际化

2026-07-31 完成，实际分支为 `feat/i18n-runtime-errors`。由于 `ACC-02` 仍缺少至少四类
真实人工标注来源，本批按依赖队列继续自动执行可完成的 `I18N-02`。

1. 新增共享运行时错误码、结构化参数、诊断详情和统一失败结果，IPC 不再要求 Renderer
   把向量构建与视频帧向量构建的英文错误句子直接显示给用户。
2. 数据准备子进程失败及 DINO/CLIP worker 连续失败会把稳定错误码写入构建进度；英文
   技术事件名继续只用于诊断日志。
3. 图片与媒体 Simple 工作流跨异步轮询保留结构化错误，进度条、toast 和高级媒体构建
   提示按当前语言翻译；未知码和旧式结果使用通用翻译并保留诊断详情。
4. `RuntimeErrorCode` 是 IPC 可检查的联合类型，新增测试锁定已知码映射、未来未知码回退、
   legacy 错误回退及工作流错误透传。

验证结果：

- `npm.cmd run typecheck`、`npm.cmd run test:settings`（23/23）和
  `npm.cmd run test:media-search`（32/32）通过。
- `npm.cmd run test:vector-pipeline`（53/53）、IPC validation、IPC registration 和
  preload contract 全部通过。
- lint 为 0 错误、5 条既有警告；本批新增的 React Hook 依赖警告已清除。

未覆盖边界：`ACC-02` 仍需要真实人工标注，不能由代码自动伪造；下一项可自动执行的
TODO 为 `I18N-03` 硬编码文本静态门禁。

## 第五十一批：I18N-03 可见硬编码文本静态门禁

2026-07-31 完成，实际分支为 `test/i18n-static-gate`。

1. 基于 TypeScript AST 扫描 Renderer TSX，覆盖 JSX 文本与字符串表达式、常见可访问
   属性，以及 toast、message、confirm、alert 的直接字符串和 fallback 分支。
2. 门禁使用精确内容指纹而不是行号，代码移动不会产生误报；文件、类型、文本或现有
   次数之外的任何扩张都会失败。
3. 当前 236 个存量组逐项记录原因和移除条件；删除旧文本会自然收缩，不需要先修改
   基线，避免基线阻碍持续翻译。
4. 稳定 `data-*` 标识、`t(...)`、纯符号和由公共组件内部翻译的面板 ID 不进入报告；
   测试 fixture 在临时目录中验证检测能力，不加入产品基线。
5. `test:i18n-static` 已加入完整测试链，后续提交不能静默新增未翻译可见文本。

验证结果：

- 静态门禁专项 5/5，覆盖 JSX、属性、消息调用、翻译忽略、精确次数和仓库零新增。
- `npm.cmd run typecheck`、`npm.cmd run format:check` 通过。
- lint 为 0 错误、5 条既有警告。

未覆盖边界：本批按计划执行“先冻结存量、禁止新增”；236 个存量项会在后续翻译中只减
不增。`ACC-02` 仍等待真实人工标注；下一项可自动执行的 P1 TODO 为 `I18N-04`。

## 第五十二批：I18N-04 双语 UI 与可访问性 E2E

2026-07-31 完成，实际分支为 `test/i18n-e2e`。

1. 新增中文/英文 × 1080p@125%/2K@150% 四组合 Electron UI smoke 矩阵，每组独立
   保存截图与报告，并显式校验 DPR、CSS viewport 和物理截图尺寸。
2. 自动执行请求语言到另一语言再恢复的运行时切换，覆盖面板标题、Image Search 空
   状态与错误提示、素材库 Category/Tag、备份视图和向量清理入口。
3. 为搜索结果、错误 toast、手工路径、备份和向量维护入口补充稳定测试标识；分类与
   标签创建按钮补充随语言变化的可访问名称。
4. 两种语言均检查关键控件无名称缺失、无重复名称、无越界裁切；smoke 面板按 viewport
   动态使用 4×2 布局，避免固定坐标掩盖 DPI 回归。
5. Windows 会把无边框窗口限制到任务栏以上的工作区；smoke 窗口改用内容尺寸和最小
   尺寸约束后，2560×1440@150% 不再丢失底部 48 个物理像素。

验证结果：

- `npm.cmd run smoke:ui:i18n`：4/4 通过。
- 中文 1920×1080@125% 与英文 2560×1440@150% 截图已人工检查，无面板重叠或关键
  控件截断。
- 语言切换、错误翻译、可访问名称和布局断言全部通过；Electron console error 为 0。

未覆盖边界：浏览器控制运行时在当前 Windows 环境无法写入 kernel assets，因此本批
使用项目内 Electron smoke 完成真实渲染验证。`ACC-02` 仍等待真实人工标注；下一项
可自动执行的 P1 TODO 为 `BLD-01`。

## 第五十三批：BLD-01 模型与工具物料 manifest

2026-07-31 完成，实际分支为 `build/resource-manifests`。

1. 新增统一 runtime manifest，覆盖当前 Windows x64 安装包的 10 个外部/生成组件和
   32 个运行制品，包含精确哈希、字节数、目标路径、用途、平台和默认随包策略。
2. Hugging Face 模型固定到 repository revision；本地导出或构建制品以制品 SHA-256
   和上游 revision/构建版本共同标识，不再用可漂移的 `main` 充当版本。
3. 许可证字段区分已登记、需要法律复核和等待项目许可证三种状态；YOLO、FFmpeg、
   AdaFace/OSNet 训练权重风险没有被清单自动宣告为“可商用”。
4. 下载模型 manifest 升级为 v2 并与统一分发清单自动交叉校验；现有 runtime 仍读取
   `models` 数组，兼容性不变。
5. 清单随 electron-builder 放入 packaged resources；资源 smoke 会阻止安装包漏带
   manifest。

验证结果：

- `npm.cmd run test:runtime-manifest`：5/5 通过。
- `npm.cmd run verify:runtime-resources`：10 个组件、32 个制品逐文件大小与 SHA-256
  全部一致。
- `npm.cmd run test:model-download`：20/20 通过，包含 packaged resource、release gate
  和新 manifest 契约。

未覆盖边界：本批只建立不可变物料事实和门禁，不执行联网获取，也不替代许可证法律
结论；非交互下载、临时文件、重试、代理、缓存与失败清理由 `BLD-02` 实现。
`ACC-02` 仍等待真实人工标注；下一项可自动执行的 P1 TODO 为 `BLD-02`。

## 第五十四批：BLD-02 非交互物料获取与校验

2026-07-31 完成，实际分支为 `build/resource-fetch`。

1. 新增非交互 CLI，严格从 runtime manifest 选择组件和制品；获取必须显式指定 cache，
   支持 clean target、offline、组件过滤、代理、超时和有界重试。
2. cache 按 SHA-256 内容寻址。target、cache、网络 partial 和发布前 target 四个阶段都
   校验字节数与哈希；损坏 cache 和 partial 会删除，失败不会发布半文件。
3. 只有 manifest 路径中已经完全匹配的文件可播种显式 cache；不会搜索用户目录或复用
   清单外残留。离线模式只接受已验证 cache。
4. 下载、本地构建、需要人工合规复核三种策略进入清单契约；manual/local 制品缺失时
   明确失败，禁止使用不受控替代地址。
5. 补齐 18 个模型伴随文件，清单由 14 个主文件扩展到 32 个完整运行物料；下载模型的
   config、preprocessor、tokenizer、vocabulary 和 Dense 投影不再依赖整目录残留。
6. release gate 在 package 前执行只读 `resources:verify`；资源工作流和命令记录在
   `resources/README.md`。

验证结果：

- `npm.cmd run test:runtime-manifest`：12/12 通过，覆盖 verify-only、显式 cache、
  offline、target 播种、重试、错误哈希清理和 manual policy。
- `npm.cmd run test:model-download`：27/27 通过。
- `npm.cmd run resources:verify`：10 个组件、32 个制品全部匹配，0 写入、0 错误。

未覆盖边界：本批不下载许可证仍待法律复核的 YOLO/FFmpeg，也不把本地编译 native/
OSNet 冒充上游二进制；它们可通过已验证 cache 进入 clean build。干净隔离环境重建、
SBOM 和统一物料报告由 `BLD-03` 完成。`ACC-02` 仍等待真实人工标注；下一项可自动
执行的 P1 TODO 为 `BLD-03`。

## 第五十五批：BLD-03 干净环境重建、SBOM 和物料报告

2026-07-31 完成，实际分支为 `build/reproducible-release`。

1. 新增双 pass 可复现构建入口：同一 commit 创建两个 detached worktree，每个 worktree
   都执行 `npm ci`，完成后默认强制移除，避免使用当前工作树的依赖或构建残留。
2. 第一遍要求 cache 初始为空，只能从显式 seed root 中与 manifest 完全匹配的 32 个
   制品播种；第二遍禁止播种与联网，只从同一内容寻址 cache 离线恢复。
3. 两遍均生成 CycloneDX SBOM 和统一物料报告，记录 Node、npm、Electron、
   electron-builder、完整 runtime 物料来源/许可证/大小/哈希，以及输出文件树。
4. package 模式保留 `win-unpacked` 并生成逐文件清单；release comparison record 同时绑定
   commit、lockfile hash、manifest hash、两遍安装器 hash 和所有报告相对路径。
5. 验收定义为 renderer、Electron 与所有非例外展开内容逐字节一致。NSIS 文件哈希必须
   记录，但归档元数据和未来签名时间戳造成的本体差异不伪装成源码或物料不可复现。
6. 首次真实双构建准确拦截了 45 个 package 差异，根因为 native PE/调试中间物嵌入临时
   worktree 路径。整改后固定 `SOURCE_DATE_EPOCH`、启用 MSVC `/Brepro`、
   `/experimental:deterministic` 和 `pathmap`，并从安装包排除仅供增量编译的 obj、tlog、
   PDB/IPDB、vcxproj 等文件。
7. 剩余差异收敛为 3 个同路径、同大小的 MSVC `.node` PE，以及由其哈希传递变化的
   `app.asar` 和主 EXE。comparison 只允许这 5 类逐项记录的 byte exception；路径增删、
   大小变化或任何 JS/资源/模型差异仍直接失败。

验证结果：

- `npm.cmd run test:reproducible-build`：10/10 通过。
- `npm.cmd run typecheck` 通过；脚本与测试通过 Prettier 格式检查。
- 独立双构建的最终判定以生成的 `comparison-report.json#ok` 为准；两份 SBOM 和物料报告
  均在 disposable worktree 清理前写入外部 evidence 目录。

未覆盖边界：当前项目仍未签名，签名和时间戳由 `REL-04` 闭环；项目许可证选择与第三方
声明由 `LIC-01`/`LIC-02` 继续处理。`ACC-02` 仍等待真实人工标注；下一项可自动准备的
P1 TODO 为 `LIC-01`。

## 第五十六批：QA-01 工具链、CI 与关键覆盖率基线

2026-07-31 完成，实际分支为 `ci/toolchain-and-coverage`。按用户要求暂时跳过
`LIC-01`/`LIC-02`，其状态继续保持待做，不生成虚假许可证结论。

1. Node/npm 固定为 24.16.0/11.13.0，版本同时写入 `.nvmrc`、`engines` 和
   `packageManager`，并开启 engine-strict；新增 CLI 与测试阻止元数据或实际运行时漂移。
2. 新增 Windows PR/main CI：干净安装、完整 verify、关键覆盖率与生产依赖审计全部作为
   同一必过门禁，使用 npm lockfile cache，不缓存 `node_modules`。
3. 真实模型与安装器另设手动受控 runner；显式 reviewed cache 离线恢复后才运行完整
   package、packaged resources、双语 UI 与 installer archive smoke，普通 PR 只走 fixture。
4. 关键覆盖率使用 Node 原生 test coverage，无新增测试框架依赖；逐文件覆盖 path/IPC、
   JSONL/metadata 事务、备份、vector GC、i18n、物料获取、release gate 和可复现构建。
5. 基线工具解析 TAP coverage 表，输出结构化 ignored 报告；专项回归覆盖版本漂移、报告
   前缀、单文件下降和 CI/受控 runner 边界。

验证结果：

- `npm.cmd run test:qa-toolchain`：5/5 通过。
- `npm.cmd run coverage:critical`：76/76 通过；行 82.30%、分支 70.86%、函数 82.67%，
  10 个关键文件均高于各自下限。
- `npm.cmd run toolchain:check` 通过；`npm.cmd audit --omit=dev --audit-level=high` 为 0 漏洞。
- detached clean worktree 从 `npm ci` 开始执行完整 `npm.cmd run ci:verify` 通过，包含全量
  test/native、renderer 构建、关键覆盖率和生产审计；不依赖主工作树 `node_modules`。

未覆盖边界：仓库当前没有 Git remote，因此不能伪造 GitHub-hosted workflow run；同一
命令已在本地 detached clean worktree 验证。受控 runner 需要维护者配置
`RUNTIME_RESOURCE_CACHE` 后手动触发。下一项可自动执行 TODO 为 `PRV-01`；许可证项仍暂缓。

## 第五十七批：PRV-01 已跟踪路径与账户标识脱敏

2026-07-31 完成，实际分支为 `docs/path-redaction`；`LIC-01`/`LIC-02` 继续按用户要求暂缓。

1. 扫描 Git 跟踪的文档与 JSON，将 Windows/Unix 用户目录、QQ 数字账户目录和微信 wxid
   统一替换为稳定语义占位符，历史 benchmark 仅保留脱敏后、可复核的指标数据。
2. benchmark wrapper 与中文语义搜索评估的默认原始输出从 `docs/benchmark/` 迁移到 ignored
   `artifacts/benchmark/`，防止真实文件路径再次进入版本控制。
3. 新增只扫描 Git 跟踪文本的 `privacy:check` 和可重复执行的 `privacy:redact`；未跟踪的用户文件
   不会被扫描或修改。
4. staged snapshot 快速验证在 typecheck/lint/format 前运行隐私门禁，覆盖普通及 JSON 转义的
   Windows 路径、macOS/Linux 用户目录、QQ 账户和微信账户标识。

验证结果：`npm.cmd run privacy:check` 通过，专项测试 4/4 通过；全部已修改 JSON 可解析。
下一项可自动执行 TODO 为 `GIT-01`；许可证项仍保持待做且不会阻断非发布类优化。

## 第五十八批：GIT-01 历史隐私审计与灾备前置门禁

2026-07-31 完成自动化准备，实际分支为 `chore/git-disaster-recovery`；任务保持进行中。

1. 新增全 refs 历史审计，覆盖文档/JSON 曾经删除或替换的 Windows/Unix 用户目录、QQ/微信
   账户目录与高置信凭据，避免只检查当前树造成“看起来已脱敏”的假象。
2. 当前审计为 1036 条历史隐私命中（Windows 用户目录 724、QQ 账户目录 296、微信账户 16），
   高置信凭据为 0；因此当前历史不能直接复制到新 remote、bundle 或裸仓库。
3. `git:backup` 已改为在创建任何输出前强制通过历史审计；测试覆盖当前树已脱敏、旧提交仍含
   路径时备份必须失败且不得留下目标目录。
4. 当前仓库没有 remote，多条已合并分支仍被外部 worktree 使用；本批没有删除分支，也没有
   修改或纳管用户的 `start.bat`。

未覆盖边界：清除旧提交需要重写全部相关 refs，会改变提交哈希并影响现有 worktree；永久灾备
位置也必须由用户选择。获得这两项明确授权后，才能完成历史净化、裸仓库恢复演练和安全分支
清理。许可证项继续暂缓。

## 第五十九批：DEP-03 第一组终端依赖迁移

2026-07-31 完成第一组实现，实际分支为 `build/ecosystem-upgrades`；DEP-03 保持进行中。

1. 将已弃用的 `xterm@5.3.0` 替换为 `@xterm/xterm@5.5.0`，同步迁移全局 CSS、类型导入和
   远程终端的按需动态加载；FitAddon 继续使用兼容的 `@xterm/addon-fit@0.11.0`。
2. 将只用于 TypeScript 编译的 `@types/ssh2` 移入 devDependencies，并增加 package/lockfile
   契约，阻止旧包名和错误依赖归类回流。
3. 远程终端测试 4/4、依赖与安全门禁 20/20、类型检查和 renderer/Electron bundle 构建通过；
   `npm audit --omit=dev --audit-level=high` 为 0。
4. 完整树当前 26 个 high 全部来自 ESLint/electron-builder 开发链，将在 DEP-03 后续分组
   处理，不进入当前生产安装依赖。

验证边界：主工作树中用户正在运行开发版 Electron，进程占用 `fast_scanner.node`，因此没有
强制关闭用户窗口；完整验证改在隔离 staged snapshot 中重建 native。packaged smoke 将在完成
后续生态分组并生成最终候选包后统一执行。

## 第六十批：DEP-03 第二组 ESLint 10 flat config

2026-07-31 完成第二组实现，继续使用 `build/ecosystem-upgrades` 分支；DEP-03 保持进行中。

1. ESLint 8.57、TypeScript ESLint 7 升级至 ESLint 10.8、TypeScript ESLint 8.65，并将
   `.eslintrc.cjs` 完整迁移为 `eslint.config.cjs` flat config。
2. `@eslint/js`、eslint-config-prettier、React Hooks plugin 和 globals 使用兼容版本；最终
   `npm ls --all` 无 invalid peer，lint 命令不再使用旧配置下的 `--ext` 参数。
3. 新核心规则先显式维持旧行为，3 处动态 require 的局部例外迁移到新规则名；lint 仍为
   0 错误、5 条既有警告，规则债务由 ARC-01 集中清理。
4. 完整依赖审计由 26 high 降至 16 high，剩余项全部属于 electron-builder 开发/打包链；
   生产依赖审计仍为 0。

验证边界：继续使用隔离 staged snapshot 执行完整 verify，避免关闭正在运行的开发版 Electron。
下一组处理 Vite 及其 Electron/React 插件，最终候选包生成后统一执行 packaged smoke。

## 第六十一批：DEP-03 第三组 Vite 7 构建链

2026-07-31 完成第三组实现，继续使用 `build/ecosystem-upgrades` 分支；DEP-03 保持进行中。

1. Vite 6.4 升级至 7.3，`@vitejs/plugin-react` 升级至 5.2，
   `vite-plugin-electron-renderer` 升级至 1.0；Node 24 与全部 peer 约束匹配。
2. 实测拒绝 `vite-plugin-electron@1.1`：它在 Vite 7 下将仅属于 Rolldown 的 `platform`
   选项传给 Rollup，导致 11 个 Electron 入口出现 unknown-option 警告；改用无警告的 0.29.1。
3. 146 个 renderer 模块以及 main、preload、worker/child 全入口构建为 0 warning；主 renderer
   gzip 从约 102.18 KiB 降至约 101.41 KiB，并新增版本组合 lockfile 契约。
4. 类型检查与 lint 通过，生产依赖审计为 0；开发树剩余 16 high 仍全部来自
   electron-builder 打包链，与本组 Vite 运行时无关。

验证边界：本组完成后继续在隔离 staged snapshot 执行完整 verify。下一组处理 React、React DOM
和 Zustand；全部生态分组结束后统一生成最终候选安装包并执行 packaged smoke。

## 第六十二批：DEP-03 第四组 React 19 与 Zustand 5

2026-07-31 完成第四组实现，实际分支为 `build/react-state-upgrades`；DEP-03 保持进行中。

1. React 与 React DOM 从 18.3.1 升级至 19.2.8，Zustand 从 4.5.7 升级至 5.0.14；React 类型
   定义同步升级至 19.2，并增加 package/lockfile 版本组合契约。
2. 全量检查两套 store 的组件订阅：selector 均直接返回 store 中的稳定字段，没有返回临时数组
   或对象；renderer 入口已使用 `createRoot`，不存在 React 19 移除的旧 ReactDOM 挂载 API。
3. 类型检查、UI smoke 契约 6/6、依赖安全门禁 23/23、lint（0 error、5 条既有 warning）和
   renderer/Electron 全入口构建通过；生产依赖审计保持为 0。

验证边界：本组继续使用隔离 staged snapshot 执行完整 verify，避免关闭正在运行的开发版
Electron。后续分组处理其余生态依赖；全部分组结束后统一生成候选安装包并执行 packaged smoke。

## 第六十三批：DEP-03 生态升级收尾与 packaged 验证

2026-07-31 完成，实际分支为 `build/dep03-packaged-smoke`；DEP-03 状态改为已验证。

1. node-gyp 由 13.0.0 更新至 13.0.1，Node 24 与 Electron 42.8 两套 ABI 原生重建成功，native
   测试 42/42 通过；Prettier 3.9 会引入 8 个无关格式差异，最终保留已验证的 3.8.4。
2. 全新候选安装器大小 968.51 MiB，包含 273 个归档文件，SHA-256 为
   `1B0EDDBDD3DE70656F46D2D45D25E4428F291BC262F79D4D3DC0A98C933F588C`；归档 smoke 通过。
3. packaged 资源清单 28/28 通过，无缺失、历史重复或路径越界；`zh-CN`、`en` UI smoke 均
   通过，7 个面板完整、控制台错误为 0，模型、媒体工具与 native addon 均从 packaged resources
   真实加载。
4. Vite 8/React 插件 6、Xterm 6、Electron 43、TypeScript 7 与 Undici 8 被登记为下一代升级
   边界，不违反“禁止一次跨越所有 major”的分组原则。完整开发树仍有 electron-builder 打包链
   的 16 个 high registry 报告，生产依赖审计为 0，且当前 electron-builder 已是最新稳定版。

验证边界：本批完成 DEP-03，不改变许可证、签名和正式 release record 的状态；许可证闭环继续
按用户要求暂缓，当前安装器仅作为内部验证候选，不标记为正式对外发布。

## 第六十四批：ACC-02 人工复核队列与 dataset 审计绑定

2026-08-01 完成自动化增量，实际分支为 `test/neko-accuracy-dataset-workflow`；ACC-02 保持进行中。

1. 新增 `annotation:neko:plan`，生成 ignored 的匿名工作计划和 class-map 模板；候选 ID、类别
   覆盖、正负样本数量、最低复核数与失效项可审计，源文件路径不写入计划。
2. manual 审计事件现在必须绑定当前 dataset SHA-256；旧 dataset 的同候选事件不能继续贡献
   70% 人工占比。严格计算后当前有效人工数为 0，最低需要 103 项，复核队列有 146 项。
3. 标注 UI 把 seeded 和旧指纹判断纳入优先队列，用户可直接确认已有标签并自动进入下一项；
   新保存事件绑定当前 dataset，避免“候选全有标签但人工门禁无法推进”的死路。
4. 当前素材库检测到 6 个类别、其中 5 个有 confirmed 正样本，数量上满足五类准备条件；三个
   类别仍使用无语义测试名称，工具不会自动猜测成物品、动物或场景。1 个失效候选也无法通过
   assetId 找到新路径，因此保持显式阻断。
5. annotation smoke、dataset-bound audit、人工复核队列、NekoSearch/聚类测试 27/27 和 lint
   均通过；新增契约阻止删除复核队列或重新接受旧 dataset 事件。

未覆盖边界：ACC-02 仍需用户为五个真实类别确认语义映射，并在当前 dataset 上完成至少 70%
可审计人工判断；本批没有修改用户类别、自动确认标签或把测试性类别名称伪装成真实分类。

## 第六十五批：人工与合规任务暂缓状态进入自动队列

2026-08-01 按用户决定暂缓 ACC-02；此前已明确跳过的 LIC-01/LIC-02 同步使用正式“暂缓”
状态。TODO 解析器新增 deferred 统计，暂缓项不会成为 selected/ready，但依赖它们的 ACC-03、
REL-04、SIZE-01 等任务仍保持阻断关系。GIT-01 的自动化准备已完成，但历史重写授权与永久
备份位置尚缺，因此从“进行中”校正为“阻塞”。当前没有可在不扩大授权或伪造人工结论的前提下
继续自动完成的 TODO；所有已生成标注计划、断点和工具均保留。

## 第六十六批：SEC-01 GPU 缩略图子窗口最小权限隔离

2026-08-01 完成，实际分支为 `fix/gpu-thumbnail-sandbox`。ACC-02 与许可证发布链按用户要求
暂缓后，本项作为技术上独立的 P2 安全整改提前执行，不改变正式发布阻断结论。

1. GPU 隐藏 BrowserWindow 关闭 Node 集成，开启 context isolation、sandbox 与 web security，
   使用独立非持久 session partition；新窗口、导航、webview、权限检查和权限请求全部拒绝。
2. 新增独立 preload，只暴露任务输入、结果、取消与健康状态；GPU 页面移除 Electron
   `require`，无法访问通用 Node API，主进程消息仍按精确 sender webContents ID 授权。
3. 主进程和隔离 preload 双重校验输入 MIME、32–256 px 尺寸、64 MiB 输入与 8 MiB 输出；
   每窗口单任务串行、池上限 8，超时任务收到取消信号并进入既有 CPU fallback。
4. 构建新增固定 `thumbnailGpuPreload.js` 入口并同时维护两套受跟踪 Vite 配置，防止开发/CI
   配置漂移导致 preload 漏包。
5. 专项测试 10/10、typecheck 和完整 Electron/renderer bundle 通过；真实 Electron GPU smoke
   在 NVIDIA WebGL 上完成 3/3 张 fixture，GPU 243 ms、0 CPU 回退、0 错误。

未覆盖边界：本批不处理全应用 IPC 能力矩阵，该工作由下一项 SEC-02 完成；也未重启用户现有
开发实例。许可证、人工准确率门禁、签名与 release record 仍未闭环，当前构建不是正式发布。

## 第六十七批：SEC-02 IPC 授权、能力矩阵与领域契约

2026-08-01 完成，实际分支为 `refactor/ipc-capabilities`。

1. 全部 248 个 renderer invoke handler 与单向文件拖拽 handler 迁移到统一安全包装器；只有
   显式登记的主窗口 webContents、main frame 和可信 file/loopback origin 可以进入业务逻辑。
2. 能力声明覆盖 `R/W/FS/EXT/PROC/NET/SECRET`，按受控 domain 与操作解析；未知通道在应用
   启动注册阶段直接失败，不允许新增 handler 后遗漏矩阵。
3. 公共 payload validator 限制参数数、字符串、集合、二进制、嵌套层级、对象 key，并拒绝
   循环对象、非有限数值和 structured-clone 不支持类型；业务 handler 的语义校验继续保留。
4. IPC 契约测试升级为 TypeScript AST 比较，同时解析字面量和共享常量；preload、main 与
   capability/validator 任一侧漂移都会失败。validator 的正常、超限、循环与异常数值另有单测。
5. `shared/ipc-contract.ts` 从 1,634 行拆至 893 行；新增 App Core、App Storage、File Manager、
   Image/Vector、Remote Terminal、Subject/SAM/Batch Rename 领域文件，与已有 Media/Asset
   共同形成 9 个领域模块，并以原入口保持兼容。
6. IPC/Preload 专项 9/9、typecheck、lint 0 error 和完整 Electron/renderer bundle 通过；真实
   中文 UI smoke 覆盖 7 个面板、语言切换、素材库变更及备份恢复，console error 为 0。

未覆盖边界：GPU 子窗口内部专用消息继续由 SEC-01 的精确 sender 校验和最小 preload 管理，
不暴露给主 renderer。人工标注、许可证、签名与 release record 仍暂缓/阻断；ARC-01 在 SEC-02
后可独立执行，但完成它也不会使当前构建成为正式发布。

## 第六十八批：ARC-01 维护热点、严格 lint 与多屏布局收尾

2026-08-01 完成，实际分支为 `refactor/maintenance-hotspots`。

1. 启用并清零 `no-useless-assignment`、`preserve-caught-error`，移除 5 条既有警告；事务恢复、
   文件替换、备份和元数据读取的新错误继续通过 `cause` 保留底层异常。
2. 把缩略图磁盘缓存及 PSD 预览解析从 `thumbnailIpc.ts` 拆成两个单职责模块；主进程启动清理、
   IPC 清缓存、旧 v4 文本缓存兼容、v6 二进制缓存和有界 stat 并发均有回归约束。
3. UI smoke runner 新增 `--work-area=x,y,width,height`，主进程可注入负坐标合成工作区，报告校验
   实际 BrowserWindow bounds。双语矩阵新增 1366×768@125% 小屏及负坐标副屏，连同原有
   1920×1080@125%、2560×1440@150% 共 6/6 通过，均为 7 个面板、0 console error。
4. 新增 Windows 数据目录规范，将 Roaming 下的 Electron `userData` 定为唯一受管理运行时根；
   明确 Local 安装/源码/构建目录不是用户数据。设置页“打开配置目录”更名为“打开应用数据目录”。
5. 专项 `typecheck`、ESLint、缩略图安全回归、UI smoke contract 及完整 `verify` 均已通过。
   ACC-02、LIC-01/LIC-02 继续暂缓，GIT-01 仍等待历史重写授权与备份位置。

## 第六十九批：LIC-01 随包许可证物料工程准备

2026-08-01 在不代替版权负责人选择项目许可证、不生成法律批准结论的边界内完成工程准备，
实际分支为 `docs/release-licenses`；LIC-01/LIC-02 状态继续保持暂缓。

1. 从权威 runtime manifest 确定性生成 10 个实际随包组件的版本、SPDX、审查状态和制品数量
   清单；手工清单与 manifest 漂移时测试直接失败。
2. 删除 notices 中“模型不随包”和“默认只包含商业友好许可证组件”的过期陈述，显式保留
   AGPL YOLO、GPL FFmpeg、AdaFace/OSNet 训练数据来源以及项目许可证待审状态。
3. electron-builder 将 notices 与生成清单复制到 `resources/legal/`；packaged resources
   inventory 新增两个必需项，缺失时发布资源 smoke 失败。
4. 新增许可证物料专项测试，覆盖 10/10 manifest 组件、生成文件一致性、待审状态不可被静默
   改成批准，以及安装包复制配置。

未覆盖边界：项目许可证、完整许可证正文、FFmpeg 对应源码/书面提供方案、YOLO 分发授权、
AdaFace/OSNet 训练数据条款仍需授权负责人或专业审查。未获得结论前不得完成 LIC-01、启动
LIC-02 或把内部安装器标记为公开发布版本。SIZE-01 后续按用户明确指令只实施技术瘦身，
不继承任何许可证批准结论。

## 第七十批：SIZE-01 在线/离线安装包瘦身

2026-08-01 完成，实际分支为 `task/size-01-package-size`。用户明确选择安装包瘦身后，本批在
LIC-02 仍暂缓的前提下只验证产物结构与体积，不改变公开发布阻断结论。

1. 新增 offline/online package profile；默认 `npm.cmd run build` 继续等同完整离线包，
   `npm.cmd run build:online` 生成独立的 `FloatingClock Online Setup` 安装器。
2. 在线包不复制模型实体、`ai-models` 和 FFmpeg 工具，只保留模型下载 manifest；构建时同步
   生成 profile 专属 runtime manifest 与第三方 bundled 清单，避免声明与真实产物漂移。
3. packaged resource smoke 根据 runtime profile 使用 19 项 online 核心契约或完整 offline
   契约；安装包归档、清理与命名脚本均支持 profile，并增加相应自动测试。
4. 真实构建的在线安装包为 168,906,813 字节（161.08 MiB），相对 968.51 MiB 基线减少
   83.37%；241 个归档文件完整性检查通过，SHA-256 为
   `99A09DD8C1C5EF330EA9271A768202831110137FE55FE39D559B5EE954B37115`。
5. 真实解包资源 smoke 通过 19/19，`ai-models` 与 `tools` 不存在，`models` 仅包含
   `manifest.json`；profile 专项与模型/许可证测试共 37/37 通过。
6. 中文 packaged UI smoke 通过：7 个面板、语言往返、素材库交互、备份验证/恢复全部成功，
   0 console error；DINO/CLIP 路径为空，native addon 来自 resources，FFmpeg 使用系统命令。

未覆盖边界：在线包不保证所有模型在 UI 中自动下载，未准备对应缓存时相关能力按现有运行时
行为降级或不可用；FFmpeg 依赖用户配置或系统发现。LIC-01/LIC-02、签名和 REL-04 仍未完成，
该安装器不得标记为正式公开或商业发布版本。

## 第七十一批：GIT-01 历史净化、灾备与分支收敛

2026-08-01 完成，最终记录分支为 `docs/git01-finalize`。用户明确授权重写全部 refs，并采用
`D:\ReasonixGitBackups\git01-20260801` 作为本次永久灾备目录。

1. 重写前创建包含 105 refs、117 个可达提交的独立敏感 mirror，并通过完整对象检查；主项目
   `start.bat`、Asset Suggestions 的 patch/未跟踪 hook，以及 DSK-01 的 8 个源码文件均已
   单独快照，避免历史切换或 worktree 清理丢失未提交内容。
2. 全 refs 将实际用户名、QQ 数字账户和微信账户标识替换为稳定占位符；历史审计由 1,036 条
   降为 0，凭据命中保持 0。重写前后 `main` tree 均为
   `186cfde5ca84a30950ed94ce0eb695f676845b80`，业务内容完全一致。
3. 隔离验证过程中曾有一次 `--refs` 通配形式未产生任何 ref 变化，候选被拒绝；第二次调用的
   工作目录参数错误使全 refs 过滤提前作用于主仓库。因重写前镜像和脏文件快照已完成，操作
   立即停止在清理前并执行恢复审计；新主仓库通过 0 命中、tree 一致、`fsck` 和无不可达旧
   对象四项检查，因此没有从旧镜像回滚，也没有丢失工作区数据。
4. 32 个旧 worktree 经绝对路径白名单检查后移除；104 个本地分支逐一通过 ancestor 检查后
   使用 `git branch -d` 删除。收尾分支合入并移除后，活动开发分支只保留 `main`。
5. 脱敏后的 clean bundle、bare repository 和恢复克隆均写入灾备目录；分别验证 bundle、
   bare 对象完整性以及恢复克隆 `main` tree 一致性。

安全边界：`pre-rewrite-sensitive.git` 与 `dirty-worktrees/` 是包含旧隐私记录或未提交代码的本地
应急材料，不得上传。正式远端只能从 clean bare/bundle 或当前净化后的 `main` 建立；bundle
不包含 ignored 安装包、模型、构建缓存或用户数据库，这些仍需使用独立的数据备份策略。

## 第七十二批：LIC-01/LIC-02 许可证合规执行门禁

2026-08-01 开始，实际分支为 `task/license-compliance-gate`。本批把许可证要求从说明性材料
升级为发布执行门禁，但不代替版权负责人、授权负责人或专业顾问作出法律结论；LIC-01/LIC-02
状态改为进行中。

1. 新增 `legal/license-decisions.json`，为项目许可证和 runtime manifest 的 10 个组件提供
   结构化审批槽位；所有初始决定均为 pending，不把未知授权状态伪装为通过。
2. 新增 profile-aware `licenses:gate`：逐项验证审批状态、受支持的处置类型、offline/online
   适用范围、审批人、时间、证据及实际存在且不越界的许可证文件；未知组件、空文件列表和缺失
   文件均为阻断项。
3. release gate 在资源清单核验后、生产依赖审计和打包前运行许可证门禁。门禁失败时不会执行
   package，也不会生成成功的 release record。
4. 当前 offline 检查阻断全部 10 个随包组件；online 检查只阻断唯一随包的 native addon，
   同时列出 9 个未随包但仍待决的模型/工具。两种 profile 均继续因项目许可证、许可证正文和
   审批证据缺失而阻断。
5. electron-builder 将决策记录复制为 `resources/legal/LICENSE_DECISIONS.json`；packaged
   resources smoke 和许可证物料测试都把它列为必需文件，防止源码决策与安装器材料漂移。

未覆盖边界：项目发布模式与许可证表达式、项目 `LICENSE`/EULA、YOLO 分发授权、FFmpeg
构建配置及源码提供义务、AdaFace/OSNet 训练数据条款、native addon 项目许可证仍需真实
负责人决策和证据。门禁实现完成不等于上述法律事项已获批准，当前构建仍不得标记为正式公开
或商业发布版本。

## 第七十三批：商业首发用户模型平台与待审模型退包

2026-08-01 完成工程实现，实际分支为 `task/model-platform-first-release`。用户明确选择把待审
模型从首发安装包移除，并把产品调整为由用户自行选择模型的本地平台；本批不替用户授予或判断
第三方模型权利，LIC-01/LIC-02 保持进行中。

1. Ultralytics YOLOv8n、Lindevs YOLOv8-Face、AdaFace WebFace12M、OSNet-AIN 与
   PulpCut MobileSAM ONNX 的 `defaultBundled` 改为 false；electron-builder 仅从
   `models/` 复制安全下载 manifest，不再复制上述 6 个 ONNX 文件。offline packaged
   resources 契约同步删除这些必需项。
2. Lindevs 模型使用 Ultralytics YOLOv8 初始权重，PulpCut ONNX 仓库又缺少独立模型卡和
   明确转换制品授权；二者从普通 `recorded` 降级为 `legal-review-required`。生成的第三方
   清单和 notices 明确区分“随包资源”与“用户可选候选”。
3. 新增 6 个固定接口兼容槽位：主体检测、人脸检测、112×112/512 维人脸特征、
   256×128/512 维行人重识别、SAM-compatible encoder 和 decoder。每个槽位只接受单个
   `.onnx` 文件、限制为 1 GiB，并记录文件名、大小、SHA-256 和安装时间。
4. 设置页新增双语模型平台：用户必须确认自行负责许可证与接口兼容性，之后才能通过系统文件
   选择器导入/替换模型；可独立移除槽位或打开受管模型目录。应用不保存原始来源路径，也不为
   待审模型提供静默下载或内置 URL 安装按钮。
5. 四条推理链改为从用户数据目录动态解析模型；文件被替换时按大小和 mtime 重建 ONNX
   session。缺失或加载失败仍分别回退到显著性裁剪、DINO 全身路径或功能不可用结果，不会使
   主进程崩溃。
6. 模型/资源/许可证/发布门禁专项 47/47、IPC 授权与注册 11/11、主体相关有效回归 31/31
   通过；另有 4 条依赖真实模型文件的推理测试按预期跳过。TypeScript 与 ESLint 通过。

边界：导入成功只证明文件已安全复制和留有哈希记录，不证明 ONNX 接口或法律许可有效；首次
推理才会建立 session 并验证运行兼容性。当前适配器也不是任意架构插件系统。FFmpeg full
build、项目专有 EULA、native addon 和其余随包依赖审批仍阻断正式商业发布。

## 第七十四批：用户模型兼容配置与多导出适配

2026-08-01 在 `task/model-profile-adapters` 实施。固定六槽位的安全边界保持不变，但每个槽位
从单一硬编码接口升级为显式兼容配置，用户导入前必须选择与模型导出方式一致的配置。

1. 主体检测支持 YOLOv8/9 风格无 objectness 输出、YOLOv5/7 风格 objectness 输出，以及
   `[N,6]` 已执行 NMS 的通用检测输出；前两类同时接受 channel-first 与 row-first 输出方向，
   类别数和 anchor 数不再固定为 80/8400。
   若 ONNX input metadata 提供固定空间尺寸，运行时采用该尺寸；符号/动态尺寸才使用配置默认值，
   因此同一 adapter 可覆盖常见 320/416/640 等导出分辨率。
   主体配置另行区分 COCO 与自定义类别；自定义类别只显示数字，不会把 class 0 误当作 person。
2. 人脸检测支持带或不带五点 landmark 的 YOLO face 输出及 `[N,6]` NMS 输出。输入和输出
   tensor 名称采用常见名称优先、部分名称匹配、首 tensor 兜底，不再硬编码
   `images/output0`。
3. 人脸特征新增 ArcFace/AdaFace 112 与 FaceNet 160 配置；行人 ReID 新增 Torchreid/OSNet
   256×128 和 FastReID 384×128 配置。特征输出维度从实际 tensor 推导，ReID 动态 batch
   失败时自动回退 batch 1；不同维度向量拒绝相似度比较。
4. SAM encoder 同时支持 HWC `[1024,1024,3]` 与 NCHW `[1,3,1024,1024]`，encoder 实际
   embedding shape 会传给 decoder；decoder 的常见输入输出名称也采用兼容解析。
5. 安装元数据升级为 schema v2 并记录 `profileId`，旧 schema v1 模型按槽位默认配置继续
   兼容。模型与安装元数据在完整临时槽位中准备后一次性发布，不会出现新模型绑定旧配置。
   session、人物特征与 SAM embedding 缓存键包含文件签名和配置，替换后不会复用旧模型向量。
6. 设置页为每个槽位增加兼容配置下拉框，显示已安装模型实际使用的配置、文件和大小；配置
   选择不会扩大许可证授权，用户责任确认与不随包策略保持不变。
7. TypeScript、ESLint、Prettier、模型/发布专项 53/53、IPC 11/11、UI smoke 契约 6/6
   通过；人脸/主体有效回归 31/31 通过，4 条依赖真实模型的推理测试按预期跳过。renderer、
   Electron、native addon 和安装器构建完成；隔离工作树缺少 ignored `ai-models`，因此本批未把
   该构建当作 packaged runtime 资源 smoke 通过证据。

边界：ONNX 图无法可靠表达训练时颜色通道、归一化和输出语义，因此平台不会声称自动兼容任意
模型。当前覆盖的是列出的常见导出契约；SCRFD/RetinaFace 多头输出和独立
boxes/scores/labels 多 tensor 检测结果在后续批次补齐，SAM2 和文本提示分割仍需要独立
adapter。没有真实模型文件的配置只能
完成纯张量契约与结构测试，正式列入“已验证模型”仍需对应制品的端到端基准。

## 第七十五批：模型图诊断、分离输出与 SCRFD 适配

2026-08-01 在 `task/model-diagnostics-multioutput` 实施，继续扩展受控 adapter，不改变用户
模型不随包和许可证责任边界。

1. 新模型在替换现有槽位前由 ONNX Runtime CPU session 读取 graph metadata；导入记录升级
   为 schema v3，保存 input/output 名称、类型、shape、检查时间和结论。无效 ONNX 或与所选
   配置存在可静态证明的不匹配时拒绝导入，旧槽位通过目录级事务保持原状。
   graph metadata 限 128 个输入/输出、256 字符 tensor 名、8 维 shape 和 64 字符符号维度，
   安装记录读取限 256 KiB 并重新净化诊断字段，防止恶意模型或手工修改用异常元数据放大
   IPC/UI 负载。
2. 设置页显示“图结构已检查”和完整 input/output 摘要；schema v1/v2 的旧模型显示待重新
   导入检查，不伪造历史诊断结论。
3. 主体与人脸检测增加分离 tensor adapter：boxes 与 scores 必需，labels 可选；scores 可为
   每框一个分数或 `[N,C]` 类别矩阵，box 使用 `x1,y1,x2,y2`，仍支持归一化或输入像素坐标。
4. 人脸检测增加 SCRFD stride 8/16/32 解码、双 anchor、距离 bbox 与可选五点 landmark。
   同时支持输出名包含 score/bbox/kps+stride 的具名图，以及 InsightFace 常见数字输出名下的
   分组顺序（3 score、3 bbox、可选 3 kps）。
5. 图诊断对 split adapter 检查 boxes/scores，对具名 SCRFD 检查每个 stride 的 score/bbox，
   对顺序 SCRFD 检查 6/9 输出，对 SAM decoder 检查全部必需输入和 masks/IoU 输出。
6. TypeScript、ESLint、Prettier、模型/发行专项 55/55、IPC 11/11、UI smoke 契约 6/6、
   主体有效回归 31/31 通过，4 条真实模型测试按预期跳过；renderer 与 Electron bundle 构建
   通过。本批没有真实 SCRFD/split-output 制品，因此其“已支持”限于纯张量解码和 graph
   契约，尚未进入已验证模型清单。

边界：graph metadata 只能验证结构，不能证明归一化、坐标语义、准确率或许可证。RetinaFace
prior-box 多头在第七十六批补齐；YOLO segmentation、SAM2 和文本提示模型仍需独立 adapter
与真实制品回归。

## 第七十六批：RetinaFace prior-box 适配

2026-08-01 在 `task/retinaface-adapter` 实施，继续遵守模型不随包、用户自行选择并确认许可证
责任的发布策略。

1. 人脸检测新增 RetinaFace MobileNet 常见 `loc/conf/landms` 三输出 profile；支持按常见名称
   识别，也支持名称不完整时按导出顺序绑定三个 tensor。
2. 输入使用 NCHW、RGB 转 BGR 并分别减去 `104/117/123` 均值，不复用 YOLO 的 0–1
   归一化。默认输入 640×640，并继续接受图 metadata 中安全范围内的固定尺寸。
3. 解码按 stride 8/16/32、每层两组 min-size（16/32、64/128、256/512）生成 prior，使用
   0.1/0.2 variance 解出归一化 bbox 与五点 landmark；置信度兼容单列或背景/人脸双列。
4. graph 诊断要求恰好三个输出，并检查 loc、conf、landms 尾维分别为 4、1/2、10；运行时
   另行核对 anchor 数、prior 数和全部 tensor 元素数，异常模型不会静默得到错误结果。
5. TypeScript、ESLint、Prettier、模型/发行专项 56/56、IPC 11/11、UI smoke 契约 6/6
   与人脸有效回归 7/7 通过，1 条依赖真实模型的推理测试按预期跳过；renderer 与 Electron
   bundle 构建通过。按本批范围未执行完整安装包构建。

边界：本批只用确定性纯张量样例验证预处理、prior 和解码，没有引入或下载 RetinaFace 权重，
也不对任意同名模型的训练参数、精度或许可证作保证。不同 prior 配置的 RetinaFace 变体仍需新增
独立 profile，不能直接选择本配置。

## 第七十七批：专有发布模式预配置

2026-08-01 用户确认项目采用闭源商业软件与专有 EULA，模型继续由用户自行取得和安装；版权
主体名称明确暂不填写。本批只固化可确定的工程选择，不把缺失主体和法律复核伪造成批准。

1. `package.json` 增加 `private: true` 与 `license: UNLICENSED`，防止项目被误当作开源包或由
   `npm publish` 意外发布；这两个字段不替代最终 EULA。
2. `legal/license-decisions.json` 将项目方向记录为 `proprietary/UNLICENSED`，状态仍为
   `pending`，`licenseFile`、审批人和审批时间继续为空，并明确待补版权主体、最终条款和证据。
3. 新增 `legal/PROPRIETARY-EULA.template.md`，包含主体、销售区域、设备授权、退款、隐私、
   消费者权利、责任限制和管辖法律等必填项。文件醒目标记为不可分发，并且不会复制进安装包。
4. 许可证门禁拒绝文件名包含 `draft` 或 `template` 的项目许可文件，避免只修改决策 JSON 就把
   草案误当成正式 EULA。专项测试锁定 proprietary 选择、发布阻断和模板不随包三项边界。
5. TypeScript、ESLint、Prettier 和模型/发行专项 58/58 通过；online/offline 许可证门禁均按
   预期失败，其中项目阻断精确收敛为未批准、缺少最终 EULA、审批元数据不完整三项。

边界：LIC-01 仍为进行中。版权主体名称、最终 EULA、授权审批人与证据未完成；LIC-02 的
FFmpeg、native addon 和随包模型/编码器许可也未因此获得批准，online/offline release gate
必须继续失败关闭。

## 第七十八批：FastScanner 解码安全预算

2026-08-01 在 `fix/fastscanner-decode-limits` 实施 FS-01，保持哈希算法、索引格式和用户数据
不变，只收紧不可信图片进入 native 解码器前的资源边界。

1. 新增共享 `image_decode_limits.h`：单边最大 32768、源图最大 100,000,000 像素、stb
   解码像素缓冲最大 256 MiB；所有乘法使用溢出安全检查。
2. stb 路径先用 `stbi_info_from_memory` 读取头部并校验预算，再调用实际解码，覆盖同步/异步
   hash、相似搜索和扫描路径；同时定义 `STBI_MAX_DIMENSIONS` 作为解码库内部第二道边界。
3. WIC JPEG hash 路径和 native 缩略图重建复用同一源尺寸/像素规则，缩放目标缓冲也单独
   校验；失败原因返回明确的 dimension、pixel 或 memory budget，不再只报告通用解码失败。
4. `getNativeStatus()` 暴露当前三项限制，便于 packaged runtime 诊断。FastScanner 升级到
   0.5.2，Electron ABI 产物重新构建，runtime manifest 同步更新大小和 SHA-256。
5. 新增伪造 BMP 头回归，证明超单边、超像素和超解码内存输入在分配前失败；Node 24 与
   Electron 42 native 构建通过，native 专项 46/46 通过。

边界：本批未实施并行扫描、异步停止或全局状态拆分，也未执行完整安装包构建。合法但超过预算
的超大图片会被安全跳过并进入既有失败记录；后续若要支持超大专业图，应增加真正的流式/分块
解码 profile，而不是放宽 stb 全图内存预算。

## 第七十九批：FastScanner 异步停止与暂停唤醒

2026-08-01 在 `fix/fastscanner-async-stop` 实施 FS-03，不改变哈希算法、索引格式和用户数据。

1. 新增 `stopScanAsync()` Promise 接口：停止信号在调用时立即发布，线程 join 转移到 N-API
   异步工作队列，Electron 主线程不再因等待扫描线程退出而冻结；原同步 `stopScan()` 保留为
   兼容和进程清理回退。
2. 暂停扫描从 100 ms 轮询改为条件变量等待；继续、停止和扫描自然结束都会唤醒等待线程，
   暂停期间不再周期性唤醒耗费 CPU。
3. 启动、停止、清空索引共享扫描生命周期锁；停止期间拒绝新扫描，活动扫描或异步停止期间
   拒绝清空索引，避免线程替换、join 和索引销毁交错。
4. Electron 服务先停止轮询并发布“正在停止”，再等待 native Promise；旧 native ABI 自动回退
   同步停止。FastScanner 升级到 0.5.3，Electron ABI 产物及 runtime manifest 哈希同步更新。
5. 新增暂停后重复异步停止、活动期清索引拒绝和停止后重新扫描回归；Node 24 与 Electron 42
   native 构建、TypeScript、定向格式检查和新增原生测试通过。

边界：本批未实施有界并行扫描流水线或 native 全局状态实例化，也未执行完整安装包构建。
进程退出仍由 native cleanup hook 最终同步收尾，以保证模块卸载前线程和映射资源已经释放。

## 第八十批：FastScanner 有界并行扫描流水线

2026-08-01 在 `feat/fastscanner-bounded-pipeline` 实施 FS-02，不改变解码预算、哈希算法、索引格式
和用户数据。

1. 目录枚举和 USN 路径收集作为生产端，固定两个 scan worker 并行执行读取、解码、双哈希与
   索引写入；路径队列容量固定为 64，队列满后生产端等待，避免扫描大目录时无界积压路径或
   图片缓冲。
2. worker 数量未按 CPU 核数无限扩展。结合每张图片 256 MiB 的原始解码像素缓冲预算，两个
   worker 将该类缓冲的理论峰值限制在约 512 MiB；文件字节、灰度缓冲和缩略图工作池另计，
   缩略图生成继续使用其独立有界队列。
3. 停止信号同时唤醒暂停条件变量和扫描队列条件变量；队列生产者、消费者和异步 join 都可
   在停止时退出。共享性能计时改为原子累计，缩略图入队状态检查纳入互斥区。
4. native progress/status 新增 worker 数、队列容量、待处理数量、当前活跃数和峰值活跃数；
   Electron 状态透传这些指标，并修复 paused 被误判为扫描完成、提前停止轮询的问题；空闲或
   停止中的扫描不再接受暂停/恢复命令。
5. FastScanner 升级到 0.5.4；并发回归验证峰值同时活跃两个 worker、队列不超过 64，并覆盖
   暂停、重复异步停止、清索引保护和停止后重启。Node/Electron ABI 构建与 native 47/47 通过。

边界：本批没有动态调节 worker 数，也没有把 native 全局状态拆成实例对象；性能计数中的
`decodeMsTotal` 是多个 worker 的 CPU 时间总和，可能大于墙钟 `totalScanMs`。完整安装包未构建。

## 第八十一批：FastScanner 扫描运行时上下文

2026-08-01 在 `refactor/fastscanner-scan-runtime` 实施 FS-04，不改变扫描结果、索引格式、哈希
算法和用户数据。

1. 新增 `ScanRuntime`，集中拥有扫描主线程、停止/暂停/运行状态、异步停止计数、进度文本、
   生命周期/暂停/队列互斥量与条件变量，以及队列待处理、活跃和峰值 worker 指标。
2. `scan_worker`、目录枚举和 `BoundedScanPipeline` 改为显式接收 `ScanRuntime&`；异步停止工作项
   保存明确的 runtime 指针，停止、join、暂停、恢复、清索引和 cleanup hook 通过同一上下文
   完成，不再依赖分散的 `g_scanThread/g_scanStop/g_scanLifecycleMutex` 等变量。
3. 解码函数只在收到 runtime 指针时写入扫描进度 backend，同步查询图片不再隐式修改扫描任务
   的进度文本。扫描开始和清索引时的进度字段也统一由 progress mutex 保护。
4. native status 新增 `scan-runtime-context` feature，并明确报告
   `scanRuntimeMode=singleton-context`。这表示状态已经对象化，但当前仍只允许一个扫描上下文写入
   共享索引，不能解释为多实例并发扫描已经开放。
5. FastScanner 升级到 0.5.5；新增源码结构契约，锁定生命周期字段归属和流水线依赖注入。
   Node/Electron ABI 构建与 native 48/48 通过，runtime manifest 同步更新二进制哈希和大小。

边界：索引容器、加载/保存计数、USN 状态与扫描性能累计仍是进程级共享状态；本批没有改变
N-API 为每个 env 创建独立索引实例，也没有执行完整安装包构建。下一步应拆出 `IndexRuntime`
和 `ScanMetrics`，之后才能安全评估多 env 或多任务实例。

## 第八十二批：FastScanner 扫描指标上下文

2026-08-01 在 `refactor/fastscanner-scan-metrics` 实施 FS-05，不改变 IPC 字段、扫描结果、索引格式
和用户数据。

1. 新增 `ScanMetrics` 并由 `ScanRuntime` 直接拥有，集中管理跳过/警告/新增/更新计数、目录与文件
   枚举计数、各阶段微秒耗时，以及每次扫描最多 200 条文件错误日志的限流计数。
2. 有界流水线、目录枚举、双哈希解码和扫描 worker 全部通过 runtime 写入指标；进度 API 从同一
   runtime 快照读取，外部字段名称与单位保持不变。
3. 扫描开始、重新启动和清索引统一调用 `ScanMetrics::reset()`，不再逐项清零分散的原子变量。
   同步图片查询在没有 scan runtime 时既不写扫描 backend，也不累计扫描 decode/hash 时间。
4. 删除 `g_skippedCount/g_enumUs/g_decodeUsTotal` 等进程级扫描指标变量；源码契约锁定
   `ScanMetrics metrics` 的所有权以及旧变量不得重新出现。
5. FastScanner 升级到 0.5.6；native status 新增 `scan-metrics-context` 并报告
   `scanMetricsMode=runtime-owned`。Node/Electron ABI 构建、native 48/48 与二进制清单核验通过。

边界：`indexedCount/failedCount/totalBytes` 仍反映共享索引，而不是单次扫描指标；USN 状态、索引
容器、映射段和持久化元数据仍是进程级状态。完整安装包未构建，下一步继续拆分 `IndexRuntime`。

## 第八十三批：FastScanner 索引运行时上下文

2026-08-02 在 `refactor/fastscanner-index-runtime` 实施 FS-06，不改变 N-API/IPC 字段、哈希算法、
索引文件格式或用户数据。

1. 新增单例 `IndexRuntime`，统一拥有内存记录、去重集合、映射段、Global Directory 句柄、路径映射、
   增量覆盖/删除集合、索引模式、manifest 路径和共享索引计数器；删除原有分散的 `g_index`、
   `g_segments`、`g_pathIndexMap`、`g_indexedCount` 等全局变量。
2. USN volume 状态、状态文件路径、累计计数和扫描 backend/fallback 状态归入同一上下文。USN 数值
   计数改为原子量，修复扫描线程写入与进度 API 读取之间的数据竞争；字符串状态通过独立互斥锁
   快照，避免返回过程中读取并发修改的 `std::string`。
3. 扫描、搜索、编辑、manifest/segment 保存加载、压缩与清理路径全部迁移到该上下文，现有共享锁
   边界保持不变；`clearIndex` 和新扫描统一重置 IndexRuntime 的 USN 扫描状态。
4. `getNativeStatus()` 新增 `index-runtime-context` 并报告
   `indexRuntimeMode=singleton-context`；源码契约锁定 IndexRuntime 所有权并禁止旧索引/USN 全局
   容器重新出现。
5. FastScanner 升级到 0.5.7；Node 24 与 Electron 42 ABI 构建通过，native 48/48 通过，runtime
   manifest 已同步 Electron 二进制大小和 SHA-256。

边界：本批完成的是进程级状态聚合，不代表多 N-API env 或多个索引实例已经安全开放；多数回调仍
通过单例访问 IndexRuntime。完整安装包未构建。下一步应引入每 env 的 `AddonContext` 并把
`ScanRuntime`/`IndexRuntime` 作为显式依赖传入回调和异步工作项，再进行多实例生命周期测试。

## 第八十四批：FastScanner N-API 环境上下文第一阶段

2026-08-02 在 `refactor/fastscanner-addon-context` 实施 FS-07A，不改变 N-API/IPC 字段、索引文件
格式、哈希算法或用户数据。

1. 新增由 `napi_set_instance_data` 注册的 `AddonContext`；每个 N-API env 独立拥有一个
   `ScanRuntime`，扫描启动、进度、暂停、恢复、同步/异步停止和清索引生命周期操作均通过
   `napi_get_instance_data` 取得当前 env 的运行时，不再访问 `static g_scanRuntime`。
2. env instance-data finalizer 替代无上下文 cleanup hook，销毁时先停止并 join 当前 env 的扫描线程，
   再释放上下文，避免静态扫描线程跨 env 串用或在线程仍 joinable 时析构。
3. `AddonContext` 通过显式指针挂接当前仍共享的 `IndexRuntime`。IndexRuntime 增加 env 引用计数，
   子 Worker env 销毁时不再清空主 env 正在使用的索引、映射段或全局缩略图资源；仅最后一个 env
   负责共享资源清理。
4. `getNativeStatus()` 新增 `addon-context` 并准确报告
   `addonContextMode=env-owned-scan-shared-index`，同时把 `scanRuntimeMode` 更新为
   `env-owned-context`；源码契约禁止 `static ScanRuntime` 回归。
5. 新增真实 Worker env 生命周期回归：主 env 建立一个记录的索引，子 env 初始化并退出后主 env
   仍保持该记录且扫描状态可用。FastScanner 升级到 0.5.8，Node 24/Electron 42 ABI 构建及
   native 49/49 通过，runtime manifest 已同步二进制大小和 SHA-256。

边界：索引和原生缩略图组件仍是进程级共享资源，本批不开放多个 env 同时扫描或并发修改索引；
`IndexRuntime` 的多数辅助函数仍直接访问共享单例。完整安装包未构建。下一步应把 IndexRuntime
显式传入扫描、搜索、持久化和异步工作项，再将索引所有权迁入 AddonContext 并补并发隔离测试。

## 第八十五批：FastScanner 扫描索引依赖注入

2026-08-02 在 `refactor/fastscanner-scan-index-injection` 实施 FS-07B，不改变 N-API/IPC 字段、
索引格式、哈希算法或用户数据。

1. `scan_worker` 改为显式接收 `ScanRuntime&` 和 `IndexRuntime&`；扫描线程创建时从当前 env 的
   `AddonContext` 同时注入两者，文件去重、路径映射、记录写入、共享计数和扫描汇总不再读取
   `g_indexRuntime`。
2. `try_usn_scan`、USN 全量枚举/增量读取、USN 状态保存加载和失败路径记录均接收
   `IndexRuntime&`；扫描 backend、fallback、volume 状态和原子统计通过传入上下文访问。
3. `ScanDirectory`、`GetScanProgress`、`GetIndexStats`、`ClearIndex` 和 USN 可用性检查从当前
   AddonContext 取得索引引用；索引卸载、Global Directory 卸载/加载入口也改为显式参数，供尚未
   迁移的持久化调用方明确传入共享实例。
4. `getNativeStatus()` 新增 `scan-index-injection` 并报告
   `scanIndexMode=context-injected-shared`。源码契约锁定扫描/USN 核心函数签名，并禁止其函数体
   重新出现 `g_indexRuntime`。
5. FastScanner 升级到 0.5.9；Node 24/Electron 42 ABI 构建和 native 49/49 通过，runtime
   manifest 已同步 Electron 二进制大小和 SHA-256。

边界：`IndexRuntime` 本身仍为进程级共享实例，搜索、编辑及多数 manifest/segment 同步和异步
路径仍直接访问该实例；因此本批只是消除扫描链路的隐藏依赖，不代表多 env 并发索引已经开放。
完整安装包未构建。下一步应先迁移搜索与编辑辅助函数，再迁移持久化和异步工作项。

## 第八十六批：FastScanner 搜索与编辑依赖注入

2026-08-02 在 `refactor/fastscanner-search-index-injection` 实施 FS-07C，不改变 N-API/IPC 字段、
搜索排序语义、索引格式、哈希算法或用户数据。

1. Global Directory、prefix16/prefix12、segment linear 和内存搜索函数统一接收
   `IndexRuntime&`；主搜索分派、linear/balanced 模式和 SearchHit 组装沿调用链传递同一引用，
   搜索核心函数不再访问 `g_indexRuntime`。
2. 同步 `searchByHash/searchByImage` 从当前 AddonContext 取得索引；异步图片搜索数据显式保存
   `IndexRuntime*`，完成回调在 N-API 主线程上使用该指针执行搜索并生成状态字段。
3. 路径隐藏判断和有效记录查找改为显式接收索引引用；记录查询、路径存在检查、删除、前缀批量清理、
   路径修复和记录 upsert 六个编辑入口全部从当前 AddonContext 取得索引。
4. `getNativeStatus()` 新增 `search-index-injection` 并报告
   `searchIndexMode=context-injected-shared`。源码契约锁定搜索/编辑函数签名，禁止其核心区间重新
   出现 `g_indexRuntime`。
5. FastScanner 升级到 0.5.10；Node 24/Electron 42 ABI 构建和 native 49/49 通过，runtime
   manifest 已同步 Electron 二进制大小和 SHA-256。

边界：IndexRuntime 仍为进程级共享实例；manifest/segment 保存、加载、修复、压缩及对应异步工作项
仍有直接单例访问。本批不开放多个 env 并发写索引，完整安装包未构建。下一步迁移全部持久化链路，
之后才能把 IndexRuntime 所有权安全迁入 AddonContext。

## 第八十七批：FastScanner 同步持久化依赖注入

2026-08-02 在 `refactor/fastscanner-sync-persistence-injection` 实施 FS-07D，不改变 N-API/IPC 字段、
索引格式、manifest schema、哈希算法或用户数据。

1. segment ID、失败路径、Global Directory、mmap segment 和 overlay 持久化 helper 统一显式接收
   `IndexRuntime&`，不再从函数体读取共享全局名。
2. 同步 manifest 保存/加载与热重载、单 segment 保存/加载、dirty 状态和 index mode 查询均从当前
   AddonContext 取得索引引用，整个同步持久化区间不再出现 `g_indexRuntime`。
3. 尚未迁移的异步 load/save/compact 回调在调用共享 helper 时显式传入当前共享实例，保持既有行为，
   并把异步生命周期迁移留作独立批次。
4. `getNativeStatus()` 新增 `sync-persistence-index-injection`，并报告
   `persistenceIndexMode=sync-context-injected-async-shared`；源码契约锁定同步持久化区间和 helper 签名。
5. FastScanner 升级到 0.5.11；Node 24/Electron 42 ABI 构建和 native 49/49 通过，runtime manifest
   已同步 Electron 二进制大小和 SHA-256。

边界：IndexRuntime 仍为进程级共享实例；异步 manifest 加载、保存、压缩完成回调及 cleanup 仍直接访问
共享实例。本批不开放多个 env 并发写索引，完整安装包未构建。下一步执行 FS-07E，迁移异步持久化工作项。

### 交接检查点（2026-08-02）

- `main` 已快进到 `3a7f182`，FS-07A 至 FS-07D 均已落库；临时 worktree 和临时分支已清理。
- FastScanner 当前版本为 0.5.11，Electron 产物为 1,042,432 字节，SHA-256 为
  `4b43f5aad94801b90ccb86f73d341219f563b3f387ac4dc1c943862405929cd7`，与 runtime manifest 一致。
- 最后验证结果：native 49/49、runtime manifest 12/12、license materials 5/5；Node/Electron ABI 构建、
  typecheck、lint、format、privacy 和 staged snapshot 均通过。因耗时约束未构建完整安装包。
- FS-07E 的直接入口位于 `LoadManifestAsyncComplete`、`SaveManifestAsyncComplete`、
  `SaveIndexToManifestAsync`、`CompactAsyncComplete` 和 `unmap_index_internal` 附近。先把索引指针绑定到
  异步工作数据并补生命周期契约，再移除完成回调中的全局访问；当前 62 处文本引用是下一批审计基线。
- 项目许可证主体名仍按用户决定暂缓；EULA 模板未完成，不得作为可公开销售版本发布。默认不捆绑的
  法务待审模型继续保持禁用/用户自行安装边界，不得因 FastScanner 重构而放宽发行门禁。

## 第八十八批：FastScanner 异步持久化依赖注入

2026-08-02 在 `refactor/fastscanner-async-persistence-injection` 实施 FS-07E，不改变 N-API/IPC 字段、
Promise 结果、索引格式、manifest schema、哈希算法或用户数据。

1. `LoadManifestAsyncData`、`SaveManifestAsyncData` 和 `CompactAsyncData` 显式保存当前
   `IndexRuntime*`；三个 N-API 入口均从 AddonContext 绑定索引，异步 worker 和完成回调不再读取单例。
2. 异步保存入口的索引快照、segment ID 分配、load/save/compact 完成后的索引交换、sidecar 保存加载和
   Global Directory 重建均沿工作数据中的索引指针执行。
3. `unmap_index_internal` 改为接收 `IndexRuntime&`；异步 load/save/compact 和 cleanup 源码契约禁止
   重新出现 `g_indexRuntime`。全文件只剩单例声明与 AddonContext 初始化两处引用。
4. 新增真实行为回归，覆盖异步完整保存、清理后异步加载、搜索命中、构造双 segment manifest 和异步
   compact 回写；native 专项由 49 项增加到 50 项。
5. FastScanner 升级到 0.5.12；Node 24/Electron 42 ABI 构建通过，runtime manifest 已同步 Electron
   二进制大小 1,041,408 字节及 SHA-256
   `70a7d0d1894a48826d53e5aee32fa05d550db84fdcb0a8417f30bf09beb8cbb8`。

边界：IndexRuntime 仍由进程单例拥有，AddonContext 只是保存指针；异步工作尚未建立显式取消、引用计数
或 finalizer 等待协议。本批不开放多个 env 并发写索引，完整安装包未构建。下一步先形成所有权与并发
生命周期设计，再决定迁移为每 env 独立实例还是受控的进程共享索引服务。

## 第八十九批：FastScanner 共享索引所有权

2026-08-02 在 `refactor/fastscanner-shared-index-ownership` 实施 FS-07F，选择受控的进程共享索引服务，
不改变 N-API/IPC 字段、索引格式、manifest schema、哈希算法或用户数据。

1. 删除静态 `g_indexRuntime` 对象，新增函数内互斥锁和 `weak_ptr` 服务；首个 env 按需创建 IndexRuntime，
   后续 env 在实例存活期间取得同一个 `shared_ptr`。
2. AddonContext 把索引裸指针升级为 `shared_ptr<IndexRuntime>`；load/save/compact/searchByImage 四类异步
   工作数据复制该所有权，异步执行或完成回调不再依赖 env context 裸指针的存活时间。
3. IndexRuntime 析构负责卸载 segment 与 Global Directory；最后一个 env finalizer 只停止自身扫描并关闭
   进程级缩略图组件，不再提前清空仍可能被异步工作持有的索引。
4. 源码契约禁止 `g_indexRuntime` 和裸 `IndexRuntime*` 回归，并使用稳定的结构体/函数标记切分异步源码，
   修复原装饰注释乱码可能导致契约空切片的问题。Worker env 现在实际完成异步图片搜索后退出，主 env
   索引仍保持有效。
5. FastScanner 升级到 0.5.13；Node 24/Electron 42 ABI 构建和 native 50/50 通过，Electron 产物为
   1,043,456 字节，SHA-256 为
   `bbc225d2724858c0cf803520bbe7da3cef3dcddf3eb17fcdeb8076869f9976a8`。

边界：多个 env 仍共享同一索引，但尚未设置写入准入或租约，因此不允许并发 scan/save/load/compact。
`StopScanAsyncData` 仍保存 env-owned `ScanRuntime*`，其取消与 finalizer 等待协议留待下一批。完整安装包未构建。

## 第九十批：FastScanner 共享索引单写者准入

2026-08-02 在 `refactor/fastscanner-index-write-admission` 实施 FS-07G，不改变成功路径的 N-API/IPC 字段、
索引格式、manifest schema、哈希算法或用户数据。

1. IndexRuntime 新增互斥保护的写者 token、操作名和递增序列；`IndexWriteLease` 以 RAII 方式持有索引所有权，
   并在所有正常、错误和异常退出路径释放对应 token。
2. scan、clear、delete/purge/repair/upsert、同步 segment/manifest 保存加载与 manifest 修复全部接入单写者
   准入；扫描线程持有租约到缩略图收尾结束，并在发布 idle 状态前释放。
3. 异步 load/save/compact 工作数据保存 `shared_ptr<IndexWriteLease>`，从排队前开始占用，直到完成回调、
   立即成功、拒绝或数据销毁；冲突 Promise 直接以 `Index write busy: <operation>` 拒绝。
4. `getNativeStatus()` 新增 `single-writer-admission`、`indexWriteMode=single-writer-process-shared`、
   `indexWriterActive` 和 `indexWriterOperation`，便于界面和诊断观察当前写者。
5. 新增跨 Worker env 回归：主 env 暂停扫描并持有 `scan` 租约时，子 env 的 clear 必须失败关闭且准确报告
   当前写者；native 专项增加到 51 项。FastScanner 升级到 0.5.14，Electron 产物为 1,061,376 字节，
   SHA-256 为 `0cc4304c193006013a20e90b779ba2fbb934b946b9e45ec52b020865b22211a3`。

边界：本批提供的是冲突拒绝，不是多写者并行或排队调度；读取仍可与写入并行，并依靠现有 shared_mutex
保护容器。`StopScanAsyncData` 仍持有 env-owned `ScanRuntime*`，完整安装包未构建。下一步迁移停止扫描的
异步生命周期并验证 Worker env 提前退出。

## 第九十一批：FastScanner 异步停止扫描运行时所有权

2026-08-02 在 `refactor/fastscanner-scan-runtime-ownership` 实施 FS-07H，不改变成功路径的 N-API/IPC 字段、
索引格式、manifest schema、哈希算法或用户数据。

1. AddonContext 将 ScanRuntime 从值成员迁移为 `shared_ptr`；每个 env 仍拥有独立扫描状态，但异步工作可在
   env finalizer 开始后安全保持运行时存活。
2. `StopScanAsyncData` 不再保存裸 `ScanRuntime*`，而是复制强所有权；创建和排队失败路径仍立即释放。
3. 异步 execute 改为复用 `stop_scan_sync()`，使 request、join 和状态复位处于同一生命周期临界区，并与
   finalizer 的同步停止串行，消除 join 后、复位前的竞争窗口。
4. `getNativeStatus()` 新增 `scan-runtime-ownership`、`scanRuntimeMode=env-owned-shared-lifetime`、
   `stopScanAsyncMode=shared-runtime-owned`、`scanStopInProgress` 和 `scanStopWorkCount`。
5. 新增 Worker env 回归：子 env 启动扫描并排队异步停止，在 Promise 完成前由主线程终止；finalizer 完成后
   共享索引写者租约释放且主 env 保持可用。native 专项增加到 52 项。FastScanner 升级到 0.5.15，Electron
   产物为 1,062,400 字节，SHA-256 为
   `fbf971497350067aed46ecb56dc8da53e8d8b22a864679236a79bb68abe62abc`。

边界：本批只统一 stopScanAsync 的 ScanRuntime 生命周期；其他 N-API async work 尚未接入通用 registry 或
显式取消协议。完整安装包未构建。下一步梳理异步任务的 env teardown、取消和完成回调顺序。

## 第九十二批：FastScanner N-API 异步工作注册与环境退出协议

2026-08-02 在 `refactor/fastscanner-async-work-registry` 实施 FS-07I，不改变成功路径的 N-API/IPC 字段、
索引格式、manifest schema、哈希算法或用户数据。

1. AddonContext 新增 env-owned `AsyncWorkRegistry`，registry 由 context 和每个已登记工作共同持有，避免
   instance finalizer 删除 context 后完成回调访问悬空注册状态。
2. stop、manifest load/save/compact、hash 和 search 共 6 类 async work 统一使用 registered create、queue、
   finish helper；全部 create/queue 返回值均检查，失败时注销、删除 work、释放租约并结算 Promise。
3. Init 注册 env cleanup hook；环境退出时关闭新登记并对 active work 调用 `napi_cancel_async_work`。
   按 Node-API 约束，成功取消后仍由 complete callback 删除 work，不在 cleanup hook 提前释放。
4. `getNativeStatus()` 新增 `async-work-registry`、`asyncWorkMode=env-owned-cancel-on-teardown`、active、closing
   和 cancel accepted 字段，便于 Worker 与诊断观察 registry 状态。
5. 新增 Worker teardown 回归：同一 env 同步排队 64 个 hash work，确认 registry 记录全部任务后立即终止；
   teardown 无崩溃，主 env active count 仍为 0 且保持可用。native 专项增加到 53 项。FastScanner 升级到
   0.5.16，Electron 产物为 1,072,128 字节，SHA-256 为
   `0dd8199328e3f36a7f64493ce0f7773634e2d614fc77a6526f3dd82180319eb8`。

边界：`napi_cancel_async_work` 只能取消尚未开始执行的任务；已在 worker pool 中运行的 load/save/compact 等任务
仍需自然完成。完整安装包未构建。下一步增加协作式取消 token 和不会破坏原子落盘语义的检查点。

## 第九十三批：FastScanner 长时间持久化任务协作式取消

2026-08-02 在 `refactor/fastscanner-cooperative-cancellation` 实施 FS-07J，不改变索引格式、manifest schema、
哈希算法或用户数据；新增一个向后兼容的 native `cancelAsyncWork()` 关闭握手入口。

1. manifest load/save/compact 三类工作新增共享 `AsyncCancellationToken`；registry 记录 token、started 和
   pre-commit 状态，状态接口新增 running、cancellable、pre-commit 计数。
2. segment 加载、路径索引生成、compact 合并和 segment 序列化循环每 256 项检查取消；临时 segment 使用
   RAII guard，所有取消和失败路径都会删除未提交的 `.tmp`。
3. save/compact 以 manifest 原子替换作为提交边界：边界前取消会回滚本批新 segment 与 manifest.tmp；边界后
   忽略迟到取消并完成旧 segment 清理及内存索引重载，避免磁盘出现半提交状态。
4. registry 改用 async cleanup hook 保证所有 active work 完成后才释放 AddonContext。实测 Node-API cleanup
   阶段在 async work 排空时触发，不能作为运行中任务的即时中断源，因此新增 `cancelAsyncWork()`；Worker/controller
   应先显式取消并等待，再调用 terminate，cleanup hook 只承担最终兜底排空。
5. 新增确定性 pre-commit 回归：Worker save 已生成新 segment 但尚未替换 manifest 时发出取消，约 50ms 内确认；
   writer 租约释放，manifest.tmp、staging tmp 和孤立 segment 均不存在。native 专项增加到 54 项。FastScanner
   升级到 0.5.17，Electron 产物为 1,090,560 字节，SHA-256 为
   `2cb4cf284ddb68d4f7fc9a76f53c58e03df73fb04a5a2323d24095a99aedf417`。

边界：当前 native 已提供关闭握手，但应用层 Worker/controller 尚未调用该入口；直接强制 terminate 仍可能等待
已运行工作自然完成。完整安装包未构建。下一步接入实际关闭链路并补应用层集成回归。

## 第九十四批：FastScanner 关闭路径取消握手接入（FS-07K）

2026-08-02 在 `main` 实施 FS-07K，不改变索引格式、manifest schema、N-API 契约或用户数据；把 FS-07J 的
`cancelAsyncWork()` 显式取消握手接入 Electron 主进程关闭路径。

1. `electron/imageSearchService.ts` 的 `NativeAddon` 接口补充 `cancelAsyncWork?()` 返回类型和
   `getNativeStatus()` 的 async work 扩展字段（active/running/cancellable/pre-commit/closing/cancel accepted
   与两种 mode），保持可选类型以兼容旧版 addon。
2. 新增导出 `shutdownImageSearchForQuit()`：先调用 `cancelAsyncWork?.()` 请求协作取消与排队任务取消，再
   `await stopImageSearchScan()`，随后 await 模块级跟踪的 autosave 保存链，最后轮询
   `getNativeStatus().asyncWorkActiveCount` 直到为 0（5 秒超时上限，避免卡死退出）；模块级
   `imageSearchShutdownPromise` 保证重复调用幂等。
3. autosave 的 `saveIndexToManifestAsync` promise 链新增模块级 `autosavePromise` 跟踪，供关闭路径 await。
4. `electron/main.ts` 的 `will-quit` 改为 `event.preventDefault()` + 完成握手后再次 `app.quit()` 的模式，
   模块级 `imageSearchShutdownRequested` 标志防止重复进入；第二次 quit 直接放行并保留
   `disposeVectorAnnWorker()`、`disconnectAll()`、`globalShortcut.unregisterAll()` 原有行为，shutdown 握手
   在 vector worker 销毁之前执行。
5. 新增应用层集成回归 `tests/image-search-shutdown.test.cjs`（源码契约断言，3 例），注册为
   `test:image-search-shutdown` 并加入总 `test` 链。native 54/54 通过，TypeScript 类型检查与 ESLint 通过。

边界：缩略图重建（native thumbnail rebuild）尚未接入关闭停止，留作下批可选项；已在运行的 native 工作
超出 5 秒排空上限时仍按原路径退出，由 FS-07I/07J 的 teardown 排空兜底。完整安装包未构建。

## 第九十五批：缩略图 native 重建的退出停止接入（FS-07L）

2026-08-02 在 `main` 实施 FS-07L，不改变 IPC 契约、索引格式、manifest schema、N-API 契约或用户数据；
把 native 缩略图重建的停止接入第九十四批建立的关闭握手，补上其声明的边界。

1. `electron/imageSearchService.ts` 已有的 `stopNativeThumbnailRebuild()` 本就是不依赖 IPC 上下文的
   service 函数（`nativeAddon?.stopNativeThumbnailRebuild?.() || { ok: false }`，addon 未加载时安全降级），
   直接复用，不新抽函数、不改 native 代码。
2. 因 native 重建由 imageSearchService 管辖，停止调用放在 `shutdownImageSearchForQuit()` 内部开头、
   `cancelAsyncWork()` 之前：重建是 native async work 的主要生产者，先停重建可让随后的取消握手与
   5 秒上限 registry 排空更快收敛。外层 try/catch 保证停止失败不阻断退出，模块级
   `imageSearchShutdownPromise` 使整体保持幂等。
3. 回归测试 `tests/image-search-shutdown.test.cjs` 新增源码契约断言（共 4 例）：service 导出
   `stopNativeThumbnailRebuild` 且带 addon 缺失降级，且关闭握手中停止调用位于 drain 排空之前。
   `main.ts` 无需改动（握手入口不变）。TypeScript 类型检查与 ESLint 通过，缩略图相关回归
   17/17 通过；未改 native，无需重跑 native 构建。

边界：JS 侧（thumbnailIpc 内）的非 native 重建循环状态不在本次范围；退出时 UI 进度状态无需更新。
完整安装包未构建。

## 第九十六批：Data Editor 来源文件夹浏览与批量删除

2026-08-02 在 `main` 为 Image Search Data Editor 增加按来源文件夹浏览与索引级批量删除，
不改变 native 代码、索引/overlay 格式或既有单条编辑语义。

1. 新 IPC 信道 `imageSearch:deleteDataFolder`：常量登记在 `shared/ipc/image-search.ts`，
   契约类型加入 `shared/ipc-contract.ts`（复用 `ImageSearchDataEditResult`，新增可选
   `removedCount`）。`electron/imageSearchService.ts` 新增 `deleteImageSearchDataFolder(folder,
   allowedRoots)`：规范化后校验 folder 等于或位于某个扫描根之下，拒绝越界；通过则调用既有
   native 原语 `purgeIndexPathPrefix` 并 `persistImageIndexEdits()` 落盘；addon 缺少该原语时
   安全降级返回错误。`electron/imageSearchIpc.ts` 的 handler 用 `safeShellPath` 规范化入参，
   从 `floating_clock_settings.json` 读取 `imageSearchScanPaths` 作为 allowedRoots；
   preload 与 `imageSearchBridge` 同步暴露。
2. UI（`ImageSearchDataManager.tsx`）：查询区上方新增来源文件夹条，scanPaths 渲染为可切换
   按钮，选中即设为查询词并自动查询；查询改为 200 条/页的分页加载（Load more 按 offset
   追加）；选中文件夹时显示两步确认的批量删除按钮，toast 报告 `removedCount` 并提示
   embedding 需手动重建。新可见文本全部走 `t()` 并补齐 `core.ts` 中文翻译。
3. 回归测试 `tests/image-search-data-folders.test.cjs`（源码契约断言，8 例）：信道常量、
   契约类型、preload 暴露、bridge 降级包装、service 根校验顺序/purge 调用/落盘、IPC handler
   设置读取、UI 文件夹选择与两步确认、新 i18n 键齐全。`package.json` 增加
   `test:image-search-data-folders` 并插入总 `test` 链。能力声明按既有模式自动匹配
   （`imageSearch` 域 + delete 写操作），无需修改 `ipc-capabilities.ts`；
   `ipc-registration`/`preload-contract` 等枚举型测试不受影响。

边界：不做文件夹计数、批量 update 或批量缩略图重建；embedding 刷新仍走向量维护手动流程。
完整安装包未构建。

## 第九十七批：修复删除路径在 manifest 加载后复活进 pathIndexMap

2026-08-02 在 `main` 修复 fast_scanner 原生缺陷，不改变 IPC 契约、索引/overlay 文件格式或 manifest schema。

1. 缺陷：`purgeIndexPathPrefix`/`deleteIndexPath` 把路径写入 `index.deletedPaths` 并从
   `index.pathIndexMap` 擦除，overlay.json 由 `save_overlay`/`load_overlay` 持久化；但 manifest
   加载/应用路径（`mmap_segment` 的 "Populate path index map" 循环、`LoadManifestAsyncComplete`
   的全量重灌、`SaveManifestAsyncComplete` 的逐段重灌）重建 `pathIndexMap` 时不咨询
   deletedPaths，而这些路径最后才 `load_overlay(...)`。后果：purge/delete → save → reload 后
   被删路径复活进 `pathIndexMap`，full 扫描在 `SCAN_SKIP_INDEXED` 分支判定"已索引"跳过，
   被删文件夹永远无法重扫回索引（实测 purge 1000 条 → save → reload → scan 后
   skippedIndexed=1000、query 为 0）。
2. 修复（单点最小改动）：`load_overlay` 在既有 `unique_lock` 内、填充 deletedPaths 之后，
   遍历 `index.deletedPaths` 从 `index.pathIndexMap` 擦除（`make_path_key` 与既有代码一致）。
   全部 4 个 `load_overlay` 调用点（同步 save/load 与异步 save/load 的 complete 回调）均未在
   持锁状态调用 `load_overlay`，锁处理与其现有方式一致，无重复加锁。
3. 回归测试 `tests/native-scan.test.cjs` 新增用例：建临时目录与图片 → full 扫描 →
   `saveIndexToManifestAsync` → `purgeIndexPathPrefix` → 再次 `saveIndexToManifestAsync` →
   `clearIndex` + `loadManifestAsync` 重载 → full 扫描，断言 `skippedIndexed` 为 0 且
   `queryIndexRecords` 重新查到记录。该用例在修复前红（skippedIndexed=2）、修复后绿；
   用例清理对异步保存保留的退役 segment 映射（Windows delete-pending 至进程退出）做了
   try/catch 容忍。版本号按惯例 bump 至 0.5.18（`getNativeVersion`/`getNativeStatus`、
   `resources/runtime-manifest.json` 版本与 electron 产物 SHA-256/sizeBytes、
   `THIRD_PARTY_COMPONENTS.md`）。native 55/55 通过，runtime manifest 12/12、
   许可证材料 11/11 通过，Node 与 Electron 双 ABI 产物均已重建。

边界：rescan 重新入库的记录不会清除 deletedPaths 墓碑（`hasIndexPath` 仍返回 false），
这与无 reload 的 purge → rescan 既有语义一致，不在本批范围。完整安装包未构建。

## 第九十八批：修复 full 扫描后 manifest 保存丢失既有 segment 引用

2026-08-02 在 `main` 修复 fast_scanner 严重数据丢失缺陷，不改变 IPC 契约、索引/overlay 文件格式或
manifest schema。

1. 缺陷链（沙盒对 280015 条真实索引副本复现）：`ScanDirectory` 对非增量模式（含默认 `full`）在
   启动时 `unmap_index` 卸载全部 mmap segment 并切回 memory 模式，却保留 `pathIndexMap` 中的
   segment 条目——该行为早于 FS-07 系列（git 历史显示 FS-07 重构仅搬迁该行），属既有设计缺陷。
   此前它恰好被空索引保护掩盖：full 扫描按 pathIndexMap 全部 `skippedIndexed` 跳过，
   `index.records` 为空，`saveIndexToManifestAsync` 以 "No records to save" 拒绝，不会写出残缺
   manifest。第九十七批（FS-07M）让 purge 路径重扫真正进入 `index.records` 后，memory 模式的
   full-save 只写这 1000 条新记录，manifest 丢弃原 280015 条 segment 引用（文件残留磁盘），
   造成索引数据丢失；且 overlay.json 的 deletedPaths 墓碑未随重扫清除，reload 后
   `queryIndexRecords` 对新记录也返回 0。
2. 修复（三处，格式不变）：
   - `ScanDirectory` 移除 full 扫描的 `unmap_index`：扫描行为不变（本就靠 pathIndexMap 跳过
     已索引文件），但 segment_mmap 模式与既有 segment 引用得以保留，随后的保存走 append 模式，
     新记录写成新 segment 列于 manifest 首位、旧 segment 引用保留。同时消除了 full 扫描后
     segment 数据在内存中不可查询的隐性降级。
   - 扫描入库分支（`SCAN_SKIP_INDEXED` 之后）对命中 deletedPaths 墓碑的路径：erase 墓碑并
     插入 replacedPaths，使重扫"复活"的路径在保存/重载后可见，且旧 segment 中的陈旧副本
     继续被 replaced 语义隐藏（与 `upsertIndexRecord` 既有处理一致）。
   - `QueryIndexRecords` 的 segment 过滤去掉对 replacedPaths 的一刀切隐藏，并改为按 manifest
     顺序（最新 segment 在前）正向遍历：`seen` 去重天然实现"replaced 路径仅最新副本可见"，
     与 `is_segment_path_hidden` 语义对齐；此前 replaced 路径在 query 中全部不可见，
     重复路径则会显示最旧副本。
3. 回归测试 `tests/native-scan.test.cjs` 新增用例：建索引 → load → purge 一个子目录 → save →
   reload → full 重扫该子目录（重扫前先把文件写大，使新旧副本元数据可区分）→ save →
   clearIndex + reload，断言旧目录记录与新扫入记录都可查（`queryIndexRecords` 返回的
   是最新副本的 fileSize）、`hasIndexPath` 均为 true。修复前红（旧 segment 记录查询为 0），
   修复后绿。沙盒复现脚本修复后输出：save2 后 manifest 为 [1000, 280015] 两段、reload2
   recordCount=281015、pxhere-000000 可查询且元数据正常。版本 bump 至 0.5.19。
   native 56/56 通过，runtime manifest 12/12、许可证材料 11/11 通过，Node 与 Electron
   双 ABI 产物均已重建。

边界：full 扫描不再卸载 segment 后，大索引扫描期间 mmap 常驻（与增量扫描一致）；被墓碑隐藏
的旧副本仍物理存在于旧 segment 中，由后续 compact 清理，与本批之前行为一致。完整安装包未构建。

## 第九十九批：修复 searchByImageAsync 省略 topK 时节段索引崩溃

2026-08-02 在 `main` 修复 fast_scanner 段错误缺陷，不改变 IPC 契约、索引/overlay 文件格式或
manifest schema。

1. 缺陷：真实索引（281,015 条、segment_mmap）下 `searchByImageAsync(path, 5)`（省略 topK）
   只要有候选结果即 Segmentation fault（exit 139）；候选为 0 或同步 `searchByImage` 同参
   均正常。根因：同步 `SearchByImage` 对 topK 有 `tk>0?tk:20` 兜底，异步
   `SearchByImageAsync` 直接 `d->topK=get_int32(env,argv[2])`，缺省实参得到 0；topK=0
   进入 prefix16/balanced 候选堆逻辑时 `heap.size()<0` 恒假，分支走到
   `d<heap.top().dist`——**对空堆取 top() 是未定义行为**，有候选即崩。`git log -S` 显示
   该缺钳制行出自初始提交，非 FS-07 系列回归；既有 native 测试全部显式传 topK 且多为
   内存索引，未覆盖此路径。
2. 修复（最小）：`SearchByImageAsync` 与同步版对齐 `d->topK=topKArg>0?topKArg:20`；
   顺带把 `SearchByImageAsyncData.metrics` 值初始化（`SearchMetrics metrics{}`），避免
   未设 `fallbackUsed` 的搜索路径输出未初始化字段。不改任何搜索算法与文件格式。
3. 回归测试 `tests/native-scan.test.cjs` 新增用例：scan → save → clearIndex +
   `loadManifestAsync` 使索引处于 segment_mmap → 不传 topK 调 `searchByImageAsync` →
   断言 mode 为 segment_mmap、有命中且含 distance=0 的查询图本身。修复前该用例使测试
   进程整体崩溃（文件级失败），修复后通过。沙盒（真实索引 3 段副本）端到端：修复前
   exit 139，修复后 candidates=4、distance=0 命中查询图，结果元数据正常。版本 bump
   至 0.5.20。native 57/57 通过，runtime manifest 12/12、许可证材料 11/11 通过，
   Node 与 Electron 双 ABI 产物均已重建。

边界：构建期间发现运行中的 dev Electron 实例锁定了 `native/build/Release` 产物
（`tryLoadAddon` 首选该路径），通过将旧文件改名释放句柄完成重建，未打扰 dev 会话；
残余 `.dev-locked` 旧二进制已删除。完整安装包未构建。

## 第一百批：修复 isWithin 跨盘误判致 D: 盘记录被丢弃

2026-08-02 在 `main` 修复 Windows 跨盘路径包含判断缺陷，不改 native、不改 IPC 契约。

1. 缺陷：userData 在 C: 盘时，Data Editor 查询 `D:\dataset\images` 永远 0 条、以图
   搜图对 D: 数据集永远无结果（生产实例实证：应用内 `queryData('D:\dataset\images')`
   返回 n:0，`C:\Windows\WinSxS` 正常）。根因：`projectSearchIndexService.ts` 的 `isWithin`
   用 `path.relative` 判断包含关系，Windows 跨盘时返回绝对路径（如 `D:\...`）——既不是
   `..` 也不以 `..\` 开头，于是被误判为"在 previewRoot 之内"；`isProjectPreviewProxy` 随之
   把所有 D: 盘文件当作 project preview 代理，`queryImageSearchData` 与图片搜索命中映射把
   这些记录 flatMap 全部丢弃。
2. 修复（最小）：`isWithin` 与 `uiSmokeService.ts` 内联的 `isUnderResources`（同一写法，
   用于 packaged 资源 provenance 判定）在 `path.relative` 之后增加
   `path.isAbsolute(relative)` 短路，跨盘即返回 false。排查了全部 `path.relative` 包含判断：
   `storageCleanupService.isContained`、`assetClusterUtilities`、`assetClusteringWorker`、
   `pathGuards.isSameOrNestedPath` 均已带 `!path.isAbsolute(relative)` 守卫，无此缺陷；
   `assetLibraryBackup.isSafeRelativePath` 是相对路径校验变体（输入先经 `path.isAbsolute`
   拒绝，不做双根 relative，且后续只用 `path.join` 拼回根目录），不适用本缺陷，未改。
3. 回归测试 `tests/project-preview.test.cjs` 新增用例：`initProjectSearchIndex`（临时
   userData）后，断言与 previewRoot 不同盘符的 `X:\dataset\images\x.jpg`（X 取
   C/D 中相异者）经 `isProjectPreviewProxy` 判为 false、previewRoot 内路径判为 true；非
   Windows 平台跳过。修复前红（跨盘路径误判为 true），修复后绿。
4. 验证：`node --test` 跑 project-preview / storage-cleanup / storage-inventory 三个测试
   文件 22/22 通过，`npm run test:app-storage` 3/3 通过，`npm run test:ui-smoke-contract`
   6/6 通过，`tsc --noEmit` 与 `tsc -p tsconfig.node.json --noEmit` 通过，ESLint 与
   Prettier 改动文件通过。

边界：未改 native、未改 IPC 契约；storageCleanup 删除决策的包含判断本已带跨盘守卫，
本批只补齐缺失的两处，未触碰其余同形但正确的实现。

## 第一百零一批：Data Editor 文件夹聚合统计（条数/体积）入口

2026-08-02 在 `main` 为 Image Search Data Editor 补文件夹级聚合统计，让"按文件夹定位数据"
的入口直接显示整个文件夹的条数与总体积，删除前即可看到影响面。

1. native 新原语 `getIndexPathStats(prefix)`（fast_scanner 0.5.20 → 0.5.21，同步、shared_lock
   只读、不需要 writer lease）：空 prefix 统计整个索引；非空按 `purgeIndexPathPrefix` 同款
   边界规则（等于 prefix 或以 `prefix + '\'` 开头）。遍历 `index.records`（反向）+ 所有
   segments，与 `QueryIndexRecords` 一致的 seen 去重与 `deletedPaths` 跳过；`fileSize` 用
   double 累加防溢出；normalize 后非空前缀 <4 字符返回 `Unsafe index prefix`。
2. IPC 新信道 `imageSearch:getDataStats`（只读，prefix 截断 1024，与 queryData 同款校验风格），
   service `getImageSearchDataStats` 直接委托 native、不做 scanPaths 根校验；preload/bridge
   全链路，native 缺原语时安全降级返回错误。
3. UI（`ImageSearchDataManager.tsx`）：来源文件夹按钮下方显示"N 条 · X MB"（面板打开时按需
   加载，失败静默不显示）；查询词像绝对路径（含 `:\` 或以 `\` 开头）时，结果列表上方显示
   "共 N 条 · X MB"统计条，随 runQuery 刷新；文件夹两步删除的确认文案带上统计（"将从索引
   删除 N 条记录（X MB），不删除源文件"），统计缺失时回退原文案；文件夹删除成功后刷新统计。
   新文本走 t()（中英）。
4. 测试：`tests/native-scan.test.cjs` 新用例先红后绿（修复前 `getIndexPathStats is not a
   function`）——临时 PNG 扫描后断言整索引与文件夹前缀的 count/totalBytes、边界规则
   （folder-a-sibling 不匹配、精确文件路径匹配）、`C:\` 触发 Unsafe 保护、save/load 后
   segment 路径同样被统计、`deleteIndexPath` 后统计随之减少。
   `tests/image-search-data-folders.test.cjs` 补 9 条契约断言（信道常量/契约/preload/bridge/
   service 委托/IPC handler 校验/native 导出/UI 展示与确认文案/i18n），17/17 通过。
5. 验证：Node 与 Electron 双 ABI 产物重建；data-folders 17/17；ipc-validation、
   ipc-registration、preload-contract 通过；`tsc --noEmit` 与 `tsc -p tsconfig.node.json
   --noEmit` 通过；ESLint 与 Prettier 改动文件通过；runtime-manifest 同步 0.5.21 的
   sha256/sizeBytes。

边界：不改索引/overlay 格式；不做文件夹树浏览（仅 scanPaths + 查询路径两级）；统计是只读
聚合，不引入新的索引写入路径。

## 第一百零二批：Data Editor 聚合统计祖先文件夹回退

2026-08-02 在 `main` 修复粘贴文件完整路径时 Data Editor 统计条无有效信息的问题：第一百零一批
的聚合是精确前缀匹配，粘贴 `...\RWTemp\2026-08\<hash>\<hash>.png` 这类文件路径时该前缀（及
其直接父目录）在索引里为 0 条，而 `%USERPROFILE%\xwechat_files` 实际有数千条。

1. UI（`ImageSearchDataManager.tsx`）runQuery 的统计逻辑改为祖先回退：pathLike 查询词构造
   候选前缀链（新增纯函数 `statsPrefixChain`：term 本身剥掉末尾 `\` 后逐级截断到最后一个
   `\`，最多 8 级、不短于盘符根，文件扩展名不做特殊处理——链从自身开始逻辑统一）；串行依次
   调 `getDataStats`，取第一个 count>0 的前缀，某级失败（stats.ok false）静默跳过，全部 0
   则用最末一个有效回复。
2. 展示：生效前缀与查询词不同且 count>0 时，统计条标注来源文件夹（新 i18n 文案
   `{prefix} · Total: {count} records · {size}` → `{prefix} · 共 {count} 条 · {size}`，
   如 `%USERPROFILE%\xwechat_files · 共 2,617 条 · 55 MB`）；前缀等于 term 或全部为 0 时
   保持原 `共 N 条 · X MB` 文案不标前缀。
3. 测试：`tests/image-search-data-folders.test.cjs` 补 3 条断言——提取 `statsPrefixChain`
   实跑验证回退链（含扩展名文件路径、末尾分隔符剥离、盘符根止步、8 级上限）、回退选择与
   失败静默跳过的契约、标注文案及其中文翻译；原"getDataStats(term)"断言随实现更新为
   `(prefix)`，20/20 通过。
4. 验证：`node --test tests/image-search-data-folders.test.cjs` 20/20；
   `npm run test:i18n-static` 仅剩既有失败（SettingsPanel.tsx:384，与本次无关）；
   `tsc --noEmit` 通过；ESLint 与 Prettier 改动文件通过。

边界：不改 native、不改 IPC 契约；回退最多 8 级且为只读聚合，不引入新的索引写入路径。

## 第一百零三批：Data Editor 文件夹删改逻辑修复（批次一：根目录校验/范围谓词/分隔符/统计陈旧）

2026-08-02 在 `main` 修复审计发现的 Data Editor 文件夹删改四处缺陷：盘符/UNC 根目录下
子文件夹删除被误拒、列表与统计/删除的范围谓词不一致、正斜杠查询词无统计、统计展示陈旧。

1. H1 根目录校验（`imageSearchService.ts` `deleteImageSearchDataFolder`）：allowedRoots
   包含判定从 `startsWith(normalizedRoot + path.sep)` 改为 `path.relative(normalizedRoot,
   normalizedFolder)`（`rel === ''` 或非 `..` 开头且非绝对路径即合法）。`path.resolve('D:\')`
   保留尾部分隔符，旧逻辑下 `'d:\foo'.startsWith('d:\\')` 为 false，scanPath 为盘符根或
   UNC 根时其下所有子文件夹删除都被拒；新写法对根路径天然正确，两侧小写规范化保持一致。
2. M1 范围谓词（`imageSearchService.ts` `queryImageSearchData`）：native
   `QueryIndexRecords` 是子串匹配（`np.find(query)`），而统计/删除是边界前缀匹配，查询
   `D:\dataset` 会额外命中 `D:\dataset2\...`。service 层新增
   `normalizedDataQueryPrefix`（pathLike 判定与 UI 同款：归一后含 `:\` 或以 `\` 开头）与
   `isWithinDataPathPrefix`（等于 prefix 或 `prefix + '\'` 之下，归一后小写比较），
   pathLike 查询对 native 返回页再过滤，使列表/统计/删除三者范围一致；非 pathLike 查询
   保持子串行为。过滤在 service 层会导致页大小不足 200，hasMore 仍以 native 为准（简单
   处理，不改 native）。
3. M2 正斜杠（`ImageSearchDataManager.tsx` runQuery）：term 先把 `/` 归一为 `\` 再做
   pathLike 判定、statsPrefixChain 切链与查询，粘贴 `D:/foo/bar` 也有统计；service 过滤
   用的 prefix 走同一归一（`normalizeDataQueryPath`：折 `/`、剥尾部 `\`、小写）。
4. M3 统计陈旧（`ImageSearchDataManager.tsx`）：文件夹删除成功后清 `queryStats`；单条
   删除/更新/修复成功后在重跑 runQuery 之外补 `loadFolderStats()` 刷新文件夹按钮统计；
   两步确认第一次点击（arm）时实时调一次 `getDataStats(selectedFolder)` 更新缓存，确认
   按钮展示的是当前数字而非可能陈旧的缓存。
5. 测试（`tests/image-search-data-folders.test.cjs`，先红后绿）：H1 契约断言改用
   `path.relative`（并断言旧 startsWith 形态不存在）；新增 M1 谓词/过滤契约、M2 分隔符
   归一契约、M3 三个刷新点契约；新增 service 级可执行用例（loadTsModule + 真实
   fast_scanner addon 种子三条记录）——修复前列表返回 dataset2  siblings、盘符根
   `['D:\']` 下 `D:\dataset` purge 被 "outside the configured scan paths" 拒绝，
   修复后 pathLike 查询（含正斜杠写法）只命中精确子树、子串查询保持原行为、根目录 purge
   成功 removedCount=1 且越界（`C:\Windows`）仍被拒。26/26 通过。
6. 验证：`node --test tests/image-search-data-folders.test.cjs` 26/26；
   `npm run test:ipc-validation`（4/4）、`test:ipc-registration`（7/7）、
   `test:preload-contract`（2/2）通过；`tsc --noEmit` 与 `tsc -p tsconfig.node.json
   --noEmit` 通过；ESLint 与 Prettier 改动文件通过。

边界：不改 native、不改 IPC 契约；pathLike 过滤只在 service 层收窄 native 返回页，分页
hasMore 语义不变；统计刷新均为只读聚合，不引入新的索引写入路径。

## 第一百零四批：Data Editor 文件夹删改逻辑修复（批次二：空索引持久化/项目预览记录清理）

2026-08-02 在 `main` 修复审计发现的 Data Editor 文件夹删改两处高危缺陷：purge 清空整个
索引时落盘必败导致重启复活，以及项目文件（.psd/.kra 等）preview 记录在文件夹 purge 后
残留。

1. H3 空索引持久化（`imageSearchService.ts` `persistImageIndexEdits`）：native
   `SaveIndexToManifestAsync` 有非 append 空保护（overlaySnap 为空即 reject
   "No records to save"），purge 在内存已生效（dirty=true）但落盘返回失败，之后不扫描则
   删除永不落盘、重启从旧 manifest 复活。排查确认应用此前没有任何空索引持久化路径
   （`clearImageIndex` 只清内存不写盘），故 service 层实现：save 失败且错误为
   "No records to save" 且 `getIndexPathStats('')`（与 save 快照同款可见性规则，跳过
   deletedPaths）确认索引已空时，视为合法结果写入空 manifest（`persistEmptyImageIndex`：
   schemaVersion 2、segments 为空、overlay 计数清零，manifest.tmp + rename 原子替换），
   并 best-effort 清理孤儿 segment/staging 文件与 overlay.json，使重启后索引为空而非复活
   旧数据。启动路径安全：`tryAutoLoadDefault` 在 manifest.json 存在时只 load 不 repair
   （native 对空 manifest 报 "No segments in manifest" 仅记日志），repair 只在无 manifest
   时触发，因此空 manifest + 孤儿文件清理的组合不会复活；被 mmap 锁住的 segment 文件删不
   掉也没关系，空 manifest 已不再引用它们。
2. H2 项目 preview 记录清理（`deleteImageSearchDataFolder`）：项目文件的索引记录路径在
   userData previewRoot 下，不在被删文件夹前缀内，prefix purge 永远碰不到它们；
   queryImageSearchData 又把 preview 映射回 sourcePath 显示，导致文件夹删除后这些记录仍
   出现在列表（空查询分页）而统计已为 0。`projectSearchIndexService` 新增
   `getProjectSearchEntriesInFolder(folder)`（按 sourcePath 用 H1 同款 path.relative
   包含判定枚举 entriesBySource，未初始化时返回空）；purge 文件夹前缀后对这些条目逐个
   `deleteIndexPath(previewPath)` + `removeImageData(sourcePath)`（vector 清理失败仅告警
   不阻断），删除数计入 removedCount，随后一并 persist。
3. 测试（`tests/image-search-data-folders.test.cjs`，先红后绿）：H3/H2 各补契约断言
   （空 manifest 形态/getIndexPathStats('') 判空/H2 枚举与清理调用），批次一
   removedCount 断言随 H2 实现同步更新；新增两个可执行用例（loadTsModule + 真实
   fast_scanner addon）——H3：修复前 purge 最后一条记录直接 reject "No records to
   save"，修复后 result.ok、recordCount 0、manifest.json segments 为空、clearIndex 后
   loadManifest 不复活（记录数保持 0）；H2：修复前 purge 后 preview 记录仍在
   （removedCount 0、hasIndexPath true），修复后真实 .kra（AdmZip + sharp 构造）经
   indexProjectPreviews 入索引、空查询列表映射显示 sourcePath，文件夹删除后 preview
   记录被删（removedCount 1）、列表不再显示。30/30 通过。
4. 验证：`node --test tests/image-search-data-folders.test.cjs` 30/30；
   `npm run test:project-preview` 15/15、`test:ipc-validation` 4/4、
   `test:ipc-registration` 7/7、`test:preload-contract` 2/2；`tsc --noEmit` 与
   `tsc -p tsconfig.node.json --noEmit` 通过；ESLint 与 Prettier 改动文件通过。

边界：不改 native、不改 IPC 契约；空 manifest 只在"save 报 No records to save 且索引
确空"时写入，非空保存路径完全不变；H2 只删索引记录与向量数据，不删 preview 文件本身，
重新扫描可正常重建项目记录。

## 第一百零五批：Data Editor 编辑落盘重试与 GC 防护（批次三）

2026-08-02 在 `main` 修复审计发现的 Data Editor 三处缺陷：编辑后 persist 瞬时失败无重试、
编辑类 IPC handler 缺 GC/清理防护、`imageSearch:clearIndex` 只清内存不落盘（批次二发现的
同根问题）。

1. M4 persist 失败语义与重试（`imageSearchService.ts`）：编辑（删除/更新/修复/文件夹
   purge）后 `persistImageIndexEdits` 失败（writer busy 等瞬时错误）时，内存墓碑已写但
   UI 只报保存失败、之后不扫描则删除可能永不落盘。新增模块级 `editPersistRetryPending`
   标记：persist 失败（非"空索引"特例）时置位并返回带后缀的错误文案 `... (edit applied
   in memory; will retry saving automatically)`，让 toast 明确区分"已删除但保存失败、将
   自动重试"；`autosaveDirtyIndex` 开头检查该标记，置位则改走
   `persistImageIndexEdits()` 重试（重试再失败会自动重新置位，下一次时机继续），复用现有
   扫描完成触发的 autosave 链，不改 autosave 架构。
2. M6 编辑 handler 补 GC 防护（`imageSearchIpc.ts`）：`imageSearch:updateData`、
   `deleteData`、`deleteDataFolder`、`repairDataPath` 四个编辑 handler 此前没有
   startScan 同款的 `isVectorGcRunning()` / `isStorageCleanupActiveFor('image-search')`
   检查。新增 `imageSearchEditBusyError()` helper（返回与 startScan 完全相同的错误文案），
   四个 handler 入口先查 busy 直接返回 `{ ok: false, error }`。
3. clearImageIndex 落盘（`imageSearchService.ts`）：IPC `imageSearch:clearIndex` 此前只
   调 native `clearIndex()` 清内存，重启后旧 manifest 复活整个索引。现在清内存成功后，若
   当前索引根存在 manifest.json，复用批次二的 `persistEmptyImageIndex` 写空 manifest（并
   清理孤儿 segment/overlay）；持久化失败仅告警不回滚内存清理。
4. 测试（先红后绿）：`tests/image-search-data-folders.test.cjs` 补 M4 契约（标记/错误
   文案/autosave 重试分支）、M6 契约（helper 文案 + 四 handler 均调用）、clearImageIndex
   契约与可执行用例（修复前 clearIndex 后 manifest 仍含旧 segment → 复活，修复后
   segments 为空、loadManifest 后 0 条）。新增独立文件
   `tests/image-search-edit-persist-retry.test.cjs` 跑 M4 端到端：stub
   `saveIndexToManifestAsync` 瞬时拒绝（修复前错误文案无 retry 后缀 → 红），恢复后触发
   空目录扫描，autosave 链重试 persist 落盘，clearIndex + loadManifest 验证磁盘只剩未删
   记录。该用例必须独立进程：排查中发现用"segments 文件占位"逼 native save 失败会让
   worker 线程异常直接终止进程（exit 127 无输出，native 既有缺陷，本批未动 native），故
   改用 stub 注入瞬时失败，并避免与 folders 文件内其它可执行用例共享模块状态。
5. 验证：data-folders 34/34；edit-persist-retry 1/1；vector-gc + storage-cleanup 8/8；
   `test:ipc-validation` 4/4、`test:ipc-registration` 7/7、`test:preload-contract` 2/2；
   `tsc --noEmit` 与 `tsc -p tsconfig.node.json --noEmit` 通过；ESLint 与 Prettier 改动
   文件通过。

边界：不改 native、不改 IPC 契约；M4 重试只挂在现有 autosave 触发链（扫描完成时机），
不新增定时器；clearImageIndex 仅在磁盘已有 manifest 时写空 manifest，全新用户目录不
额外建目录。

## 第一百零六批：Data Editor 按目录名匹配统计与批量删除

2026-08-02 在 `main` 为 Image Search Data Editor 增加"目录名模式"：输入裸目录名（如
`image-search-queries`、`RWTemp`）即可统计并删除任意位置下同名子目录的全部索引记录，
不要求绝对路径。动机：应用查询缓存被索引在 Roaming 等位置，用户从 Temp 粘贴同名文件
想删却删不掉。

1. native（fast_scanner 0.5.21 → 0.5.22）新增两个原语：
   - `getIndexPathSegmentStats(name)`：返回 `{ok, name, count, totalBytes}`。name 先规范化
     （trim、折 `/`→`\\`、小写），空、含分隔符或长度 <2 返回
     `{ok:false, error:'Invalid directory name'}`；匹配谓词为 normalize 后的记录路径包含
     `\<name>\` 段。遍历/seen 去重/`deletedPaths` 跳过与 `GetIndexPathStats` 完全一致，
     shared_lock 只读。
   - `purgeIndexPathSegment(name)`：同谓词批量删除，writer lease、`deletedPaths` 墓碑、
     `pathIndexMap`/`failedPathMap` 清理与 `PurgeIndexPathPrefix` 同款；返回 removedCount。
   边界语义：段级精确匹配——`foobar` 不匹配 `foo` 段，文件名含该词（如
   `rwtemp-note.png`）不匹配 `rwtemp`，不同父目录下的同名目录都会被聚合/删除。
2. IPC 全链路：`imageSearch:getDirNameStats`（只读）、`imageSearch:deleteDirName`
   （busy 守卫与其他编辑一致，name 截断 256）。deleteDirName 不做 scanPaths 根校验——
   该功能的目的就是清理任意位置的同名目录——但 service 层 `normalizeDirNameArg` 按
   native 同款规则拒绝空/含分隔符/短于 2 的名称；purge 后走 `persistImageIndexEdits()`
   落盘并返回 removedCount，与文件夹删除一致。
3. UI（`ImageSearchDataManager.tsx`）：查询词为裸名称（不含 `\\` 与 `/`，`/` 已先行折叠）
   时进入目录名模式：runQuery 同时调 `getDirNameStats(term)`，统计条显示
   "目录名 'x'：共 N 条 · X MB"；列表保持现有子串查询（裸名称不触发前缀过滤，天然命中
   同名目录下的记录）。N>0 时显示"按目录名删除"按钮，两步确认（确认文案带 N 条 · X MB、
   说明删除所有位置下同名子目录的索引记录、不删源文件），成功后 toast removedCount、
   清空列表与两处统计、刷新文件夹聚合并触发 `onChanged()`。与文件夹模式（scanPaths
   按钮/绝对路径）互不干扰，disabled 行为一致。新文本走 t()（中英）。
4. 测试：`tests/native-scan.test.cjs` 新用例先红后绿（修复前
   `getIndexPathSegmentStats is not a function`）——不同父目录下同名目录聚合、大小写与
   正斜杠容忍、段边界（`foo`/`foobar`、文件名含词）、非法名称拒绝（空/单字符/含分隔符）、
   purge 后 hasIndexPath 翻转且源文件与旁路目录不受影响、统计随之归零。
   `tests/image-search-data-folders.test.cjs` 补 9 条契约断言（信道常量/契约/preload/
   bridge/service 校验与委托/IPC handler/native 导出/UI 目录名模式/i18n），43/43 通过。
5. 验证：Node 与 Electron 双 ABI 产物重建；native 测试全绿；data-folders 43/43；
   ipc-validation、ipc-registration、preload-contract 通过；`tsc --noEmit` 与
   `tsc -p tsconfig.node.json --noEmit` 通过；ESLint 与 Prettier 改动文件通过；
   runtime-manifest 同步 0.5.22 的 sha256/sizeBytes 且校验通过。

边界：不做目录名自动补全或历史记录；项目预览记录（.psd/.kra 等）不在目录名 purge 的
专项清理范围内（其 preview 路径不在用户命名的目录段下）；完整安装包未构建。

## 第一百零七批：Data Editor 指定文件夹 Native/DINO/CLIP 多层索引编辑

2026-08-02 根据用户对 `<PXHERE_IMAGES>` 的实际维护需求，实现指定绝对文件夹下 Native/Hash、
DINO、CLIP 三层索引的统一选择、只读分析和批量删除。详细操作说明见
[指定文件夹多层索引编辑](2026-08-02-image-search-folder-index-editor.md)。

1. 新增 `electron/imageSearchFolderDataService.ts`：流式扫描选中 DINO/CLIP `__global.jsonl`
   shard，仅提取 `imageId`，分别统计唯一图片、物理行、命中字节和临时空间；路径按精确子树
   边界匹配，不误伤同前缀 sibling。
2. 预览生成 15 分钟、一次性令牌并保存 shard size/mtime 指纹。执行前重验指纹和可用空间，
   要求“预计保留行字节 + 64 MiB”；预览后数据变化或空间不足时拒绝执行；盘符根和网络共享
   根不能作为批量目标。
3. DINO/CLIP 采用同目录临时文件流式改写、删除数复核和 rename 切换。旧 shard 作为
   `.gc-backup-*` 保留 7 天；取消或提交前错误会恢复已切换 shard，源图片从不写入或删除。
4. 最终阶段同步清理对应模型族的旧式 embedding/job/Native 辅助记录，使 DINO F16/ANN、
   CLIP F32/path cache 和向量 manifest 失效，并停止旧分层查询、释放进程内 ANN/CLIP cache。
   Native 继续复用现有 manifest/overlay 文件夹删除链。
5. `shared/ipc/image-search.ts`、`shared/ipc-contract.ts`、`imageSearchIpc.ts`、preload 和 Renderer
   bridge 新增 preview/execute/progress/cancel 四条受控链路。编辑任务与 Image Search
   扫描/搜索、embedding、cache build、Vector GC、向量迁移及相关 storage cleanup 全部互斥。
6. `ImageSearchDataManager.tsx` 在绝对路径查询旁新增“管理文件夹索引”：三层默认全选，先显示
   影响数量和空间，再二次确认；提供当前 shard、百分比、取消和分层结果。可见文案均进入 i18n。
7. 新增 5 个可执行专项用例，覆盖小型真实 shard 的三层删除、`images`/`images-old` 边界、
   源文件不变、预览后 shard 变化拒绝、未配置且零命中拒绝，以及取消后 shard 字节级不变；
   既有 Data Editor 契约同步扩展，合计 50/50。

真实数据只读结果：DINO 57,953 张/行，命中 953,788,813 B；CLIP 57,953 张/行，命中
642,131,156 B。两层相互一致；与截图 Native 57,963 条相比各少 10 条。扫描两个总计约
12.58 GiB 的 shard 耗时 32.501 秒，若执行预计需 11,909,975,178 B（约 11.09 GiB）临时
空间。本轮没有使用确认令牌，没有改写真实 shard 或源图片。

验证：`test:image-search-data-folders` 50/50、`test:vector-pipeline` 53/53、`test:i18n-static`
5/5、preload 2/2、IPC registration 7/7、IPC validation 4/4、guards 24/24、typecheck、
format 和 Renderer/main/preload/worker 生产构建通过。

边界：DINO/CLIP 可以按文件夹删除和重建，但不开放单向量浮点编辑；完整 shard 的旧文件会保留
7 天，因此删除完成不等于立即释放全部磁盘。跨 Native、JSONL 和辅助 store 的最终提交不是
单数据库全局 ACID 事务，界面按层返回实际结果和警告；首次真实大库执行仍需人工核对预览、
供电和磁盘空间。

## 第一百零八批：模型集成测试 fixture 迁移与事务覆盖率门禁恢复

2026-08-03 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，关闭 2026-08-02 审计阶段 A 的
两个 P1 项：Face/ReID/SAM 三组集成测试前置条件失真，以及 `assetMetadataTransaction.ts`
行覆盖率 83.13% < 84% 导致的 `coverage:critical` 失败。只改测试，不改运行时行为。

1. 新增 `tests/model-fixture-utils.cjs`：`installModelPlatformFixtures()` 把仓库 `models/`
   下的遗留 ONNX 仅作为 fixture 来源，复制进隔离的临时 userData 根（`os.tmpdir()`），按
   `shared/userModelPlatform.ts` 的槽位定义写入 `models/<slotId>/<targetFileName>` 和
   schemaVersion 3 的 `installation.json`（默认 profile），并在加载被测服务前 patch
   `Module._load`，把 `require('electron')` 替换为 `app.getPath('userData')` 指向隔离根的
   stub。真实用户模型槽位不被读写；fixture 来源缺失时测试保持原有 skip 语义。
2. `tests/face-match.test.cjs`、`tests/person-reid.test.cjs`、`tests/sam-segment.test.cjs`
   改用该安装器（face-detector/face-embedder、person-reid、segment-encoder/decoder 五个槽
   位），不再通过旧随包 `models/` 路径推断用户插槽状态；测试结束清理临时目录。
3. `tests/transaction-fault-injection.test.cjs` 新增 Part E 六个用例，全部针对真实异常与
   回滚分支：journal 条目六类非法形态拒绝、不可读/超限/非文件 journal、启动恢复清理孤儿
   stage/tmp、发布后指纹失配导致 "recovery failed; restart is required" 且 journal 保留、
   预备指纹格式非法在发布前中止并清理 stage、`includeArchive` 三目标完整提交。

验证（本机实测）：

- `node --test tests/face-match.test.cjs` 6/6、`tests/person-reid.test.cjs` 5/5、
  `tests/sam-segment.test.cjs` 6/6 通过（此前 11 个子测试失败）；
- `test:face-match` 13/13、`test:person-reid` 5/5、`test:subject-crop` 33/33 通过；
- `coverage:critical` 83/83 测试通过，`assetMetadataTransaction.ts` 行覆盖率
  83.13% → 93.89%（分支 82.54%、函数 100%），门禁通过；
- 完整 `npm test` 全链通过（含 build:native 与 native 60/60），退出码 0；此前标准链在
  Face Match 阶段提前停止的问题已消除。

边界：fixture 仍依赖仓库 `models/` 下的遗留 ONNX 文件作为来源，干净 worktree 中这些套件
继续按 skip 处理；本批没有修改 `faceMatchService`/`personReidService`/`samSegmentService`
的任何运行时逻辑，也没有触碰真实 userData。

## 第一百零九批：Storage Inventory 口径修复与 embedding jobs 只读分类预览

2026-08-03 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应 2026-08-02 审计阶段 B：
修复库存统计的三类口径缺陷，并为 23.5 万条永久 pending 任务建立只读分类预览。本批不删除、
不迁移任何真实数据；唯一新增写入是 GC 预览派生的 `vector-gc-estimate.json` 小文件。

1. **vector-jsonl 可回收口径**：新增 `electron/vectorGcEstimate.ts` 统一拥有
   `vector-db/vector-gc-estimate.json` 的格式（schemaVersion 1，per-shard
   size+mtime 指纹 + reclaimable/predicted 字节）。`previewVectorGc`（UI 与
   `preview:vector-gc` 共用）每次预览后持久化估算；库存只统计指纹仍匹配的 shard，
   任何 shard 变更（含真实 GC 执行）自动失效并 fail-closed 到 0。真实数据实测：
   库存显示 reclaimable 5.48 GiB（2/2 shard 匹配），与审计数字一致。
2. **media-vectors 递归口径**：从"只枚举 media-search 根目录直属文件"改为根文件 +
   除 `frames/` 外全部一级子目录（manifests/vectors/ocr/transcripts/stats/thumbnails/
   temp），符号链接跳过。真实数据从 0 B 修正为 0.49 GiB / 931 文件。
3. **Image Search 索引孤儿区分**：库存读取 manifest.json（64 MiB 上限、路径逃逸校验），
   仅把 segments/ 与 staging/ 下未被引用且早于 24 小时保护窗口的文件计为 reclaimable；
   manifest 缺失/不可读时孤儿估算 fail-closed 为 0。真实数据：总 0.49 GiB 中孤儿约
   0.44 GiB（与审计约 458 MiB 一致），detail 明确实际回收仍需任务空闲与 manifest 复核。
4. **用户模型目录**：新增 `user-models` 库存项（userData/models，高风险、不可重建、
   reclaimable 恒 0）。真实数据 0.41 GiB，与审计一致。修复后库存总 reclaimable 约
   9.66 GiB，与审计"约 9 GiB 可安全预览"互相印证。
5. **embedding jobs 只读分类预览**：新增 `electron/embeddingJobsClassifier.ts` 与
   `npm run preview:embedding-jobs`（`--with-embedding-check` 可选）。流式分类
   malformed、terminal、pending/running 年龄桶、owner/heartbeat/epoch 未来字段、
   重复键与 stale 候选（超龄且无 live owner）；可选第二遍用 Buffer 定点字段提取扫描
   权威 shard（不解析向量数组），求"已有 embedding 的 stale 任务"交集。只读，不写
   jobs 文件。真实数据：235,635 行全部 pending、全部 >30 天、0 重复、0 malformed、
   0 owner 字段，流式扫描约 1 秒（对比全量解析 424 ms + 341 MiB RSS，内存有界）；
   含 embedding 检查时 213,203 行（86.2 MB）已有 embedding，属最安全的迁移候选，
   其余 22,432 行需逐一甄别。迁移本身待用户确认后另行实施。
6. 测试：`tests/storage-inventory.test.cjs` 增至 8 例（GC 估算生效/失效、孤儿区分、
   fail-closed、media 递归、user-models）；新增 `tests/vector-gc-estimate.test.cjs`
   5 例（读写往返、指纹失效、畸形/超限/逃逸拒绝、写入失败不抛出）与
   `tests/embedding-jobs-classifier.test.cjs` 6 例（分类、年龄桶、重复、畸形行、
   embedding 交集、shard 不可读 fail-closed）。两文件均接入 `test:vector-pipeline`。

验证：vector-pipeline 69/69；`coverage:critical` 83/83 通过（vectorGcService 57.33%
行覆盖回到 57 基线之上，assetMetadataTransaction 93.89%）；typecheck、ESLint、
Prettier（electron/src/shared）通过；完整 `npm test` 全链通过（退出码 0，含 native
60/60）。真实数据验证均为只读预览，唯一写入为派生估算文件。

边界：库存 reclaimable 是估算而非可执行清理单；Vector GC 执行、索引孤儿回收和 jobs
迁移仍属阶段 C，需分批预览与用户确认。jobs 分类器的 owner/heartbeat/epoch 字段当前
真实数据为 0，属未来 schema 的前向兼容；`--with-embedding-check` 需顺序读取约
12.58 GiB shard（实测约 149 秒），日常刷新不必开启。

## 第一百一十批：阶段 C 分批安全回收（真实数据，逐批预览确认）

2026-08-04 由 Kimi（Kimi Code CLI，精确模型版本未公开）执行。对应 2026-08-02 审计阶段 C；
每一步均先出只读预览数字、经用户逐项确认后才执行，执行期间确认 FloatingClock 应用未运行。

1. **C1 低风险清理（已执行）**：复用 `storageCleanupService` 预览令牌链，用户确认低风险批
   + 向量缓存（旧素材备份明确不删）。删除 18,727 个文件，释放 **2,864,920,123 B（约
   2.67 GiB）**，0 跳过 0 错误；删除清单快照存于 `storage-cleanup-snapshots/`。范围：
   超期扫描日志 800 MB、缩略图 3 MB、F32/F16/path 派生缓存 1.65 GiB、ANN 3.4 MB、
   媒体抽帧 231.5 MB，全部为可重建/超期数据。
2. **C2 manifest-aware 索引孤儿回收（新建并执行）**：新增
   `electron/imageSearchIndexOrphans.ts`（preview/execute 分离：执行时重读 manifest 并
   比对 size+mtime 指纹，逐文件复核"未被引用 + realpath 含于索引目录 + mtime/size 未变"
   才删除，失败 fail-closed；删除报告落盘 `image-search-orphan-reports/`）与
   `npm run image-search:orphan-cleanup`（默认只读，`--execute` 执行）。
   `storageInventory` 改为复用其 manifest 读取与保护窗口常量。真实执行：39 个未被引用
   的旧 segment/staging 文件（6–7 月遗留），释放 **475,554,364 B（约 453.5 MiB）**，
   0 跳过 0 错误，当前 3 个引用 segment 未动。
3. **C3 Vector GC 执行（用户确认后执行）**：`previewVectorGc` → `startVectorGc` 令牌链
   压实两个权威 shard：CLIP 5,460,308,954 → 3,050,675,934 B，DINO 8,045,586,193 →
   4,571,656,341 B，合计可回收 **5,883,562,872 B（约 5.48 GiB）**，0 错误；旧 shard
   作为 `.gc-backup-*`（含 expiresAt 元数据）保留 7 天，到期由既有清理链处理，因此
   磁盘净释放将在备份过期后兑现。
4. **GC 后验证**：复跑 `preview:vector-gc` 全量解析两个新 shard——active 记录数与 GC 前
   完全一致（CLIP 273,375 / DINO 276,534），stale/duplicate/malformed 全部为 0，
   reclaimable 归零；真实抽样两个 shard 各 2,000 行，维度、有限值、单位范数全部通过；
   `test:neko-search-cluster` 27/27、`test:vector-pipeline` 74/74 通过。
5. **库存闭环**：GC 后库存 vector-jsonl 7.10 GiB（reclaimable 0，估算文件已自动刷新）、
   image-search-index 0.05 GiB（孤儿归零）、vector-gc-backups 12.58 GiB（受 7 天保护，
   reclaimable 0 符合预期）；全库 reclaimable 从 9.66 GiB 降至 1.09 GiB（剩余为未确认的
   旧素材备份 0.60 GiB 与 media-vectors 0.49 GiB）。

验证：`test:vector-pipeline` 74/74（含新增 `image-search-orphan-cleanup` 5 例：预览边界、
fail-closed、执行+报告、manifest 漂移中止、目标漂移跳过）；typecheck、ESLint、Prettier
通过；完整 `npm test` 全链通过（退出码 0）。

边界与遗留：① 素材库旧备份（约 0.60 GiB）与 media-vectors（约 0.49 GiB）用户本轮未确认，
保持原状；② GC 备份 12.58 GiB 于 2026-08-11 前后到期，届时过期快照可经既有清理链删除；
③ embedding jobs 迁移（97 MB / 235,635 行）仍待用户确认后单独实施；④ C3 执行驱动脚本
在轮询期间出现过一次 MaxListenersExceededWarning（WriteStream error listener），不影响
结果但值得在后续 GC 驱动中排查监听泄漏；⑤ 本轮所有真实删除均未触碰源图片、素材主数据、
最新备份与用户模型。

## 第一百一十一批：embedding jobs 陈旧任务原子迁移

2026-08-04 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施并执行，关闭 2026-08-02 审计
最后一个 P1 工程项（`embedding_jobs.jsonl` 永久 pending 失真）。按审计原则不直接清空：
只归档"权威 shard 中已有对应 embedding"的 pending/running 行，其余一律保留。

1. 新增 `electron/embeddingJobsMigration.ts`：先流式读取全部 `__global.jsonl` shard 的
   (imageId, modelName, embeddingType) 键（Buffer 定点提取，不解析向量数组；shard 不可读
   即中止），再流式分区 jobs 文件——terminal、无 embedding、带 live owner 心跳和 malformed
   行全部保留，仅已有 embedding 的 pending/running 行写入同目录时间戳归档文件。提交路径：
   独立临时文件 → 行数复核 → 原文件改名时间戳备份 → rename 切换 → 切换后逐行复检；任何
   一步失败回滚，绝不在原文件上就地截断。`embeddingJobsClassifier` 的键函数导出复用，
   分隔符修正为显式 `\u001f` 转义。
2. 新增 `npm run jobs:migrate-stale`（默认 dry-run，`--execute` 执行）与
   `tests/embedding-jobs-migration.test.cjs` 5 例（干跑不动文件、迁移+备份、无证据拒绝、
   shard 不可读中止、键不匹配保留），已接入 `test:vector-pipeline`。
3. 真实执行（应用未运行，先 dry-run 再经用户确认）：235,635 行 / 97,196,022 B → 保留
   66,749 行 / 28,836,006 B，归档 168,886 行 / 68,360,016 B 到
   `embedding_jobs.stale-archive-2026-08-04T12-15-21-587Z.jsonl`，原文件完整保留为
   `embedding_jobs.migration-backup-2026-08-04T12-15-21-587Z.jsonl`。未删除任何数据。
4. 与第一百一十批的交互：分类预览（第一百零九批）时"已有 embedding"为 213,203 行，本次
   归档 168,886 行；差异 44,317 行是 Vector GC 已把对应 stale/duplicate 向量压实删除，
   这些行因此不再匹配 shard 键而被保守保留。其中约 22,432 行是始终无 embedding 的真实
   积压，其余是"图片可能已不在活跃索引"的待甄别行，留给未来 epoch/扫描快照口径处理。
5. 迁移后验证：`preview:embedding-jobs` 复核新文件 66,749 行 / 28.8 MB、0 malformed；
   全量加载成本从约 424 ms / 341 MiB RSS 降至约 1/3.4。

验证：`test:vector-pipeline` 通过（含迁移 5 例）；typecheck、ESLint、Prettier 通过；
完整 `npm test` 全链通过（退出码 0）。

边界：① 归档与备份文件合计约 157 MB 仍占磁盘，待用户确认后可另行删除；库存
`vector-jobs` 项目前只统计 `embedding_jobs.jsonl` 本体，归档/备份文件名不在其口径内；
② jobs 文件仍是状态快照而非 epoch 账本，新任务还会以同样方式累积，根治需阶段 D 的
epoch/owner/heartbeat schema；③ 保留的 66,749 行依然全部超龄，其中无 embedding 的行
是否值得重建，需在下次扫描/embedding 计划时评估。

## 第一百一十二批：权威 F16 向量 generation 真实迁移与召回门禁

2026-08-04 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应 2026-08-02 审计阶段 D 的
"权威二进制向量 store 切换门禁"第一步：先建逐模型召回/数值误差门禁，再执行真实迁移并用
门禁验证。双写/增量合并/语义搜索 F32 链路改造明确留待 D2。

1. 新增 `electron/vectorGenerationRecall.ts`：对齐 JSONL（F32 精确）与 generation（F16）
   的路径集合，抽样真实查询向量做双存储精确 top-K 扫描，输出 recall@K、自查询在 top-K
   比例、top-1 分数差和分数误差分位数。新增
   `npm run verify:vector-generation-recall`（门禁失败非零退出，即审计要求的"双读"验证）
   与 `npm run vector-store:migrate`（默认只读预览，`--execute` 驱动既有
   `vectorStoreMigrationService` 执行）。
2. 真实迁移（应用未运行、用户确认后执行）：CLIP 512d + DINO 768d 两个 shard 生成
   generation `20260804131624619-5c16d903`，写入 792,394,004 B（约 756 MiB），77 秒完成，
   0 错误；manifest 全量 SHA 校验通过，双模型句柄可打开，count 与 GC 后 active 数一致
   （273,375 / 276,534）。JSONL 权威 shard 未改动，仍作兼容导入日志。
3. 真实召回门禁（200 查询 × top-50 × 双存储全扫描）：CLIP recall@50 均值 0.9969、
   DINO 0.9965（阈值 0.99）；自查询在 top-50 比例 1.000 / 0.995（阈值 0.995）；
   top-1 分数差最大 1e-10 量级（阈值 1e-3）——所有"未居首位"均为与完全重复向量的
   精确平分；分数误差中位 7.6e-6 / 4.1e-6。**门禁通过（2/2）**。报告：
   [召回门禁报告](../benchmark/2026-08-04-vector-generation-recall.md) +
   原始 JSON（同目录，不手工改写）。
4. 门禁口径修正记录：首版以"自查询 top-1 = 100%"为阈值，真实数据显示 top-1 比例仅
   0.88/0.91 但分数差 ≤ 1e-10，属近重复精确平分而非缺陷；阈值改为 self-in-top-K +
   top-1 gap 口径后通过。合成测试（`tests/vector-generation-recall.test.cjs` 4 例）覆盖
   通过、召回崩溃拒绝、缺失路径排除和截断拒绝，已接入 `test:vector-pipeline`。

验证：`test:vector-pipeline` 通过（含召回 4 例）；typecheck、ESLint、Prettier 通过；
完整 `npm test` 全链通过（退出码 0）；迁移后 manifest 校验、句柄与 count 复核如上。

边界：① 本次迁移后若再有新 embedding 写入 JSONL，读取层按既有 mtime 失配逻辑回退
派生缓存重建，需重新迁移才能回到权威 generation（增量合并属 D2）；② 语义搜索 F32 链路、
素材库 CLIP 读取、Media Search 帧索引仍不经 generation（D2）；③ JSONL shard 不进入清理
预览；④ 召回门禁全量双扫描约 5.4 分钟，适合迁移后或定期校验，不适合日常刷新。

## 第一百一十三批：权威向量库增量迁移

2026-08-04 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D2a：embedding 追加
导致 JSONL 增长后，重新迁移只导入增量行而非全量重建（全量需读 7.62 GiB）。语义搜索
F16 改造与 Media 帧索引明确留待 D2b/D2c。

1. `electron/embeddingF16Cache.ts` 新增导出 `extendEmbeddingF16Cache`：以 CURRENT 旧
   generation 为基座，先做 append-only 证明（逐源比对 imports 指纹：size 缩小、同尺寸
   但 mtime 变化、路径不一致、旧 EOF 不在行边界，一律返回 null 回退全量），再从旧
   imports 偏移流式读取增量行，按 buildCache 相同的"最新修订胜出 + 最后出现排序"
   语义合并——被更新路径的旧行作废并移到最新位置，未作废旧行整块字节拷贝。写盘前
   对全部源做闭环 stat 复核，期间任一变化即放弃产出。产出三件套经
   `replaceDerivedFile` 原子替换。
2. `vectorStoreMigrationService.executeMigration` 改为增量优先：`extendEmbeddingF16Cache`
   返回 null 时自动回退既有 `ensureEmbeddingF16Cache` 全量路径；staging、SHA 校验、
   CURRENT 原子切换零改动复用。manifest version 1 不变，未加锚点字段。
3. 等价性保证：增量结果与全量重建**逐字节一致**（同一 JSONL 行、同一归一化编码、
   同一路径序），由专项测试锁定。

验证（`tests/vector-store-incremental.test.cjs` 3 例，已接入 `test:vector-pipeline`）：

- 纯追加增量：gen2 的 `.f16`/`.paths.jsonl` 与独立全量重建逐字节一致，gen2 manifest
  通过 `openAuthoritativeVectorStore` expectedSourcePaths 校验；
- 重复修订（同路径多次重新 embedding）：增量 == 全量，路径序为
  `b, c, a(最新)`，`count` 不膨胀（3），`sourceRecordCount` 正确累加（5）；
- 回退矩阵：无 generation 基座、size 缩小、同尺寸 mtime 变化、旧 EOF 非行边界，
  均返回 null 且迁移经全量路径完成、内容正确。

typecheck、ESLint、Prettier、`test:vector-pipeline`、既有迁移/F16 缓存测试无回归；
完整 `npm test` 全链通过（退出码 0）。

边界：① mtime 不变的原地改写检测不到（现实改写路径都会动 mtime；tailSha256 锚点列为
后续增强）；② legacy `image_embeddings.jsonl` 是高频整文件重写源，用户清理图片后增量
自动回退全量，行为正确但命中率取决于清理频率；③ 当前真实 generation 已最新，真实
增量场景（embedding 增长后的增量迁移）留待下次自然增长后验证；④ 迁移窗口仍由既有
IPC 互斥（embedding/GC/folder edit）保护。

## 第一百一十四批：CLIP 搜索缓存统一到共享 F16 缓存（D2b 补记）

2026-08-05 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D2b（commit
`1ac7dad`，提交当时漏记本批次，现补录）：语义搜索与素材库各自的私有 CLIP F32 缓存
（`clip_embedding_cache.f32/.json/.paths.jsonl`）统一到 DINO 与权威向量库共用的
`embeddingF16Cache` 模块。

1. `semanticSearchService` 删除私有 CLIP F32 缓存的构建/校验/读取代码，改为
   `ensureEmbeddingF16Cache`；扫描路径经 `float16ToFloat32` 解码 F16 行，
   `PreparedClipEmbeddingCache` 暴露 `dtype: f16-le`。
2. 移除 `searchClipEmbeddingsByFeedbackTarget`（分类反馈搜索归
   `assetCategoryFeedbackWorker` 所有，无残留引用）。
3. `clipEmbeddingCacheReader` 改读 embedding-cache 的 F16 布局（显式 `{row, path}` 记录）；
   `embeddingExistingIndex` 删除 legacy CLIP F32 描述符；向量维护统计指向 F16 缓存。
4. 三个受影响的测试 fixture 重写为 F16 布局并改容差断言；eval 脚本同步解码 F16。

验证：typecheck、ESLint、Prettier 通过；`test:asset-library` 118/118；
`embedding-build-performance` 8/8；neko 准确度基准 CLIP 变体退出码 0
（P@20=1.0，warm p95 约 20.1s）。

边界：Media Search 帧索引与帧覆盖率统计仍逐行扫 JSONL shard（留待 D2c）；私有 F32
缓存文件不主动删除，由既有清理预览兜底。

## 第一百一十五批：Media Search 帧索引改读权威 generation（D2c）

2026-08-05 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D2c：Media
Search 帧索引与帧覆盖率统计从"逐行扫 JSONL shard"迁移到优先读权威
generation / 共享 F16 缓存（失配回退与现状等价）。只改读取路径，不动用户数据、
不删任何文件、无迁移协议。

1. `electron/embeddingF16Cache.ts` 新增三个共享导出：
   `readFreshEmbeddingF16Cache`（仅返回与当前源统计可证明同步的句柄——imports
   匹配的 CURRENT generation 或精确匹配源的派生缓存，供同步入口安全使用）；
   `describeEmbeddingVectorSource`（freshness 指纹：generation 存活时为
   `generation:<代>:<count>:<sourceRecordCount>`，否则回退 `jsonl:<路径=size:mtime>`，
   与旧 shard 口径等价）；`readEmbeddingF16VectorsForPathsSync` /
   `readEmbeddingF16CachePaths`（同步点查与路径清单读取）。
   `vectorDatabaseService` 新增 `getEmbeddingCacheDir()` 统一 cacheDir 口径。
2. `mediaSearchFrameIndex`：`buildFrameIndex`（同步）经
   `readFreshEmbeddingF16Cache` 读 generation/派生缓存，失配回退原 JSONL 逐行扫；
   `buildFrameIndexAsync` 经 `ensureEmbeddingF16Cache`（必要时重建派生缓存）；
   `findFrameVector` 在紧凑索引未命中后先查同步的 generation/缓存，最后才扫 shard。
   派生索引 `frame_embedding_index.jsonl` 的 freshness 签名改挂
   `describeEmbeddingVectorSource` 指纹（generation 切换不再误判过期，shard
   任何漂移仍触发重建）；latest-revision-wins 去重语义由 F16 构建天然对齐。
3. `videoFrameService`：`collectEmbeddedImageIds` 覆盖率统计改读 F16 路径索引
   （覆盖 model shard + legacy `image_embeddings.jsonl`，与旧 JSONL 口径一致），
   无法建缓存时回退原流式扫描；`getFrameEmbeddingStatsSignature` 的模型 freshness
   改挂 generation/manifest 指纹。
4. `mediaCacheService` 口径核对：`clearMediaSearchData` 的帧 embedding compaction
   覆盖 `getEmbeddingStorePaths` 全集（shard + legacy），与 F16 缓存源集合一致；
   compaction 缩小 JSONL 后 generation imports 失配自动失效、派生缓存 stat 失配
   触发重建，统计口径无需改代码即可同步，故该文件零改动。

验证（`tests/media-frame-index-generation.test.cjs` 2 例，已接入
`test:vector-pipeline`）：

- 双源对齐：合成 shard + legacy 双源，先以 JSONL 口径建基线索引与覆盖率统计，
  迁移出 generation 后重建——索引路径集合完全一致、向量逐分量差 ≤ 2e-3（F16
  舍入内）、`clipEmbeddedFrames`/`coverageByDrive` 与基线一致（含 legacy 帧行）；
  meta 签名含 `generation:`；`findFrameVector` 在索引删除后从 generation 命中。
- 失配回退等价：generation 存活后向 shard 追加新帧 embedding（不重新迁移），
  `isFrameIndexFresh()` 翻 false，`ensureFrameIndexFreshAsync` 重建拾取新帧，
  签名回退 `jsonl:`，统计口径同步为 4/4。

回归：`test:vector-pipeline` 88/88、`test:media-search` 32/32、typecheck、ESLint、
Prettier 全绿。真实数据只读对比（`media-search-recall-benchmark.cjs` 需全量扫
多 GiB shard）本次 not-run：会话时长不足，留待下次维护窗口；完整 `npm test`
not-run（同上原因，相关链路已由两个专项 script 覆盖）。

边界：① generation 失配期间帧索引构建仍全量读 shard（经派生缓存重建），增量
合并命中后可规避；② F16 构建会剔除旧口径会计入的畸形向量行（非有限值/零范数/
维度不足），正常数据无差异；③ 语义搜索与帧索引已 generation 化后，JSONL 仍
是 generation 的导入源与回退副本，清理预览口径不变。

阶段 D3（embedding 追加双写 JSONL + generation 增量日志，关闭兼容窗口剩余写入口）的
设计决策记录见
[2026-08-05 embedding 追加增量日志设计](2026-08-05-embedding-append-incremental-log-design.md)。

## 第一百一十六批：embedding 追加双写 generation 增量日志（D3 阶段 1）

2026-08-05 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D3
阶段 1（设计：
[2026-08-05 embedding 追加增量日志设计](2026-08-05-embedding-append-incremental-log-design.md)）。
只加写路径：追加 embedding 时在既有 JSONL 追加之后，向 CURRENT generation
的从属增量日志双写同一向量并提交 `delta.json`。**读取路径零改动**，不动
`ensureEmbeddingF16Cache` 回退逻辑、不改 IPC 契约、不删任何用户数据；
回退方式 = 删除 `vector-store/incremental/` 目录，行为即回到现状。

1. 新增 `electron/embeddingIncrementLog.ts`：
   `prepareEmbeddingIncrement`（追加前校验/恢复）+
   `appendEmbeddingIncrementRow`（追加增量段并提交）。协议要点落地：
   - 写入顺序严格为 JSONL 行 → `delta.f16`/`delta.paths.jsonl` →
     `delta.json`（临时文件 + rename，与 `CURRENT` 切换同一原子原语）；
     反向顺序被结构排除（prepare 在 JSONL 追加前、提交在其后）。
   - `delta.json` 携带 `EMBEDDING_DELTA_VERSION = 1`、基座 generation、
     模型三元组、`deltaCount`、基座 `count`/`sourceRecordCount`、逐源尾部
     锚点 `{path, size, mtimeMs, tailSha256}`（锚定 size 处结尾的最后
     64 KiB 窗口 SHA-256）。
   - 重启校验：version/generation/三元组/基座计数对齐 CURRENT manifest；
     增量段截断恢复到已提交 `deltaCount`（唯一的半截写恢复动作，不做逐行
     修复）；**写入者锚点判定从严**——`stat.size` 必须精确等于锚点（读取层
     的"JSONL 领先"宽容不适用于写入者，否则新增量行与 JSONL 行错位且缺口
     被锚点掩盖），失配即删除整个增量目录、退化现状（fail-safe，JSONL
     权威地位不变）。已按此同步澄清设计文档"崩溃一致性协议"一节。
   - 全量重建会剔除的不可编码行（非有限/零范数/维度不足）只推进源锚点、
     不加增量行，与重建跳行语义对齐；F16 编码与 `encodeNormalizedVector`
     逐字节一致（复用 `float32ToFloat16`）。
2. `electron/vectorDatabaseService.ts`：`appendEmbeddingNoUpsertAsync` 的
   `embeddingAppendChain` 链内挂接双写（prepare → JSONL append → 增量段 +
   提交点），同步变体 `appendEmbeddingNoUpsert` 同口径；增量侧任何异常
   静默回退为纯 JSONL 追加，不影响既有追加契约。每次追加重读
   CURRENT/manifest，进程内迁移切换代后自动按新基座重新校验。
3. 专项测试 `tests/embedding-increment-log.test.cjs`（6 例，已接入
   `test:vector-pipeline`）：增量段与 JSONL 尾部逐字节对应（独立参考实现
   + 全量重建尾部比对，行号从基座 `count` 顺延）；三种崩溃恢复——崩在
   JSONL 半截行（增量被忽略、追加仍落盘）、崩在增量段半截（截断到提交点
   后续写）、崩在 `delta.json` rewrite（临时文件残留清理、旧提交点完好，
   另覆盖提交点损坏整体丢弃）；增量目录损坏/缺失与锚点失配的 fail-safe
   降级；20 路并发追加经串行链不交错（JSONL 尾部与增量段逐行对齐）。

验证：

- `npm.cmd run test:vector-pipeline`：94/94 通过（88 既有 + 6 新增），含
  迁移/增量迁移/GC/召回全部既有用例无回归。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`
  全绿。完整 `npm test` not-run（会话时长不足，相关链路已由
  `test:vector-pipeline` 覆盖）。

边界：① 阶段 1 无读取端耦合：追加后派生缓存/ANN/帧索引仍按现状失配
重建，"追加自然生长"的收益在阶段 2（复合快照 + 指纹演进）才兑现；② 与
迁移/GC 的互斥未新增锁——既有互斥矩阵不变，迁移排空规则与旧增量目录
的顺带删除属阶段 2 接线，阶段 1 靠校验自然失效兜底（generation/锚点
失配即忽略，安全由构造保证）；③ 崩在 JSONL 半截行后的首次追加会把新行
黏在无换行的半成品行尾（生产既有行为），该黏合行对行读取器不可见——
增量此时已整体丢弃，行为等同现状；④ legacy `image_embeddings.jsonl`
整文件重写会令锚点失配、增量丢弃回退现状，与设计非目标一致；⑤ 增量
写入无独立开关，回退即删 `incremental/` 目录，下次追加因 JSONL 已领先
基座而不会重建增量，直到下一次迁移。


## 第一百一十七批：读取端复合快照与指纹演进（D3 阶段 2）

2026-08-05 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D3
阶段 2（设计：
[2026-08-05 embedding 追加增量日志设计](2026-08-05-embedding-append-incremental-log-design.md)）。
把阶段 1 双写的增量对读取端开放：消费方读取"基座 generation + 已提交
增量段"的复合快照，追加 embedding 后派生缓存（CLIP F16 缓存、ANN、帧
索引）不再被判失配重建。不改 IPC 契约、不删用户数据；回退方式 = 删除
`vector-store/incremental/` 目录，行为即回到阶段 1 完成态。

1. `electron/embeddingIncrementLog.ts`：新增读取侧
   `readEmbeddingIncrementSnapshot`（只读校验，绝不截断/删除）与
   `discardEmbeddingIncrement`（执行方清理入口）。读取侧校验对齐设计的
   重启一致性校验第 1-3 步，但两处与写入者口径不同：
   - "JSONL 领先增量"（`stat.size > 锚点 size`）对读取者宽容：快照有效
     但标记 `complete=false`，已提交增量仍可见；
   - 未提交的增量段尾部只忽略、不截断（截断恢复仍是写入者独占动作）。
   另：`float32ToFloat16` 本地化拷贝，断开与本阶段新增的
   `embeddingF16Cache → embeddingIncrementLog` 依赖之间的模块循环。
2. `electron/embeddingF16Cache.ts`：复合句柄（`EmbeddingF16CacheHandle.delta`
   段，`meta.count`/`sourceRecordCount` 含 δ，`sourceFiles` 追加增量段
   统计使 ANN 指纹随追加变化）；`readFreshCache` /
   `readExistingEmbeddingF16Cache` / `describeEmbeddingVectorSource`
   复合口径；`streamEmbeddingF16Cache` 与两个
   `readEmbeddingF16VectorsForPaths` 变体的行定位改为"先基座、越界行
   落入增量段"（`createCacheRowReader`）。freshness 语义落地：
   - 增量完整（逐源 stat 精确等于锚点 + mtime/tailSha256）→ 复合快照
     新鲜，指纹 `generation:<代>:<count+δ>:<sourceRecordCount+δ>`，
     不跌回 `jsonl:`；
   - JSONL 领先增量（崩溃窗口）→ fresh 读判 null 回退重建（尾部差额
     走失配回退），stale-tolerant 的 existing 读仍见已提交复合视图，
     指纹退回 `jsonl:` 口径；
   - generation 切换 → 增量基座失配即忽略，与阶段 1 一致。
   新增 `embeddingVectorSourceStabilityKey`：generation 类指纹只保留
   `generation:<代>`，供只依赖代身份的派生索引使用。
3. 消费方适配：`electron/vectorAnnWorker.ts` 复合句柄拼接基座+增量段
   （按提交行数截取，容忍未提交尾部）——ANN 按指纹失配重建一次，属
   设计约定，ANN 增量化仍为后续优化；`electron/vectorGenerationRecall.ts`
   召回评估接受复合句柄（结构化类型 `GenerationRecallVectorSource`，
   F32 对照仍扫 JSONL shard 本身，口径不变）；召回门禁脚本
   `scripts/verify-vector-generation-recall.cjs` 改经
   `readFreshEmbeddingF16Cache` 取复合句柄，追加后不再直接判 null；
   `electron/mediaSearchFrameIndex.ts` 与 `electron/videoFrameService.ts`
   的 freshness 签名改用 stability key——同代追加不再重建帧索引/统计，
   换代或退回 `jsonl:` 口径仍失效。
4. 迁移前排空与旧增量清理（批次116 边界② 接线）：
   `electron/vectorIpc.ts` 迁移与 GC 启动前 `await flushVectorDatabaseWrites()`
   排空追加链——增量双写就在同一链步骤内同步完成，无需独立增量链
   flush，`extendEmbeddingF16Cache` 的闭环 stat 复核继续兜底；
   `electron/vectorStoreMigrationService.ts` 在 `CURRENT` 切换成功后对
   每个迁移模型 `discardEmbeddingIncrement`（旧增量基座/锚点自然失效，
   顺带删除不留孤儿）；`electron/vectorGcService.ts` 压实 shard 成功后
   同口径删除该模型的增量目录。
5. 专项测试 `tests/embedding-composite-snapshot.test.cjs`（5 例，已接入
   `test:vector-pipeline`）：复合快照读取与纯 JSONL 全量重建逐行对齐
   （逐分量容差 2e-3 覆盖 F16）+ 追加后 `ensureEmbeddingF16Cache` 不重建；
   未提交增量尾部对复合视图不可见；JSONL 领先增量时 fresh 判 null /
   existing 仍见复合 / 指纹退回 `jsonl:`；迁移换代后旧增量目录删除且
   新代指纹正确；召回门禁复合口径通过、删增量后明确判失败。

验证：

- `npm.cmd run test:vector-pipeline`：99/99 通过（94 既有 + 5 新增），
  含迁移/增量迁移/GC/召回/帧索引 generation 全部既有用例无回归。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`
  全绿；摸了 media/semantic 消费方，加跑 `npm.cmd run test:media-search`
  与 `npm.cmd run test:asset-library` 全绿。完整 `npm test` not-run
  （会话时长不足，相关链路已由上述套件覆盖）；真实数据小批量追加后的
  召回门禁复跑留待维护窗口按既有真实执行纪律执行。

边界：① 基座 manifest imports 的可选 `tailSha256` 字段本阶段未实施
（设计标注可选，`delta.json` 锚点已携带 tailSha256；旧应用宽容读取的
结论不变，留待后续随迁移写入侧一并落地）；② 召回门禁复合路径沿用
`readCurrentAuthoritativeManifest` 的默认校验，不含原脚本
`verifyFileChecksums=true` 的逐文件 sha256 复核（manifest 哈希校验仍在）；
③ 读取侧对源文件 ENOENT 从严判失效（返回 null），不同于
`openAuthoritativeVectorStore` 对"已移除导入副本"的宽容——增量锚定的
shard 本身缺失时无法证明复合视图完整；④ `extendEmbeddingF16Cache` 未改：
增量存在时增量迁移仍从旧基座合并完整 JSONL 尾部，latest-revision 去重
保证结果正确，"增量段整块保留、只合并锚点之后尾部"属性能优化留待后续；
⑤ ANN 在每次追加提交后按指纹重建一次（设计约定），同代追加只免除派生
F16 缓存与帧索引的重建。

## 第一百一十八批：诊断/导出入口改读复合快照（D3 阶段 3）

2026-08-05 由 Kimi（Kimi Code CLI，精确模型版本未公开）实施，对应阶段 D3
阶段 3（设计：
[2026-08-05 embedding 追加增量日志设计](2026-08-05-embedding-append-incremental-log-design.md)）。
诊断/导出入口改读"基座 generation + 已提交增量段"的路径索引，维护页
统计不再逐行扫多 GiB JSONL shard。不改 IPC 契约、不删用户数据；回退
方式 = 统计入口切回 JSONL 扫描，口径等价。

1. 排查结论：`getVectorMaintenanceStats`
   （`electron/vectorMaintenanceService.ts`）是诊断/导出类中唯一逐行
   扫 shard 取数的入口（dino/clip 各一次全量行扫）。其余
   `getEmbeddingStorePaths` 消费方均为搜索/构建数据路径
   （`embeddingService` 的 existing-scan、`vectorIndexService` 的 ANN
   构建、`mediaSearchFrameIndex` 的帧向量收集与单点回退等），不是
   只读统计源，不在本阶段范围；召回门禁
   `scripts/verify-vector-generation-recall.cjs` 的 F32 对照扫 JSONL
   是刻意保留的门禁基线，未动。
2. `electron/vectorMaintenanceService.ts`：新增
   `readCompositeEmbeddingShardStats`（导出、无 electron 依赖）——从
   `readCurrentAuthoritativeManifest` 取基座条目、经
   `readEmbeddingIncrementSnapshot`（与读取端同一复合校验）取已提交
   增量，统计改读基座 `paths` 索引与 `delta.paths.jsonl`：
   - 记录数 = `sourceRecordCount + δ`（与新鲜度指纹同一近似：会被
     重建跳过的追加行只推进锚点不计 δ）；
   - 唯一图片数 = 基座路径索引 ∪ 已提交增量段路径索引的去重 path
     数，未提交增量尾部不计；
   - 运行时回退：无有效 generation 返回 null，`getVectorMaintenanceStats`
     回退到原 JSONL 逐行扫描（与"任何失配退化为现状"的失败语义一致）；
     增量失效而 generation 有效时退化为仅基座口径。
   `clipCache*`（派生缓存自省）、失败日志统计、shard 文件清单等其余
   统计项不变，IPC 字段语义不变。
3. 专项测试 `tests/vector-maintenance-composite-stats.test.cjs`（3 例，
   已接入 `test:vector-pipeline`）：合成 generation + δ + JSONL 三源，
   复合统计与 JSONL 逐行扫描基线逐字段一致（含重复 imageId 追加与未
   提交增量尾部不计）；增量目录删除后退化为仅基座口径；无 generation
   返回 null（回退触发）。

验证：

- `npm.cmd run test:vector-pipeline`：102/102 通过（99 既有 + 3 新增），
  迁移/增量迁移/GC/召回/帧索引/增量日志全部既有用例无回归。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`
  全绿；摸了维护 UI 统计服务，加跑 `npm.cmd run test:media-search` 与
  `npm.cmd run test:asset-library` 全绿。完整 `npm test` not-run（会话
  时长不足，相关链路已由上述套件覆盖）。

边界：① 统计的记录数采用 `sourceRecordCount + δ` 复合口径，与崩溃窗口
内 JSONL 实际行数可有尾差（增量未提交的尾部不计），与新鲜度指纹口径
一致，属设计约定；② JSONL 地位本阶段不变——剩余角色收敛为"迁移导入
源 + 召回门禁对照源 + 追加写目标"，纳入清理预览属阶段 4 评估事项
（设计文档非目标一节约束），本阶段不动；③ `getVectorMaintenanceStats`
整体入口依赖 electron `app.getPath`，专项测试覆盖其抽取出的
electron-free 复合统计函数与回退分支，不直接驱动 IPC 层。

## 第一百一十九批：权威向量 manifest 导入尾部哈希

2026-08-07 由 Codex（GPT-5 系列，精确模型版本未公开）实施，延续 D3
阶段 2 留下的基座 manifest imports 可选 `tailSha256` 项。本批只增强新迁移
generation 的源完整性锚点和读取校验，不修改 manifest version、不删除或改写
用户 JSONL、不启动真实库迁移；旧 generation 无该字段时继续按既有
size + mtime 口径读取。

1. `electron/authoritativeVectorStore.ts`：新增 64 KiB 尾部窗口哈希函数和
   `AuthoritativeVectorStoreImport.tailSha256` 可选字段；manifest 解析拒绝非法
   哈希格式；`openAuthoritativeVectorStore(..., expectedSourcePaths)` 在路径、
   大小和 mtime 对齐后，对新 manifest 进一步复核锚定 size 处的尾部 SHA-256。
   空文件使用标准空输入 SHA-256；读取长度固定为 O(64 KiB)，不全量重哈希。
2. `electron/vectorStoreMigrationService.ts`：新 generation 写 manifest 前为每个
   JSONL 导入源生成尾部哈希，并在派生向量文件复制完成后、提交 manifest 前
   再次复核 size、mtime 与尾部哈希；期间发生追加或尾部变化时迁移失败关闭，
   staging 不会被 `CURRENT` 引用。错误信息不携带用户路径。
3. `tests/vector-store-migration.test.cjs`：新增三类断言——新 manifest 写出合法
   64 位哈希；同 size、同 mtime 但尾部内容变化时 generation 失效；删除
   `tailSha256` 并重签 manifest 后仍可读取，证明 version 1 向后兼容。

验证：`tests/vector-store-migration.test.cjs` 3/3、`npm.cmd run
test:vector-pipeline` 102/102、`npm.cmd run typecheck`、`npm.cmd run lint`、
`npm.cmd run format:check`、`npm.cmd run build:renderer` 全绿；`npm.cmd run
git:validate-commit -- perf/vector-manifest-tail-hash --full` 退出码 0，完整
`npm test`、Node ABI Native 重建、Native 65/65 与生产构建全部通过。真实库
迁移 not-run：本批没有触碰真实数据，真实数据验证仍留维护窗口执行。

边界：① 尾部窗口只覆盖锚定 size 前最后 64 KiB，同 size、同 mtime 且仅改写
更早位置的非尾部内容仍无法发现，不声称替代全文件哈希；② 已存在的旧
generation 不会被原地改写或强制重建，只有后续正常迁移产生的新 generation
携带锚点；③ JSONL 退役阶段 4 的维护周期、真实崩溃恢复和召回门禁前提不变。

## 第一百二十批：增量迁移复用复合快照

2026-08-07 由 Codex（GPT-5 系列，精确模型版本未公开）实施，关闭第一百一十七批
边界④：`extendEmbeddingF16Cache` 在已提交增量存在时不再从旧 generation 的
imports 偏移重新解析整段 JSONL 追加历史，而是复用“基座 generation + delta”
作为迁移输入，只解析 delta 锚点之后尚未进入提交点的 JSONL 领先尾部。不修改
IPC、F16 编码、latest-revision-wins 语义或真实用户数据。

1. `electron/embeddingF16Cache.ts`：增量迁移读取
   `readEmbeddingIncrementSnapshot`；基座行仍从 generation F16 读取，已提交
   delta 行直接从 `delta.f16` 按行复制，路径从已提交的
   `delta.paths.jsonl` 读取，只有锚点之后的 JSONL 才进入解析和编码流程。
2. 追加证明加强：源文件大于 delta 锚点时，除换行边界外复核锚定 size 处最后
   64 KiB 的 `tailSha256`，防止把前缀尾部改写误判为纯追加；迁移结束仍闭环复核
   最终 size 与 mtime。增量失效、缺行、短 F16 或源变化均返回 null，沿用全量
   构建回退，不产生半成品 generation。
3. 去重顺序覆盖基座、delta 和 JSONL 领先尾部三层：旧行被后续 delta 覆盖、
   delta 内重复以及再被领先尾部覆盖时，最终路径顺序和 F16 内容继续与完整
   JSONL 全量重建逐字节一致。
4. `tests/embedding-composite-snapshot.test.cjs` 新增专项用例：合成 2 条基座、
   3 条已提交 delta 和 2 条 JSONL 领先尾部，监测源流只从 delta 锚点偏移打开，
   并与全量重建逐字节比较向量和路径索引。

验证：新增用例所在文件 6/6；`npm.cmd run test:vector-pipeline` 103/103；
`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`、
`npm.cmd run build:renderer` 全绿。真实库迁移 not-run：本批仅使用临时夹具，
真实小批量追加、召回门禁和维护页复核仍留维护窗口执行。

边界：① delta F16 行按需复制，路径索引仍需线性读取以维持去重与稳定顺序；
② JSONL 完全追平 delta 时源文件不再扫描，存在领先尾部时只读该尾部；③ ANN
仍在每次追加提交后按指纹重建一次，ANN 增量化继续作为后续专项优化。

## 第一百二十一批：ANN 同代增量签名扩展

2026-08-07 由 Codex（GPT-5 系列，精确模型版本未公开）实施，关闭第一百二十批
边界③：同一 generation 的复合快照追加已提交 delta 后，ANN 不再重算基座和
既有 delta 的 SimHash 签名，只复制已提交派生索引并计算新增行。ANN 投影、候选
收集、精确 F16 重排、文件命名和对外搜索结果不变；未触碰真实用户向量库。

1. `electron/vectorAnnWorker.ts`：派生 meta 新增基座身份、基座行数、基座末尾
   64 KiB SHA-256、已签名 delta 行数与 delta 提交前缀末尾 SHA-256。源指纹失配
   后仅当模型、类型、维度、generation/基座路径、基座尾锚、delta 行数单调性和
   旧 delta 尾锚全部吻合时，才扩展旧签名；旧 meta 缺字段、签名尺寸异常、前缀
   改写、参数变化或 generation 变化均回退全量重建。meta 仍作为签名文件的原子
   提交标记，旧 version 1 索引保持可读并在首次需要重建时自然升级。
2. worker/host 结果新增 `buildMode: none | incremental | full`，保留原有 `built`
   布尔值，便于诊断和回归明确区分命中、增量扩展与全量重建。
3. `tests/vector-ann-worker.test.cjs` 新增复合快照专项覆盖：同代 delta 扩展走
   incremental、旧签名前缀原样保留、结果与删除派生索引后的全量重建逐字节
   一致；重复 path 追加保持可处理；delta 已提交前缀改写和 generation 切换均
   走 full。`test:vector-ann` 先构建 worker bundle 再运行索引和 worker 集成测试，
   并接入完整 `npm test`，避免此前 bundle 缺失时测试静默跳过。

专项验证：`npm.cmd run test:vector-ann` 8/8、`npm.cmd run typecheck`、
`npm.cmd run lint` 全绿。完整门禁结果在本批提交验证后补记。

边界：① 每次快照变化仍需载入完整 F16 向量以供精确重排，本批只消除旧行签名
重算；② 尾锚与权威 imports 相同，只覆盖锚定位置前最后 64 KiB，不替代全文件
哈希，正确性同时依赖 generation/增量文件的只追加协议；③ delta path 索引仍
完整读取，因为搜索返回路径需要当前行映射，签名本身只依赖向量内容。

## 第一百二十二批：价值排序专项 TODO 自动选择器

2026-08-07 由 Codex（GPT-5 系列，精确模型版本未公开）实施。正式 32 项发布
计划继续由 `todo:next` 管理；本批为计划外性能、可靠性和维护性专项新增独立的
机器可读价值队列，不改变正式任务状态，也不授权任何真实数据或发布操作。

1. 新增 `docs/current/2026-08-07-value-ranked-optimization-todo.md`：按 1–100
   Value 降序记录 8 项专项，明确 `auto`、`approval`、`observation`、`triggered`
   四类授权模式、依赖、外部阻塞、建议分支、状态和验收命令。
2. 新增 `scripts/next-value-optimization-task.cjs` 与 `todo:value-next` /
   `todo:value-check`：校验排名、ID、分数、状态、依赖引用和依赖环；只选择
   Mode=`auto`、无外部阻塞且依赖已验证的任务。`implemented` / `in_progress`
   优先恢复，避免跳过半成品领取低价值新任务。
3. 新增 5 个专项测试并接入 `test:optimization-todo`，覆盖安全选择、授权阻塞
   解释、依赖阻塞、进行中任务恢复优先、分数漂移与依赖环拒绝，以及仓库真实
   TODO 的机器可读性。用户随后新增 DINO/CLIP CUDA 方案，作为 Value 98 的
   `VAL-009` 插入队列，不覆盖价值 100 的真实维护验证，但成为最高价值安全
   自动任务。

验证：`npm.cmd run todo:value-check` 通过（8 项）；`npm.cmd run
test:optimization-todo` 8/8；`npm.cmd run lint` 通过。首次自动选择结果为
`VAL-009`（Value 98，DINO/CLIP CUDA 加速方案与兼容 PoC）。

边界：选择器只输出确定性任务快照，不直接改文件、删除数据、建发布签名或替代
人工审批；真实维护、清理、许可证和人工标注任务即使价值更高也保持阻塞。实际
实现仍遵守独立 worktree/分支、专项测试、完整验证和快进合入纪律。
