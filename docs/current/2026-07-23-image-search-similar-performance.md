# Image Search Similar 大库检索性能修复

> 状态：当前  
> 更新日期：2026-07-23  
> 范围：Image Search Fast / Standard / Precise 图片相似搜索  
> 替代文档：无  
> Git 边界：未提交现场；仓库已初始化但尚无首个提交

## 执行环境确认

- 执行身份：Codex。
- 模型信息：GPT-5 系列；精确公开小版本未知。
- 代理系统：Codex 当前运行时；本轮未启动 Codex 子代理。
- 外部代理：用户已说明此前 agents 属于 Kimi；本轮未读取、调用或代替 Kimi agents，也未把其状态写成本轮验证结果。
- 文档入口：`docs/README.md`。
- 事实基线：当前源码、`<DATASET>` 实际数据、当前 AppData 索引/向量缓存、专项测试和构建输出。

## 当前结论

Image Search Standard/Precise 原来会为每次查询重新流式读取并解析约 4.92 GiB 的 DINO JSONL 向量库。当前实现已改为复用约 427 MiB 的 Float16 连续向量缓存，并增加真实取消、最小堆 Top-K、活动索引过滤、DINO 常驻查询 worker 和 GPU/CPU 设置注入。

真实库 Top 200 加活动路径过滤的精确扫描约为 2.84 秒；旧 JSONL 路径估算约为 14–16 秒。用户在修复后的程序中确认“速度比之前快很多了”。

Fast 模式仍使用原生感知哈希索引。同一张 D 盘查询图片的端到端实测约为 300 ms，其中原生索引内部检索低于 1 ms，主要时间来自读取、解码查询图片和计算哈希。

## 数据规模

2026-07-23 检查得到：

| 项目                                   |              实际值 |
| -------------------------------------- | ------------------: |
| `<DATASET>` 文件数       |             116,000 |
| 目录总大小                             |          184.14 GiB |
| 该目录进入 DINO Float16 路径缓存的图片 |              57,953 |
| Image Search manifest 记录数           |             251,235 |
| Image Search 原生 segment              |   1 个，约 40.6 MiB |
| DINO 原始 JSONL                        | 5,283,876,691 bytes |
| DINO 原始记录数                        |             319,537 |
| DINO Float16 去重记录数                |             291,680 |
| DINO Float16 向量文件                  |   448,020,480 bytes |
| DINO Float16 路径索引                  |    40,764,052 bytes |

这些数据说明目录体积是规模来源，但查询时没有逐张读取 184 GiB 原图。Standard/Precise 的原瓶颈是 C 盘 AppData 中数 GiB 向量 JSONL 的重复解析；Precise 首次提取颜色/形状特征时才会额外随机读取候选原图。

## 根因复盘

### 1. 大库强制退化为 JSONL 全量扫描

`electron/vectorIndexService.ts` 在 embedding 文件超过 512 MiB 时进入 streaming 模式。旧实现每次查询都逐行执行 JSON 解析、768 维数字转换、点积和 Top-K 更新。

抽取 20,000 行、316 MiB 的同机热缓存基准耗时约 950 ms，外推完整库约 14–16 秒。

### 2. 查询 DINO 后端被写死为 CPU

旧 `electron/rerankService.ts` 向 DINO child 发送固定的 `backend: 'cpu'`，没有读取 `vector-settings.json` 中的 GPU 设置。每次查询还会新建 child 并重新加载模型；CPU 单图冷启动实测约 877 ms。

### 3. 超时不能终止后台扫描

旧实现用 `Promise.race` 返回 30 秒超时，但 JSONL 流没有取消信号。超时查询可能继续占用磁盘和 CPU；再次查询会叠加第二次全库扫描。

### 4. 向量候选范围大于活动 Image Search 索引

原始 DINO 数据包含重复历史记录和其他共享向量来源。旧搜索没有在评分阶段限制当前 Image Search 活动路径，非活动或非图片索引向量可能浪费计算并占据 Top-K。

### 5. Top-K 更新为线性找最小值

旧 `pushTopK` 在候选数组满后，每加入一个候选都会遍历整个 Top-K。Top-K 越大，额外比较越多。

### 6. Fast 名称和实际参数不一致

Image Search UI 选择 Fast 时旧代码仍向原生层传递 `balanced`。此外 UI 的 `searchMs` 只显示原生索引内部耗时，没有包含查询图片解码和哈希计算，用户看到的数字与实际等待时间不一致。

## 已完成修复

### Float16 精确搜索公共能力

`electron/embeddingF16Cache.ts` 新增 `searchEmbeddingF16Cache`：

- 复用 latest-wins Float16 连续向量文件；
- 归一化查询向量；
- 使用固定大小最小堆维护 Top-K；
- 支持协作取消；
- 支持活动路径过滤；
- 分数稳定排序，相同分数按缓存 row 决定顺序；
- 作为公共能力可继续被 Image Search、NekoSearch 或后续 ANN 回退链复用。

`electron/vectorIndexService.ts` 在大 embedding 文件场景优先确保并读取 Float16 缓存，仅在缓存不可用时保留 JSONL 兼容回退。JSONL 回退本身也增加了取消和活动路径过滤。

### 真实取消和迟到结果保护

- `shared/vectorTypes.ts` 为主进程内部向量查询增加 `isCancelled` 和 `acceptPath`，不通过 IPC 序列化函数。
- `electron/rerankService.ts` 为每次 layered search 分配 generation；新查询会使旧查询取消。
- 向量超时会设置取消状态，Float16/JSONL 扫描在下一检查点退出，不再后台继续全库工作。
- `src/components/ImageSearchPanel.tsx` 只接受当前 request ID 的响应；旧请求的 `finally` 也不能清除新请求的 searching 状态。

### DINO 常驻查询 worker 与后端设置

- `electron/vectorIpc.ts` 从当前 Vector Settings 读取 `backend`，由主进程注入 layered search。
- `electron/rerankService.ts` 按 `backend + modelPath` 复用常驻 DINO child。
- 同一后端的后续查询复用已加载 extractor；切换 CPU/GPU 时终止旧 worker 并重建。
- 查询超时或取消会终止当前 worker，避免不可取消的模型推理残留。
- GPU 初始化失败时仍沿用 child 内已有的 CPU 回退行为。

### 活动 Image Search 路径过滤

`native/fast_scanner.cc` 新增 `hasIndexPath`，直接查询现有 `g_pathIndexMap`，单次为 O(1)：

- 已从索引删除的路径返回 false；
- 路径修复后的新路径返回 true，旧路径返回 false；
- `electron/imageSearchService.ts` 暴露主进程内部 `isImageSearchIndexedPath`；
- Vector IPC 将其作为 Hash delegate 的活动路径判断；
- Float16 和 JSONL 向量评分只允许当前活动 Image Search 路径进入 Top-K。

这避免视频帧、历史删除项或未进入当前图片索引的共享向量占据结果。

### Fast 和耗时显示修正

- `src/components/ImageSearchPanel.tsx` 的 Fast 分支现在传递真正的 `searchMode: 'fast'`。
- `electron/imageSearchService.ts` 的异步图片查询返回端到端墙钟耗时，包含图片读取、解码、哈希和原生检索。

## 实测结果

查询图片：

```text
<DATASET>\pxhere-001100\46495.jpg
```

### 原链路诊断

| 阶段                   |        结果 |
| ---------------------- | ----------: |
| Fast 端到端            |   约 300 ms |
| 原生哈希内部搜索       |   低于 1 ms |
| DINO CPU 单图冷启动    |   约 877 ms |
| Float16 全量扫描加点积 |   约 2.1 秒 |
| 旧 JSONL 全量扫描外推  | 约 14–16 秒 |

### 修复后 Float16

| 配置                   |     耗时 | 结果                               |
| ---------------------- | -------: | ---------------------------------- |
| Top 50                 | 2,141 ms | 原图第一                           |
| Top 200                | 3,561 ms | 原图第一                           |
| Top 500                | 3,802 ms | 原图第一                           |
| Top 200 + 活动路径过滤 | 2,839 ms | 200/200 均为活动索引路径，原图第一 |

不同轮次受 OS 文件缓存、垃圾回收和系统负载影响；当前结论应理解为 2–4 秒级精确扫描，而不是固定 SLA。

## 验证

| 项目                        | 命令或方式                                                                                                                                                                                                              | 结果                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| TypeScript                  | `npm.cmd run typecheck`                                                                                                                                                                                                 | 通过                               |
| Float16 / IPC / Vector 专项 | `node --test tests/embedding-f16-cache.test.cjs tests/vector-pipeline.test.cjs tests/media-search-guards.test.cjs tests/search-setup-workflow.test.cjs tests/preload-contract.test.cjs tests/ipc-registration.test.cjs` | 43 项通过                          |
| 修改后核心复验              | `node --test tests/embedding-f16-cache.test.cjs tests/vector-pipeline.test.cjs tests/preload-contract.test.cjs tests/ipc-registration.test.cjs`                                                                         | 21 项通过                          |
| Native 路径编辑/活动判断    | `node --test tests/native-scan.test.cjs`                                                                                                                                                                                | 2 项通过                           |
| 真实 active path 检查       | 加载真实 manifest 后调用 `hasIndexPath`                                                                                                                                                                                 | 已知路径 true，虚构路径 false      |
| 真实 Float16 Top 200        | 真实 291,680 条缓存 + native active filter                                                                                                                                                                              | 2,839 ms；200/200 active；原图第一 |
| 完整构建                    | `npm.cmd run build`                                                                                                                                                                                                     | 通过，159.5 秒                     |
| 用户人工反馈                | 修复后实际搜索                                                                                                                                                                                                          | “速度比之前快很多了”               |

Float16 测试新增覆盖：

- Top-K 排名正确；
- 两次运行结果稳定；
- 搜索中取消会抛出 cancelled；
- 缓存 latest-wins 行为保持不变。

Native 测试新增覆盖：

```text
scan -> save -> repair path -> update -> index-only delete
     -> save -> clear -> reload
     -> hasIndexPath(old/deleted/new)
```

## 构建产物

最终安装包：

```text
release/FloatingClock Setup 1.0.0.exe
```

本轮没有自动安装或覆盖用户当前运行版本。验证新行为需要重新启动开发构建，或手动安装最新安装包。

## 剩余风险

1. 当前仍是 291,680 × 768 的精确扫描，Float16 减少了解析和 I/O，但复杂度仍为 O(N × D)。
2. 路径索引仍为 JSONL；每次搜索要解析约 39 MiB 路径文件，并跨 N-API 调用活动路径判断。
3. Float16 搜索当前在 Electron 主进程协作让出事件循环，并非独立 worker；UI 可响应，但仍会占用主进程 CPU。
4. 首次 GPU 查询仍有 DirectML/模型初始化成本；常驻 worker 主要改善同一进程内后续查询。
5. Precise 模式首次遇到未缓存候选时，仍可能从大目录随机读取原图生成颜色/形状特征。
6. 当前 Git 仓库没有首个提交，本轮属于未提交现场，不能提供提交号或可靠的 Git 回退点。

## 下一步

### P0：HNSW/ANN 向量索引

目标是把当前 2–4 秒级精确扫描降至百毫秒级：

1. 以当前 Float16 latest-wins cache 为构建源。
2. 建立版本化 HNSW/ANN 派生索引，记录 model、dim、source signature 和活动 manifest signature。
3. 查询先 ANN 召回，再用 Float16 精确重排。
4. ANN 不可用、损坏或版本过期时回退当前精确扫描。
5. 提供 Recall@K、构建耗时、索引体积和查询 P50/P95 门禁。

### P1：进一步减少精确扫描开销

1. 把路径索引改为紧凑二进制表或稳定 row-to-path 表，避免逐行 JSON 解析。
2. 把活动 manifest 映射为位图/row allowlist，避免每个向量一次 N-API 调用。
3. 将精确扫描迁入可取消 worker，并保留当前公共 API。
4. 为 UI 显示 query embedding、vector retrieval、rerank 和 thumbnail 四段耗时。

## 对话进度摘要

本轮对话中的关键进度按发生顺序记录如下：

1. 用户反馈搜索 `<DATASET>` 时 Similar 仍慢，要求再次分析。
2. 先区分 NekoSearch Similar 与 Image Search 图片相似查询；通过资产数据库和路径缓存确认目标是 Image Search 链路。
3. 实测 Fast、DINO 单图冷启动、Float16 扫描、JSONL 抽样吞吐和完整 worker 成本。
4. 确认主因是 Image Search Standard/Precise 未复用现有 Float16、查询后端写死 CPU、超时不取消和活动路径未过滤。
5. 用户要求开始修复。
6. 完成 Float16 搜索、真实取消、最小堆、GPU/CPU 设置、常驻 DINO worker、活动路径过滤、Fast 参数和耗时显示修正。
7. 完成真实库基准、TypeScript、专项测试、Native 测试和最终安装包构建。
8. 用户确认修复后的速度比之前快很多。
9. HNSW/ANN 被确定为下一阶段，而不是本轮已完成能力。

## 2026-07-24 后续状态

本文的 P0 ANN 下一步已经进入实现并通过真实库初步门槛。当前事实、准确率、性能、回退链和
剩余风险以
[`2026-07-24-image-search-ann-optimization.md`](2026-07-24-image-search-ann-optimization.md)
为准。当前实现是内置稀疏 SimHash 多探针 ANN 加 Float16 精确重排，不应写成 HNSW 或
FAISS。
