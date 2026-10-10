# FloatingClock 全项目综合审计

> 状态：历史快照
> 替代文档：[2026-08-02 全项目多维审计](2026-08-02-full-project-multidimensional-audit.md)
> 审计日期：2026-07-28
> 审计基线：`44ec705be2d0f76cfe944d24fe8b0e164c5b9007`
> 审计分支：`docs/2026-07-28-full-project-audit`
> 范围：架构、功能完整性、正确性、测试、性能、安全、依赖、磁盘、发布、许可证、文档与 Git
> 性质：只读审计；除本报告和文档索引外，未修改业务代码、用户数据或发布产物

## 1. 执行身份与事实边界

- 执行系统：Codex，GPT-5 系列；当前运行时不提供可核验的精确模型小版本。
- 本次未使用子代理。
- 其他运行时代理是否存在：当前运行时不可见，不能据此判断不存在。
- 文档入口：`docs/README.md`。
- 事实优先级：当前代码与实测结果 > `docs/current/` > 日期较新的审计 > 历史文档。
- 主工作区保留用户未跟踪文件 `start.bat`，本次未触碰。
- 另有 `task/asset-library-suggestions-hook` 工作树；其任务状态和未提交内容不属于本次审计事实，未改动。

### 1.1 未覆盖边界

- 未安装或静默执行 NSIS 安装包，避免改变系统安装状态。
- 当前 `release/` 只保留安装器，没有 `win-unpacked`，因此不能对 2026-07-28 最新安装器执行当前版本的 packaged UI smoke。
- 隔离工作树不包含被 Git 忽略的模型和 FFmpeg 实物；因此 4 项依赖本机模型的测试按设计跳过。
- 许可证部分是工程合规风险识别，不替代专业法律意见。

## 2. 一句话结论

项目的核心代码、数据事务、原生扫描和大库查询已经达到较强的内部使用质量，但当前仍是 **“可继续开发和内部使用，暂不满足对外发布门槛”**。

综合工程健康度评估为 **71/100**。本次没有发现 P0 级立即破坏数据的问题，但发现 7 个 P1：

1. 生产依赖存在 2 个高危漏洞，Electron 也未锁定到当前受支持分支的最新版本。
2. 干净 Git 工作树无法独立重建完整安装包，模型清单和多项二进制输入不在版本库。
3. 用户数据已增长到约 14.64 GiB，存在 800 MiB 无轮转日志和 8.42 GiB JSON 向量分片。
4. NekoSearch 准确率门禁因全库扫描性能回退而失败。
5. UI smoke 在中文默认语言下必然误报，最新安装包没有有效 packaged UI 门禁证据。
6. 中英文切换仍是局部国际化，35 个组件仍存在明显的硬编码英文界面文本。
7. 安装包未签名，模型、GPL FFmpeg 和 AGPL YOLO 的随包许可证与分发义务尚未闭环。

## 3. 评分

| 维度 | 分数 | 判断 |
| --- | ---: | --- |
| 功能完整性 | 78 | 功能面广；双语界面和真实准确率覆盖未完成 |
| 正确性与数据安全 | 84 | SQLite、事务、备份、恢复、故障注入体系较强 |
| 测试与发布门禁 | 65 | 444 项测试稳定，但 UI smoke 已失效且无 CI/覆盖率 |
| 性能与资源治理 | 68 | 查询性能很好；全库向量扫描和磁盘增长明显失控 |
| 安全 | 68 | 主窗口安全基线较好；生产依赖高危和 GPU 子窗口隔离不足 |
| 发布与合规 | 42 | 未签名、版本恒定、许可证材料不完整、构建输入不可复现 |
| 可维护性 | 73 | 旧巨型文件拆分成效明显，新的热点仍集中在数据库、语义搜索和 IPC |
| 文档与 Git | 82 | 用户手册完整、链接无失效；索引、隐私脱敏和远端备份仍有缺口 |
| **综合** | **71** | **内部使用可行；公开发布暂缓** |

## 4. 项目规模与结构

按 Git 跟踪文件统计：

| 目录 | 文件数 | 行数 |
| --- | ---: | ---: |
| `electron/` | 142 | 41,953 |
| `src/` | 100 | 26,144 |
| `shared/` | 6 | 2,658 |
| `native/`（含第三方 STB 头） | 6 | 20,063 |
| `tests/` | 94 | 17,377 |
| `scripts/` | 27 | 2,532 |
| `docs/` | 83 | 22,159 |

排除两个第三方 STB 头后，自有运行时代码约 **252 个文件、74,484 行**。主进程存在 **236 个 `ipcMain.handle/on` 注册点**。

### 4.1 拆分成果

2026-07-27 审计里的两个最大热点已明显改善：

- `electron/assetLibraryService.ts`：从 3,614 行降至 704 行。
- `src/components/AssetLibraryPanel.tsx`：从 2,874 行降至 1,143 行。
- 旧的 OCR / object crop / local feature 死 stub 已删除。

这是有效重构，不应在后续工作中回退成重新集中逻辑。

### 4.2 当前新热点

| 文件 | 行数 | 风险 |
| --- | ---: | --- |
| `native/fast_scanner.cc` | 3,244 | 扫描、索引、日志、解码和 N-API 边界仍集中 |
| `electron/assetLibraryDatabase.ts` | 2,131 | Schema、迁移、事务、读写查询集中 |
| `electron/semanticSearchService.ts` | 2,022 | 缓存、向量流、搜索和评分集中 |
| `shared/ipc-contract.ts` | 1,520 | 共享契约成为大面积耦合中心 |
| `src/components/ImageSearchPanel.tsx` | 1,255 | 状态机和控制器职责仍重 |
| `src/stores/useStore.ts` | 1,249 | 全局 UI 状态、默认值和持久化集中 |
| `src/components/MediaSearchPanel.tsx` | 1,192 | 工作流、任务状态和视图编排集中 |
| `electron/thumbnailIpc.ts` | 1,177 | 缓存、GPU/CPU 调度与 IPC 集中 |
| `electron/embeddingService.ts` | 1,152 | 子进程、诊断、失败记录和构建状态集中 |
| `electron/imageSearchService.ts` | 1,149 | 索引生命周期与查询职责仍重 |

## 5. 验证结果

### 5.1 基础工程链

| 命令 | 结果 |
| --- | --- |
| `npm.cmd ci` | 通过；安装/审计 500 个包 |
| `npm.cmd run git:setup` | 通过 |
| `npm.cmd run git:hooks:check` | 通过 |
| `npm.cmd run verify` | 通过 |
| TypeScript strict typecheck | 通过，0 错误 |
| ESLint | 0 错误、5 警告 |
| Prettier check | 通过 |
| 单元/集成/native 测试 | 444 项：440 通过、0 失败、4 跳过 |
| Renderer / main / preload / worker 构建 | 全部通过 |

4 个跳过项与隔离工作树没有本机 AI 模型有关：

- face match：1
- person ReID：1
- subject crop / SAM：2

测试覆盖事务回滚、SQLite 迁移、备份恢复、故障注入、IPC 注册、preload 契约、路径 guard、文件管理、远程终端/SFTP/传输、向量、媒体搜索和 native 正确性。数据安全测试是当前项目最强的工程部分之一。

### 5.2 UI smoke

`npm.cmd run smoke:ui` **失败**：

- `missingPanels`：6/6；
- `bodyTextLength`：0；
- `panelCount`：0；
- 截图为全透明。

这不是 React 白屏。独立通过 Chromium DevTools Protocol 检查同一构建，确认：

- `file://.../dist/index.html` 正常加载；
- React root 已挂载；
- 中文 `设置` 和 `图片搜索` 面板均正常存在；
- native addon 正常连接。

根因是 `electron/uiSmokeService.ts` 仍用英文标题 `Image Search`、`Media Search`、`NekoSearch` 等定位面板。系统默认中文后，脚本匹配不到任何面板，随后自己的 `.panel { display:none }` 测试样式隐藏了全部面板。

因此当前 UI smoke 不能作为发布门禁。

### 5.3 性能

#### 18 万素材目录

| 项目 | 实测 |
| --- | ---: |
| 建库（180,000 条） | 7,233.78 ms |
| 更新时间分页中位数 | 6.00 ms |
| 深页名称排序中位数 | 18.88 ms |
| 路径查询中位数 | 53.96 ms |

#### 18.7 万素材关系

| 项目 | p95 | 门槛 | 结果 |
| --- | ---: | ---: | --- |
| 分类过滤分页 | 26.99 ms | <300 ms | 通过 |
| 建议分页 | 31.18 ms | <50 ms | 通过 |
| 统计 | 56.47 ms | <100 ms | 通过 |
| 聚类分页 | 28.89 ms | <50 ms | 通过 |

#### 真实 native 索引

- 记录数：262,688。
- mmap 索引加载：479.85 ms。
- RSS 增量：78.88 MiB。
- 单次搜索平均：0.1193–0.5962 ms。
- fast 模式没有 fallback；balanced / recall 在本次样本中均触发全量 fallback，但绝对耗时仍低于 1 ms。

#### NekoSearch 真实标注门禁

`npm.cmd run benchmark:neko-search:accuracy -- --gate` **失败**：

- 当前全库 CLIP 扫描：303,228 行，62,507.1 ms。
- 当前全库 DINO 扫描：295,339 行，40,162.0 ms。
- 扫描 p95：62,507.1 ms。
- 基线 p95：36,984.9 ms。
- 回退：约 69%，超过 1.5× 门槛。

排序指标 P@20、P@50、nDCG@20 均为 1.0，但当前只有一个 `test01` 分类：

- 候选池：147；
- seeded：99；
- manual：48；
- 正样本：78；
- 负样本：69。

候选池包含用于生成排序的 confirmed 原型，且只有单分类，满分结果不能外推到全库准确率。

### 5.4 安装包

最新安装器：

- 文件：`FloatingClock Setup 1.0.0.exe`
- 大小：953.05 MiB
- SHA-256：`C587D85481758AAC8988106890689DE9528C921EC3B8A77A390B367081399AF2`
- 7-Zip 归档检查：通过，309 个文件
- Authenticode：`NotSigned`

安装包解压内容约 1.86 GiB，主要组成：

| 组成 | 未压缩大小 |
| --- | ---: |
| `resources/ai-models` | 491.24 MiB |
| `resources/tools` | 462.33 MiB |
| `resources/models` | 323.56 MiB |
| `resources/app.asar` | 151.16 MiB |
| `resources/app.asar.unpacked` | 82.34 MiB |

其中 `ffmpeg.exe` 231.26 MiB、`ffprobe.exe` 231.07 MiB，是两个独立静态 full build。

## 6. P1：发布前必须处理

### P1-01 生产依赖和 Electron 补丁线不满足发布要求

`npm audit --omit=dev --json`：

- high：2
- moderate：1

生产高危来自：

- `@huggingface/transformers@4.2.0`
- `sharp@0.34.5`
- `sharp` 继承的 libvips 漏洞：CVE-2026-33327、33328、35590、35591

当前上游依赖约束没有自动修复路径。`protobufjs@7.6.4` 另有可修复的 `.proto` 解析 DoS 中危。

完整依赖树：

- critical：1
- high：6
- moderate：1

其中 `tar@7.5.16` 的 critical 位于构建链；其余高危包括 `brace-expansion`、`fast-uri`、`js-yaml`、`postcss`。即使不随应用运行，它们仍影响构建机处理文件、归档和 source map 的安全边界。

此外：

- lockfile：Electron 42.4.1；
- 同一受支持大版本当前版本：42.7.1；
- 最新稳定大版本：43.2.0。

Electron 官方只支持最新三个稳定大版本，并且每条稳定线只支持最新 minor。42.4.1 不应继续作为发布锁定版本。参考：

- [Electron 版本支持策略](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Electron 42.7.1](https://releases.electronjs.org/release/v42.7.1)
- [sharp / libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)

处置要求：

1. 先更新 Electron 42.x 到 42.7.1，重新跑 native ABI、透明窗口、置顶和 packaged smoke。
2. 更新有直接修复的构建依赖和 `protobufjs`。
3. 对 `sharp` 制定显式策略：等待 transformers 放宽版本、受控 override 并完整回归，或隔离/替换该图片解码链。
4. 在生产高危未关闭前，不创建发布标签。

### P1-02 干净 Git 工作树不能独立复现安装包

当前 `.gitignore` 忽略：

- `models/`
- `ai-models/`
- `tools/ffmpeg/bin/*.exe`

问题在于 `models/manifest.json` 也被整个 `models/` 规则忽略。代码注释称“manifest 例外并入库”，但实际 `git ls-files models` 为空。

结果：

- 干净工作树没有下载模型所需的 manifest。
- subject search 的 YOLO、AdaFace、OSNet、MobileSAM 没有统一的可复现下载清单。
- `package.json` 的 `extraResources` 依赖本机存在的忽略目录。
- `npm ci` + `npm run build` 不能证明能从源码重建当前 953 MiB 安装包。

处置要求：

1. 跟踪不含二进制的模型/工具 manifest，包括来源、版本、SHA-256、大小、许可证和目标路径。
2. 为所有随包模型和 FFmpeg 提供非交互、校验哈希的获取脚本。
3. release build 先校验完整物料清单，再打包；禁止静默使用工作机上残留文件。
4. 输出安装器 SBOM/物料清单和可复现构建记录。

### P1-03 用户数据缺少统一配额、轮转和垃圾回收

当前 `%APPDATA%/floating-clock-electron`：

- 总大小：14,996.23 MiB；
- `vector-db`：约 10,517 MiB；
- 两个 JSONL embedding shard：8,616.52 MiB；
- `clip_embedding_cache.f32`：645.66 MiB；
- DINO Float16 cache：432.63 MiB；
- `embedding_failures.jsonl`：170.38 MiB；
- 21 个 20 MiB diagnostic backup：420 MiB；
- `image-search-scan.log`：800.14 MiB；
- `thumbcache`：1,024 MiB；
- 素材库备份：608.62 MiB；
- 素材库 recovery：202.18 MiB。

`native/fast_scanner.cc::se_log` 每次直接以 append 模式打开日志，没有大小上限或轮转。失败日志同样只追加。diagnostic 日志虽然会在 20 MiB 时改名，但旧 `.bak` 没有保留数量上限。

此外，native 活跃索引是 262,688 条，但 CLIP/DINO JSONL 分别有 330,580 / 323,197 行；准确率扫描仍处理 303,228 / 295,339 行。存在明显的历史/失活向量滞留和重复存储成本。

处置要求：

1. 先增加安全的日志轮转与保留数量，例如当前文件 + 2～3 个压缩历史文件。
2. 对 failure/job/diagnostic 记录增加 TTL、最大行数和显式清理入口。
3. 将权威向量从十进制 JSON 数组迁移到二进制/SQLite BLOB 或分块格式；避免同时长期保留 JSON、F32 和 F16 三份全量数据。
4. 建立 active asset 驱动的向量 GC/compaction，并在执行前做快照、空间预检和故障注入测试。
5. 设置页提供各数据域大小、可回收大小、最后使用时间和安全清理操作。

本审计没有删除任何现有日志、缓存、向量或备份。

### P1-04 NekoSearch 准确率性能门禁失败

本次不是“准确率数值下降”，而是门禁中的真实全库扫描延迟失败。62.51 秒已经明显影响交互、批量分类和持续回归速度。

处置要求：

1. 优先让基准读取已生成的二进制 cache/ANN，而不是每轮解析数 GB JSONL。
2. 清理失活向量后重跑同一固定基线。
3. 把准确率数据扩展到至少 5 个真实分类，覆盖人物、截图/文字、产品、动物和场景。
4. 每分类记录 manual/seeded 比例；发布门禁不能主要依赖 seeded 标签。
5. 保留 `hybrid` 为主门禁，`hybrid_feedback` 继续只作趋势参考。

### P1-05 UI smoke 和发布流程已不能证明当前版本可发布

当前问题：

- UI smoke 依赖可翻译标题而不是稳定 `data-panel` 标识。
- smoke 只覆盖英文文案，未覆盖中文和语言切换。
- `npm run verify` 不执行 UI smoke、依赖审计、准确率门禁或 packaged smoke。
- `npm run build` 只执行 renderer build、typecheck、Electron native build 和 electron-builder，不先跑完整测试。
- 2026-07-27 packaged smoke 早于 2026-07-28 的 i18n、窗口、布局和最新安装器。
- 最新安装器只有 archive 完整性证据，没有当前 packaged runtime 证据。
- 仓库没有 CI 配置。

处置要求：

1. smoke 全部改用 `data-panel`、role、test id 或 IPC 状态，不按显示语言定位。
2. 分别在 `zh-CN`、`en` 下执行 smoke，并验证运行时切换。
3. 建立唯一 release gate：

```text
npm ci
git hooks / preflight
verify
npm audit --omit=dev
accuracy gate
build（保留 win-unpacked）
packaged UI smoke
installer archive smoke
签名与哈希
最后再清理 win-unpacked
```

4. 将该链放入固定、干净的构建环境。

### P1-06 中英文切换仍未完成全界面覆盖

当前字典和 7 个 i18n 单元测试能证明部分 key 正确，但不能证明整个界面已国际化。

静态粗查发现 **35 个组件、127 行**明显的硬编码英文可见文本。示例：

- Image Search Data Manager：
  - `Filter indexed path`
  - `No matching records`
  - `Rebuild Optimized Thumbnails`
  - 多条英文 tooltip
- Media Search：
  - 路径 placeholder
  - 部分状态和结果文本
- Remote Terminal：
  - `Password`
  - `Private Key`
  - `My Server`
  - 多条英文安全提示
- Asset Library Backup：
  - `Working...`
  - `No completed metadata backups.`

处置要求：

1. 所有用户可见文本、placeholder、title、aria-label、toast、错误和主进程返回消息进入统一 key。
2. 增加静态门禁，禁止新增未经 allowlist 的 JSX 文本。
3. UI smoke 同时验证两种语言，不只验证字典函数。
4. 技术名词如 CLIP/DINO/GPU 可保留，但解释文字必须翻译。

### P1-07 公开分发的签名和第三方许可证材料未闭环

发现：

- NSIS 安装包未进行 Authenticode 签名。
- `package.json` 没有 `license` 字段，根目录没有项目 `LICENSE`。
- `THIRD_PARTY_NOTICES.md` 开头仍写“模型不随应用打包”，但当前安装器实际包含约 814.8 MiB 模型。
- YOLOv8n 被标记为 AGPL-3.0 且写有“商业再分发前审查”，但已经随安装器打包。
- FFmpeg 是 `--enable-gpl --enable-version3 --enable-static` 的 full build。
- 安装器中只看到 FFmpeg 占位 README，没有 FFmpeg LICENSE、源码获取/书面提供信息或完整组件清单。
- 根目录的 `THIRD_PARTY_NOTICES.md` 没有被 `build.files` 或 `extraResources` 纳入安装包。

处置要求：

1. 暂停公开分发，完成模型权重和 FFmpeg 的专业许可证审查。
2. 明确项目自身许可证。
3. 为安装器加入完整 third-party notices、对应许可证文本、版本、来源和必要的源码获取说明。
4. 评估是否替换 YOLOv8n 权重/实现或调整分发方式。
5. 增加代码签名、时间戳和签名验证门禁。

## 7. P2：下一阶段高优先级

### P2-01 GPU thumbnail 子窗口没有使用 Electron 安全隔离

主窗口配置良好：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 禁止新窗口和非同源顶层导航
- packaged build 不接受环境变量 dev server

但 GPU thumbnail worker：

- `nodeIntegration: true`
- `contextIsolation: false`
- `sandbox: false`
- 通过 `require('electron')` 直接获得 `ipcRenderer`
- 会解码用户选择的图片字节

虽然它加载的是固定 data URL，仍扩大了图片解码漏洞与 Node 权限组合的攻击面。建议改成最小 preload bridge，并恢复 context isolation / sandbox。

### P2-02 跟踪文档含真实个人路径和账户标识

Git 跟踪文档中发现：

- 30 行包含 `<USER_HOME>`
- 148 行包含 Tencent Files / QQ 数字目录
- 7 行包含 `xwechat_files`

`docs/benchmark/2026-07-27-chinese-semantic-search-eval.json` 保存了大量真实 Top-K 绝对路径。当前仓库没有远端，不代表未来生成软著材料、备份或推送时没有泄露风险。

建议对所有提交产物使用 `<USER>`, `<QQ_DATA>`, `<DATASET>` 等稳定占位符；原始 benchmark 留在 ignored artifacts。

### P2-03 缺少覆盖率、CI 和工具链锁定

- 没有 c8/nyc/istanbul 等覆盖率数据。
- 部分测试只做源码正则断言，不能替代真实行为测试。
- 没有 GitHub Actions 或其他 CI。
- `package.json` 没有 `engines`、`packageManager`。
- 当前实测 Node v24.16.0、npm 11.13.0，但源码没有声明。

建议先建立分层覆盖率基线，不追求一次性高数字；优先覆盖 path/IPC、事务、备份、向量 compaction、i18n 和 release scripts。

### P2-04 IPC 权限面继续扩大

当前 236 个 handler、preload 大面积暴露和 1,520 行共享契约已经形成维护风险。现有 IPC 注册/契约测试和 capability matrix 是优点，但 handler 没有统一的 sender/frame 授权层。

主窗口导航限制降低了实际风险，但建议：

- 按领域拆分契约；
- 统一 sender/frame allowlist；
- 让每个高权限 handler 声明 R/W/FS/EXT/PROC/NET/SECRET 等级；
- 自动对 capability matrix 和实际注册点做差异检查。

### P2-05 安装包与工作目录体积过大

主源码目录当前主要占用：

- `.venv-parity`：约 1,018 MiB
- `release`：约 953 MiB
- `node_modules`：约 935 MiB
- `ai-models`：约 675 MiB
- `tools`：约 462 MiB
- `models`：约 324 MiB

安装包本身 953 MiB。建议：

- 把非首启必需模型改成经过哈希验证的可选模型包；
- 评估 slim/shared FFmpeg 方案，不随包携带两个 231 MiB full build；
- 将 `.venv-parity`、旧 installer 和可重建模型缓存迁移到专用构建盘/缓存盘；
- 所有清理操作必须先生成清单，不直接递归删除用户唯一副本。

### P2-06 依赖生态已经进入集中升级窗口

- `xterm@5.3.0` 已 deprecated，应迁移到 `@xterm/xterm`。
- ESLint 8 已 deprecated。
- TypeScript ESLint 仍为 7.x。
- Vite 6、React 18、Zustand 4 等均落后多个 major。
- `@types/ssh2` 位于 runtime dependencies，应该核实并移到 devDependencies。

不建议一次跨越所有 major。先做安全补丁，再按 Electron/构建链、终端、React 状态层分批升级。

### P2-07 版本与发布可追溯性不足

- 多轮重要功能仍全部发布为 `1.0.0`。
- 没有 CHANGELOG、release manifest、SBOM 或构建环境记录。
- 最新安装包时间晚于多数业务提交，但 packaged smoke 报告属于前一天版本。

建议采用至少 `1.0.x` patch 递增，并把 commit、依赖锁、物料哈希、测试报告和安装器哈希绑定到同一 release record。

### P2-08 Git 只有本地历史，没有远端灾备

- 当前没有 Git remote。
- 51 个本地分支都已合入 `main`，分支列表噪声较高。
- 主工作树仍有用户未跟踪的 `start.bat`。

建议先建立可信远端或离线裸仓库备份，再按工作树占用情况清理已合并分支。不得删除仍被工作树使用的分支。

## 8. P3：维护改进

- 清理 5 条 ESLint 未使用变量警告。
- 把 1,000～2,000 行热点继续按 schema/migration/query、cache/scan/score、controller/view 拆分。
- 给 native scan log 增加结构化等级和隐私脱敏，避免长期记录完整个人文件路径。
- docs 索引应始终列出最新项目审计；本次已补充。
- 统一 `Roaming/floating-clock-electron`、`Local/FloatingClock` 等数据目录说明，避免用户误判占用位置。
- 为多显示器、125%/150% DPI、1920×1080 和小屏增加面板布局 E2E；当前 smoke 只使用 2560×1392。

## 9. 已确认的正面结论

1. **数据一致性强**：SQLite 权威关系库、JSONL fallback、事务 journal、原子写、恢复锁定和故障注入测试均较成熟。
2. **主窗口 Electron 安全基线较好**：sandbox、context isolation、CSP、导航限制和 loopback dev URL guard 均在位。
3. **文件系统安全有明确 guard**：路径长度/控制字符/数量限制、UNC 执行拒绝、shell wrapper 和回收站删除已落地。
4. **远程凭据处理合理**：密码不写入 profile，持久凭据使用 Electron `safeStorage`；选择 token 绑定 sender。
5. **查询性能优秀**：SQLite 分页、关系查询和 native ANN/哈希扫描均满足现有门槛。
6. **测试数量和故障场景覆盖较强**：特别是事务、备份恢复和 native 边界。
7. **用户说明书完整**：约 740 行，覆盖安装、全部面板、数据备份、安全和故障排查。
8. **文档链接健康**：审计时 0 个相对 Markdown 失效链接。
9. **未发现已提交的私钥、常见 API token 或明文远程密码。**
10. **安装器归档结构和 SHA-256 可验证。**

## 10. 推荐整改顺序

### 批次 A：立即恢复发布可信度

1. 修复 UI smoke 的稳定定位和双语执行。
2. 建立单一 release gate。
3. 更新 Electron patch、可修复依赖并重新审计。
4. 对当前安装包补做 packaged runtime smoke。

### 批次 B：阻止磁盘继续增长

1. native scan log / failure log / diagnostics 轮转。
2. 设置页增加数据占用和安全清理。
3. active asset 向量 GC。
4. 二进制权威向量格式迁移方案和故障注入。

### 批次 C：完成功能承诺

1. 清理全部硬编码用户可见文本。
2. 中英 UI smoke 和可访问性检查。
3. 扩展真实标注分类。
4. 修复并重新通过准确率性能门禁。

### 批次 D：公开分发前闭环

1. 可复现模型/工具 manifest。
2. SBOM、third-party notices、许可证审查。
3. 替代或合规处理 AGPL/GPL 组件。
4. 代码签名、版本递增和 release record。

### 批次 E：长期维护

1. CI、覆盖率和工具链锁定。
2. 数据库/语义搜索/native 热点继续拆分。
3. IPC 自动分级与 sender 授权。
4. Git 远端灾备和已合并分支清理。

## 11. 发布判定

| 场景 | 判定 |
| --- | --- |
| 当前机器内部使用 | 可以，建议先处理日志增长 |
| 继续开发/结构重构 | 可以，现有测试链可支撑 |
| 发给少量测试者 | 有条件；需先修 UI smoke、依赖高危和当前 packaged 验证 |
| 公开发布/商业分发 | **暂缓** |
| 创建正式 release tag | **暂缓** |

解除公开发布阻断至少需要：

- 生产高危依赖关闭或有经批准的风险处置；
- 当前 packaged UI smoke 通过；
- NekoSearch 性能门禁通过或经记录批准调整；
- 完整可复现物料清单；
- 第三方许可证审查与随包材料完成；
- 安装包签名和版本记录完成。

## 12. 审计命令与证据摘要

```text
npm.cmd ci
npm.cmd run git:setup
npm.cmd run git:hooks:check
npm.cmd run verify
npm.cmd run smoke:ui
npm.cmd run benchmark:asset-catalog
npm.cmd run benchmark:asset-relation
npm.cmd run benchmark:native
npm.cmd run benchmark:neko-search:accuracy -- --gate
npm.cmd audit --omit=dev --json
npm.cmd audit --json
npm.cmd outdated --json
Get-AuthenticodeSignature <installer>
Get-FileHash <installer> -Algorithm SHA256
7za.exe t <installer>
```

本报告中的用户数据体积、真实索引、准确率和安装包数据均来自 2026-07-28 当日只读实测；未来数据量、漏洞源和 Electron 版本变化后必须重新审计。
