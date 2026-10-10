# 2026-08-24 审计后自动优化 TODO

> 状态：当前  
> 更新日期：2026-08-24  
> 范围：Renderer 首屏包、Media Search Frame Index 加载、真实产物/覆盖率/发布门禁与剩余外部阻塞项  
> 选择命令：`npm.cmd run todo:post-audit-next`  
> 结构校验：`npm.cmd run todo:post-audit-check`  
> 自动验收：`npm.cmd run todo:post-audit-auto`  
> 替代文档：无

## 自动执行规则

1. 只自动执行 `Mode=auto`、依赖均为 `verified`、无外部阻塞且状态为 `pending`、`in_progress` 或 `implemented` 的任务。
2. 优化不得改变面板、搜索、索引、清理、播放或发布功能语义；新增懒加载必须保留相同错误传播、取消与缓存失效顺序。
3. 构建优化必须由产物字节预算和真实构建输出验收，不能只提高警告阈值或隐藏警告。
4. 真实素材删除、真实准确率标注、许可证批准、签名、Tag 和发布平台操作保持 `approval`/`blocked`，自动入口不得执行。
5. 每个自动项先补静态契约或行为回归，再执行 TypeScript、构建、专项测试和全量门禁；失败时保留当前任务，不跳过到低价值项。

## 机器可读任务表

| Rank | ID      | Value | Mode     | Dependencies            | External blockers                        | Branch                                   | Status   | Validation                                                      | Task                                                                                      |
| ---: | ------- | ----: | -------- | ----------------------- | ---------------------------------------- | ---------------------------------------- | -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
|    1 | VAL-601 |   100 | auto     | -                       | -                                        | `perf/post-audit-renderer-bundle`        | verified | main ≤ 393216 bytes；500000 warning target；vendor + UI smoke   | 将 React/Zustand 稳定依赖拆为长期缓存 chunk，真实降低 Renderer 主入口字节而非调高警告阈值 |
|    2 | VAL-602 |    98 | auto     | VAL-601                 | -                                        | `perf/media-frame-index-lazy-boundary`   | verified | no mixed import + media preparation/search/cleanup regression   | 消除 Frame Index 静态/动态混合导入，保持循环依赖安全并让重模块只在媒体索引路径加载        |
|    3 | VAL-603 |    96 | auto     | VAL-601,VAL-602         | -                                        | `test/post-audit-build-budget`           | verified | post-audit optimization tests + build artifact checker          | 建立机器可读 TODO、导入策略和真实构建产物预算，防止包体与加载边界回退                     |
|    4 | VAL-604 |    94 | auto     | VAL-601,VAL-602,VAL-603 | -                                        | `qa/post-audit-optimization-acceptance`  | verified | focused + build + bilingual UI smoke                            | 执行首轮专项、构建和双语窗口验收并回填实测结果                                            |
|    5 | VAL-607 |    93 | auto     | VAL-604                 | -                                        | `security/release-readiness-fail-closed` | verified | release gate 21/21；blocked readiness before signer/record      | 将 commit-bound packaged matrix 与商业 8/8 readiness 接入签名和发布记录之前               |
|    6 | VAL-608 |    92 | auto     | VAL-603                 | -                                        | `test/build-manifest-dependency-graph`   | verified | Vite manifest closure + Electron wrapper/current chunk fixture  | 按真实静态/动态依赖图核算入口闭包，并拒绝陈旧或未被 main 引用的 Frame Index chunk         |
|    7 | VAL-609 |    91 | auto     | VAL-607,VAL-608         | -                                        | `ci/checked-build-and-critical-coverage` | verified | verify/CI/package checked build + critical coverage 121/121     | 把清理、构建、预算、全量测试及新增关键脚本覆盖率接入标准自动化路径                        |
|    8 | VAL-610 |    90 | auto     | VAL-609                 | -                                        | `qa/post-audit-final-regression`         | verified | todo:post-audit-auto + npm test + coverage + bilingual UI smoke | 执行最终全量自动验收，保证新增门禁自身可达且失败会短路                                    |
|    9 | VAL-605 |    89 | approval | VAL-610                 | 用户在新构建中重新执行真实来源删除       | `ops/source-cleanup-real-verification`   | blocked  | SRC-008 original/derived/read-only matrix                       | 对真实来源只读确认原素材不变且全部图片/视频/主体派生数据为 0                              |
|   10 | VAL-606 |    88 | approval | VAL-610                 | 法律；签名；Tag；Neko 基线；正式打包环境 | `release/formal-distribution-gates`      | blocked  | release:readiness 8/8 + signed packaged matrix                  | 关闭正式 Online/Offline Release 外部门禁，不由自动优化入口伪造证据                        |

## 当前基线

- Renderer `main` 为 538.28 kB（gzip 167.08 kB），超过 Vite 500 kB 警戒线；这是真实字节优化目标，不调整 `chunkSizeWarningLimit`。
- Electron main 构建报告 `mediaSearchFrameIndex.ts` 同时被静态和动态导入，动态加载不能形成独立 chunk。
- 全量测试、关键覆盖率、双语 14/14 面板 UI 冒烟和媒体播放器冒烟已经通过，作为本轮优化前行为基线。
- Online/Offline 正式发布仍为 0/8；生产 npm 依赖漏洞为 0。这些事实不会因包拆分自动改变。

## 自动化边界

- 不访问或改写 `D:\PxHereDataset\images`、用户索引、人工素材库、模型文件或外部主机。
- 不创建 Git Tag、提交、签名、安装包或法律审批记录。
- 不通过延迟用户首个可见面板来换取虚假的入口体积下降；稳定 vendor 拆包与已经存在的面板懒加载可以保留。
- Frame Index 加载失败必须继续阻断相应媒体操作，不能用静默异步任务吞掉错误。

## 自动完成结果

- 自动任务 `VAL-601`–`VAL-604`、`VAL-607`–`VAL-610` 已完成 8/8；选择器返回 `selected: null`，只保留 `VAL-605`、`VAL-606` 两项人工阻塞任务。
- Renderer 主 chunk 从 538.28 kB（gzip 167.08 kB）降为 343,190 bytes（gzip 105,545 bytes），降幅约 36.2%/36.8%；React/Zustand vendor 为 193,158 bytes（gzip 60,710 bytes）。
- eager JavaScript 闭包合计 537,059 bytes（gzip 166,654 bytes），与拆分前总量接近；本项收益准确限定为消除单 chunk 超限、稳定框架缓存边界和约束后续回退，不宣称冷启动总传输量大幅下降。
- xterm 样式归属 Remote Terminal 懒加载面板后，首屏 CSS 从 54.92 kB 降为 52,389 bytes（gzip 9,730 bytes）；终端样式与面板 chunk 一同加载。
- Electron 构建生成独立 `mediaSearchFrameIndex` chunk 9.64 kB（gzip 3.23 kB）；7 个 owning modules 共 11 个运行时动态导入，静态值导入为 0，原混合导入警告消失。
- 构建门禁读取 Vite manifest 的真实静态/动态依赖闭包，同时限制 main、vendor、eager JavaScript、首屏 CSS、8 个重面板、xterm 归属和 Media Player 独立性；Electron 侧从 `main.js` wrapper 追到唯一当前 main bundle，再验证其 11 个 Frame Index 引用，陈旧产物不能冒充通过。
- `build:renderer:checked` 先清理 `dist`/`dist-electron`，再构建并检查；`verify`、`ci:verify` 和正式 `scripts/build.cjs` 都会经过该门禁。自动入口还包含全量 `npm test`、关键覆盖率和文档检查。
- 关键覆盖率扩展到商业 readiness、许可证、产物图检查和 Node 第三方清单生成器，共 121/121 通过；总行/分支/函数覆盖率为 85.49%/76.22%/84.97%，基线提高到 84%/75%/83%。
- 正式发布链在 package 后生成绑定当前提交的 packaged matrix，并在签名、SBOM 与 release record 前运行 `release:readiness`；回归确认 readiness 失败不会调用 signer，也不会生成 release record。该防绕过修复没有关闭真实外部门禁，Online/Offline 仍为 0/8。
- 最终 `todo:post-audit-auto`、全量 `npm test`、30 项媒体/清理/产物图专项、双语各 14 个面板 UI 冒烟、媒体播放器、模型/Native/FFmpeg 探测、Lint、格式、类型、架构、许可证和文档门禁均退出 0。
