# 本地与 NAS AI 素材发现统一架构方案

> 状态：草案
> 更新日期：2026-08-11
> 范围：本地磁盘、移动硬盘、挂载网络盘、SSH/SFTP、Image Search、Media Search、Asset Library
> 文档执行系统：Codex / GPT-5 系列（精确小版本未公开）
> 任务执行系统：未分配
> 任务所有者：未分配
> 替代文档：无

## 目录

1. [决策摘要](#1-决策摘要)
2. [目标与非目标](#2-目标与非目标)
3. [当前能力与缺口](#3-当前能力与缺口)
4. [从 Lap 借鉴与不借鉴的内容](#4-从-lap-借鉴与不借鉴的内容)
5. [目标产品架构](#5-目标产品架构)
6. [统一数据源](#6-统一数据源)
7. [统一素材与索引数据模型](#7-统一素材与索引数据模型)
8. [分阶段扫描与索引流水线](#8-分阶段扫描与索引流水线)
9. [统一搜索与结果模型](#9-统一搜索与结果模型)
10. [NAS 与局域网设备方案](#10-nas-与局域网设备方案)
11. [UI 与产品信息架构](#11-ui-与产品信息架构)
12. [IPC、安全与失败恢复](#12-ipc安全与失败恢复)
13. [存储、模型与安装包治理](#13-存储模型与安装包治理)
14. [实施阶段与验收标准](#14-实施阶段与验收标准)
15. [测试与指标](#15-测试与指标)
16. [风险与待决策事项](#16-风险与待决策事项)
17. [验证记录](#17-验证记录)

## 1. 决策摘要

FloatingClock/Reasonix 后续不应把自己定义为通用照片管理器，也不应继续以“悬浮时钟 + 多工具面板”作为主要产品叙事。建议形成以下产品定义：

> 让 AI 搜索电脑、移动硬盘和局域网 NAS 中的全部素材，快速显示文件位置、大小、设备、相似内容和视频出现时间。

核心差异化由四部分组成：

1. Windows NTFS 上基于 Native addon 的 USN/MFT 高速发现，并在不可用时安全回退到 Win32 目录枚举。
2. 文件路径、大小、来源和在线状态先于缩略图、哈希和 AI 向量显示。
3. 图片、工程文件、视频帧、字幕、人物和主体进入统一检索入口。
4. 本机、移动硬盘、挂载网络盘和 SFTP/NAS 作为统一素材源，而不是互不相关的工具面板。

框架决策：

- 保留 Electron、React、TypeScript、现有安全 IPC、C++ Native addon 和测试体系。
- 不因 Lap 使用 Tauri/Vue 而整体重写；安装包主要体积来自模型、FFmpeg 和推理运行时，仅更换桌面壳不能解决核心问题。
- 可以在新增性能热点中评估 Rust sidecar 或 `napi-rs`，但必须以独立模块和可量化收益为前提。
- 借鉴 Lap 的文件夹优先、组合资产、清晰产品边界、跨平台发布和用户数据说明，不复制 GPL-3.0 源码。

当前实施顺序决策（2026-08-11）：

1. 先完成新增功能方案和技术主链：统一来源、Discovery Catalog、稳定素材身份、分阶段索引、统一搜索、挂载网络盘/SFTP 和统一视频结果。
2. 技术阶段使用 `FloatingClock/Reasonix` 作为工作名称，不要求先确定正式产品名。
3. 版权/经营主体、正式产品名称、闭源商业模式、最终 EULA、隐私政策、退款和授权条款统一放到后续商业化阶段。
4. 顺序后移不等于取消发布阻断：上述商业事项完成前，只能继续开发和内部验证，不能把现有安装包标记为正式商业 Release。

## 2. 目标与非目标

### 2.1 产品目标

1. 用户不需要先整理文件夹或导入封闭图库，就能搜索分散素材。
2. 扫描启动后尽快显示文件名、路径、大小、类型、来源和时间，不等待 AI 建库完成。
3. 搜索覆盖本机磁盘、移动硬盘、已挂载网络盘和受控的 SFTP/NAS 数据源。
4. 支持文件名、元数据、自然语言、查询图片、人物、主体、相似图、视频画面和字幕搜索。
5. 搜索结果始终指向权威原文件；缩略图、预览代理和向量只是可重建派生数据。
6. NAS 离线、扫描中断、模型缺失或向量损坏时，基础目录和元数据搜索仍然可用。
7. 所有移动、覆盖、删除和远程写操作保持现有 fail-closed、预览、确认和审计原则。

### 2.2 工程目标

1. 建立稳定的 `SourceId`、`FileEntryId` 和 `AssetId`，消除各模块仅以绝对路径关联数据的长期风险。
2. 明确每类数据的权威存储，不再让 manifest、SQLite、JSONL、向量文件和缓存互相竞争事实来源。
3. 将发现、元数据、预览、哈希、embedding 和视频深度索引拆成可暂停、恢复和重试的阶段。
4. 复用现有 Native、向量、Asset Library、Remote SFTP、事务、备份和故障注入能力，避免推倒重来。
5. 为真实 10 万、100 万文件和 NAS 场景建立持续性能与正确性基线。

### 2.3 非目标

1. 本方案不把项目改造成 Lap 的复刻品，也不以相册、地图或摄影工作流替代素材发现主线。
2. 本方案不立即实现跨平台；第一阶段仍以当前 Windows/NTFS 产品为主，但通过适配器隔离平台依赖。
3. 本方案不立即实现通用 FTP。普通 FTP 缺少传输加密，远程入口优先使用已挂载 SMB 和 SFTP。
4. 本方案不要求首阶段部署 NAS Agent；NAS Agent 是大库和低带宽场景的后续增强。
5. 本方案不把 Remote Terminal 的端口转发、命令片段等运维能力列为素材搜索前置条件。
6. 本方案不在缺少真实基准前承诺具体扫描速度、搜索延迟或准确率数字。

## 3. 当前能力与缺口

### 3.1 已实现且应直接复用

| 能力 | 当前证据入口 | 复用结论 |
| --- | --- | --- |
| NTFS 高速发现 | `native/fast_scanner.cc` | 已实现 USN Journal 查询、全 MFT 枚举、完整父目录 FRN 图和 Win32 枚举回退；继续作为本地发现主后端 |
| Native Image Search | `electron/imageSearchService.ts` | 已封装 Native addon 加载、扫描、进度、索引和图像搜索；后续通过 source/catalog 服务调用，不让 UI 直接理解后端 |
| 向量持久化 | `electron/authoritativeVectorStore.ts`、`electron/embeddingIncrementLog.ts` | 已有 generation、manifest 内容证明、增量日志和损坏拒绝；继续作为可重建派生索引 |
| Asset Library SQLite | `electron/assetLibraryDatabase.ts`、`electron/assetLibraryStorageContext.ts` | 已默认使用 SQLite 作为关系写入模式；继续保存分类、标签、建议和用户整理关系 |
| 搜索目录投影 | `electron/assetCatalogProjection.ts`、`electron/assetMetadataStore.ts` | 已有 SQLite 查询投影和 source fingerprint；可作为统一目录演进的迁移基础 |
| SFTP 浏览与传输 | `electron/remoteSftpService.ts`、`electron/remoteTransferService.ts` | 已支持目录浏览、分页、上传、下载和文件操作；作为远程数据源传输层复用 |
| 远程安全 | `electron/remoteCredentialService.ts`、`electron/remoteTerminalService.ts` | 已有 `safeStorage`、profile 校验和主机指纹确认；统一数据源不能绕过这些边界 |
| 工程文件预览 | `electron/projectPreview*` | 已有预览代理方向；代理只能参与解码和特征计算，结果身份仍是源文件 |
| 视频检索 | `electron/mediaSearch*` | 已有扫描、抽帧、字幕、帧向量和多模态链路；后续统一结果模型，不重写算法主体 |
| 安全与 QA | `tests/`、`scripts/release-gate.cjs` | 已有 IPC、事务、索引、向量、远程传输、资源和构建测试；新架构必须沿用门禁 |

### 3.2 当前关键缺口

1. Image Search、Media Search、Asset Library、Duplicate Finder 和 Remote SFTP 仍以各自入口和状态模型工作，没有统一的素材源与文件身份。
2. SFTP 当前是远程文件浏览和传输能力，尚未作为 Image/Media Search 的统一 AI 索引数据源。
3. 本地快速发现与 AI embedding 的阶段虽然已经存在，但用户侧没有形成统一、稳定、可解释的阶段状态模型。
4. 文件路径在多处仍承担事实主键职责；移动硬盘盘符变化、NAS 重挂载、远程重命名会导致修复成本。
5. SQLite、manifest、JSONL、F16 向量和缓存各有合理用途，但权威边界需要统一文档和服务约束。
6. Remote Terminal 的产品表现偏运维工具，没有把 SSH/SFTP 解释为 NAS 素材入口。
7. 当前产品功能很多，但首页和默认导航不能用一句话引导用户完成“添加来源 → 快速发现 → AI 建库 → 搜索取回”的主流程。

## 4. 从 Lap 借鉴与不借鉴的内容

### 4.1 借鉴

1. **文件夹优先**：原文件留在用户目录，应用保存索引和整理信息，不制造强制导入和封闭图库。
2. **组合资产**：RAW + JPEG、Live Photo + MOV/AAE 等多文件关系作为一个逻辑素材处理；本项目扩展到视频 + 字幕、PSD + 导出图、原视频 + Proxy、工程文件 + 预览代理。
3. **统一图库心智**：时间、文件夹、来源、标签、评分、人物和集合是同一素材库的不同视图，不应成为互不相干的工具。
4. **明确数据说明**：区分原文件、用户整理数据、索引、缩略图、向量和模型，说明卸载、备份、外部移动文件的影响。
5. **发布工程**：学习多架构构建、自动更新、版本迁移、签名/公证、安装与卸载说明。
6. **大库浏览体验**：可见区域优先、虚拟列表、分组浏览和渐进加载应成为统一 UI 基础能力。

### 4.2 不借鉴

1. 不迁移 Vue/Pinia；React/Zustand 不是当前产品问题的根因。
2. 不整体迁移 Tauri；现有 Electron 安全边界、Native、SSH2 和测试的重写风险高于短期收益。
3. 不采用数千行单文件组件或数据库模块；新代码必须按来源、目录、任务、搜索和传输领域拆分。
4. 不降低自动化测试强度；公开项目的真实用户反馈不能替代本项目的事务、索引和故障注入测试。
5. 不复制 GPL-3.0 代码。仅借鉴公开产品概念和通用架构模式，闭源分发前继续执行现有许可证门禁。

## 5. 目标产品架构

```text
┌──────────────────────────────────────────────────────────┐
│                    React / Electron UI                   │
│ Search │ Sources │ Library │ Organize │ Tasks │ Settings │
└──────────────────────────┬───────────────────────────────┘
                           │ typed IPC contract
┌──────────────────────────▼───────────────────────────────┐
│                    Application Services                  │
│ Source │ Catalog │ Search │ Index Task │ Transfer │ Ops │
└────────────┬──────────────┬──────────────┬────────────────┘
             │              │              │
┌────────────▼─────┐ ┌──────▼───────┐ ┌────▼──────────────┐
│ Discovery Catalog│ │ Search Engine │ │ Task Orchestrator │
│ SQLite authority │ │ lexical/vector│ │ priority/recovery │
└────────────┬─────┘ └──────┬───────┘ └────┬──────────────┘
             └──────────────┼───────────────┘
                            │
                   ┌────────▼────────┐
                   │ Source Adapters │
                   └────────┬────────┘
          ┌─────────────────┼───────────────────┐
          │                 │                   │
   Local NTFS/USN    Mounted/SMB path      SFTP/NAS Agent
   Native + fallback  bounded filesystem    remote metadata
```

### 5.1 分层职责

#### Renderer

- 只维护可展示状态、搜索条件、选择和进度。
- 不持有 SSH client、文件句柄、密钥、任意本地路径授权或模型实例。
- 通过稳定 ID 操作素材，不把绝对路径作为写操作授权。

#### IPC Contract

- 统一输入校验、sender 授权、分页、取消、确认 token 和错误码。
- 搜索结果可以返回展示路径，但删除、移动、传输等写操作必须使用短期授权 token。

#### Application Services

- 编排来源、扫描、目录、搜索、索引和传输。
- 不在 IPC handler 中直接堆叠业务实现。

#### Source Adapter

- 负责特定来源的枚举、stat、读取范围、变化检测和可用性。
- 不负责用户标签、向量排序或 UI。

#### Discovery Catalog

- 保存来源、物理文件、逻辑素材、扫描 checkpoint 和索引阶段状态。
- 是“文件在哪里、大小多少、是否在线”的权威来源。

#### Derived Stores

- 缩略图、预览代理、hash、embedding、ANN 和视频帧索引均可重建。
- 每个派生物必须记录源文件指纹、生成器版本和完整性证明。

## 6. 统一数据源

### 6.1 类型

```ts
type SourceType =
  | 'local-ntfs'
  | 'local-generic'
  | 'removable'
  | 'mounted-network'
  | 'sftp'
  | 'nas-agent'

interface DataSource {
  id: string
  type: SourceType
  displayName: string
  rootLocator: string
  readOnly: boolean
  availability: 'online' | 'offline' | 'degraded' | 'unknown'
  scanCapability: 'usn' | 'directory' | 'remote-list' | 'agent'
  lastAttemptAt?: number
  lastSuccessfulScanAt?: number
  lastCompleteReconcileAt?: number
}
```

`rootLocator` 由主进程保存。Renderer 获取脱敏显示值；SFTP locator 不包含明文凭据。

### 6.2 适配器接口

```ts
interface SourceAdapter {
  probe(sourceId: string): Promise<SourceProbeResult>
  enumerate(request: EnumerateRequest): AsyncIterable<DiscoveredEntry>
  stat(fileEntryId: string): Promise<FileStatResult>
  openRead(request: ReadRequest): Promise<ReadGrant>
  getChangeCursor?(sourceId: string): Promise<ChangeCursor | null>
  enumerateChanges?(cursor: ChangeCursor): AsyncIterable<SourceChange>
}
```

约束：

1. `enumerate()` 必须支持取消、批量提交和有界内存。
2. 适配器返回统一错误码，不把 `ssh2`、Win32 或 Node 原始异常直接暴露给 UI。
3. 只在一次完整且成功的 reconcile 后标记缺失文件；离线、权限错误、取消和断线不能等价为删除。
4. 本地 NTFS 适配器优先使用当前 USN/MFT 后端，失败后沿用当前目录枚举回退和退化原因。
5. 挂载网络盘首版使用受限目录枚举，不宣称具备 NTFS USN 能力。

### 6.3 稳定来源身份

- 本地卷：卷标识、文件系统类型、规范化根路径和用户确认的来源 ID。
- 移动盘：优先卷标识，不以易变化盘符作为唯一身份。
- 挂载网络盘：UNC 根或用户选择的挂载根 + 来源 ID。
- SFTP：profile ID + 经确认的主机指纹 + 规范化远程根目录。
- NAS Agent：agent installation ID + 数据集 ID + 双向认证身份。

## 7. 统一素材与索引数据模型

### 7.1 物理文件与逻辑素材分离

```ts
interface FileEntry {
  id: string
  sourceId: string
  relativePath: string
  name: string
  extension: string
  sizeBytes: number
  modifiedAt: number
  createdAt?: number
  filesystemIdentity?: string
  availability: 'online' | 'offline' | 'missing' | 'unknown'
  quickFingerprint?: string
  contentHash?: string
}

interface Asset {
  id: string
  primaryFileEntryId: string
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'project' | 'other'
  width?: number
  height?: number
  durationMs?: number
}

interface AssetMember {
  assetId: string
  fileEntryId: string
  role: 'primary' | 'raw-companion' | 'sidecar' | 'subtitle' | 'proxy' | 'preview'
}
```

### 7.2 身份策略

1. 扫描首阶段立即创建 `FileEntryId`，不能等待完整哈希。
2. 本地 NTFS 优先使用来源 ID + 文件系统身份识别重命名；不可用时退化为路径、大小和 mtime 组合。
3. SFTP 首版使用来源 ID + 规范化远程路径；若服务端提供可靠 inode/文件 ID，可作为辅助证据而非跨系统承诺。
4. 完整 hash 只用于内容确认、重复合并和迁移修复，不能阻塞首次展示。
5. 不因为 hash 相同自动把两个物理位置折叠为一个结果；UI 必须能够显示一个素材的多份位置和来源。

### 7.3 权威存储边界

| 数据 | 权威位置 | 可否重建 |
| --- | --- | --- |
| 来源配置、根目录、可用性 | Discovery Catalog + 安全凭据存储 | 部分可重建 |
| 文件路径、大小、时间、来源 | Discovery Catalog SQLite | 可从源重新扫描，但离线时不可立即恢复 |
| 标签、评分、集合、分类反馈 | 现有 Asset Library SQLite | 不应视为可随意重建 |
| 缩略图、工程预览 | 缓存目录 + catalog artifact 记录 | 可以 |
| hash、DINO/CLIP、人物/主体向量 | Authoritative Vector Store/派生索引 | 可以，但重建成本高 |
| ANN | 向量投影 | 可以 |
| 视频帧、字幕和帧向量 | Media Search 派生存储 | 可以，但重建成本高 |
| 模型与 FFmpeg/runtime | 资源 manifest | 可以重新获取或离线安装 |

迁移原则：首阶段不强行把现有多个 SQLite 文件物理合并。先建立统一 catalog service 和稳定 ID，再以 shadow projection、读一致性和备份恢复验证决定是否合并文件。目标是每个领域只有一个权威写入者，而不是追求“只有一个数据库文件”。

### 7.4 建议表

```text
sources
file_entries
assets
asset_members
scan_sessions
scan_checkpoints
index_states
derived_artifacts
source_health_events
```

`index_states` 至少按文件和阶段记录：

```text
discovered → metadata-ready → preview-ready → hash-ready
           → image-embedding-ready
           → subject/face-ready
           → video-frame-ready
           → failed/retryable/stale
```

## 8. 分阶段扫描与索引流水线

### 8.1 阶段定义

#### D0：来源探测

- 确认来源在线、文件系统类型、访问权限和扫描能力。
- NTFS 报告 USN 是否可用以及明确退化原因。
- SFTP 先校验 profile、凭据和主机指纹，再读取远程根。

#### D1：快速发现

- 写入路径、文件名、大小、扩展名、mtime、来源和基础身份。
- 按批次提交 SQLite，首批数据立即供 UI 查询。
- 不读取完整文件，不等待缩略图和模型。

#### D2：基础元数据

- 分类图片、视频、音频、文档和工程文件。
- 读取受限 EXIF、尺寸、时长和安全元数据。
- 建立文件夹、扩展名、大小和时间聚合。

#### D3：预览

- 当前可见结果优先生成缩略图、视频封面和工程预览。
- 预览代理不能替代源文件身份。
- 离线源可继续展示已有缩略图，但必须显示离线状态。

#### D4：哈希和重复关系

- 快速 fingerprint 用于变化检测。
- 完整 hash 用于精确重复。
- 感知 hash、分段和视觉向量用于近重复和相似素材。

#### D5：图片 AI

- DINO/CLIP embedding。
- 可选中文/多语言文本模型。
- 人脸、人物 ReID、主体 crop、分类和反馈重排。

#### D6：视频深度索引

```text
视频元数据
→ 代表帧/场景切分
→ 帧 embedding
→ 字幕/文本索引
→ 多模态融合
→ 时间点结果
```

### 8.2 调度优先级

```text
P0 当前屏幕可见文件与用户显式查询
P1 当前文件夹、集合或搜索范围
P2 新增、修改和用户近期访问文件
P3 后台全库 embedding 与视频深度索引
P4 完整性证明、GC、迁移和低优先级修复
```

约束：

1. D1 不得被 D3-D6 饥饿或占满队列。
2. GPU 任务不得阻塞 Native 发现、SQLite 查询和文件操作。
3. NAS 读取必须有独立并发、带宽和超时预算，不能复用本地盘默认值。
4. 用户暂停来源时，已提交 catalog 批次保留，未完成阶段保持可恢复状态。
5. 任务重启后根据 source fingerprint、生成器版本和 artifact proof 决定复用或重建。

## 9. 统一搜索与结果模型

### 9.1 查询类型

统一搜索入口支持：

- 文件名、路径、扩展名和项目关键词。
- 大小、时间、来源、在线状态、图片尺寸和视频时长过滤。
- 自然语言文本搜索。
- 查询图片、剪贴板截图和以图搜图。
- 人物、主体、颜色、分类和反馈搜索。
- 视频字幕、画面和时间点搜索。
- 精确重复、近重复和多位置副本。

### 9.2 检索流程

```text
查询解析
  → 来源/类型/大小/时间等元数据过滤
  → 文件名和文本倒排召回
  → CLIP/DINO/人物/主体/视频帧多路召回
  → 统一候选去重与多位置聚合
  → 反馈、相关度、在线状态和质量重排
  → 分页/流式返回
```

基础元数据查询必须在 AI 模型不可用时独立工作。向量搜索失败时返回明确退化原因，不把“模型未准备”伪装成空结果。

### 9.3 结果契约

```ts
interface UnifiedAssetSearchResult {
  assetId: string
  primaryFileEntryId: string
  mediaType: string
  displayName: string
  displayPath: string
  sizeBytes: number
  source: {
    id: string
    name: string
    type: SourceType
    availability: 'online' | 'offline' | 'degraded' | 'unknown'
  }
  preview?: { url: string; status: string }
  dimensions?: { width: number; height: number }
  durationMs?: number
  videoHitMs?: number
  score?: number
  scoreBreakdown?: Record<string, number>
  indexState: string[]
  alternateLocations?: Array<{
    fileEntryId: string
    sourceId: string
    displayPath: string
    availability: string
  }>
  actionToken?: string
}
```

`displayPath` 用于展示，`actionToken` 用于受控打开、拖出、复制或传输。Renderer 不能把任意展示路径重新提交为写操作授权。

## 10. NAS 与局域网设备方案

### 10.1 第一层：已挂载 SMB/NFS/WebDAV

首个可交付版本优先支持操作系统已挂载路径：

1. 用户通过“添加数据源”选择网络盘或 UNC 下的允许目录。
2. 使用 `mounted-network` adapter 和保守目录枚举。
3. 限制并发、打开文件数、stat 频率和缩略图读取。
4. 将断线、权限拒绝和完整扫描成功区分开。
5. 网络盘符变化时按来源 ID 提供路径修复，不立即新建重复来源。

### 10.2 第二层：SFTP 素材源

复用现有 Remote Terminal/SFTP：

- profile、凭据和主机指纹继续由现有安全服务管理。
- `remoteSftpService` 继续负责分页列目录、stat 和传输。
- 新增 SFTP source adapter，把目录条目批量写入 Discovery Catalog。
- 第一阶段只建立远程元数据目录，缩略图和 AI 索引按需或按策略下载。
- 用户命中结果后通过现有 transfer queue 取回文件。

默认策略：

| 能力 | 默认 |
| --- | --- |
| 远程来源权限 | 只读 |
| 自动下载原文件 | 关闭 |
| 缩略图读取 | 当前可见/用户选择优先 |
| AI 建库 | 用户显式开启并设置缓存/带宽预算 |
| 删除与重命名 | 关闭；启用后仍需二次确认 |
| 断线处理 | 保留目录，标记离线，不删除记录 |

### 10.3 第三层：NAS Agent

大库场景可部署轻量 Agent：

```text
NAS Agent
  ├─ 本地枚举与增量变化
  ├─ 元数据和 hash
  ├─ 缩略图/代表帧
  ├─ 可选 embedding
  └─ 加密返回 manifest/delta/artifact
```

最小协议能力：

- `capabilities`
- `snapshot.begin/page/end`
- `changes.after(cursor)`
- `preview.get(fileId)`
- `content.range(fileId)`
- `hash.get(fileId)`
- `health`

Agent 不是本方案近期前置条件。开始实现前必须单独完成认证、升级、权限、协议版本、恶意响应、路径越界和许可证设计。

### 10.4 Remote Terminal 的产品位置

产品主导航不再把终端作为与素材搜索并列的默认卖点。建议入口：

```text
数据源 → NAS/远程设备 → 高级工具 → 打开终端
```

SFTP 浏览、上传和下载则直接融入“查看来源”“取回素材”“复制到 NAS”等素材工作流。终端能力继续保留给高级用户，但不影响普通用户理解产品。

## 11. UI 与产品信息架构

### 11.1 默认导航

```text
搜索
数据源
素材库
重复与整理
后台任务
设置
```

悬浮时钟、计算器、App Storage 和 Remote Terminal 可以保留为可选工具、工作区预设或高级入口，不作为首次启动的主流程。

### 11.2 首次使用

1. 选择本机目录、磁盘、移动盘或 NAS 来源。
2. 立即进入快速发现，显示文件数、大小、路径和来源。
3. 解释基础目录已经可搜索，AI 索引正在后台继续。
4. 用户选择是否下载/启用图片语义、人物、主体或视频模型。
5. 明确显示预计空间、设备要求、任务进度和可取消性。

### 11.3 首页

```text
┌─────────────────────────────────────────────────┐
│ 搜索电脑、移动硬盘和 NAS 中的全部素材           │
├─────────────────────────────────────────────────┤
│ 本机 SSD    在线    320,000 文件   AI 92%       │
│ 工作室 NAS  在线  1,200,000 文件   元数据完成    │
│ 移动硬盘    离线     82,000 文件   上次扫描...   │
├─────────────────────────────────────────────────┤
│ 最近搜索 │ 最近素材 │ 待处理重复 │ 后台任务       │
└─────────────────────────────────────────────────┘
```

### 11.4 搜索结果

每张结果卡至少显示：

- 缩略图或明确占位状态。
- 文件名、大小、格式、来源设备和路径。
- 在线、离线、缺失或退化状态。
- 图片尺寸或视频时长。
- 语义/相似度及可解释命中来源。
- 视频命中时间点。
- AI 阶段状态，不把“未索引”显示成“无结果”。

视图至少支持网格、列表、来源、文件夹、相似组、重复组和视频时间点。时间线、评分、标签、集合和对比视图可学习 Lap，但优先级低于统一来源和结果可解释性。

## 12. IPC、安全与失败恢复

### 12.1 建议 IPC 域

```text
sources:list/add/update/remove/probe
sources:scan/start/pause/resume/cancel/status
catalog:query/stats/locations
search:query/cancel/explain
assets:preview/open/reveal/drag
assets:copy/move/delete/rename
remote:transfer/enqueue/cancel/retry
tasks:list/cancel/retry
```

IPC contract 放入 `shared/ipc/` 对应领域文件；主进程 handler 只做 sender、schema、授权和服务调用。

### 12.2 安全原则

1. 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
2. 来源根目录由主进程保存和校验，Renderer 不能扩大扫描边界。
3. 本机、NAS、SFTP 分别设置只读/可写权限；默认只读。
4. SSH 凭据继续使用 `safeStorage`，主机指纹变化继续 fail closed。
5. 删除、覆盖、批量移动和远程写操作必须先生成预览和确认 token。
6. AI Control API 默认关闭、只监听 loopback，并继续执行 scope、幂等和人工确认。
7. 模型、预览提供器和 NAS Agent 响应都视为不可信输入，执行大小、像素、路径、数量和超时限制。

### 12.3 失败语义

| 事件 | 正确行为 |
| --- | --- |
| NAS 断线 | 保留目录和缩略图，来源标记离线，不删除文件记录 |
| 扫描取消 | 已提交批次保留，session 标记取消，可从 checkpoint 恢复 |
| 权限拒绝 | 来源标记 degraded，记录受影响目录，不把未访问文件标记 missing |
| 完整 reconcile 成功后未发现文件 | 先标记 missing，经过策略确认后再清理派生索引 |
| 模型缺失 | 元数据搜索正常，AI 能力显示未准备 |
| 向量损坏 | 拒绝读取损坏 generation，回退或排队重建 |
| 盘符变化 | 根据卷/来源身份提示路径修复，不直接建立重复来源 |
| SFTP 指纹变化 | 阻断连接，要求用户重新核验，不自动接受 |

## 13. 存储、模型与安装包治理

### 13.1 资源分层

#### Core

- Electron/Renderer。
- Native Scanner。
- SQLite 目录。
- 基础缩略图和元数据。
- 文件名、路径、大小和重复搜索。

#### 按需能力包

- 图片语义模型。
- 中文/多语言文本模型。
- 人脸与人物模型。
- 主体/SAM 模型。
- 视频抽帧和语义模型。
- CUDA runtime。

### 13.2 在线与离线包

- Online：小型核心安装包，模型按需下载并做 hash/许可证验证。
- Offline：按 profile 携带审核通过的模型和工具。
- 每个能力包显示下载大小、安装后占用、适用设备、版本和删除入口。
- 删除模型不删除用户目录、标签、集合或基础 catalog；只使对应 AI 能力进入未准备状态。

### 13.3 数据清理

清理 UI 必须区分：

1. 原始文件：默认永不自动删除。
2. 用户整理数据：删除前备份和强确认。
3. 缩略图/预览：可重建。
4. 向量/ANN/视频帧：可重建但成本高，显示预计重建时间和空间。
5. 模型/runtime：可重新下载，离线用户需提示后果。

## 14. 实施阶段与验收标准

### Phase 0：冻结边界与建立基准

任务：

1. 批准新增功能的技术范围、默认工作流和非目标；正式产品名与商业条款不作为本阶段前置条件。
2. 对本地 NTFS、HDD、SSD、移动盘和挂载 NAS 建立真实基准。
3. 固定 10 万/100 万文件的合成结构和至少一组脱敏真实素材集。
4. 记录首次路径/大小出现、全量发现、缩略图、hash、embedding 和搜索延迟。

验收：

- 形成可复现 benchmark 命令和原始报告。
- 不以单次日志或文档推测替代真实结果。
- 明确当前 manifest、SQLite、向量和缓存的权威边界图。

### Phase 1：统一来源与文件目录

任务：

1. 新增 `DataSource`、`FileEntry`、`ScanSession` 和 `IndexState` 契约。
2. 以适配器封装当前 Native 本地扫描。
3. 将发现批次投影到统一 Discovery Catalog。
4. UI 首屏显示来源、路径、大小和扫描阶段。

验收：

- AI 模型未下载时仍可完成路径、大小和文件名搜索。
- 扫描中可以查询已提交批次。
- USN 不可用时显示回退原因，结果完整性与目录枚举基线一致。
- 取消、重启和重复扫描不会产生重复 `FileEntry`。

### Phase 2：统一图片/素材库身份

任务：

1. 为 Image Search 和 Asset Library 建立稳定 `AssetId` 映射。
2. 保留现有索引文件，以 shadow projection 验证统一目录结果。
3. 引入 `AssetMember`，支持工程预览、RAW companion 和 sidecar。
4. 统一打开、定位和原文件拖出动作。

验收：

- 搜索、素材库和重复组对同一文件返回同一稳定 ID。
- 预览代理永远不会被当成用户可见原文件。
- 文件移动后标签、分类和索引可以按身份修复。
- 备份恢复覆盖新增 ID 映射。

### Phase 3：统一分阶段任务与搜索

任务：

1. 接入统一任务调度和优先级。
2. 合并元数据、文件名、图片语义、主体和重复召回结果。
3. 为结果增加 `indexState` 和退化原因。
4. 可见区域优先生成预览和 embedding。

验收：

- D1 不被 GPU/视频任务阻塞。
- AI 未完成时先返回元数据结果，完成后可增量增强排序。
- 向量损坏、模型缺失和任务失败均有可操作状态，不返回误导性空结果。
- 现有准确率门禁和索引完整性测试不下降。

### Phase 4：挂载网络盘与 SFTP

任务：

1. 增加 `mounted-network` adapter。
2. 将现有 SFTP 列目录和传输能力封装为 `sftp` adapter。
3. 建立远程元数据目录、离线状态和按需预览。
4. 搜索结果支持通过 transfer queue 取回素材。

验收：

- NAS 断线、权限失败或扫描取消不会导致目录误删除。
- SFTP 指纹变化继续阻断。
- 默认只读；开启写操作后仍执行确认、冲突和审计。
- 限速和并发策略不会阻塞本地搜索。
- 远程原文件未下载时，UI 明确区分仅元数据、已有预览和完整 AI 索引。

### Phase 5：统一视频搜索

任务：

1. Media Search 使用统一来源与 `AssetId`。
2. 视频帧结果聚合回原视频和具体时间点。
3. 本地与 NAS 视频应用不同抽帧、缓存和带宽策略。
4. 搜索入口统一文本、图片、字幕和画面查询。

验收：

- 结果显示原视频路径、来源、大小、时长和命中时间点。
- 本地视频与远程视频的退化原因可解释。
- 删除帧缓存不会丢失原视频或用户整理数据。
- 真实视频基准记录召回、时间点误差、索引时间和空间占用。

### Phase 6：产品界面与交付工程

任务：

1. 主界面收敛为搜索、来源、素材库、整理、任务和设置。
2. Remote Terminal 移入远程来源高级工具。
3. 实现 Online/Offline profile、按需模型和自动更新。
4. 完成升级迁移、回滚、数据导出、数据清理和卸载技术说明。

验收：

- 新用户可以不理解 Image/Media/Neko 内部模块名完成首次建库和搜索。
- 安装包资源与能力 profile 一致，不携带未声明模型。
- 上一正式版升级、数据库迁移、模型迁移和 packaged smoke 通过。
- 内部候选包通过资源、构建、迁移、packaged smoke 和准确率门禁。
- 本阶段产物仍是内部候选，不因功能完成而自动获得商业发布资格。

### Phase 7：商业合规与正式发布

本阶段在新增功能主链和内部候选稳定后执行。

任务：

1. 确定版权/经营主体、正式产品名称和品牌归属。
2. 确定闭源商业模式、销售区域、Free/Pro/Studio 边界和设备授权方式。
3. 完成最终 EULA、隐私政策、退款政策、授权条款和必要的用户确认流程。
4. 对项目、随包模型、FFmpeg、Native addon、CUDA/cuDNN 等组件作出真实许可证决定，补齐许可证正文、NOTICE、审批人与证据。
5. 配置 Authenticode 签名和可信时间戳，执行完整 `release:gate`。
6. 生成并归档 SBOM、安装器哈希、签名验证、唯一提交、正式 release record 和回滚材料。

验收：

- `legal/license-decisions.json` 中项目与目标 profile 的随包组件均有真实授权结论，许可证门禁通过。
- 最终 EULA、隐私政策、退款与授权条款由具备权限的负责人批准，不使用模板或占位内容冒充正式文件。
- 安装器签名有效，签名主体、产品名称、官网和协议主体一致。
- 完整 release gate 从干净源码、资源验证、测试、打包、packaged smoke、签名到 release record 全链通过。
- 只有完成本阶段后，安装包才可以标记为正式商业 Release。

## 15. 测试与指标

### 15.1 性能指标

必须分别记录：

- 开始扫描到首批路径/大小可见时间。
- 每秒发现文件数及总发现时间。
- SQLite 批次写入和查询 P50/P95。
- 可见缩略图完成时间。
- hash、DINO、CLIP、主体和视频帧各阶段吞吐。
- 热缓存和冷缓存搜索延迟。
- NAS 元数据首屏、全量目录、缩略图和取回耗时。
- 索引占用、缓存占用、模型占用和原始素材总量。

维度至少包含：

- SSD/HDD。
- NTFS USN/目录枚举回退。
- 小文件/大文件、浅目录/深目录。
- 10 万/100 万文件。
- 本地/移动盘/挂载网络盘/SFTP。
- 来源在线、离线、断线重连。
- 扫描同时搜索和扫描同时生成 embedding。

量化门槛应在 Phase 0 真实基线后写入 benchmark 文档，本文不预设不可验证数字。

### 15.2 搜索质量

- 文件名和路径结果正确率。
- 文本语义 Recall@K、Precision@K、nDCG。
- 以图搜图和近重复 P@K。
- 人物误匹配率、主体侵入率。
- 视频片段 Recall@K 和命中时间误差。
- 本地与远程同内容的多位置聚合正确率。
- 用户 Accept/Reject 后的重排变化和回归门禁。

### 15.3 正确性与恢复

新增测试簇建议：

```text
tests/source-adapter-contract.test.cjs
tests/source-catalog.test.cjs
tests/source-reconcile.test.cjs
tests/source-offline-semantics.test.cjs
tests/sftp-source-index.test.cjs
tests/unified-asset-identity.test.cjs
tests/unified-search-degradation.test.cjs
tests/index-stage-scheduler.test.cjs
tests/catalog-migration.test.cjs
tests/nas-bandwidth-policy.test.cjs
```

测试必须覆盖事务中断、进程退出、网络断线、凭据失败、主机指纹变化、盘符变化、路径越界、重复扫描、文件重命名、来源离线和派生索引损坏。

## 16. 风险与待决策事项

### 16.1 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 一次性重写现有索引 | 高回归、数据迁移失败 | 采用 adapter + shadow projection + 读一致性迁移 |
| NAS 全量读取原文件 | 带宽、延迟、隐私和设备负载 | 元数据优先、预览按需、独立预算、后续 Agent |
| 路径作为唯一身份 | 盘符或重命名导致索引丢失 | 稳定来源 ID、文件系统身份、hash 修复 |
| 离线误判删除 | 用户标签和派生索引被错误清理 | 只有完整成功 reconcile 才能标记 missing |
| 功能继续扩散 | 产品不可理解、维护成本上升 | 新功能必须服务于“发现、理解、定位、取回素材” |
| 模型与运行时膨胀 | 安装包和更新成本过高 | Core + 按需能力包 + 资源 manifest |
| Tauri/Rust 重写冲动 | 消耗周期但不提升核心价值 | 只对可测量热点采用独立 Rust/Native 模块 |
| GPL 代码复用 | 闭源商业分发合规风险 | 只借鉴概念，继续许可证扫描和人工审批 |

### 16.2 分阶段待决策事项

新增功能阶段先决定：

1. Discovery Catalog 与现有 `asset-catalog.sqlite`、`asset-library.sqlite` 的最终物理边界。
2. SFTP AI 建库采用按需文件缓存、用户选择目录缓存，还是后续要求 NAS Agent。
3. 是否默认收起 Remote Terminal、App Storage 和时钟工具，保留为高级工作区。
4. 首阶段继续只支持 Windows，跨平台仅保留适配器边界，还是同步投入非 Windows 验证。

后续商业化阶段再决定：

1. 版权/经营主体及其可使用的签名、收款和合同身份。
2. 对外产品名继续使用 FloatingClock，还是使用 Reasonix/新的素材搜索品牌。
3. 闭源商业模式及 Free/Pro/Studio 的数据源数量、AI 模型、NAS 和团队能力边界。
4. 最终 EULA、隐私政策、退款政策、设备授权、离线激活和授权迁移条款。
5. 目标销售区域及其许可证、隐私、消费者和 AI 功能合规要求。

## 17. 验证记录

### 17.1 本次文档证据检查

| 项目 | 命令/入口 | 结果 |
| --- | --- | --- |
| 文档入口与规范 | `docs/README.md`、`docs/reference/documentation-standard.md` | 通过 |
| 模型/运行时确认规范 | `docs/reference/model-runtime-and-document-confirmation.md` | 通过 |
| 工作区状态 | `git status --short` | 通过：仅存在用户未跟踪的 `start.bat`，未修改 |
| NTFS/USN 代码证据 | `rg -n "NTFS|USN|MFT|FindFirstFile" native electron` | 通过：确认当前 USN/MFT 和回退实现 |
| SFTP 代码证据 | `rg -n "listRemoteDirectory|enqueueUpload|enqueueDownload|safeStorage|fingerprint" electron shared src` | 通过 |
| SQLite/向量证据 | `assetLibraryDatabase.ts`、`assetCatalogProjection.ts`、`authoritativeVectorStore.ts` | 通过 |
| 功能实现与性能测试 | 未执行代码、构建或真实基准 | 未验证：本次仅形成设计方案 |

### 17.2 文档状态说明

本文是待批准架构草案，不代表 Phase 1-6 已实现，也不替代现有 `current/` 状态文档、专项设计、审计或测试结果。实施时必须按“当前代码与测试结果 > `current/` > 日期较新的审计 > 历史方案”的优先级重新复核。
