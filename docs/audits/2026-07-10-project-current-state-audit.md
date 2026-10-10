# FloatingClock 项目多角度审计 - 2026-07-10 当前状态

> 状态：历史快照  
> 审计日期：2026-07-10  
> 当前入口：[文档中心](../README.md)

## 1. 审计范围和方法

本次审计覆盖当前工作区的核心源码和工程配置：

- Renderer: `src/`
- Electron main/preload/services: `electron/`
- 共享类型契约: `shared/`
- 自动化测试和基准脚本: `tests/`
- 原生扫描模块和构建配置: `native/`
- 构建脚本和包配置: `scripts/`, `package.json`, `vite.config.mjs`

本次审计采用静态代码阅读、工程度量、关键路径抽样和现有测试结果交叉验证。未覆盖模型权重内容本身、已发布安装包的安装流程体验、真实 GUI 拖动延迟采样。

已执行的验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:media-search
npm.cmd run build:renderer
npm.cmd audit --audit-level=high
```

结果：以上均通过；`npm audit --audit-level=high` 显示 `found 0 vulnerabilities`。

## 2. 项目总体结论

当前项目已经从早期“大 main.ts”状态推进到较清晰的多域模块结构。主进程入口 `electron/main.ts` 当前约 268 行，已经不直接注册 `ipcMain.handle(...)`，核心 IPC 被迁移到按领域拆分的 `*Ipc.ts` 模块中，这是结构层面最大的正向变化。

当前主要风险不再是单点入口臃肿，而是以下几个方向：

1. 大模块仍然较多，单文件超过 800 行的业务模块集中在语义搜索、embedding、远程终端 UI、ImageSearch、MediaSearch、全局 store。
2. IPC channel 数量较多，当前约 144 个 `ipcMain.handle`，需要继续用测试和集中契约防止遗漏、参数漂移和权限扩大。
3. 主进程仍存在较多同步文件 IO。多数在显式重任务路径中可以接受，但部分统计、缓存、索引路径仍可能影响交互响应。
4. Renderer 面板数量多，部分面板仍静态进入首包。MediaSearch 已拆成 lazy chunk，但 RemoteTerminal、ImageSearch 等仍有继续拆包空间。
5. 安全边界已有基础防护，但 preload 暴露面很宽，文件系统/远程终端/外部打开能力都应继续按“能力最小化”审查。
6. 当前测试覆盖后端服务和安全 guard 较好，但 UI 级 smoke、IPC 完整性、真实性能回归还不充分。

## 3. 工程度量

### 3.1 目录规模

| 目录 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src` | 69 | 18,612 |
| `electron` | 60 | 17,485 |
| `shared` | 2 | 1,603 |
| `tests` | 26 | 3,822 |
| `native` | 29 | 335,005 |
| `scripts` | 4 | 441 |

说明：`native` 行数主要被 `stb_*.h` 和编译输出拉高，不代表业务代码复杂度。

### 3.2 最大源码文件

| 文件 | 行数 | 主要问题 |
| --- | ---: | --- |
| `shared/ipc-contract.ts` | 1,269 | 所有领域类型集中，后续扩展会越来越难导航 |
| `electron/semanticSearchService.ts` | 1,230 | 语义搜索、CLIP 缓存、候选采样、fallback 混在一个文件 |
| `src/stores/useStore.ts` | 1,139 | 全局 UI 状态、布局、可见性、面板位置高度集中 |
| `electron/embeddingService.ts` | 1,135 | 队列、模型子进程、诊断、失败记录、进度状态耦合较多 |
| `src/components/RemoteTerminalPanel.tsx` | 1,057 | UI、会话管理、指标、文件浏览等职责混杂 |
| `src/components/filemanager/FilePane.tsx` | 994 | 文件面板交互和渲染逻辑偏重 |
| `src/components/MediaSearchPanel.tsx` | 926 | 已拆子组件和 lazy chunk，但状态/动作仍集中 |
| `src/components/ImageSearchPanel.tsx` | 899 | 搜索、状态、结果、索引控制仍可继续拆分 |
| `electron/imageSearchService.ts` | 888 | native 扫描、manifest、索引加载、状态管理集中 |

### 3.3 IPC 分布

当前 `electron/main.ts` 无直接 `ipcMain.handle/on` 注册。IPC 主要分布如下：

| 模块 | handler 数 | 行数 |
| --- | ---: | ---: |
| `mediaSearchIpc.ts` | 29 | 687 |
| `vectorIpc.ts` | 22 | 387 |
| `imageSearchIpc.ts` | 21 | 157 |
| `appCoreIpc.ts` | 17 | 286 |
| `fileManagerIpc.ts` | 15 | 591 |
| `remoteTerminalTransferIpc.ts` | 7 | 209 |
| `duplicateFinderIpc.ts` | 6 | 55 |
| `remoteTerminalProfileIpc.ts` | 6 | 60 |
| `appStorageIpc.ts` | 6 | 53 |
| `remoteTerminalConnectionIpc.ts` | 6 | 191 |
| `remoteTerminalSftpIpc.ts` | 5 | 176 |
| `thumbnailIpc.ts` | 4 | 398 |

### 3.4 同步 IO 和外部能力热点

静态匹配结果：

| 模式 | 出现次数 | 审计含义 |
| --- | ---: | --- |
| `fs.readFileSync` | 34 | 大文件 JSONL、manifest、缓存读取需关注是否在交互路径 |
| `fs.readdirSync` | 7 | 目录递归统计和 worker 枚举需避免跑在 UI 敏感路径 |
| `fs.statSync` | 33 | 单次开销小，但批量路径和网络盘可能放大 |
| `fs.rmSync` | 46 | 多数是清理缓存/数据，需继续保持路径边界校验 |
| `spawn(` | 6 | embedding 子进程、ffmpeg 等，需限制参数和生命周期 |
| `execFile(` | 1 | AppStorage 调用系统命令，当前比 shell 拼接安全 |
| `shell.openPath` | 8 | 需保证路径是本地文件路径并已校验 |
| `showItemInFolder` | 6 | 同上 |

## 4. 结构审计

### 已改善的结构

1. `main.ts` 已回归入口职责：窗口创建、生命周期、服务初始化、IPC 模块装配。
2. MediaSearch、Vector、RemoteTerminal、Thumbnail、AppCore 等 IPC 已按领域拆分。
3. Renderer 侧已有 bridge 层，如 `mediaSearchBridge`、`imageSearchBridge`，组件不直接散落 `ipcRenderer.invoke`。
4. 共享类型集中在 `shared/ipc-contract.ts`，降低了 main/preload/renderer 的类型不一致风险。
5. MediaSearch 面板已 lazy chunk，构建产物出现 `MediaSearchPanel-*.js`，主包体积从约 409 KB 降到约 376 KB。

### 结构问题

1. `shared/ipc-contract.ts` 过大。它承载文件管理、ImageSearch、MediaSearch、RemoteTerminal、Vector、设置等全部类型，后续多人维护时容易产生冲突。
2. 全局 `useStore.ts` 过大。面板可见性、布局、配置、拖拽位置、业务状态混在一个 store 中，扩展新面板会持续增加复杂度。
3. 大 UI 组件仍偏多。`RemoteTerminalPanel.tsx`、`ImageSearchPanel.tsx`、`MediaSearchPanel.tsx` 都已经到了应继续按“状态 hook + 子视图 + action service”拆分的规模。
4. 部分领域服务仍承担多职责。典型是 `semanticSearchService.ts` 和 `embeddingService.ts`。
5. 源码目录中存在较多生成/构建产物，如 `native/build*`。如果该目录需要长期协作，建议明确哪些是源文件、哪些只作为本机产物。

### 建议

1. 将 `shared/ipc-contract.ts` 拆成 `shared/ipc/file-manager.ts`、`shared/ipc/media-search.ts`、`shared/ipc/remote-terminal.ts`、`shared/ipc/vector.ts` 等，再由总入口 re-export。
2. 将 `useStore.ts` 拆为至少四个 slice：visibility、layout、settings、panel-state。
3. `RemoteTerminalPanel` 拆成 `useRemoteTerminalState`、`useRemoteTerminalSessions`、`RemoteTerminalLayout`。
4. `semanticSearchService` 拆成 CLIP cache、token/synonym、candidate collection、ranking/fallback 四个模块。
5. 对生成产物增加明确的 `.gitignore` 或 `docs/reference/native-build-artifacts.md` 说明。

## 5. 逻辑审计

### MediaSearch

当前流程大致为：

`scan video -> video manifest -> build frames -> frame embeddings -> frame index -> image/text/similar/multimodal search`

优点：

- 已引入 frame index，避免每次搜索全量扫描 embedding shard。
- 固定样本测试已覆盖相似帧、文本搜视频、以图搜视频、scope 过滤、frame index 自动重建。
- 打开面板的轻量状态和 lazy chunk 已降低卡顿风险。

问题：

- `mediaSearchIpc.ts` 仍是最大 IPC 模块，既处理配置、扫描、列表、搜索、字幕、multimodal，又做结果补图。
- 路径 scope、frame key normalize、cosine score 等逻辑在多个服务中重复。
- JSONL manifest 和 embedding shard 的一致性依赖文件签名和显式 invalidation，长期看需要更强的索引元数据。
- `getCacheStats`、`clearCache`、`clearData` 仍可能递归扫描目录，适合继续做后台化或进度化。

建议：

1. 将 `mediaSearchIpc.ts` 再拆为 `mediaSearchListIpc`、`mediaSearchTaskIpc`、`mediaSearchSearchIpc`、`mediaSearchSubtitleIpc`。
2. 抽取 `electron/mediaSearchVectorMath.ts`，统一 `cosineScore`、`normalizeFrameKey`。
3. 为 frame index 增加 meta 文件，记录 manifest signature、shard signature、模型名、entries、errors，减少反复判断。
4. 将 cache stats 做成缓存加后台刷新，不在按钮点击之外的 UI 路径同步递归目录。

### ImageSearch

优点：

- 有 native addon `fast_scanner`，扫描性能基础较好。
- manifest 和 segment 结构已经比纯 JSON 全量读写更适合大索引。
- IPC 拆分较完整，bridge 和 panel 分层清楚。

问题：

- `imageSearchService.ts` 仍承担 native 加载、manifest 修复、扫描状态、索引加载等多职责。
- `ImageSearchPanel.tsx` 仍偏大。
- 默认 manifest 自动加载很强，但启动期如果数据量极大，仍需继续观察主进程初始化耗时。

建议：

1. 将 native addon 加载、manifest store、scan orchestration 分离。
2. 给自动加载 manifest 增加更详细的耗时日志和延迟策略。
3. 将 ImageSearch UI 拆为 index controls、query controls、results、status 四块。

### Vector 和 Embedding

优点：

- embedding 子进程隔离，避免模型推理完全堵塞主进程。
- CLIP/DINO child 构建为独立入口，打包路径明确。
- 有 vector pipeline 测试和 frame search 固定样本。

问题：

- `embeddingService.ts` 维护队列、状态、诊断、子进程池和失败记录，复杂度偏高。
- `vectorDatabaseService.ts` 仍有全量 JSONL 同步读取路径，大库下会影响耗时。
- 多模型扩展点偏硬编码，新增模型需要改多处。

建议：

1. 拆出 `embeddingQueueService`、`embeddingChildPool`、`embeddingDiagnostics`。
2. 为 vector store 增加 append-only shard meta 和流式 reader，减少 `readFileSync().split('\n')`。
3. 将模型能力集中为 registry：模型名、dim、child entry、支持搜索类型、默认 backend。

### RemoteTerminal

优点：

- IPC 已按 profile、credential、SFTP、transfer、connection 拆分。
- 凭据使用 Electron `safeStorage` 加密，profile 存储时剥离 password/passphrase。
- SSH host fingerprint 校验存在，未知或变更 host key 会阻止连接并返回提示。
- transfer token 绑定 sender，避免跨 renderer 滥用选择结果。

问题：

- `RemoteTerminalPanel.tsx` 过大，UI 和会话逻辑高度耦合。
- `saveProfile` 只校验必填字段，对 host、port、id、name、privateKey 等长度和格式约束还不够细。
- 远程 metrics 执行脚本是功能需要，但属于高权限远程命令，应在 UI 上保持清晰边界。

建议：

1. 为 `RemoteTerminalProfile` 增加统一 normalize/validate 函数和测试。
2. 限制字段长度、端口范围、host 字符集、privateKey 最大长度。
3. 拆分 RemoteTerminal UI 状态 hook，降低后续 SFTP/多会话扩展成本。

### FileManager

优点：

- 已有 paged listing，适合 10K+ 文件夹。
- 文件删除走 `shell.trashItem`，比直接删除更安全。
- path guard 有测试覆盖。

问题：

- 仍保留 `fm-list-directory` 非分页全量路径，可能被旧调用或未来误用。
- `fm-list-directory-paged` 在按 size/mtime/type 排序时仍需要 stat 全目录后排序，大目录会慢。
- `safeShellPath` 当前主要是 normalize，不是严格的“本地文件路径白名单”。

建议：

1. Renderer 侧确认只使用 paged listing，逐步废弃非分页 handler。
2. 大目录排序增加“name 快速列表，其他排序异步计算”的 UX。
3. 强化 `safeShellPath`：拒绝 NUL、空路径、明显非本地 path、可选存在性校验。

## 6. 性能和效率审计

### 已完成的性能优化

1. MediaSearch 打开路径已改为 lazy chunk。
2. MediaSearch 初次 status 可轻量请求，不读 manifest 计数。
3. `getMediaSearchDir()` 不再为了日志读取完整 manifest。
4. Dev server 固定 `127.0.0.1` 并加入 Electron load retry，降低开发启动失败概率。
5. `MediaSearchPanel` 初次 vector progress 查询已延后到 idle/定时器。

### 主要性能风险

1. 同步 JSONL 读取仍多，尤其 vector db、semantic cache、manifest preview、frame index。
2. 递归目录 size 统计在 `getCacheStats`、Vector maintenance、AppStorage 等场景可能耗时。
3. Renderer 中多个大型面板仍静态进入主包，RemoteTerminal 和 ImageSearch 是下一批拆包候选。
4. overlay shape 每 200ms 轮询，并在拖动时持续 `getBoundingClientRect()`，透明置顶窗口下会放大渲染成本。
5. 缩略图和 frame image 通过 data URL 进 IPC，批量结果较大时会造成内存和序列化压力。

### 建议优先级

P0:

1. 将 `getCacheStats` 和目录 size 统计改为缓存 + 后台刷新。
2. 对 `vectorDatabaseService` 和 `semanticSearchService` 的大文件读取改为流式或 mmap-like 分段。
3. 给面板打开建立统一 perf marker：mount、first paint、first IPC、IPC done。

P1:

1. Lazy load RemoteTerminal、ImageSearch、AppStorage、DuplicateFinder。
2. overlay shape 从固定 interval 改为 ResizeObserver/MutationObserver + visibility event。
3. 图片/缩略图 IPC 改为按需懒加载，不随搜索结果默认返回大 data URL。

P2:

1. 增加 benchmark 脚本固定输出到 `docs/benchmark/`。
2. 对网络盘、超大目录、10 万 manifest 行做独立压测。

## 7. 安全审计

### 已有安全措施

1. `BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
2. CSP 已配置：`default-src 'self'`、`script-src 'self'`、`object-src 'none'` 等。
3. 禁止新窗口，限制顶层导航。
4. Preload 通过 `contextBridge` 暴露固定 API，而非直接暴露 Node。
5. settings/config/clipboard/duplicate scan 等有 `ipcValidation.ts` 限制大小和类型。
6. 远程终端凭据使用 safeStorage。
7. SSH host key fingerprint 校验存在。
8. 文件删除使用回收站。
9. 依赖高危审计当前为 0 漏洞。

### 仍需补强

1. Preload API 面很宽。144 个 IPC channel 中包含文件系统、远程连接、外部打开、模型下载、执行 ffmpeg 等高权限能力，需要持续最小化。
2. `safeShellPath` 名称比实际约束更强。当前主要 normalize，不拒绝所有危险字符/非本地路径，也不总是检查存在性。
3. `safeEval.ts` 使用 `new Function`，虽有白名单，但仍建议改为手写表达式 parser，彻底去掉动态执行。
4. CSP 的 `style-src 'unsafe-inline'` 是 React 内联样式的现实妥协；长期若要安全加固，需要迁移为 class/style sheet。
5. `connect-src ws:` 为开发环境方便，生产可以考虑更严格区分 dev/prod CSP。
6. RemoteTerminal profile 保存需要更强字段校验，避免超大配置或异常 host 进入持久化。
7. 部分 `shell.openPath`、`showItemInFolder` 调用只依赖 normalize，建议统一走更严格的 path guard。

### 安全优化建议

P0:

1. 增强 `safeShellPath`，并补充负向测试。
2. 为 RemoteTerminal profile 增加 normalize/validate 测试。
3. 增加 IPC channel allowlist/注册完整性测试，确保 preload 暴露与 main handler 一致。

P1:

1. 替换 `safeEval.ts` 的 `new Function`。
2. 将高权限 IPC 按能力分级，文档化哪些 API 可读、可写、可执行外部程序。
3. 对 `openPath/showItemInFolder` 增加统一 wrapper。

## 8. 复用性审计

### 已有可复用资产

- `pathGuards.ts`
- `ipcValidation.ts`
- `mediaSearchScope.ts`
- `mediaSearchImageCache.ts`
- `mediaFrameEmbeddingState.ts`
- `remoteTerminalCredential.ts`
- bridge 层模式
- fixed sample 测试模式

### 重复点

1. `normalizeFrameKey`、`cosineScore` 在 MediaSearch 多处重复。
2. path normalize/scope 判断在 MediaSearch、VideoFrameSearch、FileManager、Vector 里重复实现。
3. IPC handler 的参数解析重复，很多 handler 都是“raw unknown -> validate -> service call -> result”。
4. 面板位置、锁定、显示隐藏逻辑在 store 和 App/DraggablePanel 之间仍偏分散。

建议：

1. 建立 `electron/common/vectorMath.ts`、`electron/common/pathScope.ts`。
2. 建立轻量 IPC helper，如 `handleValidated(channel, validator, handler)`。
3. 建立 panel registry，把默认位置、尺寸、可见性 key、lazy loader 放到配置。

## 9. 可扩展性审计

### 正向基础

1. 按功能域拆分后，新功能不必再塞进 `main.ts`。
2. Vite 多入口已经支持 worker/child process/main/preload 分开构建。
3. tests 中已有服务级固定样本和 native correctness 测试。
4. Electron build extraResources 已包含 native、模型、工具和 child entry。

### 扩展风险

1. 新增一个模型需要改 model service、embedding child、vector settings、UI、IPC，多点修改。
2. 新增一个面板会继续推高 `useStore`、App visibility、settings persistence 的复杂度。
3. 新增 IPC channel 没有自动一致性检查，容易出现 preload 暴露了但 main 没注册，或相反。
4. JSONL 存储适合快速迭代，但随着数据量增长，查询、压缩、失效、迁移都会变难。

建议：

1. 建 model registry。
2. 建 panel registry。
3. 建 IPC contract test。
4. 中长期评估 SQLite/RocksDB/LMDB 之类的本地索引存储，用于 manifest、frame index、vector metadata。

## 10. 测试覆盖审计

当前测试亮点：

- FileManager 安全 guard。
- settings store。
- RemoteTerminal/SFTP/Transfer/Stress。
- MediaSearch guard + fixed samples。
- native hash/decode/segment/search correctness。
- vector pipeline。

测试缺口：

1. 缺少 UI smoke 测试，例如打开每个面板后无白屏、无 console error。
2. 缺少 IPC 注册完整性测试。
3. 缺少 preload API 和 shared contract 的一致性测试。
4. 缺少性能预算测试，例如 MediaSearch 打开首帧、manifest 10 万行 list preview。
5. 缺少真实打包后启动 smoke。

建议新增：

1. `tests/ipc-registration.test.cjs`
2. `tests/preload-contract.test.cjs`
3. `tests/media-search-open-perf.test.cjs`
4. Playwright/Electron UI smoke，至少覆盖 Clock、FileManager、ImageSearch、MediaSearch、RemoteTerminal 面板挂载。

## 11. 当前最值得做的优化清单

### P0 - 高收益，低到中风险

1. IPC 完整性测试：枚举预期 channel，校验 main 模块注册无遗漏。
2. 加强 path guard：统一 `openPath/showItemInFolder` wrapper。
3. RemoteTerminal profile validate：限制 host、port、id、name、privateKey 大小。
4. 将 cache stats 和目录 size 统计后台化。
5. 清理仍残留的乱码注释和文本，降低维护噪声。

### P1 - 中高收益，中风险

1. 继续 lazy load RemoteTerminal、ImageSearch、AppStorage、DuplicateFinder。
2. 拆 `shared/ipc-contract.ts`。
3. 拆 `useStore.ts` 为 slices。
4. 拆 `semanticSearchService.ts` 和 `embeddingService.ts`。
5. MediaSearch 的缩略图/帧图改为按需请求，不随结果默认返回 data URL。

### P2 - 长期收益

1. 引入更强的本地索引存储，替代部分 JSONL 全量扫描。
2. 建统一 benchmark 输出和性能预算。
3. 建 feature registry：panel、IPC、settings、permissions、docs 同源配置。
4. 原生模块构建产物和源码分层管理。

## 12. 推荐执行路线

第一阶段：

1. IPC 完整性测试。
2. path guard 加固。
3. RemoteTerminal profile validate。
4. cache stats 后台化。

第二阶段：

1. lazy load 其余大面板。
2. `useStore` slices。
3. shared IPC contract 拆包。

第三阶段：

1. Vector/semantic/embedding 服务拆分。
2. JSONL 索引升级方案。
3. UI smoke + 性能预算测试。

## 13. 总结

当前项目已经具备较好的基础结构：主进程入口收敛、IPC 领域化、Electron 安全配置完整、测试覆盖逐步覆盖到关键服务。接下来最重要的不是继续堆功能，而是把“宽 IPC、同步 IO、大模块、全局 store、性能预算缺失”这些可预见的维护风险收住。

从投入产出看，优先做 IPC 完整性测试、路径安全 wrapper、RemoteTerminal profile validate、cache stats 后台化和大面板 lazy load，是当前最合适的下一轮优化。
## 2026-07-11 更新说明

本文档中的部分待办已经完成。最新项目状态、已关闭问题和后续优化顺序请以 `docs/current/2026-07-11-project-optimization-audit.md` 为准。
