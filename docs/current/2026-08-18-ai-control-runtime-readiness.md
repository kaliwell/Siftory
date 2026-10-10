# AI Control API 模型与媒体运行时完整性修复

> 状态：当前  
> 更新日期：2026-08-19  
> 范围：AI Control API、CLIP 模型安装与校验、FFmpeg/FFprobe 状态发现、图片与视频文本搜索  
> 执行系统：Codex / GPT-5 系列；精确小版本未公开  
> 提交边界：当前未提交现场；未创建提交或标签  
> 替代文档：无

## 目的与范围

本轮验证 AI Control API 除磁盘大文件分析外的实际用途，并修复模型和媒体工具首次状态不准确、在线模型下载完整性不足的问题。测试只读取现有图片、视频和向量索引；没有删除或移动素材，没有批准窗口写操作，没有修改正式 API 配置。

## 当前结论

AI Control HTTP API 已真实完成图片文本搜索、视频文本搜索、媒体运行时状态查询和任务轮询。当前机器上的 CLIP 模型状态为 `downloaded`，文本向量维度为 512；FFmpeg 与 FFprobe 均可发现并执行。

最初隔离测试出现的“缺少 `text_model_q4.onnx`”并非当前应用运行目录真的缺文件。临时测试器把 Electron `appPath` 指向了脚本目录，导致模型服务查找了错误的 `tmp/ai-models`，随后落到不完整的旧 Roaming 兼容目录。使用与正式应用一致的项目 `appPath` 后，现有文本模型可正常加载。该误报同时暴露出正式代码中的三个真实薄弱点，现已一并修复：

1. 文本模型可用性判断过去只检查图像塔 `model_q4.onnx`。
2. 模型下载状态过去只校验主权重，不能保证文本塔和 tokenizer/config 完整。
3. `mediaSearch.status` 可能在异步 FFmpeg 探测完成前返回占位状态。

2026-08-18 晚间的 Online 安装包真实运行又暴露出独立问题：打包态把模型下载目录指向只读且在 Online profile 中为空的 `resources/ai-models`。用户旧 Roaming 目录只有 CLIP 图像塔，没有文本塔，运行时仍继续初始化 tokenizer，最终显示 `Cannot read properties of undefined (reading 'tokenizer_class')`。修复后：

1. Online 下载统一写入 `app.getPath('userData')/models`，不再写安装目录。
2. Offline 仍可只读回退到 `resources/ai-models`，且不会在该目录写验证 sidecar。
3. 同一模型根目录内的全部清单文件通过 SHA-256 后才允许推理；不完整模型在加载 Transformers 前返回可操作错误。
4. 模型清单支持安全惰性加载，AI Control API 早于 Vector IPC 调用时也能正确解析模型。
5. CLIP 与多语言 ONNX 会话加入退出期显式释放，避免真实语义查询后退出出现 Windows 无效句柄异常。

## 问题与修复

| 等级 | 问题                                                | 影响                                             | 修复位置与结果                                                                                                                    |
| ---- | --------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| P1   | CLIP 下载清单只把图像塔作为模型完成条件             | 在线下载可能显示完成，但文本搜索运行时缺少文本塔 | `models/manifest.json`、`shared/vectorTypes.ts`、`electron/modelService.ts`：将文本塔和全部运行依赖列为哈希固定的 `requiredFiles` |
| P1   | 模型服务只校验和下载单个主文件                      | 不完整安装无法自动补齐，状态可能误报             | `electron/modelService.ts`：完整校验所有必需文件，只下载缺失或校验失败的文件，逐文件事务提交并生成验证 sidecar                    |
| P2   | `isClipTextModelAvailable()` 检查了错误的 ONNX 文件 | 有图像塔、无文本塔时会误报文本模型可用           | `electron/semanticSearchService.ts`：明确检查 `text_model_q4.onnx`，并兼容 scoped/direct 与旧 Roaming 根目录                      |
| P2   | API 首次读取媒体状态时不等待工具探测                | 已安装的 FFmpeg/FFprobe 可能显示为未配置         | `electron/aiControlApi.ts`：`mediaSearch.status` 先等待 `warmFfmpegStatusCache()`                                                 |
| P2   | 离线包硬性资源列表未单独要求 CLIP 文本塔            | 打包校验不能直接指出文本塔缺失                   | `scripts/verify-packaged-resources.cjs`：新增 `clipTextModel` 必需资源                                                            |
| P2   | 隔离诊断脚本未设置真实应用路径                      | 产生本机模型缺失的假阴性                         | 临时诊断器已纠正并删除；真实 HTTP 报告保留在 `%TEMP%`                                                                             |
| P0   | Online 包把下载目录指向空的安装资源目录             | 文本模型无法发现并触发 `tokenizer_class` 异常    | `electron/modelService.ts`：用户可写目录与打包只读回退分离；完整根目录校验；模型清单惰性加载                                       |
| P1   | Transformers ONNX 会话未在退出握手中显式释放        | 真实语义查询后的自检进程可能以无效句柄异常退出   | `electron/semanticSearchService.ts`、`electron/multilingualTextEncoder.ts`、`electron/main.ts`：去重并等待 `dispose()`             |

## 模型安装与失败恢复

`clip_vit_base_patch32` 现在只有在以下内容全部通过固定 SHA-256 校验后才返回 `downloaded`：

- 图像推理权重 `onnx/model_q4.onnx`。
- 文本投影权重 `onnx/text_model_q4.onnx`。
- `config.json`、`preprocessor_config.json`。
- tokenizer、词表、merges 和特殊 token 配置。

如果主权重已验证而文本塔缺失，下载器只获取缺失文件，不会重复覆盖主权重。每个大文件先写入同目录准备文件，大小和 SHA-256 都正确后才原子发布；失败或取消会清理准备文件，现有有效文件继续保留。

状态语义也与自动修复流程保持一致：仅缺少必需文件时返回 `not-installed`，设置向导可以继续补齐；已经存在但 SHA-256 不匹配的文件返回 `error`，避免把损坏或被替换的权重静默当成正常下载。

开发模式使用项目根目录的 `ai-models`。打包模式把 `%APPDATA%` 下应用 `userData/models` 作为唯一可写下载目录，并把 `resources/ai-models` 作为 Offline profile 的只读回退。运行时不会跨两个根目录拼接文件，也不会因旧目录只有图像塔就继续初始化 tokenizer；每个候选根目录必须独立满足完整清单和 SHA-256 校验。

## 真实 API 验收

隔离 API 使用一次性令牌启动，应用路径和用户数据路径与正式开发运行保持一致。测试结束后服务、Electron 进程、令牌目录和临时测试脚本均已清理。

| 调用                                    | 结果 | 实测数据                                                    |
| --------------------------------------- | ---- | ----------------------------------------------------------- |
| `mediaSearch.status`                    | 通过 | FFmpeg `true`；FFprobe `true`                               |
| `mediaSearch.search`，查询“对话”        | 通过 | 32,918 个候选帧；返回 5 条；12,924 ms                       |
| `imageSearch.search`，查询 `night city` | 通过 | 440,462 个候选；返回 5 条；8,873 ms                         |
| 图片搜索模式                            | 通过 | `degraded: false`；英文文本编码器；完整 CLIP embedding 搜索 |
| CLIP 模型状态                           | 通过 | `downloaded`；文本向量 512 维                               |

机器可读报告：`%TEMP%\siftory-ai-control-runtime-verification-20260818.json`。报告中的 API 输出经过路径脱敏，不包含 bearer token。

## 验证

| 项目                    | 命令                                                                                                                                                         | 结果                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| TypeScript              | `npm.cmd run typecheck`                                                                                                                                      | 通过                                                       |
| 模型/发布资源专项       | `npm.cmd run test:model-download`                                                                                                                            | 101/101 通过                                               |
| API、媒体和文本编码专项 | `node --test tests/media-search-fixed-samples.test.cjs tests/text-encoder-routing.test.cjs tests/ai-control-policy.test.cjs tests/ipc-registration.test.cjs` | 38/38 通过                                                 |
| 模型缺失文件修复        | `node --test tests/model-service-required-files.test.cjs`                                                                                                    | 1/1 通过                                                   |
| QA 可达性               | `npm.cmd run test:qa-toolchain`                                                                                                                              | 7/7 通过                                                   |
| ESLint                  | `npm.cmd run lint`                                                                                                                                           | 通过：0 error；0 warning                                   |
| Prettier                | `npm.cmd run format:check`                                                                                                                                   | 通过                                                       |
| 架构                    | `npm.cmd run test:architecture`                                                                                                                              | 通过；最新全审计为 435 个模块，主入口 278 个可达模块       |
| 生产构建                | `npm.cmd run build:renderer`                                                                                                                                 | 通过；Renderer、Electron、Preload 与全部 worker 均构建成功 |
| 真实 HTTP API           | 隔离令牌运行 `mediaSearch.status`、`mediaSearch.search`、`imageSearch.search`                                                                                | 通过；最终报告 `ok: true`                                  |
| 打包态模型目录回归      | `node --test tests/model-service-packaged-storage.test.cjs`                                                                                                  | 通过；用户目录写入、Offline 只读回退、惰性加载均符合预期   |
| 打包态真实 CLIP 语义    | `node tests/ai-control-api-smoke.cjs --packaged --real-semantic`                                                                                              | 通过；扫描 440,462，返回 5，退出码 0                       |
| 2026-08-18 打包态双语 UI smoke | `npm.cmd run smoke:ui:packaged -- --locale=zh-CN/en`                                                                                                  | 中文、英文均通过；当时范围为 8 个面板；0 console error     |
| 2026-08-19 全窗口 UI smoke | 最新全项目审计的 `zh-CN` / `en` Electron UI smoke                                                                                                         | 均通过；14/14 面板、0 缺失、0 console error、0 崩溃        |
| 安装包资源与归档        | `smoke:packaged:resources:online`、`smoke:installer:archive`                                                                                                  | 通过；最新内部候选归档含 248 个文件                         |

## 剩余风险与下一步

1. 本文完成的是 CLIP `requiredFiles` 完整性闭环；最新全项目审计确认 DINO 和多语言模型仍有隐式伴随文件未全部进入带大小与 SHA-256 的版本化 manifest，且部分下载仍使用整体 `arrayBuffer()` 后直接落最终路径。后续应改为有界流式下载、校验后原子替换。
2. 已重新生成并验收 Online Windows 安装候选；Offline profile 未在本轮重建。当前文件为 `release/Siftory Online Setup 1.0.0.exe`，SHA-256 `19878F6DCC38FE72F78D0EB94EDEED550131CFD8B5DFA1435304B56CA0EA3C94`；产物未签名，仅可作为内部测试版，不能替代正式商业发布门禁。
3. 当前工作区包含大量未提交历史改动。本轮结果证明当前现场可运行，但不能替代拆分提交、代码评审和可追溯发布记录。
4. FFmpeg 当前由系统 PATH 发现。在线发行版需继续保留“系统安装、用户配置目录、离线包内置工具”三条发现路径的打包态验证。
5. 商业发布仍受许可证人工批准、EULA、代码签名和受控质量基线约束；本轮没有改变这些外部阻塞项。
