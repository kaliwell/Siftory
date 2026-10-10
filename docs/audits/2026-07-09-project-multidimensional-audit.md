# FloatingClock 项目全量多角度审计 - 2026-07-09

> 项目：FloatingClock Electron  
> 审计时间：2026-07-09  
> 审计范围：项目结构、核心功能、业务逻辑、性能效率、安全边界、复用情况、可扩展性、测试与发布链路、当前可优化项。  
> 审计方式：读取当前代码、现有 docs、package scripts、核心模块、测试目录，并执行基础验证命令。  

## 总体结论

当前项目健康度：`84 / 100`。  
当前项目完成度：`87 / 100`。  
当前状态：`可用 Beta / 准发布候选`。

项目已经从“功能堆叠阶段”进入“稳定化、性能收敛、结构拆分、测试基准化阶段”。主要功能链路已经可用：窗口系统、Prompt、Folders、Files、Image Search、Media Search、Vector/Embedding、Remote Terminal、App Storage、Duplicate Finder、Native fast_scanner 都已形成实际功能闭环。

目前最大风险不再是功能缺失，而是长期维护成本：

- `electron/main.ts` 仍是最大结构热点，IPC 注册和业务 glue code 过度集中。
- `MediaSearchPanel.tsx`、`RemoteTerminalPanel.tsx`、`useStore.ts` 仍偏大，后续继续扩展会增加回归风险。
- Image/Media/Vector 三条检索链路都已可用，但召回质量、性能曲线和大数据量边界仍缺少固定样本自动化验证。
- JSONL manifest / vector store 对快速迭代友好，但长期对 10 万级以上记录的统计、排序、清理、索引重建会持续带来压力。
- 当前 lint 已恢复通过，基础质量门禁比审计初始状态更稳定。

## 验证结果

本次审计执行了以下命令：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run build:renderer`：通过。
- `npm.cmd audit --audit-level=moderate`：通过，`found 0 vulnerabilities`。
- `npm.cmd run lint`：审计初始状态未通过，后续自动优化后已通过。

`build:renderer` 仍存在既有 Vite warning：部分 Electron 后台模块同时被静态 import 和动态 import，导致动态 import 不能真正拆 chunk。涉及模块包括：

- `electron/vectorDatabaseService.ts`
- `electron/ffmpegService.ts`
- `electron/videoScanService.ts`
- `electron/videoFrameService.ts`
- `electron/mediaSearchFrameIndex.ts`
- `electron/videoFrameSearchService.ts`

已修复的 lint 问题：

- `electron/mediaSearchFrameIndex.ts:90`：`no-constant-condition`。
- `electron/persistedStatsService.ts:4`：未使用泛型 `T`。
- `electron/videoFrameSearchService.ts:39`：未使用参数 `modelName`。
- `electron/videoFrameService.ts:347`：未使用参数 `modelName`。
- `src/components/MediaSearchPanel.tsx:39`：`formatRate` 未使用。
- `src/components/MediaSearchPanel.tsx:80/83`：`console` warning。
- `src/components/MediaSearchPanel.tsx:682`：`searchTextOnly` 未使用。

## 项目规模快照

当前 `src / electron / shared / tests` 统计：

- 文件数：`144`
- 代码行数：约 `37,560`
- 测试文件：`25`
- IPC handler 数量：约 `144`

当前主要大文件：

| 文件 | 行数 | 审计判断 |
| --- | ---: | --- |
| `electron/main.ts` | 2696 | 最大结构风险，IPC 和编排职责集中 |
| `src/components/RemoteTerminalPanel.tsx` | 1199 | UI 状态和业务操作偏集中 |
| `src/components/MediaSearchPanel.tsx` | 843 | 已继续拆出结果渲染和 toolbar / query controls |
| `shared/ipc-contract.ts` | 1173 | 契约集中，建议后续按模块拆分 |
| `electron/semanticSearchService.ts` | 1162 | 语义搜索候选、fallback、cache 逻辑复杂 |
| `electron/embeddingService.ts` | 1067 | 模型/worker/任务逻辑复杂，需保持边界 |
| `src/stores/useStore.ts` | 1040 | 全局状态集中，长期扩展风险高 |
| `src/components/filemanager/FilePane.tsx` | 942 | 文件 UI/交互复杂 |
| `src/components/ImageSearchPanel.tsx` | 841 | 功能完整，仍可拆分剩余控制逻辑 |
| `electron/imageSearchService.ts` | 834 | Image Search 核心服务，需强化数据层边界 |

## 架构审计

当前架构分层：

- `src`：React renderer，负责各浮动面板、状态展示、用户操作入口。
- `electron`：主进程服务，负责 IPC、文件系统、模型、向量、扫描、远程终端、原生模块调用。
- `shared`：IPC contract、共享类型、vector 类型。
- `native`：fast_scanner N-API 加速模块。
- `tests`：Node test、native test、guard test、benchmark/smoke 脚本。
- `docs`：方案、审计、交接、性能记录。

优点：

- 已经形成清晰的 renderer / main / shared / native 分层。
- 文件管理、远程终端、Media Search、Image Search 都有独立服务文件，后端不是完全堆在一个文件中。
- `shared/ipc-contract.ts` 统一了大量跨进程类型，避免 renderer 和 main 私自约定。
- Media Search 已拆出 scan、frame、search、cache、task queue、frame index、ffmpeg、subtitle 等后端模块。
- 最近新增的 `persistedStatsService.ts` 开始抽象持久统计缓存。
- `DraggablePanel` 已作为统一窗口容器复用，最近增加 rAF 拖动节流，改善高频拖动重绘问题。

问题：

- `electron/main.ts` 仍包含大量 IPC handler 和业务 glue code，是后续最优先拆分对象。
- `preload.ts` 暴露 API 很多，随着模块增长会继续膨胀，需要按 namespace 生成或拆分。
- `shared/ipc-contract.ts` 已超过 1100 行，模块边界逐渐模糊。
- 前端部分面板仍然是“数据请求 + 状态管理 + UI 渲染 + 命令触发”混合模式。
- 测试和 benchmark 脚本独立存在，但还未形成强制执行的质量门禁。

建议：

1. 新建 `electron/ipc/*.ts`，按模块注册 IPC：
   - `registerMediaSearchIpc`
   - `registerImageSearchIpc`
   - `registerVectorIpc`
   - `registerRemoteTerminalIpc`
   - `registerAppStorageIpc`
   - `registerDuplicateFinderIpc`
2. `shared/ipc-contract.ts` 拆成：
   - `shared/contracts/mediaSearch.ts`
   - `shared/contracts/imageSearch.ts`
   - `shared/contracts/vector.ts`
   - `shared/contracts/remoteTerminal.ts`
   - `shared/contracts/fileManager.ts`
3. 前端面板继续拆纯 UI 组件，优先处理 Media Search 和 Remote Terminal。
4. 建立统一数据层接口，隐藏 JSONL / mmap / index 的具体实现。

## 逻辑审计

已验证或具备较好闭环的逻辑：

- Image Search：扫描、索引、hash/vector 搜索、剪贴板、拖拽、结果打开、文件夹打开、大图模式已可用。
- Media Search：视频扫描、抽帧、DINO/CLIP embedding、以图搜视频、语义搜视频、字幕提取、缓存清理、数据清理已可用。
- Remote Terminal：连接、凭据、SFTP、传输队列、取消、历史清理具备基础闭环。
- File Manager：目录列表、分页、watch、打开、重命名、删除、缩略图具备闭环。
- Window System：拖动、置顶、隐藏/显示、透明度、窗口层级、拖动节流已逐步修复。

主要逻辑风险：

- Media Search 的 `Scan` 与 `Build Frames` 曾经存在用户理解上的重叠：Scan 负责发现视频和元数据，Build Frames 负责抽帧。UI 已改善，但仍建议在任务状态中明确显示“当前数据范围”和“下一步建议”。
- Image/Media Search 的语义检索依赖 embedding 完整性；若 embedding 数据被清理、模型未准备好、scan paths 范围变化，结果会明显变化。需要更明确的数据一致性提示。
- CLIP 中文能力有限，中文 query 直接搜可能不稳定。当前不宜承诺“中文语义高准确率”，应在 UI 中标明模型能力。
- Build Index 语义不够直观。对用户而言需要解释：它不是重新扫描文件，而是为已有 embedding 建搜索索引。
- 大盘符扫描仍需强调 cap、跳过、失败、权限拒绝、不可读文件数量，避免用户误以为扫描了全部。

建议：

- 为 Media Search 增加“数据链路状态条”：
  `Paths selected -> Scan videos -> Build Frames -> Build DINO/CLIP -> Search ready`
- 为 Image Search / Media Search 增加 embedding 完整度检查：
  - 当前记录数
  - 已 embedding 数
  - 缺失数
  - 当前查询实际参与候选数
- 为搜索结果增加“数据来源说明”：hash / DINO / CLIP / fallback / filename path。
- 对 Build Index、Build Frames、Build CLIP、Build DINO 增加 hover tooltip。

## 性能效率审计

已完成的性能优化：

- Media Search 打开时不再立即加载全部数据，改为轻量启动和手动 Load Data。
- `getFrameEmbeddingStats` 已去掉逐帧 `existsSync` 和额外 manifest 读取，增加持久 stats 缓存。
- `listVideos` / `listFrames` 支持轻量 preview，减少启动卡顿。
- Media Search 禁用高成本开场滤镜/扫描线 overlay。
- Prompt 编辑窗口已禁用高成本 overlay，textarea 绘制隔离，并对 `DraggablePanel` 拖动做 rAF 节流。
- Build Frames 并发默认较保守，避免 ffmpeg 抢占系统资源。
- DINO/CLIP embedding 使用 child process，避免模型推理直接阻塞主进程。

当前性能风险：

- `electron/main.ts` 静态 import 过多，构建 warning 表明动态 import 并未真正拆 chunk。
- JSONL 大文件统计仍依赖文件扫描/解析，长期需要 SQLite 或专用索引。
- Media Search 结果列表、Frame grid 若一次渲染大量图片，仍可能触发 renderer 压力，需要虚拟列表。
- Remote Terminal 面板复杂，xterm、多 session、文件浏览和 profile 编辑混合在同一大组件内。
- Image Search / Media Search 缩略图仍可能产生大量 IO 和图像解码压力。
- GPU embedding 并发过高会让系统交互卡顿；并发过低又影响速度，需要自适应策略。

建议：

1. 搜索结果列表统一虚拟滚动：
   - Image Search
   - Media Search Frames
   - File Manager thumbnails
2. Media Search 引入 SQLite：
   - videos table
   - frames table
   - embeddings meta table
   - search cache table
3. 后台任务进度统一节流：主进程最多 10-20Hz 推送 renderer。
4. 缩略图加载增加 LRU cache 和 decode 队列。
5. Build Frames 增加“低占用/均衡/极速”三档。
6. 构建层面处理动态/静态 import 混用，减少 Electron bundle 首载压力。

## 安全审计

当前安全状态：`npm audit --audit-level=moderate` 为 0 漏洞。

已有安全能力：

- File Manager 有安全测试：路径、删除、watcher 等。
- IPC 中大量入口已经使用 unknown 输入和 normalize/validate。
- `pathGuards.ts` 提供 shell/open path 相关安全封装。
- Remote Terminal 凭据已有独立服务，不是简单写在 profile 明文字段中。
- NSIS 配置未默认管理员安装，`allowElevation: false`，降低安装权限风险。
- destructive 操作如 clear cache / clear data 已有路径边界检查。

主要安全风险：

- IPC handler 数量非常多，必须确保所有入口都经过 schema/guard，不能依赖 renderer 传入正确数据。
- `shell.openPath` / `showItemInFolder` / 文件删除 / remote remove 是高风险操作，需要统一 guard。
- Remote Terminal/SFTP 涉及凭据、远程命令、文件传输，必须避免日志泄露密码和密钥路径。
- 模型下载和本地模型读取需要校验目标目录，防止路径穿越。
- FFmpeg 外部工具路径由用户选择，启动参数必须严格数组化，不能拼 shell 命令。
- 当前 `lint` 已通过，质量门禁已恢复；后续要保持新增代码不引入 warning。

建议：

1. 建立统一 `registerSafeIpc(channel, validator, handler)`。
2. 所有 IPC 输入通过 `ipcValidation.ts` 或模块 validator。
3. 所有文件系统 destructive 操作统一进入 `safeFileOps.ts`。
4. Remote Terminal 日志默认脱敏：
   - password
   - privateKey
   - passphrase
   - token
5. 对模型目录、tools 目录、cache 目录建立统一 allowlist root。
6. 将 `npm audit`、`typecheck`、核心 tests 加入发布前固定 checklist。

## 复用审计

复用良好的部分：

- `DraggablePanel` 统一窗口容器。
- `TabBar` 复用 Folders / Prompts。
- `mediaTaskQueue` 承担 Media Search 后台任务队列。
- `persistedStatsService` 已开始承担通用 stats 缓存。
- `settingsStore` 统一 settings/config 读写和损坏备份。
- `pathGuards` 提供路径安全能力。
- Image Search 组件拆分后可作为 Media Search UI 继续参考。

复用不足：

- Image Search 与 Media Search 的搜索控件、路径 chips、进度条、结果 grid 仍存在相似但不同实现。
- Vector/Embedding 的任务进度模型和 Media Search frame embedding 进度模型仍未完全统一。
- JSONL preview、manifest signature、stats cache 仍只做了部分抽象。
- IPC 注册、参数校验、错误返回格式未形成统一 helper。
- thumbnail 加载/缓存能力在 File Manager、Image Search、Media Search 之间还未完全复用。

建议：

- 建立 `src/components/common/SearchToolbar.tsx`。
- 建立 `src/components/common/TaskProgress.tsx`。
- 建立 `src/components/common/PathChips.tsx`，Image/Media/File 可复用。
- 建立 `electron/jsonlStore.ts`：
  - readPreview
  - countLines
  - appendAtomic
  - compact
  - signature
- 建立 `electron/ipcResult.ts`，统一 `{ ok, error, data }` 返回风格。

## 可扩展性审计

可扩展基础：

- 已有 native fast_scanner，可继续增加 native 高性能能力。
- 已有 DINO/CLIP 两类视觉模型，未来可挂更多模型。
- Media Search 数据目录已稳定到 AppData，适合长期缓存。
- `models` / `ai-models` 已纳入软件目录和打包资源。
- Remote Terminal 和 File Manager 能扩展为更完整的系统工具。

限制点：

- 当前数据层主要是 JSONL，扩展到百万记录会吃力。
- IPC 契约集中，模块越多冲突越明显。
- Renderer 单 store 过大，状态更新可能影响无关面板。
- 搜索质量评估没有自动基准，扩展模型后难判断是否退化。
- 中文语义搜索需要专门模型或翻译/多 prompt 策略，否则上限有限。

建议路线：

1. 短期：继续拆分 UI / IPC / contract，降低变更风险。
2. 中期：Media/Image Search 引入固定样本测试和 benchmark。
3. 中期：SQLite 化 Media Search，Image Search 继续保留 native segment mmap。
4. 长期：建立统一检索框架：
   - Source scanner
   - Asset manifest
   - Feature builder
   - Vector store
   - ANN index
   - Query planner
   - Result renderer
5. 长期：引入中文友好图文模型或多语言 embedding 模型。

## 模块审计

### Window / Panel System

完成度：`88 / 100`

已完成：
- 浮窗拖动、缩放、置顶层级、隐藏/显示、透明度、锁定。
- `DraggablePanel` 已统一各功能面板。
- 已处理 prompt 编辑窗口拖动卡顿：rAF 节流、禁用 overlay、textarea 绘制隔离。

问题：
- 所有面板仍共享较多全局 CSS，单个面板的高成本样式容易影响其他面板。
- 面板布局和状态仍集中在 `useStore`。

优化：
- 为每类面板提供 `data-panel` 和专用性能规则。
- 将面板位置/大小/可见性状态从大 store 中拆到 panel store。

### Prompt / Folders

完成度：`84 / 100`

已完成：
- Prompt tabs、Prompt 增删改、编辑窗口、复制。
- Folders tabs 和路径打开。

问题：
- Prompt 编辑窗口是局部 state，关闭时自动保存，缺少显式 dirty 状态。
- Prompt 数据和 UI 编辑状态都在全局 store 周边，后续批量导入/搜索会变复杂。

优化：
- 增加 Prompt 搜索。
- 增加 Prompt 导入/导出。
- 编辑窗口增加 dirty 提示和撤销。

### Image Search

完成度：`91 / 100`

已完成：
- fast_scanner native、hash 搜索、DINO/CLIP embedding、Build Index、语义、以图搜图。
- 剪贴板/拖拽查询、缩略图、Open/Folder/Copy、结果大图模式。
- 进度和状态展示已比较完整。

问题：
- 语义准确率仍依赖模型能力和 embedding 完整度。
- 缺少固定样本 topK 回归。
- 向量和 hash 数据维护仍偏 JSONL / segment 文件组合。

优化：
- 增加固定图片样本库。
- 搜索结果标明使用的检索模式和候选数。
- 建立 embedding 完整度面板。

### Media Search

完成度：`86 / 100`

已完成：
- 视频扫描、元数据、ffmpeg 抽帧、DINO/CLIP frame embedding。
- 以图搜视频、语义搜视频、字幕提取、多模态搜索。
- 数据清理、缓存清理、FFmpeg 目录选择、Load Data、轻量启动。
- 已修复多轮卡顿/数据丢失/扫描范围提示/结果显示问题。

问题：
- `MediaSearchPanel.tsx` 已降至约 843 行，结果渲染已独立为 `MediaSearchResultsView.tsx`，顶部控件已独立为 `MediaSearchControls.tsx`。
- 语义搜索质量缺少固定样本验证。
- Build Frames / DINO Frames / CLIP Frames 对普通用户仍需要更直观说明。
- JSONL + frame image + embedding store 数据一致性需要更强状态检查。

优化：
- 继续拆出剩余 query 状态、消息区和任务编排辅助函数。
- 建立 `MediaSearchHealthPanel`：
  - videos
  - frames
  - DINO embeddings
  - CLIP embeddings
  - missing
  - failed
  - current paths coverage
- 建立小样本视频 benchmark。

### Vector / Embedding

完成度：`84 / 100`

已完成：
- CLIP / DINO 模型加载。
- CPU/GPU backend 选择。
- child process 推理隔离。
- Image/Media 共用部分 embedding 基础能力。

问题：
- GPU 并发调优仍偏手动。
- 模型错误、缺失、fallback 对用户仍不够透明。
- 中文语义不是当前 CLIP 模型强项。

优化：
- 增加自动并发调节：根据 GPU 内存、失败率、吞吐调整。
- 增加模型健康检查。
- 增加中文模型方案预研。

### File Manager

完成度：`83 / 100`

已完成：
- 分页列表、watcher、安全 guard、缩略图、打开/文件夹/操作。
- 已有专门安全测试。

问题：
- 缩略图逻辑可进一步提取给 Image/Media 使用。
- FilePane 仍偏大。

优化：
- 抽 `ThumbnailProvider`。
- 抽 `FileOperationQueue`。
- 增加大目录 benchmark。

### Remote Terminal

完成度：`82 / 100`

已完成：
- SSH profile、连接、xterm、SFTP、上传下载、传输队列、压力测试。

问题：
- `RemoteTerminalPanel.tsx` 1199 行，UI 和状态偏集中。
- 凭据、SFTP、Transfer、Profile Editor UI 可继续分离。

优化：
- 拆 session list、terminal area、sftp browser、transfer panel。
- 增加连接失败分类和重试策略。

### App Storage / Duplicate Finder

完成度：`82 / 100`

已完成：
- 应用空间扫描、缓存读取/清理。
- 重复文件扫描、最大文件查找、基础测试。

问题：
- 大目录扫描性能和取消响应仍需要 benchmark。
- 与 File Manager 的打开路径、安全 path guard 可以继续统一。

优化：
- 统一扫描任务队列。
- 增加大目录回归样本。

### Native fast_scanner

完成度：`89 / 100`

已完成：
- N-API native addon。
- hash、decode、segment、mmap、search correctness 测试。
- Image Search 主链路已受益明显。

问题：
- native 构建和 Electron ABI 依赖仍需要发布前 smoke test。
- 错误信息对 UI 用户仍偏底层。

优化：
- 发布前固定跑 `build:native:electron` + smoke 启动。
- native error code 映射为 UI 文案。

## 测试审计

已有测试：

- guards
- ipc-validation
- settings
- file-manager-security
- file-manager-watcher
- app-storage
- duplicate-finder
- media-search-guards
- remote-terminal
- remote-sftp
- remote-transfer
- remote-stress
- vector-pipeline
- native scan/decode/hash/segment/search correctness

不足：

- 缺少 Playwright/Electron UI 自动化。
- 缺少 Image Search / Media Search 准确率 golden set。
- 缺少长期 GPU embedding 压力测试。
- 缺少大型目录和大型 JSONL 的性能回归门禁。
- `lint` 已恢复通过，可以重新作为 CI/发布前阻断项。

建议：

1. 保持 `npm run lint` 通过。
2. 新增 `tests/e2e`：
   - 打开窗口
   - 添加路径
   - scan
   - build frames
   - build embedding
   - query image
   - text query
   - clear data
3. 新增固定 fixture：
   - `tests/fixtures/images`
   - `tests/fixtures/videos`
   - `tests/fixtures/expected-search.json`
4. 将 `npm run verify` 作为发布前必跑命令。

## 发布审计

当前发布链路：

- `npm run build`：主构建脚本。
- `npm run build:renderer`：renderer + electron bundle。
- `npm run build:native` / `build:native:electron`：native addon。
- `release`：electron-builder 输出 NSIS 安装包。
- `extraResources` 包含 native addon、workers、models、ai-models、tools。

风险：

- `models`、`ai-models`、`tools` 会显著影响安装包体积。
- `release/win-unpacked` 长期保留会占用大量磁盘空间。
- Electron dynamic/static import warning 表示 bundle 拆分效果有限。
- 缺少自动安装包 smoke test。

建议：

- release 目录只保留安装包，打包后清理 `win-unpacked`。
- 发布前跑：
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build:native:electron`
  - `npm run build`
  - 安装包启动 smoke

## 当前可优化清单

P0：当前无阻断 P0。

P1：

- 保持 lint 零错误零 warning，并将其纳入发布前固定验证。
- 拆分 `electron/main.ts` IPC 注册。
- 继续拆分 `MediaSearchPanel.tsx` 剩余消息区/任务编排，以及 `RemoteTerminalPanel.tsx`。
- 建立 Image/Media Search 固定样本准确率测试。
- 解决 Electron 后台模块动态/静态 import 混用 warning。
- Media Search 数据层引入 SQLite 或至少统一 JSONL store。

P2：

- docs 编码统一为 UTF-8。
- Prompt 增加搜索/导入导出/dirty 状态。
- 缩略图 provider 统一复用。
- GPU embedding 自动并发调优。
- 模型状态/错误文案产品化。
- 发布体积自动统计。

P3：

- 中文语义模型接入。
- 多模态检索统一 Query Planner。
- 可视化 benchmark dashboard。
- 插件化工具面板。

## 优先路线图

第一阶段：代码健康收敛

1. 保持 lint 通过。
2. 将 Media Search IPC 从 `main.ts` 拆到独立注册模块。
3. 将 Image Search IPC 从 `main.ts` 拆出。
4. 拆 `shared/ipc-contract.ts`。

第二阶段：性能与数据层

1. 建立 JSONL store helper。
2. Media Search 引入 SQLite 方案或中间索引层。
3. 统一缩略图 cache / decode queue。
4. 对搜索进度和任务进度做统一节流。

第三阶段：搜索质量

1. 建立固定图片/视频样本。
2. 记录 topK 期望结果。
3. 对 DINO/CLIP/hash/semantic 分别跑准确率 smoke。
4. 针对中文 query 引入专门策略。

第四阶段：发布可靠性

1. `npm run verify` 全量可过。
2. 安装包 smoke test。
3. release 体积报告。
4. Native addon ABI 检查。

## 当前评分

| 维度 | 评分 |
| --- | ---: |
| 项目完成度 | 87 / 100 |
| 项目健康度 | 84 / 100 |
| 架构清晰度 | 81 / 100 |
| 逻辑稳定性 | 84 / 100 |
| 性能效率 | 82 / 100 |
| 安全边界 | 84 / 100 |
| 复用程度 | 79 / 100 |
| 可扩展性 | 80 / 100 |
| 测试覆盖 | 77 / 100 |
| 发布可靠性 | 80 / 100 |

## 审计结论

项目已经具备继续使用和迭代的基础。当前最值得做的不是继续叠新功能，而是把已经做出来的功能稳定化：

- 保持 lint 通过。
- 再拆 `main.ts`。
- 再建立搜索准确率基准。
- 然后推进 Media Search 数据层持久化升级。

只要这四项完成，项目健康度可以从 `84` 提升到 `90+`，后续扩展中文语义、多模态搜索、统一检索框架都会更稳。

## 2026-07-09 自动优化进度 1

本轮已完成：

- 修复 `npm run lint` 的全部问题，当前 lint 已通过。
- `electron/mediaSearchFrameIndex.ts` 的流式 JSONL 读取循环改为不触发 `no-constant-condition`。
- `electron/persistedStatsService.ts` 删除未使用泛型。
- `electron/videoFrameSearchService.ts`、`electron/videoFrameService.ts` 将预留参数改为 `_modelName`。
- `src/components/MediaSearchPanel.tsx` 删除未使用 helper 和未使用 transcript-only 搜索回调。
- Media Search 性能日志保留，但改为不触发 lint 的写法。
- 新增 `src/components/MediaSearchResultsView.tsx`，拆出 Media Search 的 frame grid、video list、路径空状态渲染。
- `MediaSearchPanel.tsx` 从约 1175 行降到约 997 行。

本轮验证：

- `npm.cmd run lint` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

仍需继续：

- 拆 `MediaSearchPanel.tsx` 的 toolbar / query controls。
- 拆 `RemoteTerminalPanel.tsx`。
- 拆 `electron/main.ts` IPC 注册。
- 处理 Vite dynamic/static import 混用 warning。
- 建立 Image Search / Media Search 固定样本准确率测试。

## 2026-07-09 自动优化进度 2

本轮已完成：

- 新增 `src/components/MediaSearchControls.tsx`，拆出 Media Search 顶部 toolbar / query controls。
- `MediaSearchPanel.tsx` 从约 997 行进一步降到约 843 行。
- 新增 `src/components/remote-terminal/SessionTabs.tsx`，Remote Terminal 会话标签改由独立组件渲染。
- 已评估 Vite dynamic/static import warning：根因是 `main.ts` 与 Media/Vector 服务之间存在混合静态/动态 import；直接替换风险较高，后续应结合 IPC 拆分一起处理。

本轮验证：

- `npm.cmd run lint` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

仍需继续：

- 清理 `RemoteTerminalPanel.tsx` 中被替代的旧 inline tab JSX。
- 继续拆 `RemoteTerminalPanel.tsx` 的 credential bar / session overview。
- 拆 `electron/main.ts` IPC 注册。
- 建立 Image Search / Media Search 固定样本准确率测试。
## 2026-07-09 自动优化进度 3

本轮已完成：

- 清理 `RemoteTerminalPanel.tsx` 中已经被 `SessionTabs` 替代的旧 inline tab JSX，移除隐藏死代码和历史乱码关闭按钮。
- 新增 `src/components/remote-terminal/CredentialBar.tsx`，将远程终端密码/密钥短语输入、Session/Protected 记住选项、Forget 操作从主面板拆出。
- 新增 `src/components/remote-terminal/SessionOverview.tsx`，将远程终端会话概览、CPU/MEM/DISK 状态和刷新按钮从主面板拆出。
- `RemoteTerminalPanel.tsx` 从约 1074 行下降到约 998 行，主组件职责进一步收敛到状态编排、IPC 调用和终端容器挂载。

本轮验证：

- `npm.cmd run lint` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过；仍保留 Electron 端 dynamic/static import warning，根因在 Media/Vector 服务与 `main.ts` 的混合依赖，需要继续通过 IPC 注册拆分和服务边界整理处理。

仍需继续：

- 拆分 `electron/main.ts` 的 IPC 注册模块，优先从 AppStorage/ImageSearch/MediaSearch/RemoteTerminal 分组开始。
- 建立 Image Search / Media Search 固定样本准确率测试，避免后续语义搜索和以图搜图回归。
- 继续检查 Prompt 编辑窗口移动卡顿，重点看窗口透明叠加、重绘区域、textarea/编辑器渲染和全局拖拽事件。

## 2026-07-09 自动优化进度 4

本轮已完成：

- 针对 Prompt 编辑窗口移动卡顿，复用现有 `panel-interaction` 事件，在拖动/缩放期间为 `html` 写入 `data-panel-interaction="active"`。
- `window-system.css` 为 `prompt-edit` 面板增加 `contain: layout paint style` 和 `will-change: left, top`，降低编辑窗口移动时的绘制扩散。
- 拖动/缩放期间临时关闭 Prompt 编辑 textarea 的指针命中、caret 绘制和 transition，减少透明窗口 + 大文本区域组合导致的重绘压力；拖动结束后自动恢复。

本轮验证：

- `npm.cmd run lint` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

仍需继续：

- 如果实机仍有撕裂，需要进一步评估是否把 `DraggablePanel` 全局从 `left/top` 移动改为 `transform: translate3d(...)`，该项影响所有窗口，需单独验证。
- 继续拆分 `electron/main.ts` IPC 注册模块，处理 Electron dynamic/static import warning。
- 建立搜索准确率固定样本测试。
## 2026-07-10 优化进度：IPC 拆分、构建警告、固定样本测试

### 本轮已完成

1. `electron/main.ts` IPC 继续拆分：
   - 新增 `electron/imageSearchIpc.ts`，承接 `imageSearch:*` handlers。
   - 新增 `electron/appStorageIpc.ts`，承接 `appStorage:*` handlers。
   - 新增 `electron/duplicateFinderIpc.ts`，承接 `duplicates:*` handlers。
   - `main.ts` 继续收敛为启动、窗口、全局状态与少量未拆 IPC 的协调层。

2. Electron dynamic/static import warning 清理：
   - 将 `main.ts` 内已进入主包的 `ffmpegService`、`videoScanService`、`videoFrameService`、`videoFrameSearchService` 动态 import 改为静态调用。
   - 将 `videoFrameService.ts`、`videoFrameSearchService.ts` 中 `vectorDatabaseService` 的动态 import 改为静态调用。
   - 将 `mediaSearchFrameIndex` 从 `main.ts`、`mediaTaskQueue.ts` 的静态 import 改为按需动态 import，避免与 `videoFrameService` 形成静态循环依赖。
   - 当前 `npm run build:renderer` 已无 Vite dynamic/static import warning，`mediaSearchFrameIndex` 被拆成独立懒加载 chunk。

3. 搜索准确率固定样本测试：
   - 新增 `tests/media-search-fixed-samples.test.cjs`。
   - 使用临时 media-search 目录和临时 vector-db，手工写入 video frame manifest 与 CLIP embedding shard。
   - 覆盖相似帧搜索的固定样本排序、TopK 限制、候选数量统计、自身帧排除。
   - `test:media-search` 已纳入该固定样本测试。

4. 测试暴露并修复的结构问题：
   - `vectorDatabaseService` 原先在模块加载阶段就解析 `app.getPath('userData')`，导致 Node 测试环境和启动路径耦合。
   - 已改为 `JsonLinesStore` 懒解析 `filePath`，只有实际访问数据库时才解析路径。
   - 修正旧测试中 `Clear Cache` 会删除 manifest/frame 的过时预期；当前策略是只清理 disposable cache，保留可搜索数据，避免再次出现“清缓存后数据没了”。

### 验证结果

- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm run test:media-search`：13/13 通过。
- `npm run build:renderer`：通过，未再出现 dynamic/static import warning。

### 剩余建议

1. 继续拆分 `electron/main.ts` 中的 `mediaSearch:*`、`vector:*`、`remoteTerminal:*` IPC，但需分批处理，避免一次性移动大量共享状态。
2. 将 MediaSearch 固定样本扩展为文本搜索、以图搜视频、跨盘符 scope 过滤三组样本。
3. 对启动卡顿继续做懒加载审计，优先检查首屏打开时是否触发视频 manifest、frame stats、embedding stats 的同步读取。

### 新对话交接文档

已新增独立交接文档：

- `docs/current/2026-07-12-optimization-handoff.md`

该文档用于新对话继续接手，包含当前完成项、主要改动文件、验证结果、剩余优化项和下一轮建议执行顺序。

## 2026-07-10 后续优化进度：MediaSearch IPC 全量迁出

### 本轮已完成

1. `electron/main.ts` 中的 `mediaSearch:*` 与 `videoIndex:*` IPC 已全部迁出到 `electron/mediaSearchIpc.ts`。
2. 新增 `electron/mediaSearchImageCache.ts`，集中处理 MediaSearch frame/thumbnail dataUrl 缓存。
3. 新增 `electron/mediaSearchScope.ts`，集中处理 scanPaths 归一化和路径范围判断。
4. 新增 `electron/mediaSearchQueryImage.ts`，集中处理查询图片扩展名校验。
5. 新增 `electron/mediaFrameEmbeddingState.ts`，集中处理 frame embedding build 完成后的 frame index 自动重建状态。
6. `electron/main.ts` 从本轮开始前约 2478 行继续降到约 1771 行。

### 验证结果

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run test:media-search`：13/13 通过。
- `npm run build:renderer`：通过，未出现 Vite dynamic/static import warning。

### 下一步

1. 继续拆分 `vector:*` IPC，优先从模型状态/下载/进度/索引状态等低耦合 handler 开始。
2. 再拆 `remoteTerminal:*` IPC。
3. 继续扩展 MediaSearch 固定样本测试，优先补文本搜索、以图搜视频、scope 过滤样本。

## 2026-07-10 后续优化进度：Vector IPC 全量迁出

### 本轮已完成

1. 新增 `electron/vectorIpc.ts`，将 `electron/main.ts` 中全部 `vector:*` IPC 迁出。
2. `vectorIpc.ts` 现在统一负责模型状态、模型下载/取消/删除、embedding build、向量索引构建、layered image search、semantic image search、feature extraction、vector settings、vector maintenance。
3. Vector 初始化和事件 wiring 也迁入 `registerVectorIpc()`，避免 `main.ts` 继续持有 Vector/Rerank 服务细节。
4. `electron/main.ts` 从 MediaSearch 迁出后的约 1771 行继续降到约 1564 行。
5. 当前 `main.ts` 中已无 `ipcMain.handle('vector:*')` 残留，Vector IPC 已形成独立边界。

### 验证结果

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：13/13 通过。
- `npm.cmd run build:renderer`：通过，未出现 Vite dynamic/static import warning。

### 健康度变化

- 结构健康度：继续提升。`main.ts` 已完成 ImageSearch、AppStorage、DuplicateFinder、MediaSearch、Vector 的 IPC 分离。
- 逻辑风险：低。本轮主要为等价迁移，保留原 IPC channel、参数校验、服务调用和进度事件。
- 扩展性：提升。后续 Vector 搜索准确率优化、模型下载策略和 embedding build 策略可以在 `vectorIpc.ts` / service 层继续演进，不再扩大 `main.ts`。

### 剩余建议

1. 下一轮优先拆 `remoteTerminal:*` IPC，建议分为 profiles、connection、sftp、transfer 四组逐步迁出。
2. 搜索准确率固定样本仍需继续扩充，尤其是 ImageSearch / MediaSearch / Vector 的跨盘符、scope、索引重建场景。
3. prompt 编辑窗口移动卡顿仍需单独排查，重点关注透明窗口、置顶窗口、拖拽时重绘、Chromium compositor latency 日志。

## 2026-07-10 后续优化进度：RemoteTerminal profiles/credentials IPC 子集迁出

### 本轮已完成

1. 新增 `electron/remoteTerminalProfileIpc.ts`。
2. 将 `remoteTerminal:listProfiles`、`remoteTerminal:saveProfile`、`remoteTerminal:deleteProfile`、`remoteTerminal:credentialStatus`、`remoteTerminal:saveCredential`、`remoteTerminal:deleteCredential` 从 `main.ts` 迁出。
3. `electron/main.ts` 从约 1564 行继续降到约 1511 行。

### 验证结果

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：13/13 通过。
- `npm.cmd run build:renderer`：通过，未出现 Vite dynamic/static import warning。

### 剩余建议

1. RemoteTerminal 继续按 SFTP、transfer、connection 三个模块拆分。
2. 拆分完成后，`main.ts` 应只保留窗口生命周期、全局热键、显示器状态、少量 legacy file-manager handler 和各 IPC 模块注册。
