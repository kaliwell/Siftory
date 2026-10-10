# FloatingClock 全项目详细优化方案

> 状态：当前
> 更新日期：2026-08-01
> 范围：2026-07-28 全项目综合审计后的 P1、P2 与 P3 整改
> 文档执行系统：Codex / GPT-5 系列
> 任务执行系统：未分配
> 任务所有者：未分配
> 审计依据：[2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)
> 进度入口：[项目审计整改进度](2026-07-28-project-audit-remediation.md)

## 1. 目标与完成定义

本方案把审计问题拆成可以独立开发、验证、提交和回退的任务。目标不是一次性重写项目，而是按依赖顺序完成以下结果：

1. 阻止日志、向量和备份继续无上限占用系统盘。
2. 恢复双语 UI、准确率性能和安装包运行时门禁。
3. 关闭生产依赖高危问题，建立可复现构建。
4. 补齐版本、签名、许可证、第三方声明和发布记录。
5. 在发布可信度恢复后，再推进安全隔离、IPC 收敛、CI、覆盖率和结构重构。

“方案完成”必须同时满足：

- 本文 P1 任务全部为“已验证”，不是只有代码合入。
- 当前提交通过 `npm.cmd run verify`。
- 中英文开发态 UI smoke 通过。
- 当前 `win-unpacked` packaged UI smoke 通过。
- 安装器 archive smoke、签名验证和 SHA-256 记录通过。
- `npm.cmd audit --omit=dev` 不再存在未批准的 high/critical。
- NekoSearch 固定数据集 `--gate` 通过。
- 干净环境能够按 manifest 获取物料并重建安装包。
- 安装包携带经审查的项目许可证、第三方声明和所需许可证文本。

在上述条件满足前，项目可以继续内部使用和开发，但不得创建正式公开发布标签。

## 2. 执行原则

1. 每个任务使用独立 worktree、独立分支和独立提交，不把依赖升级、磁盘迁移、UI 翻译和结构重构混成一个批次。
2. 所有用户数据变更先生成清单和预计回收空间；默认只预览，不直接删除。
3. 向量迁移、压缩和垃圾回收必须使用临时文件、哈希/计数校验、原子切换和可恢复快照。
4. 旧审计和旧 benchmark 保留为历史证据；当前状态只更新 `docs/current/`。
5. 每项完成后更新[项目审计整改进度](2026-07-28-project-audit-remediation.md)，记录提交、验证命令、结果数量和未覆盖边界。
6. P1 批次执行期间冻结无关的大版本升级和大规模结构拆分，降低回归定位难度。
7. 法律合规任务的工程清单可以由开发者完成，但许可证结论和商业分发决定必须由具备授权的负责人确认。

## 3. 当前可以直接复用的能力

| 能力              | 当前入口                                                    | 优化时的复用方式                                        |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 面板稳定标识      | `src/components/DraggablePanel.tsx` 的 `data-panel`         | UI smoke 改为按稳定标识定位，不再读取翻译后的标题       |
| 双语基础设施      | `src/i18n/core.ts`、`src/i18n/useTranslation.ts`            | 扩充 key、插值、错误映射和语言切换测试                  |
| 向量占用统计      | `electron/vectorMaintenanceService.ts`                      | 扩展为全数据域清单、可回收估算和安全维护计划            |
| 向量维护 UI       | `src/components/VectorMaintenanceBar.tsx`                   | 翻译现有英文，并增加预览、确认、进度、取消和结果报告    |
| 二进制 CLIP 缓存  | `electron/clipEmbeddingCacheReader.ts`                      | 准确率基准优先读取二进制缓存，减少 JSONL 解析           |
| DINO Float16 缓存 | `electron/embeddingF16Cache.ts`                             | 统一权威向量格式时复用现有半精度读取和校验              |
| ANN 基础          | `electron/vectorAnnIndex.ts`、`electron/vectorAnnWorker.ts` | 用于交互检索；准确率门禁保留精确对照模式                |
| 模型下载          | `scripts/download-models.ts`、`electron/modelRegistry.ts`   | 扩展为完整 manifest、哈希、许可证和目标路径校验         |
| 安装器归档检查    | `tests/installer-archive-smoke.cjs`                         | 加入 release gate，并增加许可证、manifest、签名产物断言 |
| 数据事务与恢复    | 现有 journal、备份和故障注入测试                            | 向量 GC/迁移沿用 fail-closed 和恢复模式                 |

## 4. 总任务列表

状态统一为：`待做`、`进行中`、`已实现待验证`、`已验证`、`暂缓`、`阻塞`。

| 顺序 | ID      | 优先级 | 任务                                    | 依赖                                               | 建议分支                            | 状态   |
| ---: | ------- | ------ | --------------------------------------- | -------------------------------------------------- | ----------------------------------- | ------ |
|    1 | REL-01  | P1     | UI smoke 稳定定位与双语执行             | 无                                                 | `task/ui-smoke-stable-locators`     | 已验证 |
|    2 | REL-02  | P1     | 建立唯一 release gate 编排脚本          | REL-01                                             | `task/rel-02-release-gate`          | 已验证 |
|    3 | DEP-01  | P1     | Electron 42.x 补丁升级                  | REL-01                                             | `task/dep-01-electron-42-patch`     | 已验证 |
|    4 | DEP-02  | P1     | 生产与构建依赖安全修复                  | DEP-01                                             | `task/dep-02-security-dependencies` | 已验证 |
|    5 | REL-03  | P1     | 当前安装包 packaged runtime 验证        | REL-01、DEP-01、DEP-02                             | `task/rel-03-packaged-runtime`      | 已验证 |
|    6 | DSK-01  | P1     | native 扫描日志轮转与脱敏               | 无                                                 | `fix/native-log-rotation`           | 已验证 |
|    7 | DSK-02  | P1     | embedding failure/diagnostic 日志限额   | 无                                                 | `fix/embedding-log-retention`       | 已验证 |
|    8 | DSK-03  | P1     | 统一磁盘占用清单与回收预览              | DSK-01、DSK-02                                     | `task/dsk-03-storage-inventory`     | 已验证 |
|    9 | DSK-04  | P1     | 安全清理任务、进度、取消与报告          | DSK-03                                             | `task/dsk-04-storage-cleanup`       | 已验证 |
|   10 | DSK-05  | P1     | active asset 驱动的向量 GC              | DSK-03、DSK-04                                     | `perf/vector-gc`                    | 已验证 |
|   11 | DSK-06  | P1     | 权威向量二进制格式迁移                  | DSK-05                                             | `perf/vector-binary-store`          | 已验证 |
|   12 | ACC-01  | P1     | 准确率基准改读缓存并恢复延迟            | DSK-05，可与 DSK-06 联动                           | `perf/neko-accuracy-runtime`        | 已验证 |
|   13 | ACC-02  | P1     | 扩展至少 5 个真实人工标注分类           | 无                                                 | `test/neko-accuracy-dataset`        | 暂缓   |
|   14 | ACC-03  | P1     | 重建并锁定 NekoSearch 发布门禁          | ACC-01、ACC-02                                     | `test/neko-release-gate`            | 待做   |
|   15 | I18N-01 | P1     | 清理 Renderer 硬编码可见文本            | 无                                                 | `feat/i18n-renderer-completion`     | 已验证 |
|   16 | I18N-02 | P1     | 主进程、worker、toast 错误国际化        | I18N-01                                            | `feat/i18n-runtime-errors`          | 已验证 |
|   17 | I18N-03 | P1     | 新增硬编码文本静态门禁                  | I18N-01、I18N-02                                   | `test/i18n-static-gate`             | 已验证 |
|   18 | I18N-04 | P1     | 双语 UI 与可访问性 E2E                  | REL-01、I18N-03                                    | `test/i18n-e2e`                     | 已验证 |
|   19 | BLD-01  | P1     | 模型与工具物料 manifest                 | 无                                                 | `build/resource-manifests`          | 已验证 |
|   20 | BLD-02  | P1     | 非交互下载、哈希和许可证校验            | BLD-01                                             | `build/resource-fetch`              | 已验证 |
|   21 | BLD-03  | P1     | 干净环境重建、SBOM 和物料报告           | BLD-02、REL-02                                     | `build/reproducible-release`        | 已验证 |
|   22 | LIC-01  | P1     | 项目许可证与第三方声明清单              | BLD-01；外部：版权负责人批准最终 EULA 与组件许可证 | `docs/release-licenses`             | 阻塞   |
|   23 | LIC-02  | P1     | YOLO/FFmpeg 合规处置或替换              | LIC-01；外部：YOLO/FFmpeg 专业许可证审查           | `build/compliant-runtime-assets`    | 阻塞   |
|   24 | REL-04  | P1     | 版本、签名、时间戳与 release record     | BLD-03、LIC-02、REL-03、ACC-03、I18N-04            | `build/signed-release-record`       | 待做   |
|   25 | SEC-01  | P2     | GPU thumbnail 子窗口安全隔离            | 无                                                 | `fix/gpu-thumbnail-sandbox`         | 已验证 |
|   26 | SEC-02  | P2     | IPC sender 授权、契约拆分与能力矩阵校验 | SEC-01                                             | `refactor/ipc-capabilities`         | 已验证 |
|   27 | QA-01   | P2     | Node/npm 锁定、CI 和覆盖率基线          | REL-02                                             | `ci/toolchain-and-coverage`         | 已验证 |
|   28 | PRV-01  | P2     | 已跟踪文档和 benchmark 路径脱敏         | 无                                                 | `docs/path-redaction`               | 已验证 |
|   29 | SIZE-01 | P2     | 可选模型包与 FFmpeg 瘦身                | BLD-01、LIC-02                                     | `build/package-size`                | 已验证 |
|   30 | DEP-03  | P2     | xterm、ESLint、Vite、React 等分组升级   | DEP-02、QA-01                                      | `build/ecosystem-upgrades`          | 已验证 |
|   31 | GIT-01  | P2     | 远端/裸仓库灾备与已合并分支清理         | 无                                                 | `chore/git-disaster-recovery`       | 已验证 |
|   32 | ARC-01  | P3     | 热点拆分、lint 清零和多 DPI 布局 E2E    | SEC-02                                             | `refactor/maintenance-hotspots`     | 已验证 |

## 5. 第一阶段：恢复发布可信度

### REL-01 UI smoke 稳定定位与双语执行

实施列表：

1. 为每个面板、标签页、主要命令和关键状态补充稳定的 `data-panel`、`data-testid` 或可访问 role/name。
2. 修改 `tests/electron-ui-smoke.cjs`，禁止用 `Settings`、`Image Search` 等显示文本判断面板存在。
3. 启动参数或测试 IPC 显式指定 `zh-CN`、`en`，不得依赖本机保存设置。
4. 两种语言分别覆盖启动、默认面板、语言切换、置顶切换、面板拖动、Settings、Image Search 和 Asset Library。
5. 截图文件名包含提交、语言、开发态/packaged 和屏幕尺寸。
6. 对空白页、React 未挂载、控制台错误、未处理 Promise 和关键 IPC 失败单独报错。

主要文件：

- `tests/electron-ui-smoke.cjs`
- `electron/uiSmokeService.ts`
- `src/components/DraggablePanel.tsx`
- 各主要面板根节点

验收标准：

- `npm.cmd run smoke:ui -- --locale=zh-CN` 通过。
- `npm.cmd run smoke:ui -- --locale=en` 通过。
- 测试中不再用可翻译标题定位面板。
- 人为删除一个稳定标识时，smoke 必须失败并指出具体面板。

完成记录（2026-07-28）：

- 面板、搜索模式、素材库标签页和关键命令已使用稳定 `data-panel` / `data-testid`；新增契约测试会阻止重新引入英文显示文本定位。
- 开发态 smoke 使用独立临时用户数据，显式注入 `zh-CN` 或 `en`，并按语言隔离截图和 JSON 结果。
- 中文、英文均验证 7 个面板、应用就绪、无 ErrorBoundary、关键搜索/素材库操作、模型、native addon、备份能力，以及“当前语言 → 另一语言 → 当前语言”的运行时切换。
- `npm.cmd run smoke:ui:locales`、`npm.cmd run test:ui-smoke-contract` 和 `npm.cmd run verify` 均通过。
- 当前 packaged smoke 尚未执行；该部分由 REL-03 在新构建的 `win-unpacked` 上完成，不能用本批开发态结果替代。

### REL-02 唯一 release gate

新增一个只负责顺序和失败传播的 release 脚本，固定执行：

```text
npm ci
git hooks / preflight
npm run verify
npm audit --omit=dev
npm run benchmark:neko-search:accuracy -- --gate
npm run build（保留 win-unpacked）
npm run smoke:packaged:resources
npm run smoke:ui:packaged -- --locale=zh-CN
npm run smoke:ui:packaged -- --locale=en
npm run smoke:installer:archive
签名与签名验证
生成 SHA-256、SBOM 和 release record
最后清理 win-unpacked
```

要求：

- 任一步失败立即停止，后续不得生成“发布成功”记录。
- 每一步保存开始时间、结束时间、退出码、提交和产物哈希。
- `win-unpacked` 必须保留到 packaged smoke 完成。
- 普通 `npm run build` 不再被解释为完整发布门禁。

完成记录（2026-07-30）：

- 新增 `npm.cmd run release:gate`，固定串行执行干净安装、Git/提交检查、完整 verify、生产依赖审计、NekoSearch 门禁、保留 `win-unpacked` 的打包、双语 packaged smoke、安装包归档检查、签名与签名验证、SBOM/哈希/release record 和最终清理。
- 每次运行在 ignored `artifacts/release-gate/<run-id>/gate-report.json` 中记录提交、步骤起止时间、退出码、命令和已存在产物哈希；只有所有步骤和最终清理均通过后，release record 才会标记为 `passed`。
- 任一步失败立即停止。失败发生在 evidence 前时不创建 release record；发生在 evidence 后时会把草稿标为 `failed`，不会留下成功记录。
- 打包步骤强制注入 `FLOATING_CLOCK_KEEP_UNPACKED=1`；清理固定为最后一步。签名命令通过 `FLOATING_CLOCK_SIGN_COMMAND_JSON` 显式提供，支持 `{installer}` 占位符，报告不会记录签名参数。
- `tests/release-gate.test.cjs` 覆盖固定顺序、dirty worktree、首错停止、成功记录时机、清理失败、签名配置和安装包占位符，共 7 个 gate 专项测试。
- `npm.cmd run verify` 通过：469 项中 465 通过、0 失败、4 项因隔离 worktree 不含被忽略的本机模型实物而跳过；lint 为 0 错误、5 条既有警告。
- 在干净提交 `b2cd34f` 上真实执行 gate：`clean-install`、`git-preflight`、`verify` 通过，随后按设计在 `production-audit` 退出 1；生产树仍为 2 high、1 moderate，且没有生成 release record。

未覆盖边界：REL-02 只完成可信编排，不代表当前版本可发布。DEP-01/DEP-02、NekoSearch 性能、packaged smoke、签名证书和许可证等后续阻断项未绕过；只有这些步骤分别通过后，gate 才会继续到下一阶段。

### DEP-01 Electron 补丁升级

1. 先从 42.4.1 升到 42.x 当前批准的最新补丁，不同时跨 Electron major。
2. 重建 `onnxruntime-node`、`better-sqlite3`、`sharp` 和 `fast_scanner.node`。
3. 专项验证透明窗口、取消置顶、无 native resize 边框、全局快捷键、托盘和多显示器。
4. 开发态和 packaged 两种模式检查 CSP、导航拦截、sandbox 和 preload。
5. 将实际 Electron/Chromium/Node 版本写入 release record。

完成记录（2026-07-30）：

- 通过 npm registry 和[Electron 42.8.0 官方发布页](https://releases.electronjs.org/release/v42.8.0)确认同一 major 的当前最新版本，将 `electron` 从 `^42.4.1` 精确锁定为 `42.8.0`，未跨 major。
- Electron 42.8.0 不再由 npm 生命周期自动下载预构建二进制；新增 root `postinstall` 和 `scripts/install-electron.cjs`，先使用官方端点，失败且用户未显式配置镜像时再使用 checksum 校验的镜像重试。全新 `npm.cmd ci` 已实测通过。
- 新增 Electron 版本/安装契约测试，阻止 package 与 lockfile 漂移、非精确版本和 `electronDist` 缺少安装步骤。
- `scripts/print-electron-runtime.cjs` 实测运行时为 Electron 42.8.0、Chromium 148.0.7778.280、Node 24.18.0、V8 14.8.178.38-electron.0；release gate evidence 现在会探测并写入这四项实际版本。
- Electron 42.8.0 headers 下重新构建 `fast_scanner.node` 成功；开发态和新 `win-unpacked` 的 `zh-CN`、`en` UI smoke 均通过，7 个面板、语言往返、模型、native addon、备份恢复和关键交互正常，控制台错误为 0。
- 新 NSIS 安装器归档检查通过：953.03 MiB、309 个文件、SHA-256 `4B60E8356F1FFEAF64EB151D127E9906204F548A7C9147A5A1A2FAB4451CFC90`。验证完成后已清理 `win-unpacked`，只保留 ignored 安装器供本 worktree 诊断。
- `npm.cmd run verify`：474/474 通过、0 失败、0 跳过；typecheck、format、native 和全部生产构建通过；lint 为 0 错误、5 条既有警告。

未覆盖边界：本批不处理 transformers/sharp/protobufjs 和构建链漏洞，生产树仍为 2 high、1 moderate，完整树仍为 1 critical、6 high、1 moderate；安装器仍未签名。依赖安全继续由 DEP-02 处理，签名和正式 release record 继续由 REL-04 处理。

### DEP-02 依赖安全修复

按风险拆批：

1. 可直接修复的 `protobufjs` 和构建链依赖先独立升级。
2. 对 `@huggingface/transformers`、`sharp`、libvips 建立可达性矩阵：调用入口、输入来源、是否处理不可信文件、packaged 是否携带。
3. 优先采用上游兼容版本；使用 override 时必须验证 ABI、图片解码、模型加载和安装包。
4. 无安全升级路径时，隔离不可信输入、限制文件大小/像素、记录临时风险批准和到期日。
5. 每个批次保存升级前后 `npm audit --json` 对比。

验收标准：生产树无未批准 high/critical；构建树 critical 关闭，其他风险有明确负责人、缓解措施和到期日。

完成记录（2026-07-30）：

- 先用非强制 `npm audit fix` 更新 lockfile：`protobufjs` 升至 7.6.5，`tar` 升至 7.5.22，`fast-uri` 升至 3.1.4，`js-yaml` 升至 4.3.0，`postcss` 升至 8.5.25；原有 production moderate 和完整树 critical 均关闭。
- `@huggingface/transformers` 4.2.0 仍把 `sharp` 约束在 `^0.34.5`，而 libvips 安全修复要求 0.35.0；通过精确 root override 使用 `sharp` 0.35.0 / libvips 8.18.3，并为 0.35.0 未从 `exports` 暴露自带声明的问题增加最小 TypeScript 路径桥接。
- 新增依赖安全契约测试，锁定所有告警修复下限，并真实通过 Transformers `RawImage` 的 PNG 解码和 Lanczos resize。人脸、ReID、SAM、颜色/裁剪等真实模型与图片链路也通过。
- `npm.cmd audit --omit=dev` 从 2 high、1 moderate 降为 0。完整树从 1 critical、6 high、1 moderate 降为 0 critical、26 high；26 项均由同一 `brace-expansion` GHSA 传递展开，而实际 lockfile 已安装带 `EXPANSION_MAX_LENGTH` 有界修复的 1.1.17、2.1.3、5.0.8。该 npm advisory 范围与已发布修复分支尚未收敛，登记为构建期报告例外，由项目依赖维护者在 2026-08-13 前复核 registry 元数据；构建输入仅来自仓库受控 glob，且契约测试禁止降级到修复下限以下。
- 全新 `npm.cmd ci`、Electron native 重建和 `npm.cmd run verify` 通过；lint 为 0 错误、5 条既有警告。开发态与新 `win-unpacked` 的 `zh-CN`、`en` UI smoke 均通过，模型、native addon、备份恢复与关键交互正常，控制台错误为 0。
- 新 NSIS 安装器归档检查通过：952.87 MiB、310 个文件、SHA-256 `0268E9F4F072083D2A3ADECFDD6258A4E88B1837F51DFB4BCEB1F14583F689AB`。

未覆盖边界：安装器仍未签名，许可证、NekoSearch 门禁和正式 release record 尚未闭环；本批生成的 packaged runtime 证据只证明依赖升级兼容，REL-03 仍需按自己的资源加载清单完成正式验收。

### REL-03 当前安装包运行时验证

1. 使用 release gate 生成全新的 `win-unpacked` 和 NSIS 安装器。
2. 对 `win-unpacked` 执行中英文 smoke。
3. 验证 CLIP、DINO、subject 模型、FFmpeg、native addon、备份和恢复实际从 `resources` 加载。
4. 在临时用户数据目录运行，避免污染真实素材库。
5. archive smoke 检查文件清单、重复资源、许可证、manifest 和禁止文件。

完成记录（2026-07-30）：

- 新增 `npm.cmd run smoke:packaged:resources`，逐项验证 `app.asar`、8 个 worker、native addon、模型 manifest、9 份模型资源、FFmpeg/FFprobe、Sharp 与 ONNX Runtime 原生绑定；同时拒绝路径越界和历史重复资源。
- packaged 双语 smoke 会创建临时图片并执行真实 YOLO 推理、MobileSAM session 初始化、FFmpeg/FFprobe 探测、DINO/CLIP 模型解析和 native addon 连接；每一项都断言实际加载路径位于 `process.resourcesPath` 下。
- 中文和英文 packaged smoke 均通过，7 个面板、语言切换、素材库写入/删除/恢复、备份创建/验证/恢复均无错误；YOLO、MobileSAM、DINO、CLIP、FFmpeg、FFprobe 和 `fast_scanner 0.5.1` 均提供实际加载证据。
- NSIS 归档验证通过：安装器 999,154,080 字节（952.87 MiB），310 个归档文件，SHA-256 为 `A2AA933695CFED23A9CA437F26F5A44BB9DB93540C148DA9333283DF10A1978A`。
- release gate 已把 packaged 资源清单固定在构建与 packaged UI smoke 之间，资源缺失、空文件、错误来源或旧副本会在启动应用前失败。

未覆盖边界：本批证明当前安装器资源完整且可从 packaged runtime 实际加载，不代表可以公开发布；NekoSearch 准确率、许可证闭环、可复现物料获取、签名证书与正式 release record 仍由后续任务阻断。

## 6. 第二阶段：阻止磁盘继续增长

### DSK-01 native 扫描日志轮转

1. 把 `native/fast_scanner.cc` 的逐次 append 改为集中日志器。
2. 默认单文件上限建议 10～20 MiB，保留 2～3 份；上限必须可测试。
3. 轮转使用同目录 rename，失败时不得阻断扫描主流程。
4. 默认脱敏个人绝对路径；需要诊断时由用户显式启用详细路径并显示隐私提示。
5. 增加并发写、轮转边界、磁盘满和权限失败测试。

完成记录（2026-07-30）：

- 新增集中式、线程安全的 `rotating_logger`，native 扫描不再为每条日志自行打开 append stream；默认单文件 16 MiB、同目录保留 `.1`/`.2` 两份。
- 写入前检查轮转边界，删除最旧副本后按倒序 rename；创建目录、轮转、打开、flush 或磁盘写入失败全部 fail-open，不得中断扫描。
- 所有扫描、解码、USN state 与 segment 错误日志的绝对路径默认转换为稳定 `<path#...>` 指纹；只有同时显式设置 `IMAGESEARCH_VERBOSE_LOG=1` 和 `IMAGESEARCH_VERBOSE_PATHS=1` 才输出原路径，并先写入 `PRIVACY_WARNING`。
- 测试配置仅在 `FLOATING_CLOCK_NATIVE_LOG_TEST=1` 下开放小尺寸上限和故障注入，不改变生产默认上限。
- native 专项 40/40 通过，覆盖 8 线程并发、512 字节边界轮转、最多 2 份备份、调用点与集中兜底路径脱敏、显式路径隐私警告、不可用目录和模拟磁盘写满；`npm.cmd run verify` 486/486 通过。

### DSK-02 embedding 日志保留策略

覆盖：

- `embedding_failures.jsonl`
- `embedding_diagnostics.jsonl`
- diagnostic `.bak`
- `embedding_jobs.jsonl`

实施列表：

1. failure 记录按“模型 + imageId + 原因”去重，保留最近时间和出现次数。
2. 同时设置文件字节、记录数和 TTL 上限。
3. diagnostic 轮转后自动删除超出保留数量的旧备份。
4. job compaction 保留 pending/running 和必要的最近失败，不永久保存全部完成记录。
5. 写入失败保持 fail-safe：日志失败不能破坏 embedding 数据，但必须暴露健康状态。

完成记录（2026-07-30）：

- failure 默认上限为 32 MiB、50,000 个去重键、30 天 TTL；首次 build 自动收敛历史文件，后续新唯一失败走 O(1) 追加，重复键或触碰容量边界时原子压缩。
- diagnostic 默认上限为 20 MiB、100,000 条、14 天 TTL，最多保留 3 份 `.bak`；每 256 次写入重新应用 TTL/记录上限，单条超限事件安全丢弃并计入健康状态。
- job 自动保留全部 pending/running、30 天内最多 5,000 条失败，不保留 completed/skipped；手动 Compact Jobs 与运行时使用同一策略和同一内存 store，避免压缩后被旧缓存写回。
- 维护 IPC 和 Vector DB 面板暴露 failure/diagnostic 的最近成功、错误、压缩次数与丢弃记录数；日志写入失败不阻断 embedding。
- 真实 failure 日志临时副本从 199,143,326 bytes / 589,314 行收敛到 17,492,696 bytes / 50,000 条，用时 1.84 秒；真实 jobs 的 235,686 条均为 pending，因此按安全规则全部保留。
- `npm.cmd run test:vector-pipeline` 31/31 通过，其中 retention 专项 8/8；`npm.cmd run verify`、40 项 native 测试和生产构建通过。

### DSK-03 全数据域占用清单

扩展现有 `vectorMaintenanceService`，统一报告：

- Image Search 日志、索引、缩略图。
- CLIP/DINO JSONL、F32/F16 cache、ANN。
- Media Search 帧和向量。
- 素材库备份、recovery、删除历史。
- diagnostic、failure、job。

每项至少包含：路径类别、总大小、活跃大小、可回收估算、最后修改时间、是否可重建、清理风险和当前任务占用状态。UI 只显示逻辑数据域，不默认暴露完整个人路径。

完成记录（2026-07-30）：

- `vectorMaintenanceService` 现在统一返回 Image Search 日志/索引/缩略图、CLIP/DINO JSONL、F32/F16 cache、ANN、Media Search 帧/向量、素材库备份/recovery/删除历史以及 failure/diagnostic/job 共 14 类清单。
- 每项包含逻辑路径类别、总量、活跃量、可回收估算、最后修改时间、文件数、可重建性、清理风险和任务占用状态；IPC 和 UI 数据均不包含这些项目的真实个人路径。
- 清理估算保持保守：权威索引、向量 JSONL、recovery、删除历史和活动 job 不计入可回收；素材库保留最新备份；可重建缓存仍计入活跃量，同时单独显示潜在可回收量。
- 大目录统计改为 64 路受控异步文件 I/O，不阻塞 Electron 主进程；真实数据只读扫描 134,351 个缩略图文件耗时 12.68 秒。
- 真实清单总量为 18,364,391,981 bytes，预估可回收 4,259,518,881 bytes；本任务只生成预览，没有删除或改写用户数据。
- storage inventory 专项 3/3、`test:vector-pipeline` 34/34、`npm.cmd run verify`、40 项 native 测试和生产构建全部通过。

### DSK-04 安全清理工作流

1. 第一步只扫描并生成预览清单。
2. 用户确认后创建必要的元数据快照并检查目标盘剩余空间。
3. 清理作为可取消后台任务运行；处理中禁止重复启动相关扫描。
4. 只允许删除明确标记为可重建、过期或已被权威数据替代的内容。
5. 完成后重新统计，显示实际释放空间、跳过项和错误项。
6. 不提供“清空整个 userData”按钮。

完成记录（2026-07-30）：

- 清理入口严格分为只读预览和确认执行两步；预览令牌绑定服务器端目标快照、10 分钟过期，Renderer 只接收逻辑类别、文件数、风险和估算大小。
- 仅白名单允许清理轮转日志、派生缩略图、F32/F16 cache、ANN、媒体帧/manifest、被最新备份替代的旧素材库备份和超出保留数的 diagnostic 备份；权威索引、JSONL、recovery、删除历史和 job 不进入清理候选。
- 执行前检查目标盘剩余空间并写入元数据快照；执行时再次校验真实路径包含关系和符号链接，按文件异步删除，支持取消并报告实际释放、跳过和错误。
- 清理相关域运行期间拒绝新 Image Search 扫描、向量构建和 Media Search 扫描；重复清理任务也会被拒绝。
- UI 默认只勾选低风险项，中风险向量缓存和旧备份必须手动选择，并通过系统确认框二次确认；没有“清空 userData”或未预览直接清理入口。
- 真实用户数据只读预览扫描耗时 12.80 秒，识别 4,136,783,694 bytes 候选；未对用户数据执行清理。
- 清理专项 3/3、`test:vector-pipeline` 37/37、IPC 注册与 preload 契约、`npm.cmd run verify`、40 项 native 测试和生产构建全部通过。

### DSK-05 active asset 向量 GC

1. 从当前权威素材/索引生成 active ID/path 集。
2. 预扫描各 shard，报告 active、stale、duplicate、malformed 和预计新文件大小。
3. 写入新 shard，不原地截断旧文件。
4. 校验记录数、唯一键、维度、模型名、抽样向量哈希和搜索排序。
5. 原子切换后保留有期限的恢复快照。
6. 强杀、磁盘满、坏行和切换失败必须能恢复旧权威文件。

验收标准：真实库 stale 向量归零或有明确保留理由，所有 active 素材仍可搜索，释放空间与预估误差不超过 5%。

完成记录（2026-07-30）：

- active 集合同时读取当前 Image Search 索引、Media Search 帧 manifest 和素材库 JSONL 权威路径，避免把共用全局 shard 的媒体帧误判为 stale。
- 预览使用双遍流式算法，仅在内存保留 active 路径和最新行号，逐 shard 报告 active、stale、duplicate、malformed、预测新文件大小和最终可回收空间。
- 执行先检查磁盘空间并写入独立临时 shard；切换前校验记录数、唯一 imageId、维度、模型名、embedding type、32 条抽样向量哈希和余弦排序。
- 新 shard 校验通过后才把旧 shard 原子切换为 7 天恢复快照；磁盘满、取消或切换失败均保留/恢复旧权威文件，不原地截断。
- GC 与 embedding、向量索引构建和 Image Search 扫描互斥；UI 必须先预览，再二次确认，可取消并报告 shard 进度、错误和“快照到期后可回收”空间。
- 到期恢复快照会进入 DSK-04 清理预览，未到期或元数据无效的快照保持保护；快照存在期间实际释放量明确报告为 0，避免虚报。
- 真实库只读预览耗时 81.76 秒：270,504 个 active 权威路径；CLIP 477,795 行中 263,397 active、183,446 stale、30,952 duplicate；DINO 471,323 行中 263,393 active、176,469 stale、31,458 duplicate、3 malformed；最终预计可回收 5,829,735,147 bytes。
- 未对真实 shard 执行 GC；保留理由是该操作必须由用户在 UI 审阅预览并确认。临时夹具已验证压缩后 stale/duplicate/malformed 归零，active 向量哈希和排序不变。
- Vector GC 专项 4/4、`test:vector-pipeline` 42/42、IPC/preload 契约、`npm.cmd run verify`、40 项 native 测试和生产构建全部通过。

### DSK-06 权威二进制向量格式

推荐先形成设计决策记录，再实现：

1. 比较分块 F16/F32、SQLite BLOB、内存映射文件三种方案。
2. 元数据与向量分离，记录模型、维度、dtype、offset、校验和和 generation。
3. JSONL 只保留一次性导入/导出能力，不再作为长期全量权威副本。
4. 新旧格式并行只允许在迁移窗口存在；切换后自动给出旧副本清理预览。
5. 支持流式构建和按 generation 原子切换，禁止一次性把数 GB 数据复制到 JS 对象。

2026-07-30 已完成：

- 采用连续 `f16-le` generation + 流式路径元数据，manifest 记录模型、维度、
  dtype、offset、文件尺寸、SHA-256、导入源和 generation；方案比较与失败语义见
  `2026-07-30-authoritative-vector-store.md`。
- 维护页提供只读预览、明确确认、进度与取消；构建先检查空间，在 staging 中流式
  写入并全量校验，最后才切换 `CURRENT`。取消、损坏、空间不足和切换失败均保留
  旧 generation。
- 现有 F16 消费者统一优先读取权威 generation；导入源变化时回退刷新缓存，避免
  新 embedding 被旧快照遮住。旧派生缓存和旧 generation 自动进入清理预览。
- 专项 3/3、向量管线 45/45、IPC 注册和 preload 契约通过；真实数据只读估算
  generation 约 839,015,636 bytes，未执行真实迁移或删除。
- JSONL 删除继续受兼容窗口保护：Media Search、embedding 追加和诊断/导出入口
  全部完成 generation + 增量日志改造前，不把原始 shard 暴露为清理候选。

## 7. 第三阶段：NekoSearch 与完整双语功能

### ACC-01 恢复准确率性能门禁

1. 基准优先读取 `clip_embedding_cache.f32`、DINO F16 cache 或精确二进制 store。
2. ANN 只用于候选召回；门禁质量对照保留精确排序，防止近似索引掩盖回归。
3. 把 JSON 解析、I/O、相似度计算和排序分别计时。
4. 固定同机、同数据集、冷/热缓存条件，各运行至少 3 次并记录中位数和 p95。
5. GC 前后用相同标注和 active 集对比，质量指标不得下降。

当前恢复目标：扫描 p95 不超过 55,477.35ms；建议工程目标进一步压到 40,000ms 以下，为机器波动留余量。

2026-07-30 已完成：

- 准确率基准改为只读选择权威 generation、完整 CLIP F32 或 F16 快照，不再因
  JSONL 增长而重建缓存或扫描数 GB JSON；缺少完整二进制快照时明确失败。
- ANN 仍只用于产品候选召回；质量与延迟门禁执行 active asset 集上的完整精确
  排序。报告固定 annotation 与 active-set SHA-256，集合不同则拒绝伪比较。
- 每个模型在 application-cold（重开并重解析元数据）和 warm-path-index 条件下
  各运行 3 次，分别记录路径 I/O、JSON、向量 I/O、相似度和排序耗时；操作系统
  文件缓存不宣称被清空。
- 真实只读门禁质量不变：四个变体 P@20/P@50/nDCG@20 均为 1，
  R@50=0.6410，reject intrusion=0。6 个 warm 样本 p95=20,065.6ms，
  application-cold p95=19,014.4ms，均低于 40,000ms 工程预算。
- warm p95 分解：vector I/O 198.1ms、similarity 19,557.2ms、
  ranking 77.2ms；warm 元数据复用后路径 I/O/JSON 为 0。新基线版本为 2。
- GC 前后实测仍需用户明确确认真实 GC；门禁已用 annotation/active-set 指纹保证
  后续比较必须使用同一标注和同一 active 集，当前未改写或删除用户数据。

### ACC-02 多分类人工标注

至少建立 5 个真实分类：

1. 人物/角色。
2. 截图与文字界面。
3. 产品/物品。
4. 动物。
5. 场景/环境。

每分类要求：

- 独立记录候选池、confirmed 正样本和 hard negatives。
- manual 标签占比建议不低于 70%；seeded 只能辅助，不能替代发布判定。
- Top20、Top50 和随机池完成度均为 100%。
- 记录数据集指纹，源文件不进入 Git，匿名化摘要进入 benchmark 文档。

2026-07-30 自动化进展：新增 `annotation:neko:acceptance` 可执行门禁和
`--class-map` 固定语义映射；候选池已把 confirmed 正样本、hard negatives 和
随机池独立记录，CLIP/DINO 排序排除原型自身。门禁只认有审计事件的 manual
判定，并自动检查五类覆盖、每类 70% 人工占比、Top20/Top50/随机池 100%
完成度、数据指纹和源文件完整性。对现有标注文件的隔离只读审计结果为
1/5 类、48/147 manual（32.7%），且 1 个候选源文件已不存在，因此 ACC-02
保持“进行中”；没有把自动建议或类别名猜测计作人工真值，也未改写用户数据。

2026-08-01 自动化进展：

- 新增 `annotation:neko:plan`，在 ignored artifacts 中生成不含源文件路径的工作计划与可填写
  class-map 模板；计划同时读取当前素材库，报告类别正/负样本数、最低人工复核数、优先队列和
  不可恢复的失效候选。
- 修正人工审计边界：只有 `judgment-events` 中 dataset 指纹与当前候选集完全一致的 manual
  判断才计入 70% 门禁。旧记录的 48 项事件属于历史 dataset，严格复核后当前有效人工数为 0，
  最低需要 103 项，存在 146 项不含失效文件的复核队列。
- 标注页面会优先遍历 seeded/旧指纹判断，即使候选已经有预测标签也可直接按 1/2 重新确认，
  保存后写入当前 dataset 审计事件并自动进入下一项；不会再因“147/147 已决定”而停止。
- 当前素材库有 6 个类别，其中 5 个有 confirmed 正样本，已具备数量基础；但只有人物和图标类
  名称语义明确，其余为测试性名称，不能安全猜成物品、动物或场景。另有 1 个候选源文件失效且
  无同 assetId 新路径可恢复。2026-08-01 按用户决定将 ACC-02 改为暂缓；自动 TODO 队列不会
  再次选中，现有工作计划、标注数据和复核工具全部保留，恢复时可从当前断点继续。

### ACC-03 锁定发布门禁

1. `hybrid` 继续作为主门禁。
2. `hybrid_feedback` 只报告趋势，不作为主要发布结论。
3. 除宏平均外保存每分类 Precision、Recall、nDCG 和 Reject intrusion，任何关键分类明显回退都失败。
4. 延迟门禁区分冷缓存和热缓存，不允许只选择更好的一次。
5. 基线变更必须由单独提交完成，并解释算法、数据或硬件变化；禁止为了通过而直接放宽阈值。

### I18N-01 Renderer 全界面翻译

按面板逐个清理，建议顺序：

1. `VectorMaintenanceBar`、Image Search Data Manager。
2. Media Search。
3. Asset Library Backup、Suggestions、Categories、Clusters。
4. Remote Terminal 与 SFTP。
5. File Manager、Duplicate Finder、App Storage。
6. Settings、Prompt、Batch Rename 和公共窗口控件复核。

必须覆盖文本、placeholder、title、aria-label、toast、空状态、确认提示、进度、单位说明和错误。

完成记录（2026-07-30）：

- 已逐面板清理图片搜索数据管理、向量维护、Media Search、Asset Library、
  Remote Terminal/SFTP、公共搜索进度、设置帮助与错误边界中的可见英文文本；
  保留 DINO、CLIP、GPU、CPU、SFTP、hash、topK 等技术标识。
- 对 30 个本批修改的 Renderer 组件执行翻译键审计，除已登记的技术标识和
  多行字符串扫描转义外无缺失中文映射；新增维护、媒体、素材和远程终端翻译契约。
- 修复双语 smoke 在延迟挂载面板上的竞态：等待 7 个稳定 `data-panel` 全部挂载，
  布局也直接使用稳定面板标识，不再依赖会随懒加载替换而丢失的临时属性。
- `zh-CN` 与 `en` 开发态 UI 均找到 7/7 面板，语言/材质往返、图片搜索和素材库
  关键交互通过且控制台错误为 0。隔离 worktree 的 DINO/CLIP 开发态资源探针不可用，
  因而命令总体状态为非零；完整 `verify` 中的真实模型管线与生产构建均通过。
- `npm.cmd run test:settings` 21/21、`npm.cmd run test:ui-smoke-contract` 5/5、
  `npm.cmd run verify` 全部通过；lint 为 0 错误、5 条既有警告。

### I18N-02 运行时错误国际化

1. 主进程和 worker 返回稳定错误码与结构化参数，不返回必须直接展示的英文句子。
2. Renderer 按错误码翻译；未知错误使用双语通用说明并保留诊断详情。
3. 日志继续使用稳定英文技术事件名，用户界面不直接显示原始内部日志。
4. IPC 契约为错误码建立联合类型，测试未知码回退。

2026-07-31 已完成：

- 新增共享 `RuntimeErrorCode` 联合类型、结构化参数与失败结果；向量构建、隔离数据准备、
  DINO/CLIP worker 连续崩溃、向量维护互斥和视频帧向量构建均返回稳定错误码。
- Simple 图片/媒体库工作流保留结构化错误直到 Renderer，由当前语言映射为用户提示；
  旧接口或未来未知错误统一显示通用本地化说明，并仅把原始内容作为诊断详情附加。
- 后台诊断日志继续使用稳定英文事件名，未把日志事件直接作为界面主提示。
- IPC 契约统一使用 `RuntimeOperationResult`；回归测试覆盖已知码中文映射、未知码回退、
  旧式错误兼容及工作流跨层保留。
- `typecheck`、`test:settings` 23/23、`test:media-search` 32/32、向量管线 53/53、
  IPC validation/registration/preload contract 与 lint 均通过；lint 只有 5 条既有警告。

### I18N-03 静态门禁

1. 新增脚本扫描 JSX 文本、常见可见属性和直接 toast/confirm 字符串。
2. 技术名词、测试 fixture 和不可见标识进入窄 allowlist。
3. allowlist 每项注明文件、原因和到期条件。
4. 门禁先记录现有基线，再在完成清理后改为禁止新增和禁止残留。

2026-07-31 已完成：

- 新增 TypeScript AST 扫描器，覆盖 JSX 文本、JSX 字符串表达式、`title`、`aria-label`、
  `placeholder`、`alt`，以及 `showToast`、`setMessage`、`toast`、`confirm`、`alert`
  的直接字符串、模板、条件和 fallback 分支。
- 明确排除 `data-*` 稳定标识、已经包裹 `t(...)` 的文本、纯符号，以及由
  `DraggablePanel` 内部负责翻译的稳定面板 ID，避免门禁依赖可翻译标题。
- 首次精确基线记录 236 个存量组；每组锁定文件、类型、文本、出现次数、保留原因和
  移除条件。删除存量不会失败，新增文本、文本变化或出现次数增加都会失败。
- 新增 `test:i18n-static` 并接入完整 `npm test`；专项 5/5、typecheck、format 和 lint
  通过，lint 只有 5 条既有警告。

### I18N-04 双语 E2E

除 REL-01 基础 smoke 外，增加：

- 运行时中→英→中切换，无需重启。
- 搜索结果、Category/Tag、备份、清理和错误提示均随语言变化。
- 可访问名称在两种语言下存在且不重复。
- 文本变化不导致关键按钮遮挡、面板溢出或不可点击。
- 1920×1080、2560×1440、125% 和 150% DPI 至少形成自动截图基线。

2026-07-31 已完成：

- 新增 `smoke:ui:i18n` 四组合矩阵，中文和英文分别覆盖
  1920×1080@125% 与 2560×1440@150%，每组保存隔离的截图和 JSON 报告。
- smoke 在运行时执行“请求语言 → 另一语言 → 请求语言”，验证面板标题、搜索空状态、
  无效路径错误、Category/Tag、备份和向量清理控件同步翻译。
- 为关键交互补充稳定 `data-testid` 和可访问名称；两种语言均检查名称缺失、重复以及
  控件越界裁切。
- 窗口按物理像素和 DPI 换算 CSS viewport，并使用内容尺寸最小值避免 Windows 任务栏
  将 2K/150% 截图压缩；报告同时校验 DPR、CSS viewport 和截图物理尺寸。
- `npm.cmd run smoke:ui:i18n` 四组 4/4 通过；人工检查中文 1080p 和英文 2K 基线，
  未发现面板重叠或关键控件截断。

## 8. 第四阶段：可复现构建与公开分发闭环

### BLD-01 完整物料 manifest

每个模型和工具记录：

- 稳定 ID、组件类型和用途。
- 上游名称、精确版本、下载来源和发布日期。
- SHA-256、字节大小和目标相对路径。
- 许可证标识、许可证文件和 notice 要求。
- 是否首启必需、是否默认随包、支持的平台/架构。

`models/manifest.json` 必须作为文本进入 Git；二进制继续通过受控物料流程获取。

2026-07-31 已完成：

- 新增 `resources/runtime-manifest.json`，统一登记 10 个随包组件和 32 个制品：
  DINO、CLIP、多语言 CLIP 文本塔、YOLOv8n、YOLOv8n-face、AdaFace、OSNet、
  MobileSAM、FFmpeg/FFprobe 和 `fast_scanner.node`。
- 每个组件记录稳定 ID、类型、用途、上游名称、精确 revision 或构建版本、来源、发布日期
  （上游未提供时显式为 `null`）、SPDX、许可证文件、notice、审查状态、首启要求、默认
  随包策略和支持平台/架构；每个关键制品记录来源、SHA-256、字节数和目标相对路径。
- `models/manifest.json` 升级为 v2，同时保留运行时兼容字段；3 个可下载模型改为固定
  Hugging Face revision URL，并补齐发布和分发元数据。
- 新增清单结构、路径逃逸、重复目标、下载白名单交叉一致性和关键资源覆盖测试；本机
  校验会逐文件复算大小与 SHA-256。
- electron-builder 现在把统一 manifest 复制到 `resources/runtime-manifest.json`，
  packaged resource smoke 将它列为必需文件。
- `test:runtime-manifest` 5/5、`verify:runtime-resources` 10 组件/32 制品全部一致，
  `test:model-download` 20/20 通过。

### BLD-02 获取与校验

1. 脚本只读 manifest，非交互下载到临时路径。
2. 下载过程支持超时、重试、代理和断点安全，但哈希不符必须删除临时文件并失败。
3. 禁止自动使用 manifest 外的工作机残留文件。
4. 支持 `verify-only`，release build 必须先执行。
5. 离线构建使用显式缓存目录，缓存同样按哈希验证。

2026-07-31 已完成：

- 新增 manifest 驱动的 `resources:fetch` 和只读 `resources:verify`；变更型获取必须显式
  提供 `--cache-dir`，可指定 `--target-dir`、重复 `--component`、`--offline`、超时和
  重试次数。
- 缓存使用 `sha256/<digest>.blob` 内容寻址；已存在 target 只有在路径、大小和 SHA-256
  全部匹配 manifest 时才可播种缓存，不会扫描或采用清单外的工作机文件。
- 网络下载通过 Undici 环境代理 agent 支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`；
  支持重定向、超时和有界重试。下载先写唯一 partial，大小/哈希通过后才进入缓存，
  缓存再经过二次校验后发布到 target。
- 错误哈希、错误大小、中断、超时和损坏缓存均 fail closed，并清理 partial；离线模式
  缺少已验证 cache 时直接失败，不回退网络。
- `download`、`manual-review`、`local-build` 三种获取策略显式区分；后两者不会从替代
  URL 偷偷下载，必须提供已验证 target/cache。
- 清单从 14 个主制品扩充为 32 个完整运行物料，将 DINO/CLIP 的 config、tokenizer、
  vocabulary、preprocessor 和多语言 Dense 配置全部纳入固定 revision、大小与哈希。
- release gate 在打包前新增 `runtime-resources` 只读步骤；专项 12/12、模型/发布链
  27/27、真实工作树 32/32 制品验证通过。

### BLD-03 干净环境重建

1. 使用新的隔离目录执行 `git clone/worktree + npm ci`。
2. 从空物料缓存和受控缓存各重建一次。
3. 生成物料清单、依赖 SBOM、构建工具版本和安装器内容清单。
4. 把 commit、lockfile hash、manifest hash、安装器 hash 绑定在同一 release record。
5. 可复现目标先定义为“内容和来源可复现”；若 NSIS 时间戳导致字节不一致，明确记录非确定字段。

完成记录（2026-07-31）：

- 新增 `build:reproducible`，在同一 commit 的两个 detached worktree 中分别执行空 cache
  播种和受控 cache 复用；两个环境都从 `npm ci` 开始，运行时物料只允许通过 manifest
  与 SHA-256 校验后离线恢复。
- 每次构建生成 CycloneDX SBOM 和逐文件物料报告；汇总记录直接绑定 commit、lockfile、
  runtime manifest、两次安装器、构建工具版本，以及 renderer、Electron 和
  `win-unpacked` 的内容树哈希。
- package 模式保留并清点安装器展开目录。验收要求所有非例外文件逐字节一致；MSVC
  `.node` 及由其传递变化的 ASAR/主 EXE 只允许“同路径、同大小、哈希不同”，逐项记录
  原因与两次哈希。NSIS 本体同样记录两次哈希，但因归档元数据和未来签名时间戳允许
  字节不一致。
- Windows native 编译统一使用 commit 时间作为 `SOURCE_DATE_EPOCH`，并启用 MSVC
  `/Brepro`、`/experimental:deterministic` 与 worktree `pathmap`；安装包排除 `.tlog`、
  `.iobj`、`.ipdb`、`.vcxproj`
  等仅用于增量编译且包含绝对路径的中间物。
- 专项测试覆盖隔离路径、空 cache、双 pass 计划、确定性目录摘要、动态安装器命名和物料
  来源展平、无 shell 的 npm CLI 启动与确定性 native 环境；实际隔离双构建证据由命令
  输出目录中的 `comparison-report.json`、两份
  `material-report.json` 和两份 `sbom.cdx.json` 组成。

### LIC-01 与 LIC-02 许可证闭环

工程动作：

1. 增加项目自身 `LICENSE` 和 `package.json#license`。
2. 修正 `THIRD_PARTY_NOTICES.md` 中“模型不随包”的过期描述。
3. 自动从 manifest 生成随包组件、版本、来源和许可证清单。
4. 把 notices 和所需许可证文本纳入安装器，并由 archive smoke 验证。
5. 对 GPL/version3 FFmpeg 明确构建配置、源码获取/书面提供要求和分发方式。
6. 对 AGPL YOLO 权重与实现完成专业审查；结论可能是取得授权、替换组件、改为用户自行下载或调整分发方式。

验收标准：专业审查结论有记录，安装器内材料与实际随包内容一致，不存在“声明未打包但实际已打包”的冲突。

工程准备记录（2026-08-01）：

- 新增由 `resources/runtime-manifest.json` 确定性生成的
  `THIRD_PARTY_COMPONENTS.md`，逐项记录 10 个随包组件的上游版本、SPDX、审查状态、
  是否默认打包和制品数；生成结果漂移会由专项测试失败。
- 修正 `THIRD_PARTY_NOTICES.md` 中“模型不随包”“默认只包含商业友好许可证组件”等与
  当前离线安装包冲突的陈述，明确列出 AGPL YOLO、GPL FFmpeg、训练数据来源和项目许可证
  仍待审查。
- electron-builder 将 notices 和生成清单复制到 `resources/legal/`，packaged resource
  inventory 将二者作为必需文件；许可证专项测试同时锁定真实随包状态和未批准状态。
- 本批没有添加项目 `LICENSE` 或 `package.json#license`，因为许可证选择必须由版权负责人
  明确决定；也没有把 `legal-review-required` 或 `project-license-pending` 改成批准。因此
  当时 LIC-01/LIC-02 继续保持暂缓，当前安装器仍不是公开或商业发布候选。

执行门禁进展（2026-08-01）：

- 用户恢复许可证合规工作后，LIC-01/LIC-02 改为进行中；新增结构化
  `legal/license-decisions.json`，覆盖项目许可证和 runtime manifest 的全部 10 个组件。
- `licenses:gate` 根据 offline/online profile 的真实随包 manifest 校验审批状态、处置类型、
  适用 profile、审批人、时间、证据及许可证文件；空文件列表、缺失/越界文件和未知组件均不能
  绕过门禁。
- release gate 在资源核验后、打包前执行许可证门禁。当前 offline profile 明确阻断 10 个随包
  组件；online profile 只把 native addon 作为随包组件阻断，并记录 9 个未随包待决组件。
  两种 profile 还都会因项目许可证未决而阻断。
- 决策记录中的所有项目仍为 pending，本批没有添加 `LICENSE`、虚构 `package.json#license`、
  商业授权、源码提供方案或专业审查结论。只有授权负责人填写真实决定和证据后，门禁才允许
  后续正式发布流程继续。
- 商业首发模型平台进展（2026-08-01）：Ultralytics YOLOv8n、Lindevs YOLOv8-Face、
  AdaFace WebFace12M、OSNet-AIN 与 PulpCut MobileSAM ONNX 改为非随包候选；默认 offline
  安装包也不再复制其 6 个 ONNX 文件。Lindevs 与 PulpCut 的状态同步降级为
  `legal-review-required`，避免仅凭下游仓库标签将其误判为商业批准。
- 设置页新增 6 个用户模型兼容槽位，覆盖主体检测、人脸检测、人脸特征、行人重识别以及分割
  编码器/解码器。用户确认自行承担许可证和兼容性责任后才可导入、替换或移除本地 ONNX；
  应用不提供上述待审候选的一键下载，模型缺失或接口不兼容时保持既有安全降级路径。
- “模型平台”不是任意 ONNX 通用执行器：每个槽位固定输入尺寸、输出结构和最大 1 GiB 文件
  边界。当前 FFmpeg、项目专有 EULA、native addon 与其余随包组件的真实审批仍由后续
  LIC-01/LIC-02 决策闭环处理。
- 专有发布模式预配置（2026-08-01）：用户确认闭源商业软件与专有 EULA，模型继续由用户自行
  安装；版权主体暂不填写。项目先标记为 `private`/`UNLICENSED`，决策记录选定
  `proprietary` 但保持 `pending`。不可分发 EULA 模板不会进入安装包，门禁也拒绝用
  `draft/template` 文件冒充最终 EULA；主体、正式条款、审批人与证据补齐前 LIC-01 不关闭。

### REL-04 正式发布记录

每次候选发布必须：

1. 递增版本，不再长期复用 `1.0.0`。
2. 生成 changelog、release manifest、SBOM、验证摘要和已知限制。
3. 对安装器执行 Authenticode 签名和可信时间戳。
4. 在独立步骤验证签名主体、时间戳和安装器 SHA-256。
5. release record 指向唯一 Git commit，不接受工作区未提交产物。

## 9. 第五阶段：安全与长期维护

### SEC-01 GPU thumbnail 隔离

1. 把 GPU 子窗口改为 `nodeIntegration:false`、`contextIsolation:true`、优先 `sandbox:true`。
2. 使用最小 preload，仅暴露任务输入、结果、取消和健康状态。
3. 限制消息大小、图片尺寸、格式、任务并发和 sender。
4. 如果 sandbox 与 GPU API 存在兼容问题，记录最小必要例外，不恢复通用 Node 权限。

完成记录（2026-08-01）：

- GPU 隐藏窗口已关闭 Node 集成，开启 context isolation、sandbox、web security，并使用独立
  非持久 partition；窗口创建、导航、webview 和所有权限请求均默认拒绝。
- 新增 1.53 KiB 专用 preload，只桥接任务、结果、取消和健康状态；页面不再直接
  `require('electron')`，主进程结果监听仍绑定精确 `webContents.id`。
- 主进程和 preload 双重限制输入格式、32–256 px 尺寸、64 MiB 源数据与 8 MiB 输出；每个
  GPU worker 保持单任务串行，池大小继续限制为最多 8 个。
- 真实 Electron smoke 在 sandbox 下由 NVIDIA WebGL 完成 3/3 张图片，0 CPU 回退、0 错误，
  GPU 阶段耗时 243 ms；专项测试 10/10、typecheck 与 Electron/renderer bundle 均通过。
- 本项按用户明确暂缓人工/许可证发布链后的重新排序独立实施，不解除 ACC-03、LIC-02、
  REL-04、SIZE-01 的依赖，也不把当前候选安装器标记为正式发布。

### SEC-02 IPC 能力收敛

1. 按领域拆分 `shared/ipc-contract.ts`。
2. 所有高权限 handler 声明 `R/W/FS/EXT/PROC/NET/SECRET` 能力。
3. 建立统一 sender/frame/origin allowlist。
4. 自动比较 preload 暴露、主进程注册和 capability matrix。
5. 新增 handler 没有能力声明或验证器时直接测试失败。

完成记录（2026-08-01）：

- 248 个 renderer invoke handler 与 `fileDrag:start` send handler 已全部迁移到统一授权包装器；
  只接受显式登记的主窗口 `webContents`、main frame 与 packaged file/开发态 loopback origin。
- 新增 `R/W/FS/EXT/PROC/NET/SECRET` 能力声明解析器与公共 bounded structured-clone
  validator；未声明 domain、超过 64 个参数、1 MiB 字符串、10,000 项集合、64 MiB 二进制、
  12 层嵌套、循环对象或非有限数值会在进入业务 handler 前失败。
- 契约测试使用 TypeScript AST 同时解析字面量与 IPC 常量，自动比较 preload invoke、main
  注册和能力/validator 矩阵；任何一侧新增而另一侧缺失都会失败。
- `shared/ipc-contract.ts` 从 1,634 行降到 893 行；App Core、App Storage、File Manager、
  Image/Vector、Remote Terminal、Subject/SAM/Batch Rename 与既有 Media/Asset 共 9 个领域模块，
  barrel 继续保持 renderer 类型兼容。
- IPC/Preload 专项测试 9/9、typecheck、lint 0 error、完整 bundle 与真实中文 Electron UI smoke
  均通过；7 个面板、语言切换、素材库备份/恢复正常，console error 为 0。
- 本项不改变 ACC-02、许可证、签名和 release record 状态。ARC-01 改为依赖 SEC-02，可继续
  非发布类维护；正式发布仍被原 P1 人工与合规项阻断。

### QA-01 工具链、CI 与覆盖率

1. 在 `package.json` 声明 `engines` 和 `packageManager`，提交 `.nvmrc` 或等价版本文件。
2. CI 先覆盖 Windows 干净安装、verify、审计、双语 smoke 的可自动部分。
3. 建立覆盖率基线，优先统计 path/IPC、事务、备份、向量 GC、i18n 和 release scripts。
4. 初期不以高百分比为目标；禁止关键模块覆盖率下降。
5. 真实模型/安装器任务放到受控 runner，普通 PR 使用 fixture。

完成记录（2026-07-31）：

- `.nvmrc`、`engines` 与 `packageManager` 统一锁定 Node 24.16.0 / npm 11.13.0；
  `.npmrc` 开启 engine-strict，`toolchain:check` 同时校验元数据一致性和当前运行时，避免
  本机与 CI 静默漂移。
- Windows PR/main CI 使用干净 `npm ci`、完整 verify、关键覆盖率门禁和生产依赖审计；权限
  限制为 contents read，并按 workflow/ref 取消过期并发任务。
- 真实模型和安装器验证拆到仅手动触发的受控 Windows runner，从显式 reviewed cache 离线
  恢复物料后执行 verify、package、packaged resources、双语 packaged UI 和安装器 archive
  smoke；普通 PR 不接触大型模型或工作机 cache。
- Node 原生覆盖率门禁固定 10 个关键文件、9 个测试入口和 76 项测试。基线实测为行
  82.30%、分支 70.86%、函数 82.67%，汇总下限设为 81/69/81；path/IPC、事务、备份、
  vector GC、i18n 与 release scripts 另有逐文件下限，任何单项下降都会失败。
- 覆盖率报告写入 ignored `artifacts/coverage/critical-summary.json`，版本化基线只保存指标，
  不提交包含本机路径的原始运行数据。

### PRV-01 路径脱敏

1. 扫描 Git 跟踪文档和 JSON 中的用户目录、QQ/微信目录和账户标识。
2. 用 `<USER>`、`<QQ_DATA>`、`<DATASET>` 等稳定占位符替换。
3. 原始 benchmark 只留在 ignored artifacts。
4. 增加提交前隐私路径检查，Windows 和 Unix 用户目录都覆盖。

完成记录（2026-07-31）：

- 29 个已跟踪文档/JSON 已用 `<USER_HOME>`、`<QQ_DATA>`、`<WECHAT_DATA>`、
  `<APP_DATA>`、`<DATASET>` 等稳定占位符脱敏；保留的 benchmark 只含脱敏后的可复核结果。
- 媒体扫描与中文语义评估的原始输出默认迁移至 ignored `artifacts/benchmark/`，避免后续运行
  再把真实素材路径写入 `docs/benchmark/`。
- 新增 `privacy:check`、`privacy:redact` 和 4 项专项测试，覆盖普通/JSON 转义 Windows 路径、
  Unix 用户目录、QQ 数字账户与微信 wxid。
- `git:validate-staged` 的临时提交快照会先运行 `privacy:check`，提交内容存在个人路径时直接失败。

### SIZE-01 安装包瘦身

1. 将非首启必需模型拆为带 manifest 和哈希的可选包。
2. 比较 FFmpeg slim/shared build、按需下载和系统工具发现方案。
3. 保留离线完整包时，明确区分 online、offline 两类发布物。
4. 设置安装包和 unpacked 资源体积预算，超预算需解释。

完成记录（2026-08-01）：

- 在用户明确选择安装包瘦身后，以不改变许可证发布结论为边界提前完成技术拆分；默认 `build`
  与显式 `build:offline` 保持完整离线包，新增 `build:online` 生成独立命名的在线包。
- 在线 profile 只保留模型 manifest，不随包复制 `models` 实体、`ai-models` 或 `tools/ffmpeg`；
  runtime manifest 与随包第三方清单按 profile 生成，准确标注实际 bundled 状态。
- 资源 smoke 按随包 manifest 自动识别 online/offline 契约；新增 profile、资源清单、安装包命名、
  release 清理和在线归档回归测试，离线默认配置保持原样。
- 实际在线 NSIS 安装包为 168,906,813 字节（161.08 MiB），相对现有 968.51 MiB 离线基线
  减少 83.37%；归档包含 241 个文件并通过 7-Zip 完整性检查，SHA-256 为
  `99A09DD8C1C5EF330EA9271A768202831110137FE55FE39D559B5EE954B37115`。
- 实际 `win-unpacked/resources` 检查通过 19/19 必需项，未发现 `ai-models`、`tools` 或旧重复
  路径，`models` 下仅有 4,196 字节的 `manifest.json`；资源目录共 304.75 MiB。
- 在线包中文 packaged UI smoke 通过：7 个面板、双语切换、素材库事务与备份恢复均正常，
  0 console error；明确验证 DINO/CLIP 未随包、native addon 来自 resources，系统 FFmpeg 可用。

未覆盖边界：在线包依赖现有 manifest/缓存准备流程取得模型，并依赖配置或系统 FFmpeg；缺少
对应资源的功能会按现有运行时能力降级或不可用。LIC-01/LIC-02 仍暂缓，因此本项只证明工程
瘦身与产物完整性，不批准 YOLO、FFmpeg、模型或项目本身的公开/商业分发，也不解除 REL-04。

### DEP-03 生态升级

分组执行，禁止一次跨越所有 major：

1. `xterm` → `@xterm/xterm`。
2. ESLint 与 TypeScript ESLint。
3. Vite 和构建插件。
4. React、Zustand 和 UI 状态层。
5. 核实 `@types/ssh2` 并移到 devDependencies。

每组执行完整 verify 和对应 packaged smoke。

阶段记录（2026-07-31，第一组）：

- 已弃用的 `xterm@5.3.0` 已迁移为同 API 代际的 `@xterm/xterm@5.5.0`，CSS、类型导入与
  动态加载入口全部切换；`@xterm/addon-fit@0.11.0` 保持兼容版本。
- `@types/ssh2` 从生产依赖移入 devDependencies，安装包不再把纯类型包视为运行时依赖。
- 新增 lockfile 契约，阻止旧 `xterm` 回流或 SSH 类型包重新进入生产依赖。
- 定向验证已通过，生产依赖审计为 0。完整 verify 在全部测试通过后因当前运行中的开发版
  Electron 占用 native addon 而无法原地重建；改用隔离 staged snapshot 完成最终验证。

阶段记录（2026-07-31，第二组）：

- ESLint 8 / TypeScript ESLint 7 升级为 ESLint 10.8 / TypeScript ESLint 8.65，配置迁移至
  `eslint.config.cjs` flat config；React Hooks、Prettier config 和 globals 同步升级兼容版本。
- 新版新增的 `no-useless-assignment` 与 `preserve-caught-error` 暂按旧行为关闭，留给 ARC-01
  专项修复；require 例外改用新规则名，lint 仍保持 0 错误、5 条既有警告。
- 最终 npm peer tree 无 invalid；完整开发依赖审计由 26 high 降到 16 high，剩余项全部位于
  electron-builder 打包链，生产依赖仍为 0。

阶段记录（2026-07-31，第三组）：

- Vite 6 升级至 7.3，React 插件升级至 5.2，Electron renderer 插件升级至 1.0；继续保留
  Windows 上已验证的 `configLoader runner`。
- `vite-plugin-electron@1.1` 在 Vite 7 下错误下传 Rolldown `platform` 选项，11 个入口均产生
  unknown-option 警告；最终固定为无警告的 `0.29.1`，不以“仍能产出文件”掩盖兼容问题。
- 146 个 renderer 模块、main/preload 和 9 个 worker/child 入口全部构建成功且为 0 warning；
  主 renderer JS gzip 由约 102.18 KiB 降至约 101.41 KiB。

阶段记录（2026-07-31，第四组）：

- React、React DOM 从 18.3 升级至 19.2，Zustand 从 4.5 升级至 5.0，并同步升级 React 类型定义。
- 全量扫描 Zustand selector：当前组件只直接返回 store 中的稳定字段，没有 Zustand 5 会反复创建
  数组或对象的 selector；入口已使用 `createRoot`，没有 React 19 移除的旧 ReactDOM 挂载 API。
- 类型检查、UI smoke 契约、依赖安全门禁、lint 和 renderer/Electron 全入口构建通过；生产依赖
  审计保持为 0，并新增 React/Zustand package-lock 组合契约。

阶段记录（2026-07-31，收尾验证）：

- node-gyp 从 13.0.0 更新至 13.0.1，真实 Node/Electron 双 ABI 原生重建与 42 项 native 测试通过；
  Prettier 3.9 会造成 8 个无关格式差异，因此保留已验证的 3.8.4 并锁定当前下限。
- 新候选安装器为 968.51 MiB、273 个归档文件，SHA-256 为
  `1B0EDDBDD3DE70656F46D2D45D25E4428F291BC262F79D4D3DC0A98C933F588C`；安装器归档 smoke 通过。
- packaged 资源 28/28 通过；中文、英文 UI smoke 均通过，7 个关键面板、语言往返、素材库备份
  恢复、YOLO、MobileSAM、DINO、CLIP、FFmpeg/FFprobe 与 fast_scanner 均有真实运行证据。
- Vite 8/React 插件 6、Xterm 6、Electron 43、TypeScript 7 和 Undici 8 均属于已识别的下一代
  边界，不跨 major 追加到本任务。DEP-03 的计划分组与最终 packaged 验证全部完成，状态改为已验证。

### GIT-01 灾备与分支治理

1. 由用户确定可信私有远端或离线裸仓库位置。
2. 首次推送/备份前执行敏感路径和凭据审计。
3. 验证从灾备恢复 main、tag 和 release record。
4. 只删除已经合入且未被 worktree 使用的分支。

完成记录（2026-08-01）：

- 用户明确授权全 refs 历史重写，并指定 `D:\ReasonixGitBackups` 为永久灾备根。重写前建立
  独立敏感 mirror，完成 `git fsck --full`，同时快照主目录 `start.bat` 和两个存在未提交
  改动的旧 worktree；原始敏感镜像只用于本机恢复，不得推送或公开。
- 对 117 个可达提交、105 个本地分支统一替换 Windows 用户目录、QQ 账户目录和微信账户标识；
  重写后 `git:history-audit` 从 1,036 条命中降为 0，高置信凭据仍为 0。
- 重写前后 `main` tree SHA-1 均为 `186cfde5ca84a30950ed94ce0eb695f676845b80`，证明业务文件
  内容未发生额外变化；对象完整性检查通过，且不存在旧敏感不可达对象。
- 32 个已完成旧 worktree 在逐路径边界校验后清理；两处真实未提交源码先保存 patch/逐文件
  副本。104 个已确认是新 `main` 祖先的本地分支使用非强制删除收敛，收尾后只保留 `main`。
- 正式脱敏 bundle 与裸仓库写入同一灾备根，并执行 bundle verify、bare `fsck` 和恢复克隆
  tree 对比。灾备不包含忽略资源、安装包、模型、用户数据库或未提交工作区文件。

执行边界：重写前敏感 mirror 与脏工作区快照仍包含本机路径或未发布代码，只能作为受控本地
应急恢复材料；可共享灾备只能使用标记为 clean 的 bundle/裸仓库。后续如配置远端，必须从
脱敏后的 `main` 强制建立新历史，不得从旧 worktree 或敏感 mirror 推送。5. `start.bat` 的纳管、忽略或保留由用户单独决定，本方案不替用户处理。

阶段记录（2026-07-31）：

- 新增 `git:history-audit`，扫描所有可达 refs 的文档/JSON 历史补丁，并复用当前路径和高置信
  凭据规则；当前发现 1036 条历史隐私命中，凭据命中为 0。
- `git:backup` 在创建目标目录和 bundle 前强制运行历史审计，避免把已从当前树删除的个人路径
  复制到新灾备；专项测试验证“当前树已脱敏但历史仍泄露”也必须失败。
- 当前无 remote，且大量已合并分支仍被外部 worktree 占用。历史重写属于破坏性操作，可信
  私有远端/离线裸仓库位置也必须由用户指定，因此本项保持进行中，尚未备份或删除任何分支。

### ARC-01 维护收尾

1. 清零当前 5 条 ESLint 警告。
2. 按职责拆分 1,000～2,000 行热点，不改变发布门禁期间的行为。
3. 为 1920×1080、小屏、125%/150% DPI 和多显示器增加布局 E2E。
4. 统一 Roaming/Local 数据目录说明和用户可见路径。

完成记录（2026-08-01）：

- ESLint 10 的 `no-useless-assignment` 与 `preserve-caught-error` 已改为 error；原 5 条警告和
  新规则发现的错误全部清零，异常包装保留原始 `cause`。
- `thumbnailIpc.ts` 的磁盘缓存和 PSD 内嵌预览解析分别迁入
  `thumbnailDiskCache.ts`、`psdThumbnailPreview.ts`；IPC 文件由 1,190 行降至约 1,028 行，
  缓存版本、旧缓存兼容、并发淘汰和生成路径行为保持不变。
- UI smoke 矩阵扩展为 6 个真实 Electron 场景：1366×768 小屏、1920×1080、2560×1440、
  125%/150% DPI、中文/英文，以及 `x=-1536` 的副显示器工作区。布局 fixture 改为按 CSS
  工作区动态 3/4 列，6/6 均覆盖 7 个主要面板且 console error 为 0；报告同时校验窗口 bounds。
- 新增 `2026-08-01-data-directory-policy.md`，明确运行时唯一数据根为
  `app.getPath('userData')`（Windows 默认 `%APPDATA%\\floating-clock-electron`），区分 Roaming
  用户数据与 Local 安装/工程/构建产物。设置页入口同步改名为“打开应用数据目录”。

## 10. 建议实施批次

### 批次 A：门禁骨架

`REL-01 → REL-02 → DEP-01 → DEP-02 → REL-03`

退出条件：开发态双语 smoke 可靠，依赖风险有明确结果，当前安装包存在有效 packaged runtime 证据。

### 批次 B：磁盘止损

`DSK-01 + DSK-02 → DSK-03 → DSK-04 → DSK-05`

退出条件：日志不再无上限增长，用户能安全预览和清理，失活向量可回收且可恢复。

### 批次 C：搜索性能与双语闭环

`ACC-01 + ACC-02 → ACC-03`，同时执行 `I18N-01 → I18N-02 → I18N-03 → I18N-04`

退出条件：准确率性能门禁通过，至少 5 个分类具备以人工标注为主的数据，全部主要功能通过中英文 E2E。

### 批次 D：可复现与合规发布

`BLD-01 → BLD-02 → BLD-03`，并行 `LIC-01 → LIC-02`，最后 `REL-04`

退出条件：干净环境可以重建，物料与许可证一致，候选安装器已签名并绑定唯一提交。

### 批次 E：长期治理

`SEC-01 → SEC-02`、`QA-01`、`PRV-01`、`SIZE-01`、`DEP-03`、`GIT-01`、`ARC-01`

退出条件：CI 和覆盖率稳定，IPC 与 GPU 子窗口风险收敛，灾备可恢复，维护债务进入持续门禁。

## 11. 每个任务的通用验收模板

```markdown
### <任务 ID> 完成记录

- 状态：已验证
- 执行系统：
- 所有者：
- 分支：
- 提交：
- 修改范围：
- 用户数据影响：无 / 预览 / 已确认迁移
- 回退方式：
- 验证：
  - `npm.cmd run typecheck`：通过
  - `npm.cmd run lint`：通过，0 错误
  - `npm.cmd run format:check`：通过
  - 专项测试：N/N 通过
  - `npm.cmd run verify`：通过或说明未执行原因
  - smoke/benchmark/package：实际结果
- 未覆盖边界：
```

任何失败都要保留命令、退出码和错误摘要，不得把“已编码”写成“已完成”。

## 12. 当前下一步

门禁骨架 `REL-01 → REL-02 → DEP-01 → DEP-02 → REL-03` 已全部验证。执行 `npm.cmd run todo:next` 会从本文件的总任务表解析依赖，输出当前第一个可执行 TODO、全部并行就绪项和每个阻塞项仍缺少的依赖；该命令作为后续自动推进的唯一队列入口。

ACC-02 与许可证链按用户决定暂缓后，SEC-01、SEC-02 已作为不改变发布结论的独立安全项完成。
截至 2026-08-05：FastScanner FS-07O→07S 全部完成、交接待办清零；向量存储阶段 D1、D2a/b/c 与
D3-1/2/3 全部完成（批次 114-118）；`ARC-01` 等 32 项任务均已验证，工程侧自动可执行任务已清空，
队列剩余 LIC-01（阻塞，需版权负责人决策）、ACC-02（暂缓）、ACC-03/REL-04（被阻塞）；下一步
入口见[2026-08-05 向量与 FastScanner 交接](../handoffs/2026-08-05-vector-and-fastscanner-handoff.md)。
后续任何任务仍使用独立分支、专项测试、完整 `verify`、提交验证
和 fast-forward 合并；任一步失败即停在该 TODO 修复，不越过失败项伪造完成状态。

已完成任务均未删除、移动或压缩用户数据；ignored 模型和 FFmpeg 物料只在隔离 worktree 中只读复用。

### 2026-08-01 用户模型兼容配置扩展

- 六个本地用户模型槽位升级为显式 profile：YOLOv8/9、YOLOv5/7、NMS detection、YOLO
  face、ArcFace/AdaFace、FaceNet、OSNet/Torchreid、FastReID 与两种 SAM encoder layout。
- profile 固定布局、归一化和输出语义；运行时动态解析 tensor 名、固定 input metadata 尺寸、
  检测输出方向、类别/anchor 数、特征维度和 SAM embedding shape。
- schema v1 安装记录向后兼容，新增安装写入 schema v2/profileId。模型签名与缓存键包含配置，
  避免更换模型后混用旧特征。
- 这是一组受控 adapter，不是任意 ONNX 自动执行器；新增架构必须先增加张量契约、测试和真实
  模型验证，许可证门禁不因用户模型兼容范围扩大而放宽。
- 后续扩展（2026-08-01）：新导入模型增加 CPU graph metadata 诊断和 schema v3 检查记录；
  主体/人脸检测支持独立 boxes/scores/labels tensor；人脸检测支持具名或数字分组输出的
  SCRFD stride 8/16/32。结构诊断失败时目录级事务保留原模型。
- RetinaFace 扩展（2026-08-01）：新增 `loc/conf/landms` prior-box profile、BGR 104/117/123
  均值预处理、stride 8/16/32 prior 与五点解码，并在导入时检查三输出尾维。该 profile 只覆盖
  固定 prior 参数的常见导出，不包含权重，也不扩大许可证授权范围。
- FastScanner FS-01（2026-08-01）：在所有 stb/WIC 图片入口增加统一的单边、总像素和解码
  内存预算，超限输入在像素缓冲分配前失败；限制通过 native status 可观测。FastScanner 更新为
  0.5.2 并重建 Node/Electron ABI，native 专项 46/46 通过。下一步按风险顺序处理异步取消，
  再引入有界并行扫描流水线。
- FastScanner FS-03（2026-08-01）：新增 Promise 异步停止接口，把线程 join 移出 Electron 主线程；
  暂停轮询改为条件变量唤醒，并用生命周期锁串行化启动、停止和清索引。FastScanner 更新为
  0.5.3，Node/Electron ABI 构建及新增停止/重启回归通过。下一步为 FS-02 有界并行扫描流水线。
- FastScanner FS-02（2026-08-01）：目录枚举/USN 生产端接入容量 64 的背压队列，由两个 scan
  worker 并行读取、解码和双哈希；停止会唤醒队列与暂停等待，运行时暴露队列和活跃 worker
  指标。FastScanner 更新为 0.5.4，native 47/47 通过。下一步拆分进程级全局扫描状态。
- FastScanner FS-04（2026-08-01）：新增显式 `ScanRuntime`，集中拥有线程、停止/暂停状态、进度
  文本和队列同步对象；扫描线程、流水线与异步停止工作项通过 runtime 引用协作。FastScanner
  更新为 0.5.5，native 48/48 通过。当前模式仍是 `singleton-context`；下一步拆分索引与指标状态。
- FastScanner FS-05（2026-08-01）：新增 runtime-owned `ScanMetrics`，收拢扫描结果、枚举、阶段
  耗时和日志限流指标，进度 IPC 契约保持不变；查询图片不再污染扫描指标。FastScanner 更新为
  0.5.6，native 48/48 通过。下一步拆分共享索引容器、映射段和持久化状态。
- FastScanner FS-06（2026-08-02）：新增进程级 `IndexRuntime`，统一拥有内存索引、映射段、路径映射、
  索引模式、持久化元数据、共享计数器和 USN 状态；USN 数值统计改为原子访问，backend/fallback
  状态通过互斥快照读写。FastScanner 更新为 0.5.7，native 48/48 通过。下一步把 N-API 回调从
  单例访问迁移为显式 `AddonContext`/runtime 依赖，再评估多 env 实例。
- FastScanner FS-07A（2026-08-02）：新增 N-API instance-data `AddonContext`，每个 env 独立拥有
  `ScanRuntime`，并通过显式指针访问暂时共享的 `IndexRuntime`；env finalizer 负责停止自身扫描，
  共享资源仅由最后一个 env 清理。Worker env 初始化/销毁后主 env 索引保留回归通过。FastScanner
  更新为 0.5.8，native 49/49 通过。下一步迁移索引辅助函数的显式依赖并消除共享索引单例。
- FastScanner FS-07B（2026-08-02）：扫描线程、USN 枚举/增量读取、失败路径记录、扫描进度、索引统计、
  清理和映射卸载入口统一接收当前 AddonContext 的 `IndexRuntime&`；源码契约禁止扫描与 USN 核心
  函数重新访问共享全局名。FastScanner 更新为 0.5.9，native 49/49 通过。下一步迁移搜索链路，
  再迁移 manifest/segment 异步持久化链路。
- FastScanner FS-07C（2026-08-02）：segment/GD/内存搜索、同步与异步图片搜索、索引查询和六个编辑
  入口统一接收当前 AddonContext 的 `IndexRuntime&`；异步完成数据显式保存索引指针。路径隐藏与
  有效记录查找也完成依赖注入。FastScanner 更新为 0.5.10，native 49/49 通过。下一步迁移
  manifest/segment 同步与异步持久化链路。
- FastScanner FS-07D（2026-08-02）：manifest/segment 同步保存、加载、热重载、overlay、失败路径、
  Global Directory 和索引状态查询统一接收当前 AddonContext 的 `IndexRuntime&`；共享持久化 helper
  改为显式参数，异步调用暂时明确传入共享实例。FastScanner 更新为 0.5.11，native 49/49 通过。
  下一步迁移异步 load/save/compact 工作项，再评估 IndexRuntime 所有权迁入 AddonContext。
- FastScanner FS-07E（2026-08-02）：异步 manifest load/save/compact 工作数据保存当前 `IndexRuntime*`，
  worker、完成回调、入口快照和内部 cleanup 均沿显式依赖访问索引；新增真实异步保存、加载、双 segment
  压缩回归。FastScanner 更新为 0.5.12，native 50/50 通过，源码中只保留单例声明与 AddonContext
  初始化两处 `g_indexRuntime`。下一步评估 IndexRuntime 所有权迁移和多 env 写入隔离。
- FastScanner FS-07F（2026-08-02）：进程共享 IndexRuntime 改由弱引用服务按需创建，AddonContext 与所有
  索引异步工作数据共同持有 `shared_ptr`；最后一个所有者释放时由 IndexRuntime 析构统一卸载 segment/GD。
  `g_indexRuntime` 和异步裸索引指针均已删除，Worker env 异步搜索与 finalizer 回归通过。FastScanner 更新
  为 0.5.13，native 50/50 通过。下一步补共享索引写入准入和 ScanRuntime 异步生命周期协议。
- FastScanner FS-07G（2026-08-02）：共享 IndexRuntime 新增可观测的单写者租约，scan、clear、编辑、同步
  segment/manifest 与异步 load/save/compact 统一竞争写入准入；异步数据和扫描线程持有租约到完成/失败。
  跨 Worker env 回归确认主 env 暂停扫描时子 env clear 被拒绝并报告当前写者。FastScanner 更新为 0.5.14，
  native 51/51 通过。下一步处理 StopScanAsyncData 与 env finalizer 的 ScanRuntime 生命周期。
- FastScanner FS-07H（2026-08-02）：AddonContext 的 ScanRuntime 改由 `shared_ptr` 持有，
  `StopScanAsyncData` 复制所有权并复用同步停止临界区，因此 env finalizer 与异步 stop 不再竞争裸指针或分段
  更新生命周期状态。新增 stop work 可观测字段与 Worker env 在 Promise 完成前终止的回归；FastScanner 更新为
  0.5.15，native 52/52 通过。下一步梳理通用 N-API async work 注册、取消与 env teardown 协议。
- FastScanner FS-07I（2026-08-02）：每个 AddonContext 新增共享生命周期的 AsyncWorkRegistry，stop、manifest
  load/save/compact、hash 和 search 共 6 类 N-API async work 统一在创建后登记、完成时注销，并检查 create/queue
  失败路径。env cleanup hook 在 instance finalizer 前关闭注册并调用 `napi_cancel_async_work` 取消尚未执行的任务；
  工作数据持有 registry 和运行时资源直到 complete。FastScanner 更新为 0.5.16，native 53/53 通过。下一步为
  已开始执行的长时间 persistence 工作增加协作式取消检查点。
- FastScanner FS-07J（2026-08-02）：manifest load/save/compact 工作数据新增共享取消 token，加载、合并与 segment
  序列化循环加入检查点；registry 改用 async cleanup hook 排空，并新增 `cancelAsyncWork()` 供 Worker 在关闭握手中
  显式请求运行中任务退出。save/compact 在 manifest 原子替换前取消会清理 tmp 和新 segment，替换后继续完成提交。
  pre-commit Worker 回归验证约 50ms 内取消且无孤立产物。FastScanner 更新为 0.5.17，native 54/54 通过。
  下一步把显式取消握手接入实际 FastScanner Worker/controller 关闭路径，并补应用层集成回归。
- FastScanner FS-07K（2026-08-02）：Electron 主进程关闭路径接入 `cancelAsyncWork()` 显式取消握手；
  `imageSearchService` 新增幂等的 `shutdownImageSearchForQuit()`（取消 → 停扫描 → await autosave 链 →
  5 秒上限排空 registry），`main.ts` 的 will-quit 改为 preventDefault + 完成后再次 quit 的防重入模式。
  新增 `tests/image-search-shutdown.test.cjs` 应用层源码契约回归 3 例，native 54/54 通过。下一步可选把
  缩略图重建停止也接入关闭路径。
- FastScanner FS-07L（2026-08-02）：缩略图 native 重建停止接入关闭路径；复用
  `imageSearchService.stopNativeThumbnailRebuild()`（addon 未加载时安全降级），置于
  `shutdownImageSearchForQuit()` 内部开头、`cancelAsyncWork()` 之前，保持幂等。`tests/image-search-shutdown.test.cjs`
  扩至 4 例，缩略图相关回归 17/17 通过，未改 native。
- FastScanner FS-07M（2026-08-02）：修复删除路径在 manifest 加载后复活进 `pathIndexMap` 的缺陷；
  `load_overlay` 填充 deletedPaths 后从 `pathIndexMap` 擦除墓碑路径，单点覆盖全部同步/异步
  load/save 调用点，purge/delete → save → reload 后 full 扫描可重新入库被删文件夹。
  FastScanner 更新为 0.5.18，native 55/55 通过。
- FastScanner FS-07N（2026-08-02）：修复 full 扫描后 manifest 保存丢失既有 segment 引用的
  数据丢失缺陷；`ScanDirectory` 非增量模式不再 `unmap_index`（保留 segment_mmap 与既有
  segment 引用，保存走 append），扫描入库清除 deletedPaths 墓碑并以 replacedPaths 隐藏旧
  segment 陈旧副本，`QueryIndexRecords` 按 manifest 顺序正向遍历使 replaced 路径仅最新
  副本可见。FastScanner 更新为 0.5.19，native 56/56 通过。
- FastScanner FS-07O（2026-08-02）：修复 `searchByImageAsync` 省略 topK 时以 topK=0 进入
  候选堆、对空堆取 `heap.top()` 导致 segment_mmap 有候选即崩溃的初始提交遗留缺陷；与同步
  搜索对齐 topK 缺省 20 并值初始化 SearchMetrics。FastScanner 更新为 0.5.20，native 57/57
  通过。
- FastScanner FS-07P（2026-08-05）：为 10 个缺 argc 保护的 N-API 入口补"缺参早退报错"——
  `SearchByHash`/`SearchByImage`（缺 hash/filePath、threshold、topK）、`SearchByImageAsync`
  （缺 filePath/threshold）、`HashImage`/`HashImageAsync`、`ScanDirectory`、`RepairIndexPath`、
  `LoadManifestAsync`/`SaveIndexToManifestAsync`/`CompactManifestAsync`（缺 rootDir）；同步入口
  返回 `{ok:false,error}`，异步入口经新增 `reject_missing_args` 返回 rejected Promise，杜绝
  读取未初始化 argv[] 栈值的 UB（与 FS-07O 同源）。native 65/65 通过。
- FastScanner FS-07Q（2026-08-05）：搜索参数上限钳制——三个搜索入口（SearchByHash/
  SearchByImage/SearchByImageAsync）topK 缺省/非正按 20 计并 clamp 到 1..1000（JS 侧
  `MAX_SEARCH_TOP_K`=500，1000 留有余量），threshold 按 64 位汉明距离语义 clamp 到 0..64，
  同步/异步行为一致；内部 search_by_hash 调用链只接收已钳制值。FastScanner 更新为 0.5.24，
  native 65/65 通过。
- FastScanner FS-07R（2026-08-05）：Worker/controller 关闭路径取消握手补全。应用层调查确认
  fast_scanner addon 仅在主进程 `imageSearchService` 加载，全部 `*Worker.ts`/`*Child.ts` 均无
  addon env（vectorAnnWorker 为纯 TS、派生文件走 tmp+rename 原子替换；catalog worker 只写 staging
  目录），catalog controller 的 `shutdownImageSearchDataCatalogForQuit()` 此前已接入 will-quit；
  真正缺口是 `uiSmokeService` 的 `app.exit()` 绕过 will-quit 导致握手不执行，现改为先跑同一
  幂等握手（`shutdownImageSearchForQuit()` + `shutdownImageSearchDataCatalogForQuit()`，失败不阻塞
  退出）再 `app.exit`。`tests/image-search-shutdown.test.cjs` 扩至 7 例（新增 catalog 有界等待、
  smoke 退出握手顺序、"Worker/Child 不得直接加载 addon"守卫），未改 native、未改 IPC 契约。
- FastScanner FS-07S（2026-08-05）：多 env 并发写索引隔离评估（纯评估，未改代码）。逐路径核实
  15 个租约调用点的失败关闭语义：冲突写全部带写者身份可观测、失败分支无状态残留；扫描租约经
  finalizer join 线程出口释放、异步租约经 N-API 必达的 complete 回调 `delete d` 释放、同步租约栈上
  RAII 释放，且租约自身持有 `shared_ptr<IndexRuntime>` 无悬垂——不存在"持有租约的 env 退出后租约
  泄漏"的死角，未发现需改代码的缺陷。禁令精确化为：语义上仍不支持多 env 并发写（fail-fast 不排队，
  调用方须串行化），架构上并发写已被租约失败关闭保护不致索引损坏，当前单 env 加载 + 守卫测试使该
  场景不会发生；未来支持的差距清单（写准入排队/写者归一/读快照语义/关闭握手扩展等）作为 backlog
  记录。详见[多 env 并发写索引隔离评估](2026-08-05-fastscanner-multienv-write-eval.md)。
- 应用层第一百批（2026-08-02，非 FS-07 系列）：修复 `isWithin` 在 Windows 跨盘时把
  `path.relative` 返回的绝对路径误判为"在根内"的缺陷——D: 盘图片记录被当作 project preview
  代理全部丢弃（Data Editor 查询与以图搜图对 D: 数据集恒无结果）；`projectSearchIndexService`
  与 `uiSmokeService` 补 `path.isAbsolute(relative)` 短路，新增 Windows 跨盘回归测试，
  未改 native 与 IPC 契约。

#### FastScanner 交接状态（2026-08-02）

- FS-07E 基线提交为 `3e9c1a1 docs(fastscanner): record handoff state`；工作树仅保留用户自己的
  未跟踪 `start.bat`，未修改或纳入提交。
- 已验证：Node 24 与 Electron 42 ABI 原生构建、native 49/49、runtime manifest 12/12、许可证材料
  5/5、TypeScript 类型检查、ESLint、Prettier 与 staged snapshot 均通过；未执行完整安装包构建。
- FS-07F 后 `native/fast_scanner.cc` 已无 `g_indexRuntime` 和裸 `IndexRuntime*`；当前采用受控进程共享索引，
  AddonContext 和索引异步任务共同持有所有权，资源清理由最终所有者触发。
- FS-07G 后共享索引采用 `single-writer-process-shared`；冲突操作失败关闭并通过 native status 暴露当前
  写者操作。FS-07S 评估后禁令精确化为：语义上仍不得宣称支持多 env 并发写索引——租约 fail-fast 不排队，
  冲突写直接失败需调用方自行串行化，且无跨操作读快照语义；架构上并发写已被租约失败关闭保护、不致
  索引损坏，租约释放路径无 env 退出泄漏死角；当前 addon 仅主进程单 env 加载并有守卫测试禁止
  Worker/Child 加载，该场景不会发生，新增 addon env 前须先完成 FS-07S 差距清单
  （见[多 env 并发写索引隔离评估](2026-08-05-fastscanner-multienv-write-eval.md)）。
- FS-07H 后 ScanRuntime 为 env-owned shared lifetime，异步 stop 持有强引用并与 finalizer 串行执行完整停止；
  Worker env 在 stop Promise 回调前终止的回归已覆盖。
- FS-07I 后全部 6 类 N-API async work 接入 `env-owned-cancel-on-teardown` registry；64 个 hash work 排队后
  立即终止 Worker 的回归已覆盖，主 env 保持可用。Node-API 只能取消尚未开始的 work，接手后优先为
  load/save/compact 等已开始执行的长任务增加共享取消 token 和安全检查点，避免 teardown 被磁盘工作拖延。
- FS-07J 后 persistence 长任务支持显式协作式取消，状态模式为
  `env-owned-explicit-cancel-teardown-drain`；Node-API cleanup hook 本身仍属于最终排空阶段，不能替代关闭前握手。
- FS-07K 后 Electron 主进程 will-quit 已先调用 `cancelAsyncWork()` 并等待扫描停止、autosave 链与
  registry 排空（5 秒上限）后再继续退出，关闭前握手已接入；FS-07R 确认应用层不存在独立加载
  addon 的 Worker/child env（addon 仅主进程 `imageSearchService` 加载），catalog controller 与
  `uiSmokeService` 的 `app.exit` 路径均已接入同一幂等握手，Worker/controller 关闭场景至此覆盖完毕。
- FS-07L 后 will-quit 握手会先停止进行中的 native 缩略图重建再走取消与排空，退出路径已覆盖重建停止。
- FS-07M 后 `load_overlay` 会从 `pathIndexMap` 擦除 deletedPaths 墓碑路径，purge/delete 的索引编辑
  在 manifest 保存/重载后不再复活；扫描重入库的记录不清除墓碑，`hasIndexPath` 语义不变。
- FS-07N 后 full 扫描不再卸载 mmap segment（避免保存丢失 segment 引用），扫描重入库会清除
  deletedPaths 墓碑并以 replacedPaths 隐藏旧副本；`QueryIndexRecords` 对 replaced 路径只显示
  最新副本。保存路径因此一律走 append，memory-only 全量重写仅剩无 segment 场景。
- FS-07O 后 `searchByImageAsync` 的 topK 与同步搜索一致（缺省/非正按 20 计），异步搜索不再
  依赖调用方显式传 topK。
- FS-07P+Q 后全部搜索/哈希/扫描/manifest N-API 入口对缺参早退报错（同步返回错误对象、异步
  返回 rejected Promise），topK 统一 clamp 到 1..1000、threshold clamp 到 0..64 且同步/异步
  一致；后续入口审查的要点转向新增参数时的钳制一致性。
- 2026-08-05 起 FastScanner 与向量存储线的整体交接状态维护在
  [2026-08-05 向量与 FastScanner 交接](../handoffs/2026-08-05-vector-and-fastscanner-handoff.md)；
  本节保留 FS-07 系列逐条历史记录。

### 2026-07-31 紧急性能修复记录

DINO / CLIP GPU 构建吞吐异常已在提交 `9b734e5` 修复并验证，不新增或改变原 TODO 的依赖状态。修复包含已有向量 ID 快速索引、伪图片预过滤与负缓存、真实批量派发、DINO batch offset 池化、Windows DirectML 并发上限和子进程异常恢复。

真实验证中，DINO 已有 ID 检查由约 30.1 秒降至 0.78 秒；DINO 与 CLIP 的 DirectML batch=4 均为 4/4 成功、约 1.98 秒。完整记录见[DINO / CLIP GPU 构建吞吐异常事件](2026-07-31-embedding-gpu-throughput-incident.md)，整改摘要同步记录在[项目审计整改进度](2026-07-28-project-audit-remediation.md)。
