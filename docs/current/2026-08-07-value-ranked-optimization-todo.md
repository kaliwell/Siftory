# 价值排序专项优化 TODO

> 状态：当前
> 实施状态：当前自动化入口
> 建立日期：2026-08-07
> 范围：审计驱动的安全、数据正确性、性能、发布可靠性与维护性专项
> 选择命令：`npm.cmd run todo:value-next`
> 结构校验：`npm.cmd run todo:value-check`
> 自动推进：`npm.cmd run todo:value-auto`（仅运行允许列表中的只读探测并保存证据）

## 自动执行规则

1. Value 为 1–100 的相对价值分，综合用户影响、性能收益、故障概率、覆盖范围和后续解锁价值；表格必须按 Value 降序排列。
2. Mode 决定授权边界：`auto` 可由执行器领取；`approval` 涉及真实数据或外部授权；`observation` 需要维护周期证据；`triggered` 只有产品需求出现时才启动。
3. 自动选择只接受 Mode=`auto`、状态为 `pending` / `in_progress` / `implemented`、依赖均为 `verified` 且无 External blockers 的任务。
4. `implemented` 和 `in_progress` 优先于领取新任务，防止遗留半成品；同状态按 Value、Rank 排序。
5. 自动执行不得删除或迁移真实用户数据、替用户作许可证决定、伪造人工标注、创建发布签名或绕过真实维护窗口。
6. 每项使用独立分支和提交；先把任务标为 `in_progress`，实现后标为 `implemented`，完整验收通过并合入 `main` 时才标为 `verified`。
7. 任务拆分或价值变化必须同步修改表格、说明理由并通过结构测试；不能通过调低风险项分数来绕过正在进行的任务。
8. 每项完成前必须审计相邻的数据流、权限边界和发布链；新发现按 Value、依赖、授权边界和验收条件立即插入本表。发现问题不扩大既有授权，真实数据修复、许可证、签名和外部发布仍停在 `approval` / `blocked`。

## 机器可读任务表

| Rank | ID      | Value | Mode        | Dependencies              | External blockers                         | Branch                                  | Status      | Validation                                                               | Task                                                                                            |
| ---: | ------- | ----: | ----------- | ------------------------- | ----------------------------------------- | --------------------------------------- | ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
|    1 | VAL-001 |   100 | approval    | -                         | -                                         | `ops/vector-real-data-validation`       | verified    | verify-vector-generation-recall + maintenance stats                      | 真实小批量 embedding 追加、召回门禁、维护统计与崩溃恢复验证                                     |
|    2 | VAL-020 |   100 | auto        | -                         | -                                         | `fix/smoke-isolation-sandbox`           | verified    | smoke isolation fixtures + sandbox argv guard + production digest        | Smoke 强制临时 userData 与测试标记，真实语义 smoke 不再 junction 生产库，正常开发恢复沙箱       |
|    3 | VAL-021 |    99 | auto        | VAL-020                   | -                                         | `fix/vector-validity-recall-gate`       | verified    | worker protocol + persistence + zero/NaN/dimension + recall completeness | 在 child、主进程、持久化和查询边界拒绝无效向量，并让召回门禁统计源错误与 generation 缺失        |
|    4 | VAL-034 |    99 | auto        | VAL-020; VAL-021          | -                                         | `fix/composite-cache-search`            | verified    | base+delta search fixtures + latest-wins duplicate recall                | 修复 composite F16 的增量行读取与同路径更新语义，确保 committed CLIP 增量可搜索且最新向量生效   |
|    5 | VAL-022 |    98 | auto        | VAL-020                   | -                                         | `fix/semantic-scope-prefilter`          | verified    | scope starvation fixtures + semantic search smoke                        | 在 F16 topK heap 前执行语义 scope 过滤，避免 Native 子集有数据却返回零结果                      |
|    6 | VAL-009 |    98 | auto        | -                         | -                                         | `design/dino-clip-cuda`                 | verified    | design review + deterministic parity harness                             | DINO/CLIP NVIDIA CUDA 架构、模型兼容门禁、性能基准和安全回退方案                                |
|    7 | VAL-023 |    97 | auto        | VAL-020                   | -                                         | `fix/clip-alpha-input`                  | verified    | grayscale-alpha/RGBA fixtures + CLIP child tests + vector pipeline       | CLIP 解码失败时执行有界 sRGB/flatten/removeAlpha 回退，修复灰度+Alpha 等通道转换失败            |
|    8 | VAL-010 |    97 | auto        | VAL-009                   | -                                         | `feat/dino-clip-cuda-worker`            | verified    | provider profiles + parity gate + test:vector-pipeline                   | 隔离 CUDA PoC、native inference worker 与每模型 provider 路由，保留 DirectML/CPU 回退           |
|    9 | VAL-024 |    96 | auto        | VAL-020                   | -                                         | `fix/release-profile-gate`              | verified    | coverage:critical + clean build graph + release/profile contracts        | 修复关键覆盖率回退，清理不可达构建输出，并让覆盖率和 online/offline profile 贯穿发布门禁        |
|   10 | VAL-002 |    96 | auto        | -                         | -                                         | `perf/vector-ann-hot-snapshot`          | verified    | test:vector-ann + test:vector-pipeline                                   | ANN worker 复用已加载基座，只追加 delta 向量和路径，消除快照变化后的全量重读与复制              |
|   11 | VAL-012 |    95 | auto        | -                         | -                                         | `perf/native-scan-adaptive-workers`     | verified    | worker-policy fixtures + native scan benchmark + test:native             | Native 扫描从固定 2 worker 改为有界自适应并发，按 CPU/内存扩展队列并提高解码/双哈希吞吐         |
|   12 | VAL-025 |    95 | approval    | VAL-021; VAL-023          | -                                         | `ops/repair-vector-coverage`            | verified    | repaired counts + generation manifest + recall gate                      | 定向补算 3,682 条零 DINO 与约 966 条灰度+Alpha CLIP，并重建 authoritative generation            |
|   13 | VAL-037 |    95 | auto        | VAL-021; VAL-027          | -                                         | `fix/subject-embedding-boundaries`      | verified    | child framing + hostile tensor/store fixtures + graceful fallback        | 隔离并严格校验 subject/face/person embedding 输出与缓存，使用显式 negative 状态且损坏时安全降级 |
|   14 | VAL-013 |    94 | auto        | VAL-012                   | -                                         | `perf/native-scan-signature-prefilter`  | verified    | signature fixtures + hash parity + test:native                           | 图片扩展名候选先做小文件头签名预检，拒绝伪图片后再读取和完整解码                                |
|   15 | VAL-026 |    94 | approval    | VAL-025                   | 真实 Native index 与 Catalog 重建授权     | `ops/rebuild-native-catalog`            | blocked     | native/catalog counts + database UI E2E                                  | 重建当前为空的 Native image-search-index 与 data catalog，并在 UI 分层显示数据库状态            |
|   16 | VAL-035 |    94 | auto        | VAL-022                   | -                                         | `fix/dino-ann-scope-prefilter`          | verified    | ANN scope-starvation fixtures + exact fallback parity                    | 将 DINO ANN 的 acceptPath 下推到 topK 选择前，避免全局近邻挤掉 scope 内最佳结果                 |
|   17 | VAL-027 |    93 | auto        | VAL-020                   | -                                         | `fix/user-model-process-isolation`      | verified    | worker crash/OOM/timeout fixtures + user-model E2E                       | 将未审查 ONNX 的导入检查与推理移出 Electron main，增加资源上限、超时和崩溃恢复                  |
|   18 | VAL-011 |    93 | approval    | VAL-010                   | NVIDIA runtime 再分发与许可证审查         | `release/cuda-optional-runtime`         | blocked     | runtime manifest + license gate + online/offline installer smoke         | CUDA 可选 runtime 清单、哈希下载、online profile 打包与安装器回退验收                           |
|   19 | VAL-030 |    93 | approval    | VAL-011; VAL-024          | 项目 EULA；第三方许可；签名密钥；远端备份 | `release/current-signed-distribution`   | blocked     | license gates + signed installer + SBOM + remote bundle                  | 建立 online/offline 正式 gate，完成依赖 notices、当前版本签名安装器与异机灾备                   |
|   20 | VAL-038 |    92 | auto        | VAL-021; VAL-034          | -                                         | `fix/vector-source-integrity-proof`     | verified    | checksum/semantic proof + bitflip fixtures + fail-closed consumers       | 为 authoritative、delta 与 derived F16 建立统一缓存证明，阻止落盘后损坏继续进入搜索与 ANN       |
|   21 | VAL-003 |    92 | observation | VAL-001; VAL-021; VAL-025 | 修复后 3 个相隔至少 24 小时的稳定维护周期 | `docs/vector-jsonl-retirement`          | blocked     | recall completeness gate + cleanup preview review                        | 完整覆盖恢复后重新累计三个稳定周期，再评估 JSONL shard 退役                                     |
|   22 | VAL-014 |    91 | auto        | VAL-012                   | -                                         | `perf/native-scan-enumeration-fallback` | verified    | USN/enum parity + whole-drive fixtures + UI status                       | 对齐 USN 与枚举回退的系统目录剪枝，并输出可操作的卷访问/管理员诊断                              |
|   23 | VAL-015 |    90 | auto        | VAL-013                   | -                                         | `perf/native-scan-jpeg-single-pass`     | verified    | dual-hash parity + thumbnail benchmark + test:native                     | JPEG 哈希与 Native thumbs 复用压缩输入或解码结果，减少同一图片的二次读取和解码                  |
|   24 | VAL-017 |    89 | auto        | -                         | -                                         | `feat/multi-display-workspace`          | verified    | multi-display coordinate tests + dual-display UI E2E                     | 多显示器透明工作区、跨屏面板迁移、混合 DPI 布局恢复与热插拔安全回退                             |
|   25 | VAL-004 |    88 | auto        | -                         | -                                         | `feat/embedding-job-epochs`             | verified    | test:vector-pipeline + migration fault tests                             | embedding jobs 增加 epoch、owner、heartbeat，根治 stale pending 再积累                          |
|   26 | VAL-036 |    88 | auto        | VAL-022                   | -                                         | `fix/semantic-scope-state`              | verified    | absent/valid-empty/corrupt manifest fixtures + safe fallback             | 区分 Native scope 缺失、有效空库与损坏状态，损坏时禁止静默扩大为全 CLIP 搜索                    |
|   27 | VAL-018 |    87 | auto        | -                         | -                                         | `feat/ai-control-api`                   | verified    | capability/auth/path/rate-limit tests + packaged loopback smoke          | 默认关闭的本机 AI 控制 API、能力白名单、权限/确认规则、任务事件与使用文档                       |
|   28 | VAL-028 |    86 | auto        | VAL-022; VAL-034          | -                                         | `perf/semantic-search-worker`           | verified    | 78K warm P95 + cancellation + heap/GC benchmark                          | 融合 F16 解码与点积并迁出主进程，降低约 153 MiB 查询临时分配和事件循环尾延迟                    |
|   29 | VAL-029 |    85 | auto        | VAL-020                   | -                                         | `fix/electron-ai-security-hardening`    | verified    | permission/CSP/origin/SSE/pre-auth tests                                 | 主 Session 权限默认拒绝、收紧 CSP/IPC origin，并限制 AI API 认证失败与 SSE 并发                 |
|   30 | VAL-005 |    80 | approval    | -                         | -                                         | `ops/storage-confirmed-cleanup`         | verified    | cleanup task + zero-error progress + fresh zero-candidate post-check     | 清理派生缩略图、派生媒体帧和旧素材库备份，同时保护最新素材库备份                                |
|   31 | VAL-016 |    78 | auto        | VAL-015                   | -                                         | `perf/native-thumbs-adaptive-fill`      | verified    | queue-pressure + fill-missing benchmark + shutdown tests                 | Native thumbs 自适应 worker 与扫描后 Fill Missing，降低队列 deferred 且保持索引优先             |
|   32 | VAL-006 |    76 | auto        | -                         | -                                         | `perf/vector-chunk-integrity`           | verified    | test:vector-pipeline + corruption fixtures                               | 用分块完整性锚点补强 64 KiB 尾哈希无法发现的早期同尺寸改写                                      |
|   33 | VAL-019 |    74 | auto        | -                         | -                                         | `feat/semantic-theme-presets`           | verified    | contrast audit + bilingual theme screenshot E2E + settings migration     | 柔和、硬朗、中性主题组与深色/浅色/System 模式，语义色彩 token 和无障碍对比度                    |
|   34 | VAL-031 |    73 | auto        | VAL-025                   | -                                         | `perf/authoritative-dino-ann-prewarm`   | verified    | ANN parity + generation prewarm + warm-query benchmark                   | 为 authoritative generation 预热 DINO ANN，避免首次相似搜索全量构建                             |
|   35 | VAL-033 |    70 | auto        | VAL-024                   | -                                         | `task/ipc-build-hotspots`               | verified    | layer checks + IPC contract budget + build graph                         | 拆分临界 IPC contract 与超大高频模块，收紧层级和可达构建图                                      |
|   36 | VAL-032 |    65 | auto        | VAL-021                   | -                                         | `perf/recall-observation-memory`        | verified    | recall memory ceiling + unchanged-source reuse                           | 将 VAL-003 召回周期放入低优先级进程，并复用未变化源的验证矩阵以降低内存峰值                     |
|   37 | VAL-007 |    58 | auto        | -                         | -                                         | `feat/i18n-baseline-batches`            | verified    | test:i18n-static + bilingual smoke                                       | 按面板分批清理 235 组 grandfathered i18n baseline                                               |
|   38 | VAL-039 |    50 | auto        | -                         | -                                         | `feat/settings-processed-data-reset`    | verified    | derived-data-reset fixtures + ipc/preload/i18n gates                     | 设置面板一键清除图搜派生数据（Native 索引、缩略图、扫描日志、vector-db），带 busy 守卫与链接防护 |
|   39 | VAL-008 |    30 | triggered   | -                         | 出现第二个加载 FastScanner addon 的 env   | `feat/fastscanner-multienv-owner`       | deferred    | test:native + shutdown integration                                       | FastScanner 写入排队、统一 owner、读快照、租约诊断和多 env 关闭握手                             |

## 状态流转

```text
pending -> in_progress -> implemented -> verified
              |                |
              +---- blocked ---+

deferred --(明确需求出现)--> pending
blocked  --(外部证据/授权满足)--> pending
```

`todo:value-next` 只负责确定下一项和解释阻塞，不会直接修改文件、删除数据或提交代码。`todo:value-auto` 会自动运行剩余任务的允许列表探测：CUDA 清单/许可证状态、JSONL 召回维护周期、存储清理只读预览和 FastScanner 第二 env 触发检测；证据写入忽略版本控制的 `artifacts/value-optimization/`。它不会接受许可证、删除用户数据或直接改写任务状态。自动逐步完成由执行器按输出建立独立分支、实现、验证和更新状态；失败时保留当前任务，下一轮优先恢复而不是跳到低价值任务。

2026-08-07 的 `VAL-001` 只读预检发现：现有 317,268 条 CLIP / 321,002 条 DINO 复合快照均为 0 缺失、0 坏行，但原始路径身份 recall 因近重复 top-K 边界翻转降至 0.9747 / 0.9830。门禁已改为以 F32 精确分数等价性判定，同时保留严格路径 recall 诊断；真实只读复跑的分数等价 recall 为 1.0000 / 0.9999，门禁 2/2 通过。

2026-08-07 获得真实维护窗口与小批量写入授权后，`VAL-001` 追加 2 条真实 DINO 向量，记录/唯一图片从 321,002/320,356 增至 321,004/320,358；CLIP 保持 317,268/316,622。3 字节未提交 F16 尾部与 7 字节 malformed 路径尾部均由正式恢复流程精确截断，追加后真实召回门禁 2/2 通过。实现与证据已通过完整验收并合入 `main`，状态流转为 `verified`；`VAL-003` 的真实崩溃恢复证据已满足，仅剩 N 个稳定维护周期。

2026-08-07 因新增 DINO/CLIP CUDA 需求，将方案与实际接入拆开：`VAL-009` 先固定架构和可重复门禁，`VAL-010` 在其后自动执行真实 PoC 与 worker 接线，涉及 NVIDIA runtime 再分发决定的发布打包独立为 `VAL-011`，不让许可证授权阻塞前置技术验证。

2026-08-07 Native 扫描现场显示：单个整盘路径因无法打开 NTFS 卷而回退目录枚举，i7-12700H 的 20 个逻辑处理器只由固定 2 个扫描 worker 使用；当前会话开头还出现 58 个扩展名命中但内容签名无效的候选。新增 `VAL-012`–`VAL-016`，依次处理自适应扫描并发、签名预检、USN/枚举回退一致性、JPEG 单次处理和 Native thumbs 队列补全。真实目录仅用于只读观察，性能门禁使用临时夹具，不自动删除或重写用户数据。

2026-08-08 `VAL-012` 在 i7-12700H/15.6 GiB 现场按可用内存选择 4 worker/128 队列；512 张 2048×1365 JPEG 的三轮中位吞吐从固定 2 worker 的 85.48 提升至 160.29 张/秒（1.875×），512 条记录与双哈希摘要完全一致。实现、状态栏观测、Node/Electron ABI 和运行时清单已完整验收并合入 `main`，状态流转为 `verified`。

2026-08-08 `VAL-013` 已实现 12 字节图片签名预过滤：同一次文件打开先校验 JPEG/PNG/GIF/BMP/WebP 签名，伪图片不再分配并读取完整文件；拒绝数进入扫描进度、状态栏和失败路径缓存。128 个 16 MiB 伪图片夹具（每轮可避免 2 GiB 逻辑读取）中，旧版两次三轮中位数为 2782/2895 ms，新版均为 124 ms，保守提升 22.4×；真图索引及双哈希保持一致。实现已完整验收并合入 `main`，状态流转为 `verified`。

2026-08-08 `VAL-014` 已将 USN 与目录枚举统一到同一套系统目录策略，并在 USN 中按 FRN 传播父目录排除；整盘回退不再进入 `Windows`、`Program Files`、`Program Files (x86)`、`ProgramData`。2048 个系统目录候选夹具从旧版索引 2049 条、57–206 ms，降至只索引 1 条用户图片、3 ms；回退原因、Win32 错误码、管理员需求和操作建议已暴露到状态栏。实现已完整验收并合入 `main`，状态流转为 `verified`。
2026-08-08 `VAL-015` 已让扫描阶段读取的 JPEG 压缩字节直接进入 Native thumbs 的 WIC 内存流，保留原有 EXIF 方向、缩放、画质与缓存键；待处理输入受 128 MiB 上限保护，超限自动回退路径读取。64 张 1,582,467 字节 JPEG 的缩略图源读取由 64 次降至 0，复用 101,277,888 字节，中位吞吐由 121.41 提升至 123.27 张/秒（+1.5%），双哈希摘要完全一致且完成后保留输入为 0。Native 67/67、类型、i18n、Node/Electron ABI 与运行时清单已通过，实现已合入 `main`，状态流转为 `verified`。
2026-08-08 `VAL-016` 已实现 Native thumbs 索引优先自适应并发与扫描后 Fill Missing：扫描阶段按 CPU/内存使用 1–2 个 worker，Hash 完成后扩展到最多 8 个；队列压力任务进入受 65,536 项和 32 MiB 路径数据双上限保护的 deferred 列表，JPEG 输入仍共享 128 MiB 保留预算。512 张压力夹具中 Hash 就绪中位时间由 979.75 ms 降至 646.38 ms（-34.0%），旧版最差永久漏 336 张，新版三轮均补齐 512/512、源文件二次读取 0、停止后路径与 JPEG 保留内存均归零。Native 69/69、缩略图管线 10/10、类型、i18n 与 Node/Electron ABI 已通过，实现已合入 `main`，状态流转为 `verified`。

2026-08-08 `VAL-011` 已完成可选 CUDA runtime 的技术实现：固定 ORT GPU 1.24.3、CUDA 12.8.1 与 cuDNN 9.19.1 的官方归档、外层/内层 SHA-256、精确 ZIP 条目提取、21 个运行制品完整性校验、一键 online/offline 安装器、显式 NVIDIA 许可证接受和损坏时 DirectML 回退。真实 RTX 3050 smoke 已完成 DINO 768 维与 CLIP 512 维推理，2,124,750,595 字节安装目录的 21/21 制品复验通过。该项仍保持 `blocked`：所有 CUDA 组件默认不打包，只有项目/法律责任人批准 NVIDIA 再分发后才能改变发布配置。

2026-08-08 新增 `todo:value-auto` 安全自动推进器并完成第一轮只读探测：`VAL-011` 技术门禁通过、4 项发布决定仍为 pending；`VAL-003` 因用户已清空 embedding shard 而无 authoritative generation，周期不计数，明确固定为重新生成后至少 3 个相隔 24 小时的召回周期；`VAL-005` 预览到 830,725,787 字节候选（缩略图 33,217,073、媒体帧 152,668,570、旧素材库备份 644,840,144），未删除；`VAL-008` 仍只有 `electron/imageSearchService.ts` 一个生产加载点，未触发。状态和报告保存在忽略版本控制的 `artifacts/value-optimization/`。

2026-08-09 已形成 `VAL-011` 官方来源签核包：ONNX Runtime MIT 条款、CUDA 12.8.1 Attachment A、CUDA/cuDNN 官方 redistributable 清单与 cuDNN runtime DLL 补充条款均已逐项映射到 manifest。该材料只缩小人工审查范围，不接受协议或代替授权人；4 项决定继续保持 `pending`。详见 `docs/current/2026-08-09-val-011-license-approval-packet.md`。

2026-08-09 `VAL-011` 自动探测升级为两阶段门禁：项目 EULA 与四项组件审批仍必须由真实授权人完整记录；审批全部通过后，计划任务才自动运行限定的 CUDA installer、online/offline profile、固定哈希资源、worker provider gate 与 DirectML 回退回归。审批字段与审批后技术回归必须同时通过才输出 `completionReady=true`；自动化不传递许可证接受参数、不下载 runtime，也不改写决定记录。

2026-08-09 20:55 CST 进度快照：`VAL-005` 已完成 11,996 个文件、830,725,787 字节的授权清理且 fresh preview 为 0；DINO/CLIP 各有 79,194 条有效向量，generation `20260809120822669-510e58f8` 的双模型召回门禁 2/2 通过。`VAL-003` 在相同证据合约与快照下为 1/3，下一窗口不早于北京时间 2026-08-10 20:10:52；`VAL-011` 技术门禁通过，但项目 EULA 与四项组件审批仍全部 pending，审批后回归保持 `waiting-for-prerequisites`。计划任务 `Reasonix-VAL003-Observations` 正在运行；当前约束为不关机、不处理 ACC-02、不伪造审批或维护周期。

2026-08-09 根据用户新增需求加入 `VAL-017`–`VAL-019`：先解决主窗口固定主显示器导致的跨屏限制，再建立默认关闭、仅 loopback、按 capability 白名单授权的 AI 控制 API，最后扩展现有六主题为柔和/硬朗/中性与深色/浅色/System 组合。三项均不接触真实索引数据，详细规则和验收见 `docs/designs/2026-08-09-multi-display-ai-api-theme-plan.md`。

2026-08-08 用户明确选择 VAL-005 的全部三类候选后，正式清理任务 `storage-cleanup-1786202640410-4tmxpfuf` 删除 11,996 个派生/旧文件并释放 830,725,787 字节，0 skipped、0 errors；修复旧目录 mtime 变化可能误判最新备份的保留缺陷后，fresh preview 对三类候选均为 0，最新 107,473,698 字节素材库备份受保护。实现与 13/13 清理/库存回归已合入 `main`，VAL-005 状态流转为 `verified`。

2026-08-09 项目全量审计将安全、数据正确性、发布可靠性和性能发现加入 `VAL-020`–`VAL-033`，并启动滚动审计规则。当前扫描发现 83,367 个候选，CLIP 有效 78,228，DINO JSONL 79,194 行中有 3,682 条零向量；双模型有效交集 74,546，Native index 与 Data Catalog 均为空。代码型任务只使用临时夹具；真实向量补算、索引重建、许可证、签名和发布继续停在审批边界。

2026-08-09 在实现 `VAL-020` 时继续向下审计，确认 966 条 CLIP 通道失败全部来自灰度+Alpha PNG，而非先前概括的 RGBA；`VAL-023` 的回归夹具和任务描述已按真实输入修正。同时发现 composite F16 handle 的 `meta.count` 包含 delta，但语义扫描仍只读 base vector/path，且同路径更新可能不满足 latest-wins；新增价值 99 的 `VAL-034` 独立修复增量可搜索性与重复路径语义。

2026-08-09 `VAL-020` 已实现 fail-closed smoke 启动策略、随机 marker/nonce、正常开发态 sandbox-on，以及不使用 junction/硬链接的独立语义缓存与模型快照。sandbox-on AI smoke、视觉 smoke 和真实语义 smoke 均通过；真实语义返回 78,228 个候选和 5 个结果，生产 vector/model 文件清单、大小与 mtime 前后不变。生产 CLIP derived-cache metadata 仍保留旧 junction smoke 写入的已删除临时源路径，本项只记录证据而未改写真实数据。

2026-08-09 `VAL-020` 合入后状态流转为 `verified`，自动队列转向 `VAL-021`。相邻数据链继续发现 DINO ANN 也在全局 topK 后才执行 scope 过滤，以及 Native manifest 的缺失、有效空库和损坏状态被折叠为同一个“全库放行”结果；分别新增 `VAL-035` 和 `VAL-036`。发布链还确认 release gate 会静默忽略非法 profile，controlled workflow 会误取默认不捆绑的 CUDA 组件；这些验收并入 `VAL-024`，不触碰许可证或签名授权。

2026-08-09 用户要求构建正式 release 后启动 `VAL-024`：release gate 现已拒绝非法或重复 profile，并把 online/offline 选择贯穿 bundled-only runtime 复验、许可证门禁、构建、packaged resources、安装器 archive、清理、安装器路径与 release record；关键覆盖率重新接入正式门禁。生产构建在 Vite 入口前只清理受控的 `dist` 与 `dist-electron`，避免历史不可达主进程产物污染 ASAR；controlled workflow 同步要求显式 profile、profile 许可证门禁和 `ci:verify`。专项模型/发布测试 71 项、QA workflow 5 项、可重复构建 11 项均通过；正式 release 仍必须等待真实项目/组件许可证和 Authenticode 签名配置，当前不得绕过。

2026-08-09 正式 offline release gate 运行 `2026-08-09T14-16-58-878Z-offline-08b88e81f6b7`：`clean-install`、`git-preflight`、完整 `verify`、`coverage:critical` 与 bundled-only runtime resources 26/26 全部通过，关键覆盖率为 lines 84.64%、branches 74.64%、functions 83.69%。门禁随后在 `license-compliance` 正确停止：项目许可证/EULA，以及 DINOv2、CLIP、多语言编码器、FFmpeg、fast_scanner 的审批记录、证据和许可证文件仍未获授权；本机 Authenticode 签名命令也未配置。因此本次没有执行 package、签名、SBOM 或 release record，未生成可冒充正式发布的安装器。`VAL-024` 的工程接线已验证并流转为 `verified`；实际正式发布继续由 `VAL-030`/`VAL-011` 的真实法律审批与签名授权阻断。

2026-08-09 按用户要求生成本地内部测试安装器 `release/FloatingClock Setup 1.0.0.exe`：保留已复核 pinned native，不执行会改变清单哈希的现场 native 重编；renderer、主进程、preload 与 workers 从干净输出重新构建，TypeScript 检查通过。packaged resources 25/25、NSIS archive 271 文件检查通过；文件大小 709,045,402 bytes，SHA-256 为 `405D0901751C124BDAD8785B0B95614252E9060BEAF99669B81959580474D56E`。该文件 Authenticode 状态为 `NotSigned`，且前述许可证审批仍未完成，因此只可用于本机内部测试，不是正式可分发 Release；正式发布门禁状态不变。

2026-08-09 `VAL-021` 滚动审计把全局图片、媒体帧和素材流的 child 协议、查询、持久化、latest-wins 与召回完整性纳入同一严格向量边界，并以 schema v2 使旧的宽松 authoritative/delta/derived 缓存安全失效。相邻链另发现 subject/face/person 输出与缓存仍缺少同等级隔离和显式 negative 状态，新增价值 95 的 `VAL-037`；落盘后的 F16 bitflip 或本地损坏仍需统一 checksum/语义证明，新增价值 92 的 `VAL-038`。两项只进入自动队列，不在本轮访问、迁移或重写真实用户向量数据。

2026-08-09 `VAL-021` 实现完成：严格向量校验统一覆盖模型输出、child framing、主进程协议、JSONL/F16/authoritative/delta 持久化、Memory/ANN/stream 查询、媒体帧和素材流；跨 shard/latest-invalid 使用 canonical tombstone，召回门禁按 current-state 双向统计并对全区间确定性分层采样。`test:vector-pipeline` 175 通过、2 个需真实 CUDA fixture 的用例按设计跳过；全仓 `verify`、`coverage:critical`、TODO 结构检查、生产依赖审计均通过，0 个 npm 漏洞。真实用户向量与缓存未被迁移或改写；合入主分支后再流转为 `verified`。

2026-08-09 `VAL-021` 已以提交 `6cb4d1c` 快进合入 `main`，状态流转为 `verified`。自动队列解除 `VAL-034`、`VAL-032` 的代码依赖；下一项按同价值依赖顺序进入 composite F16 base+delta 搜索修复。

2026-08-09 自动队列启动 `VAL-034`：以 committed base+delta 的全部行可搜索、同路径 latest revision 唯一生效、invalid latest 形成 tombstone，以及 CLIP/媒体/ANN 消费者一致为验收边界；先使用隔离临时 fixture，不读取或改写真实用户向量数据。

2026-08-09 `VAL-034` 实现完成：共享 F16 reader 现在按 canonical path 重放 base+delta 并只暴露最新物理行，流式搜索、同步/异步点查、路径枚举、媒体帧、素材分类、CLIP 聚类读取和 ANN 精排均使用同一 latest-wins 视图；CLIP scope 同时下推到 top-K 堆之前，避免子库候选饥饿。隔离 fixture 覆盖 delta 新路径、同路径多次更新、大小写/斜杠等价、ANN 旧行屏蔽和完整 JSONL rebuild 对齐。`test:vector-pipeline` 176 通过、2 个真实 CUDA fixture 按设计跳过，`test:asset-library` 130/130、媒体相关 45/45、ANN 16/16；全仓 `verify`、`coverage:critical`、Native 69 项和生产依赖审计均通过，0 个 npm 漏洞。真实用户向量、缓存和 embedding shard 未被读取、迁移或改写；合入主分支后再流转为 `verified`。

2026-08-09 `VAL-034` 已以提交 `6e72d1d` 快进合入 `main`，状态流转为 `verified`。自动队列释放依赖 composite latest-wins 的 `VAL-038`；同价值队列下一项转向修复真实灰度+Alpha CLIP 输入的 `VAL-023`。

2026-08-09 自动队列启动 `VAL-023`：以真实失败日志对应的灰度+Alpha PNG 为首要夹具，先保留 Transformers 原生快速路径，仅在受支持的通道转换失败时执行有界 Sharp sRGB/flatten/removeAlpha 三通道回退；同时覆盖普通 RGB/RGBA、损坏输入、资源上限和 child 生命周期，所有验证使用临时 fixture，不读取或补算真实用户 embedding。

2026-08-09 `VAL-023` 实现完成：CLIP 单图、CUDA 和批处理三条读取路径统一使用惰性加载的有界解码器；RGB/RGBA 保留 Transformers 原生快速路径，只有明确的通道转换错误才启用 Sharp rotate/white-flatten/sRGB/removeAlpha 三通道回退，文件限制 256 MiB、像素限制 64 MiB，其他损坏输入保持原错误。合成灰度+Alpha、RGB、RGBA、损坏和超限夹具 6/6 通过；对当前失败日志中 966 个仍存在的真实文件执行只读验证，966/966 均确认为 2 通道灰度+Alpha、原生 966/966 失败、回退 966/966 成功且全部输出 RGB。`test:vector-pipeline` 183 通过、2 个真实 CUDA fixture 按设计跳过；全仓 `verify`、`coverage:critical`、Native 69 项和生产依赖审计均通过，0 个 npm 漏洞。真实 embedding、failure log 和用户图片均未写入或补算；合入主分支后再流转为 `verified`。

2026-08-09 `VAL-023` 已以提交 `dc31214` 快进合入 `main`，状态流转为 `verified`。`VAL-025` 的 CLIP 通道修复依赖已解除；真实 966 条定向补算和 authoritative generation 重建仍保持审批门禁，不因只读解码验证自动执行。

2026-08-09 用户明确要求重建 DINO/CLIP embedding 后，`VAL-025` 获得限定于 3,682 条当前零 DINO、966 条已确认灰度+Alpha CLIP 失败记录和 authoritative generation 的真实数据操作授权。新增 `vectors:repair-coverage` 两阶段工具：预览令牌绑定 JSONL、失败日志与每个候选文件的 size/mtime，执行时复验并加单实例锁；只追加定向修复结果，随后以临时 generation 完整校验后原子切换 `CURRENT`。脚本与夹具 5/5、`test:vector-pipeline` 187 通过（2 个真实 CUDA fixture 按设计跳过），全仓 `verify`、`coverage:critical` 和生产依赖审计通过。

2026-08-09 真实修复完成：DINO 3,682/3,682、CLIP 966/966，失败与跳过均为 0；当前双模型均为 79,194 条有效向量，DINO 当前零/非有限/错维均归零，CLIP 失败候选归零。schema v2 generation `20260809120822669-510e58f8` 已完成双模型 2/2 原子构建并切换；每模型 200 个分层查询的完整召回门禁 2/2 通过。`VAL-025` 流转为 `verified`，`VAL-003` 在相同 generation/证据合约下接受第 1 个真实周期，下一窗口不早于 2026-08-10T12:10:52.860Z；其余两个周期仍必须各自满足至少 24 小时真实间隔。

2026-08-09 用户要求新增测试用派生数据清除入口，登记 `VAL-039`：设置面板 Data 区新增"清除图搜处理数据"按钮，确认弹窗先 preview 再直接删除 Native 索引、缩略图、扫描日志与整个 vector-db（models、配置、media-search、素材库保留）。主进程 `derivedDataResetService` 复用 containment/realpath/符号链接守卫，删除后失效 ANN worker 与 CLIP 内存缓存；IPC clear 通道带扫描/embedding/媒体/迁移/清理全部 busy 守卫。夹具测试 5/5、`test:vector-pipeline` 193 通过 2 跳过、ipc/preload/i18n/settings 门禁与 typecheck 均通过；未触碰真实用户数据。合入 `main` 后流转为 `verified`。

2026-08-09 `VAL-039` 真实使用反馈修复：Native 索引段文件以 `segment_mmap` 常驻映射，直接 unlink 在 Windows 报 `EBUSY`（`global_directory.idx` 等 3 个文件）。`clearProcessedImageData` 现在删除前先 `disposeVectorAnnWorker()` 并经 `clearImageIndex()` → `unmap_index` 释放映射，再执行受守卫的删除；单测 5/5、typecheck/lint/prettier 通过。

2026-08-10 `VAL-039` 以提交 `27a446d` 合入 `main`，状态流转为 `verified`。同分支另以 `a4a199f` 将 VAL-003 观察计划任务改为 wscript 隐藏启动（登录不再弹控制台窗口）；VAL-003 周期因向量库重建按规则从 0/3 重新累计，调度器已在后台正常运行。

2026-08-10 `VAL-022` 审计结论：VAL-034 的 composite 重写已把 CLIP 语义路径的 acceptPath 下推到 `BoundedSemanticCandidateHeap` 之前，其余 F16 topK 路径（DINO 精确、Memory ANN、媒体帧、素材 worker）经逐点核查也均先做 scope 过滤。本项补齐行为证明：新增 3 组 scope starvation 夹具（共 5 例），在 out-of-scope 候选全局分数更高时驱动 `searchSemanticImages`/`searchEmbeddingF16Cache` 仍返回 scope 内结果，并经变异验证（移除预过滤则夹具失败）；`tests/semantic-search-scope.test.cjs` 结束游离状态接入 `test:vector-pipeline`（198 通过 2 跳过），全量 `verify` 通过。相邻链确认：`VAL-035` 前提成立（DINO ANN 在 `vectorIndexService.ts:534-535` 仍于全局 annTopK 后过滤，仅由精确回退兜底避免零结果）；`VAL-036` 前提成立（缺失/空 scope 与损坏 manifest 均折叠为全库搜索，`semanticSearchService.ts:718-720`、`:1570`、`rerankService.ts:71-72`），空 scope 现有行为已被夹具钉住，VAL-036 实施时需同步更新。以提交 `2aa489b` 合入 `main` 后流转为 `verified`。

2026-08-10 `VAL-035` 实现完成：scope 以路径快照形式（`VectorSearchRequest.acceptPathKeys`，仅主进程不过 IPC）经 `HashSearchDelegate.listIndexedPaths` 枚举传入 ANN worker，在 latest-wins/active-row 构建阶段过滤，先于有界 topK 堆；快照不可用或索引为空时保持旧的谓词后过滤行为，精确 F16 回退作为安全网不变。夹具覆盖 scope starvation（8 个 out-of-scope 满分候选下 scoped topK 仍返回 2 条 scope 内结果）、精确回退 parity（路径/顺序/分数在 F16 容差内一致）与 host 转发，移除 worker 内 scope 过滤的变异使夹具失败。`test:vector-ann` 18、`test:vector-pipeline` 198 通过 2 跳过、IPC 三门禁与全量 `verify` 通过。对 VAL-028 的记录：scope 集合目前按查询 structured-clone，大索引下迁 worker 时应按 generation 共享；对 VAL-031 的记录：scope 在 `ensureLoaded` 后按请求应用，预热索引无需因 scope 失效。以提交 `e60f882` 合入 `main` 后流转为 `verified`。

2026-08-10 `VAL-027` 实现完成：未审查 ONNX 最危险的首次接触（导入检查时的 `ort.InferenceSession` 原生解析）从主进程移入一次性子进程（`userModelRuntimeChild`，`ELECTRON_RUN_AS_NODE`，JSON-lines 有界分帧），宿主 `userModelRuntimeHost` 提供 512 MiB 堆上限、加载前文件大小闸门、120 秒请求超时、崩溃/超时/输出洪泛只失败当前请求且下一请求换新子进程、SMP-009 陈旧退出忽略、退出时 dispose。导入安全闸门（确认、大小/扩展名、事务与 profile 校验）不变；打包链（vite 入口、extraResources、CORE_RESOURCES）已同步。夹具 6/6（崩溃、超时、OOM 中止、输出洪泛、畸形 ONNX、真实导入 E2E），`test:model-download` 77 通过，全量 `verify` 通过。范围说明：四处已安装（检查过）模型的推理会话仍在主进程（faceMatch/personReid/samSegment/subjectSearch），按既有分工属于 `VAL-037` 的 subject/face/person 边界隔离，可复用本次宿主生命周期并扩展 `run` 操作；注意通过导入检查的模型仍可能在 `session.run` 时行为异常，VAL-037 的 hostile tensor 夹具需覆盖。以提交 `8cba7a0` 合入 `main` 后流转为 `verified`。

2026-08-10 `VAL-037` 实现完成：face、person-ReID、SAM 与 subject detector 的已安装用户 ONNX 模型统一经 `userModelRuntimeChild` 隔离推理，新增 96 MiB 有界分帧、feed/output 结构限制、按文件签名缓存会话及空闲释放；embedding 输出在进入结果或缓存前统一执行有限值、非零范数和维度上限校验，公开结果使用 `model-missing`、`model-invalid`、`output-invalid`、`no-subject`、`input-unreadable` 显式 negative reason，持久化 subject cache 在读取时 tombstone 损坏条目并拒绝写入非法向量。实现提交 `0db62b8` 记录专项、face/person/subject/model-download、typecheck、lint、format 与全量 `verify` 均通过；接管复验 `node --test tests/subject-embedding-boundaries.test.cjs tests/user-model-runtime-isolation.test.cjs` 12/12，通过 typecheck、lint、format，完整 `verify` 的再次运行仅在 Windows 临时目录 symlink 权限处被 `test:git-policy` 的 `EPERM` 环境限制中止，未出现业务回归。提交已快进合入 `main`，任务流转为 `verified`。

2026-08-10 Native USN 现场缺陷修复：用户扫描 `D:\dataset` 时，旧 `usn_enum_files` 对整个 D: 卷枚举 320,603 条 MFT 记录并生成 78,313 个相对图片路径，没有补盘符或限定选择根目录，导致候选全部 `READ_FAIL`；旧增量读取同样只返回裸文件名。第一阶段安全修复先把子目录切到 `scoped-directory` 枚举；收到用户要求继续使用 USN 后，第二阶段改为先收集完整目录 FRN 图，再从每个图片的父 FRN 反向解析到所选根 FRN，只有确属该根目录且未穿过排除目录的候选才生成 UTF-8 绝对路径，因此子目录可继续使用 USN 而不会混入同卷其他文件。由于 USN change record 不含完整父链，增量分支目前仍使用完整 MFT 视图，优先保证路径正确。隔离回归 24/24、完整 Native 70/70、Node/Electron ABI 构建、typecheck、lint、format 均通过；非提权真实目录探针按预期报告 `volume-access-denied` 并安全回退，Windows 上真正启用 USN 仍需以管理员权限启动应用。

2026-08-11 `VAL-038` 实现完成：authoritative、delta 与 derived F16 段落统一携带提交时内容证明（size + SHA-256），消费者全部 fail-closed。新增 `electron/embeddingCacheIntegrity.ts` 统一证明原语（path+size+mtime memo，同一落盘状态只哈希一次，`[vector-integrity]` 显式信号）；authoritative 直接启用 manifest 早已钉住但读取侧从未校验的哈希（无需版本升级）；delta 升级 v3（commit 带 vectorsSha256/pathsBytes/pathsSha256，running hash 保持 append O(行)，reader/writer 双侧校验，损坏增量被 discard 而非"洗"进下一次 commit 证明，顺带修复 `recoverDeltaSegments` 非 ASCII 路径的字符/字节偏移偏差）；derived 升级 v3（meta.integrity 四段证明，三个铸造点返回 handle 前强制校验，v2 安全失效后从 JSONL 重建）；ANN worker 在索引构建/扩展前重验证明，失败经 host reject 回退 exact 搜索；CLIP 无 source 回退读取同样要求证明。bitflip 夹具 12/12（derived/authoritative/delta 位翻转 fail-closed、降级到已证明数据、writer 防洗证明、v2 安全失效、非 ASCII 回归、ANN 请求级拒绝），`test:vector-ann` 22、`test:vector-pipeline` 208 过 2 跳过、`test:asset-library` 130、typecheck/lint/format/verify 全过；接管复验新夹具 12/12 与 typecheck、test:vector-ann 通过。以提交 `a45dee6` 合入 `main` 后流转为 `verified`。遗留：校验与流式 exact 读取之间的 TOCTOU 窗口未覆盖（ANN 路径已由 worker 重验覆盖）；每段首次会话内一次全量哈希为证明的必要成本。自动队列下一项转向 `VAL-036`（Native scope 缺失/有效空库/损坏状态区分）。

2026-08-11 `VAL-036` 实现完成：Native scope 的缺失、有效空库与损坏三态显式区分（新共享类型 `NativeScopeState`，`semanticSearchScope.ts`）。`collectManifestPaths` 不再用同一 catch 折叠：manifest 不存在为 `absent`、JSON 不可解析或 segments 形状非法为 `corrupt`（`[semantic-scope]` 显式信号）、零路径为 `valid-empty`。`corrupt` 时 CLIP 文本搜索 fail-closed 早退（零结果 + degraded 原因），DINO layered 路径经 `HashSearchDelegate.getScopeState` 返回拒绝一切的 filter 与空 scope keys（等效降级 Hash-only），两条路径均禁止静默扩大为全库搜索；`absent`/`valid-empty` 保留既有全库回退但降级文案按状态区分。`imageSearchService.getImageSearchScopeState()` 懒探测实时读盘判定，mock 模式语义不变。夹具 13/13（新增 valid-empty 显式回退、corrupt 垃圾 JSON 与 malformed 形状 fail-closed 等 5 例，VAL-022 既有夹具原样通过），`test:vector-pipeline` 214 过 2 跳过，media-search/sort/shutdown/data-folders/ipc-registration 等波及套件全过，typecheck/lint/format/verify 通过；接管复验 scope+rerank 夹具 13/13 与 typecheck 通过。保守边界：segment 文件级损坏仍按 valid-empty 语义处理，避免 overlay 全删等合法空库被误判，段级证明留待后续。以提交 `1ed54cd` 合入 `main` 后流转为 `verified`。自动队列下一项转向 `VAL-028`（语义搜索 worker 化）。

2026-08-11 `VAL-028` 实现完成：CLIP 语义 F16 精确扫描迁入融合 worker。新增共享模块 `semanticClipScan.ts`（限界堆与参考扫描单源，worker 与主进程 parity 由构造保证）、`semanticVectorSearchWorker.ts`（按 cache 指纹一次性读入 base+已提交 delta 前缀 Uint16 视图，F16 经 65536 项查找表内联进点积循环，不再物化每行 Float32Array；行序/去重复用精确路径同一函数；VAL-038 证明读字节前重验；scope 按 scopeId 共享、变化才传全量 keys；SharedArrayBuffer+Atomics 每 1024 行检查取消）与 `semanticVectorSearchWorkerHost.ts`（单 worker FIFO 队列、20ms 取消轮询、5 分钟空闲回收、unref 防挂进程）。无 feedback 查询走 worker、失败自动回退进程内参考扫描，feedback 路径与 rerank 逻辑未动。78K×512 合成基准 warm P95 54ms，主进程 GC 事件 6→0、heap 增量 -13.7 MiB→+0.1 MiB，每查询的路径索引重读/逐行解码在主进程归零。夹具 7/7（位级 parity 含 delta 修订与 scoped、scope id 复用协议、证明不符拒绝、预置/排队/中途取消），test:vector-ann 29、test:vector-pipeline 214 过 2 跳过，typecheck/lint/format/verify 通过；接管复验新夹具 0 失败与 typecheck 通过。边界：复用快照对磁盘后续损坏不重复重验（reload 必重验，与 ANN worker 语义一致）；host 二次归一化理论漂移 ~1e-14 远小于 F16 容差。以提交 `04377cd` 合入 `main` 后流转为 `verified`。自动队列下一项转向 `VAL-029`（Electron/AI 安全加固）。

2026-08-11 `VAL-029` 实现完成：主 Session 权限双 handler deny-default（`sessionSecurity.ts`，白名单为空冻结数组，拒绝时显式 warn）；renderer CSP 收紧（media-src/worker-src/manifest-src 'self'、frame/child-src 'none'、connect-src 仅 'self' 与 dev ws，无 http(s) 外联）；IPC origin 新增 `createRendererFrameUrlTrust`——打包态仅信任 app 目录内 file:（path.relative 防逃逸），dev 态必须精确等于 dev-server origin，不再放行任意 loopback 端口；AI 控制 API 新增 `AiControlAuthFailureGuard`（8 次失败/10 分钟滑窗/5 分钟锁定，429 auth_locked，堵上原 rate bucket 只计已认证请求的 pre-auth 暴力破解缺口）与 `AiControlSseLimiter`（全局 8、单地址 4，超限 429 sse_concurrency_limit）。夹具 18/18（权限/CSP/origin 矩阵/接线顺序、注入时钟的锁定与窗口过期、limiter 上限与释放），test:guards 36、test:settings 46、ipc-validation/registration/preload-contract 全绿，typecheck/lint/format/verify 通过；接管复验新夹具 18/18 与 typecheck 通过。以提交 `0013e92` 合入 `main` 后流转为 `verified`。

2026-08-11 `VAL-031` 实现完成：authoritative generation 就绪即预热 DINO ANN，首次相似搜索不再付全量构建。新增 `annPrewarmService.ts`（按 source-snapshot fingerprint 去重，成功粘性、失败可重试）与 `openAuthoritativeEmbeddingF16Cache`（不在主线程哈希文件，句柄携带 manifest 钉死的 VAL-038 证明）；ANN worker 新增 `prewarm` 请求，走与 search 完全相同的 ensureLoaded（含完整性门）只跳过候选打分，预热索引与按需构建字节一致；host 低优先级设计——真实搜索抢占进行中预热，搜索中预热单槽排队，同 generation 并发共享请求。触发点：迁移 CURRENT 原子切换后与 app 启动（fire-and-forget 不阻塞）。夹具 6/6（去重/重试/复位、真实迁移驱动触发、字节级 parity、抢占/排队/去重、16K×64 benchmark 首查 cold 112.9ms→warm 22.7ms），test:vector-ann 35、test:vector-pipeline 214 过 2 跳过，typecheck/lint/format/verify 通过；接管复验新夹具 6/6 与 typecheck 通过。以提交 `a59e999` 合入 `main` 后流转为 `verified`。自动队列下一项转向 `VAL-033`（IPC/构建热点拆分）。

2026-08-11 `VAL-033` 实现完成：临界 IPC contract 与超大高频模块纯结构性拆分 + 层级/构建图治理落地。`shared/ipc-contract.ts` 944→221 行瘦身成纯 barrel，305 成员 `ElectronAPI` 迁入 `shared/ipc/electron-api.ts`（成员 parity 305/305，仅一处动态自引用改直引）；`imageSearchService.ts` 1930→1639 行，Native* 类型抽至 `imageSearchNativeTypes.ts`。新增 `check-layering.cjs`（三层依赖规则，330 模块 0 违规）与 `check-build-graph.cjs`（entry 可达性、shared 无环、entry 模块数预算 main=207/preload=15/renderer=120、热点模块行预算只降不升），挂入新套件 `test:architecture`（test 链 test:guards 之后）；preload-contract 增加 contract 预算断言。全部套件与 verify 通过；接管复验 test:architecture、preload-contract 2/2 与 typecheck 通过。以提交 `b8297ba` 合入 `main` 后流转为 `verified`。自动队列下一项转向 `VAL-032`（召回观测内存优化）。

2026-08-11 `VAL-032` 实现完成：VAL-003 召回观测计算迁入低优先级 worker（`vectorGenerationRecallWorker.ts` + Host，沿用 vectorAnnWorkerHost 契约：单活动评估、supersede、SharedArrayBuffer 协作取消、unref 5 分钟空闲回收；host 无 electron 依赖，plain-node 观测脚本复用），`verify-vector-generation-recall.cjs` 走 worker 并在 gate 源码新于 bundle 时用 esbuild 兜底重建。内存上限 `memoryCeilingBytes`（默认 256 MiB）：超限后归一化源行 spill 到 scratch 文件、latest-wins 压实，精确 F32 扫描按 8192 行分块流式（一次分块覆盖全部采样查询，行范数只算一次），不再物化全量矩阵；未变化源按 fingerprint 复用验证矩阵（--matrix-cache-dir/--no-matrix-cache/--memory-ceiling-mb）。内存基准（100k×128 合成）：峰值 RSS 增量 150→52 MiB，指标逐位一致。夹具 22 项（核心 +5、worker +2），test:vector-ann 37、test:vector-pipeline 219 过 2 跳过、test:architecture 332 模块无违规（新 worker entry=7）、typecheck/lint/format 干净；接管复验召回测试 20/20、test:architecture 通过、全量 `npm run verify` exit 0。实现代提交 `4344f5a`（代理完成代码与验证后离场，提交动作由接管方按同一 hook 格式完成）。以该提交合入 `main` 后流转为 `verified`。

2026-08-11 经用户明确授权执行 DINO authoritative generation 迁移：`npm.cmd run vector-store:migrate -- "%APPDATA%\floating-clock-electron" --execute`，两个模型（CLIP 512d / DINO 768d）全部完成，写入 760 MB，0 错误，新 generation `20260811114205797-5fd15010`。迁移后 `verify-vector-generation-recall.cjs --snapshot-only` 确认 CLIP（57,953 条）与 DINO（411,636 条）快照均 `ready: true` 且与源记录数一致，VAL-003 周期计数的技术前提已恢复，三个 ≥24 小时稳定周期由计划任务 `Reasonix-VAL003-Observations` 自动累计。
