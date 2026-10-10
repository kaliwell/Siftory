# FloatingClock 项目全量审计 - 2026-07-05

> 项目：FloatingClock Electron  
> 审计范围：整体架构、Image Search、Media Search、Vector/Embedding、File Manager、Remote Terminal、App Storage、Duplicate Finder、Native fast_scanner、IPC、安全、性能、测试、复用与扩展性。  
> 文档目的：按照 `docs` 目录现有审计文档格式，建立一份新的当前状态快照，便于后续继续优化、交接和回归验证。

## 总体结论

当前项目健康度：`84 / 100`。

当前状态属于“可用 Beta / 准发布候选”。核心功能已经能闭环运行，尤其是 Image Search 和 Media Search 已从原型推进到可实际使用阶段；Native fast_scanner、DINO/CLIP embedding、视频抽帧、以图搜视频、语义搜图/搜视频、远程终端、文件管理、应用空间分析和重复文件扫描均已形成可维护模块。

主要短板不再是“功能没做”，而是：

- 大文件 JSONL 数据层仍偏重，长期需要 SQLite/二进制索引/持久增量统计。
- `electron/main.ts` 和部分前端面板仍偏大，IPC 编排职责集中。
- Media Search 的真实召回、性能曲线和端到端 UI 回归还需要更系统的自动化测试。
- 中文语义能力受 CLIP 模型和 query normalize 限制，能用但不是专门中文检索模型水平。
- 文档历史编码混杂，部分旧文档在终端中出现乱码，需要后续统一为 UTF-8。

## 项目规模快照

当前源码与测试概况：

- TypeScript / TSX / CSS / CJS 统计：约 `131` 个文件，约 `37,385` 行。
- `rg --files src electron shared tests native`：约 `160` 个项目相关文件。
- 测试文件：`25` 个，覆盖 native、IPC guard、settings、file manager、app storage、duplicate finder、media search、remote terminal、remote transfer、vector pipeline。
- 构建链：`npm run typecheck`、`npm run build:renderer` 已在最近优化中多次通过。
- 打包配置：`electron-builder`，发布目录 `release`，当前策略是只保留 `FloatingClock Setup 1.0.0.exe`。

当前大文件和高复杂度热点：

- `electron/main.ts`：IPC 注册和跨模块编排集中，仍是最大结构风险。
- `src/components/MediaSearchPanel.tsx`：Media Search 主 UI 功能完整，但状态和渲染仍偏集中。
- `src/components/RemoteTerminalPanel.tsx`：远程终端 UI 复杂度较高。
- `electron/semanticSearchService.ts`：文本语义、fallback、候选、cache 逻辑较集中。
- `shared/ipc-contract.ts`：类型契约覆盖面广，增长较快。
- `electron/embeddingService.ts`、`electron/videoFrameService.ts`、`electron/imageSearchService.ts`：核心数据和模型链路，需保持谨慎修改。

## 全部审计

已完成度较高：

- Floating panel 基础框架、窗口置顶、透明度、拖拽、尺寸、全局隐藏/显示已可用。
- Image Search 主链路完成：扫描、fast hash 检索、DINO/CLIP embedding、Build Index、Semantic、以图搜图、剪贴板/拖拽查询、结果列表/大图模式。
- Media Search 主链路完成：视频扫描、ffprobe 元数据、ffmpeg 抽帧、DINO/CLIP frame embedding、frame index、以图搜视频、语义搜视频、字幕提取、多模态搜索、缓存/数据清理、Load Data。
- Native fast_scanner 已形成独立 C++ N-API 加速能力，包含 hash、segment mmap、append segment、path map、搜索和 native 测试。
- File Manager 已有目录分页、缩略图、批量操作、watcher、文件安全测试。
- Remote Terminal 已有 profile、凭据、连接、SFTP、传输队列、基础压力测试。
- App Storage、Duplicate Finder 均具备可用扫描和结果展示链路。
- IPC 大部分入口已有 normalize / guard / safeShellPath / 白名单模型名处理。
- 模型目录已经迁移到软件目录内的 `models` / `ai-models`，打包资源配置明确。

当前主要扣分点：

- 数据层仍以 JSONL manifest / shard 为主，适合快速迭代，但长期大数据量会形成读取、统计、排序压力。
- Media Search 和 Image Search 都已具备功能，但“召回质量评估”还依赖人工观察，缺少固定样本基准。
- `main.ts` IPC handler 多且混合，未来新增模块容易进一步膨胀。
- 部分 UI 面板仍承担状态管理、业务触发、渲染三类职责。
- docs 历史文档存在编码显示问题，降低后续交接可靠性。

## 结构审计

优点：

- 项目分层基本清楚：`src` 负责 renderer，`electron` 负责主进程服务，`shared` 放 IPC contract 和共享类型，`native` 放 fast_scanner。
- Image Search 已经做过较多组件拆分：维护栏、构建控件、状态栏、进度条、结果网格、索引底栏、最近 manifest、搜索控件、提示条、hash smoke test。
- Media Search 后端已经拆分出 `videoScanService`、`videoFrameService`、`videoFrameSearchService`、`mediaTaskQueue`、`mediaCacheService`、`mediaSearchFrameIndex`、`transcriptService`、`ffmpegService`。
- Remote Terminal 拆出 SSH、SFTP、Transfer、Credential 等服务，边界比早期更清楚。
- File Manager 具备独立 IPC 模块和安全测试，后续可继续复用缩略图能力。

问题：

- `electron/main.ts` 仍包含大量 IPC 业务 glue code，Media Search、Image Search、Vector、Remote、File Manager 都有逻辑散落其中。
- `MediaSearchPanel.tsx` 已做启动性能优化，但 UI 内仍有较多状态、回调、列表渲染和搜索控制逻辑。
- `shared/ipc-contract.ts` 越来越大，后续建议按模块拆契约文件，再统一导出。
- `semanticSearchService.ts` 同时承担 CLIP 文本 embedding、候选收集、fallback、缓存与进度，后续中文语义扩展会继续变复杂。
- JSONL 数据读写分散在多个服务中，缺少统一数据访问层。

建议：

- 逐步把 `main.ts` 中的模块 IPC 注册迁移为 `registerImageSearchIpc()`、`registerMediaSearchIpc()`、`registerVectorIpc()` 等文件。
- 继续拆分 `MediaSearchPanel`：`MediaSearchToolbar`、`MediaSearchStatusGrid`、`MediaSearchResultGrid`、`MediaSearchProgressBars`。
- 将 Media Search 的 manifest、frame index、stats cache 统一到 `mediaSearchRepository` 或 `mediaSearchStore`。
- 将 `shared/ipc-contract.ts` 拆为 `imageSearchContract`、`mediaSearchContract`、`remoteContract`、`fileManagerContract`。

## 逻辑审计

优点：

- Image Search 保持“三层检索”思路：hash retrieval -> vector retrieval -> rerank verification，不推翻 fast_scanner 第一层。
- DINO 和 CLIP 构建支持 CPU/GPU 路径，子进程隔离降低模型崩溃对主进程影响。
- Media Search 的 `Scan` 与 `Build Frames` 已明确分工：前者扫描视频元数据，后者抽帧。
- Media Search 近期已修复打开卡顿：打开时不再自动跑 `getFrameEmbeddingStats` 和 `listVideos` 重操作，完整数据改为手动 `Load Data`。
- Media Search 数据层近期已优化：视频/帧列表预览路径、frame embedding stats 持久缓存、frame index 只提取 imagePath 统计。
- 搜索进度回传已具备百分比、速度、ETA、phase message。

问题：

- 搜索质量仍需固定样本验证。以图搜视频已较接近预期，语义搜视频对中文输入仍不稳定。
- `Load Data` 首次仍可能触发重统计；缓存命中后会快，但首次计算对大库仍有成本。
- JSONL manifest 逆序预览提升了速度，但不是严格分页数据库，复杂筛选、排序和多条件检索会受限。
- 部分逻辑依赖运行时缓存签名，缓存失效规则需要继续压测。
- Build Frames 对系统资源占用已有优化，但用户大盘符扫描/抽帧仍可能遇到 IO 或 ffmpeg 并发压力。

建议：

- 建立固定 media sample benchmark：固定视频目录、固定 query image、固定 text query，记录 topK 准确率和耗时。
- 给 Media Search 增加“数据健康页”：video manifest 行数、frame manifest 行数、DINO/CLIP embedding 覆盖、frame index 新鲜度、stats cache 命中状态。
- JSONL 保留为兼容层，新增 SQLite 作为长期索引层。
- 搜索质量使用标注样本评估，不再只靠截图观察。

## 安全审计

优点：

- `safeShellPath` 已在大量 open/reveal/hash/load 路径中使用。
- Media Search 的 start scan、task id、open media input 有 guard 测试。
- Remote SFTP 路径使用 POSIX normalize，拒绝 NUL、Windows 反斜杠、超长路径。
- File Manager 有安全测试，覆盖文件操作风险入口。
- 模型名使用白名单，避免 renderer 任意指定模型路径。
- `contextBridge` 暴露 API，renderer 不直接访问 Node。

风险：

- `main.ts` 中仍有大量 shell/openPath/showItemInFolder 调用，未来新增入口容易漏 guard。
- 用户本地路径会显示在 renderer，需要继续避免 HTML 注入和不安全 innerHTML。
- 清理缓存/数据涉及递归删除，虽然已有路径校验，但需要持续保持“目标必须在 data dir 内”的规则。
- 模型下载、外部工具 ffmpeg 路径配置需要继续限制目录边界和可执行文件验证。
- Remote Terminal 凭据安全需要持续审计，尤其是导入导出、传输任务历史和错误日志。

建议：

- 所有 IPC handler 统一通过 validator 文件声明输入输出。
- shell 操作统一封装为 `safeOpenPath` / `safeRevealPath`。
- 对清理类操作补充单测，覆盖路径穿越、符号链接、根目录保护。
- 对 renderer 传入的大对象做大小限制，避免 IPC 滥用造成主进程压力。

## 性能审计

已优化：

- Image Search 使用 native fast_scanner 和 segment mmap，hash 检索性能高。
- Image Search embedding 从单体大 JSONL 转向分片/streaming，并有维护入口。
- Media Search 打开窗口不再自动加载重数据，避免 3-4 秒卡顿。
- Media Search `listVideos` / `listFrames` 不带缩略图时使用 JSONL 尾部预览路径。
- Media Search `getFrameEmbeddingStats` 增加持久缓存，命中后避免重复扫 frame index / embedding shard。
- frame index 统计改为只提取 `imagePath`，不再解析完整 512/768 维向量数组。
- ffmpeg 状态检查从同步阻塞改为缓存/异步 warm。

剩余瓶颈：

- 首次统计和首次索引构建仍需要扫大文件。
- JSONL 随数据增长会继续放大 IO 成本。
- 大量缩略图/图片 data URL 进入 renderer 时仍可能造成内存压力。
- GPU embedding 路数可调，但过高会造成系统级卡顿，需要更完善的背压和温度/显存保护。

建议：

- Media Search 和 Vector 数据层迁移 SQLite：视频、帧、embedding coverage、失败记录、统计缓存都可入库。
- 缩略图使用分页 + 虚拟列表，减少一次性 DOM 和 data URL。
- 为 GPU embedding 增加自动节流：根据失败率、耗时、显存或温度动态降低并发。
- 将性能日志 `[MediaSearchPerf]` 保留为开发模式，生产可通过设置开关启用。

## 数据层审计

当前数据形态：

- Image Search：fast_scanner native index、manifest、segment mmap、vector-db 分片、embedding jobs/failures/diagnostics。
- Media Search：`video_files.jsonl`、`video_frames.jsonl`、`frame_embedding_index.jsonl`、`stats/frame_embedding_stats.json`、frames/thumbnails/transcripts/temp。
- Vector：DINO/CLIP embedding shard、Build Index、maintenance stats。
- 设置：settings/config JSON。

优点：

- JSONL 易调试、易恢复、易追加，适合当前快速迭代。
- 重要重数据已有分片、缓存、签名、预览路径。
- Clear Cache 与 Clear Video Data 已区分，避免误删可搜索数据。

问题：

- JSONL 无原生索引，多条件查询和分页排序成本高。
- 多模块各自实现签名、缓存、扫描，存在重复。
- 数据迁移和版本号机制不明显，未来格式变更可能需要兼容层。

建议：

- 建立 `dataVersion` 和 migration 机制。
- 引入 SQLite 后，JSONL 作为导入/备份格式。
- 统计缓存文件统一存入 `stats`，并记录 `sourceSignature`、`updatedAt`、`schemaVersion`。

## 复用功能审计

当前复用较好的能力：

- `vectorDatabaseService`：DINO/CLIP embedding 存储、分片路径、向量读取。
- `embeddingService`：模型构建任务、进度、GPU/CPU、子进程隔离。
- `modelService`：模型状态、下载、删除、目录管理。
- `SearchProgressBar` / 进度结构：Image Search 和 Media Search 都在向统一进度体验靠拢。
- `pathGuards` / `ipcValidation` / `mediaSearchGuards`：输入清洗和路径安全。
- `ffmpegService`：视频元数据、抽帧、字幕检测/提取。
- File Manager 缩略图链路：后续可继续给 Media Search 复用。
- Remote Transfer Queue：可复用任务进度、取消、失败状态模式。

复用不足：

- Media Search UI 仍未像 Image Search 那样拆出足够多独立组件。
- IPC 注册仍集中在 `main.ts`，复用边界不够清晰。
- Vector maintenance 和 Media maintenance 是两套入口，后续可统一为 Storage/Maintenance 面板。
- 不同模块的分页/预览/统计缓存写法相似但未抽象。

建议：

- 抽出通用 `JsonlPreviewReader`、`PersistentStatsCache`、`TaskProgressBar`。
- 抽出统一 `registerIpcModule(name, handlers)` 模式。
- 将模型构建控件抽象为可配置组件，Image/Media 共用。

## 功能完成度评估

整体项目完成度：`86 / 100`。

分模块评估：

- Window / panel system：`86 / 100`
- Image Search：`90 / 100`
- Media Search：`84 / 100`
- Vector / Embedding / Model：`84 / 100`
- File Manager：`82 / 100`
- Remote Terminal / SFTP / Transfer：`80 / 100`
- App Storage：`82 / 100`
- Duplicate Finder：`80 / 100`
- Native fast_scanner：`88 / 100`
- 测试与验证：`76 / 100`
- 安全边界：`82 / 100`
- 扩展性：`78 / 100`

## 当前落地进度

近期已完成的关键优化：

- Media Search 打开卡顿定位：`getFrameEmbeddingStats` 和 `listVideos` 是主耗时点。
- Media Search 启动策略调整：打开仅加载轻量状态，重列表/统计改为手动 `Load Data`。
- Media Search 禁用大透明面板开场滤镜和扫描线覆盖，减少合成压力。
- Media Search 增加 `[MediaSearchPerf]` 性能日志。
- Media Search `listVideos` 改为轻量预览。
- Media Search `listFrames` 改为轻量预览。
- Media Search `getFrameEmbeddingStats` 去掉逐帧 `existsSync` 和额外视频 manifest 读取。
- Media Search frame index 统计只提取 `imagePath`，不解析完整向量。
- Media Search 增加 `stats/frame_embedding_stats.json` 持久统计缓存。
- `mediaCacheService` 增加 `stats` 目录创建和清理。
- 多轮验证通过 `npm.cmd run typecheck` 和 `npm.cmd run build:renderer`。

## 测试审计

已有测试：

- `test:guards`
- `test:ipc-validation`
- `test:settings`
- `test:fm-security`
- `test:fm-watcher`
- `test:app-storage`
- `test:duplicate-finder`
- `test:media-search`
- `test:remote-terminal`
- `test:remote-sftp`
- `test:remote-transfer`
- `test:remote-stress`
- `test:vector-pipeline`
- `test:native`

不足：

- 缺少 Playwright/Electron UI 自动化点击流。
- Media Search 搜索准确率没有固定 golden set。
- GPU embedding 稳定性缺少长时间压力测试。
- 大数据 manifest 的性能回归测试还偏脚本化，未纳入标准 `npm test`。

建议：

- 建立 `tests/e2e`：打开窗口、选择路径、Scan、Build Frames、Build CLIP/DINO、搜索、清理。
- 建立 `tests/fixtures/media` 小样本库和预期 topK。
- 把 Media Search benchmark 的结果写入 `docs/benchmark`。

## 发布审计

当前发布链路：

- `npm run build` 负责主构建。
- `build:renderer` 可单独验证 renderer / electron bundle。
- `build:native` / `build:native:electron` 构建 native addon。
- `release` 输出 NSIS 安装包。
- `extraResources` 包含 native addon、worker、models、ai-models、tools。

风险：

- 模型和 tools 会显著影响安装包体积。
- 开发目录、release 目录、AppData 数据目录需要继续保持边界清晰。
- 打包后 smoke test 应继续保留，避免 native addon 路径、模型路径、ffmpeg 路径失效。

建议：

- 发布前固定跑：`typecheck`、核心测试、`build:native:electron`、`build`、安装包启动 smoke。
- release 目录继续只保留安装包，避免 win-unpacked 长期占用空间。

## 风险清单

P0 风险：

- 无当前 P0 阻断项。核心功能可用。

P1 风险：

- Media Search 大数据首次统计/索引仍可能慢。
- 语义搜索准确率需要固定样本验证。
- `main.ts` 继续膨胀会增加回归风险。
- GPU embedding 高并发可能造成系统卡顿。

P2 风险：

- docs 编码混杂。
- 部分历史 warning / any 仍存在。
- 部分 UI 状态提示不够产品化。
- JSONL 长期维护成本高。

## 后续路线

推荐优先级：

1. 拆分 `main.ts` IPC 注册，先从 Media Search 开始。
2. 继续拆分 `MediaSearchPanel.tsx`，降低 UI 复杂度。
3. 建立 Media Search 固定样本召回测试。
4. 把 Media Search 和 Vector 的 stats cache 抽成通用工具。
5. 引入 SQLite 作为 Media Search 的长期索引层。
6. 增加 E2E 自动化，覆盖 Image Search / Media Search 主流程。
7. 处理 docs 编码统一和旧文档归档。

## 当前评分

- 项目健康度：`84 / 100`
- 项目完成度：`86 / 100`
- 架构清晰度：`80 / 100`
- 逻辑稳定性：`83 / 100`
- 安全边界：`82 / 100`
- 性能表现：`80 / 100`
- 测试覆盖：`76 / 100`
- 可扩展性：`78 / 100`
- 可维护性：`81 / 100`

结论：项目已经具备继续迭代和内部使用的基础。后续不要再大范围推翻现有链路，应该围绕“数据层持久化、IPC 拆分、UI 组件拆分、固定样本测试、性能基准”做持续收敛。

## 2026-07-05 自动优化进度 1

本轮目标：先处理审计中低风险、收益明确的问题，避免继续扩大 Media Search 主面板复杂度，并把性能日志和统计缓存做成更可控的结构。

已完成：
- 拆出 `src/components/MediaSearchStatusGrid.tsx`，承接 Media Search 状态网格展示。
- 拆出 `src/components/MediaSearchProgressBars.tsx`，承接任务进度、搜索进度、embedding 进度展示。
- `MediaSearchPanel.tsx` 删除一批状态/进度展示中间变量，主组件职责收敛到流程控制和数据请求。
- `[MediaSearchPerf]` 日志改为开关控制：开发环境默认开启；生产环境默认关闭，可通过 `localStorage.mediaSearchPerf=1` 临时开启。
- 新增 `electron/persistedStatsService.ts`，统一按签名读取/写入持久化 stats JSON。
- `videoFrameService.ts` 的 frame embedding stats 缓存改为复用通用 stats 工具，原缓存文件格式保持不变。

验证：
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

遗留：
- 构建仍提示部分 Electron 后台模块同时存在静态 import 和动态 import，导致 chunk 不能进一步拆分；这是既有架构问题，后续应结合 `main.ts` IPC 拆分一起处理。
- `MediaSearchPanel.tsx` 仍偏大，下一轮建议继续拆出 toolbar、path chips、frame result grid、video result list。
- Media Search 的固定样本准确率测试仍未补齐，需要建立小型 fixture 和 topK golden set。

## 2026-07-05 自动优化进度 2

已完成：
- 拆出 `src/components/MediaSearchPathChips.tsx`，承接 Media Search 扫描路径 chips 展示和删除按钮状态。
- `MediaSearchPanel.tsx` 进一步减少内联 UI，路径展示逻辑改为独立组件。

验证：
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

下一轮建议：
- 继续拆 `MediaSearchPanel.tsx` 的 toolbar 和结果列表，降低单文件维护成本。
- 梳理 Electron 后台动态/静态 import 混用警告，优先从 Media Search IPC 注册拆分开始。
- 建立 Media Search 固定样本回归测试，避免后续优化再次影响语义/以图搜视频准确率。
