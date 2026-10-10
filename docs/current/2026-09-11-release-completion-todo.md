# Siftory（寻藏）首版收尾与发布验收 TODO

> 状态：当前  
> 实施状态：VAL-901～910 自动任务已验证；VAL-911～920 尚待源码归档、真实环境或发布条件  
> 更新日期：2026-09-11  
> 范围：Windows 首版范围、版本归档、工程回归、真实质量与可靠性、安装和发布  
> 执行系统：Codex  
> 编制模型：GPT-6 系列；精确版本未公开  
> 文档所有者：Codex/root；VAL-901～910 由 Codex/root 领取，其他任务未分配  
> 外部代理：本轮未使用；其他运行时状态未知  
> 工作区：`feat/phase3-staged-index-unified-search`，未提交现场  
> 参考 HEAD：`4be3326240edeaec667730a963bddb7ea6a3e1e2`；本次验证包含 HEAD 以外的工作区改动  
> 替代文档：无；本清单统筹收尾，专项定义与历史证据继续保留

## 1. 目标与当前领取

将功能较完整的内部候选收尾为可追溯、可恢复、质量有证据的 Windows 首版。**VAL-901～910 已验证，当前无可直接领取的 auto 任务。**下一阶段是 VAL-911：依据变更清单完成历史改动归属、分批审查与干净候选归档；真实质量、设备及发布任务按后续依赖推进。

用户已追加授权开始自动优化。本轮执行工程与验收准备；历史改动提交、真实数据操作和正式发布仍按具体任务条件处理。`Mode` 与依赖区分工程工作、实机观察和发布决策，不把计划写成完成结果。

快速入口：[当前证据](#2-2026-09-11-检查基线)、[任务队列](#3-任务队列)、[验收细则](#4-分阶段验收细则)、[验证命令](#5-执行与验证命令)、[完成定义](#6-完成定义与状态更新)。

## 2. 2026-09-11 检查基线

以下结果来自创建 TODO 前同日完成的项目评估，不代表冻结提交上的最终验收：

| 检查 | 结果与边界 |
| --- | --- |
| TypeScript、ESLint、工具链 | 通过；Node 24.16.0、npm 11.13.0 |
| 架构 | 通过；488 个模块无跨层导入，Shared 无循环依赖 |
| 核心测试抽查 | 12 个测试文件正常退出；不等于全量 `npm test` 通过 |
| QA 工具链及内存专项 | 8 + 72 + 6，共 86 项通过；不等于真实长时间负载通过 |
| 构建 | `build:renderer:checked` 通过；包含 Renderer、Electron、Preload、Worker/Child 与产物校验 |
| 构建发现 | 直接构建曾因旧、新 Electron chunk 混存导致后置检查失败；清理后构建已消除；仍有 sharp 静态/动态导入混用警告 |
| 发布准备检查 | Online、Offline 均为 0/8；这是发布条件通过率，不是功能完成度 |
| Git | `git status --porcelain` 740 条记录；发布检查展开统计 780 个变更路径；两者口径不同，执行时重新统计 |
| 本轮未验证 | 全量回归、当前覆盖率、真实模型推理、桌面交互、干净机器安装、正式三轮性能与长期负载 |

构建日志位于 `artifacts/completion-audit-build-2026-09-11.log`，属于本机产物，不要求随源码提交。历史视频报告中的 92.5% 是语义接受率代理指标，严格一致率为 81.3%，时间点严格准确率为 51.9%；不能作为正式 Recall@K。

## 3. 任务队列

优先级：VAL-901～911 为 P0 工程与验收准备，VAL-912～914 为 P1 真实质量验收，VAL-915～920 为 P0 发布阻断项。表内 Rank 是建议推进顺序；已满足依赖的准备工作可以独立推进，正式发布必须全部收敛。

执行系统与所有者：`auto` 默认由领取任务的工程执行者负责；`observation` 由设备/数据负责人配合 QA；`approval` 由真实权利主体或发布负责人决策；`triggered` 在前置证据齐备后执行。VAL-901～910 由 Codex/root 负责，其余任务未分配；本轮未使用代理。

| Rank | ID | Value | Mode | Dependencies | External blockers | Branch | Status | Validation | Task |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | VAL-901 | 100 | auto | - | - | `docs/v1-scope` | verified | 首版能力清单、可选能力、未验收能力及延后范围逐项可追溯 | 盘点 Windows 首版范围，明确统一搜索主流程与高级能力边界 |
| 2 | VAL-902 | 99 | auto | - | - | `docs/source-change-inventory` | verified | 暂存、未暂存、未跟踪清单和归属、提交分组、敏感文件排除方案 | 盘点当前改动并形成可审查的分批归档方案 |
| 3 | VAL-903 | 98 | auto | - | - | `build/checked-entry-audit` | verified | 开发、CI、安装构建入口核对，清理后产物唯一且预算通过 | 统一可靠构建路径，复核旧产物残留与 sharp 导入警告 |
| 4 | VAL-904 | 97 | auto | VAL-901; VAL-903 | - | `qa/full-regression` | verified | verify 与关键覆盖率通过，记录全部失败和跳过原因 | 执行全量工程回归并修复确认的阻断缺陷 |
| 5 | VAL-905 | 96 | auto | VAL-904 | - | `qa/desktop-product-flow` | verified | 隔离配置下双语 UI 与播放器冒烟通过，无崩溃及控制台错误 | 验证首次引导、来源、任务、搜索、播放器和导出入口 |
| 6 | VAL-906 | 95 | auto | VAL-901 | - | `docs/real-fault-matrix` | verified | NAS、SFTP、移动盘、强退、休眠、窗口矩阵含步骤及预期结果 | 编制真实环境故障与恢复验收方案 |
| 7 | VAL-907 | 94 | auto | VAL-901 | - | `docs/search-quality-protocol` | verified | 查询、真值、Recall@K、时间误差及接受阈值有固定口径 | 建立可比搜索质量验收方案和标注模板 |
| 8 | VAL-908 | 93 | auto | VAL-901 | - | `docs/performance-acceptance-plan` | verified | 复用 accepted 基线、硬件指纹、三轮及长期负载计划 | 整理性能剩余项、正式预检和资源预算 |
| 9 | VAL-909 | 92 | auto | VAL-901 | - | `docs/clean-windows-acceptance` | verified | 双 profile 双语、安装升级回滚卸载、首次模型准备矩阵完整 | 准备干净 Windows 验收清单与记录模板 |
| 10 | VAL-910 | 91 | auto | VAL-901 | - | `docs/release-decision-packet` | verified | 八项发布阻断逐项对应材料、责任人角色和待决策内容 | 汇总发布者、组件许可、隐私、支持和模型安装决策材料 |
| 11 | VAL-911 | 90 | triggered | VAL-902; VAL-904; VAL-905 | 既有改动归属与审查结论 | `release/reviewed-source-candidate` | pending | 分批审查提交，隔离干净 checkout 复验，固定候选 SHA | 整理可追溯的源码候选，保留未纳入首版的既有工作 |
| 12 | VAL-912 | 89 | observation | VAL-907; VAL-911 | 固定素材与查询真值、人工标注 | `qa/controlled-search-quality` | pending | 同一活动集对照、分通道召回、证据和时间误差均达到预定阈值 | 完成真实检索质量验收并修复失败项 |
| 13 | VAL-913 | 88 | observation | VAL-908; VAL-911 | 满足 RAM/GPU 预检的固定硬件窗口 | `qa/formal-runtime-performance` | pending | 固定代码和数据指纹的三轮、混合负载、故障恢复证据通过 | 完成内存与性能专项尚未关闭的正式场景 |
| 14 | VAL-914 | 87 | observation | VAL-906; VAL-911 | 可控 NAS/SFTP、移动盘和隔离副本 | `qa/real-source-window-resilience` | pending | 断线重连、权限、掉盘、强退、休眠及窗口点击实机报告通过 | 完成真实设备可靠性和来源派生数据复验 |
| 15 | VAL-915 | 86 | approval | VAL-910 | 真实发布者、许可及政策决策 | `release/final-policy-materials` | pending | REL-LEGAL、REL-PRIVACY、REL-SUPPORT 通过，最终文件无占位符 | 落实项目和组件分发许可、隐私及更新支持政策 |
| 16 | VAL-916 | 85 | approval | VAL-915 | 可信签名证书与受保护执行环境 | `release/production-signing` | pending | 签名命令有效，实际测试产物 Authenticode Valid 且时间戳有效 | 配置并验证生产签名 |
| 17 | VAL-917 | 84 | triggered | VAL-911; VAL-912; VAL-913; VAL-914; VAL-915; VAL-916 | - | `release/frozen-package-matrix` | pending | 干净最终提交、版本标签、双 profile 双语包与哈希证据绑定 | 冻结最终源码并生成签名候选及 packaged matrix |
| 18 | VAL-918 | 83 | observation | VAL-909; VAL-917 | 无开发环境的 Windows 设备或虚拟机 | `qa/clean-machine-lifecycle` | pending | 安装、首次搜索、升级回滚、卸载保留及签名检查全通过 | 对同一批最终候选完成干净机器验收 |
| 19 | VAL-919 | 82 | triggered | VAL-917; VAL-918 | - | `release/final-evidence-review` | pending | 双 profile readiness 8/8，release gate 通过，证据同版本同提交 | 汇总最终验收与发布说明，关闭或降级未达标承诺 |
| 20 | VAL-920 | 81 | approval | VAL-919 | 发布负责人批准具体产物与渠道 | `release/windows-v1` | pending | 发布文件哈希与验收一致，渠道记录、回退包和支持入口可查 | 执行首版正式发布并归档记录 |

## 4. 分阶段验收细则

### 4.1 P0：范围、工程与源码

- [ ] **VAL-901**：逐项区分已实现、依赖外置模型、需要硬件、尚未验收的能力。默认以现有 Windows 功能为候选范围；NAS Agent、尚未完成的终端用户模型一键安装等不能对外承诺已支持。延后新增功能不等于删除既有面板或修改用户设置；影响既有范围的取舍先形成具体方案。
- [ ] **VAL-902 / VAL-911**：先盘点再整理；只归档确认归属的改动。Git bundle 不包含未提交文件，需要另行记录其保护方式。不得通过清空、强制回退或全量暂存掩盖来源未知的改动。提交验证遵循项目 Git 规范，最终用干净 checkout 复现。
- [ ] **VAL-903**：复用现有清理脚本和 `build:renderer:checked`，核对 `build.cjs`、CI 和手动入口；已有正确接线只补证据，不重复改造。sharp 警告先定位是否实际影响加载、内存和打包，再决定是否调整导入。
- [ ] **VAL-904**：跑完整 `verify` 与 `coverage:critical`，记录运行版本、源码指纹、环境、日志、失败和跳过。覆盖率阈值沿用项目基线，不降低阈值换取通过。修复后重跑受影响项；最终候选再执行一次完整回归。
- [ ] **VAL-905**：隔离配置验证中文/英文、首次启动、取消与恢复、模型缺失提示、首次结果和播放器入口；真实模型安装、生成有效结果的闭环由 VAL-918 验收，不能用 UI 控件存在替代。

### 4.2 P1：真实质量、性能与恢复

- [ ] **VAL-907 / VAL-912**：冻结素材、活动集和查询集，分别标注文字、图片、视频画面、对白及混合查询的相关结果与时间范围。运行前锁定 Recall@K、排序、证据正确性、时间误差的阈值；结果按通道报告，不能只给综合平均值，也不能看到结果后放宽阈值。Neko 当前 266001 与基线 245171 不可直接比较；不可覆盖旧基线伪造可比性。
- [ ] **VAL-908 / VAL-913**：按内存专项复核未关闭任务，固定硬件、软件、素材及实际 provider，验证三轮和规定的混合负载。预检不满足时标记未执行，记录原因；不要终止无关用户程序来制造测试条件。报告建库时间、搜索延迟、进程树 RAM、VRAM、低空闲内存、取消后释放和结果一致性。每周 8 小时诊断单独安排；若转为发布后观察，必须记录不影响首版承诺的理由与责任人。
- [ ] **VAL-906 / VAL-914**：对隔离副本执行断线、重连、权限不足、磁盘满、掉盘、进程退出和休眠恢复；核对原文件未损坏、目录不误删、无半提交索引、任务可恢复、远程结果仍对应正确素材。窗口验收覆盖双窗口真实点击、隐藏穿透、快捷键冲突及休眠后恢复。
- [ ] **来源清理复验**：承接 SRC-008，区分工程夹具与真实数据证据；只在明确指定的副本或已授权操作后检查 Native、DINO、CLIP、主体、缩略图和视频派生层。没有实际复验时保持未验证。

### 4.3 P0：最终产物与发布

- [ ] **VAL-910 / VAL-915**：复用已有 legal 决策文件和模板，先完成可审查材料，再取得真实决策。不同 profile 分别列出随包与运行时下载组件；外置模型的一键安装若不能闭环，应在首版范围和 UI 中如实标明依赖。许可证和政策不由自动化代填批准。
- [ ] **VAL-916 / VAL-917**：生产签名材料存放在受保护环境；冻结包含工程修复与最终政策的提交，在该提交重跑必要门禁，再创建与版本一致的标签并构建。候选验证期间出现源码修复须更新 SHA、重新构建并重做受影响验收；不得把旧证据直接绑定到新 SHA。
- [ ] **VAL-909 / VAL-918**：在无 Node、Python、开发目录、预置模型和开发机缓存的 Windows 环境验证 Online/Offline × zh-CN/en。覆盖安装、首次启动、模型准备或明确降级、建库、有效搜索、导出、升级、迁移失败回滚、卸载数据保留和重装；记录系统版本、硬件、安装包 SHA-256 和签名。UI 实现或夹具不能代替这些结果。
- [ ] **VAL-919 / VAL-920**：八项准备检查、packaged matrix 和安装生命周期报告全部绑定最终候选。若 release gate 重建了安装包，必须对新字节重新验证，不沿用旧包证据。正式发布前准备具体文件清单、渠道、发布说明、已知限制与回退方案，最后由负责人批准该批产物。

## 5. 执行与验证命令

复用现有选择器，无需新增自动执行器或修改 `package.json`。以下前两条仅检查计划或显示下一任务，不执行任务：

```powershell
node scripts/next-value-optimization-task.cjs docs/current/2026-09-11-release-completion-todo.md --check
node scripts/next-value-optimization-task.cjs docs/current/2026-09-11-release-completion-todo.md
npm.cmd run docs:check
```

后续任务按阶段使用现有命令；运行前阅读脚本参数和隔离数据要求，不无条件串成一次自动发布：

| 阶段 | 命令 | 完成条件 |
| --- | --- | --- |
| 工具链 | `npm.cmd run toolchain:check` | 精确版本符合工程要求 |
| 工程回归 | `npm.cmd run verify` | 类型、lint、格式、全量测试、Native 构建/测试及受检构建通过 |
| 关键覆盖率 | `npm.cmd run coverage:critical` | 聚合和逐文件阈值均通过，记录本次数据 |
| 受检构建 | `npm.cmd run build:renderer:checked` | 无旧 chunk 残留，产物检查通过 |
| 双语桌面 | `npm.cmd run smoke:ui:locales` | 两种语言分别通过 |
| 播放器 | `npm.cmd run smoke:media-player` | 控制、命中导航与导出入口验证通过 |
| 安装恢复夹具 | `npm.cmd run verify:install-upgrade-recovery` | 工程夹具通过；真实安装另行验收 |
| 性能预检 | `npm.cmd run benchmark:memory:preflight` | 仅满足预检后才安排正式负载 |
| 发布准备 | `npm.cmd run release:readiness -- --profile=online` | 最终目标为 8/8；当前阻断如实保留 |
| 发布准备 | `npm.cmd run release:readiness -- --profile=offline` | 最终目标为 8/8；当前阻断如实保留 |

具体性能、packaged matrix 与 release gate 参数沿用专项文档和脚本契约；候选构建、签名、模型下载和真实设备操作仅在对应任务条件满足后执行。

## 6. 完成定义与状态更新

1. `pending`：尚未执行；`in_progress`：已开始且记录领取人；`implemented`：已产出但未完成验收；`verified`：验收标准与证据均满足；`blocked`：已确认的条件缺失；`deferred`：范围明确延后且不影响当前发布承诺。
2. 每次领取记录执行系统、所有者、分支、文件范围；完成时记录命令、退出码、运行日期、提交或工作区指纹、日志位置、失败和跳过原因。
3. 历史工程通过不自动关闭本轮任务；本清单的文档校验通过也不表示任何收尾任务完成。
4. 首版源码收尾完成：VAL-901～911 已验收；质量可靠性完成：VAL-912～914 已验收，或具体非首版能力明确移出承诺并复核依赖；可发布：VAL-915～919 已验收；实际发布完成：VAL-920 有对应渠道记录。
5. 不用“核心功能 85%～90%”作为发布阈值；发布取决于具体能力、门禁和证据。未纳入验证的平台、模型、远端协议或场景不得概括宣称已支持。

## 7. 复用的专项依据

- [文档中心](../README.md)与[Git 工作流](../reference/git-workflow-and-commit-policy.md)。
- [商业发布准备专项](2026-08-17-commercial-release-readiness.md)：VAL-301～312 与八项发布检查。
- [产品化 TODO](2026-08-17-productization-auto-todo.md)：VAL-421 真实来源、VAL-422 检索质量、VAL-423 外置模型一键安装。
- [视频语义最终验收报告](../benchmarks/2026-08-15-video-profile-final-report.md)：代理指标与正式检索召回的边界。
- [内存与性能 TODO](2026-08-28-runtime-memory-optimization-todo.md)和[固定硬件基线](../benchmark/2026-08-26-fixed-hardware-first-build-baseline.md)。
- [窗口真实交互验收](2026-08-29-window-visibility-click-through-fix-todo.md)。
- [来源同步恢复整改](2026-08-30-source-file-sync-audit-remediation-todo.md)和[来源清理 TODO](2026-08-23-source-derived-data-cleanup-auto-todo.md)。
- [数据安全加固](2026-09-01-data-security-hardening.md)和[升级回滚生命周期](../reference/2026-08-12-upgrade-rollback-data-lifecycle.md)。

## 8. 自动执行证据

- [首版范围与源码清单](2026-09-11-v1-scope-and-source-inventory.md)：VAL-901/902，完成范围盘点与归档方案，不等于干净源码候选完成。
- [真实验收方案与发布材料包](2026-09-11-release-acceptance-packet.md)：VAL-906～910，完成步骤、阈值、模板和材料索引，不等于实机或审批通过。
- [自动优化执行记录](2026-09-11-auto-optimization-execution.md)：本轮修复、命令、结果和剩余条件。

## 9. 变更记录

- 2026-09-11：依据同日完成度评估建立 20 项收尾任务；接入现有选择器和文档索引。本轮仅编制计划，不关闭任何实施或发布任务。
- 2026-09-11：用户授权自动优化后，完成 VAL-901～910；全量回归累计 2108 通过、5 项环境跳过，关键覆盖率 126/126，中英文 UI 与播放器通过。源码仍为未提交现场；不关闭后续实机与发布任务。
