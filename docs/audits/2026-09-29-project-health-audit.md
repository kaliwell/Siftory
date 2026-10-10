# Siftory（寻藏）项目健康度审计

> 状态：历史快照  
> 更新日期：2026-09-29  
> 范围：当前桌面工程、构建与测试、数据维护、依赖、发行证据  
> 执行系统：Codex / GPT-6 系列，精确部署小版本未公开  
> 所有者：Codex/root  
> 协作：Codex/health_data_safety、Codex/health_release_dependencies、Codex/health_architecture_runtime，只读审查；其他运行时未知  
> 替代关系：补充 9 月 28 日状态；历史安装器和冻结登记材料分别追溯

## 1. 当前结论

**本地执行环境已恢复，工程具备继续开发的基础；默认回归与受检构建通过，但完整 CI 和正式发行条件尚未通过。** 不用一个主观百分比分数代替分项结果。

| 维度 | 本次结论 |
| --- | --- |
| 本地执行 | PowerShell、文件读写、Node、JavaScript 内核均恢复；本轮采用项目锁定工具链 |
| 类型、Lint、格式 | 全部通过 |
| 默认测试链 | 累计 2447 次测试执行，2440 通过、0 失败、7 跳过，包含重复用例 |
| 来源派生数据清理专项 | 86/86 通过；另用新夹具复现了现有测试未覆盖的晚期失败统计问题 |
| 构建 | Node 原生模块重建及测试通过；受检 renderer/Electron JS 构建与模块来源检查通过 |
| 关键覆盖率 | 失败：发布检查脚本分支覆盖率 77.92%，要求 89% |
| npm 依赖告警 | 生产依赖 0；含开发依赖时 6 个包级告警：4 高、2 中 |
| 数据安全 | 批量命名防覆盖、主体向量来源清理已有实现；新确认 1 项部分清理反馈缺陷 |
| 正式发行 | 内部门禁 0/8；条款、版本归档、签名和实机验收仍需收尾 |

用户已明确表示**软著申请已经提交**。本报告按用户陈述更新状态，不将提交申请继续列为待办，也不推定已受理或已获登记。冻结的 60 页源程序 PDF 和 27 页说明书 PDF 未修改。

## 2. 现场与证据口径

当前 HEAD 为 `4be3326240edeaec667730a963bddb7ea6a3e1e2`，提交日期为 2026-09-02；审计对象是此后的**未提交工作区**，不能把 HEAD 当作当前全部源码版本。

审计起点 `git status --porcelain` 为 815 条：MM 4、未暂存修改 288、暂存修改 46、暂存新增 87、新增后又修改 7、未暂存删除 2、未跟踪条目 381。展开未跟踪目录后，发行门禁统计为 982 个路径。这是两种统计口径，不是审计中突然增加了 167 项修改。

证据目录为 artifacts/health-audit-20260929（本地证据未随源码公开：`../../artifacts/health-audit-20260929/`）。其中 baseline.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/baseline.json`） 保存现场和关键源码摘要；checks.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/checks.json`） 保存逐项退出码和耗时；summary.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/summary.json`） 汇总测试与依赖结果。

当前会话配置下命令已恢复执行，但这不等于证明之前 `apply deny-read ACLs` 的根因已消除。本轮没有修改 Windows ACL 或全局 npm 配置。

## 3. 已确认问题与优先级

### H-01：来源清理晚期失败丢失已提交视频阶段统计（P2，已复现）

触发步骤：选择来源清理并启用 `remove-source-traces`；生成预览后，受管理的历史日志新增一行；随后执行清理。

[sourceDerivedDataCleanupService.ts](../../electron/sourceDerivedDataCleanupService.ts) 第 1529 行先完成视频清理，随后第 1531 行执行历史痕迹清理。[sourceScopedTraceCleanup.ts](../../electron/sourceScopedTraceCleanup.ts) 第 452 行检测到日志与预览指纹不同后抛错。外层第 1581 行的异常路径无法引用局部 `videoResult`，第 1591 行起返回的 `emptyResult` 漏掉已提交的视频结果。

本次独立复现：

| 项目 | 返回结果 | 实际状态 |
| --- | --- | --- |
| 清理结果 | `ok:false` | 视频阶段已完成，历史阶段拒绝执行 |
| 视频记录、总记录 | 都为 0 | 视频 manifest 已清空 |
| 删除文件、释放字节 | 都为 0 | 生成的帧缓存文件已删除 |
| 原始视频 | `originalFilesAffected:0` | 内容完整，未改动 |

界面 [SourceDerivedDataCleanup.tsx](../../src/components/SourceDerivedDataCleanup.tsx) 第 605–611 行在失败时只展示错误，没有明确提示“部分阶段已完成”。这不是原始视频被误删，而是失败返回和用户反馈不准确，容易使用户误判维护状态。

复现脚本：reproduce-cleanup-partial.cjs（本地证据未随源码公开：`../../artifacts/health-audit-20260929/reproduce-cleanup-partial.cjs`）；输出：cleanup-partial-reproduction.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/cleanup-partial-reproduction.json`）。从项目根执行 `node artifacts/health-audit-20260929/reproduce-cleanup-partial.cjs`。脚本只新建 TEMP 夹具，结束时校验路径并清理；退出码 0 表示缺陷成功复现，不表示产品行为通过。

建议：保留每个已提交阶段的结果，失败时返回准确计数和部分完成状态；补上“视频已清理、历史指纹随后失败”的故障回归。本轮未修改业务实现。

### H-02：关键覆盖率门禁失败（P2，CI 阻断）

`npm run coverage:critical` 退出码为 1。选定 14 个源文件的整体行/分支/函数覆盖率分别为 **87.66% / 76.79% / 86.55%**；整体超过最低线，但 [check-commercial-release-readiness.cjs](../../scripts/check-commercial-release-readiness.cjs) 分支覆盖率 **77.92% < 89%**，导致单文件门禁失败。

证据：critical-coverage.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/critical-coverage.json`）、coverage.log（本地证据未随源码公开：`../../artifacts/health-audit-20260929/coverage.log`）。该指标只覆盖指定文件，不是全应用覆盖率。[package.json](../../package.json) 的 `ci:verify` 包含此门禁，因此不能把默认测试通过描述为整套 CI 通过。

建议：为发布者身份、最终政策及实际检查器输入补行为分支测试，保留当前阈值；避免通过降低阈值关闭问题。

### H-03：开发依赖存在已公开告警（P2，需升级验证）

本机从 npm 审计服务得到的生产依赖结果为 0；完整锁文件结果如下。所有命中路径在锁文件中均为 `dev:true`。

| 包 | 锁定版本 | 告警级别 |
| --- | --- | --- |
| @xmldom/xmldom | 0.8.13 | 高 |
| browserslist | 4.28.2 | 高 |
| fast-uri | 3.1.5 | 高 |
| js-yaml | 4.3.1 | 高 |
| baseline-browser-mapping | 2.10.33 | 中 |
| undici | 顶层 7.29.0；构建依赖内另有 6.28.0、8.9.0 | 中 |

“6”是 npm 的受影响包项数，不是独立公告条数。开发依赖告警不等于已证明桌面安装版存在对应可利用入口；本轮没有进行攻击可达性验证。生产依赖 0 也不覆盖 Electron/Chromium 或全部原生二进制的安全状态。

原始结果：audit-production.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/audit-production.json`）、audit-all.json（本地证据未随源码公开：`../../artifacts/health-audit-20260929/audit-all.json`）。本轮还打开核对了上游维护者公告：[xmldom 内存消耗](https://github.com/xmldom/xmldom/security/advisories/GHSA-965w-775f-mr7g)、[fast-uri 序列化](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)、[js-yaml 合并解析](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)、[undici WebSocket 异常](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v)。例如 undici 公告要求使用相应已修补版本，实际项目升级仍需结合锁文件与回归验证。

建议：单独整理开发依赖升级，复跑工具链、测试和构建。本轮没有安装、升级或自动修复依赖。

### H-04：源码归档与正式发行证据未闭环（发布前优先）

当前有大量未提交改动，HEAD 没有 `v1.0.0` 标签。应先按模块整理可审阅快照，再让安装器、源码归档和测试证据绑定同一版本；不能直接把 9 月 2 日 HEAD 标成当前 V1.0.0 实现。

现有 9 月 26 日维护安装器并非缺失。本次只读核对 build-record.json（本地证据未随源码公开：`../../release/20260926-maintenance/build-record.json`） 所列 **5 个交付文件均存在且 SHA-256 匹配**，包括 175,263,469 字节安装器和 453,723,312 字节对应源码 ZIP。但后续源码改动和本轮新生成的开发构建，不能冒充已经进入该旧安装器。

[条款 manifest](../../legal/end-user-terms/manifest.json) 仍为 `review`；[发布决策文件](../../legal/commercial-release-decisions.json) 尚未落地最终发布者信息、隐私和支持政策。用户已确定“个人免费、商用收费”，当前缺口是正式随包文本与发布材料，不是要用户重新决定策略。

Online 发布门禁为 0/8：许可与发布者记录、干净源码、版本标签、签名、可比 Neko 质量基线、当前提交绑定的安装包矩阵、最终隐私政策、最终支持政策。详见 readiness.log（本地证据未随源码公开：`../../artifacts/health-audit-20260929/readiness.log`）。这是内部正式发行条件检查，不是功能完成率，也不是第三方组件是否免费或是否合法的裁判。

### H-05：真实发行验收与原生组件范围仍有缺口（发布前优先）

现有交付记录明确：安装器未数字签名，未完成干净 Windows 安装/升级；中文默认双屏合成拖动偏差仍待确定根因。本轮没有重跑桌面 UI、休眠/唤醒、NAS/SFTP、干净安装或签名验收，不将旧偏差直接判为已确认的产品拖动故障。

`licenses:check` 本次通过，说明已有清单、许可载荷、已识别对应源码和绑定检查通过。但 [covered-source manifest](../../legal/covered-source/manifest.json) 仍为 `completeNativeInventory:false`，不能据此宣称全部原生第三方组件已审完。

当前 Online 配置不捆绑模型。用户另行下载模型的待确认记录，不能统一解释为软件包已分发这些模型，或所有第三方都没有授权。

### H-06：默认 npm 与项目约定不同（P2，环境一致性）

实际默认 npm 为 **12.0.2**，项目要求 **11.13.0**，直接 `npm.cmd run toolchain:check` 失败。本机 Node 安装目录内已有 11.13.0，本轮通过局部启动器使用它，检查通过。Node 为要求的 **24.16.0**。

run-audit.cjs（本地证据未随源码公开：`../../artifacts/health-audit-20260929/run-audit.cjs`） 为自己的子进程设置工具路径，并生成本轮专用 `bin/npm.cmd`；没有修改全局安装或系统 PATH。重新运行本轮检查可使用 `node artifacts/health-audit-20260929/run-audit.cjs toolchain`。后续正常开发也应明确选用项目要求的 npm。

### H-07：用户说明书与登记进度入口滞后（P2，文档准确性）

[用户说明书](../reference/user-manual.md) 第 562 行仍写“主体向量未接入来源清理”，第 795 行仍写“首次输出可能覆盖已有文件”，均已落后于当前源码。本次代码复核及专项回归确认：

- [batchRenamePolicy.ts](../../electron/batchRenamePolicy.ts) 第 157 行起，复制到临时文件后使用不覆盖发布；兼容回退使用 `COPYFILE_EXCL`；`keep-best` 在复制前仲裁，并检查源指纹。
- 来源清理第 1495 行已调用主体向量清理；专项测试覆盖 crop、face、osnet、negative 向量和其他来源保留。历史日志默认保留，可显式清理。

这两项不能再作为“当前未修复风险”。应更新维护版说明书，并保留 H-01 的新边界；冻结的登记 PDF 不因后续维护而重写。

9 月 28 日状态中的“待签章提交”也已被用户后续“已提交申请”覆盖，本轮更新文档入口予以说明。

## 4. 架构、性能和验证范围

源码抽查发现主窗口、播放器、条款窗口均启用 context isolation 与 sandbox、关闭 renderer Node 集成；IPC 验证发送窗口、主 frame、可信来源和有界 payload；默认权限拒绝。AI Control API 监听本地环回并校验 Host、Origin、Bearer。退出流程和 ANN worker 生命周期已有集中清理。没有据此发现可确认的新 P0/P1 逃逸问题，但静态抽查不等于完成真实 Electron 对抗测试。

已有历史大库证据，不能描述为“完全没有十万级验证”：

- [PREP-007](../benchmark/2026-08-22-vector-ann-q8-projection-prep007.md)：440,450 条真实 DINO 768 维向量，50 查询、三轮，平均 Recall@50 99.88%。
- [8 月 29 日质量门禁](../benchmark/2026-08-29-runtime-memory-quality-gate.md)：CLIP 383,840 条 512D、DINO 445,575 条 768D，固定条件下三轮质量证据。
- [1000 次搜索诊断](../benchmark/2026-08-29-runtime-memory-search-soak-1000.md)：同 worker 固定搜索约 24.84 分钟完成，原始产物存在。

上述是当时源码、语料和环境的局部证据，不是本轮性能实测。当前版本正式两小时混合负载三轮、八小时诊断及完整内存控制线仍待闭环；八维合成规模夹具不能替代真实模型全维性能验收。

## 5. 本次验证记录

以下 npm 检查通过本轮局部启动器使用 Node 24.16.0 / npm 11.13.0 执行。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run toolchain:check` | 通过 | toolchain.log |
| `npm run typecheck` | 通过 | typecheck.log |
| `npm run lint` | 通过 | lint.log |
| `npm run format:check` | 通过 | format.log |
| `npm test` | 2440 通过、7 跳过、0 失败；约 374 秒 | tests.log |
| `npm run test:source-derived-cleanup` | 86/86 通过 | cleanup.log |
| `npm run coverage:critical` | 单文件分支门禁失败 | coverage.log、critical-coverage.json |
| `npm run docs:check` | 通过 | docs.log；报告写入后另复检 |
| `npm run licenses:check` | 通过；完整原生清单仍未声明完成 | licenses.log |
| `npm run check:bundle-provenance`（重建前） | 失败：旧 dist-electron 有 6 个缺少模块证据的残留脚本 | provenance.log |
| `npm run build:renderer:checked` | 通过；清理并重建后模块来源检查通过 | build.log |
| `npm run release:readiness -- --profile=online --json` | 0/8，正式发行条件未满足 | readiness.log |
| `npm audit --omit=dev --json` | 0 告警，退出码 0 | audit-production.json |
| `npm audit --json` | 6 个开发依赖告警，退出码 1 | audit-all.json |
| `npm ls --depth=0 --json` | 通过，退出码 0 | dependencies.json |

`verify` 包含的各步骤已分项执行通过，没有再重复运行完整聚合命令；额外的 `coverage:critical` 失败仍保留。默认测试统计是 56 组摘要之和，含重复执行，不是 2447 个唯一测试。

7 个正式跳过：4 个 Windows 文件链接夹具权限限制、1 个 POSIX 权限检查、2 个缺少指定 CUDA 对照夹具。另有用例内记录的链接检查跳过，原日志保留；不能据“失败 0”声称所有平台条件均已覆盖。

## 6. 本轮已处理与剩余工作

本轮完成环境验证、局部工具链选择、默认回归、专项回归、依赖查询和故障复现。标准受检构建清理并重建了项目的 `dist` / `dist-electron`，重建前路径已确认为项目直属生成目录；旧产物的模块证据问题已消除，原失败日志仍保留。默认测试链也重建了 Node 原生模块。

没有改动业务源码、锁文件、全局 npm、正式安装器、冻结登记材料或真实素材库；没有提交、打标签或发布软件。

建议按下列顺序继续：

1. 修复 H-01 的部分清理返回并补故障回归，更新维护版说明书的实际安全边界。
2. 补齐发布检查器的行为分支测试，使关键覆盖率门禁通过。
3. 单独升级命中的开发依赖，再跑默认回归、受检构建和两种 npm 审计。
4. 整理当前未提交源码，形成可追溯版本快照，再绑定新安装器和校验材料。
5. 落实已确定使用策略对应的最终条款，完成原生清单及真实 Windows 安装、升级、多屏、休眠和长期负载验收。

软著申请已提交与正式商业发行是不同事项；本轮剩余工作不要求重新准备或重新提交已有登记 PDF。
