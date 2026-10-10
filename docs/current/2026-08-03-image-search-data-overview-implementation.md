# Image Search Data Editor 全量数据总览实施记录

> 状态：当前
> 实施状态：P0 + P1 + P2 + P4 增量刷新已完成
> 日期：2026-08-03；最新验证 2026-08-22
> 适用范围：Image Search / Data Editor Manager
> 设计来源：[全量数据总览方案](../designs/2026-08-03-image-search-data-overview-design.md)
> 性能证据：[真实全量目录基准](../benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)、[PREP-009 增量刷新验证](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)

## 1. 交付结论

Data Editor Manager 现在可以一次展示 Image Search 的主要数据，而不需要用户逐个输入文件夹：

- 打开面板后直接显示 Native、DINO、CLIP、派生缓存、任务、诊断、日志、恢复文件和目录快照等主要数据源；
- 可展开查看每个逻辑数据源下的物理文件、相对路径、大小和更新时间；
- 点击一次“Analyze All Data / Refresh All Data”后生成 Native/DINO/CLIP 全库联合目录；
- 后续文件夹浏览、全局目录搜索、异常筛选和分页只查询 SQLite，不再重复读取 12.58 GiB 的权威向量 JSONL；
- 已有 v2 目录满足严格追加证明时，Refresh All Data 复用未变化分片并只读取旧 partial chunk 与新增尾部；证明不足则自动全量重建；
- 从任意覆盖目录点击“Manage Indexes”即可进入现有文件夹编辑器，Native、DINO、CLIP 三层均可勾选；
- 总览默认只读，不提供直接修改向量浮点值或任意删除物理文件的入口。

因此，用户原来遇到的“Indexed path not found”不再是查看全局数据的必经入口。单条记录查询仍保留，用于精确修复；全库了解和目录定位改由新总览承担。

## 2. 界面与操作流程

Data Editor Manager 顶部新增两个视图：

1. **Major Data Stores**
   - 无需深度扫描即可查看主要物理数据；
   - 区分 authoritative、derived、maintenance、recovery、catalog 等角色；
   - 展开后显示相对路径和单文件大小；
   - “Open Location”只接受主进程 registry 中的固定 `storeId`，Renderer 不能提交任意路径。
2. **Folder Coverage**
   - 首次分析后显示目录级 Native/DINO/CLIP 覆盖；
   - 支持根目录、子目录展开、全库名称搜索、仅异常和分页；
   - 显示 missing DINO、missing CLIP、vector-only 和 duplicate rows；
   - “Manage Indexes”把目录传给现有的多层编辑器，再执行影响预览和确认。

首次分析状态为：

```text
collecting -> native -> dino -> clip -> folders -> validate -> switch -> completed
                     \-> cancelling / cancelled
                     \-> error（旧快照继续有效）
```

## 3. 代码结构

| 层次           | 主要文件                                                                                | 职责                                                                             |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Native         | `native/fast_scanner.cc`                                                                | `snapshotIndexRecords()` 在线性时间内导出当前有效 Native 视图，不做逐文件 `stat` |
| 主进程目录服务 | `electron/imageSearchDataCatalogService.ts`                                             | 数据源 registry、快速物理清单、构建调度、generation 切换、分页查询和安全位置解析 |
| 后台 worker    | `electron/imageSearchDataCatalogWorker.ts`                                              | 全量/增量调度、JSONL 投影、原子 staging 与一致性校验                             |
| Worker contract | `electron/imageSearchDataCatalogTypes.ts`                                              | 主进程与 worker 的输入、结果、进度和消息类型；避免主图遍历 worker 实现            |
| 指纹与汇总     | `electron/imageSearchDataCatalogFingerprint.ts`、`electron/imageSearchDataCatalogRollup.ts` | 固定 chunk 完整指纹、append-tail 证明、全量/受影响祖先 rollup                 |
| 路径工具       | `electron/imageSearchDataPathUtils.ts`、`electron/imageSearchDataCatalogPaths.ts`       | Windows 路径归一化、目录链、精确边界和 Buffer 定点 JSON 字段提取                 |
| IPC            | `electron/imageSearchIpc.ts`、`electron/preload.ts`、`shared/ipc/*`                     | 六个目录总览能力及参数/返回类型                                                  |
| Renderer       | `src/components/ImageSearchDataOverview.tsx`                                            | 数据源与文件夹覆盖 UI、进度轮询、筛选和分页                                      |
| 既有编辑器     | `src/components/ImageSearchDataManager.tsx`、`electron/imageSearchFolderDataService.ts` | Native/DINO/CLIP 文件夹级影响预览、原子改写、备份和缓存失效                      |

Native 旧接口 `queryIndexRecords('', offset, 200)` 每一页都会从索引开头重新遍历，导出全库接近 O(N²)。新接口在一次 shared lock 中遍历 overlay 和 mmap segments，按当前可见性规则去重和隐藏删除项，复杂度为 O(N)。

## 4. 目录数据结构

目录存放在 `userData/image-search-data-catalog`，属于可重建派生数据：

```text
image-search-data-catalog/
├── CURRENT
└── generations/
    ├── <current>/
    │   ├── catalog.sqlite
    │   └── build.json
    └── <previous>/
        ├── catalog.sqlite
        └── build.json
```

SQLite 主要表：

- `catalog_meta`：schema、generation、构建时间、源快照和汇总；
- `source_files`：每个物理权威源的顺序、层、大小、namespace、行统计、抽样哈希、完整 chunk-tree 根和前缀证明；
- `source_chunks`：固定 8 MiB 分块的 offset、长度和 SHA-256，所有 chunks 共同覆盖源文件每个字节；
- `indexed_paths`：Native/DINO/CLIP 路径并集和每层计数；
- `folder_rollups`：目录树的覆盖、差集、重复和逻辑源文件字节汇总。

提交规则：

1. 在隐藏 staging generation 中构建；
2. 检查 Native revision、向量 source identity/order/layer、size/mtime/sample、完整 chunk 根和前缀证明；
3. 执行 SQLite `quick_check` 和路径数不变量；
4. 再次核对源快照；
5. 原子切换 `CURRENT`；
6. 保留 current + previous 两代，清理更旧的合法派生 generation。

构建前使用 `statfs` 做保守磁盘空间预检。2026-08-03 单代约 215.3 MiB，2026-08-22 v2 基准为 206.58 MiB；刷新时还需要 staging 和临时索引空间。

## 5. 真实数据健康结论

### 5.1 全局权威数据

2026-08-03 只读实测：

| 指标                         |              数量 |
| ---------------------------- | ----------------: |
| Native 有效唯一路径          |           279,967 |
| DINO 物理记录 / 唯一路径     | 486,731 / 455,270 |
| CLIP 物理记录 / 唯一路径     | 489,240 / 458,288 |
| 三层路径并集                 |           464,977 |
| Native + DINO + CLIP 完整    |           273,297 |
| Native 缺 DINO               |             3,480 |
| Native 缺 CLIP               |             6,639 |
| 仅存在于向量层               |           185,010 |
| 重复向量修订                 |            62,413 |
| malformed（行结构/关键字段） |                 0 |
| 目录聚合节点                 |            29,885 |

解释：

- 两份权威 JSONL 均未发现行边界或目录投影所需关键字段损坏；为避免解析 12.58 GiB 向量数组，本结论不等同于逐元素验证每个 embedding 的数值、维度和范数；
- DINO 有 31,461 条重复修订，CLIP 有 30,952 条，属于明显可优化的存储冗余；
- 185,010 条 vector-only 主要分布在其他历史目录，表示它们不在当前 Native 有效视图中；这不等同于源文件一定丢失，P2 为避免 27 万次随机磁盘访问，没有逐文件验证存在性；
- 全局缺失层数量不为零，说明 Native、DINO、CLIP 尚未完全同步，后续应按目录定位后补建或清理，而不是直接删除大文件。

### 5.2 `D:\dataset\images`

| 指标           |   数量 |
| -------------- | -----: |
| Native         | 57,963 |
| DINO           | 57,953 |
| CLIP           | 57,953 |
| Native 缺 DINO |     15 |
| Native 缺 CLIP |     15 |
| vector-only    |      5 |
| 重复修订       |      0 |

这里不是简单的“Native 比向量多 10 条”。实际集合差异为 20 个路径：15 个 Native 路径同时缺 DINO/CLIP，另有 5 个路径同时存在 DINO/CLIP 但不在 Native；`57,963 - 15 + 5 = 57,953`。

缺 DINO/CLIP 的 15 个相对路径：

```text
pxhere-000025/1645843.jpg
pxhere-000072/1584349.jpg
pxhere-000144/1435513.jpg
pxhere-000144/1435579.jpg
pxhere-000144/1435583.jpg
pxhere-000200/1356313.jpg
pxhere-000200/1356322.jpg
pxhere-000200/1356363.jpg
pxhere-000200/1356402.jpg
pxhere-000200/1356453.jpg
pxhere-000200/1356485.jpg
pxhere-000200/1356503.jpg
pxhere-000216/1335312.jpg
pxhere-000216/1335346.jpg
pxhere-000216/1336128.jpg
```

仅向量层存在的 5 个相对路径：

```text
pxhere-000001/1692110.jpg
pxhere-000025/1644999.jpg
pxhere-000048/1616584.jpg
pxhere-000072/1585793.jpg
pxhere-000072/1585827.jpg
```

建议先在新总览中定位这些目录并核对源文件，再决定“补建向量”还是“清理过期向量”。仅凭集合差异不能安全判断应删除哪一层。

### 5.3 2026-08-22 当前只读快照

PREP-009 正式基准重新读取了当日权威源。当前结果为 Native 266,372、DINO 440,450、CLIP 440,462、路径并集 440,907、三层完整 265,927、missing DINO/CLIP 各 445、vector-only 174,535、duplicate/malformed 均为 0、目录节点 26,832。两份向量源共 12,194,373,682 bytes（约 11.36 GiB）。

这些计数与 2026-08-03 历史快照不同，说明期间权威数据已经过正常建库或维护；本次优化没有写入真实源，不能把差值归因于 PREP-009，也不能跨快照直接比较健康率。

## 6. 性能与处理效率

真实 12.578 GiB 权威向量数据、975,971 条物理向量记录的最终单次结果：

| 指标                  |      结果 |
| --------------------- | --------: |
| Native 279,967 条快照 |   0.703 s |
| 完整 worker 构建      | 125.745 s |
| 端到端                | 127.323 s |
| 峰值 RSS              | 586.0 MiB |
| SQLite                | 215.3 MiB |

同一机器当前真实 `userData` 的主要数据清单单次只读测量：进程内首次调用 192.6 ms，10 秒缓存内连续两次分别 4.7 ms 和 4.4 ms；共返回 13 类存储、汇总约 16.92 GB。测量没有清空操作系统文件缓存，因此只证明当前样本达到 `<500 ms` 目标，不是严格冷启动或跨机器 P95。

与首个可完成版本相比：

- 端到端 149.556 s → 127.323 s，缩短约 14.9%；
- 峰值 RSS 1,169.2 MiB → 586.0 MiB，降低约 49.9%；
- Native 旧分页导出超过 120 s 仍未完成，新线性快照约 0.7 s。

已采用的优化：

- Native 一次性线性快照，去掉 O(N²) 分页；
- Buffer 内定点提取 `imageId/modelName/embeddingType`，不把整条大向量转成 JS 字符串；
- SQLite `iterate()` 流式目录聚合，不把 464,977 行一次装入对象数组；
- 紧凑的“namespace → path set”重复检测，并在目录聚合前释放；
- 主进程在 Worker 完成 structured clone 后立即释放 Native 记录引用；
- 物理文件清单流式累计精确总数/总字节，只在内存保留最大的 100 个文件；
- 20,000 行事务批次、file-backed SQLite temp 和 staging 可重建前提下的 `synchronous=NORMAL`。

最大的使用体验收益仍是：全库扫描一次后，后续目录浏览和筛选不再读取权威 JSONL。

### 6.1 PREP-009 增量刷新

2026-08-22 当前 11.36 GiB 真实源的 v2 全量构建为 129.129 秒、峰值 RSS 584.35 MiB、SQLite 206.58 MiB。相对 2026-08-03 的 127.323 秒仅慢 1.42%，处于统一 3% 噪声阈值内；全量性能没有为了增量路径而退化。

从同一全量 generation 连续执行三轮无变化刷新，P50/P95 为 12.171/12.452 秒，三轮 `fullBytesRead` 和 `tailBytesRead` 均为 0，汇总和逻辑 SHA 与全量一致。隔离的 80,000 行/层加 2,000 行 DINO append A/B 只读取 13.5141% 源字节，耗时 1.273 秒，对照全量 5.468 秒，改善 76.72%。完整失效矩阵与原始产物见[PREP-009 增量刷新验证](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)。

无变化刷新仍需复制上一代派生 SQLite、执行 `quick_check` 和有界完整性证明，因此不是零耗时。源缩短、替换、前缀改写、namespace/分片集合变化、Native 删除以及 GC/压实会自动回到全量重建。

## 7. 安全与功能影响

- 总览扫描只读 Native、DINO、CLIP；不会修改搜索索引、向量值或源图片；
- 唯一新增写入是可删除、可重建的目录 SQLite 和 `build.json`；
- 构建失败、取消、源数据变化、磁盘不足或校验失败时不会切换 `CURRENT`；
- 构建与 Native 扫描/保存、embedding build、Vector GC、迁移、缓存构建、存储清理和文件夹编辑互斥；
- 普通 Image Search 查询可继续使用当前权威索引和上一代目录；
- Renderer 只能传短 `storeId`、受限分页条件或现有编辑器 token，不能指定任意 app-data 路径；
- 权威向量源、缓存维护目标、目录数据库和“打开位置”均校验真实路径处于 `userData` 内，拒绝符号链接/目录联接逃逸；
- 破坏性文件夹编辑使用 96-bit 加密随机预览令牌，并在执行前复验 TTL、允许根、分片大小和修改时间；
- catalog 对单条 JSONL 设置 8 MiB 上限，超长损坏行按 malformed 计数并流式跳过；破坏性编辑遇到超长行则 fail-closed，不允许无换行输入无限扩张内存；
- 增量目录只复用通过 source identity、完整 chunk-tree、前缀证明、换行边界和 namespace 门禁的源；取消不会被误判为失效后继续执行全量；
- DINO/CLIP 文件夹编辑仍走“预览 → 磁盘预检 → 指纹复核 → 原子替换 → 7 天恢复备份 → 缓存失效”，源图片不删除。
- DINO/CLIP 重写仅解码路径用于匹配，所有保留行按原始字节复制，CRLF、无末尾换行和异常字节不会被顺带改写。

对现有搜索功能的影响是可逆的：删除 `image-search-data-catalog` 只会失去总览快照，不会影响 Native/DINO/CLIP 权威搜索。

## 8. 当前边界与后续优先级

已完成 P0/P1/P2/P4 增量刷新；以下仍属于后续阶段：

1. **P3 多目录批量动作**：当前可以从任意目录进入单目录三层编辑，但还没有“当前筛选全部”的 opaque selection token。
2. **P3 缺失向量补建**：当前总览能定位 missing DINO/CLIP，尚未提供按筛选集合补建按钮。
3. **记录详情页**：当前全量可见性以数据源和目录聚合为主，尚未在 Renderer 分页展示路径级差集。
4. **源文件存在性**：Native 快照故意不随机 `stat` 每个源文件；如需判断 stale/missing-source，应增加独立、限速、可暂停的健康任务。
5. **向量内容校验**：目录分析只提取路径、模型和 embedding 类型，不逐元素解析向量；数值有限性、维度和范数健康度应复用 Vector Pipeline 的专用校验，不能由 `malformed=0` 推断。
6. **内存长期目标**：584.35 MiB 已适合当前 15.6 GiB 机器，但仍可通过 Native 二进制快照或 SQLite 临时去重进一步降低。

## 9. 验证

实现包含以下自动化覆盖：

- Native 快照的可见性、更新覆盖、删除隐藏和无逐文件 `stat`；
- Native/DINO/CLIP 并集、缺失层、vector-only、重复、malformed 和目录 rollup；
- v2 无变化复用、append-tail、新增/重复/malformed、Native-only 增量和受影响祖先 child count；
- 源替换/缩短、namespace 变化、Native 删除、旧 schema 与取消的安全全量回退或停止；
- 增量与干净全量的 `indexed_paths`、`folder_rollups`、汇总和逻辑 SHA 精确 parity；
- 混合 model/type 的重复命名空间语义；
- 取消不提交、CURRENT 只读分页、路径边界和转义 JSON；
- IPC、preload、Renderer bridge、UI、i18n 和 worker 打包契约；
- IPC registration/validation、preload contract、TypeScript、ESLint、Prettier、Renderer build 和 Node/Electron Native 构建。

2026-08-03 最终验收结果：

- Data Overview 与文件夹编辑：63/63；
- Native：60/60，其中一次性快照专项 1/1；
- Vector Pipeline：53/53；
- IPC validation 4/4、registration 7/7、preload contract 2/2、i18n 5/5、Image Search shutdown 4/4；
- TypeScript、ESLint、Prettier、Renderer/Electron/Worker 生产构建、runtime manifest 和第三方组件清单均通过；
- 实际 Electron 42.8.0 / Node 24.18.0 已验证 `node:sqlite`、Electron Native `fast_scanner 0.5.23` 和打包后的 catalog worker 可执行；
- 全量 `npm run verify` 在 `face-match` 停止：本机 Model Platform 未安装兼容的人脸检测模型，9 项通过、3 项推理测试失败；该套件在本次功能范围之外，失败前本功能相关套件均已通过，随后也已独立复验上述专项门禁。

2026-08-22 PREP-009 增量验收：

- catalog 专项 15/15、Data Overview 与文件夹编辑 67/67；
- Vector Pipeline 235 通过，2 个外部 CUDA fixture 按设计跳过，0 失败；
- TypeScript 与架构门禁通过，主进程保持 283/283，catalog worker 29/120；
- 当前真实源全量、三轮无变化刷新和隔离 append A/B 通过；源文件快照不变、派生输出隔离；
- ESLint、Prettier、文档标准和 `git diff --check` 见同日[PREP-009 报告](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)。
