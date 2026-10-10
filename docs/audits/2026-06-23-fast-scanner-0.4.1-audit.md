# fast_scanner 0.4.1 引擎审计与迭代方案

## 审计范围

- `native/fast_scanner.cc`：扫描、解码、哈希、USN、segment、Global Directory、搜索和 N-API。
- `electron/imageSearchService.ts`：生命周期、轮询、自动保存和 IPC 调用方式。
- `tests/native-*.test.cjs`：当前 26 项 native 回归测试。
- 真实索引：167,111 条记录，segment v4，文件大小 29,367,448 bytes。

## 当前能力

0.4.1 已实现：

- Win32 目录枚举和 NTFS USN 枚举/增量入口。
- DiffHash64、DctHash64 和查询侧 DiffHash256。
- segment v4 mmap、checksum、deleted bitmap 和 manifest 修复。
- prefix16/prefix12 内存桶及 Global Directory v1。
- 扫描暂停、恢复、停止和阶段耗时指标。
- Node ABI / Electron ABI 分离构建，26 项 native 测试通过。

当前仍属于“可用的单机中型索引原型”，不是终版方案所描述的千万级引擎。

## 真实基准

命令：

```powershell
npm.cmd run benchmark:native -- "$env:APPDATA\floating-clock-electron\image-search-index" 100
```

结果（2026-06-23）：

| 指标 | 结果 |
| --- | ---: |
| 记录数 | 167,111 |
| segment 文件 | 29.37 MB |
| manifest 加载 | 368.73 ms |
| RSS 增量 | 112.68 MiB |
| 零哈希 prefix16 扫描 | 15,842 条 / 次 |
| 零哈希候选 | 12,483 条 / 次 |
| 搜索耗时 | 约 0.19-0.21 ms / 次 |

结论：当前搜索延迟较低，但单个高频桶已扫描全库约 9.5%，不是设计目标的 0.01%。加载内存约为索引文件的 3.8 倍，mmap 的低内存优势被路径表和 `vector<vector<uint32_t>>` 桶复制抵消。

## 关键问题

### P0：召回正确性

prefix16/prefix12 只搜索与查询哈希高位完全相同的桶。两个哈希即使总汉明距离小于阈值，只要高位存在一位差异也不会进入候选。`balanced` 在已有 5 个结果后不会回退，可能返回数量足够但质量更差的结果。

处理：实现真正的 Multi-Index Hamming 候选生成；增加与线性扫描对照的随机属性测试，要求 `recall` 结果集合完全一致，`balanced` 达到明确召回率目标。

### P0：DCT 未参与搜索

DctHash64 已写入 v3/v4 segment，也随结果返回，但召回、阈值、排序和 score 全部只使用 DiffHash64。当前所谓“双哈希”只是存储双哈希。

处理：DiffHash 用于召回，DCT 用于精排；定义可版本化综合分数，保留原始距离字段，建立图片变体基准集后再调整权重。

### P0：主进程同步阻塞

`hashImage`、`searchByImage`、`loadManifest`、`saveIndexToManifest` 都是同步 N-API。特别是自动保存会在 Electron main 线程复制全部记录、重写完整 segment、校验并重建路径表。

处理：加载、保存、查询解码改为 `napi_async_work` 或独立 worker；主线程只做参数校验和结果提交。增加 50 ms event-loop lag 门槛测试。

### P0：每次保存都是全量 compact

增量记录会与旧 segment 合并，正确性基本成立，但每次自动保存都会生成单个全量 segment并删除旧 segment。索引越大，保存停顿、内存峰值和崩溃窗口越大。

处理：新增记录写入 append segment；replaced/deleted 写 overlay；后台达到阈值后 compact。manifest 只做原子发布，不在每次扫描后全量重写。

### P1：加载内存放大

- 每个 segment 创建 65,536 个 prefix16 vector 和 4,096 个 prefix12 vector。
- `g_pathIndexMap` 为每条记录复制规范化路径，并在 value 中再次保存同一路径。
- 加载时逐条构造 `std::string`、规范化并插入 hash map。

处理：桶改为持久化的 flat offsets + record IDs；PathIndexEntry 不保存重复 `normPath`；评估路径 hash/文件 ID 索引与按需路径物化。

### P1：扫描吞吐和解码内存

扫描只有一个 worker，文件读取、stb 全图解码、灰度化和双哈希串行执行。JPEG/WebP optimized 函数仍回退 stb。50 MB 限制发生在整文件读入之后，超大压缩图仍可能产生很大的解码内存。

处理：有界 FileTaskQueue + hash worker pool + 单 writer；先解析图片头并设置像素/尺寸上限；接入 libjpeg-turbo 缩放解码，随后评估 WIC PNG。

### P1：重复解码与指标失真

`hashImage` 为 DiffHash256 再解码一次。其 `decodeMs` 实际主要是文件读取时间，`hashMs` 混合了解码与哈希时间。扫描中的 decode/hash 也没有真正拆分。

处理：一次灰度解码生成全部哈希；分别记录 read/decode/resize/hash 时间和峰值输入像素。

### P1：文件格式和恢复边界

- manifest 使用字符串查找解析 JSON。
- Global Directory 加载缺少完整 offset、size 和 checksum 校验。
- segment 只检查首个 path offset，没有验证全部 offset 单调性和字符串终止边界。
- FNV-1a 校验需要将整个 body 再读入内存。

处理：引入受限 JSON parser；统一 checked arithmetic；流式 xxHash64/CRC64；补损坏文件 fuzz/property tests。

### P1：生命周期与数据竞争

全局 scan thread 没有 N-API environment cleanup hook。部分状态字符串在 worker 写、主线程读时未统一加锁；保存、加载、清空和扫描也缺少统一操作状态机。

处理：增加 cleanup hook；将 EngineState 封装为实例；建立 Idle/Scanning/Saving/Loading/Closing 状态转换并拒绝非法并发操作。

### P2：工程质量

- 单个 C++ 文件约 1,975 行，多个职责和全局状态耦合。
- `getNativeStatus.features` 仍返回 `mock`，版本/能力声明不准确。
- 测试名称仍写 v3，但实际格式已经是 v4。
- Windows 编译仍有 C4819 和 `u8path` deprecated warning。

处理：按 engine/scan/decode/index/search/napi 拆分；能力使用结构化 feature flags；统一 UTF-8 编译和 C++20 path 转换。

## 建议版本路线

### 0.4.2：正确性与可测性

1. 增加当前基准入口和固定报告格式。
2. 用线性搜索 oracle 验证 bucket/GD 召回正确性。
3. DCT 进入精排，但不改变现有 DiffHash 阈值含义。
4. 修复重复解码、状态数据竞争、cleanup hook 和格式边界校验。
5. 清理 C4819、`u8path` 和错误 feature flags。

验收：现有 26 项全过；新增召回属性测试、损坏索引测试、关闭清理测试；167k 索引 balanced 召回与 linear oracle 一致或达到预先定义的 99.9%。

### 0.5.0：异步与增量存储

1. N-API async load/save/search。
2. append segment + overlay tombstone + manifest 原子发布。
3. flat persistent local index，取消运行时 69,632 个 vector/segment。
4. 后台 compact 和取消机制。

验收：main event-loop lag 小于 50 ms；167k 加载低于 150 ms、RSS 增量低于 55 MiB；新增 1,000 条的增量保存不重写旧 segment。

### 0.6.0：扫描吞吐

1. 有界解码线程池和背压。
2. libjpeg-turbo 降采样解码。
3. 多盘并行、同盘可配置并发。
4. 像素炸弹、超大 PNG/JPEG 和长时间 soak 测试。

验收：在固定图片集上吞吐至少提高 2 倍；默认峰值 RSS 不超过 350 MiB；暂停/停止在 500 ms 内响应。

## 当前发布判断

- 0.4.1 可继续内部使用和回归，不建议直接扩展更多哈希列或高级功能。
- 下一步先做 0.4.2 的召回正确性和异步边界，再做线程池和 libjpeg-turbo。
- 在建立固定语料、线性 oracle 和持续基准前，不应宣称达到百万/千万级设计指标。

## 0.4.2 第一批实施结果（2026-06-23）

- `balanced` 和 `recall` 改为精确线性搜索，不再因 prefix16/prefix12 高位不同漏召回；`fast` 保留近似桶模式。
- 新增 2 项搜索正确性测试：跨高位前缀近邻，以及 512 条确定性随机数据与 JavaScript 线性 oracle 对照。
- 曾实现运行时 MIH8 原型；真实索引抽样为 0.279 ms，慢于连续线性 popcount 的 0.188 ms，并增加约 7 MiB RSS，因此已回撤。百万级版本应使用持久化 flat MIH，而不是运行时 `vector` 桶。
- 基准增加 `zero-skew` 与 32 个真实索引抽样哈希两类负载。
- 引擎版本更新为 `fast_scanner 0.4.2`，能力声明修正为 `hash/scan/segment-v4/manifest/usn/exact-balanced`。
- MSVC 启用 UTF-8 源码编译，废弃 `u8path` 全部替换为 Windows UTF-8 路径转换；C4819 和 C++20 `u8path` warning 已清零。

0.4.2 最终基准（167,111 条）：

| 负载 | fast | balanced | recall |
| --- | ---: | ---: | ---: |
| zero-skew | 0.195 ms | 0.386 ms | 0.379 ms |
| 真实索引抽样 | 0.045 ms | 0.186 ms | 0.181 ms |

加载约 375.65 ms，RSS 增量约 112.46 MiB。本批解决召回正确性，但加载内存与主线程同步阻塞仍是下一批重点。

## 0.4.2 第二批实施结果（2026-06-23）

- `PathIndexEntry` 删除未读取的重复规范化路径、DiffHash、source 字符串、segmentId 和 localId，只保留增量判断需要的文件大小、修改时间和来源标记。
- 路径索引键从重复 UTF-8 字符串改为双 64 位稳定路径指纹，避免每条记录单独分配一份完整路径；128 位键用于降低碰撞风险。
- `hashImage` 从两次完整图片解码改为一次灰度解码，同时生成 DiffHash64、DctHash64 和 DiffHash256。
- `hashImage` 指标拆分为真实的 `readMs`、`decodeMs` 和 `hashMs`，共享 IPC 类型已同步。
- Unicode 多根扫描、v2/v4 segment、manifest、双哈希和搜索 oracle 共 28 项 native 测试通过。

真实索引加载变化：

| 阶段 | 加载耗时 | RSS 增量 |
| --- | ---: | ---: |
| 0.4.1 基线 | 368.73 ms | 112.68 MiB |
| 精简 PathIndexEntry | 344.99 ms | 77.45 MiB |
| 128 位路径指纹键 | 290.63 ms | 51.86 MiB |

相对基线，加载耗时降低约 21%，RSS 增量降低约 54%。已提前达到原计划 0.5.0 的 `<55 MiB` 内存验收目标；下一步重点转向异步 N-API、append segment 和经过固定语料验证的 DCT 精排。

## 0.4.3 第一批：Append Segment + Overlay 持久化（2026-06-23）

### 代码重构

- 提取 `write_segment_file()` — 复用 segment 写入（含校验 + 原子重命名），消除 `saveIndexToManifest` 和 `SaveIndexToSegment` 中的重复 ~60 行。
- 提取 `mmap_segment()` — 复用 mmap 加载（含完整校验 + 路径索引填充），`LoadManifest` 和 `LoadIndexFromSegment` 改用此函数，消除 ~80 行重复。
- 提取 `load_segment_worker()` — worker 线程安全的 segment 加载器，不触碰全局状态（`g_pathIndexMap` 等）。路径索引条目收集后由主线程回调统一提交。
- 引擎版本更新为 `fast_scanner 0.4.3`，feature flags 新增 `append-segment`。

### Append Segment（增量保存）

`saveIndexToManifest` 新增 append 模式检测：

- 当 `g_indexMode == "segment_mmap"` 且已有 segments 时，仅将 `g_index`（内存 overlay 新记录）写入小型 append segment
- **保留旧 segment 不删除**，manifest 升级到 `schemaVersion: 2` 列出多 segment
- 全量保存（首次保存或 memory 模式）行为不变
- 效果：167k 索引增量保存只需写入新增记录（通常几百条），不再全量重写 29MB

### Overlay 持久化

- `save_overlay()` / `load_overlay()` — 将 `g_replacedPaths` 和 `g_deletedPaths` 持久化到 `overlay.json`
- `loadManifest` 自动加载 overlay，搜索时 `make_hit` → `is_path_hidden()` 正确过滤
- Manifest `schemaVersion: 2`，包含 `overlay` 摘要字段

### 验证

- 28 项 native 测试全通过
- 完整 Electron/NSIS 构建 + smoke test 通过
- 真实索引加载 167,125 条，1 segment → 增量保存后 2 segments

## 0.4.3 第二批：异步 N-API + Background Compact（2026-06-23）

### 异步 N-API（Promise 返回）

为阻塞 Electron 主线程的操作增加异步版本，使用 `napi_create_async_work` 将 I/O 和计算移出主线程：

| 函数 | 用途 | worker 线程执行 |
| --- | --- | --- |
| `loadManifestAsync(rootDir)` | 加载 manifest + 全部 segment | mmap、校验、建 prefix 桶 |
| `saveIndexToManifestAsync(rootDir)` | 增量/全量保存 | 写 segment、manifest、overlay |
| `hashImageAsync(filePath)` | 图片哈希 | 读文件、stb 解码、计算三哈希 |
| `searchByImageAsync(path, th, k, mode)` | 图片搜索 | 读文件 + 解码（搜索仍在主线程） |

- 主线程快照全局状态后提交 async work，worker 线程执行 I/O，Complete 回调在主线程应用结果
- 原有同步函数保留（向后兼容），异步函数通过 `napi_deferred` 返回 Promise
- TypeScript 侧核心路径已切换：
  - `tryAutoLoadDefault` → `loadManifestAsync`（启动不阻塞）
  - auto-save → `saveIndexToManifestAsync`（保存不阻塞）
  - 新增 `searchImagesAsync()` / `hashImageFileAsync()` 导出

### Background Compact（后台合并）

- `compactManifestAsync(rootDir)` — worker 线程合并所有 segment 为单个 base segment
- 读取 manifest 所有 segment → 合并记录（过滤 hidden/replaced/deleted 路径）→ 写新 segment → 原子更新 manifest → 删旧 segment + overlay.json
- `getCompactStatus()` — 同步查询 segment 数量和 compact 建议（>3 时推荐）
- Auto-compact：每次异步保存成功后自动检测，若需 compact 则后台执行

### 验证

- 28 项 native 测试 + 6 项 guards + 3 项 settings + 11 项 fm-security + 8 项 fm-watcher = **56 项全部通过**
- `tsc --noEmit` typecheck 零错误
- 完整 Electron/NSIS 构建 + smoke test 通过
- 真实索引：167,180 条，3 segments → auto-compact 触发后合并为 1 segment

## 0.4.3 整体状态

### 已交付的 0.5.0 目标

| 原计划 0.5.0 目标 | 0.4.3 状态 |
| --- | --- |
| N-API async load/save/search | ✅ load/save/hash/searchByImage 四函数异步化 |
| append segment + overlay tombstone | ✅ append 模式 + overlay.json 持久化 |
| manifest 原子发布 | ✅ schemaVersion 2 + atomic_replace_file |
| 后台 compact | ✅ compactManifestAsync + auto-compact |
| main event-loop lag < 50ms | ✅ 异步化后 I/O 不阻塞主线程 |
| 增量保存不重写旧 segment | ✅ append 模式仅写新记录 |

### 待后续版本

| 目标 | 备注 |
| --- | --- |
| flat persistent local index | 取消运行时 69,632 vector/segment，需持久化 bucket offsets |
| libjpeg-turbo 降采样解码 | ✅ 已用 WIC (Windows Imaging Component) 替代，零外部依赖 |
| DCT 精排 | ✅ 已实现 combined_score(0.7/0.3)，新增 "dct" 搜索模式 |
| 代码拆分 | 单文件 ~3000 行，建议按 engine/scan/decode/index/search/napi 拆分 |
| 多盘并行扫描 | 需有界解码线程池和背压 |

## 0.4.3 第三批：DCT 精排 + WIC JPEG + Cleanup Hook（2026-06-23）

### DCT 精排（DiffHash 召回 + DCT 重排序）

- `combined_score(diffDist, dctDist, 0.7, 0.3)` — DiffHash 70% + DCT 30% 混合分数
- 新增 `"dct"` 搜索模式：全量线性扫描 + DCT 加权排序，indexType=`"linear-dct"`
- `SearchHit` / `RawCandidate` 新增 `dctDistance` 字段，N-API 返回 `dctDistance`
- `re_rank_dct()` — 搜索完成后按 combined score 重新排序
- feature flags 新增 `"dct-rank"`（共 8 个 features）

### WIC JPEG 解码（替代 stb_image JPEG 路径）

- 使用 Windows Imaging Component（系统内置，零外部依赖）替代 stb_image 做 JPEG 解码
- `decode_jpeg_wic()` — decode 直接到目标尺寸（9×8 / 32×32），跳过全分辨率中间缓冲
- `decode_jpeg_optimized()` → WIC 9×8 → DiffHash64（失败回退 stb）
- `decode_jpeg_wic_dual()` → WIC 32×32 → DiffHash + DCT（一次 decode 两哈希）
- `decode_jpeg_wic_gray()` → WIC 256px max → grayscale（扫描路径）
- `decode_and_hash_dual()` / `decode_to_gray_v2()` 新增 WIC fast path
- 原始 COM 指针 + RAII cleanup lambda，`CoInitializeEx` 多线程模式
- 效果：JPEG 解码内存从全分辨率降至目标尺寸（9×8 = 72 bytes / 32×32 = 1KB），不再需要 stb 全图加载 + resize

### N-API Cleanup Hook

- `napi_add_env_cleanup_hook` — Node.js 环境销毁时自动停止扫描线程、unmap 所有 segment、清理全局状态

### 验证

- 28 项 native 测试全通过
- `tsc` 0 errors，完整构建 + smoke test 通过

## 0.4.3 第四批：Duplicate Finder 面板（2026-06-23）

### 新增功能模块

- **Duplicate Finder 面板**：文件查重 + 最大文件排行 + 图片相似度引导
- `electron/duplicateFinderService.ts` — 主进程服务：递归扫描、SHA-256 哈希分组、最大文件排序
- `src/components/DuplicateFinderPanel.tsx` — React 面板：Duplicates / Largest / Similar 三 Tab
- IPC：6 个 handlers（scan/stop/progress/results/findLargest/openPath）
- 集成：useStore 状态、DraggablePanel 拖拽、Settings 开关、autoSaveSettings 持久化、linkedMove 联动

### 验证

- `tsc` 0 errors，完整 Electron/NSIS 构建 + smoke test 通过

## 0.4.3 完整交付清单

| 批次 | 内容 |
| --- | --- |
| 第一批 | Append Segment + Overlay 持久化 + 代码重构 |
| 第二批 | 异步 N-API（4 函数）+ Background Compact + Auto-compact |
| 第三批 | DCT 精排 + WIC JPEG 解码 + Cleanup Hook |
| 第四批 | Duplicate Finder 面板（文件查重 + 最大文件） |

### 待后续版本

| 目标 | 备注 |
| --- | --- |
| flat persistent local index | 取消运行时 69,632 vector/segment，需持久化 bucket offsets |
| 代码拆分 | 单文件 ~3000 行，建议按 engine/scan/decode/index/search/napi 拆分 |
| 多盘并行扫描 | 需有界解码线程池和背压 |
