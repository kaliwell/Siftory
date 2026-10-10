# Image Search 数据编辑管理器与缩略图重建

> 状态：当前
> 更新日期：2026-08-17
> 范围：Image Search 数据编辑、索引维护与缩略图重建
> 替代文档：无

日期：2026-07-23

更新：2026-08-02

## 执行环境确认

- 本轮由 Codex（GPT-5 系列）执行。
- 未调用 Kimi agents，也未把其他模型的工作状态视为本轮验证结果。
- 确认方式：以当前会话系统身份、实际工作区源码、当前机器测试输出为准。

## 已实现能力

Image Search 面板新增 `Data Editor Manager` 入口，集中提供：

1. 按完整路径或路径片段查询当前原生 Image Search 索引。
2. 查看源文件是否存在、原始分辨率和文件大小。
3. 对单条记录重新读取源图、计算 DiffHash/DCT Hash，并原子保存 manifest/segment overlay。
4. 只删除索引记录，不删除源文件；删除需要二次确认。
5. 源文件移动后执行旧路径到新路径修复：
   - 新文件必须存在；
   - 新文件大小必须与旧索引记录一致；
   - 新路径不能已经存在于索引；
   - 内容发生变化时必须使用 `Update Selected`，不能冒充路径移动。
6. 对选中图片或全部 Scan Paths 重建优化缩略图。
7. 对一个绝对文件夹执行 Native/Hash、DINO、CLIP 三层索引的可选批量删除；先只读分析，
   再使用一次性确认令牌执行，源图片始终不删除。完整边界见
   [指定文件夹多层索引编辑](2026-08-02-image-search-folder-index-editor.md)。

## 缩略图重建

- 后台枚举受支持的图片格式。
- CPU 解码和回退最多 3 个全局任务，和正常列表缩略图共用限流器。
- 可选择 `Auto (adaptive CPU/GPU)`、`GPU preferred` 或 `CPU only`：
  - Auto/GPU 使用可配置数量的隐藏且隔离的 Chromium worker；
  - Auto 会把不超过 2 MB、且浏览器支持的图片交给 GPU；较大图片直接交给 Sharp CPU，使两条流水线并行，避免大文件的 GPU 传输与回读成本；
  - JPEG、PNG、WebP、GIF、BMP、AVIF、ICO 优先由 WebGL/ANGLE 在 GPU 上等比例缩放；
  - WebP 编码、文件读取和图片元数据检查仍由 CPU 完成，界面不把它误报为全流程 GPU；
  - TIFF、PSD、不支持的编解码器、软件 WebGL、驱动错误或单图 GPU 失败会自动回退 Sharp；
  - `GPU Jobs` 和 `Batch` 均可按偶数在 2/4/6/8/10/12/14/16/18/20 间调整；
  - GPU Jobs 控制逻辑流水线并发，最多复用 8 个物理 GPU renderer context，避免创建 20 个 Chromium 窗口造成额外内存开销；
  - Batch 控制每个逻辑 job 的图片预读深度；后端保证 `Jobs × 实际 Batch ≤ 40`，必要时会降低并在进度中显示实际 Batch，避免 20×20 同时解码 400 张大图；
  - Batch 会在上一张进行 GPU 缩放/编码时并行预解码后续图片；主进程不再逐张等待 renderer 返回，并移除了每张图片的 `gl.finish()` 强制同步；
  - GPU 任务不再占用固定的 3 个 CPU 解码槽；只有失败后回退 Sharp 的图片才进入 CPU 限流器；
  - UI 显示实际 backend、jobs、batch、img/s、GPU/CPU 完成数、fallback 数量、GPU 设备和不可用原因。
- 强制按当前 v3 规则重建 256px WebP 缓存。
- 64px/128px 请求允许复用已生成的 256px 缓存，避免再次解码原图。
- UI 显示总数、完成数、失败数、跳过数、当前路径和进度。
- 支持停止；停止后保留已经成功生成的缓存。
- 完成后执行 1GB LRU 磁盘缓存裁剪。

## 索引持久化修复

本轮发现并修复两个既有问题：

1. `IdxMetaFwd` 原来缺少磁盘结构中的 `flags/reserved`，导致 segment 第二条及后续记录使用错误步长读取宽高、大小和 mtime。现在保持与 `IdxMeta` 相同的 packed 32-byte stride。
2. `overlay.json` 保存 Windows 路径时会转义反斜杠，但加载和 compact 时没有反转义，导致 deleted/replaced 路径重启后失效。现在加载和压缩流程统一反转义。

新增原生回归覆盖：

```text
scan -> save manifest -> move source -> repair path
     -> update record -> index-only delete -> save
     -> clear memory -> reload manifest -> verify paths
```

## 向量数据边界

- 删除或路径修复后，Semantic Search 的候选集合会读取 `overlay.json`，过滤 deleted 路径并按 manifest 顺序去重，因此旧路径不会因为残留 CLIP cache 再次返回。
- 单条 `Update Selected` 会立即刷新 Hash 索引；已有 DINO/CLIP embedding 仍代表更新前内容。
  图片内容发生变化后，应再执行缺失/更新 embedding 构建。文件夹管理器现在可以按路径从
  DINO/CLIP 权威 JSONL 中删除整棵子树并使派生缓存失效，但不允许手工修改单个浮点向量。
- NekoSearch 同步仍以最新 Image Search manifest 为准；需要在编辑后执行 `Sync Image Index` 才会刷新其素材状态。

## 验证结果

```text
IPC registration: 4/4 passed
Preload contract:  1/1 passed
Native tests:      31/31 passed
TypeScript:        passed
ESLint:            passed
Prettier check:    passed
Renderer build:    passed
Node native build: passed
Electron native:   passed
Electron UI smoke: 6 panels, 0 console errors, passed
GPU runtime smoke: NVIDIA RTX 3050 / D3D11, Auto 4 jobs / batch 2,
                   GPU 24, CPU 40, fallback 0, 3293 ms
20/20 safety smoke: requested 20 jobs / batch 20, effective 20/2,
                    GPU 400, CPU 0, fallback 0, 1567 ms
```

从 `<DATASET>` 抽取 64 张不同图片（约 193 MB）的同机重建基准，包含 worker 初始化，不含 UI smoke 其他步骤：

| Backend / 配置              |    耗时 | 相对 CPU |
| --------------------------- | ------: | -------: |
| CPU / 3 slots               | 3967 ms |     基线 |
| 强制 GPU / 4 jobs / batch 2 | 4325 ms |    慢 9% |
| 强制 GPU / 8 jobs / batch 4 | 3828 ms |    快 4% |
| Auto / 4 jobs / batch 2     | 3293 ms |   快 17% |

默认采用 `Auto + 4 jobs / batch 2`。强制 GPU 对大文件反而更慢，原因是浏览器解码、主进程到 GPU worker 的字节传输和 WebP 回读抵消了缩放收益；`GPU preferred` 主要保留给大量小图场景和手动基准，不作为通用默认值。

GPU 占用率不是此任务的主要性能指标：输出只有最多 256×256，GPU 缩放阶段很短；磁盘读取、JPEG/PNG 解码和 WebP 编码仍是 CPU 工作。即使调度正常，RTX 级 GPU 也不会长期满载，应以 UI 的 `img/s` 和总耗时比较配置。为了提高占用率而重复计算或扩大纹理只会降低实际速度。

UI smoke 截图：

`artifacts/ui-smoke/screenshot.png`

GPU 运行证据记录在：

`artifacts/ui-smoke/report.json`

## 来源文件夹浏览与 Native-only 批量删除（历史实现）

本节记录原有来源文件夹按钮上的 Native-only 删除实现；底层 IPC 为兼容性保留。2026-08-02
后，来源文件夹按钮和“管理文件夹索引”都进入新的多层编辑器，可以同时选择 Native/Hash、
DINO 和 CLIP，并采用预览、磁盘预检、原子改写和恢复备份。

在查询区上方新增“来源文件夹”条，把当前设置的扫描路径渲染为可切换按钮：

- 点击文件夹 F 会把查询词设为 F 并立即执行查询（pathLike 查询词在 service 层按统计/删除
  同款的边界前缀谓词过滤，正斜杠先归一为反斜杠；非路径查询词保持子串匹配）；再次点击取消选中。
- 查询改为分页加载：每页 200 条，底部“加载更多”按钮按 offset 追加，`hasMore` 控制按钮显隐。
- 选中文件夹时出现“从索引删除该文件夹”按钮，两步确认（与单条删除一致），调用新 IPC
  `imageSearch:deleteDataFolder`。成功后 toast 显示删除条数，并提示如有需要手动重建
  DINO/CLIP embedding；随后清空列表、取消选中并触发 `onChanged()`。

边界：

- 批量删除仅允许等于或位于设置中扫描路径根之下的文件夹；主进程从
  `floating_clock_settings.json` 读取 `imageSearchScanPaths` 做根校验，越界直接拒绝。
- 只删索引记录（native `purgeIndexPathPrefix`，自带 prefix 长度保护），源图片不受影响。
- 删除后立即落盘（`persistImageIndexEdits()`）；与单条删除一致，已有 DINO/CLIP embedding
  不会自动刷新，需要时在向量维护中手动重建。
- purge 清空整个索引时 native 拒绝空保存（"No records to save"），service 此时改写
  segments 为空的 manifest 并清理孤儿 segment/overlay，保证删除重启后不复活。
- 编辑落盘瞬时失败（writer busy 等）时内存编辑保留并标记待重试，下一次 autosave 时机
  （扫描完成链）自动重试落盘，toast 文案会注明"将自动重试"；`clearIndex` 清内存的同时
  把空索引写入 manifest，重启不再复活。
- 编辑类 IPC（update/delete/deleteFolder/repairPath）与 startScan 一样，在 Vector GC 或
  Image Search 存储清理进行中直接返回 busy 错误。
- 项目文件（.psd/.kra 等）的 preview 记录按 sourcePath 匹配后随文件夹一并删除
  （preview 文件本身保留，重新扫描可重建）。
- native addon 缺少 `purgeIndexPathPrefix` 时安全降级返回错误，不中断其他编辑功能。

## 文件夹聚合统计（条数/体积）

文件夹级入口现在直接显示聚合信息，不再只有单张图片元数据：

- 每个来源文件夹按钮下方显示"N 条 · X MB"（面板打开时按文件夹调用
  `imageSearch:getDataStats` 加载，失败静默不显示；文件夹删除成功后自动刷新）。
- 查询词像绝对路径（含 `:\` 或以 `\` 开头）时，结果列表上方显示"共 N 条 · X MB"统计条，
  随查询一起刷新；文件名片段等非路径查询不显示。粘贴文件完整路径时统计自动沿祖先文件夹
  回退（term 本身逐级向上、最多 8 级、不短于盘符根，取第一个 count>0 的前缀），生效前缀
  与查询词不同时统计条标注来源文件夹，如 `%USERPROFILE%\xwechat_files · 共 2,617 条 · 55 MB`。
- 选中文件夹的批量删除确认按钮带上统计："将从索引删除 N 条记录（X MB），不删除源文件"；
  统计尚未加载时回退原"确认删除文件夹索引"文案。

实现：native `getIndexPathStats(prefix)`（0.5.21，shared_lock 只读）按
`purgeIndexPathPrefix` 同款前缀边界规则聚合 `count` 与 `totalBytes`，遍历内存记录与全部
segment 并遵守 seen 去重/`deletedPaths` 跳过，58k 级索引无需翻页即可得到整个文件夹的体积与
条数。IPC 链路 `imageSearch:getDataStats` 只读，service 直接委托 native，不做 scanPaths 根
校验。

## 按目录名匹配（任意位置的同名目录）

查询词为裸名称（不含 `\` 与 `/`，如 `image-search-queries`、`RWTemp`）时进入"目录名
模式"，用于清理任意位置下同名子目录的索引记录，不要求知道绝对路径：

- 统计条显示"目录名 'x'：共 N 条 · X MB"，聚合所有父目录下名为 x 的子目录里的记录；
  列表保持子串查询，天然命中这些记录。
- N>0 时出现"按目录名删除"按钮，两步确认，确认文案带统计并说明"删除所有位置下名为 x
  的子目录的索引记录，不删除源文件"；成功后 toast 删除条数、清空列表与统计、刷新
  文件夹聚合。

匹配是路径段级精确匹配：`foobar` 不匹配 `foo` 段，文件名只是包含该词（如
`rwtemp-note.png`）不会被命中；名称大小写与正斜杠不敏感。实现：native
`getIndexPathSegmentStats(name)` / `purgeIndexPathSegment(name)`（0.5.22），遍历与
可见性语义同 `getIndexPathStats`，purge 带 writer lease 并落盘。IPC
`imageSearch:getDirNameStats` 只读；`imageSearch:deleteDirName` 不做 scanPaths 根
校验（功能目的就是清理任意位置的同名目录），但空/含分隔符/短于 2 的名称在 service
与 native 两层都会被拒绝。

## 2026-08-03 全量数据总览

Data Editor Manager 顶部已增加“主要数据文件”和“文件夹覆盖”视图。用户不再需要逐个输入目录来了解数据：一次后台分析会生成 Native/DINO/CLIP 全库 SQLite 投影，后续目录展开、全局搜索、异常筛选和分页均不重读 12.58 GiB JSONL；从覆盖表点击“Manage Indexes”仍进入本页既有的 Native/DINO/CLIP 安全编辑流程。

当前实现、真实数据健康、性能和限制见[全量数据总览实施记录](2026-08-03-image-search-data-overview-implementation.md)，原始性能测量见[真实全量目录基准](../benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)。
