# Siftory（寻藏）全面工程审计

> 状态：历史快照  
> 更新日期：2026-09-29  
> 范围：当前桌面软件源码、数据安全、检索、模型通信、桌面运行、安全边界、网站、构建与发行证据  
> 执行系统：Codex / GPT-6 系列；精确部署版本不可见  
> 所有者：Codex/root  
> 协作：Codex/full_data_integrity、Codex/full_search_lifecycle、Codex/full_security_review；其他运行时未知  
> 替代关系：扩大同日健康度审计范围，作为当前审计入口；前一报告中的原始测试证据仍保留

## 1. 结论

**工程能够构建和运行，但当前版本存在可复现的数据覆盖风险及核心功能故障，不具备直接正式发行的条件。** 不能用单元测试通过数量替代用户操作安全性，也不使用主观百分比分数表示健康度。

本轮新增确认 **14 项代码缺陷：4 项 P1、10 项 P2**。加上同日上一轮已复现的来源清理部分完成统计问题，目前两轮合计 **15 项已确认代码缺陷**。另有 GUI 验收失败、覆盖率门禁失败、依赖维护和正式发行材料缺口，单独记录，不混入代码缺陷数。

P1 表示应优先修复的数据安全或关键功能问题；P2 表示特定条件下的可靠性、正确性和资源控制问题。未据本轮证据确认 P0，也不能据此保证不存在其他问题。

| 优先级 | 编号 | 问题及用户影响 |
| --- | --- | --- |
| P1 | F-01 | 文件管理器把文件重命名为已有名称，可直接覆盖原目标 |
| P1 | F-02 | SFTP 下载完成时，可能覆盖传输期间新出现的同名文件 |
| P1，条件性 | F-03 | 素材库恢复遇到指向库外的目录链接，可覆盖、删除库外文件 |
| P1 | F-04 | 视频以图搜帧的宿主与模型子进程协议不一致，握手超时 |
| P2 | F-05 | 默认冲突策略下，跨文件夹移动失败，目标不存在也失败 |
| P2 | F-06 | SQLite 旧版本迁移中断后，下一次启动迁移仍失败 |
| P2 | F-07 | 兼容 JSONL 模式的备份遗漏分类、标签等关系数据 |
| P2 | F-08 | 向量失效队列部分恢复时指纹不一致，进度保存失败 |
| P2 | F-09 | CLIP 排队请求被取消后，后续请求停在队列中 |
| P2 | F-10 | CLIP 范围快照被提前标记已发送，取消后触发错误回退 |
| P2 | F-11 | 连续媒体查询中，较旧请求的迟到结果可覆盖新结果 |
| P2 | F-12 | 媒体查询零命中后，界面自动补入全库帧 |
| P2 | F-13 | 多模态搜索的字幕分支可带回所选来源以外的视频 |
| P2 | F-14 | AI Control 并发门禁可被两个同时到达的请求跨过 |
| P2，沿用 | F-15 | 来源清理晚期失败时，遗漏已经完成的视频清理统计 |

用户已经明确表示**软著申请已提交**，本报告不把提交申请继续列为待办，也不推定已受理或获登记。冻结的登记 PDF 没有改写。本轮没有升级依赖、修复业务源码、发布网站、生成新安装器或操作真实用户素材。

## 2. 审计对象、方法和证据

审计的是当前未提交工作区，HEAD 为 `4be3326240edeaec667730a963bddb7ea6a3e1e2`（2026-09-02）。工作区已有大量历史改动，不能把 HEAD 当成当前软件的完整源码版本，也不能把当前开发构建当成 9 月 26 日安装器的内容。

- 对 1052 份源码、测试及构建脚本建立摘要；结束时全部摘要一致，根 `package.json` 和 `package-lock.json` 也一致。见 source-integrity.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/source-integrity.json`）。
- 静态审查真实调用链，并使用真实业务处理器、Windows 文件系统、SQLite、现有构建子进程及受控故障注入验证。媒体 UI 两项及融合范围项是原函数的 AST 隔离验证，明确区别于完整 GUI 操作。
- 主代理独立执行了 11 个复现脚本，复核全部 14 项新增缺陷；脚本只创建新的 TEMP 或审计目录夹具。每个脚本的退出码 0 表示复现脚本完成，**不表示产品通过**。
- 真实 Electron 检查使用隔离资料目录；桌面两种语言的衍生启动器移除原烟测的 `--no-sandbox`，明确要求启用 sandbox。没有更改项目原测试脚本或业务断言。
- 当前 322 个根目录 `.test.cjs` 文件均能在默认测试脚本链中找到，未发现测试文件完全漏挂；这不代表测试已覆盖所有重要路径。

证据入口：完整审计产物（本地证据未随源码公开：`../../artifacts/full-audit-20260929/README.md`）、源码清单（本地证据未随源码公开：`../../artifacts/full-audit-20260929/inventory.json`）、本轮执行记录（本地证据未随源码公开：`../../artifacts/full-audit-20260929/checks.json`）、独立复现汇总（本地证据未随源码公开：`../../artifacts/full-audit-20260929/root-reproductions.json`）。同日已有全量测试与构建证据见[上一轮报告](2026-09-29-project-health-audit.md)，业务源码未变化，本轮没有无意义地再次执行整套默认测试。

## 3. 已确认缺陷

### F-01：文件管理器重命名静默覆盖已有文件（P1）

[fileManagerIpc.ts](../../electron/fileManagerIpc.ts) 第 883 行直接执行 `fsp.rename`。`FilePane.tsx` 第 1441、1455 行以及 `FileContextMenu.tsx` 第 115 行调用该入口，没有目标冲突确认，相关调用也没有完整处理返回的失败状态。

在新建目录中创建 `draft.psd=source-content` 和 `final.psd=valuable-existing-target`，调用真实注册的 `fm-rename-file`。返回 `success:true`，原路径消失，目标内容变为 `source-content`。已有目标内容被覆盖。

**这是单文件管理器重命名，不是已有不覆盖保护的批量重命名恢复功能。** 修复必须在主进程提供原子不覆盖语义，并处理同名、仅大小写变化及界面错误反馈；只增加一次“是否存在”判断不足以消除竞争。

证据：file-operations.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/data/file-operations.root-result.json`）。验收应覆盖目标存在、目标在提交时出现、大小写变更、失败后两份内容完整。

### F-02：SFTP 下载末尾同名竞争导致覆盖（P1）

[remoteTransferService.ts](../../electron/remoteTransferService.ts) 第 513 行在传输前检查目标是否存在，第 551 行对初始不存在的目标直接 `rename` 提交。下载 UI 的默认策略经 IPC 归一化为 `ask`；文件夹选择令牌确实绑定调用窗口，问题不是目录选择权限绕过。

用真实 Windows 文件系统和真实 `runDownload`，只将 SFTP 输入替换为内存流：开始时目标不存在，传输期间创建 `LOCAL_CREATED_DURING_TRANSFER`，结束后其内容变为 `REMOTE_DOWNLOAD`。应用本身允许两个并行传输，竞争既可能来自其他程序，也可能来自下载任务。

建议将 `ask`/不覆盖语义落实到最终原子提交，复用不覆盖链接或排他复制方案；明确覆盖策略另保留回滚。仅下载结束前再判断一次存在仍有竞争窗口。本轮没有连接真实 SSH 服务器。

证据：repro-security.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/security/repro-security.root-result.json`） 的 `transfer`。验收应模拟“初始不存在、提交前出现”和两个同名下载并发。

### F-03：素材库恢复跟随库外 junction（P1，明确前提）

[assetLibraryBackup.ts](../../electron/assetLibraryBackup.ts) 第 205 行递归收集时检查子项链接，但没有检查传入目录本身；第 243 行直接进入 `search-feedback`。第 676、706 行生成恢复计划，第 619、628 行删除和替换时没有确保目标的所有中间目录仍在素材库内。

在 TEMP 中创建真实 Windows junction，使素材库 `search-feedback` 指向夹具中的另一个目录，随后恢复旧备份：库外 `victim.json` 从 `EXTERNAL_KEEP` 变为 `BACKUP_VALUE`，库外 `extra.json` 被删除。

触发前提是素材库已有这样的目录链接；**不是已证明的远程匿名攻击，也不是普通库恢复必然出错**。恢复协调器会创建保护备份，可能提供恢复机会，但不能阻止此次越界改动。

建议在收集、计划生成和 journal 执行处统一检查目录本身、中间父目录及真实目标，任何改动前先验证整批计划。验收覆盖库内、库外、嵌套链接与恢复中断，保证外部哨兵文件完全不变。

证据：同一 安全复现结果（本地证据未随源码公开：`../../artifacts/full-audit-20260929/security/repro-security.root-result.json`） 的 `backup`；所有被覆盖或删除的内容均为临时夹具。

### F-04：视频以图搜帧模型协议不匹配（P1）

[frameQueryEmbeddingService.ts](../../electron/frameQueryEmbeddingService.ts) 第 67、93、140、162 行将 stdout 当 UTF-8 JSONL 读取，只有解析到 `ready` 后才发送图片任务。但 [dinoEmbeddingChild.ts](../../electron/dinoEmbeddingChild.ts) 第 33、691 行及 [clipEmbeddingChild.ts](../../electron/clipEmbeddingChild.ts) 第 36、1104 行已输出二进制帧。

调用链是 `searchFramesByImage → searchVideoFramesByImage → imageEmbeddingProvider → embedImageForMediaSearch`。使用当前 TS 宿主和实际现有构建的 DINO/CLIP 子进程，两者都实际发出可被二进制解码器识别的 `ready`，但宿主写入任务次数均为 **0**，最终均超时。复现使用函数现有参数将等待缩至 10 秒，生产默认 120 秒；只替换模型就绪元数据，没有下载、加载模型或执行推理。

图文融合也调用此链，而且会忽略视觉分支 `ok:false`，随后可能将纯文本结果作为 `ok:true` 返回，掩盖视觉分支故障。

建议统一宿主和子进程协议、向量载荷解码及超时/退出处理；补上真实协议握手集成测试，并让融合响应明确表示分支失败。现有 lifecycle 测试主要检查源码 framing 符号，固定样本测试替换了 embedding provider，所以没有检出断链。

证据：frame-protocol-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/frame-protocol-result.json`）。本项不等于静态图片搜索的所有模型通道都不可用。

### F-05：默认跨目录移动失败（P2）

[fileManagerIpc.ts](../../electron/fileManagerIpc.ts) 第 1032 行把实际源路径作为 preparedPath 传入 [localFileTransaction.ts](../../electron/localFileTransaction.ts)；后者第 166 行要求暂存文件与最终目标同目录。`useFileOperations.ts` 第 189 行默认 `conflict='overwrite'`，目标不存在也走此路径。

同盘跨目录移动在“目标不存在”和“目标已存在”两组中都返回 `Prepared path must be a sibling of the final path`；显式 `conflict:'rename'` 控制组成功。该异常不是 EXDEV，因此也不会进入跨盘复制回退。失败组原文件保留。

建议实现专门的移动事务或先在目标目录准备，再安全提交和删除源。验收包括普通移动、同名冲突、跨卷移动、只读目标及中断恢复。证据：文件操作结果（本地证据未随源码公开：`../../artifacts/full-audit-20260929/data/file-operations.root-result.json`）。

### F-06：SQLite 部分迁移无法自动重试（P2）

[assetLibraryDatabase.ts](../../electron/assetLibraryDatabase.ts) 第 108 行起的 v1→v2 两次 ALTER 和版本更新没有事务包裹。注入第二次 ALTER 前失败后，第一列已经持久化，`user_version` 仍为 1；再次打开报 `duplicate column name: origin`。

只影响需要从 v1 升级且中途失败的库；没有证据表明用户当前库已经处于该状态。建议将迁移原子化，并兼容已经部分迁移的数据库，验证每个失败点后的再次启动。证据：migration.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/data/migration.root-result.json`）。

### F-07：JSONL 兼容模式备份遗漏关系数据（P2）

[assetLibraryStorageConfig.ts](../../electron/assetLibraryStorageConfig.ts) 仍支持 JSONL。备份清单 [assetLibraryBackup.ts](../../electron/assetLibraryBackup.ts) 第 42、233 行以 SQLite 迁移后结构为主，未包含正常 JSONL 模式的分类、标签、关联及 `cluster_lineage.jsonl`。

夹具包含资产、分类、标签和关联数据，生成备份只收录 `assets.jsonl/state.json`，校验仍成功；修改分类后恢复，分类仍为备份之后的值。**默认 SQLite 模式不据此认定有同样遗漏。** 建议按真实存储模式决定清单，并校验恢复前后全部业务关系。证据：backup-jsonl.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/data/backup-jsonl.root-result.json`）。

### F-08：向量失效队列部分恢复无法落盘（P2）

[sourceVectorInvalidationOutbox.ts](../../electron/sourceVectorInvalidationOutbox.ts) 第 625 行起将 `entries` 改成 remaining，却保留旧 fingerprint；保存时第 370 行附近重新计算校验，抛指纹不匹配。

两条任务中，一条成功失效，另一条 Native 探测临时失败；已完成工作发生，但磁盘仍有原来两条记录、`attempts:0`、空错误原因。**旧队列没有丢失**，以后全部成功仍可能完成；问题是部分恢复进度和错误不能保存、反复重做。

建议缩减记录时重算指纹，覆盖部分成功、部分放弃和后续失败的组合。证据：outbox.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/data/outbox.root-result.json`）。

### F-09：CLIP 队首取消后停止派发（P2）

[semanticVectorSearchWorkerHost.ts](../../electron/semanticVectorSearchWorkerHost.ts) 第 118 行拒绝取消项后直接返回，没有继续消费后面的请求。真实宿主和 worker 的合成向量夹具中，A 执行、B 排队后取消、C 排队；A 完成后 C 在 250ms 观察窗内仍未结算，新加入 D 才将它唤醒。源码也显示没有其他派发事件时 C 会留队，空闲回收因队列非空不会处理它。

AI Control 搜索取消会传入此取消状态，UI 和统一检索共享 worker。建议连续跳过取消项，并验证无后续新请求时尾部任务仍能完成。证据：队列复现（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/reproduce-semantic-queue.root-result.json`）。256×2 向量仅用于顺序验证，不是性能基准。

### F-10：CLIP scope 提前确认导致不存在的范围快照（P2）

同一宿主第 218、224 行在入队时就把 scope 记为已发送，尚未真正交给 worker；如果携带 payload 的排队请求取消，后续请求只有 scope ID。真实复现中后续两项均报 `Semantic vector worker scope snapshot is missing`。

[semanticSearchService.ts](../../electron/semanticSearchService.ts) 第 1224 行有主进程 exact 回退，因此不能说这是搜索范围泄漏；影响是反复回退及主进程额外扫描。建议与 F-09 一起修复，但分别测试队列前进和缓存一致性。证据：scope-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/scope-result.json`）。

### F-11：媒体查询迟到响应覆盖较新结果（P2）

[MediaSearchPanel.tsx](../../src/components/MediaSearchPanel.tsx) 第 602、610 行的查询回调没有响应序列保护，控制组件以建库状态而非搜索状态限制操作。AST 提取原回调、用受控 Promise 令 B 先返回，再完成 A，最终界面状态从 B 变成 A。

这是函数级验证，没有完成真实 GUI 的竞态复现。实际图片查询当前会先受到 F-04 影响；修复协议后，本项仍会暴露。建议按查询代际接收结果，并将取消、错误、进度和卸载一起纳入一致性控制。

证据：media-ui-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/media-ui-result.json`） 的 `race`。

### F-12：媒体零命中被自动全库列表覆盖（P2）

[MediaSearchPanel.tsx](../../src/components/MediaSearchPanel.tsx) 第 332 行 effect 将“帧列表为空且未建库”作为加载条件；第 228 行的 `listFrames` 不带检索范围，第 255 行替换展示。成功零命中也满足该条件。

原查询回调返回 `results:[]` 后，原 effect 触发 `refresh(includeFrameList:true)`；结合真实 refresh 调用链，会重新填入浏览列表。应区分首次浏览、查询中、查询完成零命中三种状态。只有当前确实得到成功空结果才触发，不能将所有失败响应都归入本项。

证据：同一 媒体 UI 隔离结果（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/media-ui-result.json`） 的 `emptyResult`；refresh 在夹具中受控替代，其无范围行为另经源码核对。

### F-13：多模态字幕召回越过所选来源（P2）

[mediaSearchIpc.ts](../../electron/mediaSearchIpc.ts) 第 1697 行取得 scanPaths，图片视觉分支第 1722 行使用它，但第 1711 行字幕搜索只过滤可用 videoId。[transcriptService.ts](../../electron/transcriptService.ts) 第 608 行起把仅字幕命中的视频加入融合结果。

原 IPC handler 与原融合函数的隔离验证：请求 `D:\selected`，字幕命中 `D:\outside\private-b.mp4`，最终范围外视频位于第一项，整体 `ok:true`。这是搜索范围正确性问题，没有证明文件权限逃逸。建议所有召回分支共用范围过滤，并在融合后最终校验。

证据：multimodal-scope-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/search-lifecycle/multimodal-scope-result.json`）。文件名和路径是合成夹具，不来自真实用户图库。

### F-14：AI Control 并发上限检查存在竞争（P2）

[aiControlApi.ts](../../electron/aiControlApi.ts) 第 881 行先检查 active，第 889 行等待读取 body，第 1028 行启动任务，第 715 行才登记 active。两个请求可同时通过前面的检查。[aiControlPolicy.ts](../../electron/aiControlPolicy.ts) 第 215 行声明 `storage.largeFiles` 并发上限为 1。

真实 handler、内存请求流、可控扫描 Promise 复现：两个请求都返回 202，实际并行执行数为 2。没有开放新监听端口或扫描真实磁盘。触发者仍需要有效 Bearer 和 scope；**不是鉴权绕过**。

建议 body/schema/确认校验后、启动任务前同步预约槽位，并在所有终结路径释放。证据：repro-api-race.root-result.json（本地证据未随源码公开：`../../artifacts/full-audit-20260929/security/repro-api-race.root-result.json`）。

### F-15：来源清理部分完成统计遗漏（P2，前轮已确认）

视频派生数据清理已完成后，历史记录指纹检查失败，外层返回空统计，界面只显示失败。原视频没有被删，但用户看不到已发生的维护结果。详见[前轮 H-01](2026-09-29-project-health-audit.md#h-01来源清理晚期失败丢失已提交视频阶段统计p2已复现)及独立复现（本地证据未随源码公开：`../../artifacts/health-audit-20260929/cleanup-partial-reproduction.json`）。本轮未重复修改或运行真实来源清理。

## 4. 运行检查与测试解释

| 检查 | 结果 | 范围与限制 |
| --- | --- | --- |
| 桌面类型、Lint、格式、默认回归及受检构建 | 同日证据通过 | 2447 次累计测试执行，2440 通过、7 跳过、0 失败；有重复用例，不是唯一用例数 |
| 来源清理专项 | 同日 86/86 通过 | 不含已新增确认的晚期统计故障路径 |
| 本轮安全专项 | 61 次：60 通过、1 跳过、0 失败 | 跳过文件 symlink 权限夹具；目录 junction 复现实际成功 |
| 本地 AI Control HTTP/Electron smoke | 通过 | 未认证拒绝、写操作确认、重放、幂等冲突、scope、token 轮换；不消除 F-14 |
| 中文、英文桌面 UI smoke | 两者整体失败 | 都有 remoteAdvancedFocused=false，保留原始失败 |
| UI 正向子项 | 通过 | 14 面板、主题/语言/工作区切换、60 次面板生命周期、12 次可见性循环，无控制台错误 |
| 条款独立窗口 | 两语言各 9 项检查通过 | 勾选、同意/拒绝/关闭、隔离 preload、小窗口滚动、记录保存和失败行为；不等于发行条款定稿 |
| 受控播放器 | 通过 | TEMP 3 秒视频、1.25 秒定位、区间循环、边界帧步进和导出控件存在；未实际输出完整编辑工程 |
| 网站 | 构建、19 项测试、Lint、类型检查通过 | 当前本地源码；没有发布网站或浏览器逐帧视觉验收 |
| 隐私扫描 | 既有 263 个 tracked 文本检查通过 | 额外扫描 1409 个文本，未检出所用高置信 secret 模式；45 个路径模式候选主要在测试夹具，另有通用 Public 路径，未确认新真实凭据泄漏 |
| 关键覆盖率门禁 | 同日失败 | 发布检查脚本分支 77.92%，要求 89%；不是整个软件覆盖率 |

默认测试的 7 项跳过涉及 Windows 文件链接、POSIX 条件及 CUDA 对照夹具，不能当作全平台通过。本轮没有更改这些条件来制造绿灯。

UI 失败位于 [uiSmokeService.ts](../../electron/uiSmokeService.ts) 第 633–641 行：点击前保存 DOM 引用、固定等待 100ms 后判断置顶。真实调用链为 WorkspaceNavigator 双 rAF → panel-focus-request → DraggablePanel → panelLayerOrder，静态检查未发现明显接线错误。测试缺少节点是否仍连接、重新查询后的 zIndex、事件到达记录，**尚不能区分产品缺陷与测试时序问题**。下一步应增加观察证据，不能直接放宽断言。

60 次面板循环中，中文监听器差值 -5、DOM 节点 -8、heap 约 +391 KB；英文监听器差值 0、DOM -6、heap 约 -3 KB。这是短程抽样，没有显示持续 DOM/监听器增长，不能替代长时泄漏验收。当前两组在指定 1920×1080 工作区内的合成拖动检查通过，不证明旧双屏混合 DPI 问题已消失。

原始 GUI：中文报告（本地证据未随源码公开：`../../artifacts/full-audit-20260929/ui-zh/ui-smoke-8oCbL2/report.json`）、英文报告（本地证据未随源码公开：`../../artifacts/full-audit-20260929/ui-en/ui-smoke-go8d2t/report.json`）；播放器结果（本地证据未随源码公开：`../../artifacts/full-audit-20260929/player-result.json`）；安全测试记录（本地证据未随源码公开：`../../artifacts/full-audit-20260929/security-tests.json`）。

## 5. 依赖、运行时及发行健康度

### 运行时补丁维护

本机开发 Node 为 24.16.0；本轮实际 Electron 42.8.0 进程报告内嵌 Node 24.18.0、undici 7.28.0。npm 生产依赖审计为 0 不覆盖这些内嵌运行时。

Electron 官方 42.8.1 记录更新 Node 至 24.18.1，并修复 Windows 不同 DPI 次屏的显式坐标窗口尺寸问题等。此信息支持升级和回归的必要性，但没有 A/B 证据证明旧拖动问题就是此原因。[Electron 42.8.1 发行说明](https://releases.electronjs.org/release/v42.8.1)

Node 官方 2026 年 7 月安全公告把 24.18.1 列为修补版本，涉及 HTTP/2、权限模型和内嵌依赖等；项目当前开发和内嵌版本低于该修补基线。具体利用条件未逐项证明在软件中可达，不能等同已发现应用远程攻击入口。[Node 安全公告](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases)

另有 undici 上游公告涉及 WebSocket 解压异常，7.x 修补版本为 7.29.1；不能把只升级至 Electron 42.8.1 当作全部后续公告的完整修复。应选择覆盖相关修补的受支持运行时，并一起调整项目工具链、原生 ABI 和回归证据。[undici 公告](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v)

### 工程与发行缺口

- 同日完整 npm 审计有 6 个开发依赖包项告警：4 高、2 中；生产 npm 依赖 0。详细版本及上游链接保留在[前轮 H-03](2026-09-29-project-health-audit.md)。没有运行自动升级。
- 默认全局 npm 12.0.2 与项目 11.13.0 要求不同；本次明确使用 Node 附带的项目约定 npm，没有改全局配置。工具链固定有利复现，但旧运行时仍需有计划升级。
- 内部 Online 发行门禁 0/8：许可/发布者记录、干净源码、标签、签名、Neko 可比质量基线、当前源码绑定的安装包矩阵、隐私政策、支持政策。它不是功能完成率或法律结论。
- 9 月 26 日安装器及源码 ZIP 的 5 项交付哈希在前轮核对通过；当前开发源码的通过项不能自动归到该安装器。尚无本次源码的干净 Windows 安装/升级验收及签名证据。
- 许可检查通过，但原生清单仍声明 `completeNativeInventory:false`。Online 安装不含模型；用户自行下载模型与发行包内第三方二进制应分别处理。
- 用户已定“个人免费、商用收费”；当前缺的是最终随包发布文本和证据。软著申请已提交，不因此自动完成软件质量、发行或第三方清单工作。
- 用户说明书第 562、795 行的部分历史描述仍滞后：主体向量来源清理和批量重命名恢复防覆盖已有实现。不能据此重复报旧漏洞，也不能与 F-01 单文件重命名混为一谈。

## 6. 架构与审查覆盖边界

Electron/React/TypeScript、C++ 扫描和多个模型 worker 的分工已经形成；IPC 合约、向量维护互斥、来源身份复核、请求代际过滤、检查点、备份校验和事务日志均有实现。问题集中在**模块交界处**：协议迁移不同步、取消与缓存状态不同步、重命名语义与事务工具不匹配、测试替身绕过实际通信。只增加源码正则断言不够，应补真实边界集成测试。

原生扫描自有文件约 5547 行，多个检索/界面模块在 1500 行以上，维护成本较高；第三方 stb 头文件不计入自有大模块评价。建议先修上述可复现缺陷，再沿真实职责拆分，避免先做大范围结构调整而丢失行为基线。

| 领域 | 实际覆盖 | 未据此证明 |
| --- | --- | --- |
| 文件与元数据 | 重命名/移动 IPC、SQLite 故障、备份完整性与链接、来源同步、outbox | 真实断电、USB 拔出、NAS 掉线后的完整恢复 |
| 检索与模型 | DINO/CLIP host、ANN 身份与 scope、取消队列、视频帧/字幕融合、实际子进程握手 | 当前全部模型实际推理准确率、模型下载及 GPU 兼容性 |
| 安全 | IPC sender/frame/origin、默认 sandbox、HTTP 鉴权确认、SFTP 指纹/凭据、外链导航、备份加密校验 | 恶意服务器全链攻击、解码器模糊测试、所有本机对抗路径 |
| 桌面 | 实际 Electron 中英隔离运行、短循环、条款窗口、播放器 | 长时内存稳定、真实多屏热插拔、休眠唤醒、干净安装器 |
| 网站 | 构建与测试、演示文案抽查 | 已部署站点与本地完全一致、移动端及逐帧视觉验收 |

网站样片已有“非软件实录、规模示意、动画时长不代表检索耗时、PSD/AI 可读预览及打开核对”等边界说明，本轮未确认新的夸大描述，但 F-04 意味着视频以图搜帧不能用动画替代软件实测。

已有 8 月的 44 万级 DINO、38 万级 CLIP 和 1000 次搜索历史基准，不能说从未验证过大库；也不能将其当作当前版本的实测结果。当前两小时混合负载多轮、八小时诊断以及完整 CPU/GPU/RSS/VRAM 预算仍需闭环。详见前轮报告引用的历史基准。

## 7. 建议执行顺序与验收出口

1. **先处理原文件和库边界**：F-01、F-02、F-03；每条路径都验证冲突/失败后原有文件内容不变。修复前避免重命名为已有文件名；避免相同下载目标并发；存在库外目录链接的素材库暂不恢复备份。
2. **恢复关键检索与移动能力**：F-04、F-05；真实 DINO/CLIP 握手、可用模型的一次完整视频搜帧、正常跨目录及跨盘移动。
3. **完善状态与故障恢复**：F-06 至 F-15；迁移各失败点、两种存储模式往返、部分 outbox、取消队列、旧结果/零结果/范围、并发 API 和部分维护统计。
4. **通过真实桌面与依赖门禁**：定位远程面板断言；修复关键覆盖率；更新相关运行时和开发依赖后重建原生组件，检查 sandbox、混合 DPI、播放器及模型链路。
5. **固定可发行版本**：整理可审阅的源码快照，安装器和测试矩阵绑定该快照；补齐最终发行文本、原生第三方清单及干净安装/升级证据。保留已提交登记材料原样。

本轮交付为审计与复现材料，以上修复尚未实施。少量临时夹具保留，便于核对；一次清理这类夹具的递归删除被自动审批策略拒绝（`blocked by policy`），没有换路径绕过。真实素材、索引和现有用户配置没有被测试用例作为变更目标。
