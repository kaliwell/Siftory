# 来源文件同步：失败恢复与安全边界整改记录

> 状态：当前  
> 实施状态：历史来源同步限定范围已有自动回归；2026-09-25 Native 0.5.38 完整集成门禁与内部 Online 目录包资源检查通过；整合式 `release:gate` 和真实 Electron 强退/掉盘验收仍未完成  
> 建立日期：2026-08-30；更新日期：2026-09-25；SFR-011 历史来源同步限定范围已通过集成 `verify`，新发现路径结果见文末；商业发布 `release:gate` 与真实 Electron 矩阵尚未完成
> 范围：来源失效同步、Native 图片索引、DINO/CLIP 向量、视频检索、缩略图缓存、素材库联动、IPC 互斥和故障恢复  
> 数据边界：自动测试只使用临时夹具、临时缓存和索引副本；本轮不得删除、移动或改写用户原始图片、视频及现有索引。

## 目标与不变语义

本轮针对“正常路径可以运行，但失败恢复、并发和安全边界覆盖不足”的审计结论进行整改。功能语义保持不变：只同步已经从磁盘消失的源文件所产生的派生数据，绝不删除原始素材；来源离线、权限不足、探测超时或身份不确定时必须失败关闭。

状态口径：

- **已实现并有阶段验证**：实现和至少一组相关测试已经通过，但仍需以最后一次合并后的总回归为发布依据。
- **已实现，待最终回归**：实现与用例已落地，当前文档不把尚未执行的最终命令写成“通过”。
- **部分完成**：主要风险已降低，仍存在明确、可复现或尚未封闭的残余边界。

## 整改状态

| ID | 当前状态 | 整改结果与证据 | 发布前仍需确认 |
| --- | --- | --- | --- |
| SFR-001 | **已完成自动回归** | 预览记录来源根目录的规范路径与身份；确认后在维护屏障前后、durable intent 写入后再次校验在线状态、`realpath`、设备/文件身份和 reparse 边界。只有稳定来源中的 `ENOENT`/`ENOTDIR` 才视为 missing。合并后 source/outbox/Asset 组合套件 55/55 通过。 | 真实掉盘与换根仍需在隔离副本进行 Electron 人工验收。 |
| SFR-002 | **已完成自动回归** | Native 以检查后的临时文件、原子替换和目录同步提交 overlay/manifest；混合 replaced/deleted overlay 的第二阶段替换失败不会发布新 manifest。最终 Native 专项 82/82 通过，覆盖 overlay replace fault。 | Windows symlink 子检查在无创建权限时可能记录 `EPERM`；发布环境仍需专项复核。 |
| SFR-003 | **已完成自动回归** | schema v2、`segments: []` 的合法空 manifest 可在新 worker 中同步和异步加载，并清空内存视图；截断/畸形 manifest 继续拒绝。runtime 22/22 通过；Node 与 Electron Native 产物版本、大小和哈希一致。 | 正式构建已重新生成 Electron ABI 产物并通过打包资源校验。 |
| SFR-004 | **已完成自动验收** | Native 删除前原子写入向量失效 outbox；v2 intent 绑定已加载索引的 canonical root、realpath、dev/ino。启动、保存、手工 manifest 加载与修复加载均执行对账；切换前先结清当前根 active intent，切换后以前后身份快照校验并对账新根。其他根及旧 v1 intent 保持 deferred，绝不探测错误 Native 实例。active 失败采用单定时器、每会话六次有限退避。 | 旧 v1 未绑定 intent 只能显式审计/丢弃，不会静默绑定。 |
| SFR-005 | **已完成自动回归** | embedding append 与 tombstone 共用串行 append-chain，`flushVectorDatabaseWrites()` 会反复观察链身份，直至等待所有已接受写入；GC 原子切换前复核大小、边界哈希与身份，并与 append 串行。向量/来源目录组合套件 66/66 通过。 | 同步快照和大结果集回传仍按残余风险继续治理。 |
| SFR-006 | **已完成自动回归** | legacy embeddings/jobs/crops/features 使用 Windows 大小写与斜杠归一后的路径键清理；即使当前 shard 不存在，也创建 tombstone-only shard，使新 tombstone 压过旧数据。部分 chunk 成功时保留真实计数，允许幂等重试。向量/来源目录组合套件 66/66 通过。 | 大规模真实索引迁移仍只允许在副本上验证。 |
| SFR-007 | **已完成自动回归** | 视频 manifest 明确标记为 `missing` 的 video ID 会从可用帧 manifest、帧详情、相似/文本/多模态检索和列表统计中排除；未标记 missing 的旧版记录保持兼容。磁盘上的帧、缩略图和语义派生文件不会因此删除。媒体/视频套件 57/57 通过。 | 深层语义恢复与字幕召回仍需随真实 Electron 人工验收抽查。 |
| SFR-008 | **已完成自动验收** | `ok:false` 的部分提交仍返回 Native、catalog、向量、缩略图和素材库真实计数，并标记 `partialCommit`。来源同步在图片索引修改前原子写入 Asset Library 补偿标记，终态成功才清除；运行期失败和重启均以有限指数退避续跑。资产移动修复另有 v2 durable journal，逐阶段记录 identity、Asset Library、catalog、Native、Vector、clear 与 rebuild，并支持重启续跑、超时、取消和 sender-scoped 原子 claim。 | SHA-256 是完整性校验而非抵御已获得本机 userData 写权限攻击者的 MAC。 |
| SFR-009 | **已完成自动回归** | 缩略图缓存根目录在预览和删除时分别校验 `lstat`、`realpath`、根身份和边界；候选删除前再次检查，拒绝符号链接、联接点或越过用户数据目录的目标。Native manifest/segment/overlay 也拒绝绝对路径、父级穿越和 reparse escape。图片/IPC/edit/shutdown 套件 66/66 通过。 | 在允许创建 symlink/junction 的 Windows 专项环境复核链接边界。 |
| SFR-010 | **已完成自动回归** | 新的向量维护协调器区分搜索 reader、普通 mutation 与独占维护；来源同步持有独占预留，图片、视频、主体、统一搜索和 AI Control 搜索持有 reader。扫描、Embedding、ANN build、GC、迁移、素材库重建及来源清理均增加双向忙碌检查；提交 epoch 改变后丢弃旧搜索结果。Asset Library/统一搜索/产品/缩略图组合套件 85/85 通过。 | 真实 Electron 多窗口高并发仍需隔离副本人工验收。 |
| SFR-011 | **历史来源同步限定范围通过；新发现路径完整门禁通过，整体仍部分完成** | Native 0.5.36 后台捕获一致快照，最多 2 个导出游标；每页最多 256 条且路径载荷预算 256 KiB，单导出最多 1,000,000 条/128 MiB 预算；删除保留单次原子提交并分页返回结果。服务在页间让出事件循环并在取消/失败时释放游标。12 万条临时索引三轮快照最大事件循环间隔从 302～409 ms 降至 16.01～16.71 ms。最终集成 `verify` 为 2,125 项、2,111 通过、14 跳过、0 失败，包含 Native 87/87。 | 商业发布 `release:gate` 和 Electron 实机矩阵仍未完成；4 万删除输入的主线程复制仍为 13.74～19.44 ms。2026-09-25 扫描发现路径已改后台快照并通过 89 项专项及 2,200 项全量门禁；上层完整数组、全链路流式化及正式发布验收未完成，见文末。 |
| SFR-012 | **已完成自动回归** | 预览计划有数量/保留上限，只保留最新的大计划；每文件探测有界超时，超时与权限错误归为 inaccessible，不归为 missing；取消在提交边界前结束且不修改索引。执行中的幂等 token 不再因 TTL 被提前清理，TTL 从终态开始计算。source/outbox/Asset 组合套件 55/55 通过。 | 真实长时掉盘、取消和重启恢复仍需隔离副本人工验收。 |
| SFR-013 | **自动回归与构建验证完成，release gate 待执行** | 2026-08-31 合并后 TypeScript、架构、Native、runtime、source/outbox/Asset、图片、媒体、向量/目录、Asset Library/统一搜索回归通过；`npm.cmd run build` exit 0 并生成 NSIS installer。installer archive smoke 通过（249 files）；临时 `--dir` 解包资源校验通过（26/26 required、175 packaged files、0 missing/forbidden/sensitive）；`licenses:check` 通过，项目根与 website 的四项 npm audit 均为 0。`clean-release.cjs` 按设计删除 `.blockmap` 与 `win-unpacked`，仅保留 installer。 | 尚需在干净、可追踪且已完成法律/签名配置的发布源上执行 `npm.cmd run release:gate`；真实 Electron 人工验收仍待执行。 |

## 提交与恢复顺序

来源同步的安全顺序如下：

1. 预览阶段只读枚举 Native 图片、视频和 catalog，记录来源根身份；离线或不确定来源不生成可确认计划。
2. 确认阶段检查 token、计划新鲜度和全局维护状态，获取向量独占维护预留。
3. 在任何派生数据写入前执行维护屏障并重新验证来源根；逐文件探测只接受明确 missing。
4. 为将被删除的 Native 记录预写向量失效 outbox，并在预写后再次验证来源根。
5. catalog 记录标记 missing，然后提交 Native 删除；已经发生的部分提交始终写入结果计数。
6. 追加 DINO/CLIP tombstone、过滤 missing 视频、清理缩略图，并等待素材库补偿任务终态。
7. 成功时完成/移除 outbox intent；失败或 Native 真值未知时保留 intent，供启动或显式重试对账。
8. 在首次派生数据写入前推进 mutation epoch，使旧 epoch 搜索结果失效；流程结束后在 `finally` 中释放维护预留。

catalog 联动只处理本地文件型来源，按精确绝对路径在单个 SQLite 事务中将文件和非 discovery 索引阶段标为 stale/missing；NAS/SFTP 不由这条本地来源同步路径改写。

## 强制不变量

1. `originalFilesAffected` 永远为 `0`；实现和测试不得调用源素材的删除、移动或覆盖操作。
2. 只有 `ENOENT`/`ENOTDIR` 且来源根目录身份稳定时，记录才能判定为已删除；超时、权限错误、盘符掉线和未知错误一律保留。
3. Native、向量、视频、缩略图、catalog 和素材库允许暂时不一致并重试，但不得把已提交删除伪装成零修改，也不得让旧数据重新进入搜索。
4. 同一确认 token 保持幂等；不同维护任务在同一索引域内互斥，活动 reader 会阻止独占维护，活动维护会拒绝新 reader。
5. 所有自动验证只操作临时目录或生成物副本；用户原索引和 `D:\PxHereDataset\images` 等源素材目录不作为破坏性测试目标。

## 已记录的阶段验收

以下结果来自本轮较早完成的阶段检查，已经由后述 2026-08-31 合并后回归覆盖。它们仅保留为历史证据，不作为最终发布构建结论。

| 命令/检查 | 已记录结果 | 说明 |
| --- | --- | --- |
| `npm.cmd run test:native` | **82/82 通过** | 覆盖 Native scan/decode/hash/log/segment/search/fuzz；包含异步批量删除 writer lease、pre-commit fault、overlay replace fault、空 manifest 和路径逃逸。 |
| `npm.cmd run test:runtime-manifest` | **22/22 通过**，manifest validator 通过 | 覆盖 runtime manifest、资源获取与 CUDA runtime installer。 |
| `node --test tests/media-search-fixed-samples.test.cjs tests/media-search-guards.test.cjs tests/image-search-data-folders.test.cjs` | **77/77 通过** | 已在视频 missing 过滤和 Native 删除选择修正后复跑。日志中的隔离 mock fallback 警告不影响结论。 |
| `node --test --test-name-pattern="service bulk source deletion prefers async Native and preserves sync and legacy fallbacks" tests/image-search-data-folders.test.cjs` | **目标用例 1/1 通过** | 验证优先异步 Native，并保留受限同步/legacy 回退。 |
| `node --test tests/source-file-sync.test.cjs` | 阶段检查点 **13/13 通过** | 此后又加入 catalog、维护屏障等用例，当前文件已变化；必须用最终文件重新执行，不能沿用 13/13 作为最终数字。 |
| `npm.cmd run typecheck` | 阶段检查点通过 | 此后视频/媒体和测试仍有合并，发布前必须重跑。 |
| 三个 Native 构建产物 SHA-256 | 一致 | 见下一节；哈希由当前文件重新读取确认。 |

阶段性媒体/图片组合回归中的 **77/77** 是独立的一次执行；不要与 Native **82/82**、runtime **22/22** 或旧 source-sync **13/13** 相加后宣称为“全项目测试数”。

## 2026-08-31 合并后自动回归与独立构建验证

下列数字分别属于独立命令或组合套件，不相加作为“全项目测试数”。所有自动测试仅使用临时夹具、临时缓存和生成物副本，没有操作真实图片、视频或用户正式索引。

| 检查域 | 最终结果 | 关键证据 |
| --- | --- | --- |
| TypeScript | **通过** | `npm.cmd run typecheck` exit 0；renderer 与 Node 两套 `tsc --noEmit` 均通过。 |
| 架构 | **通过** | 扫描 486 modules，0 cross-layer imports；`main=300/300`、`preload=23`、`renderer=157`，`shared/**` 无环。 |
| Native | **82/82 通过** | scan/decode/hash/log/segment/search/fuzz 均通过；无失败。一个 symlink 子检查在当前 Windows 权限下记录 `EPERM` 信息，不能替代有创建权限环境的专项复核。 |
| runtime manifest | **22/22 通过** | manifest validator、资源获取和 CUDA runtime installer 均通过。 |
| source/outbox/Asset | **55/55 通过** | 覆盖来源身份、维护屏障、outbox v2、手工切根、有限重试和 Asset durable recovery。 |
| 图片/IPC/edit/shutdown | **66/66 通过** | 覆盖图片来源同步、编辑持久化、IPC 与关闭恢复。 |
| 媒体/视频 | **57/57 通过** | 覆盖 missing 过滤、帧/语义状态与媒体检索。 |
| 向量/来源目录 | **66/66 通过** | 覆盖 append/tombstone、GC、目录与来源 catalog。 |
| Asset Library/统一搜索/产品/缩略图 | **85/85 通过** | 覆盖素材库、资产身份、统一搜索、产品增量与缩略图联动。 |
| i18n 静态检查 | **7/7 通过** | 无新增可见硬编码文本；基线为空。 |

独立发布构建与产物检查：

| 检查 | 结果 |
| --- | --- |
| `npm.cmd run build` | **exit 0**；renderer/Electron/worker、性能预算、TypeScript、Electron ABI Native 重建和 online 资源校验均通过，NSIS installer 生成成功。 |
| installer archive smoke | **通过**；归档含 249 files，检测到 NSIS executable tail。 |
| 临时 `--dir` 解包资源校验 | **通过**；26/26 required，175 packaged files，0 missing、0 legacy duplicates、0 forbidden、0 sensitive，manifest/model manifest 均无问题。 |
| 发布清理 | `clean-release.cjs` 按策略移除 `.blockmap`、`builder-debug.yml` 与 `win-unpacked`，仅保留 installer；这是成功构建后的预期结果。 |
| 最终安装包 | 2026-08-31 21:05 最新重建：`release/Siftory Online Setup 1.0.0.exe`；177,405,169 bytes（169.19 MiB）；SHA-256 `9D0F2E6848E58D6FA058D7199A4D64646FEB77B54330F06D26B23101556BBF77`。 |
| 许可证清单 | `npm.cmd run licenses:check` **通过**；21 个运行时组件和 Node 生产依赖清单均为最新。 |
| 依赖审计 | 项目根与 `website/` 分别执行全量及 `--omit=dev --audit-level=high`，四项结果均为 **0 vulnerabilities**。 |

上述安装包已通过内部自动化结构验证，但当前未签名，不能等同于已经通过商业发布门禁的正式分发版本。

### Native 0.5.35 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `native/build/Release/fast_scanner.node` | 1,243,648 bytes | `a3fc85704c3d174c3b364fe599638a0105935d8b22fb1a0aafa565ce282dc73a` |
| `native/build-node/Release/fast_scanner.node` | 1,243,648 bytes | `a3fc85704c3d174c3b364fe599638a0105935d8b22fb1a0aafa565ce282dc73a` |
| `native/build-electron/Release/fast_scanner.node` | 1,243,648 bytes | `a3fc85704c3d174c3b364fe599638a0105935d8b22fb1a0aafa565ce282dc73a` |

`resources/runtime-manifest.json` 中的 Electron Native 组件版本为 **0.5.35**，目标大小和 SHA-256 与上表一致。

### 异步删除阶段基准

临时基准使用 266,372 条 Native 索引、删除 40,997 条路径，三轮结果如下：

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | ---: | ---: | ---: |
| 总耗时 | 541.9 ms | 655.0 ms | 612.0 ms |
| 主线程入队耗时 | 17.5 ms | 9.8 ms | 11.5 ms |
| 最大事件循环间隔 | 24.3 ms | 30.6 ms | 24.4 ms |

旧同步路径在相近样本中约阻塞 692 ms。该结果证明异步删除降低主线程连续阻塞，但它不是固定硬件三轮发布基线，也没有关闭同步快照和大结果集转换的残余风险。

## 已知残余风险

1. **快照边界已细化（2026-09-24）**：来源同步、数据目录构建、清理预览和 ANN 范围枚举已改为后台一致快照及有界页面。`snapshotIndexRecords()` 仍作为 Native 兼容/诊断接口保留；`sourceAdapter.ts` 的扫描发现轮询仍使用同步快照，但本次后续修复将交付批次限制为 256 条并在页间让出事件循环。同步快照及整次扫描去重表仍为 O(N)，尚未实现扫描中的异步增量捕获。
2. **大结果集回传已治理（2026-09-24）**：来源同步优先使用分页删除结果，单次完成回调仅返回游标和计数；页面读取失败保留已提交删除计数及 outbox。大量输入路径的 JS→Native 复制、上层整库 JS 结果保留和后续 catalog worker 的完整传输仍不属于流式事务，不能声称整个应用常量内存。
3. **受限 legacy 路径**：旧 addon 在 64 条以内仍可能同步删除；超过 64 条会安全失败而不是自动完成。用户必须更新 Native 组件后再执行大批量同步。
4. **outbox 容量**：最多 32 个 intent、250,000 个 entry、64 MiB；单路径最多 32 KiB，每 entry 最多 4 个向量路径。容量耗尽时维护会失败关闭，需要先完成对账，不能绕过上限。
5. **本机写权限与 journal 回滚**：Asset repair journal 已升级 v3：HMAC-SHA256 密钥认证（safeStorage/DPAPI 保护的每安装密钥）、单调 generation 与独立防伪 anchor，可识别篡改与单文件回滚；合法 v2 journal 一次性迁移。残余边界：攻击者一致回滚 journal+anchor 全部文件仍不可检测（需要 OS 级 anchor）；旧 v1 journal 继续失败关闭。见 [2026-09-01 数据安全加固](2026-09-01-data-security-hardening.md)。
6. **Windows 链接测试权限**：Native junction 边界已有通过记录；symlink 用例在无创建权限的环境可能以 `EPERM` 跳过。发布机需要有能力创建链接的专项环境。
7. **有限自动重试**：active outbox 和 Asset Library 启动恢复每会话只执行有限次数指数退避；长期占用或永久错误不会形成紧循环，但可能需要重启应用或在维护界面显式重试。旧 v1 未绑定 outbox intent 永久 deferred，必须人工审计后显式丢弃。
8. **架构预算已压线**：`imageSearchService.ts` 为 1,696 行，main reachability 为 300/300。当前门禁通过但没有余量；后续新增主进程依赖必须先拆分或合并，不能抬高预算。
9. **真实 Electron/断电恢复**：尚未把真实窗口交互、强制终止进程、磁盘突然离线和应用重启组成端到端发布门禁。现有自动测试不能替代这组人工/隔离环境验证。
10. **商业发布门禁仍被阻塞**：`licenses:gate --profile=online` 已执行并因项目许可证/EULA、审批元数据、Native 项目许可及 Source Han Sans 审批证据不完整而失败。`release:readiness --profile=online --json` 为 0 passed、8 blocked：法律审批、干净可追踪发布源（当前 828 changed paths）、`v1.0.0` tag、生产签名命令、可比较的 Neko 基线、与当前 commit 绑定的 packaged matrix、最终隐私政策、最终安全/更新/支持政策均未闭环。当前 installer 未配置 Authenticode 签名，只能作为内部测试构建。

## 最终验收清单

已勾选项均有 2026-08-31 实际输出；未勾选项是商业发布或真实环境的明确阻塞项：

- [x] `npm.cmd run typecheck`：exit 0。
- [x] source/outbox/Asset 合并后组合套件：55/55。
- [x] 向量/来源目录组合套件：66/66。
- [x] 媒体/视频组合套件：57/57。
- [x] Asset Library/统一搜索/产品/缩略图组合套件：85/85。
- [x] 图片/IPC/edit/shutdown 组合套件：66/66。
- [x] `npm.cmd run test:native`：82/82。
- [x] `npm.cmd run test:runtime-manifest`：22/22。
- [x] `npm.cmd run test:architecture`：486 modules，main 300/300，0 cross-layer imports。
- [x] `npm.cmd run test:i18n-static`：7/7。
- [x] `npm.cmd run docs:check`：current metadata、H1 structure 与 relative links 均通过。
- [x] `npm.cmd run licenses:check`：21 个组件与 Node 生产依赖清单均为最新。
- [x] 项目根与 `website/` 四项 npm audit：均为 0 vulnerabilities。
- [x] `npm.cmd run build`：exit 0，NSIS installer 已生成。
- [x] installer archive smoke：249 files。
- [x] 临时 `--dir` packaged resources：26/26 required，175 packaged files，0 missing/forbidden/sensitive。
- [ ] `npm.cmd run licenses:gate -- --profile=online`：已执行但被法律与审批材料阻塞，exit 1。
- [ ] `npm.cmd run release:readiness -- --profile=online --json`：0 passed、8 blocked。
- [ ] `npm.cmd run release:gate -- --profile=online`：仅完成只读 plan；在上述阻塞项、干净提交和签名配置完成前不执行会重装依赖/重打包/签名的整合门禁。
- [ ] 在隔离数据副本上进行真实 Electron 验收：掉线、取消、重复确认、搜索并发、强制退出/重启对账；确认原始素材和用户正式索引未被测试修改。

最终补录格式：记录日期、完整命令、通过/失败/跳过数量、构建产物路径；若失败，写明是否为本轮回归、既有架构债务或环境限制。不得用阶段检查点结果替代最终输出。

## 2026-09-24 SFR-011 独立工作树执行记录

执行身份为 **Codex / GPT-6 系列（精确版本未知）**；所有者 `Codex/source_sync_async`，分支 `task/copyright-20260924-source-sync`。外部运行时代理状态未知。依据 `docs/README.md`、身份规范和 Git 规则，在仓库外独立工作树修改；只使用本轮开始前 `source-before` 源码副本对比，不暂存或提交此前现场改动。

### 实现与安全边界

- 新增 `snapshotIndexRecordsAsync`、`readIndexExportPage`、`closeIndexExport` 和 `deleteIndexPathsPagedAsync`。快照持 Native writer lease 在后台读取一致视图，完成后释放 lease；之后索引改变不会改变已有游标。游标仅属于创建它的 Node 环境。
- 同一环境最多两个游标，含正在后台释放的游标。每次快照最多扫描 1,000,000 条物理记录，并以 128 MiB 预算限制记录、路径和临时去重数据；删除输入/导出路径也有 128 MiB 上限。超限在提交前失败关闭。每页最多 256 条，路径数据加每条保守开销预算为 256 KiB。游标内存后台释放，环境退出也会清理未消费游标。
- 来源同步、数据目录构建、清理缩略图来源与 ANN 候选范围枚举等待后台快照，并在页面之间执行 `setImmediate`。目录构建取消在页边界观察，`finally` 关闭游标；Native 后台工作沿用环境关闭的协作取消机制。未提供单任务 Native 取消令牌；刚开始捕获时的 UI 取消需等待捕获返回后关闭，期间主线程保持可调度。
- 批量删除仍使用一次预分配计划与原子内存提交，未改为分批提交。结果页面失败后返回真实 `removedCount`，不继续向量清理，不丢弃 durable intent；调用方按已有机制退休旧搜索快照，后续由持久化及对账流程恢复。原素材没有删除、移动或覆盖操作。
- 旧 Native 不具备分页导出时，快照或删除超过 256 条安全拒绝；逐条旧版删除仍保持 64 条上限。全部游标被占用时新删除在修改前拒绝，不绕过限额。
- `snapshotIndexRecords()` 同步兼容/诊断入口继续保留；`sourceAdapter.ts` 的扫描发现轮询仍使用该入口。上层完整 JS 数组和 catalog worker 整体传输仍存在，因此本项完成仅覆盖上述来源同步及相关消费路径，不代表整个应用已实现流式常量内存。

### 本轮实际验证

所有命令均运行于 `source-sync` 独立工作树，Node **24.16.0**、npm **11.13.0**（显式 `npm_config_prefix=C:/Program Files/nodejs`）、MSVC **18.6.11806.211**。共享 `node_modules` 仅用于读取工具链，未修改依赖或真实用户数据。

- `npm.cmd run build:native`：Node ABI Native 0.5.36 构建通过。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run test:architecture`：通过；架构扫描 488 modules，无跨层导入。
- `node --test tests/image-search-data-folders.test.cjs tests/image-search-data-overview.test.cjs tests/rerank-cascade.test.cjs tests/source-file-sync.test.cjs tests/source-vector-invalidation-outbox.test.cjs`：**102/102 通过**。
- `npm.cmd run test:native`：**87/87 通过**；覆盖快照隔离、mmap/overlay 一致性、按条数与字节分页、预提交故障、原素材不变、删除结果持久化、游标配额和环境清理。已有 symlink 子检查在本机仍记录 `EPERM`，不替代可创建符号链接环境验收。
- `npm.cmd run docs:check`：独立纯源码副本因未复制被忽略的历史 benchmark artifacts 而报告 13 个既有缺失链接；本轮 SFR 文档没有新增失效链接。根集成已将旧链接改为明确本地产物的路径记录并通过文档检查，原历史数据仍在原工作区；未使用空占位文件伪造通过。
- `node tests/native-index-export-benchmark.cjs`：在系统临时目录生成 120,000 条 v2 索引，三轮各删除 40,000 条。退出前关闭游标、卸载索引、删除临时夹具；未读取真实素材或用户库。

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | ---: | ---: | ---: |
| 同步快照总耗时/最大事件循环间隔（ms） | 302.26 / 302.49 | 375.04 / 375.14 | 409.07 / 409.22 |
| 异步分页快照总耗时/最大事件循环间隔（ms） | 321.23 / 16.01 | 413.22 / 16.03 | 413.38 / 16.71 |
| 快照入队/最慢单页（ms，469 页） | 0.42 / 1.81 | 0.08 / 4.29 | 0.04 / 2.43 |
| 分页删除总耗时/最大事件循环间隔（ms） | 346.74 / 19.61 | 433.69 / 16.57 | 426.21 / 16.67 |
| 删除入队/最慢单页（ms，157 页） | 19.44 / 0.09 | 13.74 / 0.05 | 14.67 / 0.31 |

该实验衡量临时生成索引的主线程响应；总耗时不保证下降，不能替代固定硬件两小时负载、真实 Electron 多窗口、掉盘/强退以及发布矩阵。最终 `resources/runtime-manifest.json` 的 Native 版本/大小/SHA-256 必须由集成工作树的 Electron 构建统一生成，本文未把 Node 构建哈希冒充正式分发资源证据。

## 2026-09-24 扫描发现错误传播与取消所有权后续修复

执行身份为 **Codex / GPT-6 系列（精确版本未知）**；所有者 `Codex/source_sync_async`，分支 `fix/source-adapter-error-propagation`，工作树 `source-adapter-followup`。以当前原项目的 1,385 个源码文件及独立 SHA-256 基线为准，不沿用较早工作树作为权威；不暂存既有改动，不修改原项目、冻结交付包、共享依赖或真实用户库。

### 修复范围

- 来源发现不再把失败的 Native 快照、失败或不完整的分页查询、错误扫描状态伪装为空结果成功。记录格式、分页偏移、数量和前进性均校验；错误经 `SCAN_FAILED` 交给已有目录服务，使任务记录失败并保留此前成功时间，不撤销已提交的有效目录记录。
- 每次交付最多 256 条记录，每页后执行 `setImmediate`，包括全部被过滤或去重的页面；保留路径去重和文件大小/修改时间变化后的再次交付。这里的限制为记录条数，不宣称单批固定字节上限。只有同代、未取消的扫描处于 `idle` 且所有页面处理完毕，才发送成功终态。
- Native **0.5.37** 的启动结果和进度包含单调递增的 `generation`，新增 `stopScanGenerationAsync(generation)`。代际检查和停止预约在同一生命周期锁内完成，旧代清理不会停止新扫描；旧无参停止 API 保持兼容。缺少新 API 的 Native 在启动前安全拒绝，要求更新组件。
- 生成器失败、取消、消费者 `return` 或 `throw` 后等待本代扫描清理；页间检测被新扫描替换。并发异步停止合并到一个后台 join，后续调用不会在主线程等待 join 所持的锁。启动前的停止标记不再被工作线程覆盖。
- Native 进度保存本代取消标记；外部服务通过旧 API 停止扫描也不会被目录服务写成成功。停止操作保留已发生的 Native 错误，下一代扫描启动才清理旧错误。新增故障/延迟钩子仅在测试显式设置对应环境标志时启用。

### 已有复现与专项验证

- 修复前新增失败复现测试 **8/8 失败**；新增 Native 所有权契约测试 **2/2 失败**，分别保存原始日志，未把失败隐藏或改写为通过。
- `node --test tests/source-adapter-contract.test.cjs`：**31/31 通过**，包含临时 PNG、临时 SQLite、快照/分页失败、外部取消、旧代退出、消费者中断、等待清理、部分记录保留及 256 条交付上限。
- Native 四项新增专项：**4/4 通过**，覆盖旧代停止与新代隔离、参数边界、真实重叠的多个停止请求和事件循环心跳、真实 Native 错误经旧停止 API 后仍保留。重叠测试等待后台 join 活动后再调用后续停止，验证首个停止未完成时 `setImmediate` 和计时器能够执行。
- Node Native 构建、TypeScript 和 ESLint 已通过。最终工程门禁及哈希绑定见下一节，不与阶段专项测试数字相加。

### 最终工程门禁与源码绑定

在独立工作树中完成代码复审及以下最终验证；不以这组结果代替商业发布或真实 Electron 矩阵。

| 命令/检查 | 实际结果 |
| --- | --- |
| `npm.cmd run verify` | **exit 0**；各 Node 测试摘要合计 **2,160 项、2,146 通过、14 跳过、0 失败**，包含最后的 Native **91/91**；TypeScript、ESLint、格式、渲染器/Electron 构建与构建预算检查通过。 |
| `npm.cmd run coverage:critical` | **exit 0，126/126**；行覆盖率 **86.59%**、分支 **76.83%**、函数 **85.50%**。覆盖范围沿用既有 14 个关键文件，不将这些数字冒充 Native C++ 或来源适配器覆盖率。 |
| `npm.cmd run build:native:electron` | **exit 0**；Native **0.5.37**，三个本地绑定均为 **1,265,152 bytes**，SHA-256 `c136f353b19b6cbab7a1d74a354603b76610dc66e03b6c88ea29fbfb4c0f28bf`；`resources/runtime-manifest.json` 与实际 Electron 产物一致。 |
| `npm.cmd run test:runtime-manifest` | **22/22 通过**。 |
| `npm.cmd run docs:check` | **exit 0**；实施文档补录后再次通过并单独记录，不宣称改写后的文档已经参加此前全量门禁。 |
| 受验源码前后比较 | 由 `git ls-files -co --exclude-standard -z` 去重得到 **1,385 个普通源文件**；逐项 SHA-256/大小及既有缺失路径在最终门禁前后完全一致。此前已删除的 `scripts/run-value-observations-hidden.vbs` 单列记录，未恢复或伪造。 |

完整日志及源码清单位于本地 `artifacts/source-scan-fix/`，不作为必需的仓库链接；外部 QA 目录保留最终校验记录。门禁后仅更新本节文档状态，并单列该文档的受验哈希与最终哈希；不把最后的文字补录伪装为此前受验源码。

保留三类失败历史及处理：首次关键覆盖率因生成的第三方清单仍记 Native 0.5.36 而失败，重新生成清单后通过；首次全量验证发现上一轮既有窗口输入故障测试未接入默认测试链，已补入 `test:window-visibility`，该组 **20/20** 且无真实窗口/输入操作；第二次全量验证在 SQLite 临时备份恢复夹具删除目录时遇到 `ENOTEMPTY`，与启动时异步清单脱敏存在重叠窗口，仅为临时夹具删除增加最多 5 次、100 ms 递增等待的重试，最多额外等待 1,500 ms，持续失败仍报错。该 SQLite 组修复后 **22/22**，业务断言和产品 API 未改变。三项均有独立只读复审；最终全量验证在修复后的同一源码快照上完成。

### 保留边界

截至 2026-09-24，扫描持有索引 writer lease，直接切换到同样需要该 lease 的异步快照会造成冲突，当时没有这样替换。2026-09-25 的专用后台发现快照及跨环境所有权处理见下一节。同步快照仍会一次创建完整 Native/JS 结果，扫描去重表、上层数据目录完整数组及 worker 整体传输仍存在；本次降低交付和同步 SQLite 单次写入的记录数量，没有证明整体常量内存或消除全量捕获暂停。此前最终集成 `verify` 通过与商业 `release:gate` 未通过是不同结论；真实 Electron、掉盘/强退、签名和版权申请人的权属确认仍需各自验收。

## 2026-09-25：Native 0.5.38 后台发现快照

### 实现与已取得阶段证据

- 专用 `snapshotScanRecordsAsync` 在后台复制 path/size/mtime，按 generation 与 environment owner 发布只读游标；adapter 使用分页，不再调用同步全量快照作为回退。每页上限 256 条/256 KiB，页间让出事件循环，包括纯重复或其他来源的页面。
- 捕获准入与取消 token 在短所有权锁内登记；活动扫描的 writer lease 保留到捕获结束。扫描结束后再次捕获需原子核对最后 writer token，因此其他 environment 已完成的写入也能使旧 generation 的捕获拒绝。已成功捕获的视图保持不可变，之后的其他环境写入不撤销视图；这不是贯穿整个消费过程的全局写事务。
- stop 在 sidecar 停止副作用结束前持有既有 lease，无旧 lease 的空闲环境不能取消其他环境的工作。重叠 stop 合并等待；adapter 等待 capture 时也响应 abort，仍在 finally 关闭返回游标。普通迟取消通过后台 discard 释放；排队或环境清理异常仍可能在 JS 线程释放有界 export 存储。
- 专项为 **89/89**：`tests/native-scan.test.cjs` **50 项**与 `tests/source-adapter-contract.test.cjs` **39 项**，0 失败、0 框架级跳过。日志另记 file symlink 子检查因 `EPERM` 未执行，不能用框架 skipped=0 将其视为通过。覆盖跨环境已完成 writer、cursor owner、取消/替换、quota 回收、sidecar 隔离、目录枚举一致及 catalog 失败保留。
- Node Native 0.5.38 构建通过；当时绑定为 **1,282,048 bytes**、SHA-256 `0ff44e82b4ae5173af8825860f90e4e9b776e3b3b5295da1008c4f186e142fe5`，不是新 Electron 产物的替代证据；下表实验只绑定此作者工件，没有在后续 `c7096d2a…` 的集成或随包 binding 上重跑。类型与定向 lint/格式通过，独立复审核对固定源码及原始日志，未自行重跑产品测试。

### 临时 120,000 条索引实验

从临时生成 mmap 段捕获轻量元数据，每轮与同步视图排序后逐项相等；没有读取用户素材。每轮 469 页。

| 轮次 | 同步最大循环间隔 ms | 异步最大循环间隔 ms | 同步总耗时 ms | 异步总耗时 ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 227.01 | 15.98 | 226.86 | 208.92 |
| 2 | 241.11 | 15.79 | 241.00 | 300.76 |
| 3 | 360.40 | 15.67 | 360.28 | 319.35 |

响应性在此夹具改善；第二轮总耗时增加，不能宣称扫描始终更快。单页调用最大约 0.37～0.51 ms，但后台捕获本身仍约 121～192 ms。额外 2,048 张临时 PNG 的重叠扫描样本最大循环间隔 16.51 ms，只有 19 个小型同步读样本；未测得 writer 恰好排队的最坏情形，不能外推为真实混合负载、锁公平性或查询型同步读上界。实验可用内存约 2.75 GB，不是受控硬件正式验收。

### 完整集成验证与保留边界

本轮完整 `verify` **exit 0**：52 组 Node 摘要合计 **2,200 项、2,186 通过、14 跳过、0 失败、0 取消**，包含完整 Native **99/99**。关键覆盖率命令 **136/136、exit 0**，行 **86.59%**、分支 **76.83%**、函数 **85.50%**；仍是既有 14 个关键文件范围，不代表 Native C++ 或 adapter 覆盖率。

全量门禁前后 **1,428 个普通源文件**的路径、大小和摘要完全一致，快照时间分别记录。新 Electron Native 构建 **exit 0**，三个本地绑定与新包中的 `fast_scanner.node` 均为 **1,282,048 bytes**，SHA-256 `c7096d2a6b58d5b52bd3b1b9f7fd5bda3563875f8eb09095b1cb924a19f9b621`，runtime 及生成清单绑定当前产物。此 SHA 与作者实验工件 `0ff44e82…` 不同；没有将 120k 性能结果伪装成新包实测。

当前内部 Online 未签名目录包资源检查通过：**29/29 核心要求、40 份许可原文、131 个资源文件**，缺件、重复、禁止、敏感载荷及 manifest 问题列表为空。独立只读复核确认 45 个 ASAR 构建文件与当前输出一致，Native 与 42 个许可目录文件逐字节对应受审源树，1,428 源文件无变化；没有启动应用或 GUI。没有生成正式安装器、签名、发布或提交；资源报告不代替真实 Electron 功能和干净设备矩阵。门禁后补录的既有 Markdown 将逐项列明前后摘要并另跑文档检查；原始和公开验证证据的摘要随候选包保存。旧 0.5.37 的验证与产物仅保留历史含义，89 项专项也不与完整门禁数字重复相加。

每次轮询仍捕获全局有效索引，Native 去重和 JS Map 随唯一记录数增长，上层完整数组消费者未改变。共享锁捕获可能阻塞 writer；获得锁本身不可取消，多个 reader/writer 的最坏竞争未闭合。每环境最多两个游标和 100 万条/128 MiB 估算预算不等于进程 RSS 上限。SFR-011 整项仍部分完成；真实 Electron、掉盘/强退、受控长时负载、干净设备安装和正式发布各自保留验收条件。
