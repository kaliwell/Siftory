# Image Search Data Editor 全量数据总览方案

> 状态：P0 + P1 + P2 + P4 增量刷新已实施；P3 待后续
> 日期：2026-08-03；P4 于 2026-08-22 验证
> 适用范围：Image Search / Data Editor Manager
> 执行环境：Codex，GPT-5 系列，精确版本不可见；未使用子代理
> 事实基线：[2026-08-02 全项目多维审计](../audits/2026-08-02-full-project-multidimensional-audit.md)、[指定文件夹多层索引编辑](../current/2026-08-02-image-search-folder-index-editor.md)与当前工作区代码
> 实施记录：[2026-08-03 全量数据总览实施](../current/2026-08-03-image-search-data-overview-implementation.md)；[真实全量基准](../benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)；[PREP-009 增量刷新验证](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)

## 1. 结论

Data Editor Manager 可以直接展示 Image Search 相关的全部数据，但不应把几个超大 JSONL 当成普通文本文件加载，也不应要求用户逐个文件夹触发分析。

推荐方案是三层结构：

1. **主要数据文件**：打开面板后立即显示 Native、DINO、CLIP、派生缓存、任务、日志和备份等物理数据，文件大小通过文件系统元数据取得，不读取大文件正文。
2. **全量目录快照**：用户首次点击“深度分析全部数据”时，只顺序扫描一次 Native、DINO、CLIP 的权威记录，生成可重建的 SQLite 目录；之后搜索、展开文件夹、统计缺失层和查看异常都查询目录，不再重复扫描十几 GiB 源数据。
3. **安全批量处理**：总览默认只读。用户按文件夹、数据层或异常类型筛选后生成影响预览，再复用现有文件夹编辑、向量 GC、缺失向量构建和缓存重建流程；不提供直接修改向量浮点值或任意删除物理文件的入口。

“全部数据”在本方案中指 **Image Search 及其直接依赖的数据**，而不是整个应用的通用文件浏览器。Media Search、Asset Library 等数据只显示关联摘要和跳转入口，默认不混入 Image Search 的批量操作范围。

## 2. 当前问题与已验证事实

### 2.1 当前交互的限制

- 当前 Data Editor 的记录列表以 Native 索引为主，无法直接看到 DINO-only、CLIP-only 或跨三层的路径并集。
- 当前指定文件夹分析可以同时统计 Native、DINO 和 CLIP，但每换一个文件夹都需要重新扫描大向量文件；它适合精确修改，不适合做全库浏览器。
- Vector Maintenance 能显示部分向量分片和存储汇总，但与 Data Editor 分离，也没有按文件夹展示三层覆盖关系。
- `storageInventory` 当前主要返回类别汇总，不支持展开到全部物理文件；部分统计口径还存在漏计或回收量不准确的问题，因此不能直接作为新的总览唯一数据源。
- 用户无法一次回答“主要大文件有哪些、每层有多少图片、哪些目录缺 DINO/CLIP、哪些是缓存或可回收数据”这些问题。

### 2.2 真实数据只读快照

下表来自 2026-08-03 对当前 `userData` 的只读文件系统统计。路径使用逻辑名称，避免在文档中固化个人绝对路径。

| 数据源                      | 角色         | 文件数 |                    物理大小 | 说明                                                           |
| --------------------------- | ------------ | -----: | --------------------------: | -------------------------------------------------------------- |
| Native index                | 权威索引     |     47 |   526,305,643 B / 0.490 GiB | 包含 manifest、segment 和 staging 等文件，需区分活跃与孤立文件 |
| DINO authoritative JSONL    | 权威向量记录 |      1 | 8,045,586,193 B / 7.493 GiB | 当前最大的单一数据源                                           |
| CLIP authoritative JSONL    | 权威向量记录 |      1 | 5,460,308,954 B / 5.085 GiB | 当前第二大的单一数据源                                         |
| DINO F16 / ANN / path cache | 派生缓存     |      5 |   739,638,574 B / 0.689 GiB | 可由权威记录重建，必须显示新鲜度                               |
| CLIP F32 cache              | 派生缓存     |      1 |   978,526,208 B / 0.911 GiB | 不应与权威 JSONL 重复计算逻辑图片数                            |
| CLIP path cache             | 派生缓存     |      1 |    61,702,238 B / 0.057 GiB | 用于路径映射和快速查询                                         |
| Embedding jobs              | 维护任务     |      1 |    97,196,022 B / 0.091 GiB | 当前审计发现大量 pending 任务，需单独显示健康状态              |
| Rotated scan log            | 日志         |      1 |   839,211,024 B / 0.782 GiB | 不属于索引权威数据，应按日志保留策略处理                       |
| Media vectors               | 关联数据     |      2 |   509,094,061 B / 0.474 GiB | 默认不进入 Image Search 编辑范围                               |

对当前图片目录做一次深度只读分析时：

- Native：57,963 个路径；
- DINO：57,953 个唯一路径 / 57,953 条记录；
- CLIP：57,953 个唯一路径 / 57,953 条记录；
- 新总览已确认真实集合差异为 15 个 Native 路径缺 DINO/CLIP，加上 5 个 DINO+CLIP-only 路径，净差为 10；
- 顺序读取的权威向量数据约 12.58 GiB，当前实测约 32.5 秒。

  32.5 秒是扫描两份大文件并只投影单个目录的旧测量；全局 464,977 路径 SQLite 目录最终实测为 127.323 秒、586 MiB 峰值 RSS。全量分析可以作为显式后台任务，但不能在每次展开文件夹或输入搜索词时重复执行。

## 3. 数据范围与统一口径

### 3.1 五种数据角色

| 角色     | 示例                                    | 是否直接编辑   | 处理原则                                   |
| -------- | --------------------------------------- | -------------- | ------------------------------------------ |
| 权威数据 | Native 活跃索引、DINO JSONL、CLIP JSONL | 仅通过受控服务 | 所有删除、修复必须有预览、备份和一致性检查 |
| 派生数据 | F16/F32、ANN、path cache、优化缩略图    | 不手工编辑     | 显示新鲜度；失效时重建或安全清理           |
| 维护数据 | embedding jobs、failure、diagnostics    | 通过维护动作   | 显示待处理、失败、过期和可回收数量         |
| 恢复数据 | GC backup、迁移备份、旧 segment         | 不直接编辑内容 | 标出来源、保留期、可恢复性和清理风险       |
| 关联数据 | Media Search、Asset Library             | 不在本面板编辑 | 只显示摘要并跳转到对应维护界面             |

### 3.2 必须分开的统计值

新界面不得再用一个 `Total` 同时表示不同概念，至少需要区分：

- **物理文件数**：磁盘上实际存在多少文件；
- **物理字节数**：操作系统 `stat` 汇总，不把同一文件重复计入；
- **记录行数**：JSONL 中的物理行数；
- **唯一图片数**：按规范化源路径去重后的图片数；
- **三层覆盖数**：Native、DINO、CLIP 各自包含多少路径；
- **异常行数**：malformed、duplicate、stale、missing-source；
- **可回收字节数**：只有在已有安全清理流程能够证明时才显示，不能用“派生数据总大小”冒充；
- **匹配源文件字节数**：图片源文件的逻辑大小，不能与索引文件物理大小相加。

### 3.3 路径集合

全量路径集合定义为：

```text
U = Native paths ∪ DINO imageId paths ∪ CLIP imageId paths
```

每个路径至少产生以下状态之一：

- 三层完整；
- Native-only；
- DINO-only；
- CLIP-only；
- Native + DINO，缺 CLIP；
- Native + CLIP，缺 DINO；
- DINO + CLIP，缺 Native；
- 有重复记录、格式错误或源文件不存在。

项目预览图等存在显示路径与源路径映射的数据，必须按已有 `sourcePath` 规则归一到源文件，不能把 preview 文件误判为独立图片。

## 4. 用户界面方案

### 4.1 顶层结构

```text
Data Editor Manager
┌─────────────────────────────────────────────────────────────┐
│ 数据总览 │ 文件夹/记录编辑 │ 缩略图维护                     │
├─────────────────────────────────────────────────────────────┤
│ 快照：2026-08-03 21:30  [有变化] [深度分析全部] [取消]      │
│ 15.6 GiB+  57,963 路径  三层完整 57,953  异常 10           │
├─────────────────────────────────────────────────────────────┤
│ 主要数据文件 │ 文件夹覆盖 │ 记录 │ 健康问题                 │
├─────────────────────────────────────────────────────────────┤
│ 筛选 / 搜索 / 排序 / 只看异常                              │
│ 分页或虚拟化表格                                            │
├─────────────────────────────────────────────────────────────┤
│ 已选择 3 个文件夹 / 10 条异常 [生成处理预览]                │
└─────────────────────────────────────────────────────────────┘
```

默认打开“主要数据文件”，无需深度扫描即可给用户答案。若还没有目录快照，“文件夹覆盖”和“记录”页显示明确的“首次分析约需几十秒”提示，而不是空白或卡住。

### 4.2 “主要数据文件”页

每一行表示一个逻辑数据源，默认按物理大小降序：

| 字段            | 含义                                            |
| --------------- | ----------------------------------------------- |
| 名称 / 数据层   | Native、DINO、CLIP、缓存、任务、日志或备份      |
| 角色            | 权威、派生、维护、恢复、关联                    |
| 物理文件        | 文件数量，可展开查看相对路径和单文件大小        |
| 物理大小        | 真实磁盘字节数                                  |
| 唯一图片 / 记录 | 从最近目录快照读取；没有快照时显示“待分析”      |
| 异常            | stale、duplicate、malformed、orphan、pending 等 |
| 新鲜度          | 与权威源一致、可能过期、已过期、未知            |
| 修改时间        | 最近物理修改时间                                |
| 可重建          | 是 / 否，以及重建来源                           |
| 操作            | 查看位置、分析、生成清理预览、重建、进入维护页  |

展开后可以查看主要物理文件，但 Renderer 不取得可任意操作文件系统的能力。所有“打开位置”或维护操作都提交 `storeId`，由主进程映射到受信任的应用数据路径。

### 4.3 “文件夹覆盖”页

这是解决“一个一个尝试麻烦”的核心视图。它基于一次生成的目录快照，按文件夹树或平铺表展示：

| 文件夹 | Native | DINO | CLIP | 缺 DINO | 缺 CLIP | 向量-only | 重复/错误 | 匹配源大小 |
| ------ | -----: | ---: | ---: | ------: | ------: | --------: | --------: | ---------: |

支持：

- 懒加载展开文件夹树；
- 按目录名或规范化路径搜索；
- 一键筛选“三层不一致”“只缺 DINO”“只缺 CLIP”“有重复或格式错误”；
- 选择一个、多个或当前筛选结果中的全部文件夹；
- 点击单行进入现有“指定文件夹 Native/DINO/CLIP 多层索引编辑”；
- 对批量选择先生成统一影响预览，再执行已有的安全维护动作；
- 展开 20 个目录也不重新读取 DINO/CLIP JSONL。

文件夹边界必须是规范化后的精确祖先关系。例如选择 `images/a` 不能命中兄弟目录 `images/ab`。

### 4.4 “记录”页

记录页使用 `U` 的路径并集，不再只列 Native 记录：

- 每条记录显示 Native、DINO、CLIP 三个徽标；
- 支持按文件名、完整路径、文件夹和异常状态筛选；
- 每页最多 200 条并使用虚拟化渲染；
- 默认只返回元数据，不把向量数组传到 Renderer；
- 可以进入单条 Native 路径修复或指定文件夹编辑；
- DINO/CLIP 的“编辑”只表示删除错误成员、重建缺失向量或通过受控流程修复路径，不允许人工修改 512/768 维浮点值。

记录页可放在第二阶段交付；首个可用版本优先完成主要文件和文件夹覆盖。

### 4.5 “健康问题”页

健康问题按严重级别、影响范围和可执行动作聚合：

- Native 有但 DINO/CLIP 缺失；
- DINO/CLIP 有但 Native 不存在；
- 重复、陈旧或格式错误的向量记录；
- Native manifest 未引用的 segment / staging 文件；
- 派生缓存与权威记录指纹不一致；
- embedding jobs 大量 pending 或失败；
- 超过保留期的日志和备份；
- 源图片不存在或路径大小写/分隔符异常。

每类问题只提供与其风险匹配的动作。未知来源文件只允许查看，不显示通用“删除”按钮。

## 5. 加载与缓存设计

### 5.1 快速清单

打开 Data Editor 时执行轻量清单：

1. 读取已知应用数据根目录下的文件元数据；
2. 读取 Native manifest、缓存元数据和上一次目录快照状态；
3. 汇总主要数据源的文件数、大小、修改时间和可重建属性；
4. 比较源文件指纹，标记快照为“最新”或“有变化”；
5. 不读取 DINO/CLIP JSONL 正文，不枚举用户图片目录。

目标是冷启动 P95 小于 500 ms、已有缓存时小于 300 ms，并始终保持界面可交互。

### 5.2 一次深度分析

“深度分析全部数据”由后台 worker 执行：

1. 记录 Native manifest generation 与所有源文件的大小、修改时间；
2. 以分页或流式接口导出 Native 可见路径，不能通过 Renderer 每次 200 条循环拉取；
3. 顺序扫描 DINO JSONL，只解析 `imageId` 和最少必要元数据，不解析向量数组；
4. 顺序扫描 CLIP JSONL，采用相同规则；
5. 分批写入新 SQLite generation 并计算文件流式 SHA-256；
6. 生成路径并集、文件夹汇总、健康问题和数据源统计；
7. 重新检查源文件指纹，运行 SQLite `quick_check` 与计数不变量；
8. 验证成功后原子切换 `CURRENT`，失败或取消则保留上一份完整快照。

DINO 和 CLIP 当前位于同一物理磁盘，默认串行扫描以减少磁盘寻道和缓存竞争。只有能够证明位于不同物理磁盘时，才允许并行读取。

早期 32.5 秒探测只覆盖了部分顺序读取，没有包含 Native 投影、SQLite upsert、目录聚合和一致性校验，不能作为完整端到端目标。真实全流程门槛与结果以后文第 10 节为准。

### 5.3 增量刷新

目录快照需要保存每个源的指纹和扫描检查点：

- 大小、修改时间和流式 SHA-256；
- JSONL 最后完整换行偏移；
- 已扫描行数和尾部校验摘要；
- Native manifest generation / hash；
- 目录 schema 版本和应用版本。

刷新规则：

- 指纹不变：直接复用；
- JSONL 只追加：验证旧尾部检查点后只扫描新增部分；
- 文件缩小、替换或旧前缀变化：只重建受影响的数据层；
- Native manifest 变化：只重建 Native 投影和相关并集/汇总；
- 缓存、日志、任务和备份：只重新统计文件元数据或其小型 manifest；
- schema 变化：创建新 generation，不在旧目录上原地迁移。

首版可以先完成可靠的整层重扫，增量追加优化放在后续阶段；不得为了“增量”牺牲一致性检查。

2026-08-22 实施说明：schema v2 已保存固定 8 MiB chunk-tree、source identity/order/layer、namespace 和有界前缀证明。严格 append-tail 只读取旧 partial chunk 与新增尾部，未变化源完整复用，变更目录只更新受影响祖先。当前对源缩短/替换、旧前缀变化、source set/namespace 变化、Native 删除以及 GC/压实采用更保守的完整重建，而不是按层局部重建；增量与干净全量的路径行、目录行、汇总和逻辑 SHA 已通过 parity。

## 6. 派生目录架构

项目已经使用 Node 24 / Electron 42，并在 Asset Library 中采用 `node:sqlite`，因此新目录可以复用同一技术栈，不新增原生第三方依赖。

建议位置：

```text
userData/
  image-search-data-catalog/
    CURRENT
    generations/
      <generation-id>/
        catalog.sqlite
        build.json
```

目录只是可删除、可重建的只读投影，不改变 Native、DINO、CLIP 的权威格式。

### 6.1 建议表结构

```sql
CREATE TABLE catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE source_files (
  source_id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  role TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  physical_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  fingerprint TEXT,
  record_count INTEGER,
  unique_count INTEGER,
  malformed_count INTEGER,
  stale_count INTEGER,
  duplicate_count INTEGER,
  freshness TEXT NOT NULL,
  rebuildable INTEGER NOT NULL,
  cleanup_risk TEXT NOT NULL
);

CREATE TABLE indexed_paths (
  path_id INTEGER PRIMARY KEY,
  normalized_path TEXT NOT NULL UNIQUE,
  display_path TEXT NOT NULL,
  native_count INTEGER NOT NULL DEFAULT 0,
  native_bytes INTEGER,
  dino_rows INTEGER NOT NULL DEFAULT 0,
  dino_bytes INTEGER,
  clip_rows INTEGER NOT NULL DEFAULT 0,
  clip_bytes INTEGER,
  flags INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folder_rollups (
  folder_key TEXT PRIMARY KEY,
  parent_key TEXT,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  native_count INTEGER NOT NULL,
  dino_count INTEGER NOT NULL,
  clip_count INTEGER NOT NULL,
  native_only INTEGER NOT NULL,
  dino_only INTEGER NOT NULL,
  clip_only INTEGER NOT NULL,
  missing_dino INTEGER NOT NULL,
  missing_clip INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  malformed_rows INTEGER NOT NULL,
  matched_bytes INTEGER
);

CREATE TABLE health_issues (
  issue_id INTEGER PRIMARY KEY,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  path_id INTEGER,
  folder_key TEXT,
  detail_json TEXT NOT NULL,
  action_kind TEXT
);
```

必须为 `indexed_paths` 的层状态、`folder_rollups.parent_key`、异常类型和常用排序字段建立索引。SQLite 写入按 5,000 至 20,000 行批量事务执行，具体批量大小由基准测试确定。

为避免目录层级放大，不建立“每条图片 × 每级祖先”的关系表。每个唯一文件夹只存一个汇总节点，在 worker 中按父链聚合一次。

### 6.2 generation 一致性

- 构建始终写入新的 staging generation；
- `build.json` 记录源指纹、统计、耗时、完成状态和 schema 版本；
- 构建结束后关闭并重新以只读方式打开 SQLite，执行 `PRAGMA quick_check`；
- 检查路径并集、各层计数、异常数量等不变量；
- 用原子替换切换 `CURRENT`；
- 保留最近一份完整 generation，新的稳定快照建立后再按策略删除更旧目录；
- 用户取消、进程崩溃或磁盘不足都不得破坏当前可用快照。

## 7. 服务、IPC 与组件边界

### 7.1 主进程服务

建议新增或拆分：

- `imageSearchDataCatalogService.ts`：快照生命周期、只读查询、状态机；
- `imageSearchDataCatalogWorker.ts`：流式扫描、归一化、SQLite 批量构建；
- `imageSearchDataStoreRegistry.ts`：受信任数据源注册、角色、路径映射和维护能力；
- 从 `storageInventory.ts` 提取可复用的文件统计器，同时修复现有漏计和回收量口径；
- 复用现有 `imageSearchFolderDataService`、Vector GC preview、向量构建、缩略图重建和缓存失效逻辑，不复制写入实现。

总览是“读取模型和动作编排器”，不是第二套 Native/DINO/CLIP 写入服务。

### 7.2 IPC 草案

| IPC                                  | 用途                     | 关键边界                           |
| ------------------------------------ | ------------------------ | ---------------------------------- |
| `imageSearch:getDataOverview`        | 取得快速摘要和目录状态   | 固定小响应                         |
| `imageSearch:startDataCatalogBuild`  | 启动深度分析             | 单实例、互斥检查                   |
| `imageSearch:getDataCatalogProgress` | 查询阶段、字节和记录进度 | 节流更新                           |
| `imageSearch:cancelDataCatalogBuild` | 请求安全取消             | 保留旧 generation                  |
| `imageSearch:listDataStores`         | 分页列出逻辑与物理数据源 | Renderer 只传过滤和分页参数        |
| `imageSearch:listDataFolders`        | 查询文件夹树或平铺表     | 每页和子节点数有上限               |
| `imageSearch:listDataRecords`        | 查询路径并集记录         | 每页最多 200，不返回向量数组       |
| `imageSearch:listDataIssues`         | 查询聚合健康问题         | 详情大小受限                       |
| `imageSearch:openDataStoreLocation`  | 打开受信任数据源位置     | 只接受 `storeId`，不接受任意路径   |
| `imageSearch:previewBulkDataAction`  | 生成批量处理计划         | 返回精确层、数量、字节、备份和风险 |

若实现时现有 bridge 更适合按一个 namespace 暴露，这些 IPC 可合并为类型化 API，但不能牺牲输入校验和分页上限。

### 7.3 Renderer 组件

不要继续扩大单个 `ImageSearchDataManager.tsx`。建议拆为：

- `ImageSearchDataOverview.tsx`；
- `ImageSearchDataStoreTable.tsx`；
- `ImageSearchFolderCoverage.tsx`；
- `ImageSearchDataRecordTable.tsx`；
- `ImageSearchDataIssues.tsx`；
- `ImageSearchBulkActionPreview.tsx`。

公共的分页、字节格式化、状态徽标和选择模型应提取复用，避免 Data Editor 与 Vector Maintenance 各维护一套口径。

## 8. 状态与并发

目录状态：

```text
no-catalog -> quick-ready/stale -> building -> ready
                                  |       |
                                  v       v
                             cancelling  error
```

- `building` 时仍允许使用上一份 `ready` 快照浏览，并明确显示“后台正在更新”；
- 深度分析与 Native 扫描提交、embedding build、Vector GC、向量迁移、文件夹多层删除互斥；
- 普通 Image Search 查询可以继续使用当前权威索引和上一份目录快照；
- 批量处理前必须重新核对源 generation 和文件指纹，预览过期时拒绝执行；
- 取消是协作式取消：完成当前安全批次、关闭 staging SQLite、保留旧快照；
- 磁盘空间不足时在构建前拒绝，并给出预计临时空间，而不是写到一半失败。

## 9. 安全与隐私

- 所有物理路径从主进程受信任 registry 解析；Renderer 不能指定任意应用数据文件进行打开、扫描或删除。
- 用户输入路径最大长度建议 1,024，分页上限 200，文件夹子节点和排序字段使用白名单。
- 目录扫描不跟随符号链接，不跨越注册的数据根目录；Windows 路径使用统一大小写和分隔符规则。
- 目录 SQLite 含个人文件路径，只保存在 `userData`，不得写入日志、审计文档或错误遥测。
- 导出目录必须是显式用户操作，默认做根目录别名化或脱敏，并明确告知内容。
- 大批量删除必须经过“分析 → 影响预览 → 明确确认 → 原子替换/备份 → 校验 → 缓存失效”流程。
- 不提供任意物理文件删除按钮；权威文件损坏时进入对应维护流程。
- 错误消息返回逻辑数据源和问题代码，不把完整个人路径或 JSONL 内容带到 Renderer 日志。

## 10. 性能目标与实测

原 `<45 s / <150 MiB` 目标来自单个 57,963 路径目录的早期估算。真实全局输入为 464,977 个并集路径和 975,971 条向量记录，因此 P2 首版采用以下同机门槛；长期 `<45 s` 转为 P4 增量刷新目标。

| 场景                    |                        P2 门槛 |                                        2026-08-03 单次实测 |
| ----------------------- | -----------------------------: | ---------------------------------------------------------: |
| 打开主要数据文件页      | 冷启动 < 500 ms；缓存 < 300 ms | 进程首次 192.6 ms；缓存 4.4–4.7 ms（未清 OS 缓存、非 P95） |
| 首次深度分析 12.578 GiB |                        < 150 s |                                                  127.323 s |
| 全流程峰值 RSS          |                      < 700 MiB |                                                  586.0 MiB |
| 单代目录磁盘            |                      < 256 MiB |                                                  215.3 MiB |
| Native 279,967 条导出   |                  O(N) 且 < 5 s |                                                    0.703 s |
| 连续展开 20 个文件夹    |         0 次重新读取权威 JSONL |                                        架构满足，待 UI P95 |
| 取消响应                |          < 1 s 进入 cancelling |                                      1,000 行/安全批次检查 |
| 主进程事件循环单次阻塞  |            重任务必须在 worker |          向量/SQLite 均在 worker；Native 快照约 0.7 s 同步 |

完整过程、硬件和三轮结果见[真实全量目录基准](../benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)。

## 11. 批量处理模型

用户不需要逐个尝试文件夹。新总览支持按筛选结果批量选择，但执行仍保持安全：

1. 用户选择文件夹、记录或问题类型；
2. 系统冻结选择条件和目录 generation；
3. 主进程从权威数据重新计算精确影响；
4. 预览显示 Native/DINO/CLIP 各自记录数、匹配字节、预计临时空间、是否生成备份、缓存失效范围和不可撤销部分；
5. 用户选择动作，例如“补建缺失 DINO/CLIP”“从三层删除错误路径”“运行向量 GC”“重建过期缓存”；
6. 通过现有专用服务执行，不由总览直接改文件；
7. 校验成功后刷新受影响层的目录投影。

“选中当前筛选结果的全部”必须绑定筛选快照，而不是把成千上万条路径传到 Renderer 后再原样传回主进程。主进程使用 opaque selection token，并在执行前验证过期状态。

## 12. 功能影响

| 影响项                | 结论                                                         |
| --------------------- | ------------------------------------------------------------ |
| Image Search 查询结果 | 总览本身只读，不改变搜索结果                                 |
| Native/DINO/CLIP 格式 | 不迁移、不修改权威格式                                       |
| 首次使用              | 增加一次可取消的深度分析，当前全局真实数据约 127 秒          |
| 后续浏览              | 从重复扫描大文件改为查询 SQLite，速度会显著提升              |
| 磁盘占用              | 新增可重建目录和一个构建期 generation，需预检查空间          |
| 运行性能              | 后台构建会产生顺序磁盘 I/O，应降低优先级并避免与建库/GC 并行 |
| 数据安全              | 只读总览无数据风险；批量动作沿用现有预览和原子替换边界       |
| 兼容性                | 删除目录即可回退，不影响旧 Data Editor 与搜索链路            |

最大的性能收益不是把约 127 秒的首次全量分析再缩短几秒，而是把“每个文件夹都扫描一次”变为“全库只扫描一次，后续查询约百毫秒”。

## 13. 实施阶段

### P0：口径与测试基线

- 固化五种数据角色和物理/逻辑统计口径；
- 为当前真实数据建立只读基准快照；
- 修复 `storageInventory` 已知的 nested file 漏计、Vector GC 可回收量和 Native manifest/orphan 分类；
- 定义 IPC 类型、catalog schema、路径归一化和 selection token；
- 增加真实大文件之外的小型固定测试夹具。

### P1：主要数据文件 MVP

- 数据源 registry；
- 快速清单与主要文件表；
- 文件展开、大小、角色、新鲜度和受控“打开位置”；
- 与 Vector Maintenance 的维护入口互链；
- 无目录快照时也可以立即使用。

### P2：全量目录与文件夹覆盖

- 后台 worker 和 generation SQLite；
- Native 流式导出、DINO/CLIP 单次扫描；
- 文件夹覆盖、差集筛选和健康问题；
- 进度、取消、旧快照继续可用；
- 点击目录进入现有多层索引编辑。

P1 与 P2 组成推荐 MVP：P1 解决“主要大文件看不见”，P2 解决“每个文件夹一个一个尝试”。

### P3：安全批量动作

- 多目录和“当前筛选全部”选择；
- opaque selection token；
- 统一影响预览；
- 接入缺失 embedding 构建、三层路径删除、Vector GC 和缓存重建；
- 执行后增量刷新受影响投影。

### P4：增量和高级记录页

- JSONL append-tail 增量刷新；
- 全量记录页和组合筛选；
- 存储趋势、历史 generation 差异和预计回收空间；
- 真实 10 万 / 100 万记录基准与内存优化。

## 14. 验收标准

### 14.1 正确性

- 主要数据源的文件数和物理字节与操作系统 `stat` 完全一致；
- 同一物理文件不会被多个类别重复计入总大小；
- 当前图片目录显示 Native 57,963、DINO 57,953、CLIP 57,953，并能区分 15 条缺向量与 5 条 vector-only 路径；
- 唯一路径、物理行、重复、陈旧和格式错误分别统计；
- Native orphan 仅依据 manifest 引用关系判定，不能按扩展名猜测；
- preview 路径正确映射到源路径；
- `images/a` 的操作不命中 `images/ab`。

### 14.2 性能与稳定性

- 达到第 10 节性能目标，测试报告记录机器、磁盘和源文件指纹；
- 深度分析期间 Renderer 可持续交互，主进程无长时间同步阻塞；
- 连续查询和展开不读取 DINO/CLIP 权威 JSONL；
- 取消、崩溃、磁盘不足和 malformed 行都不会替换当前完整 generation；
- 源文件在构建期间变化时，本次快照拒绝提交并明确提示重试；
- 大 IPC 响应、无界数组和向量数组传输测试必须失败。

### 14.3 安全与回归

- Renderer 提交任意路径、未知 `storeId`、过期 selection token 均被拒绝；
- 深度分析与 GC、建库、迁移和文件夹删除互斥；
- 批量动作只有影响预览通过后才能执行；
- 目录中断后旧快照仍可查询；
- 通过 IPC validation、registration、preload contract、i18n、typecheck、lint、format check、build 和 Image Search / vector pipeline 专项测试。

## 15. 当前建议

P0 + P1 + P2 + P4 增量刷新已完成，当前最小闭环包括主要大文件、一次全库分析、严格追加复用、目录覆盖/差集、异常筛选，以及进入现有单目录 Native/DINO/CLIP 编辑器。

下一步优先级：

1. P3 增加“当前筛选全部”的 opaque selection token 和统一影响预览；
2. 为 missing DINO/CLIP 接入受控补建，而不是让用户手工猜测路径；
3. 增加路径级记录分页和独立、限速的源文件存在性健康任务；
4. 若继续压缩无变化刷新，优先评估派生 SQLite 快照复用，同时保留 current/previous 两代和原子切换语义。
