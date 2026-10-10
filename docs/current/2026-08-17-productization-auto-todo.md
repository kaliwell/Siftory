# Siftory 软件产品化自动优化 TODO

> 状态：当前  
> 实施状态：自动任务完成；人工门禁待处理  
> 更新日期：2026-08-19  
> 范围：首次启动、模型与任务、数据源、统一搜索、播放器、导出、恢复、性能与 UI  
> 替代文档：无  
> 执行系统：Codex  
> 所有者：Codex/root  
> 模型：GPT-5 系列；精确内部小版本不可见  
> 选择命令：`npm.cmd run todo:productization-next`  
> 结构校验：`npm.cmd run todo:productization-check`

## 目的与范围

本清单把用户选择硬盘或 NAS、观察模型与建库进度、断点恢复、多模态搜索、时间点证据、打开与剪辑导出，以及相邻的软件产品化缺口，转换成可按依赖自动领取的工程任务。

事实基线来自[2026-08-19 全项目多维审计与整改](../audits/2026-08-19-full-project-multidimensional-audit.md)、[商业发布准备专项](2026-08-17-commercial-release-readiness.md)、[既有产品自动 TODO](2026-08-12-product-followup-auto-todo.md)和[视频语义剩余 TODO](2026-08-15-video-semantic-remaining-auto-todo.md)。[2026-08-17 全项目复审](../audits/2026-08-17-full-project-audit.md)作为历史快照保留。本清单只处理软件功能、稳定性、性能和体验，不把商标、著作权、签名证书或商店审批写成已完成的软件任务。

## 自动执行规则

1. `auto` 项按“恢复半成品优先、价值降序、依赖已验证”自动领取；实现、定向测试、类型检查、Lint、格式门禁和文档证据全部通过后才能标记 `verified`。
2. 自动任务不得静默下载大模型、扫描未授权目录、修改真实素材、连接真实 NAS/SFTP、关闭系统、签名发布或上传数据。
3. 所有破坏性维护必须先提供预览、精确范围、确认和可恢复路径；搜索、索引和模型错误必须保留可操作原因，不能只显示“失败”。
4. `approval` 项和带 External blockers 的任务只记录等待条件，不进入自动代码队列，也不得用夹具结果替代真实验收。
5. 任务状态由本表和选择器共同决定；新增任务必须保持价值降序、依赖无环、ID 唯一并通过结构测试。

## 机器可读任务表

| Rank | ID      | Value | Mode     | Dependencies                       | External blockers                                             | Branch                                      | Status   | Validation                                                            | Task                                                                                                                           |
| ---: | ------- | ----: | -------- | ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
|    1 | VAL-401 |   100 | auto     | -                                  | -                                                             | `feat/product-readiness-model`              | verified | test:productization + typecheck + eslint + prettier                   | 聚合数据源、目录、DINO/CLIP、视频抽帧、Qwen3-VL 和 SenseVoice 状态，统一判断可搜索能力、降级原因与下一动作                     |
|    2 | VAL-402 |    98 | auto     | VAL-401                            | -                                                             | `feat/setup-center-ui`                      | verified | component contract + i18n + renderer build                            | 增加首次准备中心，在一个界面显示总体就绪度、六阶段状态、当前可搜索能力和一个明确的下一步                                       |
|    3 | VAL-403 |    96 | auto     | VAL-402                            | -                                                             | `feat/model-lifecycle-actions`              | verified | guarded model actions + failure fixtures                              | 统一显示 DINO、CLIP、Qwen3-VL 和 SenseVoice；直接管理 DINO/CLIP 的下载、校验、修复、取消与删除，外置运行时只导航到显式安装入口 |
|    4 | VAL-404 |    94 | auto     | VAL-401                            | -                                                             | `feat/unified-task-inventory`               | verified | task projection + persistence + restart fixtures                      | 聚合数据源扫描、缩略图、图片向量、视频抽帧、深层视频语义和音频语义为统一持久任务清单                                           |
|    5 | VAL-405 |    92 | auto     | VAL-404                            | -                                                             | `feat/task-center-ui`                       | verified | task center UI + i18n + restart smoke                                 | 任务中心显示阶段、进度、速度、预计时间、磁盘占用、错误、暂停、恢复和重试，并在面板重开与程序重启后恢复                         |
|    6 | VAL-406 |    90 | auto     | VAL-401                            | -                                                             | `feat/source-health-center`                 | verified | source probes + root repair + offline fixtures                        | 数据源健康中心显示本地、移动盘、挂载 NAS 与 SFTP 的可用性、最近成功时间、断线原因、重连与根路径修复                            |
|    7 | VAL-407 |    88 | auto     | VAL-401                            | -                                                             | `feat/unified-search-filters`               | verified | request guards + recall fixtures + UI                                 | 统一搜索增加媒体类型、来源、日期、时长、方向和已建索引能力筛选，并保持简单模式可用                                             |
|    8 | VAL-408 |    86 | auto     | VAL-407                            | -                                                             | `feat/search-evidence-cards`                | verified | evidence projection + UI contract                                     | 结果卡统一展示命中类型、原文或描述、时间范围、置信度、模型来源与降级提示                                                       |
|    9 | VAL-409 |    84 | auto     | VAL-408                            | -                                                             | `feat/search-feedback-ranking`              | verified | feedback persistence + deterministic rerank                           | 增加相关、不相关和时间点错误反馈，进行仅本地保存、可撤销、可解释的个人排序校正                                                 |
|   10 | VAL-410 |    82 | auto     | VAL-408                            | -                                                             | `feat/player-hit-navigation`                | verified | player guard + aspect matrix + smoke                                  | 播放器显示命中范围与上下文，支持上一处、下一处、字幕证据、快捷键和横竖屏完整显示                                               |
|   11 | VAL-411 |    80 | auto     | VAL-408                            | -                                                             | `feat/search-results-export`                | verified | CSV and JSON fixtures + path guards                                   | 将选中搜索结果按受控字段导出 CSV 或 JSON，包含文件身份、时间范围、证据和查询信息                                               |
|   12 | VAL-412 |    78 | auto     | VAL-410; VAL-411                   | -                                                             | `feat/edl-export`                           | verified | CMX3600 fixtures + import smoke                                       | 导出可供 Premiere 和 DaVinci Resolve 导入的 CMX3600 EDL，并明确帧率与越界处理                                                  |
|   13 | VAL-413 |    76 | auto     | VAL-412                            | -                                                             | `feat/fcpxml-export`                        | verified | FCPXML schema fixtures + import smoke                                 | 导出 FCPXML 时间线，保留素材路径、入出点和证据标记                                                                             |
|   14 | VAL-414 |    74 | auto     | VAL-406                            | -                                                             | `feat/incremental-source-watch`             | verified | watcher + stale invalidation + reconnect fixtures                     | 数据源增删改后增量更新目录并把受影响派生索引标为 stale，断线期间不误删记录                                                     |
|   15 | VAL-415 |    72 | auto     | VAL-404                            | -                                                             | `perf/resource-governor`                    | verified | resource policy + cancellation + pressure fixtures                    | 增加省电、均衡和高质量资源策略，统一限制 CPU、GPU、内存、显存、磁盘与后台并发                                                  |
|   16 | VAL-416 |    70 | auto     | VAL-404; VAL-415                   | -                                                             | `test/product-fault-matrix`                 | verified | deterministic fault matrix                                            | 建立进程退出、任务子进程崩溃、磁盘满、模型损坏、来源离线和重启的确定性故障注入矩阵                                             |
|   17 | VAL-417 |    68 | auto     | VAL-401; VAL-416                   | -                                                             | `feat/health-repair-center`                 | verified | redaction + health report + repair fixtures                           | 提供隐私脱敏健康报告、索引一致性检查和分层修复动作，不暴露用户绝对路径或凭据                                                   |
|   18 | VAL-418 |    66 | auto     | VAL-402; VAL-405; VAL-408; VAL-410 | -                                                             | `refactor/product-information-architecture` | verified | simple advanced parity + keyboard + viewport matrix                   | 收敛横向和窄屏面板布局，保证简单与高级模式入口等价、空状态清楚、快捷导航稳定且键盘可达                                         |
|   19 | VAL-419 |    64 | auto     | VAL-402; VAL-403; VAL-405; VAL-406 | -                                                             | `feat/first-run-guided-path`                | verified | fresh profile smoke + cancel resume fixtures                          | 首次启动按添加来源、准备模型、开始建库和首次搜索形成可跳过、可恢复的最短引导路径                                               |
|   20 | VAL-420 |    62 | auto     | VAL-416; VAL-417; VAL-419          | -                                                             | `test/install-upgrade-recovery`             | verified | clean install + upgrade + rollback fixtures                           | 自动验证干净安装、旧数据升级、索引迁移失败回滚、卸载保留策略和诊断导出                                                         |
|   21 | VAL-423 |    61 | approval | VAL-403                            | Qwen3-VL 与 SenseVoice 最终分发许可、下载同意文案和安装源策略 | `feat/external-model-one-click-installer`   | blocked  | signed manifest + consent + cancel + rollback + clean-machine install | 为 Qwen3-VL 与 SenseVoice 外置运行时提供最终用户一键安装、校验、取消、修复和卸载；未批准前不得自动下载                         |
|   22 | VAL-421 |    60 | approval | VAL-406; VAL-414; VAL-416          | 可控 NAS/SFTP、断线设备、权限账户与干净 Windows 测试机        | `ops/real-source-resilience`                | blocked  | real disconnect + reconnect + permission + throughput report          | 在真实 NAS、SFTP 和移动盘上验收断线、重连、权限、吞吐、休眠唤醒和中断恢复                                                      |
|   23 | VAL-422 |    58 | approval | VAL-407; VAL-408; VAL-409; VAL-410 | 人工标注的真实查询相关性、证据和时间点真值                    | `ops/product-search-acceptance`             | blocked  | Recall@K + timestamp error + evidence acceptance                      | 对自然语言、图片、对白和混合查询执行真实 Recall@K、时间误差和命中依据人审                                                      |

## 当前领取

`VAL-401` 至 `VAL-420` 已验证。选择器当前不再领取自动任务；`VAL-421`、`VAL-422` 和 `VAL-423` 保持人工门禁，不会被自动队列误领。

## 已完成

### VAL-401 统一产品就绪度模型

- 新增 `src/services/productReadiness.ts`，把六套既有状态投影成稳定的阶段状态、0–100 进度、可搜索能力和单一下一动作。
- 元数据目录可用但语义模型未安装时明确为 `searchable`，不把整个产品误报为不可用；来源离线但旧目录仍在时明确为 `degraded`。
- 不执行模型下载、素材扫描或真实数据写入，适合首次启动界面、任务中心和健康报告复用。
- `tests/product-readiness.test.cjs` 覆盖空安装、扫描中、元数据降级搜索、来源离线、全部就绪、运行器故障和部分索引恢复。

### VAL-402 首次准备中心

- 顶部快捷导航的“任务”菜单现包含统一准备中心；关闭再打开后重新读取主进程权威状态，不依赖图片或视频面板的临时组件状态。
- 同屏展示总体状态与进度、六个准备阶段、六类当前可搜索能力，以及按依赖排序的唯一下一步按钮。
- 下一步会受控导航到数据源、图片搜索或视频搜索面板；状态读取失败会明确标记 `unavailable`，不会永久伪装成加载中。
- 720px 以上显示三列阶段卡，窄屏降为两列并允许安全滚动；所有可见文本均进入中英文翻译门禁。

### VAL-403 统一模型管理入口

- 准备中心的模型管理区同时显示 DINOv2、CLIP、Qwen3-VL 和 SenseVoice 的真实状态与下载进度。
- DINO/CLIP 复用既有受控 IPC，提供显式下载、校验、损坏后重下、取消和移除；下载与删除都必须由用户点击并确认，组件挂载和自动测试不会触发。
- Qwen3-VL 与 SenseVoice 继续遵守外置运行时边界，只导航到视频面板查看状态和安装说明；最终用户一键安装拆为 `VAL-423` 人工批准项，未把分发许可或下载同意写成已完成。

### VAL-404 统一任务清单

- `src/services/productReadiness.ts` 现把数据源扫描、图片索引、缩略图、图片向量、视频抽帧、深层视频语义与音频语义投影为统一任务结构。
- 每个任务保留稳定 ID、阶段、状态、完成/失败/总数、速度、预计时间、当前条目、错误与可暂停/恢复/停止能力；活动任务优先，其余按更新时间和稳定 ID 排序。
- 任务清单只读取各主进程持久任务权威状态，不在组件内复制生命周期；相同状态序列化后重建可得到完全一致结果。
- `tests/product-readiness.test.cjs` 覆盖全部七类任务、活动任务排序、速度/预计时间、恢复能力和重启投影一致性。

### VAL-405 统一任务中心

- 准备中心内新增统一任务中心，同屏展示七类任务的状态、进度、完成/失败/总数、速度、预计时间、当前项目和明确错误。
- 暂停、恢复、停止与重试均由用户点击后调用任务所属的主进程权威 API；需要路径或策略的重试只跳转到对应配置面板，不猜测用户输入。
- 中心每 2.5 秒及面板重开时重新读取主进程状态；持久任务明确标记“重启后可恢复”，当前仅内存维护的任务明确标记“仅本次运行”。
- 图片数据与视频缓存占用集中显示，读取失败时显示“状态不可用”，不伪造为 0；控件和双栏/单栏任务布局均通过静态与 Renderer 构建门禁。

### VAL-406 数据源健康中心

- 数据源列表新增健康摘要，区分本地、移动盘、挂载网络、SFTP 与 NAS 代理，并显示当前可用性和实际扫描能力。
- 所有来源均提供用户触发的“检查连接/重新连接”，探测结果与主进程持久可用性合并显示；不在后台静默连接远程来源。
- 每个来源显示最近成功扫描、最近尝试和探测/扫描失败原因；来源离线时继续保留目录数量与容量，不误导为数据丢失。
- 挂载网络盘继续提供根路径修复，并复用既有绝对路径、越界、重复来源和抽样文件身份校验；SFTP 不伪装成本地路径修复。
- `tests/product-source-health.test.cjs` 覆盖在线探测、网络盘离线保留、SFTP 降级结果覆盖和界面动作绑定。

### VAL-407 统一搜索筛选

- 主进程统一请求现在受控接收媒体类型、来源、修改日期、时长、画面方向和索引能力筛选，数组值使用白名单、范围值有边界并自动纠正反向区间。
- 筛选在各召回通道合并、目录身份回填和索引级别计算后执行，再进行排序与分页；不会只筛当前页，也不会让 Renderer 猜测来源或索引状态。
- 图片与视频尺寸、视频时长由资产库和视频清单权威元数据补齐；横屏、竖屏与方形判定在主进程完成，缺少尺寸的条目不会伪造方向。
- 简单模式直接显示全部核心筛选和一键清除，不藏在高级折叠区；`tests/product-unified-search-filters.test.cjs` 覆盖请求守卫、筛选谓词、分页顺序和界面入口。

### VAL-408 统一命中依据卡片

- 每条结果现在由主进程附带有界的依据列表，统一区分文件名、图片语义、主体、重复项、视频画面、视频语义、对白和多源融合命中；Renderer 不根据自由文本或分数猜测来源。
- 依据卡显示原文或描述、命中时间范围、0–100% 置信度、证据来源、模型 ID/版本及结果级降级原因；纯元数据与规则结果明确标记，不伪造 AI 模型。
- 相近的视频画面、OCR、深层语义、字幕、ASR 和音频事件仍在主进程融合，融合卡保留全部受控来源与模型身份，单独的时间跳转按钮保持可用。
- `tests/product-search-evidence.test.cjs` 覆盖置信度边界、模型权威、融合时间范围、证据来源、Renderer 只读展示和降级文案映射。

### VAL-409 本地反馈与个人排序

- 统一结果卡提供“相关”“不相关”和视频“时间点错误”动作；反馈由受控 IPC 写入用户数据目录，保存查询指纹与稳定文件身份，不保存查询原文或绝对路径。
- 同一查询与结果的最新相关性反馈确定性生效：相关结果获得有界提升，不相关结果明显降级；时间点错误提供小幅排序惩罚，并在有其他候选时自动把下一处命中设为默认打开位置。
- 每条被修正的结果显示原因和精确修正值，反馈保存后可立即撤销；写入采用串行原子替换，失败时回滚内存状态，不把未落盘反馈误报为成功。
- `tests/product-search-feedback.test.cjs` 覆盖输入守卫、本地重启恢复、隐私字段、撤销、同毫秒确定性、时间候选切换、排序校正和简单模式 UI。

### VAL-410 播放器命中导航

- 统一搜索打开视频时会向沙箱播放器传递最多 32 个经主进程二次校验的命中，播放器显示当前序号、命中类型、起止时间、查询、对白/描述与证据来源。
- 播放器支持上一处、下一处按钮，以及 `Alt+←`、`Alt+→`、`[`、`]` 快捷键；时间范围在进度标记条中显示，错误时间点反馈选出的替代命中会成为默认位置。
- 播放器现提供独立入点/出点数值框、范围滑块、可点击/键盘操作的选区时间线、命中范围复用和循环预览；`I` / `O` 直接设置当前入点/出点，边界支持按毫秒或所选帧率逐帧精调。
- 播放器始终使用 contain 布局并根据真实视频尺寸计算渲染矩形；横屏、竖屏、方形与超宽比例均保证完整画面，窗口调整后重新计算，不再裁掉竖屏上下内容。
- 输入守卫、比例矩阵、DOM 安全渲染、键盘入口、Renderer/主进程构建及隐藏 Electron 真实 seek 冒烟均通过；1.250 秒目标实际落在 1.257 秒。

### VAL-411 搜索结果 JSON/CSV 导出

- 简单模式可对已勾选结果直接导出 JSON 或 CSV；Renderer 不接收写入路径，主进程重新按白名单投影字段，并只写入系统保存对话框返回的绝对路径。
- 导出包含文件/资产/视频稳定身份、素材名称与路径、来源、修改时间、尺寸、时长、索引状态、降级原因、分数、查询信息及每条证据的类型、原文、时间范围、置信度和模型。
- JSON 使用版本化 `siftory-unified-search-export/v1` 结构；CSV 每条证据一行，带 UTF-8 BOM、RFC 风格引号转义和 Excel 公式注入防护。
- 参考图片仅导出“已使用”布尔值，不泄露参考图绝对路径；测试同时确认任意额外字段、内部 scoreBreakdown 与个人反馈记录不会被顺带写出。

### VAL-412 CMX3600 EDL 导出

- 简单模式提供显式时间线帧率选择与“导出 EDL”入口；主进程只接受 23.976、24、25、29.97、30、50、59.94 和 60 fps，并通过系统保存对话框写入 `.edl`。
- 受控播放器复用同一帧率白名单和验证器，可把手动入点/出点直接投影成单素材 CMX3600 EDL；播放器 Renderer 只持有绑定窗口与源视频的临时导出 token，不接收或提交任意源路径。
- 导出器按素材时长约束入出点，跳过非视频、无时间依据和不可用区间，去重相同片段，并向用户返回导出、越界修正和跳过数量。
- CMX3600 事件保留素材名、来源和命中依据注释；29.97/59.94 使用 drop-frame 分号时间码，其余使用 non-drop 时间码，时间线从 01:00:00 开始。
- 帧率边界、drop-frame 换算、越界/跳过、事件去重、格式验证和简单模式保存路由均由 `tests/product-edl-export.test.cjs` 覆盖。

### VAL-413 FCPXML 时间线导出

- 简单模式复用显式时间线帧率，新增受控“导出 FCPXML”入口；主进程生成并验证 FCPXML 1.11 后才允许通过系统保存对话框写入 `.fcpxml`。
- 受控播放器可把当前选区导出为引用原始本地素材的单片段 FCPXML；保存前继续执行既有结构验证、Windows 路径 URI 编码和 XML 转义。
- 23.976、29.97 和 59.94 fps 使用精确的 `1001/24000s`、`1001/30000s` 和 `1001/60000s` 帧时长，其余帧率同样以帧整数投影，避免浮点时间漂移。
- 时间线保留本地素材 `file://` URI、源入出点、画面尺寸与每个命中的证据 marker；Windows 中文路径和 XML 特殊字符均经过 URI 编码与属性转义。
- 非视频、远程未取回、无时间依据和越界无效项会明确跳过；重复区间去重，越界片段截断，并返回导出、截断与跳过数量。格式结构、资源引用和标记完整性由 `tests/product-fcpxml-export.test.cjs` 验证。

### VAL-414 数据源增量监听

- 本地盘、移动盘与挂载网络来源注册后由主进程启动非持久递归 watcher，变更按来源去抖合并并限制为最多 2048 个路径；应用退出、来源删除和根路径修复时均关闭旧 watcher。
- 新增或修改文件直接增量写入 Discovery Catalog；同一文件内容变化时把 metadata、preview、hash 与 image embedding 等全部既有派生阶段标为 `stale`，目录事件进行有界补扫。
- 删除采用可恢复 tombstone 并从普通搜索和打开动作中隐藏；只有变更批次前后两次确认来源根仍在线才会标记缺失，断盘、网络离线或权限错误不会把保留目录误删。
- 来源健康卡显示监听中、离线暂停、不支持或错误状态，以及待处理数量和最近增量更新时间；重新探测成功后重建 watcher 并复用原目录身份。
- `tests/product-incremental-source-watch.test.cjs` 覆盖增改删、全部派生索引失效、路径越界拒绝、断线保留、重连恢复和 watcher 清理。

### VAL-415 统一资源治理

- 统一调度器新增“省电、均衡、高质量”三档持久策略，分别约束本地并发、GPU 并发、磁盘 I/O 并发、最大排队量、CPU 目标、进程工作集及最低空闲内存/显存/磁盘空间。
- 主进程每 5 秒使用 Node/Electron 内建接口采样 CPU、系统内存、进程 RSS、用户数据盘空间与电池状态，不启动 PowerShell、远程控制或额外硬件扫描进程。
- 资源压力存在时，P3/P4 后台建库任务留在队列，P0–P2 显式或可见区域任务仍能响应；压力恢复后自动继续。用户可在任务中心显式取消所有排队中的后台任务。
- 资源策略通过受控 IPC 修改并原子保存为版本化 `resource-governor.json`；任务中心显示当前策略、有效本地/GPU 并发及暂停原因，应用退出时停止采样计时器。
- `tests/product-resource-governor.test.cjs` 覆盖策略预算、压力暂停/恢复、前台保活、动态并发、显式取消、电池模式、持久化损坏回退与 UI/IPC 路由。

### VAL-416 确定性故障注入矩阵

- 新增无生产故障开关的 `siftory-product-fault-matrix/v1` 恢复契约，固定覆盖进程退出、任务子进程崩溃、磁盘满、模型损坏、来源离线和应用重启六类故障，并要求每项给出稳定处置结果与修复动作。
- 进程退出用真实 Node 子进程在持久化运行中租约后退出，重启端确认过期租约重新排队；独立的重启用例还验证同一快照恢复结果一致，旧 epoch/owner 的迟到结果不能提交。
- 子进程崩溃用真实隔离模型工作进程退出码验证当前请求失败但主进程存活，下一请求会创建全新子进程；没有向 Renderer、IPC 或正式包暴露注入入口。
- `ENOSPC` 在真实 JSONL 事务阶段写入边界注入，验证未发布事务完整回滚、权威文件和内存状态均保持旧值且无日志/阶段孤儿；损坏的 SenseVoice 文件在启动运行器前被完整性预检拒绝。
- 来源根离线用真实 Discovery Catalog 验证目录仍可查询、不产生缺失 tombstone；`tests/product-fault-matrix.test.cjs` 汇总六项观察并拒绝缺项、重复项或任何弱化的数据保护证据。

### VAL-417 隐私脱敏健康与分层修复中心

- 新增稳定的 `siftory-product-health/v1` 健康报告契约，统一呈现来源连通性、目录一致性、向量索引、托管模型、任务运行态与用户数据盘空间；报告仅包含有界状态和计数，不包含来源名称、绝对路径、查询、素材名或凭据。
- Discovery Catalog 增加 SQLite `quick_check`、外键、孤儿记录、缺失 discovery 状态、非法索引状态、missing/stale/failed 聚合检查；所有检查由主进程读取权威状态，Renderer 不拼装诊断事实。
- 健康中心把动作分为安全检查、可重建修复和破坏性维护；当前报告未提供的动作不能调用，需要确认的取消后台任务与派生数据重置不能绕过确认，重置仅导航到设置中的既有预览流程。
- 脱敏器覆盖 Windows、POSIX、UNC 路径、URI、邮箱、IPv4 和常见凭据字段；导出前再次执行 fail-closed 字段审计，并通过准备文件与事务提交写入用户主动选择的位置，返回结果不回传绝对路径。
- `tests/product-health-repair.test.cjs` 使用真实临时 SQLite 验证一致性聚合，并覆盖报告确定性、脱敏、动作可用性、确认门禁、修复路由以及 Renderer/Preload/Main 接线；产品化测试累计通过 `77/77`。
- 资源治理持久化和健康/修复 IPC 使主进程可达图由 VID-017 时的 262 个模块增至 273 个；架构门禁把 273 设为新的精确上限，后续再增加任一可达模块仍会失败并要求复审。

### VAL-418 产品信息架构与响应式交互

- 图片和视频搜索把选择来源、准备素材库、图片查询与自然语言查询定义为简单/高级模式共同的核心动作；高级模式只增加扫描、模型、后端和维护参数，不再移除简单模式的最短入口。
- 搜索模式切换采用 `radiogroup`、roving `tabIndex`、方向键/Home/End 导航和可见焦点；顶部快捷导航支持方向键移动焦点、Escape 收起菜单，移动手柄支持方向键微调与 Home 复位。
- 图片、视频、统一搜索新增可翻译的标题式空状态和下一步说明；视频结果把缩略图、元数据和操作分组，统一搜索结果的操作区可换行，避免窄面板把中文按钮压成竖排。
- 320、480、560、720、979、980、1050 和 1440 宽度形成可执行布局矩阵：紧凑/堆叠模式限制控制区高度并保留独立结果区，宽面板切换为控制栏加结果栏；快捷导航在视口内有界并允许横向滚动。
- 2026-08-18 关闭顶部导航卡顿与残影回归：拖动期间只更新独立合成层的 `translate3d`，松手后一次性提交持久位置；交互期停止重复 DOM 测量和原生 Shape IPC，并暂停透明模糊。任务中心展开时不再与首次引导同时占用大型内容区；工作区根改用 `overflow: clip`，阻止焦点自动滚动造成的无滚动条位移。
- `tests/product-information-architecture.test.cjs` 覆盖模式动作等价、键盘环绕、视口无间隙、三类空状态和结果分组；隔离 Electron 在中文、1366×768、125% 缩放下通过真实 DOM、双语、焦点、裁切和导航验收，产品化测试累计通过 `83/83`。

### VAL-419 可跳过、可恢复的首次启动引导

- 新增四步首次启动路径：添加来源、准备 DINO/CLIP 托管模型、构建首个素材库、完成首次搜索；步骤直接读取准备中心的主进程权威快照，已完成进度单调保留，短暂断盘或状态读取失败不会让用户倒退。
- 引导只持久化版本、状态、步骤 ID、首次搜索布尔值和更新时间，不写入路径、文件名、查询词、模型输出或凭据；设置通过共享串行写入器立即原子落盘，退出或重启后可恢复。
- 用户可“暂时跳过”，并从顶部“任务 → 开始使用”重新打开；每一步受控导航到数据源、模型管理、素材库准备或统一搜索入口，不会因组件挂载自动扫描目录或下载模型。
- 统一、图片和视频搜索只在真实搜索 API 成功返回后发送无内容的完成事件；失败或取消不计为首次搜索。已有可搜索数据的旧配置会静默迁移为已完成，避免升级后打扰现有用户。
- `tests/product-first-run-guide.test.cjs` 覆盖全新配置、逐步推进、跳过、序列化重启、恢复、旧配置迁移、输入边界与隐私；隔离 Electron 在中文、1366×768、125% 缩放下真实验证首次显示、四步结构、跳过隐藏、任务菜单重开和持久化恢复，产品化测试累计通过 `89/89`。

### VAL-420 安装、升级与恢复矩阵

- 新增稳定的 `siftory-install-upgrade-recovery/v1` 验收契约和 `npm.cmd run verify:install-upgrade-recovery`，五项缺失、重复或任一数据保护条件弱化都会使报告失败。
- 干净安装夹具验证稳定用户数据目录、设置原子写入和空 SQLite 素材库；旧数据升级夹具验证未知设置、来源路径和旧 JSONL 原件保留，并对导入后的 SQLite 数据执行哈希核验。
- 索引迁移先生成可用权威 generation，再在确定性异常下注入失败；验收要求 `CURRENT` 字节级不变、活动 generation 不变且 staging 目录完全清理。
- Online/Offline 安装配置均验证当前用户安装和卸载保留数据；诊断导出复用正式脱敏器与事务提交，拒绝绝对路径泄漏及残留 `.part`/transaction 文件。
- 全链只在 `os.tmpdir()` 下创建隔离目录，结束前校验临时根边界后清理，不读取或修改真实 AppData、素材目录和索引；机器可读报告写入 `artifacts/install-upgrade-recovery/report.json`，产品化测试累计通过 `92/92`。
- 最终全量回归同时修复了 `semantic-search-scope` 夹具未释放语义向量 worker 导致测试进程不退出的问题，并把挂载网络根修复的旧 UI 断言更新为验证集中后的 `canRepairRoot` 权威字段；不是通过延长超时或复制业务条件掩盖失败。

## 2026-08-19 后续产品化补充

### 播放器精确片段导出

- 播放器可将至少 40 毫秒的有效选区通过 FFmpeg 精确重编码为 H.264/AAC MP4，使用私有 `.partial` 临时文件完成后再写入用户选择的目标；目标不得覆盖源视频，失败或取消后执行尽力临时清理。
- 导出授权绑定播放器 `webContents`、源视频和随机 token；主进程在每次导出前重新检查源文件，只接受有界整数时间和固定格式/帧率，并拒绝同一播放器并发导出。
- `tests/media-player-export.test.cjs` 覆盖请求守卫、EDL/FCPXML 验证、真实 4 秒测试视频的 1.5 秒 MP4 导出、可调入点/出点、逐帧精调、循环选区以及 Renderer 不接收任意源路径。

### 图片搜索结果兼容拖拽

- 图片搜索结果默认通过受控原生拖拽 token 传递文件。WebP、AVIF、SVG、AI、PDF 等旧版 Photoshop 风险格式会优先使用已有项目预览或有界 PNG 兼容缓存；PSD/PSB、JPG、PNG 和 TIFF 仍默认传递原文件。
- 用户按住 Shift 开始拖动时强制传递原始文件，避免兼容预览丢失矢量、图层或文档语义；兼容预览生成失败也安全退回原文件。
- 兼容缓存最多保留 256 个文件或 512 MiB，按访问时间清理；拖拽前重新核对源文件大小和修改时间，过期能力或来源变化会拒绝操作。
- `tests/file-drag.test.cjs` 覆盖单 Renderer 授权、能力过期与容量淘汰、源指纹复核、兼容扩展名、Shift 原图模式和 Preload 边界。

### 全窗口一致性、任务恢复与文件管理排序

- 14 个主面板的 `panelId`、DOM ID、可见性键、位置键和尺寸键改为读取共享身份表；Settings 聚焦、Workspace Navigator、Linked Move 和 UI 冒烟不再维护互相漂移的手写映射。
- Duplicate Finder 和 Remote Terminal 隐藏时保留挂载，避免活动扫描或 SSH 会话丢失；Duplicate Finder 可在重新进入时恢复已完成结果。
- Batch Rename 在启动任务前建立进度订阅并读取权威进度/结果，关闭快速任务完成后 UI 仍停留在运行态的竞态；输入阈值、冲突枚举和三个目录边界由主进程验证。
- File Manager 的大小排序冻结用户点击时的显示快照；文件夹大小后续进度继续更新显示，但不会自动移动用户正在浏览或选择的行。
- File Manager resize RAF、Image Search 通知计时器和 Batch Rename 进度监听均在替换或卸载时释放。

## 验收定义

1. 用户任何时候都能知道“现在能搜什么、正在做什么、下一步是什么”，关闭再打开面板不丢失主进程权威状态。
2. 中断、关机、断盘、磁盘满和模型子进程退出均有可复现测试；真实设备项目必须保留人工门禁。
3. 搜索结果能显示时间范围和命中依据，并能安全打开、定位、导出 JSON/CSV、MP4、EDL 或 FCPXML。
4. 简单模式包含完成任务所需的最短路径，高级模式提供诊断和策略调整；不同窗口宽度下不截断核心操作。

## 验证记录

| 项目           | 命令                                                                                                                                   | 结果                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| TODO 结构      | `npm.cmd run todo:productization-check`                                                                                                | 通过：23 项               |
| 产品就绪度测试 | `npm.cmd run test:productization`                                                                                                      | 通过：92/92               |
| 安装生命周期   | `npm.cmd run verify:install-upgrade-recovery`                                                                                           | 通过：5/5，隔离临时目录   |
| 全量回归       | `npm.cmd test`                                                                                                                         | 通过；QA 工具链确认 241 个测试文件可达，含 Native 重建 |
| TypeScript     | `npm.cmd run typecheck`                                                                                                                | 通过                      |
| 全量 Lint      | `npm.cmd run lint`                                                                                                                     | 通过；0 错误、0 warning   |
| 双语可见文本   | `npm.cmd run test:i18n-static`                                                                                                         | 通过：7/7，0 条新增硬编码 |
| 格式门禁       | `npm.cmd run format:check`                                                                                                             | 通过                      |
| Renderer 构建  | `npm.cmd run build:renderer`                                                                                                           | 通过                      |
| 双语全窗口 UI  | Electron UI smoke，`zh-CN` 与 `en`                                                                                                     | 均通过：14/14 面板、0 缺失、0 控制台错误、0 崩溃 |
| 播放器/拖拽补充 | `node --test tests/media-player-export.test.cjs tests/file-drag.test.cjs`                                                              | 通过：10/10               |
| 窗口/文件管理/批量命名 | `test:ui-smoke-contract`、`test:fm-security`、Batch Rename 定向测试                                                        | 通过：28/28、50/50、19/19 |
| 内部 Online 候选 | `npm.cmd run build:online`；`npm.cmd run smoke:installer:archive`                                                                    | 构建和 248 文件归档冒烟通过；未签名，仅限内部 QA |

## 剩余边界

- `VAL-401` 至 `VAL-420` 的安全自动软件任务已完成，自动选择器应返回 `selected: null`。
- `VAL-421`、`VAL-422` 和 `VAL-423` 依赖真实设备、人工真值或发布许可决策，自动化只能准备工具和模板，不能代替最终验收。
- Batch Rename 对输出目录中既有同名文件的覆盖策略和失败/取消后的部分结果语义仍需产品决定；在事务式策略确定前不标记为数据安全关闭。
- DINO/多语言等隐式模型伴随文件仍需进入带大小和 SHA-256 的版本化 manifest，并改为有界流式、校验后原子落盘。
- 商标、版权、第三方许可证、代码签名、商店页面与正式分发继续由商业发布专项管理。
