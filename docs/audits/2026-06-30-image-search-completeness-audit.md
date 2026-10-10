# Image Search 完整度审计 - 2026-06-30

## 总体结论

当前项目健康度：`78 / 100`。

当前状态属于“可用 Beta / 准发布候选”。Image Search 主流程、模型构建、语义搜索、以图搜图、分片存储和打包链路都已经跑通；但还不是长期稳定正式版。主要短板集中在运行时数据维护、端到端测试、中文语义模型能力、历史类型债和 UI 结构拆分。

## 全部审计

已完成度较高：

- Image Search 主流程可用：扫描、以图搜图、Semantic 搜索、CLIP 构建、DINO 构建、结果展示。
- 大文件风险已明显下降：旧单体 `image_embeddings.jsonl` 已拆分为 DINO/CLIP 分片。
- 打包链路可用：`npm run build` 通过，`release` 已精简为只保留安装包。
- 核心验证通过：`typecheck`、`test:guards`、`test:vector-pipeline`。

主要扣分点：

- 缺少产品内“向量库维护”能力。
- 缺少端到端 UI 测试。
- Semantic 中文准确度受英文 CLIP 模型限制。
- lint warning 较多，历史类型债仍在。
- 运行时数据量大，长期需要更正式的数据库/向量索引方案。

## 结构审计

优点：

- 主进程、renderer、shared 类型边界基本清楚。
- Image Search 已形成独立服务层：`embeddingService`、`semanticSearchService`、`vectorIndexService`、`vectorDatabaseService`。
- DINO / CLIP 子进程隔离方向正确，降低 native 崩溃影响。
- IPC 类型集中在 shared contract，方向正确。

问题：

- `ImageSearchPanel.tsx` 仍偏大，UI 状态、构建控制、搜索控制、结果展示混在一个组件里。
- `vectorDatabaseService` 仍是文件存储与通用 JSONL store 混合，职责偏重。
- `semanticSearchService` 同时承担文本 embedding、cache 管理、fallback、搜索排序，后续会变复杂。
- 历史文档编码混杂，文档体系需要收敛。

建议：

- 拆分 `ImageSearchPanel` 为 `SearchControls`、`BuildControls`、`ResultGrid`、`VectorStatusBar`、`MaintenancePanel`。
- 新增 `vectorMaintenanceService`。
- 把 CLIP cache 独立为 `clipCacheService`。

## 逻辑审计

优点：

- Build Embeddings 已避免旧的全量 `getAll()` 高风险路径。
- 新 embedding 写入按模型分片，旧数据兼容读取。
- Build Index 对大文件走 streaming，不强制内存索引。
- Search TopK streaming 已优化，不再每条结果都排序。
- DINO GPU 历史不稳定，当前保守降级是正确取舍。

问题：

- `embedding_jobs.jsonl` 仍有较大体积，job 生命周期缺少清理策略。
- `embedding_failures.jsonl` 仍有较大体积，失败记录缺少保留上限。
- Semantic CLIP cache 缺少显式“重建 cache”按钮。
- UI 对 DINO/CLIP 覆盖率提示不够。
- 分片 compaction 目前是脚本级，不是产品内逻辑。

建议：

- 显示当前扫描图片数、DINO embedding 数、CLIP embedding 数、缺失数量。
- 增加“只补缺失 embedding”模式。
- 增加“清理完成 jobs / 清理失败日志 / 重建 CLIP cache”按钮。
- 搜索结果区显示当前使用的是 DINO、CLIP、hash 还是 fallback。

## 安全审计

优点：

- IPC 已增加模型名白名单。
- scanPaths 已做目录存在性、类型、去重、数量限制。
- searchLayered 查询图片路径已校验是否真实文件。
- DINO/CLIP 推理放入子进程，降低 native 崩溃影响。
- 大文件写入和读取逐步改为 streaming，降低 OOM 风险。

风险：

- 文件打开、打开文件夹、复制路径等 shell 操作仍需持续保证路径校验。
- 大量本地路径会经过 renderer 展示，未来需要避免 HTML 注入。
- 模型下载、模型路径、cache 路径需要继续限制在软件目录或 userData 目录内。
- IPC handler 尚未全部统一 validator。

建议：

- IPC handler 全部套统一 validator。
- 所有 shell.openPath / showItemInFolder 前统一走 `safeShellPath + exists + file/dir type`。
- 增加 IPC fuzz 测试。
- 禁止 renderer 传任意模型路径，只允许传模型 ID。

## 复用功能审计

可复用性较好的部分：

- `vectorDatabaseService` 的路径和分片逻辑可复用。
- `embeddingService` 的进度事件、诊断日志、子进程池可以继续扩展。
- `semanticSearchService` 的 CLIP cache 可以作为其他文本搜图入口复用。
- `vectorIndexService` 的 streaming search 可复用到 DINO/CLIP 两类向量。

复用性较差的部分：

- UI 状态大量集中在 `ImageSearchPanel`，复用成本高。
- Build DINO / Build CLIP 逻辑虽然已统一一部分，但 UI 层仍有较多分支。
- 维护动作目前是脚本，不是服务 API。
- 文档和调试脚本没有统一入口。

建议：

- 抽出 `useImageSearchState`、`useEmbeddingBuild`、`useSemanticSearch` hooks。
- 所有 Build 按钮统一调用 `startEmbeddingBuild({ modelName, backend, scanPaths, mode })`。
- 新增 `vectorMaintenanceService`，UI 和脚本共用同一套能力。
- 把 compaction 脚本改为可被 IPC 调用的后台任务。

## 扩展性审计

当前扩展性：`70 / 100`。

适合扩展：

- 中文/多语 CLIP 模型。
- 向量库维护面板。
- 更高性能的二进制向量索引。
- 搜索结果过滤、标签、收藏、批量操作。
- 模型覆盖率和增量构建。

扩展瓶颈：

- JSONL 分片不是最终形态。
- 5GB+ 向量数据继续增长后，纯 JSONL streaming 会变慢。
- 当前没有真正 ANN 索引，`Build Index` 更像 manifest/streaming 开关。
- UI 组件过大，会阻碍继续加功能。
- 缺少端到端自动测试，扩展时容易回归。

## 推荐优先级

P0：

- 做向量库维护能力。
- 清理 `embedding_jobs.jsonl`、`embedding_failures.jsonl`、诊断日志的产品内入口。
- 显示 DINO/CLIP 覆盖率。

P1：

- 拆分 `ImageSearchPanel`。
- 给 Build / Search / Cache 增加端到端测试。
- 增加“只补缺失 embedding”模式。

P2：

- 引入中文/多语 CLIP。
- 引入正式 ANN 索引。
- 清理 lint warning 和历史 any 类型。

## 当前落地进度

已完成：

- 新增 `electron/vectorMaintenanceService.ts`，提供向量库维护后端能力。
- 新增向量库统计接口：统计 `vector-db` 总体积、embedding 分片、job/failure/diagnostic 文件、CLIP cache 文件。
- 新增维护接口：清理诊断备份、清空失败日志、压缩 job 队列。
- `shared/ipc-contract.ts`、`electron/preload.ts`、`electron/main.ts` 已接入对应 IPC。
- `ImageSearchPanel` 已接入 `Vector DB` 维护条，可查看向量库总体积、embedding 分片体积、job/failure/diagnostic 体积、CLIP cache 体积。
- `Vector DB` 维护条已显示 DINO/CLIP 去重图片数和相对当前 hash 索引总量的真实覆盖率。
- DINO/CLIP records 数仍保留在 tooltip 中，用于判断是否存在重复写入。
- 大 JSONL 覆盖率统计已改为一次异步流式扫描，同时产出 records 和 unique，避免点击维护统计时一次性读取/解析 5GB+ 文件导致主进程卡顿。
- 维护统计加载时已显示 `Loading stats...`。
- Build 区已明确标注为 `Build Missing`，当前构建流程会跳过已有 embedding，只补缺失图片。
- `Vector DB` 维护条已显示 embedding 失败总条数、按模型分布、Top 失败原因和最近失败原因。
- 失败原因已做归类：OOM、Timeout、File missing、Permission denied、Image decode failed、GPU inference failed、Model execution failed 等。
- 新增失败重试候选接口：从 `embedding_failures.jsonl` 中提取最近失败、去重且文件仍存在的图片路径。
- `Vector DB` 维护条已新增 `Retry DINO`、`Retry CLIP`，重试会复用 `Build Missing`，已有 embedding 自动跳过。
- `Vector DB` 维护条已新增 `Retry Top DINO`、`Retry Top CLIP`，只重试当前最主要的可重试失败原因。
- `Retry Top` 会跳过 `File missing`、`Permission denied`、`Image decode failed` 等通常重试无效的原因。
- `ImageSearchPanel` 已提供 `Clear Diag`、`Clear Fail`、`Compact Jobs` 产品内维护入口。
- 文件大小显示已优化为自动使用 KB/MB/GB。
- `typecheck` 通过。
- `test:guards` 通过。
- `test:vector-pipeline` 通过。
- `lint` 无错误，仅保留历史 warning。
- `npm run build` 通过。
- 打包后启动烟测通过。
- `release` 已清理为只保留 `FloatingClock Setup 1.0.0.exe`。

待继续：

- 失败统计目前来自 `embedding_failures.jsonl`，后续可增加点击复制失败路径和失败列表弹窗。
- 增加“只补缺失 embedding”的产品入口。
- 继续拆分 `ImageSearchPanel`，降低 UI 状态耦合。
- 为 Build / Search / Cache 增加端到端回归测试。

## 2026-07-01 自动优化进度

本轮已完成：

- 新增 `src/components/VectorMaintenanceBar.tsx`，将 Vector DB 维护栏从 `ImageSearchPanel.tsx` 中抽离。
- `VectorMaintenanceBar` 独立承载维护统计、失败统计、清理诊断、清理失败、压缩 jobs、Retry DINO/CLIP、Retry Top DINO/CLIP。
- `ImageSearchPanel.tsx` 已删除旧维护栏状态和旧维护动作函数，改为只传入 `indexedCount`、`gpuJobs`、`buildDisabled`、`showToast`。
- 清理了抽离后残留的旧刷新 effect 和未使用百分比工具函数。
- 本轮结构健康度提升点：维护 UI 已具备独立复用和后续单测条件，`ImageSearchPanel` 职责继续收窄。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，仍保留历史 warning。

当前估算：

- Image Search 完整度：`90 / 100`。
- 项目健康度：`82 / 100`。
- 扩展性：`76 / 100`。

下一步建议：

- 继续拆分 `ImageSearchPanel` 的 Build 控制区或 Search 控制区。
- 为 `VectorMaintenanceBar` 增加组件级测试或端到端冒烟覆盖。
- 继续清理 `ImageSearchPanel` 内的历史 `any` 和未使用参数 warning。

## 2026-07-01 继续优化进度 2

本轮已完成：

- 新增 `src/components/EmbeddingBuildControls.tsx`，将 DINO/CLIP 下载、Build Missing、CLIP GPU jobs、Build Index、embedding 进度条从主面板中抽出。
- `ImageSearchPanel.tsx` 删除了旧的 Build 启动函数、embedding 百分比计算和无用 `STATUS_COLORS`。
- 由于首次大范围替换命中过宽，已即时恢复顶部扫描/查询入口，当前保留 Start Scan、Stop、Add New、Folders、Drive、手动路径、Query、Paste、Refresh、Semantic、阈值、TopK、排序、搜索模式和视图模式。
- `ImageSearchPanel` 的职责继续收窄：模型构建控制已经独立，后续可以继续抽出 SearchControls。

本轮验证：

- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，剩余 warning 属于历史 `any`/未使用项。
- `npm run build` 通过。
- 打包后 exe 启动冒烟通过。
- `release` 已清理为只保留 `FloatingClock Setup 1.0.0.exe`。

当前风险记录：

- 本轮恢复的顶部控制区是保守实现，功能入口完整，但样式与之前可能有轻微差异。
- 下一步继续拆分时必须避免使用宽正则替换 JSX，优先使用小范围补丁或先抽组件再逐段替换。

## 2026-07-01 继续优化进度 3

本轮已完成：

- 新增 `src/components/ImageSearchStatusBar.tsx`，将 Image Search 状态栏从 `ImageSearchPanel.tsx` 中抽离。
- 状态栏独立承载：扫描状态、索引模式、总数、新增/已存在/未变化/更新/不可读数量、耗时、错误/警告、当前扫描路径、scanner backend 统计。
- `ImageSearchPanel.tsx` 中对应状态区已替换为 `<ImageSearchStatusBar status={status} isScanning={isScanning} />`。
- 移除了主面板中一个确定无用的历史常量 `STATUS_COLORS`。

本轮验证：

- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，warning 从 210 降到 209。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 下一步优先抽离 `SearchProgressBar` 或 `SearchControls`，继续降低 `ImageSearchPanel` 的 JSX 体积。

## 2026-07-01 继续优化进度 4

本轮已完成：

- 新增 `src/components/SearchProgressBar.tsx`，将语义搜索和以图搜图的进度条从 `ImageSearchPanel.tsx` 中抽离。
- `SearchProgressBar` 统一处理 semantic progress 与 layered image-search progress，并复用同一套百分比、消息和进度条渲染。
- `ImageSearchPanel.tsx` 中原两段搜索进度 JSX 已替换为 `<SearchProgressBar />`。
- 本轮只移动展示层，不改搜索请求、进度事件订阅、结果排序和结果渲染逻辑。

本轮验证：

- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，warning 保持 209，未新增 warning。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 下一步建议抽离 `ImageSearchResultGrid`，它能显著降低主面板 JSX 体积，但需要更谨慎处理结果 action props。

## 2026-07-01 继续优化进度 5

本轮已完成：

- 新增 `src/components/ImageSearchResultGrid.tsx`，将结果滚动区、搜索指标摘要、缩略图卡片、列表/大图模式、Open/Folder/Copy 按钮从 `ImageSearchPanel.tsx` 中抽离。
- 新组件导出 `ImageSearchDisplayResult` 和 `ImageSearchMetrics`，主面板继续负责搜索、排序和状态管理，结果组件只负责展示和动作回调。
- `fmtBytes` 已从主面板移入结果组件。
- `ImageSearchPanel.tsx` 中 `sortedResults` 已从 `any[]` 收紧为 `ImageSearchDisplayResult[]`。

本轮验证：

- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，warning 从 209 降到 205。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 下一步建议抽离 `ImageSearchToolbar/SearchControls` 或 `ImageSearchIndexFooter`，继续压缩主面板。

## 2026-07-01 继续优化进度 6

本轮已完成：

- 新增 `src/components/ImageSearchIndexFooter.tsx`，将可见的索引管理底栏从 `ImageSearchPanel.tsx` 中抽离。
- `ImageSearchIndexFooter` 独立展示 index mode、segment 数、record 数、path map 健康状态、autoload 状态、USN 权限提示，以及 Reload/Clear/IdxDir 操作按钮。
- 主面板保留 Reload/Clear/OpenIndexDir 的业务回调，新组件只负责展示与触发回调。
- 清理了 Recent manifest 和 Index footer 中一批旧 `as any` 用法。

本轮验证：

- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，warning 从 205 降到 195。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 已抽离 `ImageSearchIndexFooter`。
- 下一步建议抽离 `RecentManifestBar` 或 `ImageSearchToolbar/SearchControls`。

## 2026-07-01 继续优化进度 7

本轮已完成：

- 新增 `src/components/RecentManifestBar.tsx`，将最近索引 manifest 列表从 `ImageSearchPanel.tsx` 中抽离。
- `RecentManifestBar` 只负责展示最近 manifest 和触发加载回调；真实加载、toast、状态刷新仍保留在主面板，职责边界更清晰。
- `ImageSearchPanel.tsx` 新增 `handleLoadRecentManifest`，统一复用 `imageSearchBridge.loadManifest`、`addRecentManifest`、`fetchStatus` 流程。
- 主面板底部结构现在由结果区、最近 manifest 条、索引 footer 三个组件组成，后续继续拆 `SearchControls` 时风险更低。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 保持 195。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 已抽离 `ImageSearchIndexFooter`。
- 已抽离 `RecentManifestBar`。
- 下一步建议抽离 `ImageSearchToolbar` / `ImageSearchSearchControls`，把顶部扫描路径、Query/Paste/Refresh、Semantic 输入、TopK/Sort/Search/View 控制继续从主面板中移出。

## 2026-07-01 继续优化进度 8

本轮已完成：

- 新增 `src/components/ImageSearchControls.tsx`，将顶部扫描路径、Query/Paste/Refresh、Semantic 输入、阈值、TopK、排序、搜索模式、视图模式和 Scores 开关从 `ImageSearchPanel.tsx` 中抽离。
- `ImageSearchControls` 只承载 UI 展示和事件转发；扫描、路径校验、盘符枚举、以图搜图、剪贴板搜索、语义搜索等业务逻辑仍由 `ImageSearchPanel` 控制，避免改变现有行为。
- `ImageSearchPanel.tsx` 新增 `handleToggleDrivePicker`，替代原先内联的盘符枚举逻辑。
- TopK 选项迁移为 `IMAGE_SEARCH_TOPK_OPTIONS`，排序选项随控制组件封装，进一步减少主面板常量和 JSX 体积。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 保持 195。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 已抽离 `ImageSearchIndexFooter`。
- 已抽离 `RecentManifestBar`。
- 已抽离 `ImageSearchControls`。
- 下一步建议转向清理 `ImageSearchPanel` 内剩余历史 `any`、隐藏旧索引路径 UI，或继续抽离 `ConfirmWholeDriveBanner` / `ToastBanner` 这类小组件。

## 2026-07-01 继续优化进度 9

本轮已完成：

- 新增 `src/components/ImageSearchBanners.tsx`，集中承载 Image Search 的顶部提示条组件。
- 抽离 `ImageSearchToastBanner`，主面板只保留 toast 状态和 `showToast` 行为。
- 抽离 `ConfirmWholeDriveBanner`，主面板只保留整盘扫描确认状态和确认/取消动作。
- 新增 `ImageSearchToastState` 类型，替代主面板内联 toast 类型，减少重复结构定义。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 保持 195。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 已抽离 `ImageSearchIndexFooter`。
- 已抽离 `RecentManifestBar`。
- 已抽离 `ImageSearchControls`。
- 已抽离 `ImageSearchBanners`。
- 下一步建议清理 `ImageSearchPanel` 中隐藏的旧 Index paths UI，或开始逐项消除主面板内剩余历史 `any` warning。

## 2026-07-01 继续优化进度 10

本轮已完成：

- 删除 `ImageSearchPanel.tsx` 中 `display: none` 的旧 Index paths UI，移除已经不可见且被新顶部控制区替代的历史 JSX。
- 新增 `src/components/ImageHashSmokeTest.tsx`，将底部哈希烟测入口从主面板中抽离。
- `ImageHashSmokeTest` 保留原有 Test Image、hashing 状态、hash 结果展示和错误展示，不改变调试能力。
- 修正哈希尺寸显示中的乱码乘号，改为 ASCII `x`，避免编码显示异常。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 保持 195。

当前结构拆分进度：

- 已抽离 `VectorMaintenanceBar`。
- 已抽离 `EmbeddingBuildControls`。
- 已抽离 `ImageSearchStatusBar`。
- 已抽离 `SearchProgressBar`。
- 已抽离 `ImageSearchResultGrid`。
- 已抽离 `ImageSearchIndexFooter`。
- 已抽离 `RecentManifestBar`。
- 已抽离 `ImageSearchControls`。
- 已抽离 `ImageSearchBanners`。
- 已抽离 `ImageHashSmokeTest`。
- 已删除隐藏旧 Index paths 死代码。
- 下一步建议开始清理 `ImageSearchPanel` 内剩余历史 `any` warning，优先处理搜索 API 返回值和 layered result 映射处。

## 2026-07-01 继续优化进度 11

本轮已完成：

- 清理 `ImageSearchPanel.tsx` 中剩余的历史 `any` warning。
- 将 `(window as any).electronAPI?.vector` 统一改为已声明类型的 `window.electronAPI?.vector`。
- 移除 `startScan` 参数、hash 搜索 `searchMode`、autoload 错误读取等位置的无必要 `as any`。
- 将 autoload `.catch((e) => ...)` 改为 `.catch(() => ...)`，消除未使用异常参数 warning。
- `ImageSearchPanel.tsx` 当前已无 lint warning，主面板类型边界更清晰。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 195 降到 183。

当前结构与类型进度：

- Image Search 主面板已抽离 10 个组件。
- `ImageSearchPanel.tsx` 已清除本文件 lint warning。
- 剩余 warning 主要集中在 electron 后端服务、preload、file manager、remote terminal、App/Settings 等历史区域。
- 下一步建议继续清理 Image Search 相关后端文件，例如 `electron/imageSearchService.ts`、`electron/semanticSearchService.ts`、`electron/embeddingService.ts` 中的 `any`。

## 2026-07-01 继续优化进度 12

本轮已完成：

- 清理 `electron/imageSearchService.ts` 中全部历史 `any` warning。
- 补全 `NativeScanProgress` 类型：`lastWarning`、`skippedCount`、`warningCount`、`durationMs` 等扫描统计字段改为类型化访问。
- 补全 `NativeAddon` 类型：`pauseScan`、`resumeScan`、`isScanPaused`、异步 manifest/compact 返回值的 `error` 字段。
- 移除 native addon pause/resume/isPaused、manifest 错误日志、search fallback 字段等位置的 `as any`。
- `electron/imageSearchService.ts` 当前已无 lint warning，扫描/搜索主服务的 native 边界更清晰。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 183 降到 155。

当前类型进度：

- `ImageSearchPanel.tsx` 已清零 warning。
- `electron/imageSearchService.ts` 已清零 warning。
- 剩余 Image Search 相关重点 warning 转向 `electron/semanticSearchService.ts`、`electron/embeddingService.ts`、`electron/clipEmbeddingChild.ts`、`electron/dinoEmbeddingChild.ts`。

## 2026-07-01 继续优化进度 13

本轮已完成：

- 清理 `electron/semanticSearchService.ts` 中全部历史 `any` warning。
- 新增最小 Transformers.js 运行时类型：`ClipTokenizer`、`ClipTextModel`、`ClipTextOutput`、`ClipTransformersModule`。
- 新增 `ClipEmbeddingJsonlEntry`，让 CLIP embedding JSONL 记录解析从 `any` 改为明确结构。
- 将 CLIP 文本模型和 tokenizer promise 从 `Promise<any>` 收紧为具体可调用接口。
- 将语义搜索 CLIP fallback 异常处理从 `catch (err: any)` 改为 `unknown` + `errorMessage()`。
- `electron/semanticSearchService.ts` 当前已无 lint warning，文本语义搜索、CLIP cache 和 fallback 路径的类型边界更清晰。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 155 降到 147。

当前类型进度：

- `ImageSearchPanel.tsx` 已清零 warning。
- `electron/imageSearchService.ts` 已清零 warning。
- `electron/semanticSearchService.ts` 已清零 warning。
- 下一步建议清理 `electron/embeddingService.ts`、`electron/clipEmbeddingChild.ts`、`electron/dinoEmbeddingChild.ts`，继续覆盖 embedding 构建链路。

## 2026-07-01 继续优化进度 14

本轮已完成：

- 清理 `electron/embeddingService.ts` 中全部历史 `any` warning。
- 新增 `WorkerChildMessage` 类型，明确 child process JSON 消息结构。
- 新增 `parseWorkerChildMessage()`，统一处理 CLIP/DINO worker stdout JSON 解析。
- CLIP/DINO worker 返回的 `vector` 现在经过 `Array.isArray` 判断后再 `map(Number)`，避免直接信任未类型化 JSON。
- DINO stdin 写入异常从 `catch (err: any)` 改为 `unknown` + `instanceof Error`。
- `electron/embeddingService.ts` 当前已无 lint warning，embedding 构建调度层的类型边界更清晰。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 147 降到 144。

当前类型进度：

- `ImageSearchPanel.tsx` 已清零 warning。
- `electron/imageSearchService.ts` 已清零 warning。
- `electron/semanticSearchService.ts` 已清零 warning。
- `electron/embeddingService.ts` 已清零 warning。
- 下一步建议清理 `electron/clipEmbeddingChild.ts` 和 `electron/dinoEmbeddingChild.ts`，把 embedding worker 子进程自身也收敛掉。

## 2026-07-01 继续优化进度 15

本轮已完成：

- 清理 `electron/clipEmbeddingChild.ts` 中全部历史 `any` warning。
- 清理 `electron/dinoEmbeddingChild.ts` 中全部历史 `any` warning。
- 为 CLIP worker 新增最小 Transformers.js 运行时类型：`ClipTokenizer`、`ClipProcessor`、`ClipModel`、`ClipRawImage`、`ClipTransformersModule`、`ClipRuntime`。
- 为 DINO worker 新增最小 Transformers.js 运行时类型：`DinoFeatureOutput`、`ImageFeatureExtractor`、`DinoTransformersModule`。
- 将 CLIP/DINO 子进程异常处理从 `catch (err: any)` 收紧为 `unknown` + `errorMessage()`，减少不受控异常对象传播。
- CLIP/DINO embedding 构建链路当前重点文件均已清零 lint warning：`ImageSearchPanel.tsx`、`imageSearchService.ts`、`semanticSearchService.ts`、`embeddingService.ts`、`clipEmbeddingChild.ts`、`dinoEmbeddingChild.ts`。

本轮验证：

- `npx prettier --write electron\clipEmbeddingChild.ts electron\dinoEmbeddingChild.ts` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 144 降到 132。

当前剩余优化重点：

- `electron/preload.ts`、`electron/main.ts`、`electron/fileManagerIpc.ts`、`electron/remoteTerminalService.ts` 仍有较多历史 `any`。
- 前端 File Manager、Settings、App、Store 仍有少量未使用变量和历史 `any`。
- Image Search 核心链路本轮已基本完成结构拆分和类型边界收紧，后续可转向跨模块 IPC 类型统一、preload API 类型复用和 File Manager 缩略图链路治理。

## 2026-07-01 继续优化进度 16

本轮已完成：

- 清理 `electron/preload.ts` 中全部历史 `any` warning。
- 将 preload 事件监听回调统一改为 `IpcRendererEvent` + 明确 payload 类型，覆盖 work area、File Manager、Image Search、AppStorage、Remote Terminal、Duplicate Finder、Vector 进度事件。
- 在 `shared/ipc-contract.ts` 中新增 File Manager 持久化状态类型：`FileManagerPaneLayout`、`FileManagerViewMode`、`FileManagerGroupMode`、`FileManagerFavoriteEntry`。
- 将 `AppSettingsData` 里的 `fmLayout`、`fmPaneTabs`、`fmActiveTab`、`fmPaneSorts`、`fmFavorites`、`fmViewModes`、`fmGroupModes`、`fmGroupExpanded` 从 `any` 收紧为结构化类型。
- `electron/preload.ts` 与 `shared/ipc-contract.ts` 当前已清零 lint warning，跨进程暴露层和设置持久化字段的类型边界更清晰。

本轮验证：

- `npx prettier --write electron\preload.ts shared\ipc-contract.ts` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 132 降到 100。

当前剩余优化重点：

- `electron/main.ts`、`electron/fileManagerIpc.ts`、`electron/remoteTerminalService.ts` 是剩余后端 warning 主体。
- 前端侧可继续清理 `App.tsx` 的 work area/geometry 类型、File Manager 缩略图返回类型，以及 Settings 面板的 vector API 访问方式。

## 2026-07-02 继续优化进度 17

本轮已完成：

- 清理 `electron/fileManagerIpc.ts` 中全部历史 `any` warning。
- 文件管理 IPC 的复制、移动、删除、目录读取、跨盘移动 fallback 等异常分支统一从 `catch (e: any)` 收紧为 `unknown` + `errorMessage()`。
- 为文件管理 IPC 新增 `errorCode()`，专门处理 `EXDEV`、`ENOENT` 这类 Node 文件系统错误码，避免直接信任未知异常对象。
- 清理 `electron/modelService.ts` 中全部历史 `any` warning，模型下载和删除异常处理统一收紧。
- 清理 `electron/appStorageService.ts` 中全部历史 `any` warning，应用存储扫描的缓存删除和注册表读取错误处理统一收紧。
- 清理 `electron/rerankService.ts` 中全部历史 `any` warning，Hash/Vector/Rerank 降级原因统一使用安全错误消息。
- 清理 `electron/vectorDatabaseService.ts` 中全部历史 `any` warning，JSONL 泛型写入、Color/Shape feature upsert 均改为结构化类型。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `node --test tests\file-manager-watcher.test.cjs` 通过，8 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 100 降到 78。

当前剩余优化重点：

- 后端剩余 warning 主要集中在 `electron/main.ts` 和 `electron/remoteTerminalService.ts`。
- 前端剩余 warning 主要集中在 `src/App.tsx`、File Manager 组件、Settings、Store、Remote Terminal 面板。
- Image Search、Vector、Embedding、Rerank、Model、File Manager IPC 的核心后端链路本轮已基本完成类型边界清理。

## 2026-07-02 继续优化进度 18

本轮已完成：

- 清理 `electron/remoteTerminalService.ts` 中全部历史 `any` warning。
- 新增远程终端 profile 类型守卫 `isRemoteTerminalProfile()`，配置文件读取不再直接信任 JSON 结构。
- 新增 `SensitiveRemoteTerminalProfile`，保存 profile 时继续明确删除 `password` / `passphrase`，同时不再使用 `as any`。
- 新增 keyboard-interactive SSH 事件的最小类型接口，替换 `(client as any).on(...)`。
- 远程终端 SSH 连接、测试连接、指标采集、私钥读取、write/resize 等异常分支统一收紧为 `unknown` + `errorMessage()`。
- 清理 `electron/main.ts` 中全部历史 `any` warning。
- `main.ts` 新增 `normalizeLayeredSearchMode()` 与 `normalizeHashSearchMode()`，替换 Layered Search / Hash delegate 中的非类型化 searchMode。
- `vectorSettings` 从 `any` 收紧为 `VectorSettings | null`，保存时使用 `DEFAULT_VECTOR_SETTINGS` 兜底，避免写入缺失必填字段的设置对象。
- `appStorage:scan` 状态回调改为 `AppStorageScanStatus`，缩略图、剪贴板图片、AppStorage openPath 等异常处理统一收紧。

本轮验证：

- `npx prettier --write electron\remoteTerminalService.ts electron\main.ts` 通过。
- `npm run typecheck` 通过。
- `npm run test:guards` 通过，6 项通过。
- `node --test tests\remote-terminal.test.cjs tests\remote-stress.test.cjs` 通过，7 项通过。
- `npm run lint` 通过，无 error，历史 warning 从 78 降到 50。

当前状态：

- `electron/` 与 `shared/` 已无 lint warning。
- 剩余 50 个 warning 全部集中在前端 `src/`：`App.tsx`、File Manager、Settings、Store、Remote Terminal UI 等。
- 后续优化重点从后端 IPC/服务层转向前端组件类型、未使用变量和 UI 状态类型收敛。

## 2026-07-02 继续优化进度 19

本轮已完成：

- 前端 `src/` lint warning 已清零，项目当前 ESLint 为 0 error / 0 warning。
- 清理 `src/App.tsx` 的 work area、panel geometry、hotkey warning 事件分发类型，移除历史 `any`。
- 清理 `SettingsPanel` 的 Vector Settings 类型边界：`window.electronAPI.vector` 不再走 `window as any`，`backend` 写入限制为 `cpu | gpu`。
- 清理 File Manager 前端组件：`FileManagerPanel` 的 View/Group 回调改为 `ViewMode` / `GroupMode`，`FilePane` 和 `ThumbnailImage` 删除旧死代码和历史缩略图对象兜底。
- 清理 Remote Terminal 前端组件：`xterm` / `FitAddon` 实例改为真实类型，侧栏移除未使用 setter props，降低父子组件耦合。
- 清理 `useLinkedMove` 与 `useStore` 的动态状态写入：用显式 panel position/size 映射替代 `as any`。
- 修复一个结构性隐患：`duplicateFinder` 面板不能通过 `name + 'Size'` 推导尺寸，现统一走显式 `panelSizeForName()`，避免新开/自动排列时拿不到正确尺寸。
- 删除 `useStore` 内未调用的旧 `resolveCollisions()` / `screenClamp()` 死代码，保留当前实际使用的 `packPanels()` / `applyPositions()` 路径。

本轮验证：

- `npx prettier --write` 通过。
- `npm run typecheck` 通过。
- `npm run lint` 通过，无 error，无 warning，历史 warning 从 50 降到 0。
- `npm run test:guards` 通过，6 项通过。
- `npm run test:vector-pipeline` 通过，12 项通过。
- `node --test tests\remote-terminal.test.cjs tests\remote-stress.test.cjs` 通过，7 项通过。
- `npm run build` 通过，完成 renderer、electron main/preload、worker、native fast_scanner 和 NSIS 安装包构建。
- release 烟测通过，`release\win-unpacked\FloatingClock.exe` 可正常启动。
- release 已清理，只保留 `FloatingClock Setup 1.0.0.exe`。

当前状态：

- Image Search / Vector / Embedding / Model / File Manager / Remote Terminal 相关主链路已完成大范围结构拆分、IPC 类型收紧、异常边界收紧和前端 lint 清零。
- 下一步重点转向完整测试矩阵、打包烟测、release 产物清理，以及继续审查未被 lint 覆盖的重复结构和长期可维护性问题。
