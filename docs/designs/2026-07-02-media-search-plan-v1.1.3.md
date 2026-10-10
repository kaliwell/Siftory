# FloatingClock — MediaSearch 多模态视频搜索新增功能方案

> **版本**: 1.1.3  
> **类型**: 新增功能独立技术方案  
> **所属项目**: Floating Clock Electron  
> **语言**: TypeScript / Electron / React  
> **平台**: Windows  
> **生成日期**: 2026-07-02  
> **适配更新**: 2026-07-02  
> **说明**: 本文档为独立新增功能方案，不合并进原《FloatingClock 项目技术文档》。原项目文档保持原样，本文件仅描述新增 MediaSearch 多模态视频搜索、视频处理、声音转文字、字幕解析、OCR、本地多模态融合搜索与功能拆分实施计划、现有功能复用对比与复用审计。外部 LLM API 辅助理解不纳入当前版本，仅作为后续分支规划。v1.1.3 已按当前项目代码基线进行适配优化：现有 ImageSearch / Vector / Model / FileManager / RemoteTerminal 主链路已完成 lint 清零和打包验证，MediaSearch 后续落地必须复用这些稳定边界，不再按理想化空白项目方案推进。

> **架构关系更新（2026-08-11）**：本文继续负责视频抽帧、字幕、帧向量和多模态融合专项；视频与图片共享的来源身份、Discovery Catalog、任务阶段、NAS/SFTP 数据源和统一搜索结果，以[本地与 NAS AI 素材发现统一架构方案](2026-08-11-local-nas-ai-asset-discovery-architecture.md)为准。

---

## 目录

1. [新增功能定位](#1-新增功能定位)
2. [设计原则](#2-设计原则)
3. [功能拆分计划](#3-功能拆分计划)
4. [新增模块结构](#4-新增模块结构)
5. [MediaSearch 总体架构](#5-mediasearch-总体架构)
6. [视频画面处理流程](#6-视频画面处理流程)
7. [抽帧策略](#7-抽帧策略)
8. [抽帧图片压缩方案](#8-抽帧图片压缩方案)
9. [视频抽帧去重方案](#9-视频抽帧去重方案)
10. [以图搜视频方案](#10-以图搜视频方案)
11. [文本语义搜视频方案](#11-文本语义搜视频方案)
12. [声音转文字方案](#12-声音转文字方案)
13. [字幕解析方案](#13-字幕解析方案)
14. [视频 OCR 方案](#14-视频-ocr-方案)
15. [本地索引与片段理解方案](#15-本地索引与片段理解方案)
16. [多模态融合搜索](#16-多模态融合搜索)
17. [缓存目录设计](#17-缓存目录设计)
18. [增量索引策略](#18-增量索引策略)
19. [后台任务调度](#19-后台任务调度)
20. [IPC 接口设计](#20-ipc-接口设计)
21. [UI 设计](#21-ui-设计)
22. [安全与隐私设计](#22-安全与隐私设计)
23. [开发阶段规划](#23-开发阶段规划)
24. [测试规划](#24-测试规划)
25. [最终推荐路线](#25-最终推荐路线)
26. [后续分支：外部 LLM API 辅助理解](#26-后续分支外部-llm-api-辅助理解)
27. [v1.1.3 当前项目适配优化](#27-v113-当前项目适配优化)

---

## 1. 新增功能定位

MediaSearch 是 FloatingClock Electron 的新增多模态媒体搜索系统，目标是把本地视频素材转化为可搜索、可定位、可解释的视频片段资产。

新增能力包括：

| 能力 | 说明 |
|---|---|
| 以图搜视频 | 输入图片或截图，返回本地视频中相似画面的时间点 |
| 文本语义搜视频 | 输入自然语言，搜索画面语义相近的视频片段 |
| 视频抽帧理解 | 将视频拆成代表帧和片段，建立视觉索引 |
| 声音转文字 | 提取视频音轨并转写为带时间戳文本 |
| 字幕解析 | 解析 `.srt`、`.ass`、`.vtt` 字幕文件并建立索引 |
| 视频 OCR | 识别硬字幕、产品文字、屏幕文字、包装文字 |
| 多模态融合搜索 | 融合画面、声音、字幕、OCR 和文件名等本地索引结果 |

核心思路：

```txt
视频 → 抽帧 → 压缩 → 去重 → CLIP/DINO 向量化 → 本地向量库检索
视频 → 音频提取 → ASR 转文字 → Transcript 索引
视频 → 字幕解析 / OCR → 文本索引
检索结果 → 本地融合排序 → 返回可定位的视频片段
```

---

## 2. 设计原则

MediaSearch 必须沿用现有 FloatingClock Electron 的安全架构。

```txt
Renderer React：
只负责 UI、状态、展示和用户操作。

Preload：
通过 contextBridge 暴露受控 API。

Main Process：
负责 IPC 注册、任务调度、路径校验、文件访问、ffmpeg 调用和模型任务管理。

Worker / Child Process：
负责视频抽帧、CLIP/DINO 向量、ASR、OCR、批量索引等重任务。

shared/ipc-contract.ts：
统一定义主进程和渲染进程之间的类型契约。

native/：
后期可承接高性能文件扫描、图像 hash、批量缩放等能力。
```

硬性规则：

```txt
Renderer 不直接读取本地视频。
Renderer 不直接调用 ffmpeg。
Renderer 不直接跑 ASR / OCR / CLIP。
Renderer 不直接访问任意本地路径。
所有本地能力必须走 preload API + IPC + Main 校验。
所有 IPC 入参必须 unknown → guard 校验 → 业务逻辑。
```

---

## 3. 功能拆分计划

MediaSearch 必须在设计阶段提前拆分功能边界，避免把视频处理、搜索、转写、OCR、缓存、任务调度和 UI 全部集中在一个服务、一组接口或一个面板里。拆分目标是：每个能力可以独立开发、独立测试、独立开关、独立回滚。

### 3.1 拆分目标

| 目标 | 要求 |
|---|---|
| 功能边界清晰 | 视频画面、声音文字、字幕、OCR、融合搜索分别独立成模块 |
| 开发阶段可控 | 每个阶段只交付一个主能力，不把多个重功能塞进同一阶段 |
| UI 不拥挤 | 综合搜索只做入口和结果整合，具体能力分到独立 Tab / Panel |
| 后台任务可调度 | 抽帧、向量、ASR、OCR、缓存清理都使用独立任务类型 |
| 测试可拆分 | 每个模块都有自己的 guard、service、index、worker、test |
| 后续可扩展 | 外部 LLM API、Caption、大模型视频理解必须作为后续分支接入 |

### 3.2 UI 层拆分

`MediaSearchPanel` 只作为统一入口，不承载所有细节逻辑。具体功能拆成独立页面或 Tab：

```txt
MediaSearchPanel
├── 综合搜索 Tab
│   ├── 统一搜索框
│   ├── 来源过滤
│   ├── 融合结果列表
│   └── 时间线预览
│
├── 以图搜视频 Tab
│   ├── 图片选择 / 拖入
│   ├── 视觉检索参数
│   └── 相似片段结果
│
├── 文本搜画面 Tab
│   ├── 文本查询
│   ├── CLIP 文本向量检索
│   └── 画面语义结果
│
├── 声音 / 字幕 Tab
│   ├── ASR 任务管理
│   ├── 字幕导入
│   ├── Transcript 查看
│   └── 文本片段搜索
│
├── OCR Tab
│   ├── OCR 任务配置
│   ├── 识别区域设置
│   ├── OCR 文本结果
│   └── 低置信度结果过滤
│
└── 任务 / 缓存 Tab
    ├── 后台任务队列
    ├── 索引状态
    ├── 缓存体积
    └── 清理策略
```

UI 禁止把所有配置和结果堆在一个长面板中。默认只展示常用入口，高级能力放入对应 Tab 或设置区域。

### 3.3 服务层拆分

| 功能域 | 主服务 | 说明 |
|---|---|---|
| 视频扫描 | `videoScanService.ts` | 只负责视频发现和元数据读取 |
| 抽帧与压缩 | `videoFrameExtractService.ts` / `videoFrameCompressionService.ts` | 只负责 ffmpeg 抽帧、缩放、转码 |
| 帧去重 | `videoFrameDedupService.ts` | 只负责 dHash / pHash 与代表帧选择 |
| 视觉索引 | `videoIndexService.ts` | 只负责帧向量、片段向量和索引写入 |
| 视觉搜索 | `videoSearchService.ts` | 只负责以图搜视频和文本搜画面 |
| 声音转文字 | `audioExtractService.ts` / `speechTranscriptionService.ts` | 只负责音频提取、切片、ASR |
| 字幕解析 | `subtitleImportService.ts` | 只负责 `.srt` / `.ass` / `.vtt` 解析 |
| OCR | `videoOcrService.ts` | 只负责 OCR 裁剪、识别、去重合并 |
| 融合排序 | `mediaSearchFusionService.ts` | 只负责多来源分数融合 |
| 任务调度 | `mediaTaskQueue.ts` | 只负责任务排队、优先级、取消、暂停 |
| 缓存维护 | `mediaCacheService.ts` | 只负责缓存上限、清理、失效判断 |

`mediaSearchService.ts` 只做门面层，不允许变成几千行的巨型服务。实际业务必须分发到具体服务。

### 3.4 IPC 拆分

IPC 通道按能力前缀拆分，避免所有功能集中到一个 `mediaSearch:*` 通道。

```txt
mediaSearch:*        综合搜索、融合结果、索引状态
videoSearch:*        视频画面搜索、以图搜视频、文本搜画面
videoIndex:*         视频扫描、抽帧索引、片段索引
transcript:*         ASR、字幕、声音文字搜索
videoOcr:*           OCR 任务、OCR 文本搜索
mediaTask:*          任务队列、暂停、取消、优先级
mediaCache:*         缓存统计、缓存清理、索引维护
```

每组 IPC 都要有对应 guard 文件或校验函数。禁止一个接口同时接收过多混合参数，复杂操作要拆成多个明确接口。

### 3.5 数据与索引拆分

不同来源的数据必须分表 / 分文件 / 分索引保存，不要放进一个大表。

```txt
video-files.db             视频文件元数据
video-frames.db            代表帧信息
video-segments.db          视频片段信息
video-frame-vectors.bin    帧向量
video-segment-vectors.bin  片段向量
transcript-chunks.db       ASR / 字幕文本片段
transcript-vectors.bin     文本向量
video-ocr-chunks.db        OCR 文本片段
video-ocr-vectors.bin      OCR 文本向量
media-task-state.db        后台任务状态
cache-manifest.json        缓存清单
```

这样可以做到：视频索引重建不影响转写文本，OCR 重建不影响视觉向量，字幕变化只重建字幕索引。

### 3.6 任务拆分

后台任务按类型拆分，任务队列只做调度，不直接写业务逻辑。

```txt
scan-video-files       扫描视频文件
read-video-metadata    读取视频元数据
extract-video-frames   抽帧
compress-frame         压缩帧
dedup-frame            帧去重
build-visual-vector    生成视觉向量
build-video-segment    聚合视频片段
extract-audio          提取音频
transcribe-audio       声音转文字
import-subtitle        导入字幕
run-video-ocr          OCR 识别
merge-ocr-text         OCR 文本合并
cleanup-cache          缓存清理
```

每个任务都应支持：进度、取消、失败重试、错误记录、任务类型、所属 videoId。

### 3.7 开发阶段拆分

开发阶段必须按最小闭环拆分，不要在一个阶段同时做多个重能力。

```txt
阶段 A：视频扫描 + 封面 + 缩略图
阶段 B：抽帧压缩 + dHash/pHash 去重
阶段 C：CLIP 以图搜视频
阶段 D：CLIP 文本搜画面
阶段 E：字幕解析与字幕搜索
阶段 F：ASR 声音转文字
阶段 G：OCR 硬字幕 / 画面文字
阶段 H：本地多模态融合搜索
阶段 I：后续分支能力接入
```

每个阶段必须单独验收，不能因为后续能力未完成而阻塞前面能力上线。

### 3.8 不允许集中化的内容

```txt
不允许把所有视频处理写进一个 videoSearchService.ts。
不允许把所有 IPC 塞进一个 mediaSearch:invoke。
不允许把所有 UI 放进一个超长 MediaSearchPanel。
不允许把视觉、声音、字幕、OCR 数据塞进一张表。
不允许默认一键执行抽帧、ASR、OCR、融合搜索全部任务。
不允许让外部 LLM API 进入当前主流程。
不允许让缓存清理、任务调度和索引写入互相耦合。
```

主流程只保留本地轻量索引能力。深度能力必须按需触发，后续分支能力必须独立开关。


### 3.9 现有功能复用对比与复用审计

本节用于对比原项目已有能力与 MediaSearch 新增能力，提前审计哪些功能可以直接复用、哪些功能只能改造复用、哪些功能必须新建，避免重复造轮子，也避免把原有 ImageSearch、DuplicateFinder、FileManager 等模块强行改成视频系统导致耦合过重。

#### 3.9.1 复用分级标准

| 复用级别 | 含义 | 处理方式 |
|---|---|---|
| A 级：直接复用 | 原功能职责与 MediaSearch 需求高度一致 | 通过现有服务、工具函数、组件或类型直接调用 |
| B 级：改造复用 | 原功能方向一致，但输入、数据结构或任务粒度不同 | 保留原设计模式，新增 MediaSearch 专用封装 |
| C 级：参考复用 | 原功能不能直接调用，但架构思路、UI 模式或测试方式可参考 | 只复用设计经验，不复用业务代码 |
| D 级：不建议复用 | 职责不匹配或强行复用会造成耦合 | 新建模块，不进入原模块主流程 |

#### 3.9.2 可直接复用功能

| 原有模块 / 能力 | 复用级别 | MediaSearch 用途 | 复用方式 |
|---|---:|---|---|
| `shared/ipc-contract.ts` | A | 统一定义 MediaSearch、VideoSearch、Transcript、OCR IPC 类型 | 扩展接口，不另建独立通信体系 |
| `preload.ts` + `contextBridge` | A | 暴露安全的媒体搜索 API | 按现有安全桥模式新增 `mediaSearch` API |
| `ipcValidation.ts` | A | 校验 topK、mode、文本长度、配置对象等通用入参 | 复用通用校验函数，新增媒体专用校验 |
| `pathGuards.ts` | A | 视频目录、字幕文件、缓存路径、打开文件位置校验 | 直接复用路径规范化、防遍历、合法性校验 |
| `embeddingService.ts` | A | 生成查询图片、视频代表帧、文本查询的 embedding | 复用 CLIP / DINO 调度能力 |
| `clipEmbeddingChild.ts` | A | 以图搜视频、文本搜视频画面 | 复用 CLIP image/text embedding 子进程 |
| `dinoEmbeddingChild.ts` | A | 视觉相似、片段聚类、相似帧辅助排序 | 复用 DINO 图像特征子进程 |
| `vectorDatabaseService.ts` | A | 保存视频帧向量、片段向量、转写文本向量、OCR 文本向量 | 扩展 namespace / collection，不混用原图像表 |
| `vectorIndexService.ts` | A | 建立视频帧/片段 TopK 检索索引 | 复用向量索引能力，新增 media index 类型 |
| `vectorMaintenanceService.ts` | A | 索引压缩、清理、重建、失效维护 | 增加 video / transcript / ocr 维护入口 |
| `semanticSearchService.ts` | A | 文本搜视频画面、文本搜转写片段 | 复用文本语义检索流程 |
| `rerankService.ts` | A | 视频片段二次排序、相邻片段合并前排序 | 增加 MediaSearch 权重，不改原图片排序逻辑 |
| `modelService.ts` | A | 管理 CLIP / DINO 模型下载和缓存 | 扩展模型 manifest，后续可接 ASR 模型 |
| `ocrService.ts` | C | 对视频裁剪帧做 OCR 的接口思路 | 当前只是 OCR stub，占位逻辑可参考，真实视频 OCR 必须新建能力或接入 OCR 引擎 |
| `useStore.ts` / `useAutoSaveSettings.ts` | B | 保存抽帧模式、缓存上限、ASR/OCR 开关 | 按现有 Zustand + settings writer 模式新增 MediaSearch 设置，不使用不存在的 `settingsStore.ts` |
| `SearchProgressBar.tsx` | A | 展示扫描、抽帧、向量、ASR、OCR 进度 | 复用进度条组件 |
| `VectorMaintenanceBar.tsx` | A/B | 展示视频向量索引维护状态 | 复用 UI 模式，新增媒体索引状态 |
| `ImageSearchResultGrid.tsx` 的布局思路 | B | 视频结果网格 | 不直接混用，抽象公共 ResultGrid 或新建 VideoSearchResultGrid |
| `TabBar.tsx` / `DraggablePanel.tsx` | A | MediaSearch 面板集成到现有多面板系统 | 直接接入现有面板系统 |
| `useStore.ts` / Zustand 模式 | B | 保存 MediaSearch UI 状态、任务状态、筛选条件 | 新增 slice，不把媒体状态塞进图片搜索状态 |
| Node.js Test Runner 测试体系 | A | 新增 video / transcript / ocr 测试 | 按现有 `.test.cjs` 结构扩展测试 |

#### 3.9.3 可改造复用功能

| 原有模块 / 能力 | 复用级别 | 可复用部分 | 必须新增 / 改造部分 |
|---|---:|---|---|
| `imageSearchService.ts` | B | 搜索流程、状态回调、TopK 召回、结果结构设计思路 | 不直接承载视频逻辑，新建 `videoSearchService.ts` |
| `imageSearchGuards.ts` | B | 搜索模式、路径、数值范围校验模式 | 新建 `mediaSearchGuards.ts`、`videoSearchGuards.ts` |
| `ImageSearchPanel.tsx` | B | 搜索控件布局、结果展示、状态栏交互 | 新建 `VideoSearchPanel.tsx` / `MediaSearchPanel.tsx` |
| `ImageSearchControls.tsx` | B | mode、topK、threshold 控件模式 | 新增视频抽帧间隔、片段长度、来源过滤控件 |
| `ImageSearchStatusBar.tsx` | B | 搜索状态展示方式 | 新增视频索引、ASR、OCR、缓存状态 |
| `DuplicateFinderService.ts` | B | 文件扫描、hash 比对、进度回调、Worker 思路 | 视频帧去重必须新增 dHash / pHash，不使用文件名 fast 判重 |
| `duplicateFinderWorker.ts` | B | Worker 任务结构、取消、进度 | 新建 `videoSearchWorker.ts` / `audioAnalysisWorker.ts` |
| `appStorageService.ts` | B | 目录扫描、体积统计、缓存分析 | 新建 `mediaCacheService.ts`，不能把媒体缓存混进 AppStorage 业务 |
| `fileManagerIpc.ts` | B | 打开文件、复制路径、在资源管理器中显示 | 新增 `openMediaAtTime`，不可让 Renderer 直接拼接路径 |
| 文件管理器缩略图 UI | B | 缩略图展示、文件列表、右键菜单 | 视频缩略图生成逻辑必须独立，由 ffmpeg + cache 控制 |
| `native/fast_scanner.cc` | B/C | 高性能扫描、未来可扩展批量 hash / resize | 第一阶段用 ffmpeg 和 TS 服务，后续再考虑下沉 native |
| `stb_image` / `stb_image_resize2` | B/C | 图片解码、缩放能力 | 视频抽帧仍以 ffmpeg 为主，STB 可用于后续帧 hash 预处理 |
| `vectorTypes.ts` | B | 向量类型、索引元信息结构 | 新增 `videoTypes.ts` / `mediaTypes.ts`，避免视频类型挤进图片类型 |
| `RecentManifestBar.tsx` | B | 最近索引清单展示 | 可扩展为视频最近索引清单 |

#### 3.9.4 不建议直接复用的内容

| 原有能力 | 不建议复用原因 | 正确处理 |
|---|---|---|
| ImageSearch 的 `fast = 文件名 + 路径文本匹配` | 不能判断重复图像或重复视频帧 | 只做候选召回，重复判断必须用 hash / pHash / dHash |
| `ImageSearchPanel.tsx` 作为视频搜索主面板 | 会导致 UI 过长、状态混乱、图片/视频逻辑耦合 | 新建 MediaSearch / VideoSearch 面板 |
| `imageSearchService.ts` 承载视频抽帧、ASR、OCR | 会变成巨型服务，破坏功能边界 | 新建专用服务并由 mediaSearchService 门面调度 |
| DuplicateFinder 的文件 hash 作为视觉去重依据 | 文件 hash 只能识别完全相同文件，不能识别压缩、缩放、转码后的相似帧 | 新增感知哈希与时间窗口去重 |
| FileManager 直接负责视频缓存生成 | 文件管理器职责是浏览文件，不应承担媒体索引业务 | 新建 videoThumbnailService / mediaCacheService |
| RemoteTerminal / SFTP 模块 | 与本地视频索引无直接关系 | 不复用，仅保持架构隔离 |
| Calculator / Edit / Prompts 面板 | 与 MediaSearch 主流程无关 | 不进入复用范围 |
| 外部 LLM API 相关设计 | 当前版本明确不纳入主流程 | 只保留后续分支章节，不参与当前复用审计 |

#### 3.9.5 新建模块必要性审计

以下模块必须新建，不能强行塞进原有模块：

| 新模块 | 必须新建原因 |
|---|---|
| `ffmpegService.ts` | 原项目没有视频解码、抽帧、音频提取封装 |
| `videoScanService.ts` | 视频文件类型、元数据、时长、编码与图片扫描不同 |
| `videoFrameExtractService.ts` | 视频抽帧需要 ffmpeg、时间戳和任务调度 |
| `videoFrameCompressionService.ts` | 抽帧后需按 thumbnail / embeddingFrame / ocrCrop 三种用途压缩 |
| `videoFrameDedupService.ts` | 视频连续帧去重需要时间窗口 + dHash / pHash |
| `videoIndexService.ts` | 视频帧、片段、向量和图片索引结构不同 |
| `audioExtractService.ts` | 需要检测音轨、提取音频、转码 16kHz mono |
| `speechTranscriptionService.ts` | ASR 是独立重任务，不能混进图像模型服务 |
| `subtitleImportService.ts` | 字幕解析有独立格式和时间轴规则 |
| `transcriptIndexService.ts` | 转写文本片段索引不同于图片向量索引 |
| `videoOcrService.ts` | 视频 OCR 需要裁剪区域、重复合并、时间轴归并 |
| `mediaTaskQueue.ts` | 抽帧、ASR、OCR、向量任务必须统一调度 |
| `mediaCacheService.ts` | 媒体缓存体积大，需独立上限和清理策略 |
| `mediaSearchFusionService.ts` | 多来源分数融合不同于单一图片搜索排序 |

#### 3.9.6 复用优先级路线

实现顺序建议按复用价值排序：

```txt
第一优先级：
pathGuards.ts
ipcValidation.ts
shared/ipc-contract.ts
preload.ts
embeddingService.ts
clipEmbeddingChild.ts
vectorDatabaseService.ts
vectorIndexService.ts
rerankService.ts

第二优先级：
dinoEmbeddingChild.ts
semanticSearchService.ts
vectorMaintenanceService.ts
modelService.ts
SearchProgressBar.tsx
ImageSearchResultGrid.tsx 的布局思路
ImageSearchControls.tsx 的参数控件思路

第三优先级：
duplicateFinderWorker.ts 的任务模式
appStorageService.ts 的缓存统计思路
fileManagerIpc.ts 的打开文件 / 复制路径 / 资源管理器定位能力
ocrService.ts 的 OCR 引擎调用能力

第四优先级：
native/fast_scanner.cc
stb_image / stb_image_resize2
RecentManifestBar.tsx
VectorMaintenanceBar.tsx
```

#### 3.9.7 复用风险清单

| 风险 | 说明 | 规避措施 |
|---|---|---|
| 图片索引和视频索引混表 | 会导致重建、清理、迁移困难 | 使用独立 collection / db / manifest |
| 图片搜索 UI 直接扩展成视频 UI | 面板变重，状态不可维护 | 新建视频面板，共享小组件 |
| fast 模式误用为去重 | 文件名相似不等于视觉重复 | fast 只做候选，去重用 hash / pHash / dHash |
| ASR/OCR 默认全量运行 | CPU/GPU/磁盘压力过高 | 按需触发，任务队列限并发 |
| 复用 Worker 时任务类型混乱 | 进度、取消、错误难以追踪 | 每类重任务独立 taskType |
| 复用向量库但不分 namespace | 图片、视频、文本向量相互污染 | collection 按 image/video/transcript/ocr 拆分 |
| 复用 FileManager 路径能力时绕过校验 | 可能引入任意文件访问风险 | 所有路径仍走 Main + guard |
| 缓存清理和索引写入耦合 | 清理时可能删掉正在使用的文件 | mediaCacheService 只按 manifest 和 task lock 清理 |

#### 3.9.8 审计结论

MediaSearch 应优先复用原项目的安全架构、IPC 类型契约、CLIP/DINO embedding、向量数据库、向量索引、rerank、OCR 引擎调用、测试体系和部分 UI 组件模式。视频抽帧、帧压缩、帧去重、音频提取、ASR、字幕解析、视频 OCR 时间轴合并、媒体任务队列、媒体缓存维护必须新建专用模块。

最终原则：

```txt
能复用底层能力，不复用错误职责。
能复用设计模式，不强行复用业务服务。
能复用 UI 小组件，不复用超长面板。
能复用向量库能力，不混用索引数据。
能复用安全校验体系，不绕过 Main / Preload / IPC。
```


## 4. 新增模块结构

### 4.1 Main Process 新增模块

```txt
electron/
├── mediaSearchService.ts              # 多模态搜索统一入口
├── mediaTaskQueue.ts                  # 视频/音频/OCR/向量任务队列
├── mediaSearchGuards.ts               # 参数校验
├── mediaSearchFusionService.ts        # 多模态融合排序
│
├── videoSearchService.ts              # 视频画面搜索主服务
├── videoScanService.ts                # 视频扫描与元数据读取
├── videoFrameExtractService.ts        # 视频抽帧
├── videoFrameCompressionService.ts    # 抽帧压缩
├── videoFrameDedupService.ts          # dHash/pHash 帧去重
├── videoThumbnailService.ts           # 缩略图缓存
├── videoIndexService.ts               # 视频帧/片段索引
├── videoSearchWorker.ts               # 视频处理 Worker
│
├── ffmpegService.ts                   # ffmpeg / ffprobe 封装
│
├── audioExtractService.ts             # 音频提取
├── speechTranscriptionService.ts      # ASR 声音转文字
├── transcriptIndexService.ts          # 转写文本索引
├── transcriptSearchService.ts         # 声音文字搜索
├── audioAnalysisWorker.ts             # 音频分析 Worker
│
├── subtitleImportService.ts           # srt / ass / vtt 字幕导入
│
├── videoOcrService.ts                 # 视频 OCR
├── videoOcrIndexService.ts            # OCR 文本索引
├── videoOcrWorker.ts                  # OCR Worker

```

### 4.2 Renderer UI 新增组件

```txt
src/components/
├── MediaSearchPanel.tsx
├── VideoSearchPanel.tsx
├── VideoSearchControls.tsx
├── VideoSearchResultGrid.tsx
├── VideoTimelinePreview.tsx
├── TranscriptPanel.tsx
├── TranscriptTimeline.tsx
├── VideoOcrPanel.tsx
└── MediaSearchStatusBar.tsx
```

### 4.3 Shared 新增类型文件

```txt
shared/
├── mediaTypes.ts
├── videoTypes.ts
├── transcriptTypes.ts
├── videoOcrTypes.ts
└── ipc-contract.ts
```

---

## 5. MediaSearch 总体架构

```txt
MediaSearch
│
├─ VideoSearch
│  ├─ 视频扫描
│  ├─ 视频抽帧
│  ├─ 抽帧压缩
│  ├─ 帧去重
│  ├─ CLIP / DINO 向量化
│  ├─ 以图搜视频
│  └─ 文本搜视频画面
│
├─ TranscriptSearch
│  ├─ 音轨检测
│  ├─ 音频提取
│  ├─ 音频切片
│  ├─ ASR 声音转文字
│  ├─ 转写文本索引
│  └─ 搜索视频说过的话
│
├─ SubtitleSearch
│  ├─ srt / ass / vtt 解析
│  ├─ 字幕时间轴转换
│  ├─ 字幕文本索引
│  └─ 字幕搜索
│
├─ VideoOcrSearch
│  ├─ 视频硬字幕 OCR
│  ├─ 产品文字 OCR
│  ├─ 屏幕文字 OCR
│  ├─ OCR 去重合并
│  └─ OCR 文本索引
│
└─ FusionSearch
   ├─ visualScore
   ├─ speechScore
   ├─ subtitleScore
   ├─ ocrScore
   ├─ metadataScore
   └─ 多模态融合排序
```

---

## 6. 视频画面处理流程

```txt
选择目录
↓
扫描视频文件
↓
读取元数据：path、size、duration、width、height、fps、codec、mtime
↓
生成封面缩略图
↓
按策略抽帧
↓
抽帧时直接压缩，不保存原始大图
↓
计算 dHash / pHash
↓
去掉连续重复帧
↓
保留代表帧
↓
生成 CLIP / DINO 向量
↓
按时间窗口聚合成 VideoSegment
↓
写入本地向量索引
↓
支持以图搜视频 / 文本搜画面
```

---

## 7. 抽帧策略

默认不做高频抽帧。抽帧分为四档：

```ts
export const VIDEO_FRAME_POLICY = {
  fast: {
    intervalSec: 10,
    maxFramesPerVideo: 300,
  },
  balanced: {
    intervalSec: 5,
    maxFramesPerVideo: 800,
  },
  recall: {
    intervalSec: 2,
    maxFramesPerVideo: 1800,
  },
  deep: {
    intervalSec: 1,
    maxFramesPerVideo: 3600,
  },
};
```

默认使用 `balanced`：每 5 秒 1 帧，每个视频最多 800 帧。

原因：

```txt
1. 压力可控；
2. 足够完成大部分以图搜视频；
3. 不会生成过多缩略图；
4. 不会让 CLIP 向量数量爆炸；
5. 后续可以对指定视频手动深度分析。
```

---

## 8. 抽帧图片压缩方案

抽帧图片不能保存原始 1080p / 4K 大图，必须在 ffmpeg 抽帧阶段直接缩放、压缩、转码。

抽帧图分三种用途：

```txt
thumbnail：
UI 预览缩略图。

embeddingFrame：
给 CLIP / DINO 生成向量的分析图。

ocrCrop：
给 OCR 识别字幕 / 产品文字的裁剪图。
```

推荐规格：

```txt
thumbnail：
WebP，长边 320px，quality 58，长期保留。

embeddingFrame：
WebP，长边 384px；4K 视频可提高到 512px；quality 72。
生成向量后删除，只保留向量。

ocrCrop：
裁剪底部 25% - 35% 字幕区域。
最大宽度 960 - 1280px。
quality 82。
OCR 完成后默认删除，只保留 OCR 文本。
```

根据分辨率动态调整：

```txt
720p 以下：embedding 长边 320px
1080p：embedding 长边 384px
2K：embedding 长边 448px
4K / 8K：embedding 长边 512px
```

核心规则：

```txt
不要保存原始帧。
不要先导出 PNG 再压缩。
不要所有用途共用同一张图。
embeddingFrame 用完即删。
thumbnail 长期保留。
ocrCrop 默认不长期保留。
```

---

## 9. 视频抽帧去重方案

不使用 `fast = 文件名 + 路径文本匹配` 作为最终去重依据。

去重分三层：

```txt
完全重复：
size + SHA/BLAKE3，用于完全相同文件。

视觉重复：
dHash / pHash，用于压缩、改尺寸、转格式后仍然相似的图片。

语义相似：
CLIP / DINO，用于相似素材推荐，不用于自动删除。
```

视频连续帧去重流程：

```txt
抽出一帧
↓
缩放压缩
↓
计算 dHash / pHash
↓
与同一视频最近 30 秒内代表帧比较
↓
Hamming Distance <= 5：高度重复，跳过
↓
Hamming Distance <= 10：疑似重复，可跳过或降权
↓
不重复：保留为代表帧
↓
生成 thumbnail / 向量 / OCR 候选
```

推荐策略：

```ts
export const FRAME_DEDUP_POLICY = {
  enabled: true,
  hash: ['dHash', 'pHash'],
  compareWindowSec: 30,
  exactDuplicateThreshold: 5,
  nearDuplicateThreshold: 10,
  keepFirstFrame: true,
  keepSceneChangedFrame: true,
  skipEmbeddingForDuplicate: true,
  skipOcrForDuplicate: true,
};
```

---

## 10. 以图搜视频方案

以图搜视频流程：

```txt
用户选择图片 / 拖入图片
↓
生成 query image embedding
↓
搜索 video frame vectors / video segment vectors
↓
召回 TopK 视频帧
↓
按 videoId + segmentId 聚合
↓
rerank
↓
返回视频片段、时间点、缩略图、分数
```

评分建议：

```ts
finalScore =
  maxFrameScore * 0.65 +
  segmentCentroidScore * 0.25 +
  temporalDensityScore * 0.10;
```

结果不是返回整条视频，而是返回片段：

```ts
export interface VideoSearchResult {
  videoId: string;
  path: string;
  name: string;
  durationMs: number;
  bestTimestampMs: number;
  segmentStartMs: number;
  segmentEndMs: number;
  thumbnailPath: string;
  score: number;
  matchedFrames: Array<{
    timestampMs: number;
    thumbnailPath: string;
    score: number;
  }>;
  reason: 'image-vector' | 'text-vector' | 'metadata' | 'hybrid';
}
```

---

## 11. 文本语义搜视频方案

文本搜视频流程：

```txt
用户输入自然语言
↓
CLIP text encoder 生成 textVector
↓
搜索视频帧 / 视频片段的 CLIP image vectors
↓
按 videoId / segmentId 聚合
↓
结合 metadata / OCR / ASR / subtitle 做混合排序
↓
返回相关视频片段
```

适合搜索的通用查询类型：

```txt
场景描述 + 主体类别 + 关键动作
物体类别 + 使用状态 + 环境特征
语音关键词 + 画面文字 + 文件元数据
```

---

## 12. 声音转文字方案

ASR 不默认全库自动运行，只能按需执行。

流程：

```txt
ffprobe 检测音轨
↓
ffmpeg 提取音频
↓
转为 16kHz / mono / wav
↓
VAD 静音检测
↓
按 30 秒切片，重叠 2 秒
↓
ASR 转文字
↓
生成 TranscriptChunk
↓
写入 transcript index
↓
支持搜索视频说过的话
```

默认配置：

```ts
export const AUDIO_TRANSCRIPTION_CONFIG = {
  enableAutoTranscribe: false,
  transcribeOnDemand: true,
  sampleRate: 16000,
  channels: 1,
  chunkSec: 30,
  overlapSec: 2,
  enableVad: true,
  skipSilentChunks: true,
  modelSize: 'base',
  maxConcurrentAsrJobs: 1,
};
```

ASR 模型档位：

```txt
tiny：快速粗搜。
base：默认推荐。
small：质量更高。
medium：手动高质量。
large：不建议默认集成。
```

转写结果结构：

```ts
export interface TranscriptChunk {
  chunkId: string;
  videoId: string;
  audioId: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  confidence?: number;
  modelName: string;
  modelSize: 'tiny' | 'base' | 'small' | 'medium';
  source: 'asr' | 'subtitle';
  createdAt: number;
}
```

---

## 13. 字幕解析方案

字幕优先级高于 ASR 和 OCR。

如果存在：

```txt
.srt
.ass
.vtt
```

优先解析字幕文件，不触发 ASR / OCR。

流程：

```txt
检测外挂字幕
↓
解析时间轴
↓
清洗文本
↓
转换为 TranscriptChunk
↓
写入字幕索引
↓
支持字幕搜索和时间点跳转
```

原因：

```txt
字幕解析压力最低。
准确率通常高于 ASR。
天然带时间轴。
不占 GPU。
不需要 OCR。
```

---

## 14. 视频 OCR 方案

OCR 分三类：

```txt
外挂字幕：
优先走字幕解析。

硬字幕 OCR：
识别视频画面底部字幕。

画面文字 OCR：
识别产品参数、包装文字、屏幕文字。
```

默认不全库自动 OCR，只能按需执行。

硬字幕 OCR 流程：

```txt
按 OCR 策略抽帧
↓
裁剪底部 25% - 35%
↓
压缩到最大宽度 960 - 1280px
↓
OCR 识别
↓
过滤低置信度
↓
相邻重复文本合并
↓
生成 VideoOcrChunk
↓
写入 OCR 文本索引
```

默认配置：

```ts
export const VIDEO_OCR_CONFIG = {
  enableAutoOcr: false,
  ocrOnDemand: true,
  parseExternalSubtitleFirst: true,
  intervalSec: 5,
  deepIntervalSec: 2,
  cropSubtitleAreaOnly: true,
  subtitleCropBottomRatio: 0.35,
  maxOcrImageWidth: 1280,
  minConfidence: 0.65,
  mergeDuplicateText: true,
  keepOcrCrops: false,
};
```

OCR 输出结构：

```ts
export interface VideoOcrChunk {
  ocrId: string;
  videoId: string;
  frameId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  bbox?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  region: 'subtitle-bottom' | 'full-frame' | 'custom';
  source: 'ocr';
}
```

---

## 15. 本地索引与片段理解方案

当前版本不接入外部 LLM API，不把 DeepSeek API 或其他云端大模型作为主流程依赖。

本阶段的视频理解只基于本地可控数据：

```txt
CLIP / DINO：
负责视觉向量检索，找出相关视频帧和视频片段。

ASR / 字幕 / OCR：
负责提供带时间轴的文本证据。

文件名 / 路径 / 元数据：
负责补充轻量关键词召回和过滤。

FusionSearch：
负责把画面分数、语音分数、字幕分数、OCR 分数、元数据分数融合成最终排序。
```

当前版本不做：

```txt
不调用外部 LLM API。
不发送本地路径、字幕、OCR 或 ASR 文本到云端。
不使用 LLM 做查询规划。
不使用 LLM 做结果解释。
不使用 LLM 参与当前版本的排序链路。
```

本地片段理解输出依赖结构化证据：

```ts
export interface LocalSegmentEvidence {
  videoId: string;
  startMs: number;
  endMs: number;
  visualTags?: string[];
  representativeFrameIds: string[];
  speechText?: string;
  subtitleText?: string;
  ocrText?: string;
  metadataText?: string;
  scores: {
    visual?: number;
    speech?: number;
    subtitle?: number;
    ocr?: number;
    metadata?: number;
  };
}
```

当前版本的理解方式是：

```txt
用户输入查询
↓
本地 CLIP / DINO 检索画面
↓
本地 Transcript / Subtitle / OCR 检索文字
↓
按时间片段合并证据
↓
FusionSearch 本地融合排序
↓
返回视频片段、时间点、缩略图、命中来源和分数
```

如果后续需要外部 LLM API，只作为独立分支扩展，见第 26 章。

---

## 16. 多模态融合搜索

最终结果返回视频片段，而不是整个视频文件。

统一结果结构：

```ts
export interface MediaSearchResult {
  videoId: string;
  path: string;
  name: string;

  startMs: number;
  endMs: number;
  bestTimestampMs: number;

  thumbnailPath?: string;

  visualScore?: number;
  speechScore?: number;
  subtitleScore?: number;
  ocrScore?: number;
  metadataScore?: number;

  finalScore: number;

  sources: Array<'visual' | 'speech' | 'subtitle' | 'ocr' | 'metadata'>;

  matchedText?: {
    speech?: string;
    subtitle?: string;
    ocr?: string;
  };
}
```

默认融合权重：

```txt
visualScore   0.35
speechScore   0.30
subtitleScore 0.20
ocrScore      0.10
metadataScore 0.05
```

以图搜视频模式：

```txt
visualScore   0.80
metadataScore 0.10
speechScore   0.05
ocrScore      0.05
```

声音文字搜索模式：

```txt
speechScore   0.75
subtitleScore 0.15
ocrScore      0.05
metadataScore 0.05
```

当前版本只使用本地融合排序，不依赖外部模型重排。

---

## 17. 缓存目录设计

```txt
userData/
└── media-search/
    ├── videos/
    │   ├── video-files.db
    │   ├── video-frames.db
    │   ├── video-segments.db
    │   ├── video-frame-vectors.bin
    │   └── video-segment-vectors.bin
    │
    ├── thumbnails/
    │   └── <videoId>/
    │       ├── 000012_240000.thumb.webp
    │       └── ...
    │
    ├── transcripts/
    │   ├── transcript-chunks.db
    │   ├── transcript-vectors.bin
    │   └── transcript-manifest.json
    │
    ├── ocr/
    │   ├── video-ocr-chunks.db
    │   └── video-ocr-vectors.bin
    │
    ├── audio/
    │   ├── extracted/
    │   └── chunks/
    │
    └── temp/
```

缓存保留策略：

```txt
thumbnail：长期保留。
embeddingFrame：生成向量后删除。
ocrCrop：OCR 完成后默认删除。
audio chunk：ASR 完成后可删除。
transcript：长期保留。
vector：长期保留。
temp：启动时自动清理。
```

缓存上限：

```txt
默认 10GB。
超过后优先清理：
1. temp
2. embeddingFrame
3. ocrCrop
4. audio chunk
5. 最旧缩略图
```

---

## 18. 增量索引策略

视频是否变化，用：

```txt
path + sizeBytes + mtimeMs
```

判断。

未变化：

```txt
不重新抽帧。
不重新转写。
不重新 OCR。
不重新建向量。
```

视频变化：

```txt
删除该视频旧 frame。
删除该视频旧 segment。
删除该视频旧 vector。
删除该视频旧 transcript。
删除该视频旧 OCR。
重新分析该视频。
```

模型变化：

```txt
CLIP/DINO 模型变化：只重建视觉向量。
ASR 模型变化：只重建 Transcript。
OCR 模型变化：只重建 OCR。
```

字幕变化：

```txt
只重建字幕索引。
```

---

## 19. 后台任务调度

默认并发限制：

```ts
export const MEDIA_TASK_SCHEDULER = {
  maxVideoDecodeJobs: 1,
  maxEmbeddingJobs: 1,
  maxAsrJobs: 1,
  maxOcrJobs: 1,
  maxScanJobs: 2,
  pauseHeavyJobsWhileSearching: true,
  pauseOnBattery: true,
  allowManualPriority: true,
};
```

任务优先级：

```txt
高优先级：
用户当前点击的深度分析视频。
当前搜索结果页需要的缩略图。
当前查询相关的视频片段。

中优先级：
默认视觉索引。
字幕解析。
封面生成。

低优先级：
全库 OCR。
全库 ASR。
高频抽帧。
DINO 细节索引。
```

---

## 20. IPC 接口设计

建议新增：

```ts
export interface MediaSearchAPI {
  startMediaIndex(input: StartMediaIndexInput): Promise<Result>;
  cancelMediaTask(taskId: string): Promise<Result>;
  getMediaIndexStatus(): Promise<MediaIndexStatus>;

  searchMedia(input: MediaSearchQuery): Promise<MediaSearchResult[]>;
  searchVideoByImage(input: VideoImageSearchQuery): Promise<VideoSearchResult[]>;
  searchVideoByText(input: VideoTextSearchQuery): Promise<VideoSearchResult[]>;

  transcribeVideo(input: TranscribeVideoInput): Promise<Result>;
  getTranscript(videoId: string): Promise<TranscriptChunk[]>;
  searchTranscript(input: TranscriptSearchQuery): Promise<TranscriptSearchResult[]>;

  importSubtitle(input: ImportSubtitleInput): Promise<Result>;
  runVideoOcr(input: VideoOcrInput): Promise<Result>;


  openMediaAtTime(input: OpenMediaAtTimeInput): Promise<Result>;
  revealMediaInExplorer(path: string): Promise<Result>;

  onMediaIndexProgress(cb: (event: MediaIndexProgressEvent) => void): Unsubscribe;
  onTranscriptionProgress(cb: (event: TranscriptionProgressEvent) => void): Unsubscribe;
  onVideoOcrProgress(cb: (event: VideoOcrProgressEvent) => void): Unsubscribe;
}
```

所有接口必须做：

```txt
路径校验。
扩展名校验。
topK 范围校验。
mode 校验。
时间范围校验。
模型名校验。
语言校验。
chunkSec / overlapSec 校验。
OCR 区域校验。
搜索文本长度校验。
禁止路径遍历。
禁止 Renderer 传入任意命令参数。
```

---

## 21. UI 设计

新增 `MediaSearchPanel`，包含：

```txt
[综合搜索] [以图搜视频] [声音/字幕搜索] [OCR 搜索] [深度分析]
```

结果卡片显示：

```txt
缩略图
视频名称
路径
命中时间：00:02:13 - 00:02:25
来源：画面 + 语音 + OCR
分数：0.87
语音命中：音频中提到目标关键词或相关说明
OCR 命中：画面中识别到相关文字或参数
按钮：
- 打开视频
- 跳转到时间点
- 在资源管理器中显示
- 复制路径
- 深度分析此视频
```

时间线预览：

```txt
00:00 ──────●──────●────●──────── 05:30
             画面命中 语音命中 OCR命中
```

设置项：

```txt
抽帧模式：fast / balanced / recall / deep
自动字幕解析：开
自动 ASR：默认关
自动 OCR：默认关
缓存上限：默认 10GB
ASR 模型：tiny / base / small / medium
OCR 区域：底部字幕 / 全画面 / 自定义
```

---

## 22. 安全与隐私设计

### 22.1 本地安全

```txt
Renderer 不直接读取本地文件。
Renderer 不直接调用 ffmpeg。
Renderer 不直接调用 OCR / ASR / CLIP。
所有路径由 Main Process 校验。
所有任务由 Worker / Child Process 执行。
```

### 22.2 本地数据隐私

当前版本不接入外部 LLM API，视频路径、缩略图、ASR 转写、字幕、OCR 文本和索引数据默认全部保存在本地。

默认策略：

```txt
不上传视频文件。
不上传抽帧图片。
不上传本地路径。
不上传 ASR 全文。
不上传 OCR 文本。
不上传字幕内容。
不把索引数据库发送到外部服务。
```

### 22.3 危险操作限制

```txt
搜索、分析和去重结果只能生成建议。
删除、移动、清理缓存必须由用户手动确认。
语义相似结果不得触发自动删除。
OCR / ASR 结果不得作为不可核验事实。
```

---

## 23. 开发阶段规划

### P0：视频基础索引

```txt
视频扫描
ffprobe 元数据读取
生成封面
5 秒抽 1 帧
WebP 压缩
thumbnail 缓存
dHash / pHash 去重
```

### P1：以图搜视频

```txt
复用 CLIP image embedding
视频代表帧生成向量
建立 video frame vector index
图片查询生成 query vector
返回视频 + 时间点 + 缩略图 + 分数
```

### P2：文本搜视频画面

```txt
CLIP text embedding
搜视频帧向量
按 videoId / segmentId 聚合
返回片段级结果
```

### P3：字幕解析

```txt
srt / ass / vtt 导入
转 TranscriptChunk
字幕文本搜索
点击跳转时间点
```

### P4：声音转文字

```txt
音轨检测
音频提取
16kHz mono wav
30 秒切片
VAD 跳过静音
Whisper tiny/base/small
TranscriptChunk 索引
```

### P5：视频 OCR

```txt
底部字幕区域裁剪
OCR 识别
低置信度过滤
重复文本合并
OCR 文本搜索
```

### P6：多模态融合搜索

```txt
visualScore
speechScore
subtitleScore
ocrScore
metadataScore
统一 MediaSearchResult
```

---

## 24. 测试规划

新增测试：

```txt
videoSearchGuards.test.cjs
videoScan.test.cjs
videoFrameExtract.test.cjs
videoFrameCompression.test.cjs
videoFrameDedup.test.cjs
videoIndex.test.cjs
videoSearchCorrectness.test.cjs

audioExtract.test.cjs
speechTranscription.test.cjs
transcriptIndex.test.cjs
transcriptSearch.test.cjs

subtitleImport.test.cjs

videoOcr.test.cjs
videoOcrMerge.test.cjs

mediaSearchFusion.test.cjs
mediaCacheCleanup.test.cjs
mediaTaskQueue.test.cjs
```

验收标准：

```txt
1. 4K 视频抽帧后不保存 4K 原始大图。
2. 100 个 1080p 视频默认索引缓存可控。
3. 截图搜索视频，Top 5 能返回对应视频和接近时间点。
4. 文本搜索画面，可以返回语义相关视频片段。
5. 有字幕文件的视频优先解析字幕，不触发 ASR/OCR。
6. 手动 ASR 后，可以搜索视频说过的话。
7. 手动 OCR 后，可以搜索硬字幕/画面文字。
8. 搜索结果显示来源：画面、语音、字幕、OCR、文件名。
9. 点击结果可以跳转视频时间点。
10. 视频未变化时不会重复索引。
11. 视频变化时只重建该视频。
12. npm test、npm run typecheck、npm run build 必须通过。
```

---

## 25. 最终推荐路线

最稳路线：

```txt
第一步：抽帧压缩 + 去重
第二步：CLIP 以图搜视频
第三步：文本搜视频画面
第四步：字幕解析
第五步：声音转文字
第六步：OCR
第七步：多模态融合搜索
```

不要第一版就做：

```txt
全库 1 秒抽帧
全库 ASR
全库 OCR
全画面 OCR
逐帧 Caption
直接把整段视频交给大模型理解
自动删除相似素材
```

最终产品形态：

```txt
本地 CLIP/DINO 向量库负责找画面。
ASR/字幕/OCR 负责补充文字证据。
MediaSearch 负责统一搜索结果。
```

一句话总结：

**这个方案的核心不是让大模型直接看完整视频，而是先用本地低成本索引把视频拆成可搜索、可定位、可增量维护的片段。当前版本以本地检索、本地索引和本地融合排序为主，配置压力低、扩展性强，也更适合当前 FloatingClock Electron 项目的架构。**

---

## 26. 后续分支：外部 LLM API 辅助理解

该分支不纳入当前版本开发范围。只有在本地 MediaSearch 主流程稳定后，再考虑作为可选扩展加入。

### 26.1 分支定位

外部 LLM API 不直接理解视频、不直接读取向量数据库、不参与全库检索。它只读取本地检索出的 TopK 片段证据，用于辅助生成解释、摘要、标签和自然语言问答。

推荐定位：

```txt
本地 CLIP / DINO：负责视觉检索。
本地 ASR / 字幕 / OCR：负责文本证据。
本地 FusionSearch：负责基础排序。
外部 LLM API：作为后续可选分支，只处理 TopK 结果的解释、摘要和标签。
```

### 26.2 后续可新增模块

```txt
electron/
├── deepseekService.ts                 # 外部 LLM API 封装，可替换为其他模型服务
├── mediaQueryPlannerService.ts        # 查询规划，可选
├── mediaResultExplainerService.ts     # 结果解释，可选
└── mediaCaptionSummaryService.ts      # 片段摘要 / 标签整理，可选
```

### 26.3 后续分支流程

```txt
用户输入自然语言
↓
本地 MediaSearch 完成多路检索
↓
本地 FusionSearch 返回 TopK 片段
↓
用户明确允许后，将匿名化片段证据发送给外部 LLM API
↓
外部 LLM API 返回摘要、标签、解释或二次重排建议
↓
UI 标记该结果来源为“外部模型辅助解释”
```

### 26.4 隐私边界

后续分支必须默认关闭，并提供明确开关：

```txt
[ ] 启用外部 LLM API 辅助理解
[ ] 允许发送文件名
[ ] 允许发送本地路径
[ ] 允许发送 ASR 转写文本
[ ] 允许发送 OCR 文本
[ ] 允许发送字幕内容
```

默认策略：

```txt
不发送完整本地路径。
不发送整库信息。
不发送原始视频。
不发送抽帧图片。
只发送用户授权后的 TopK 片段结构化证据。
```

### 26.5 分支限制

```txt
外部 LLM API 不能直接删除文件。
外部 LLM API 不能直接移动文件。
外部 LLM API 不能直接修改索引。
外部 LLM API 不能替代本地 CLIP / DINO 检索。
外部 LLM API 只能生成解释、标签、摘要或排序建议。
```

---

## 27. v1.1.3 当前项目适配优化

本节是对 v1.1.2 方案的落地适配。当前项目已经完成 ImageSearch、Vector、Embedding、Model、FileManager、RemoteTerminal 等模块的大范围审计与优化，`src/`、`electron/`、`shared/` 当前 lint 已清零，`typecheck`、核心测试、build、release 烟测均通过。因此 MediaSearch 不能按“从零新建大系统”的方式推进，必须按现有边界小步接入。

### 27.1 当前代码基线

| 项目现状 | 适配结论 |
|---|---|
| `shared/ipc-contract.ts` 已作为统一 IPC 类型源 | MediaSearch 类型必须继续放入这里，不能另建第二套 IPC 契约 |
| `electron/preload.ts` 已完成类型收紧 | 新 API 必须按现有 `contextBridge` 模式暴露，禁止 `any` 回流 |
| `electron/modelService.ts` 当前使用软件目录 `ai-models` | MediaSearch 视觉模型复用 `ai-models`，不要回退到旧 Roaming models 作为主路径 |
| `vector-db` 已从旧单体 JSONL 向分片与缓存方向优化 | 视频向量第一版应复用“分片 JSONL + 二进制 cache”思路，不建议第一版直接引入 SQLite |
| `ocrService.ts` 目前只是候选级 OCR 占位 | 文档中 OCR 不能标为 A 级直接复用，应改为“接口模式可参考，能力必须新建/接入引擎” |
| 项目当前没有 ffmpeg / ffprobe 依赖 | P0 前必须先做 `ffmpegService` 能力探测与配置，不应假设环境一定存在 |
| release 安装包当前约 681MB | 第一版 MediaSearch 禁止默认打包 ASR/OCR 大模型，避免安装包继续失控 |
| ImageSearch UI 已组件化 | MediaSearch 可复用控件模式，但不能把视频逻辑塞回 `ImageSearchPanel` |

### 27.2 对原复用审计的修正

以下条目需要按当前项目实际调整：

| 原方案判断 | 修正后判断 | 原因 |
|---|---|---|
| `ocrService.ts` A/B 级复用 | C 级参考复用 | 当前实现为 stub，只能复用候选级 OCR 的接口思路，不能作为视频 OCR 能力基础 |
| `settingsStore.ts` A 级复用 | 改为 `useStore.ts` + `useAutoSaveSettings.ts` B 级复用 | 当前项目没有独立 `settingsStore.ts`，设置持久化走 Zustand + settings writer |
| `vectorDatabaseService.ts` 保存 transcript / OCR vectors | 第一版只保存 visual frame vectors | Transcript / OCR 向量需要文本索引策略，不能先污染现有 image embedding schema |
| `vectorIndexService.ts` 直接建立 video frame index | 先做独立 media namespace / cache 文件 | 避免 ImageSearch 索引和 MediaSearch 索引互相影响 |
| `ffmpegService.ts` 直接用于抽帧 | 先做能力探测、路径配置和版本校验 | Windows 环境中 ffmpeg 不一定存在，也不应让 Renderer 传命令参数 |
| `SearchProgressBar.tsx` A 级复用 | A 级复用 UI 模式，不直接绑定 ImageSearch 状态 | 进度结构要新增 `MediaTaskProgressEvent`，不要复用图片搜索 status |

### 27.3 第一阶段落地顺序调整

原方案 P0 包含扫描、ffprobe、封面、抽帧、压缩、去重。按当前项目复杂度，P0 拆成 P0a / P0b / P0c，降低一次性引入视频处理导致崩溃和打包膨胀的风险。

```txt
P0a：契约与空壳闭环
- shared/ipc-contract.ts 增加 MediaSearch / VideoIndex / MediaTask 类型
- electron/mediaSearchGuards.ts 增加入参 guard
- electron/mediaTaskQueue.ts 增加任务队列骨架
- electron/mediaCacheService.ts 增加缓存目录与统计
- electron/preload.ts 暴露 mediaSearch API
- src/services/mediaSearchBridge.ts 增加 renderer bridge
- src/components/MediaSearchPanel.tsx 只做空状态、任务状态、缓存状态
- tests/media-search-guards.test.cjs 覆盖路径、topK、模式、时间范围
```

```txt
P0b：视频发现与元数据
- videoScanService.ts 只扫描视频文件，不抽帧
- ffmpegService.ts 只做 ffmpeg / ffprobe 可用性探测
- 支持用户配置 ffmpeg 路径，默认不下载、不打包
- 读取 path、sizeBytes、mtimeMs、durationMs、codec、resolution
- 写入 userData/media-search/videos/video-files.jsonl
```

```txt
P0c：封面与缩略图
- ffmpeg 可用时生成少量封面和缩略图
- 缩略图直接压缩为 WebP / JPEG 小图
- 不保留 1080p / 4K 原始帧
- 缓存写入 userData/media-search/thumbnails/<videoId>/
- UI 显示视频列表、封面、时长、索引状态
```

P0 完成后再进入 P1 以图搜视频。不要在 P0 同时实现 CLIP、ASR、OCR、融合排序。

### 27.4 存储方案适配

第一版不要直接引入 SQLite。当前项目已经有 JSONL、分片、二进制向量 cache、manifest 的维护经验，MediaSearch 应先复用这个低依赖路线。

推荐第一版目录：

```txt
userData/
└── media-search/
    ├── manifests/
    │   ├── video_files.jsonl
    │   ├── video_frames.jsonl
    │   ├── video_segments.jsonl
    │   └── media_tasks.jsonl
    ├── vectors/
    │   ├── clip_video_frames.f32
    │   ├── clip_video_frames.paths.jsonl
    │   └── clip_video_frames.cache.json
    ├── thumbnails/
    ├── transcripts/
    ├── ocr/
    └── temp/
```

后续当视频数量、帧数量和文本片段数量明显增长后，再评估 SQLite 或更专业的 ANN 索引。第一版目标是稳定可回滚，不是直接做最大规模数据库迁移。

### 27.5 IPC 与安全适配

MediaSearch 必须延续当前项目已经验证过的 IPC 风格：

```txt
Renderer:
只调用 src/services/mediaSearchBridge.ts。

Preload:
只暴露白名单 API。

Main:
ipcMain.handle 收到 unknown。
先 guard 校验。
再调用具体 service。

Service:
只接收已校验参数。
不接收 Renderer 拼接出的命令行参数。
不直接信任本地路径。
```

建议第一版 IPC 最小集：

```ts
mediaSearch:getStatus
mediaSearch:getCacheStats
mediaSearch:selectVideoPaths
videoIndex:startScan
videoIndex:stopTask
videoIndex:getTaskProgress
mediaSearch:openMediaAtTime
mediaSearch:revealInExplorer
mediaSearch:onTaskProgress
```

`searchVideoByImage`、`searchVideoByText`、`transcript:*`、`videoOcr:*` 不进入 P0a/P0b，避免接口先膨胀。

### 27.6 UI 适配

当前 ImageSearch 面板已经较复杂，MediaSearch 不能复用成同一个面板。第一版 UI 只做实际可用的工作台，不做说明型页面。

推荐 P0 UI：

```txt
MediaSearchPanel
├── 顶部工具栏：Select Videos / Scan / Stop / Cache / Refresh
├── 状态条：ffmpeg 状态、视频数、任务状态、缓存大小
├── 视频列表：封面、文件名、时长、分辨率、索引状态
├── 任务栏：当前任务、进度百分比、失败数、耗时
└── 底部：缓存目录、打开缓存、清理 temp
```

暂不做：

```txt
综合搜索 Tab
ASR Tab
OCR Tab
外部 LLM 设置
全量高级参数面板
```

等 P1/P2/P3 能力真实可用后，再分 Tab 增加。

### 27.7 模型与安装包体积约束

当前 `package.json` 已将 `models` 和 `ai-models` 放入 `extraResources`。MediaSearch 继续使用现有视觉模型时，不新增模型体积。

第一版限制：

```txt
不默认打包 Whisper。
不默认打包 OCR 模型。
不默认打包 ffmpeg 大二进制，除非确认许可证、体积和更新策略。
不复制视频帧原图进安装目录。
不把 userData/media-search 打包进 release。
```

如果后续必须内置 ffmpeg，应单独审计：

```txt
许可证。
二进制来源。
sha256 校验。
体积变化。
electron-builder extraResources 影响。
卸载残留。
用户自定义 ffmpeg 路径优先级。
```

### 27.8 P1 以图搜视频适配

P1 开始后，视觉搜索应复用现有 CLIP/DINO worker 思路，但必须使用视频专用记录。

```txt
video frame thumbnail
↓
embeddingService / CLIP child process
↓
写入 media-search/vectors/clip_video_frames.*
↓
搜索时 query image embedding
↓
流式 / mmap 扫描视频帧向量
↓
按 videoId + 时间窗口聚合
↓
返回片段
```

禁止：

```txt
把视频帧当成普通 ImageSearch 图片写入 image_embeddings。
把视频缩略图路径加入 imageSearchScanPaths。
把 videoId、timestamp 塞进图片搜索 result 的 path 字段里。
```

### 27.9 验收门槛

P0a 验收：

```txt
npm run typecheck 通过。
npm run lint 通过，0 warning。
npm run test:guards 通过。
新增 media-search guard 测试通过。
MediaSearch 面板可打开、关闭、拖动、保存位置。
没有 ffmpeg 时 UI 明确显示 not configured，不崩溃。
```

P0b 验收：

```txt
扫描 1 个目录，能发现视频文件。
非法路径、空路径、非视频扩展名被拒绝。
ffprobe 不存在时任务失败但主进程不崩溃。
video_files.jsonl 可重复扫描且按 path + size + mtime 增量更新。
```

P0c 验收：

```txt
能为少量视频生成封面。
封面尺寸受控。
缓存统计准确。
清理 temp 不误删 thumbnails / manifests。
release build 通过。
release 只保留安装包。
```

P1 验收：

```txt
截图搜视频 TopK 能返回视频时间点。
搜索进度有百分比。
取消任务有效。
结果可以打开视频并跳转到时间点。
视频视觉向量不污染 ImageSearch 向量库。
```

### 27.10 当前推荐结论

MediaSearch 可以落地，但必须按“先安全骨架、再视频扫描、再缩略图、再视觉搜索、最后 ASR/OCR/融合”的路线推进。

当前最优路线：

```txt
1. P0a：contracts + guards + bridge + empty panel + task/cache skeleton
2. P0b：video scan + ffmpeg capability detection + metadata
3. P0c：cover thumbnail cache
4. P1：CLIP image-to-video
5. P2：CLIP text-to-video
6. P3：subtitle import
7. P4：ASR
8. P5：OCR
9. P6：fusion search
```

当前不建议立即做：

```txt
SQLite 迁移。
全库 ASR。
全库 OCR。
内置 Whisper 大模型。
内置 ffmpeg 大包。
把 MediaSearch 合并进 ImageSearch。
把所有媒体 IPC 一次性加完。
```

一句话适配结论：

**v1.1.2 的方向正确，但 v1.1.3 必须按当前 FloatingClock 已稳定的 IPC、模型目录、向量分片、任务进度、release 体积约束来落地。第一阶段只做可验证的小闭环，不做多模态大而全。**

### 27.11 P0a 实现进度 - 2026-07-02

本轮已开始落地 MediaSearch P0a，完成安全骨架和空壳闭环。

已实现：

```txt
shared/ipc-contract.ts
- 新增 MediaSearchStatus
- 新增 MediaSearchCacheStats
- 新增 MediaSearchTaskProgress
- 新增 MediaSearchStartScanArgs
- 新增 OpenMediaAtTimeInput
- ElectronAPI 增加 mediaSearch 白名单 API

electron/mediaSearchGuards.ts
- 校验视频扩展名
- 校验扫描路径
- 校验 taskId
- 校验 openMediaAtTime 输入

electron/mediaCacheService.ts
- 建立 userData/media-search 目录结构
- 统计 manifests / thumbnails / vectors / temp / total 缓存体积

electron/mediaTaskQueue.ts
- 建立 P0a 任务骨架
- 支持 start / stop / get progress
- 支持任务进度事件推送

electron/main.ts
- 注册 mediaSearch:getStatus
- 注册 mediaSearch:getCacheStats
- 注册 mediaSearch:selectVideoPaths
- 注册 videoIndex:startScan
- 注册 videoIndex:stopTask
- 注册 videoIndex:getTaskProgress
- 注册 mediaSearch:openMediaAtTime
- 注册 mediaSearch:revealInExplorer

electron/preload.ts
- 暴露 mediaSearch API

src/services/mediaSearchBridge.ts
- 新增 renderer 侧类型安全 bridge

src/components/MediaSearchPanel.tsx
- 新增 Media Search 面板
- 支持选择视频/目录
- 支持 P0a Scan / Stop / Refresh
- 展示状态、缓存、ffmpeg 状态、任务进度条

src/stores/useStore.ts / App.tsx / SettingsPanel.tsx
- MediaSearch 接入面板系统
- 支持显示/隐藏、拖动、缩放、锁定、可见性锁、自动保存位置

tests/media-search-guards.test.cjs
- 新增 MediaSearch guard 测试
- package.json 新增 test:media-search 并接入 npm test
```

当前限制：

```txt
P0a 只做安全骨架和任务闭环。
尚未实现真实视频扫描。
尚未接入 ffmpeg / ffprobe。
尚未生成封面缩略图。
尚未写入 video_files.jsonl。
尚未实现以图搜视频。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过，0 warning。
npm run test:guards 通过，6 项通过。
npm run test:media-search 通过，5 项通过。
npm run build 通过。
release 烟测通过，FloatingClock.exe 可正常启动。
release 已清理，只保留 FloatingClock Setup 1.0.0.exe。
```

下一步：

```txt
进入 P0b：videoScanService + ffmpegService 能力探测 + video_files.jsonl 增量扫描。
```

### 27.12 P0b 推进进度 - 2026-07-02

本轮继续推进 MediaSearch P0b，已把 P0a 的“空任务”替换为真实视频发现与 manifest 写入。

已实现：

```txt
electron/ffmpegService.ts
- 新增 ffmpeg / ffprobe 能力探测。
- 使用固定命令执行 -version。
- 不接收 Renderer 传入命令参数。
- ffmpeg / ffprobe 不存在时只返回 missing，不导致主进程崩溃。

electron/videoScanService.ts
- 新增递归视频扫描。
- 支持 mp4 / mkv / mov / avi / webm / wmv / m4v / flv / ts / mts / m2ts。
- 按 path + sizeBytes + mtimeMs 判断新增、更新、未变化。
- 写入 userData/media-search/manifests/video_files.jsonl。
- 保留缺失文件 missing 标记，避免直接删除历史记录。
- 扫描过程支持进度回调和取消检查。
- 设置 MAX_SCAN_ENTRIES，避免误扫超大目录导致任务不可控。

electron/mediaTaskQueue.ts
- startMediaIndexScan 已调用真实 scanVideoFiles。
- 任务进度显示当前路径、扫描数量、发现视频数量、失败数。
- 任务完成后显示新增、更新、未变化统计。
- stopTask 会请求取消扫描。
- getMediaSearchStatus 会读取 video_files.jsonl 统计视频数。
- 状态中增加 ffmpegConfigured / ffprobeConfigured / version 信息。

src/components/MediaSearchPanel.tsx
- 状态栏显示 ffmpeg / ffprobe 探测状态。
- Scan 现在触发真实视频发现与 manifest 写入。
- 文案从 P0a 空壳更新为 P0b metadata scan。
```

当前仍未完成：

```txt
尚未调用 ffprobe 读取 duration / codec / resolution。
尚未生成封面缩略图。
尚未实现 video_files.jsonl 的 UI 列表展示。
尚未实现 P0c 缩略图缓存。
尚未实现以图搜视频。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过，0 warning。
npm run test:media-search 通过，5 项通过。
npm run build 通过。
release 烟测通过，FloatingClock.exe 可正常启动。
release 已清理，只保留 FloatingClock Setup 1.0.0.exe。
```

下一步：

```txt
继续 P0b：补 ffprobe 元数据读取 durationMs / width / height / videoCodec / audioCodec。
然后进入 P0c：封面缩略图生成与缓存展示。
```

### 27.13 P0b 元数据与列表进度 - 2026-07-02

本轮继续完善 P0b，完成 ffprobe 元数据读取和 MediaSearch 面板视频列表展示。

已实现：

```txt
shared/ipc-contract.ts
- MediaSearchVideoRecord 增加 durationMs / width / height / videoCodec / audioCodec / containerFormat。
- 增加 metadataStatus / metadataError，区分 done / unavailable / error。
- 增加 MediaSearchVideoListResponse。
- ElectronAPI.mediaSearch 增加 listVideos(limit)。

electron/ffmpegService.ts
- 增加 parseFfprobeMetadata(jsonText)。
- 增加 readVideoMetadata(filePath)。
- ffprobe 调用固定参数：-v error -print_format json -show_format -show_streams。
- 不接收 Renderer 传入命令参数。
- ffprobe 不存在或解析失败时返回结构化错误，不中断扫描。

electron/videoScanService.ts
- 新增/变化视频会尝试读取 ffprobe 元数据。
- 未变化视频保留旧元数据，避免重复 ffprobe。
- ffprobe 不可用时 metadataStatus 写为 unavailable。
- ffprobe 失败时 metadataStatus 写为 error，并保留 metadataError。

electron/main.ts / preload.ts / mediaSearchBridge.ts
- 新增 mediaSearch:listVideos IPC。
- 默认最多返回 200 条，主进程硬限制 1000 条。

src/components/MediaSearchPanel.tsx
- 扫描完成后读取 video_files.jsonl。
- 显示视频名称、时长、分辨率、视频编码、体积、Folder 按钮。
- 状态栏显示 listed / total。

tests/media-search-guards.test.cjs
- 增加 ffprobe JSON 解析测试。
- MediaSearch 测试从 5 项增加到 7 项。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过，0 warning。
npm run test:media-search 通过，7 项通过。
npm run build 通过。
release 烟测通过，FloatingClock.exe 可正常启动。
release 已清理，只保留 FloatingClock Setup 1.0.0.exe。
```

当前限制：

```txt
尚未生成封面缩略图。
尚未支持点击跳转到具体时间点。
尚未做 P0c thumbnail cache。
尚未做 P1 以图搜视频。
```

下一步：

```txt
进入 P0c：使用 ffmpeg 生成视频封面缩略图，写入 thumbnails/<videoId>/cover.webp 或 cover.jpg，并在 MediaSearchPanel 中展示。
```
### 27.14 P0c 封面缩略图缓存进度 - 2026-07-02

本轮继续推进 MediaSearch P0c，已把视频封面缩略图纳入扫描、缓存和列表展示闭环。

已实现：

```txt
shared/ipc-contract.ts
- MediaSearchVideoRecord 增加 thumbnailPath / thumbnailStatus / thumbnailError / thumbnailDataUrl。

electron/ffmpegService.ts
- 新增 generateVideoCoverThumbnail。
- 使用固定 ffmpeg 参数从视频抽取单帧封面。
- 输出 cover.jpg，不接收 Renderer 传入命令参数。
- ffmpeg 不可用、超时、失败时返回结构化错误，不中断扫描任务。

electron/videoScanService.ts
- 新增 thumbnails/<videoId>/cover.jpg 路径规则。
- 新增/变更视频会生成封面。
- 旧记录缺少封面或封面文件丢失时会补生成。
- 未变更且封面存在的视频复用旧缓存，避免重复 ffmpeg。
- thumbnailStatus 区分 done / unavailable / error。

electron/main.ts
- mediaSearch:listVideos 会把安全缓存目录内的 cover.jpg 转为 data URL。
- 不把任意本地路径直接暴露给 Renderer 的 img src。
- 单张缩略图读取限制为 1MB，避免异常大文件撑爆 IPC。

src/components/MediaSearchPanel.tsx
- 视频列表增加封面列。
- 缺少封面时显示稳定占位。
- 增加 Open 按钮，可直接打开视频。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过。
npm run test:media-search 通过，7 项通过。
npm run build 通过。
```

当前限制：

```txt
封面抽帧仍是同步 ffmpeg 调用，超大批量扫描时后续需要改为专用 worker/并发队列。
封面当前只抽单帧，不支持时间轴多帧预览。
openMediaAtTime 当前仍只打开文件，尚未跳转到精确时间点。
P1 以图搜视频、镜头级索引、OCR/ASR 尚未开始。
```

### 27.15 P0c 工具路径适配进度 - 2026-07-02

本轮根据实际运行截图继续推进 MediaSearch。当前机器与项目目录没有 ffmpeg / ffprobe，因此面板显示 missing 是真实状态。已补齐工具路径发现与打包目录适配。

已实现：

```txt
electron/ffmpegService.ts
- 新增 buildMediaToolCandidates。
- 探测优先级：
  1. FFMPEG_PATH / FFPROBE_PATH
  2. FLOATING_CLOCK_FFMPEG_DIR
  3. FFMPEG_DIR
  4. FFMPEG_HOME/bin
  5. 软件目录 tools/ffmpeg/bin
  6. 软件目录 tools/ffmpeg
  7. 软件目录 ffmpeg/bin
  8. 软件目录 ffmpeg
  9. PATH 中的 ffmpeg / ffprobe
- 开发版与打包版都会检查 process.resourcesPath / cwd / app root 相关目录。

shared/ipc-contract.ts / electron/mediaTaskQueue.ts
- MediaSearchStatus 增加 ffmpegCommand / ffprobeCommand。
- Renderer 可通过 tooltip 看到当前探测命令或路径，方便排查 missing。

src/components/MediaSearchPanel.tsx
- ffmpeg / ffprobe 状态增加 tooltip。
- missing 时显示：把 ffmpeg.exe 和 ffprobe.exe 放到 tools/ffmpeg/bin，或加入 PATH。

package.json / tools/ffmpeg/bin/README.md
- 新增 tools/ffmpeg/bin 占位说明。
- electron-builder extraResources 增加 tools -> tools。
- 后续若把 ffmpeg.exe / ffprobe.exe 放入 tools/ffmpeg/bin，打包时会随安装包一起带上。
```

本轮验证：

```txt
npm run test:media-search 通过，8 项通过。
npm run typecheck 通过。
npm run lint 通过。
```

当前限制：

```txt
尚未自动下载 ffmpeg。
尚未提供 UI 选择 ffmpeg 目录。
当前只完成路径探测与打包目录支持。
```

### 27.16 P0c FFmpeg 目录选择进度 - 2026-07-02

本轮继续把工具配置做成可用闭环。现在用户不需要手动改 PATH，可以直接在 Media Search 面板选择 FFmpeg 目录。

已实现：

```txt
electron/mediaToolConfigService.ts
- 新增 MediaSearch 工具配置服务。
- 配置文件保存到 userData/media-search/tool-config.json。
- 支持选择直接包含 ffmpeg.exe / ffprobe.exe 的目录。
- 支持选择上一级目录，自动识别 bin/ffmpeg.exe 与 bin/ffprobe.exe。
- 保存后调用 setConfiguredFfmpegDir，并强制刷新 ffmpeg / ffprobe 探测缓存。
- 如果目录缺少任一工具，会返回结构化错误，不写入配置。

electron/ffmpegService.ts
- 新增 setConfiguredFfmpegDir。
- 已保存目录会进入 buildMediaToolCandidates 候选路径。
- 修改配置后自动清除 cachedStatus，避免 UI 继续显示旧 missing 状态。

electron/main.ts / preload.ts / shared/ipc-contract.ts / src/services/mediaSearchBridge.ts
- 新增 mediaSearch:selectFfmpegDirectory。
- ElectronAPI.mediaSearch 增加 selectFfmpegDirectory。
- Renderer 只拿到结构化结果，不直接访问 Node 文件系统。

src/components/MediaSearchPanel.tsx
- 新增 FFmpeg Dir 按钮。
- 选择成功后显示已配置目录并刷新状态。
- 选择失败时显示缺失 ffmpeg.exe / ffprobe.exe 的原因。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过。
npm run test:media-search 通过，8 项通过。
```

当前限制：

```txt
仍未自动下载 ffmpeg。
仍未提供清空已保存 ffmpeg 目录的按钮。
封面抽帧仍在扫描循环内同步执行，后续需要拆成 worker 队列。
```

### 27.17 P0c 工具配置运维进度 - 2026-07-02

本轮继续补齐 FFmpeg 工具配置的可维护性。现在选错目录后可以直接在面板清空配置，也可以一键打开推荐工具目录。

已实现：

```txt
electron/mediaToolConfigService.ts
- 新增 clearFfmpegDirectory。
- 删除 userData/media-search/tool-config.json。
- 清空内存中的 configuredFfmpegDir。
- 强制刷新 ffmpeg / ffprobe 探测缓存。
- 新增 getBundledFfmpegBinDir / ensureBundledFfmpegBinDir。
- 开发版返回 app root/tools/ffmpeg/bin。
- 打包版返回 resources/tools/ffmpeg/bin。

electron/main.ts / preload.ts / shared/ipc-contract.ts / src/services/mediaSearchBridge.ts
- 新增 mediaSearch:clearFfmpegDirectory。
- 新增 mediaSearch:openFfmpegToolsDirectory。
- 仍通过 preload 白名单暴露，不开放任意 Node 文件系统访问。

src/components/MediaSearchPanel.tsx
- 新增 Tools 按钮：打开推荐放置 ffmpeg.exe / ffprobe.exe 的目录。
- 新增 Clear FF 按钮：清空已保存 FFmpeg 目录并刷新状态。
```

本轮验证：

```txt
npm run typecheck 通过。
npm run lint 通过。
npm run test:media-search 通过，8 项通过。
```

当前限制：

```txt
仍未自动下载 ffmpeg。
仍未实现后台 worker 抽帧队列。
仍未实现视频帧级索引和以图搜视频。
```

### 27.18 构建验证记录 - 2026-07-02

本轮代码验证通过，但安装包生成阶段出现环境性阻塞，需要单独处理。

已完成验证：

```txt
npm run typecheck 通过。
npm run lint 通过。
npm run test:media-search 通过，8 项通过。
release/win-unpacked/FloatingClock.exe 烟测通过，可正常启动。
```

构建阻塞：

```txt
npm run build 在 electron-builder NSIS 阶段失败。
失败位置：NsisTarget.computeScriptAndSignUninstaller。
错误：spawn EPERM。
现象：electron-builder 已生成 win-unpacked 和 nsis.7z，但生成的 FloatingClock Setup 1.0.0.exe 只有约 189KB，是无效半成品。
初步判断：不是代码编译错误，而是 NSIS 在执行临时 installer 以生成 uninstaller 时被系统权限/安全策略拦截。
```

处理结果：

```txt
无效的 189KB 安装包不能作为 release 产物保留。
本轮保留 win-unpacked 用于运行验证。
后续需要修复 NSIS installer 阶段，再恢复 release 只保留 FloatingClock Setup 1.0.0.exe 的规则。
```

### 27.19 NSIS 修复尝试记录 - 2026-07-02

本轮继续排查安装包阶段失败。

尝试过的方案：

```txt
1. 清空 release 后重新 npm run build。
   结果：仍在 NsisTarget.computeScriptAndSignUninstaller 阶段 spawn EPERM。

2. 使用自定义 NSIS script 复用 electron-builder 默认 installer.nsi。
   目的：让 electron-builder 跳过“执行临时 installer 生成/签名 uninstaller”步骤。
   结果：确实绕过了 spawn EPERM，但 electron-builder 在 custom script 模式下不会预生成 UNINSTALLER_OUT_FILE，导致 installApplicationFiles 的 File 指令失败。

3. 尝试在 custom script 中安装时 WriteUninstaller。
   结果：需要把 uninstaller.nsh 纳入最终 installer；直接 include 会和 installer 侧 installUtil 变量重复。
   判断：继续维护自定义 NSIS 分叉风险过高，已回退 package.json 的 nsis.script 配置。
```

当前结论：

```txt
业务代码与 win-unpacked 运行正常。
安装包失败仍归类为 electron-builder/NSIS 在当前系统执行临时 installer 被拦截。
不要保留 189KB 半成品安装包。
暂不引入自定义 NSIS 分叉，避免后续安装/卸载逻辑偏离官方模板。
```

### 27.20 NSIS 安装包修复完成 - 2026-07-03

本轮继续处理安装包阶段阻塞。最终没有继续维护自定义 NSIS script，而是回到 electron-builder 官方模板，通过 NSIS 配置降低安装器提权路径。

已调整配置：

```txt
package.json
- nsis.perMachine = false
- nsis.selectPerMachineByDefault = false
- nsis.allowElevation = false
- nsis.packElevateHelper = false
- 保留 nsis.oneClick = false 和 allowToChangeInstallationDirectory = true
```

关键判断：

```txt
INSTALL_MODE_PER_ALL_USERS_REQUIRED 在 electron-builder assisted installer 中会默认出现。
它不等同于强制全用户安装；真正强制全用户安装对应 INSTALL_MODE_PER_ALL_USERS。
本轮改动重点是显式关闭 per-machine 默认项、关闭安装器提权和 elevate helper，避免再次触发系统策略拦截。
```

验证结果：

```txt
npm.cmd run build 通过。
electron-builder 成功生成 release/FloatingClock Setup 1.0.0.exe。
release/win-unpacked/FloatingClock.exe 烟测通过，可正常启动。
npm.cmd run test:media-search 通过，8 项测试全部通过。
release 已按规则清理，只保留 FloatingClock Setup 1.0.0.exe。
```

当前产物：

```txt
release/FloatingClock Setup 1.0.0.exe
大小约 650 MiB / 681,674,831 bytes。
```

### 27.21 MediaSearch 缓存清理闭环 - 2026-07-03

本轮继续推进 MediaSearch 基础运维能力。新增受控缓存清理入口，用于在视频 manifest、缩略图、后续帧向量或临时文件异常时快速恢复干净状态。

已实现：

```txt
electron/mediaCacheService.ts
- 新增 clearMediaSearchCache。
- 固定只清理 userData/media-search 下的 manifests、vectors、thumbnails、transcripts、ocr、temp。
- 清理后自动重建目录结构。
- 保留 tool-config.json，不会删除用户已配置的 FFmpeg 目录。
- 新增 setMediaSearchDirForTests，便于测试隔离。

electron/main.ts
- 新增 mediaSearch:clearCache IPC handler。
- 如果 MediaSearch 任务正在 running，拒绝清理，避免扫描/抽帧过程中删除工作目录。

shared/ipc-contract.ts / electron/preload.ts / src/services/mediaSearchBridge.ts
- 新增 MediaSearchClearCacheResult。
- ElectronAPI.mediaSearch 增加 clearCache。
- Renderer 不能传入任意路径，清理范围由主进程固定。

src/components/MediaSearchPanel.tsx
- 新增 Clear Cache 按钮。
- 清理成功后刷新状态、缓存统计和视频列表。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，9 项测试全部通过。
新增测试确认清理缓存会删除 manifest/thumbnail，但保留 tool-config.json。
```

### 27.22 P0d 视频代表帧索引 - 2026-07-03

本轮继续推进 MediaSearch 从“视频文件扫描”进入“帧级索引输入”阶段。当前版本先做代表帧抽取和 frame manifest，不直接接向量模型，避免把抽帧、embedding、检索三个风险点一次性混在一起。

已实现：

```txt
electron/videoFrameService.ts
- 新增视频代表帧规划 planVideoFrameTimestamps。
- 默认每 10 秒抽 1 帧，每个视频最多 12 帧。
- 抽帧输出到 userData/media-search/frames/<videoId>/<frameId>.jpg。
- 写入 manifests/video_frames.jsonl。
- 支持复用已存在的 done frame，避免重复抽帧。
- ffmpeg 不可用时记录 unavailable，不让任务崩溃。
- 新增 getVideoFrameManifestCount，用于 MediaSearch 状态栏显示 Frames 数量。

electron/mediaTaskQueue.ts
- MediaSearchStatus.indexedFrameCount 改为读取 frame manifest done 数量。
- startScan(mode=visual) 现在会先扫描视频 manifest，再进入 extract-video-frames 阶段。
- 任务进度会从 scan-video-files 切换为 extract-video-frames，并显示帧抽取进度。

src/components/MediaSearchPanel.tsx
- 新增 Build Frames 按钮。
- 用户选择视频或目录后，可单独构建代表帧索引。

electron/mediaCacheService.ts
- ensureMediaSearchDirs 增加 frames 目录。
- MediaSearchCacheStats 增加 frameBytes。
- Clear Cache 会清理 frames 目录并重建。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，10 项测试全部通过。
新增测试覆盖 frame 时间点规划，以及 Clear Cache 对 frames 目录的清理。
```

当前限制：

```txt
代表帧还没有接入 DINO/CLIP embedding。
还没有视频帧搜索 UI。
当前抽帧策略是固定间隔，尚未做关键帧检测、镜头变化检测或去重。
```

### 27.23 P0d 帧索引可视化 - 2026-07-03

本轮继续完善视频代表帧索引的可审计性。之前 Build Frames 已能生成 `video_frames.jsonl` 和 frame jpg，但 UI 只能看到 Frames 数字，无法直接确认抽出来的画面是否正确。现在已补齐帧列表读取和面板展示。

已实现：

```txt
shared/ipc-contract.ts
- 新增 MediaSearchFrameListResponse。
- MediaSearchVideoFrameRecord 增加 imageDataUrl。
- ElectronAPI.mediaSearch 增加 listFrames。

electron/main.ts
- 新增 mediaSearch:listFrames IPC。
- 默认返回前 500 帧，最大 2000 帧，避免一次性把大量图片塞进 Renderer。
- frame 图片读取继续限制在 userData/media-search 目录内。
- 单张 frame dataUrl 限制 1MB，防止异常大图拖垮 UI。

electron/preload.ts / src/services/mediaSearchBridge.ts
- 补齐 listFrames 白名单和 renderer bridge。

src/components/MediaSearchPanel.tsx
- 新增 View 选择：Videos / Frames。
- Frames 视图以网格显示 frame 缩略图、时间点、状态和 Open 按钮。
- 状态栏增加 Frame list / Frame total / Frame ok。

tests/media-search-guards.test.cjs
- 新增 video frame manifest loader 测试。
- 验证 malformed frame record 会被跳过。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，11 项测试全部通过。
```

当前意义：

```txt
现在 Build Frames 后可以直接在 MediaSearch 面板切到 Frames 查看抽帧结果。
这一步让后续接 DINO/CLIP embedding 前，能够先确认帧级输入是否正确。
```

### 27.24 P0e 视频帧 embedding 构建入口 - 2026-07-03

本轮开始把 MediaSearch 的视频代表帧接入现有 Vector/Embedding 能力。当前先实现构建入口，不单独新建模型加载流程，避免复制 DINO/CLIP 子进程逻辑。

已实现：

```txt
shared/ipc-contract.ts
- 新增 MediaSearchFrameEmbeddingRequest。
- ElectronAPI.mediaSearch 增加 buildFrameEmbeddings。

electron/videoFrameService.ts
- 新增 getVideoFramesDir。
- 新增 getReadyVideoFrameCount，只统计 status=done 且 imagePath 真实存在的 frame。

electron/main.ts
- 新增 mediaSearch:buildFrameEmbeddings IPC。
- 不接受任意路径，固定使用 userData/media-search/frames 目录作为 scanPaths。
- 复用现有 startEmbeddingBuild。
- 支持 dinov2_vitb14 和 clip_vit_base_patch32。
- 默认 backend=gpu。
- CLIP 默认 maxConcurrentEmbeddings=8，DINO 默认 1。
- 如果没有 ready frame，返回 Build Frames first。

electron/preload.ts / src/services/mediaSearchBridge.ts
- 补齐 buildFrameEmbeddings 白名单和 renderer bridge。

src/components/MediaSearchPanel.tsx
- 新增 DINO Frames 按钮。
- 新增 CLIP Frames 按钮。
- 只有 frameReadyCount > 0 时可点击。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，12 项测试全部通过。
新增测试确认 ready frame 只统计真实存在的 done 图片。
```

当前限制：

```txt
Frame embedding 进度暂时复用 Vector Embedding 全局进度，不在 MediaSearch 面板内单独显示。
Frame embedding 存入现有 vector-db embedding shard，后续还需要增加 frame -> video/timestamp 的搜索结果映射。
还没有实现视频语义搜索 UI。
```

### 27.25 P0e 视频帧 embedding 覆盖率 - 2026-07-03

本轮继续补齐 frame embedding 的可观测性。之前已经能点击 DINO Frames / CLIP Frames 启动构建，但 MediaSearch 面板看不出多少 frame 已经真正写入向量库。现在已增加覆盖率统计，便于定位后续搜索结果为空时的原因。

已实现：

```txt
shared/ipc-contract.ts
- 新增 MediaSearchFrameEmbeddingStats。
- ElectronAPI.mediaSearch 增加 getFrameEmbeddingStats。

electron/videoFrameService.ts
- 新增 getFrameEmbeddingStats。
- 流式读取现有 vector-db embedding shard，不把全部向量载入内存。
- 只统计 MediaSearch ready frame 对应的 imagePath。
- 分别统计 dinoEmbeddedFrames / clipEmbeddedFrames / missingDinoFrames / missingClipFrames。
- vectorDatabaseService 改为运行时动态 import，避免测试环境加载 Electron app 依赖。

electron/main.ts / preload.ts / src/services/mediaSearchBridge.ts
- 补齐 mediaSearch:getFrameEmbeddingStats IPC 链路。

src/components/MediaSearchPanel.tsx
- Refresh 时加载 frame embedding stats。
- 状态栏显示 DINO emb / CLIP emb。
- Clear Cache 后清空 frame embedding stats 显示。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，12 项测试全部通过。
```

当前意义：

```txt
用户现在可以确认 Build Frames 后有多少 ready frame，也可以确认 DINO Frames / CLIP Frames 后有多少 frame 已写入向量库。
下一步可以基于这些 frame embedding 做以图搜视频帧，并把命中结果映射回视频时间点。
```

### 27.26 P0f 相似视频帧检索 - 2026-07-03

本轮开始验证 frame embedding 到视频时间点的检索闭环。当前先实现“以已抽出的某一帧作为 query，查找相似视频帧”，不先做任意外部图片临时 embedding，避免把 query embedding、向量检索、结果映射三个风险点同时叠加。

已实现：

```txt
shared/ipc-contract.ts
- 新增 MediaSearchFrameSearchRequest。
- 新增 MediaSearchFrameSearchResponse。
- ElectronAPI.mediaSearch 增加 searchSimilarFrame。

electron/videoFrameService.ts
- 新增 searchSimilarVideoFrames。
- query frame 必须来自 video_frames.jsonl 且 imagePath 存在。
- 读取 query frame 的现有 DINO/CLIP embedding。
- 只在 MediaSearch ready frame 集合中匹配候选，不混入普通图片 embedding。
- 返回 videoPath、timestampMs、imagePath、vectorScore 等 frame 结果。

electron/main.ts
- 新增 mediaSearch:searchSimilarFrame IPC。
- frameId 限制为 SHA1 格式。
- topK 限制 1-200。
- 返回结果补充 frame imageDataUrl。

electron/preload.ts / src/services/mediaSearchBridge.ts
- 补齐 searchSimilarFrame 白名单和 bridge。

src/components/MediaSearchPanel.tsx
- Frames 视图每张图增加 Similar 按钮。
- 默认优先使用 CLIP embedding；没有 CLIP embedding 时使用 DINO。
- 搜索结果直接替换当前 Frames 网格，并显示命中数量和候选总数。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，12 项测试全部通过。
```

当前限制：

```txt
Similar 目前只能用已抽帧且已 embedding 的 frame 作为 query。
尚未支持任意外部图片搜视频。
尚未支持文本语义搜视频。
搜索实现当前按 embedding shard 扫描，后续可接入更高性能的 frame 专用 ANN / streaming index。
```

### 27.27 P0f 外部图片检索视频帧 - 2026-07-03

本轮把 MediaSearch 从“点某个已抽帧做 Similar”推进到“选择任意外部图片，检索已 embedding 的视频帧”。实现仍然复用现有 DINO/CLIP 子进程和 vector-db embedding shard，不新建模型加载链路。

已实现：

```txt
electron/frameQueryEmbeddingService.ts
- 新增外部图片临时 embedding 服务。
- 复用 clipEmbeddingChild.js / dinoEmbeddingChild.js 协议。
- 根据 modelService 校验模型必须已下载且 SHA 校验通过。
- 支持 backend=cpu/gpu，默认由调用方选择 gpu。
- 子进程带 120s 超时，失败时返回明确错误，不阻塞主进程。

electron/videoFrameSearchService.ts
- 新增 searchVideoFramesByImage。
- 只在 MediaSearch ready frame 集合内检索，不混入普通 ImageSearch 图片 embedding。
- 读取现有 vector-db embedding shard，按余弦相似度保留 TopK。
- 返回 videoPath、timestampMs、imagePath、vectorScore。

shared/ipc-contract.ts
- 新增 MediaSearchFrameImageSearchRequest。
- 新增 MediaSearchFrameImageSearchResponse。
- MediaSearchVideoFrameRecord 增加 vectorScore。
- ElectronAPI.mediaSearch 增加 selectQueryImage / searchFramesByImage。

electron/main.ts
- 新增 mediaSearch:selectQueryImage。
- 新增 mediaSearch:searchFramesByImage。
- 查询图片限制为 jpg/jpeg/png/webp/bmp/gif。
- 查询路径经过 safeShellPath 和 fs.statSync 校验。
- 返回结果补充 frame imageDataUrl。

electron/preload.ts / src/services/mediaSearchBridge.ts
- 补齐 preload 白名单和 renderer bridge。

src/components/MediaSearchPanel.tsx
- 新增 Query Image 按钮。
- 新增 Search Frames 按钮。
- 状态区显示当前 Query 图片文件名。
- 搜索结果进入 Frames 视图。
- frame 卡片显示 vectorScore 百分比。
```

验证结果：

```txt
npm.cmd run typecheck 通过。
npm.cmd run lint 通过。
npm.cmd run test:media-search 通过，12 项测试全部通过。
```

当前限制：

```txt
外部图片检索当前仍扫描 embedding shard，候选量大时速度依赖磁盘与 JSONL 解析。
下一步应推进 MediaSearch frame 专用索引或更细的流式搜索进度，减少大库检索时的等待感。
当前 UI 默认 topK=120，后续可暴露为面板可调参数。
```
