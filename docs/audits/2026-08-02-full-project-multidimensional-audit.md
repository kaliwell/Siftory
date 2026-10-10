# FloatingClock 全项目多维审计

> 状态：当前
> 审计日期：2026-08-02
> 审计基线：`3dadb15`（`main`）
> 执行系统：Codex / GPT-5 系列，精确小版本未公开
> 范围：结构、逻辑正确性、性能效率、安全、复用、扩展性、数据结构、真实数据健康、测试、构建、发布与文档
> 替代文档：[2026-07-28 全项目综合审计](2026-07-28-full-project-audit.md)
> 性质：基线采集为只读工程与真实数据审计；第 15 节记录审计后的专项实现。全过程未写入或删除真实用户数据

## 1. 快速结论

当前版本适合继续开发和内部使用，基础搜索、素材库、双语界面、数据事务与 Electron 安全隔离已有较强工程基础；但完整验证链、真实数据治理和公开发布条件尚未闭环，不能标记为正式公开发布版本。

综合工程健康度评估为 **76/100**。与 2026-07-28 的 71/100 相比，依赖安全、UI smoke、IPC 授权、磁盘治理工具、Native 生命周期和构建可复现能力已有实质改善；本次新增发现主要集中在真实数据堆积、模型平台迁移后的测试契约、覆盖率回退和库存统计失真。

| 维度 | 评分 | 当前判断 |
| --- | ---: | --- |
| 功能与逻辑正确性 | 78 | 主要功能和专项测试稳定；三组模型集成测试与当前用户模型机制不一致 |
| 结构与可维护性 | 74 | 分层和领域拆分清晰；仍有多个 1,000–2,000 行热点 |
| 性能与效率 | 82 | 查询核心性能优秀；向量维护、遗留任务加载和同步文件 I/O 仍有空间 |
| 安全 | 84 | sandbox、IPC 授权、参数验证和凭据加密到位；CSP/权限策略仍可收紧 |
| 复用与扩展性 | 78 | 共享契约、注册表、存储和 worker 能力可复用；部分领域仍重复编排 |
| 数据健康 | 58 | SQLite 主库健康，但向量、任务、索引和历史派生数据存在明显堆积与少量畸形记录 |
| 测试与质量门禁 | 72 | 类型、lint、格式、双语 smoke 通过；完整测试和关键覆盖率门禁失败 |
| 构建与发布 | 48 | Renderer/Electron 构建通过；许可证、签名、正式发布记录和完整 verify 未通过 |

### 1.1 发布判定

- 日常开发：**允许**。
- 内部使用：**允许，但建议先备份并分批执行数据维护**。
- 内部测试包：**有条件允许**，必须明确记录模型集成测试和覆盖率门禁失败。
- 公开或商业发布：**阻断**。许可证/EULA/授权证据、签名、正式 release record、NekoSearch 人工准确率门禁和完整验证尚未关闭。

## 2. 审计边界与事实优先级

1. 事实优先级为：当前代码和本次实测 > `docs/current/` > 本审计之前的审计 > 历史方案。
2. 本次没有安装 NSIS 安装包，没有运行 packaged smoke，没有修改或清理真实用户数据。
3. 本次使用本机现有 Native 产物执行测试，没有重新执行 `npm.cmd run build:native`。
4. 工作区原有 11 个仅表现为换行符状态异常的已跟踪路径和未跟踪 `start.bat`；归属未知，本次未修改。
5. Git 当前无 remote；本地历史不能代替远端灾备和服务端分支保护。
6. 真实数据路径只在命令执行期读取；本文仅记录逻辑数据域，不保存个人绝对路径。

## 3. 项目规模与结构

### 3.1 规模

| 区域 | 文件数 | 物理行数 |
| --- | ---: | ---: |
| `electron/` | 172 | 50,298 |
| `src/` | 108 | 29,532 |
| `tests/` | 130 | 24,834 |
| `native/` | 9 | 21,045 |
| `scripts/` | 44 | 5,286 |
| `shared/` | 17 | 3,707 |
| 合计 | 480 | 134,702 |

`native/stb_image.h` 和 `native/stb_image_resize2.h` 共约 16,334 行，属于内嵌第三方源码；扣除后，一方代码和测试约 11.8 万行。54 个文件超过 500 行，19 个超过 1,000 行。

### 3.2 当前结构优点

1. Renderer、主进程、共享契约和 Native 边界明确；`src/` 没有直接导入 `electron/` 实现。
2. IPC 按 Image Search、Media Search、Asset Library、Vector、Remote Terminal 等领域注册，并通过 `electron/ipcAuthorization.ts` 统一执行 sender、main-frame、origin 和 payload 校验。
3. `shared/ipc-contract.ts`、`shared/ipc-capabilities.ts` 和 preload contract 形成可测试的边界。
4. 面板通过 `src/config/panelRegistry.ts` 懒加载；重型面板已经形成独立 chunk。
5. 大量耗时任务已迁移到 child process、worker 或 Native 有界流水线。
6. 素材库的列表、统计、聚类、备份、事务和控制器已经从早期大文件中拆出多个可复用服务。

### 3.3 当前热点

| 文件 | 行数 | 主要风险 |
| --- | ---: | --- |
| `native/fast_scanner.cc` | 3,829 | 扫描、索引、持久化、N-API 生命周期仍集中在单一编译单元 |
| `electron/assetLibraryDatabase.ts` | 1,978 | schema、迁移、查询和写事务耦合，变更回归面大 |
| `electron/semanticSearchService.ts` | 1,923 | 模型、缓存、查询和降级路径集中 |
| `electron/imageSearchService.ts` | 1,650 | 扫描、查询、Data Editor、索引持久化和项目预览协调耦合 |
| `electron/embeddingService.ts` | 1,337 | 任务选择、进程管理、批处理和日志治理耦合 |
| `src/components/ImageSearchPanel.tsx` | 1,195 | UI 状态和多类搜索编排集中 |
| `src/components/MediaSearchPanel.tsx` | 1,151 | 扫描、查询、视图和任务状态集中 |
| `src/stores/useStore.ts` | 1,150 | 多面板全局状态扩展时容易产生无关订阅和更新 |
| `src/components/AssetLibraryPanel.tsx` | 1,108 | 已拆子视图但顶层控制流仍大 |
| `src/components/SettingsPanel.tsx` | 1,026 | 设置域继续扩展会增加 UI 回归范围 |

结论：结构已从“单体功能堆叠”转向“有领域边界的中型桌面应用”，但热点拆分仍应围绕状态所有权和事务边界进行，不能只按文件行数机械拆分。

## 4. 逻辑正确性与功能完整性

### 4.1 已确认正常

- TypeScript、ESLint、Prettier 和 Renderer/Electron/worker 构建通过。
- 双语 UI smoke 在 `zh-CN` 和 `en` 下均通过；7 个关键面板存在，无 console error，语言切换和恢复正常。
- Image Search Data Editor 基线 44/44 通过；审计后加入指定文件夹多层索引编辑，当前专项
  50/50 通过，新增覆盖 DINO/CLIP 原子改写、过期预览、取消恢复和源文件不变。
- Native 59/59 通过；当前 281,016 条索引可加载，path map 健康。
- Asset Library 两个 SQLite 数据库 `PRAGMA quick_check` 均为 `ok`，外键违规为 0。
- Project Preview 15/15 通过。

### 4.2 P1：模型平台迁移后集成测试前置条件失真

提交 `16867d6` 已将 Face Detector、Face Embedder、Person ReID 和 MobileSAM 移到用户 Model Platform 插槽；运行时代码不再把仓库 `models/` 下的旧文件当成已安装模型。但是以下测试仍用旧目录判断 `MODELS_PRESENT`：

- `tests/face-match.test.cjs`
- `tests/person-reid.test.cjs`
- `tests/sam-segment.test.cjs`

本机保留旧 ONNX 文件，因此测试进入真实模型分支，而运行时插槽为空，造成 11 个子测试失败；Node 汇总时连同 3 个父 suite 共报告 14 个失败。`npm.cmd test` 在 Face Match 阶段停止，后续组不会由标准链自动执行。

影响：运行时会按设计安全降级，不直接破坏现有搜索；但完整 CI/verify 被阻断，且真实模型兼容性无法由当前测试证明。

修复原则：测试必须复用 `userModelPlatformService` 的安装/临时注册机制，或在隔离 userData 中显式安装 fixture 模型；不能继续通过旧随包路径推断用户插槽状态。

### 4.3 P1：关键覆盖率门禁回退

`npm.cmd run coverage:critical` 的 77 个测试全部通过，但 `electron/assetMetadataTransaction.ts` 行覆盖率为 83.13%，低于门禁基线 84%，导致命令失败。总体覆盖率为：行 82.43%、分支 70.74%、函数 82.67%。

影响：当前没有证据说明事务实现错误，但新分支或异常路径缺少回归保护，完整 `ci:verify` 不能通过。

## 5. 数据结构与持久化设计

### 5.1 主要数据域

| 数据域 | 当前结构 | 一致性/恢复机制 |
| --- | --- | --- |
| 素材主目录 | `assets.jsonl` + `asset-catalog.sqlite` 投影 | JSONL 与 catalog 当前均为 252,903 条；SQLite WAL、事务和重建投影 |
| 素材关系 | `asset-library.sqlite` | WAL、外键、schema migration、备份/恢复事务 |
| Image Search | segment manifest + mmap `.idx` + overlay/tombstone | manifest 临时文件原子替换、writer lease、空索引显式持久化 |
| DINO/CLIP 向量 | 两个权威 JSONL shard | GC 快照、原子替换、恢复备份；派生 F32/F16 和 ANN 缓存 |
| Media Search | 视频/帧 JSONL + 帧向量 JSONL +派生帧 | 临时文件替换、可重建派生数据 |
| 用户模型 | Model Platform slot metadata + 用户提供 ONNX | schema v3、图检查、profile/adapter、变更前释放 session |
| Remote Terminal | profile JSON + OS 加密 credential JSON | `safeStorage` 加解密、临时文件后 rename；明文不落盘 |

### 5.2 设计优点

1. 素材关系使用 SQLite 事务，复杂查询不再全量扫描 JSONL。
2. Image Search 使用 segment mmap 和 manifest，28 万级索引加载和查询性能稳定。
3. 向量 GC 使用 active-set 快照、磁盘空间预检、取消、原子切换和恢复备份，具备安全执行基础。
4. JSONL 事务和本地文件替换覆盖断电、权限、磁盘满和恢复场景。
5. 用户模型和随包模型已分离，降低未知模型许可证直接进入商业包的风险。

### 5.3 结构债务

1. 向量 JSONL 同时承载高维浮点数组和元数据，空间放大明显；F16/F32/ANN 仍是派生缓存，权威切换尚未完全落地。
2. `embedding_jobs.jsonl` 是状态快照而非有 epoch 的任务账本，`pending` 无过期/所有者语义，历史任务会永久被视为活动任务。
3. `asset-catalog.sqlite` 是 JSONL 投影，虽当前计数一致，但需要持续保留指纹和可重复重建门禁。
4. Image Search manifest 只引用当前 segment，旧 segment/staging 没有纳入库存和安全回收闭环。

## 6. 真实数据健康审计

### 6.1 总体容量

当前主用户数据目录物理占用约 **18.3 GiB**。主要组成：

| 逻辑域 | 占用 |
| --- | ---: |
| `vector-db` | 14.47 GiB |
| 历史 Image Search 扫描日志 | 0.78 GiB |
| Media Search | 0.72 GiB |
| 素材库备份 | 0.68 GiB |
| Image Search 索引 | 0.49 GiB |
| 用户数据下模型目录 | 0.41 GiB |
| 当前素材库 | 0.24 GiB |
| 素材恢复快照 | 0.20 GiB |

### 6.2 数据健康结果

| 检查 | 结果 | 判定 |
| --- | --- | --- |
| 当前配置 JSON | 6/6 可解析 | 正常 |
| 当前主要 JSONL 首尾抽样 | 15 个文件，抽样无解析错误且均以换行结束 | 基础结构正常 |
| 素材 `assets.jsonl` | 252,903 行，0 解析错误、0 重复规范化路径、0 空路径 | 正常 |
| 素材缺失标记 | 7,731 条，占约 3.06% | 需确认是否为用户已移动/删除文件 |
| `asset-catalog.sqlite` | 252,903 条，与 JSONL 一致；quick_check ok | 正常 |
| `asset-library.sqlite` | quick_check ok，0 外键违规 | 正常 |
| Image Search manifest | 3 个 segment，281,016 条可加载，path map healthy | 当前索引正常 |
| 向量 GC | 2 个 shard 合计 975,971 行；发现 363,649 条 stale、62,410 条 duplicate、3 条 malformed | 明显堆积 |
| Embedding jobs | 235,635 行全部为 `pending`，0 解析错误 | 状态异常/失去时效语义 |

### 6.3 P1：向量数据膨胀和畸形记录

项目自带 `preview:vector-gc` 在 85.06 秒内扫描两个权威 shard：

| Shard | 源大小 | active | stale | duplicate | malformed | 可回收 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CLIP 512d | 5,460,308,954 B | 273,375 | 184,913 | 30,952 | 0 | 2,409,633,020 B |
| DINO 768d | 8,045,586,193 B | 276,534 | 178,736 | 31,458 | 3 | 3,473,929,852 B |
| 合计 | 13,505,895,147 B | — | 363,649 | 62,410 | 3 | 5,883,562,872 B（约 5.48 GiB） |

结论：不是整个向量库损坏；大部分 active 记录可识别，只有 3 条格式异常。但历史重建产生了大量 stale/duplicate，已显著放大磁盘和维护扫描时间。

### 6.4 P1：遗留任务队列永久活动

`embedding_jobs.jsonl` 为 97,196,022 B、235,635 行，全部为 `pending`。当前保留策略永久保留 `pending/running`，库存也把它们全部视为不可回收。一次性读取并解析该文件实测约 424 ms，RSS 增量约 340.9 MiB；`embeddingService.ts` 的无显式 scan-path fallback 仍会调用 `jobStore.getAll()`。

这说明任务行在结构上合法，但业务状态已经失真。直接清空可能丢失合法待办，正确做法是引入 build epoch、来源 scan snapshot 和最后心跳，再把无 owner、超期且已有 embedding 的 pending 转成可预览的 stale job。

### 6.5 P1：Image Search 孤儿 segment/staging

当前 manifest 只引用 3 个文件、约 43.99 MiB；索引目录另有 44 个未引用文件、约 457.93 MiB，其中包括旧 segment 和一个约 20.6 MiB 的 staging 临时文件。当前索引加载正常，但库存把整个索引标为 active、reclaimable=0。

不能按扩展名直接删除。安全清理必须在索引任务空闲时读取 manifest 快照，仅处理不在引用集合、非 mmap 占用且早于保护窗口的文件，并保留报告/可选回收快照。

### 6.6 P1：库存统计不能反映真实可回收量

`electron/storageInventory.ts` 存在三类口径问题：

1. `vector-jsonl` 固定报告 reclaimable=0，说明仍写“等待 GC 可用”，但 active-set GC 已经实现并能计算 5.48 GiB。
2. `media-vectors` 只枚举 `media-search` 根目录直属文件，真实向量和 manifest 位于子目录，因此本次错误报告为 0 B。
3. Image Search 索引不区分 manifest 引用和孤儿文件；用户数据下模型目录也未进入库存。

影响：维护 UI 会低估占用和可回收空间，用户无法根据现有界面做完整决策。

### 6.7 已可安全预览的空间

在不删除源素材的前提下，现有证据支持分批预览约 **9 GiB** 的潜在释放空间：

- 向量 stale/duplicate/malformed：约 5.48 GiB。
- 可重建 F32/F16/路径缓存：约 1.65 GiB。
- 超出日志预算的扫描日志：约 0.76 GiB。
- 旧素材库备份（保留最新）：约 0.58 GiB。
- 未引用 Image Search segment/staging：约 0.45 GiB。
- 可重建 Media Search 帧：约 0.23 GiB。

这些项目不能合并成一个“立即清空”操作。向量 GC、缓存删除、索引孤儿回收和备份删除必须分别预览、确认和验证。

## 7. 性能与数据处理效率

### 7.1 当前实测

| 场景 | 结果 | 判定 |
| --- | --- | --- |
| 18 万素材 catalog 构建 | 1.97 s | 良好 |
| 素材更新分页 | median 2.75 ms | 良好 |
| 素材路径查询 | median 31.64 ms | 可接受，仍可索引优化 |
| 18.7 万关系分类页 | p95 27.08 ms | 通过 <300 ms 目标 |
| 建议页 | p95 35.11 ms | 通过 <50 ms 目标 |
| 统计 | p95 55.71 ms | 通过 <100 ms 目标 |
| 聚类页 | p95 29.55 ms | 通过 <50 ms 目标 |
| 28.1 万 Native 索引加载 | 491.67 ms，RSS +84.13 MiB | 良好 |
| Native 搜索 | 约 0.03–0.54 ms/次 | 优秀 |
| Media manifest 100K 冷读 | 47–113 ms；热读 p95 <2 ms | 良好 |
| 20K×512 向量扫描微基准 | 约 1.28M vectors/s | 良好 |
| Vector GC 真实库预览 | 85.06 s / 12.58 GiB | 受权威 JSONL 体积约束 |

### 7.2 提速空间与优先级

1. **先治理数据，再改算法**：Native 和 SQLite 查询已经很快；清理 5.48 GiB stale/duplicate 会直接缩短后续 GC、迁移和备份扫描。
2. **任务队列改成有 epoch 的增量账本或 SQLite 表**：避免每次把 97 MB JSONL 和 23.6 万对象全部载入内存。当前可量化收益上限约 424 ms 和 341 MiB 峰值 RSS。
3. **完成权威二进制向量代际切换**：F16/F32 + path table + manifest/CURRENT 可把高维 JSON 文本解析改为顺序二进制读；预计显著降低磁盘和 GC 时间，但必须先做逐模型召回/数值误差门禁，不能直接删 JSONL。
4. **将高频同步文件 I/O 移出主进程热路径**：`electron/` 有 334 处同步 fs 调用。大部分是启动/维护/原子提交，但 `semanticSearchService.ts`、Media frame/index 和 IPC 文件处理应逐条用 profiling 确认是否阻塞 UI。
5. **路径查询增加规范化索引**：catalog 路径查询 median 31.64 ms 尚可；若大库继续增长，可增加规范化 path/parent 列或 FTS，而不是在 Renderer 增加缓存掩盖慢查询。

## 8. 安全审计

### 8.1 已确认的防护

- 主窗口和 GPU 子窗口均为 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 禁止新窗口和非当前地址顶层导航。
- IPC 只授权已登记 webContents、main frame 和受信 origin；所有 Renderer channel 必须有 capability 和 payload validator。
- Native 解码有文件、像素、维度和内存预算；专项测试通过。
- 文件管理、拖拽、远程传输和项目预览有路径、容量、超时和原子替换约束。
- 外部预览工具使用绝对 `.exe`、参数模板、`shell:false`、超时和输出大小限制。
- Remote Terminal profile 不持久化明文密码；设备凭据使用 Electron `safeStorage` 加密，临时文件后原子 rename。
- `npm audit` 生产树和完整树均为 0 vulnerabilities。
- 当前 116 个跟踪文本文件隐私扫描通过，Git 历史高置信度路径/秘密扫描通过。

### 8.2 P2 安全加固项

1. 主 Renderer CSP 的 `connect-src 'self' ws:` 允许任意 WebSocket scheme；开发态只需要受控 loopback，packaged 模式原则上可禁用 Renderer 网络连接。
2. 主 session 没有像 GPU partition 一样显式拒绝 permission request/check。当前 UI 没有浏览器权限需求，建议默认 deny 并为确有需要的权限建立 allowlist。
3. `trustedFrameUrl()` 接受任意 `file:` 和 loopback HTTP；正常导航守卫会阻止跳转，但 IPC 信任可进一步绑定当前应用文件 URL或已解析的 dev origin，减少未来改动产生的组合风险。
4. preload 有约 256 处 invoke 暴露，虽然 capability/validator 测试齐全，仍应继续按领域最小化返回字段，避免把绝对路径、诊断详情或大对象无必要送入 Renderer。
5. CSP 仍需要 `style-src 'unsafe-inline'`；当前大量 React inline style 使其难以移除。该项属于长期硬化，不应以大规模样式重写阻断近期数据修复。

## 9. 复用与可扩展性

### 9.1 可复用资产

- `secureIpcMain`、capability matrix 和 payload validator 可复用于所有新 IPC。
- `JsonLinesStore`、JSONL transaction、SQLite repository 和本地文件事务覆盖常见持久化模式。
- bounded scheduler、child process、worker、Native writer lease 和任务取消协议可复用于新批处理。
- Panel registry、Window System、i18n core 和共享 ElectronAPI contract 支持新增面板。
- User Model Platform 的 slot/profile/adapter 能容纳不同 ONNX 导出，而不把模型耦合进业务服务。
- Storage inventory、cleanup preview token、Vector GC snapshot 已形成统一维护框架。

### 9.2 扩展性限制

1. Image Search、Media Search、Subject Search 分别维护相似的模型准备、路径枚举、缓存和状态编排；应抽取“数据集快照 + 模型任务 + 进度/取消”的领域框架，而不是合并业务评分逻辑。
2. 新面板虽然可懒加载，但可见性 key 和 store 仍是联合类型/集中状态；插件式第三方面板尚不支持动态注册。
3. `fast_scanner.cc` 已改善 env/runtime 所有权，但编译单元仍过大；建议按 index storage、scan pipeline、N-API binding 拆分，保持 ABI 和测试不变。
4. `shared/ipc-contract.ts` 仍接近 900 行；继续按 domain contract 拆分，并用聚合导出保持 Renderer API 稳定。
5. i18n 静态门禁仍冻结 235 组历史可见文本；新增文本受控，但存量债务使语言完整性依赖 baseline 而非真正清零。

## 10. 优化影响矩阵

| 优先级 | 优化项 | 预期收益 | 对功能的影响 | 主要风险与保护 |
| --- | --- | --- | --- | --- |
| P1 | 修复三组模型集成测试前置条件 | 恢复完整 test/verify，证明用户模型路径 | 不改运行时功能 | 测试使用隔离 userData，不污染真实模型槽 |
| P1 | 恢复 `assetMetadataTransaction` 覆盖基线 | 关闭质量门禁回退 | 不改功能 | 重点补异常/回滚分支，不为数字写无意义断言 |
| P1 | 给 embedding jobs 增加 epoch/owner/heartbeat 并迁移 stale pending | 降低约 341 MiB 载入峰值和无效任务扫描 | 合法未完成任务仍应可恢复 | 先只读分类和导出清单，用户确认后迁移；不直接清空 |
| P1 | 执行 active-set Vector GC | 预计释放约 5.48 GiB，缩短维护扫描 | active 最新向量不变 | 保留 GC backup，校验 active-set 指纹和搜索抽样后再过期备份 |
| P1 | manifest-aware 索引孤儿回收 | 预计释放约 458 MiB | 当前 3 个引用 segment 不变 | 任务空闲、保护窗口、二次读取 manifest、禁止删除 mmap 引用 |
| P1 | 修复 storage inventory 递归和 GC 口径 | UI 展示真实容量和可回收量 | 只改变统计/维护入口 | 防止重复计数；用 fixture + 真实只读快照验证 |
| P1 发布 | 完成许可证、EULA、签名和 release record | 解除商业发布阻断 | 可能改变随包资源/profile | 必须由授权负责人决策，工程不能伪造批准 |
| P2 | 权威二进制向量 store 代际切换 | 显著降低 JSON 解析、磁盘和 GC 时间 | 搜索链路可无感切换 | 双写/校验、CURRENT 原子指针、召回和数值误差门禁 |
| P2 | 同步 fs 热点迁 worker/异步队列 | 降低主进程卡顿尾延迟 | UI 行为不变 | 保留事务顺序、取消和退出 drain 协议 |
| P2 | 拆分热点服务/组件 | 降低维护和回归范围 | 不应改变 UI/IPC | 先锁定契约测试，按状态所有权拆，不做纯搬文件重构 |
| P2 | 收紧 CSP、permission 和 IPC origin | 降低 Renderer 被利用后的横向能力 | 开发态 HMR/本地图片需保留 | packaged/dev 分配置，双语 smoke 和资源加载回归 |
| P2 | 资产 missing 状态复核 | 明确 7,731 条缺失是否合理 | 可能恢复移动文件映射 | 默认只读扫描，不自动删除元数据 |
| P3 | 清理 235 组 i18n baseline | 提升翻译完整性 | 文案可能变化 | 分面板迁移并运行双语/可访问性 smoke |

## 11. 推荐执行顺序

### 阶段 A：恢复可信验证

1. 修复 Face/ReID/SAM 测试的 Model Platform fixture。
2. 补 `assetMetadataTransaction.ts` 的真实异常路径测试，恢复 coverage gate。
3. 重新运行 `npm.cmd run verify`；失败即停，不进入数据写入阶段。

### 阶段 B：只读数据治理设计

1. 修复 storage inventory 的递归、GC、索引孤儿和模型目录口径。
2. 为 pending jobs 建立 epoch/owner/heartbeat 分类器，只输出预览报告。
3. 将 Vector GC、索引孤儿、缓存、日志和备份分成独立确认项。

### 阶段 C：分批安全回收

1. 先清低风险日志、缩略图和可重建缓存。
2. 再执行 manifest-aware 索引孤儿回收。
3. 最后执行 Vector GC；完成后复跑向量搜索、NekoSearch、磁盘清单和真实抽样。
4. 任何阶段不得未经确认清空 `userData`、素材恢复快照或最新备份。

### 阶段 D：性能和结构演进

1. 完成权威二进制向量 store 的双读/双写/切换门禁。
2. 根据 profiling 迁移主进程同步 I/O 热点。
3. 按状态所有权拆分 Image Search、Semantic Search、Asset DB 和 Native 编译单元。

### 阶段 E：发布闭环

1. 完成人工准确率数据集和门禁。
2. 由授权负责人完成项目许可证、EULA 和第三方组件决定。
3. 完成签名、时间戳、packaged 双语 smoke、正式 release record 和远端/离线灾备。

## 12. 验证记录

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 工具链 | `npm.cmd run toolchain:check` | 通过：Node 24.16.0、npm 11.13.0 |
| 类型 | `npm.cmd run typecheck` | 通过 |
| Lint | `npm.cmd run lint` | 通过 |
| 格式 | `npm.cmd run format:check` | 通过 |
| 构建 | `npm.cmd run build:renderer` | 通过；Renderer、main、preload 和 workers 均生成 |
| 完整测试 | `npm.cmd test` | 失败：Face Model Platform 前置条件失真；标准链提前停止 |
| 补充模型测试 | `test:person-reid`、`test:subject-crop` | 失败：ReID/SAM 同源前置条件失真 |
| Data Editor | `npm.cmd run test:image-search-data-folders` | 审计基线 44/44；专项整改后 50/50 通过 |
| Native | `npm.cmd run test:native` | 59/59 通过；使用现有产物 |
| Project Preview | `npm.cmd run test:project-preview` | 15/15 通过 |
| 双语 UI | `npm.cmd run smoke:ui:locales` | 通过：中文、英文均通过 |
| 关键覆盖率 | `npm.cmd run coverage:critical` | 77/77 测试通过；门禁失败：83.13% < 84% |
| 依赖安全 | `npm.cmd audit --omit=dev`、`npm.cmd audit` | 均为 0 vulnerabilities |
| 隐私 | `npm.cmd run privacy:check` | 116 个跟踪文本文件通过 |
| Git 历史隐私 | `npm.cmd run git:history-audit` | 通过 |
| 许可证清单 | `npm.cmd run licenses:check` | 10 个组件清单一致 |
| 许可证门禁 | `npm.cmd run licenses:gate` | 失败：项目批准/EULA/证据及 5 个 offline 随包组件未批准 |
| Runtime manifest | `npm.cmd run verify:runtime-resources` | 10 个组件、32 个 artifact 通过 |
| Vector GC 预览 | `npm.cmd run preview:vector-gc` | 通过；发现约 5.48 GiB 可回收和 3 条 malformed |
| 素材性能 | `benchmark:asset-catalog`、`benchmark:asset-relation` | 通过目标 |
| Native 性能 | `npm.cmd run benchmark:native` | 通过；28.1 万索引加载约 492 ms |
| Media 性能 | manifest/vector benchmark | 通过目标 |

## 13. 剩余未验证边界

- 未重新构建 Node/Electron 双 ABI Native 产物。
- 未运行完整 `npm.cmd run verify` 到结束，因为已确认测试和覆盖率门禁失败。
- 未运行安装包构建、签名、packaged smoke 或真实安装/升级/卸载。
- 未执行任何真实 Vector GC、缓存清理、索引孤儿删除或任务迁移。
- 未在真实 PxHere 向量 shard 上执行文件夹索引删除；只完成只读匹配预览。
- 未重跑 NekoSearch 多分类人工准确率门禁；`ACC-02` 仍按既有决定暂缓。
- 未对第三方模型/FFmpeg 作法律结论；本报告不是法律意见。

## 14. 审计结论

项目的主要查询和交互链路已经从“能运行”进入“有测试、有边界、有性能基线”的阶段，Native 搜索、素材库查询、双语 UI、IPC 安全和事务恢复是当前最可靠的部分。下一阶段最有价值的工作不是继续堆功能，也不是先做大规模重构，而是恢复完整验证、纠正库存口径、治理真实向量/任务/索引数据，并在此基础上完成权威二进制向量代际切换。

在 P1 数据与验证问题关闭前，任何“性能已最优”“数据完全健康”或“可以正式发布”的表述都不成立。

## 15. 审计后专项整改：指定文件夹多层索引编辑

用户反馈 Data Editor 只能处理 Native 索引，无法对指定文件夹同步维护 DINO/CLIP。当前实现已
新增 Native/Hash、DINO、CLIP 三层可选的“分析 → 二次确认 → 执行 → 进度/取消”工作流；详细
使用和恢复边界见[指定文件夹多层索引编辑](../current/2026-08-02-image-search-folder-index-editor.md)。

核心安全控制包括：精确子树路径边界、15 分钟一次性预览令牌、shard 大小/mtime 指纹复核、
预计新文件加 64 MiB 的磁盘预检、同目录临时文件与原子 rename、7 天恢复备份、重写阶段取消
回滚、派生 DINO/CLIP 缓存失效，以及与扫描、搜索、embedding、GC、迁移和清理任务互斥。源图
片不参与写入或删除。DINO/CLIP 仍不允许逐个手改浮点值；正确维护方式是按文件夹删除后重建。

对截图指定的 `<PXHERE_IMAGES>` 做了真实只读预览：

| 层 | 唯一图片 | 物理行 | 命中字节 | 权威 shard 字节 |
| --- | ---: | ---: | ---: | ---: |
| DINO | 57,953 | 57,953 | 953,788,813 | 8,045,586,193 |
| CLIP | 57,953 | 57,953 | 642,131,156 | 5,460,308,954 |

DINO/CLIP 两层完全对齐；与截图 Native 57,963 条相比各少 10 条，说明该时点存在 10 条
Native-only 记录，但仅凭聚合数据不能区分尚未构建、构建失败或采样时点差。预览读取约
12.58 GiB，耗时 32.501 秒；若执行，预计需要约 11.09 GiB 临时空间。该结果同时证明当前
性能瓶颈主要是全局 JSONL 的顺序 I/O；只有完成权威二进制向量与独立 path table 迁移，才能
避免文件夹删除重写整个 shard。

专项验证：Data Editor 50/50、Vector Pipeline 53/53、i18n static 5/5、preload 2/2、IPC
registration 7/7、IPC validation 4/4、guards 24/24、typecheck、format 和生产构建均通过。
真实用户 shard 没有执行删除，因此恢复备份与大文件提交路径仍需首次人工执行时核对结果。
