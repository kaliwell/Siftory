# FloatingClock 项目多维审计（2026-07-13）

> 状态：当前审计快照（P1 整改及搜索双模式已闭环）  
> 更新日期：2026-07-14  
> 范围：项目根目录、`src/`、`electron/`、`shared/`、`native/`、`tests/`、`scripts/`、构建配置、运行模型与发布产物  
> 基线版本：`floating-clock-electron@1.0.0`  
> 关联当前基线：[优化进度交接](../current/2026-07-12-optimization-handoff.md)  
> 替代文档：无，本文件为新增审计快照

## 快速结论

项目当前综合健康度为 **95/100**。核心功能、主进程隔离、IPC 领域拆分、搜索索引、虚拟化渲染、自动测试和本机打包链已经达到可持续迭代状态。审计未发现 P0 阻断问题；最初发现的 4 项 P1 已于 2026-07-13 完成修复和自动验证：

1. 文件管理器覆盖复制/移动已改为同级临时目标、备份提交和失败回滚。
2. JSONL 向量存储写队列可从失败恢复，支持 flush/健康状态、完整快照补偿和损坏行隔离。
3. 模型下载改为带背压的流式写入、增量 SHA256、节流进度和可取消清理。
4. 发布包已移除重复模型和非 Windows x64 ONNX Runtime，最新安装包为 575.94 MiB，`release/` 只保留安装包。
5. Image Search 和 Media Search 已增加默认简单模式和兼容原功能的高级模式，一键流程复用现有扫描、模型、embedding 与索引服务；详见[搜索双模式说明](../designs/2026-07-13-search-experience-modes-design.md)。

当前判断：

| 维度       | 状态   | 结论                                                                                 |
| ---------- | ------ | ------------------------------------------------------------------------------------ |
| 功能完整度 | 98%    | 搜索主流程新增一键准备和高级模式；文本语义人工准确率仍未形成可发布结论               |
| 工程健康度 | 95/100 | 无 P0/P1；事务、持久化、下载流、Hooks 和工具链门禁已闭环，剩余问题集中在 P2/P3       |
| 发布就绪度 | 89%    | NSIS 构建、归档完整性和 packaged smoke 通过；仍未签名、未在干净 VM 完成安装/卸载验证 |
| 搜索可用性 | 已验证 | 真实帧索引范围和相似帧 Recall 已验证；文本语义候选池存在，但人工覆盖率为 0%          |
| 安全基线   | 良好   | Electron 沙箱、上下文隔离、导航限制、IPC 校验、SSH 主机指纹和凭据加密均已落地        |

下一阶段建议顺序：人工语义标注 -> Windows 干净 VM 安装/升级/卸载 -> 正式图标与签名 -> 布局逻辑复用 -> 大模块按职责拆分。

## 目录

1. 审计目的与范围
2. 项目规模与架构
3. 综合评分
4. 高优先级问题
5. 结构审计
6. 逻辑与数据一致性审计
7. 性能与效率审计
8. 安全审计
9. 复用与死代码审计
10. 可扩展性审计
11. 测试与发布审计
12. 已完成的关键优化
13. 优化路线与验收标准
14. 验证记录
15. 审计限制

## 1. 审计目的与范围

本次审计回答以下问题：

1. 当前项目结构是否仍适合继续扩展 Image Search、Media Search 和素材管理能力。
2. 关键数据路径是否存在状态错乱、数据丢失、索引不一致或任务失控风险。
3. 启动、扫描、索引、搜索、缩略图和发布流程是否存在可测量的性能瓶颈。
4. Electron 主进程、IPC、文件系统、远程终端和发布链是否满足桌面应用安全基线。
5. 已有模块是否得到复用，是否存在重复实现、占位服务和难以维护的大模块。
6. 当前架构对未来分类、标签、聚类和视频关键帧扩展是否保留稳定边界。

审计包含源代码、配置、测试、基准报告、模型目录和当前发布产物。`node_modules/`、`dist/`、`dist-electron/`、`release/` 和 Native 构建目录不计入源码规模，但会计入磁盘和发布体积分析。

当前目录不是 Git 工作树，无法使用提交历史、差异或 blame 验证变更来源。因此本报告以 2026-07-12 至 2026-07-13 的文件内容、自动测试和现有基准产物为事实基线。

## 2. 项目规模与架构

### 2.1 技术栈

| 层级     | 当前实现                                                                  |
| -------- | ------------------------------------------------------------------------- |
| 桌面容器 | Electron 42.4.1                                                           |
| UI       | React 18.3.1 + TypeScript 5.9.3 + Zustand 4.5.7                           |
| 构建     | Vite 6.4.3 + electron-builder                                             |
| 模型推理 | `@huggingface/transformers` + ONNX Runtime                                |
| 图片处理 | Sharp、Native `fast_scanner.node`                                         |
| 视频处理 | FFmpeg / FFprobe、帧清单和 Frame Index                                    |
| 远程终端 | SSH2 + xterm                                                              |
| 数据     | JSONL manifest、embedding shard、JSONL Frame Index、本地配置文件          |
| 测试     | Node test runner、固定样本、性能基准、Electron UI smoke、安装包归档 smoke |

### 2.2 源码规模

按应用、测试和 Native 源文件统计，项目约有 **183 个源文件、2.28 MiB、6.1 万行**。其中 `native/` 包含第三方 `stb_image` 头文件，因此总行数不能直接等同于自研复杂度。

| 目录        | 文件数 |    体积 | 约计行数 | 主要职责                             |
| ----------- | -----: | ------: | -------: | ------------------------------------ |
| `electron/` |     65 | 589 KiB |  1.69 万 | 主进程、IPC、搜索/向量/媒体/终端服务 |
| `src/`      |     71 | 602 KiB |  1.79 万 | React 面板、状态、虚拟化和交互       |
| `shared/`   |      3 |  49 KiB |    1,554 | IPC 契约和跨进程类型                 |
| `tests/`    |     33 | 192 KiB |    5,154 | 单元、固定样本、压力、基准和 smoke   |
| `scripts/`  |      4 |  13 KiB |      394 | 构建与 Native 编译                   |
| `native/`   |      4 | 883 KiB |  1.92 万 | 扫描、解码、哈希和搜索 Native 实现   |

### 2.3 主要大文件

| 文件                                      | 物理行数 | 审计判断                                                               |
| ----------------------------------------- | -------: | ---------------------------------------------------------------------- |
| `electron/semanticSearchService.ts`       |    1,232 | 模型生命周期、缓存、文本查询和回退策略集中，适合按运行时与检索阶段拆分 |
| `electron/embeddingService.ts`            |    1,131 | 任务调度、子进程、GPU/CPU 路径和进度集中，需保持任务状态测试           |
| `src/stores/useStore.ts`                  |    1,139 | 全局状态和面板布局实现混合，且布局逻辑与 `arrangeEngine.ts` 重复       |
| `src/components/RemoteTerminalPanel.tsx`  |    1,057 | 配置、会话、终端和传输 UI 集中，适合按可测试子视图拆分                 |
| `shared/ipc-contract.ts`                  |    1,034 | 多领域契约聚集；Media Search 已开始独立契约化                          |
| `src/components/filemanager/FilePane.tsx` |      997 | 文件浏览、选择、操作和渲染职责偏多                                     |
| `src/components/MediaSearchPanel.tsx`     |      977 | 已抽出状态网格与结果视图，但任务控制仍较集中                           |
| `src/components/ImageSearchPanel.tsx`     |      907 | 主流程稳定，后续应继续把查询控制与结果展示隔离                         |
| `electron/imageSearchService.ts`          |      888 | 索引、搜索、Native 适配集中，应优先以测试边界而非行数机械拆分          |

### 2.4 当前运行架构

```text
React panels + Zustand
        |
        v
typed window.electronAPI
        |
        v
preload explicit bridge + shared IPC contracts
        |
        v
domain IPC modules
  appCore / fileManager / imageSearch / mediaSearch / vector
  remoteTerminal profiles / connection / sftp / transfer
        |
        v
services + workers + child processes + native addon
        |
        v
userData manifests / vector-db / frame index / caches / credentials
        |
        v
local models + FFmpeg + filesystem + SSH endpoints
```

`electron/main.ts` 当前约 286 个物理行，主要承担窗口生命周期和领域 IPC 注册。Image Search、Media Search、Vector、RemoteTerminal、文件管理、缩略图和应用核心 IPC 已拆出，早期主进程巨型入口问题已经基本解决。

### 2.5 磁盘规模

| 目录             |   当前体积 | 说明                                                                        |
| ---------------- | ---------: | --------------------------------------------------------------------------- |
| `release/`       | 575.94 MiB | 只保留 `FloatingClock Setup 1.0.0.exe`                                      |
| `node_modules/`  | 948.86 MiB | 开发依赖和跨平台原生包                                                      |
| `ai-models/`     | 541.89 MiB | 开发目录保留 DINO、CLIP 图像/文本模型和兼容副本；打包白名单不再复制重复权重 |
| `tools/`         | 462.33 MiB | FFmpeg 和 FFprobe 为主要体积来源                                            |
| `backup/`        |  83.12 MiB | 本地备份产物，已在 `.gitignore` 排除                                        |
| `dist-electron/` |  48.58 MiB | 主进程、preload、worker 和 child 构建产物                                   |
| `native/`        |  37.72 MiB | 源码和本地构建产物                                                          |

## 3. 综合评分

评分反映当前代码和本机验证状态，不是用户体验问卷或生产故障率统计。

| 维度         | 分数 | 主要加分项                                                            | 主要扣分项                                                   |
| ------------ | ---: | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| 结构         |   93 | IPC 领域化、Renderer 懒加载、主入口收敛、事务层独立                   | 若干 900 至 1,200 行模块、IPC 总契约仍偏大                   |
| 逻辑与一致性 |   95 | scope、TopK、事务提交、持久化恢复和损坏行隔离均有测试                 | JSONL 接受与持久化语义仍需调用方逐步显式化                   |
| 性能与效率   |   93 | 虚拟化、缩略图懒加载、manifest 热缓存、流式下载、包体裁剪             | generic JSONL 仍会全量重写，Frame Index 构建峰值会随规模增长 |
| 安全         |   94 | sandbox、contextIsolation、导航限制、IPC 校验、SSH 指纹、safeStorage  | 安装包未签名，CSP 样式仍允许 inline                          |
| 复用         |   91 | 模型注册表、路径守卫、进度组件、虚拟网格、事务和缓存工具可复用        | 面板布局双实现、少量错误处理重复                             |
| 可扩展性     |   91 | 模型、任务、索引、持久化状态和 IPC 已有领域边界                       | 大服务仍集中，实验服务没有成熟契约                           |
| 测试与交付   |   96 | 143 项测试、完整 verify、UI smoke、安装包归档 smoke、真实 Recall 基线 | 无 CI、无干净 VM、文本人工标注 0%                            |
| 文档         |   94 | `docs/` 已结构化并有当前入口、审计、基准和交接                        | 部分历史结论已过时，需要继续以当前索引约束读取顺序           |

综合分按风险影响加权后为 **94/100**。

## 4. 高优先级问题

### P1-01 文件覆盖操作缺少事务保护

**状态**：已修复（2026-07-13）。新增 `electron/localFileTransaction.ts`，复制和移动覆盖均使用 prepared sibling、旧目标备份、原子提交和失败回滚；`tests/file-manager-transaction.test.cjs` 覆盖文件、目录、提交失败和恢复路径。

**位置**：`electron/fileManagerIpc.ts:456-468`、`electron/fileManagerIpc.ts:514-541`

复制和移动选择 `overwrite` 时，代码先执行 `fsp.rm(dest, { recursive: true, force: true })`，再复制或重命名来源。若后续发生取消、读取失败、权限错误、磁盘空间不足或跨盘复制失败，旧目标已经删除。

**影响**：文件管理器可造成用户已有目标文件或目录不可恢复的数据丢失。当前删除操作使用回收站，但覆盖路径直接 `rm`，不经过回收站。

**测试缺口**：`tests/file-manager-security.test.cjs` 验证路径和 conflict 参数，没有覆盖操作回滚、取消、`EXDEV` 和写入失败。

**建议修复**：

1. 在目标同级写入唯一临时文件或目录。
2. 复制完成并校验后，将旧目标重命名为备份，再原子提交临时目标。
3. 提交成功后删除备份；任一步失败时恢复旧目标。
4. 对取消、权限错误、空间不足和跨盘移动添加故障注入测试。

**验收标准**：所有失败分支中旧目标保持原内容；新目标只在完整复制后可见；测试覆盖文件和目录。

### P1-02 JSONL 写队列可能永久失效

**状态**：已修复（2026-07-13）。写队列可从 rejected 状态继续，失败后的下一次写入会提交完整当前快照；新增 `flush()`、持久化健康状态、损坏行报告和批量孤儿清理。`tests/vector-database-persistence.test.cjs` 覆盖损坏行、写失败恢复和入队快照。

**位置**：`electron/vectorDatabaseService.ts:40-80`、`electron/vectorDatabaseService.ts:92-160`、`electron/vectorDatabaseService.ts:345-397`

`JsonLinesStore` 使用 `_saveMutex = _saveMutex.then(...)` 串行化写入，但没有 rejected promise 恢复。如果一次 `writeFileSync`、`renameSync` 或 `appendFileSync` 抛错，后续追加到该 rejected promise 的所有写任务都会跳过。公开的 insert/update/delete 方法同步返回，调用方无法等待落盘或接收失败。

`load()` 还会在任意一行 JSON 损坏时捕获整个异常并把全部缓存设为空数组。孤儿清理流程在循环内多次调用 `deleteWhere`，可能触发多次全量过滤和重写。

**影响**：一次磁盘错误可能让本次进程后续向量更新全部不落盘；单行损坏可能表现为整个存储为空；大量清理存在 O(n²) 级放大风险。

**建议修复**：

1. 将写 API 改为可等待的 Promise，失败必须向上返回。
2. 队列使用成功和失败双分支继续执行，并记录持久化健康状态。
3. 入队时冻结快照，避免异步任务读取后续变化的共享 cache。
4. 按行容错加载，把损坏行隔离到报告文件，不静默丢弃全部数据。
5. 孤儿清理先收集 ID，再按 store 一次批量删除和一次落盘。
6. 增加 rename 失败、只读目录、磁盘写失败和损坏行测试。

**验收标准**：第一次写失败后，修复环境后的第二次写可以成功；调用方能收到错误；单行损坏不会清空其余有效记录。

### P1-03 模型下载进度造成 I/O 和内存放大

**状态**：已修复（2026-07-13）。新增 `electron/modelDownloadStream.ts`，使用流式 pipeline、背压、增量 SHA256、进度节流和 AbortSignal；安装模型的重复状态检查使用 stat/摘要验证缓存。取消和失败只清理 partial，不破坏旧模型。

**位置**：`electron/modelService.ts:64-94`、`electron/modelService.ts:253-300`

`buildStatus()` 在检查 `currentDownload` 前，只要目标文件存在就会同步 `readFileSync` 并计算 SHA256。下载循环每收到一个 chunk 都调用 `emit(buildStatus(modelName))`，因此部分文件出现后，每个进度事件都可能重新读取并哈希完整增长文件。

下载循环还把所有 `Uint8Array` 放入未使用的 `chunks` 数组，直到任务完成。最终校验再次一次性读取完整模型。

**影响**：大模型下载期间主进程磁盘 I/O 接近二次增长，内存至少额外保留一份下载内容，可能导致窗口卡顿、GC 压力和下载阶段崩溃。

**建议修复**：

1. `buildStatus()` 优先返回 `currentDownload`，下载中不读取文件。
2. 移除未使用的 `chunks` 数组。
3. 写入时增量更新 SHA256，完成后直接比较摘要。
4. 按 100 至 250 ms 或固定字节阈值节流进度事件。
5. 用可控 ReadableStream 增加大模型下载、取消和摘要失败测试。

**验收标准**：下载过程常驻内存不随文件大小线性增加；状态刷新不读取部分文件；进度稳定且取消后临时文件按策略清理。

### P1-04 发布产物冗余且未满足单安装包约束

**状态**：已修复（2026-07-13）。打包仅包含 scoped 模型、Windows x64 ONNX Runtime 和实际需要的资源；构建后由安全清理脚本只保留当前安装包，缺少预期安装包时拒绝删除任何产物。

**位置**：`package.json:83-121`、`ai-models/`、`release/`

发现问题时，`extraResources` 复制整个 `models/`、`ai-models/` 和 `tools/`。修复前发布数据包括：

| 项目                         |                            修复前数据 |
| ---------------------------- | ------------------------------------: |
| NSIS 安装包                  |         804,183,148 bytes，766.93 MiB |
| `release/`                   |     2,681,445,448 bytes，2,557.23 MiB |
| `ffmpeg.exe`                 |                            231.26 MiB |
| `ffprobe.exe`                |                            231.07 MiB |
| `app.asar`                   |                            199.43 MiB |
| CLIP visual scoped model     |                            180.63 MiB |
| CLIP visual legacy duplicate | 180.63 MiB，SHA256 与 scoped 文件相同 |
| CLIP text model              |                            119.92 MiB |
| DINO model                   |                             53.81 MiB |

修复前的 `app.asar.unpacked` 还携带 Darwin、Linux、Windows ARM64 和 Windows x64 的 ONNX Runtime 二进制。当前是 Windows x64 安装包，这些跨平台运行库不会在目标平台执行。

此外，用户要求 `release/` 最终只保留 `FloatingClock Setup 1.0.0.exe`；修复前仍保留 `win-unpacked/`、blockmap 和 builder 元数据，发布目录与约束发生漂移。

**建议修复**：

1. 保留唯一的 scoped CLIP 模型目录，先验证旧 userData 迁移，再删除打包内 legacy 重复模型。
2. 通过 electron-builder 文件过滤只打包 Windows x64 ONNX Runtime 和 Sharp 运行库。
3. 评估 FFprobe 是否可以复用 FFmpeg 功能，或改为首次使用时安装可选工具包。
4. 区分开发归档目录和最终分发目录；打包成功后把唯一安装包复制到干净 `release/`。
5. 加入安装包内容白名单和体积阈值测试，防止依赖升级重新带入跨平台二进制。

**验收标准**：安装、DINO CPU/GPU、CLIP CPU/GPU、视频扫描和搜索在干净 Windows x64 VM 通过；`release/` 只保留安装包；体积下降数据写入新基准。

当前自动验收结果：安装包为 603,920,601 bytes（575.94 MiB），相较 766.93 MiB 基线仍减少约 24.9%；归档仅含 Windows x64 ONNX Runtime，重复 CLIP 权重未进入安装包，`release/` 只保留安装包。干净 VM 验证仍属于独立 P2 发布项。

## 5. 结构审计

### 5.1 已形成的健康边界

1. `electron/main.ts` 已从业务 handler 集合收敛为窗口和注册入口。
2. IPC 按 Image Search、Media Search、Vector、RemoteTerminal、文件管理、缩略图和应用核心拆分。
3. `preload.ts` 使用显式 API，不向 Renderer 暴露 Node.js 全局对象。
4. Renderer 面板通过 `React.lazy` 和 `Suspense` 延迟加载，主包没有强制加载所有重面板。
5. Media Search 已有独立 bridge、scope、query image、image cache、frame embedding state 和 frame index 模块。
6. GPU/CPU 模型能力由 `electron/modelRegistry.ts` 统一描述，避免按钮和后端各自硬编码能力。

### 5.2 结构性剩余问题

| 严重度 | 问题                                  | 位置                                                                   | 影响                                                        |
| ------ | ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| P2     | 全局 store 与独立布局引擎保留两套实现 | `src/stores/useStore.ts:313-588`、`src/stores/arrangeEngine.ts:46-355` | 修复一处可能遗漏另一处；独立引擎实际只复用了 `GAP`          |
| P2     | 多个服务或面板超过 900 行             | 见 2.3                                                                 | 修改需要更宽上下文，测试边界不清晰                          |
| P2     | IPC 契约仍集中                        | `shared/ipc-contract.ts`                                               | 跨领域改动容易产生大文件冲突；Media Search 已证明可按域拆分 |
| P3     | 没有 CI 配置且目录不是 Git 工作树     | 项目根目录                                                             | 质量门禁只能依赖人工运行，无法验证提交级回归                |

拆分原则应是“先定义可测试职责，再迁移代码”，不按行数机械拆文件。推荐优先抽取模型运行时生命周期、embedding 任务调度器、RemoteTerminal 会话/编辑器子视图和文件操作事务层。

## 6. 逻辑与数据一致性审计

### 6.1 正向结论

1. Image Search 和 Media Search 的 scan path/scope 过滤已经集中，跨盘符数据不再依赖 UI 临时状态推断。
2. Media Search 固定样本覆盖 TopK、候选数量、自身帧排除和稳定排序。
3. Frame Index 会用签名判断缓存有效性，embedding 更新后可自动触发重建。
4. `Clear Cache` 只清理可重建缓存，不再删除 manifest、frames 和 vectors 等搜索数据。
5. 文件删除使用 `shell.trashItem`，普通删除具有系统回收能力。
6. Remote transfer 已有临时文件和备份提交测试，可作为本地文件覆盖事务化的复用参考。

### 6.2 逻辑风险

P1-01 和 P1-02 已闭环，当前还存在以下中等级问题：

| 严重度 | 问题                                                    | 证据                                        | 建议                                                          |
| ------ | ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| 已解决 | generic JSONL 单行损坏                                  | `electron/vectorDatabaseService.ts`         | 当前跳过损坏行并写入 corruption report，保留其余有效记录      |
| P2     | Frame Index 重建会在内存中持有完整 Map 和完整输出字符串 | `electron/mediaSearchFrameIndex.ts:309-389` | 达到阈值后改为外部排序、分段合并或二进制块写入                |
| 已解决 | React Hooks lint 未启用                                 | `.eslintrc.cjs`                             | 已安装官方插件并启用 rules-of-hooks/exhaustive-deps，警告清零 |
| P3     | 公开 store 写操作返回“内存已修改”，不等同于“已落盘”     | `electron/vectorDatabaseService.ts`         | API 命名和返回值区分 accepted、persisted、failed              |

## 7. 性能与效率审计

### 7.1 已验证性能

Media Search 当前真实索引包含 9,423 帧、915 个视频。100 查询固定基线结果：

| 指标                 | DINOv2 ViT-B/14 | CLIP ViT-B/32 |
| -------------------- | --------------: | ------------: |
| Same Video Recall@10 |             94% |           98% |
| Adjacent Recall@10   |             79% |           82% |
| Same Video Recall@50 |             99% |           99% |
| Adjacent Recall@50   |             94% |           94% |
| 精确评分 P95         |         7.76 ms |       5.53 ms |

259.5 MB JSONL Frame Index 冷加载约 755 ms。当前低于既定的 1 秒二进制索引触发阈值，精确评分也远低于 250 ms 的 worker/native ANN 触发阈值，因此现在不应为了技术偏好立即替换索引格式。

Manifest Cache 在 100K 规模优化后，Video Preview 热加载 P95 为 2.371 ms，Frame Preview 为 3.389 ms，四条热路径均低于 4 ms。Media Search 打开时重复读取完整 manifest 的主要问题已经解决。

### 7.2 UI 性能

1. `ImageSearchResultGrid.tsx` 和 `MediaSearchResultsView.tsx` 使用 `useVirtualGrid`，视口外结果不创建完整结果节点。
2. Media frame preview 和通用 `ThumbnailImage` 使用 IntersectionObserver、批处理和缓存，降低缩略图风暴。
3. 面板使用懒加载；Media Search shell 先挂载再延迟初始化重状态。
4. UI smoke 在 2560x1392 环境中 5/5 面板通过，没有空白或 console error。

### 7.3 性能剩余问题

| 严重度 | 问题                           | 当前影响                           | 优化条件                             |
| ------ | ------------------------------ | ---------------------------------- | ------------------------------------ |
| 已解决 | 模型下载重复哈希和保留 chunks  | 已改为流式背压、增量摘要和节流进度 | 保留自动测试和状态缓存               |
| 已解决 | 发布包重复模型和跨平台运行库   | 安装包下降约 24.9%                 | 由打包白名单和归档 smoke 防回归      |
| P2     | generic JSONL 全量重写         | 大量更新和清理时放大 I/O           | 在持久化重构中一起修复               |
| P2     | Frame Index 构建持有完整输出   | 数据量继续增长时峰值内存上升       | 记录 100K/500K 帧 RSS 后决定分块方案 |
| P3     | 缩略图磁盘缓存仍有同步读写路径 | 高并发冷缓存可能阻塞主进程         | 用性能日志确认 P95 超标后迁移 worker |

GPU 加速只适合模型推理，不能加速目录枚举、JSON 解析、磁盘复制或 UI 合成。Build Frames 的 FFmpeg 解码可按硬件能力尝试 GPU 路径，但必须限制并发、显存和磁盘写入，避免再次出现系统级卡顿。

## 8. 安全审计

### 8.1 已落实的安全控制

| 控制                                   | 证据                                                                                            | 状态         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| Renderer 与 Node 隔离                  | `electron/main.ts:156-158`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` | 通过         |
| 阻止任意新窗口                         | `electron/main.ts:172`                                                                          | 通过         |
| 阻止跨源导航                           | `electron/main.ts:173-180`                                                                      | 通过         |
| 开发服务器仅允许 loopback              | `electron/devServerGuard.ts`                                                                    | 通过         |
| CSP 禁止外部脚本、object、base 和 form | `index.html:7-9`                                                                                | 通过         |
| IPC 输入大小和类型限制                 | `electron/ipcValidation.ts` 及各领域 guards                                                     | 通过         |
| 文件删除进入回收站                     | `electron/fileManagerIpc.ts:400-405`                                                            | 通过         |
| SSH 主机密钥校验                       | `electron/remoteTerminalService.ts:173-208`                                                     | 通过         |
| 远程凭据加密                           | Electron `safeStorage`、本地权限限制                                                            | 通过         |
| 依赖漏洞                               | `npm audit --audit-level=moderate`                                                              | 0 个已知漏洞 |
| 第三方说明                             | `THIRD_PARTY_NOTICES.md`                                                                        | 已存在       |

### 8.2 安全剩余风险

| 严重度 | 风险                                 | 说明                                                                              |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| P2     | 安装包未签名                         | 当前 Authenticode 为 `NotSigned`，降低 SmartScreen 和供应链信任                   |
| P2     | 未在干净 VM 验证安装与卸载           | 归档完整不等于实际安装、升级、卸载和用户数据保留正确                              |
| 已解决 | 本地覆盖写事务                       | prepared sibling、备份提交和失败回滚已落地并有故障测试                            |
| P3     | CSP 允许 `style-src 'unsafe-inline'` | React 内联样式的现实妥协；当前 `script-src` 仍保持 `'self'`，不存在 `unsafe-eval` |
| P3     | UI smoke 使用 `executeJavaScript`    | 仅测试服务使用且受 smoke 模式约束，不应进入普通业务调用路径                       |

不建议为文件管理器增加“只能访问应用目录”的伪沙箱，因为其产品职责就是管理用户选择的本地文件。正确控制应是参数校验、明确确认、回收站、事务提交、取消和审计日志。

## 9. 复用与死代码审计

### 9.1 已有高价值复用

1. `electron/modelRegistry.ts`：统一 DINO/CLIP 维度、默认后端和查询能力。
2. `src/hooks/useVirtualGrid.ts`：复用于 Image Search 和 Media Search 大结果集。
3. `electron/mediaSearchScope.ts`：统一扫描路径和搜索范围判断。
4. `electron/mediaSearchImageCache.ts`、Thumbnail cache：统一 data URL 缓存和淘汰。
5. `electron/ipcValidation.ts` 与各领域 guards：统一输入上限和路径归一化。
6. `shared/ipc/media-search.ts`：开始按领域拆分共享契约。
7. Remote transfer 的临时文件、备份和原子提交模式：可复用于 File Manager 覆盖操作。
8. 固定样本、真实 Recall、manifest benchmark、UI smoke 和 installer smoke：构成可复现验证链。

### 9.2 重复实现

`src/stores/arrangeEngine.ts` 已导出 `collectPanels`、`collectLockedPanels`、`placeNewPanel` 和 `packPanels`，但 `src/stores/useStore.ts` 只导入了 `GAP`，并保留同名或同职责的完整布局实现。当前形成一条 type-only 反向依赖和两套维护面。

建议先定义不依赖 Zustand store 的 `PanelLayoutState`/`PanelRef` 输入，再让 store 调用纯布局函数并删除重复代码。完成前必须保留锁定面板、吸附、边界、行列布局和多显示器固定样本。

### 9.3 占位和未接线服务

| 文件                              | 当前状态                         | 判断                                     |
| --------------------------------- | -------------------------------- | ---------------------------------------- |
| `electron/localFeatureService.ts` | ORB/OpenCV TODO，返回 null 或 0  | 未被业务接线，应标记 experimental 或删除 |
| `electron/ocrService.ts`          | OCR TODO，返回 null 或 0         | 未被业务接线，应标记 experimental 或删除 |
| `electron/objectCropService.ts`   | 中心裁剪可用，对象检测返回空数组 | 只保留真实能力，未实现接口不要伪装为可用 |

死代码判断基于当前 import 搜索，不代表这些方向没有产品价值。若未来实现 NekoSearch 分类，应通过 feature flag、明确 capability 状态和测试重新接入，而不是保留静默返回空结果的生产接口。

## 10. 可扩展性审计

### 10.1 当前可扩展基础

1. Image Search 和 Media Search 已共享模型、embedding、缩略图、路径范围和结果虚拟化经验。
2. 模型注册表可以继续加入 SigLIP 等模型能力，但需同时定义维度、文本能力、GPU 后端和索引版本。
3. JSONL manifest 透明、易诊断，当前规模下读取性能达标。
4. Media task queue、child process 和 progress contract 支持长任务、取消、ETA 和状态恢复。
5. 领域 IPC 允许未来分类、标签和聚类模块独立注册，不需要重新扩张 `main.ts`。

### 10.2 扩展约束

| 方向          | 当前约束                                                    | 推荐演进                                                     |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| 智能分类/标签 | 缺少事务型元数据关系库                                      | 分类、标签、确认状态使用 SQLite；向量继续独立存储            |
| 聚类          | Frame/Image embedding 可复用，但没有稳定 cluster job schema | 使用持久任务、版本化算法参数和可重算结果                     |
| 多模型        | 模型注册存在，但索引兼容性依赖命名约定                      | 增加 `modelId + revision + dim + preprocessVersion` 复合版本 |
| 超大向量库    | 当前精确评分很快，Frame Index 冷加载低于阈值                | 达到阈值后再引入 HNSW/FAISS/sqlite-vec，不提前复杂化         |
| 多进程任务    | child/worker 已有，但状态分散                               | 统一任务状态机、资源配额、取消和日志格式                     |
| 插件化        | IPC 已分域，但没有插件 ABI                                  | 先稳定 capability 和任务契约，再考虑动态插件加载             |

未来 NekoSearch 分类功能不应继续把 categories、tags、suggestions 和 clusters 写入 generic JSONL。该功能存在多表关系、确认/拒绝状态和批量事务，SQLite 更适合作为元数据事实源；embedding shard 或 ANN index 可作为可重建派生数据。

## 11. 测试与发布审计

### 11.1 当前测试覆盖

完整 `npm test` 链覆盖 guards、IPC validation/registration、preload contract、安全表达式、设置、文件管理、watcher、App Storage、重复查找、Media Search、Search Setup workflow、RemoteTerminal、SFTP、transfer、stress、vector pipeline、模型下载流、发布清理和 Native 扫描/解码/哈希/索引，共 **143/143 通过**。

搜索质量验证包括：

1. Media Search 固定样本排序、TopK、scope 和索引行为。
2. 真实 9,423 帧、915 视频、100 查询的 Recall@K 基线。
3. 100K manifest cache 冷/热路径基准。
4. UI 5/5 面板 smoke。
5. NSIS 归档内容 smoke。

### 11.2 质量门禁问题

| 严重度 | 问题                                 | 当前状态                                                       |
| ------ | ------------------------------------ | -------------------------------------------------------------- |
| 已解决 | `npm run format:check` 失败          | 相关文件已统一格式化，当前检查通过                             |
| 已解决 | `verify` 不包含 lint 和 format check | 当前顺序为 typecheck、lint、format:check、test、build:renderer |
| 已解决 | tests/scripts 不在 lint 范围         | lint 已覆盖 `src/ electron/ shared/ tests/ scripts/`           |
| 已解决 | React Hooks lint 未启用              | 官方插件已启用，rules-of-hooks 与 exhaustive-deps 均通过       |
| P2     | 无 CI                                | 没有 `.github/` 或其他自动门禁配置                             |
| P2     | 文本语义准确率不可发布               | 1,748 个候选、12 个概念、0 条人工判断、coverage 0%             |
| P2     | 安装包未做干净 VM 测试               | 当前只验证构建、归档和 unpacked smoke                          |

修复前的格式失败文件（已全部格式化，保留清单用于追溯）：

```text
src/components/MediaSearchStatusGrid.tsx
src/components/remote-terminal/SessionTabs.tsx
src/components/RemoteTerminalPanel.tsx
src/services/mediaSearchBridge.ts
electron/duplicateFinderIpc.ts
electron/mediaCacheService.ts
electron/mediaSearchScope.ts
electron/mediaTaskQueue.ts
electron/modelRegistry.ts
electron/preload.ts
electron/remoteTerminalCredential.ts
electron/remoteTerminalService.ts
electron/rerankService.ts
electron/semanticSearchService.ts
electron/thumbnailIpc.ts
electron/transcriptService.ts
shared/ipc-contract.ts
```

当前 `verify` 已覆盖 typecheck -> lint -> format:check -> unit/fixed/native tests -> renderer build。后续 CI 应复用该入口，并在 Windows release job 追加 `npm audit`、UI smoke、正式构建和安装包归档 smoke。

## 12. 已完成的关键优化

本次审计确认以下历史问题已在当前代码中解决或显著缓解：

1. `electron/main.ts` 业务 IPC 已按领域迁出，当前入口约 286 行。
2. Electron dynamic/static import warning 在当前 Renderer 构建中未复现。
3. Image Search 和 Media Search 大结果列表已虚拟化，视口外缩略图不再完整渲染。
4. Media Search manifest cache 的 100K 热路径已降到 4 ms 内。
5. Frame Index 覆盖全部有效 embedding，真实 Recall 基线没有复现“只搜少量帧”。
6. Media Search 清缓存语义已改为保留 manifest、frames 和 vectors。
7. 跨盘符 scope、TopK、索引重建和固定排序已有自动测试。
8. CLIP/DINO CPU/GPU 能力集中到模型注册表，任务进度、ETA 和取消路径已经存在。
9. RemoteTerminal profiles、connection、SFTP 和 transfer IPC 已拆分，凭据与主机指纹安全边界已建立。
10. 全局 toggle 的窗口透明残留问题、搜索结果过多导致掉帧的问题已有专项修复和试错记录。
11. 文档已迁入 current/audits/designs/handoffs/history/product/reference/benchmark 结构，并由 `docs/README.md` 统一索引。
12. File Manager 覆盖复制/移动已使用可复用事务提交层，失败可恢复旧目标。
13. Vector JSONL 持久化队列可恢复并暴露健康状态，损坏行不再清空整个 store。
14. 模型下载已改为有背压的流式任务，消除完整 chunk 保留和进度时重复哈希。
15. 打包白名单和发布清理脚本已落地，安装包缩减约 24.9%，发布目录只保留安装包。
16. `verify` 已纳入 lint 和 format gate，当前全链路 143/143 测试通过。
17. Image Search 和 Media Search 默认使用简单模式，一键准备流程复用现有数据链；高级模式完整保留原参数和维护能力，任务支持进度、失败短路与取消。
18. Image Search 结果视图固定为 Large，并删除 List 状态和控件分支；虚拟网格继续只挂载可见行，避免大图结果恢复全量渲染。
19. lint 已扩展到 tests/scripts，并启用 React Hooks 官方规则；初始 2 个工具脚本错误、30 个 CLI 输出警告和 14 个 Hooks 依赖警告已分类处理并清零。
20. 文件分页偏移改为读取最新长度引用，目录刷新与 watcher 使用稳定回调；远程文件浏览和联动面板的陈旧闭包风险已消除。

## 13. 优化路线与验收标准

### 13.1 第一阶段：数据安全与任务稳定性（已完成）

1. File Manager 覆盖复制/移动事务化。
2. JsonLinesStore 写队列可恢复、可等待、可报告失败。
3. JsonLinesStore 损坏行隔离和批量清理。
4. 模型下载移除 chunks、增量哈希、节流进度。

阶段验收：新增故障注入测试全部通过；任何失败都不破坏旧目标和有效 JSONL 记录；下载内存不随模型大小线性增长。

### 13.2 第二阶段：交付体积与质量门禁（主体已完成）

1. [已完成] 去除安装包中的重复 CLIP visual 模型。
2. [已完成] 裁剪非 Windows x64 ONNX Runtime。
3. [已完成] 建立最终分发目录，只保留安装包。
4. [已完成] 修复 17 个格式文件并把 format/lint 纳入 `verify`。
5. [已完成] 将 tests/scripts 和 React Hooks 规则纳入 lint，当前 0 错误、0 警告。
6. [待完成] 建立 Windows CI 或等价提交级自动门禁。

阶段验收：当前功能 smoke 不回退；安装包体积显著下降；`release/` 只保留安装包；所有门禁一次通过。

### 13.3 第三阶段：准确率和可维护性

1. 完成人工文本语义标注，至少覆盖 Top10/Top20 后再发布 Precision/nDCG。
2. 合并 `useStore.ts` 与 `arrangeEngine.ts` 的重复布局实现。
3. 删除或 feature-flag 占位 OCR、local feature 和 object detection 接口。
4. 按职责拆分 semantic/embedding/terminal/file pane 大模块。
5. 按领域继续拆分 `shared/ipc-contract.ts`。

阶段验收：人工标注报告 `publishable: true`；布局只有一个事实实现；占位能力不会在 UI 中显示为可用；模块拆分后固定样本和 smoke 不回退。

### 13.4 条件触发优化

以下优化当前没有足够数据支持立即实施：

| 优化                 | 触发条件                                                       |
| -------------------- | -------------------------------------------------------------- |
| Frame Index 二进制化 | 冷加载稳定超过 1 秒或峰值 RSS 超过预算                         |
| Worker/native ANN    | 精确评分 P95 超过 250 ms，或向量规模进入当前基线数倍后阻塞交互 |
| Manifest 迁移 SQLite | 100K 热路径 P95 超过 20 ms，或需要多表事务和复杂查询           |
| 缩略图处理迁出主进程 | 冷缓存 IPC P95 和 event-loop lag 证明同步 I/O 为瓶颈           |

## 14. 验证记录

| 项目                | 命令                                                   | 结果                                                         |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| TypeScript          | `npm.cmd run typecheck`                                | 通过                                                         |
| Lint                | `npm.cmd run lint`                                     | 通过：覆盖 runtime/tests/scripts，0 错误、0 警告             |
| Format              | `npm.cmd run format:check`                             | 通过：所有匹配文件符合 Prettier                              |
| 完整门禁            | `npm.cmd run verify`                                   | 通过：typecheck、lint、format、143/143 tests、renderer build |
| 全量测试            | `npm.cmd test`                                         | 通过：143/143                                                |
| Native Electron ABI | `npm.cmd run build:native:electron`                    | 通过；node-gyp Python 探测产生上游 DEP0190 warning           |
| Renderer 构建       | `npm.cmd run build:renderer`                           | 通过；112 modules；未出现 dynamic/static import warning      |
| 依赖漏洞            | `npm.cmd audit --audit-level=moderate`                 | 通过：0 vulnerabilities                                      |
| 开发态 UI smoke     | `npm.cmd run smoke:ui`                                 | 通过：5/5 面板、0 console error；搜索双模式检查通过          |
| Electron UI smoke   | `npm.cmd run smoke:ui:packaged`                        | 通过：5/5 面板、0 console error、8,972 ms                    |
| 安装包归档          | `npm.cmd run smoke:installer:archive`                  | 通过：176 个归档文件、575.94 MiB、5,816 ms                   |
| 文本标注状态        | `npm.cmd run annotation:text:status`                   | 数据完整；1,748 candidates、0 judgments、coverage 0%         |
| 真实 Recall         | `npm.cmd run benchmark:media-search:recall` 的现有基线 | 通过；9,423 帧、915 视频、100 查询，结果可重复               |

2026-07-14 Hooks/工具链门禁优化后的完整 `verify` 用时 48.3 秒并通过。该轮修改发生在 575.94 MiB 安装包验证之后，为避免重复长时间打包，本轮未重建 NSIS；下一次正式发布需重新生成安装包并复跑 packaged UI/归档 smoke。

关键发布事实：

```text
Installer: FloatingClock Setup 1.0.0.exe
Size:      603,920,601 bytes (575.94 MiB)
SHA256:    1D8A74FC2ADA9802D2670B13AD1C573DC95C5A764007188691D786CEFFAEA9DE
Signature: NotSigned
```

## 15. 审计限制

1. 当前目录不是 Git 工作树，无法验证提交历史、作者和未提交差异。
2. 没有在干净 Windows VM 执行安装、升级、卸载、SmartScreen 和用户数据保留测试。
3. 文本语义候选池没有人工标签，不能把视觉 Recall 或候选数量当作文本语义准确率。
4. UI smoke 验证固定布局和非空像素，不替代长时间拖拽、窗口撕裂、多显示器和不同刷新率人工测试。
5. GPU 利用率受解码、磁盘、模型、温度和驱动影响，本报告没有把一次任务管理器读数当作稳定吞吐结论。
6. P1 回滚、写失败恢复、流式下载取消和发布清理均已有自动测试；仍未覆盖操作系统断电、进程强杀发生在原子提交窗口内的真实故障。

本审计的事实优先级为：当前代码和本次命令结果 > 当前基线文档 > 2026-07-12 基准报告 > 历史审计和旧方案。
