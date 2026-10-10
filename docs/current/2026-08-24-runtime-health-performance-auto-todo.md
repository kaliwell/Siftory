# 2026-08-24 运行健康与性能自动化 TODO

> 状态：当前  
> 更新日期：2026-08-26  
> 范围：运行健康、模型检测与安全修复、固定素材性能回归、来源派生数据审计、夜间调度  
> 选择命令：`npm.cmd run todo:operations-next`  
> 结构校验：`npm.cmd run todo:operations-check`  
> 自动验收：`npm.cmd run todo:operations-auto`  
> 替代文档：无

## 自动执行规则

1. 默认入口必须只读、离线或使用隔离输出目录；任何安装、下载、删除、许可证接受、签名和公开发布均不得由本 TODO 隐式触发。
2. 每个外部子进程必须有超时、总输出上限和单阶段结果；一个阶段失败后继续收集其余诊断，最终状态仍然失败关闭。
3. `D:\PxHereDataset\images\pxhere-000000` 只作为只读性能输入。基准产物只能写入仓库的 `artifacts/automation`，不得写入或覆盖素材目录。
4. 基线缺字段、配置不一致或没有可比较报告时标记 `skipped`/`incomplete`，不得将“没有证据”解释为“没有回退”。
5. 模型修复必须同时具备显式 `--execute`、白名单 repair id、`--allow-download` 和原安装器许可参数；编排器不得自己生成许可同意。
6. 来源审计不暴露执行删除的参数，且不持久化清理确认 token；夜间报告默认脱敏本机、项目、素材和用户路径。

## 机器可读任务表

| Rank | ID      | Value | Mode        | Dependencies                                    | External blockers                          | Branch                                   | Status   | Validation                                            | Task                                                                               |
| ---: | ------- | ----: | ----------- | ----------------------------------------------- | ------------------------------------------ | ---------------------------------------- | -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
|    1 | VAL-701 |   100 | auto        | -                                               | -                                          | `ops/runtime-health-report`              | verified | health contracts + real toolchain stage               | 汇总工具链、架构、隐私、文档、许可证和扩展安全检查，生成有界 JSON/HTML 健康报告    |
|    2 | VAL-702 |    98 | auto        | VAL-701                                         | -                                          | `perf/fixed-dataset-regression`          | verified | benchmark contracts + real PxHere failure evidence    | 对固定图片素材执行分阶段 A/B，并以 P50/P95、总耗时和 RSS 与兼容基线比较            |
|    3 | VAL-703 |    97 | auto        | VAL-701                                         | -                                          | `ops/model-safe-repair-orchestrator`     | verified | model repair + installer/preflight contracts          | 检测本地、Ollama、CUDA 和 llama.cpp，并为允许的修复建立显式许可与下载门禁          |
|    4 | VAL-704 |    96 | auto        | VAL-701                                         | -                                          | `ops/source-derived-read-only-audit`     | verified | audit contracts + final real read-only pass           | 只读分析指定盘符或文件夹关联的图片、视频、主体、缩略图、转写和语义派生数据         |
|    5 | VAL-705 |    94 | auto        | VAL-702,VAL-703,VAL-704                         | -                                          | `ops/nightly-bounded-orchestrator`       | verified | nightly orchestration contracts                       | 串联质量、健康、模型、基准、来源审计及 UI 冒烟，失败后继续汇总并保存有界阶段日志   |
|    6 | VAL-706 |    92 | auto        | VAL-705                                         | -                                          | `ci/nightly-self-hosted-workflow`        | verified | workflow contract + default path redaction            | 添加受限自托管 Windows 夜间工作流，定时运行且只上传脱敏诊断产物                    |
|    7 | VAL-707 |    90 | auto        | VAL-701,VAL-702,VAL-703,VAL-704,VAL-705,VAL-706 | -                                          | `qa/operations-automation-final-gate`    | verified | `npm run verify` exit 0 + operations/TODO/docs gates  | 将新入口接入 npm test/TODO/文档并完成最终全量回归                                  |
|    8 | VAL-708 |    88 | observation | VAL-707                                         | -                                          | `perf/nightly-real-baseline-observation` | verified | accepted three-run baseline + immutable control line   | 在目标硬件完成连续三次真实基线并建立后续回退比较控制线                             |
|    9 | VAL-709 |    86 | triggered   | VAL-707                                         | Git remote；受保护分支；在线自托管 runner  | `ci/remote-nightly-activation`           | blocked  | remote schedule evidence + private artifact retention | 在远程仓库和受控 runner 就绪后启用真实夜间计划，不把本地 workflow 文件冒充运行证据 |

## 新增入口

| 命令                                                   | 默认行为                                           | 写入范围                            |
| ------------------------------------------------------ | -------------------------------------------------- | ----------------------------------- |
| `npm.cmd run automation:health`                        | 运行 quick 只读健康检查；`--full` 扩大安全契约范围 | `artifacts/automation/health`       |
| `npm.cmd run automation:model-repair`                  | 只检测并生成修复建议；不安装、不下载               | 仅显式 `--output` 报告              |
| `npm.cmd run automation:benchmark -- --plan`           | 验证固定素材和执行计划；不创建输出目录             | 无                                  |
| `npm.cmd run automation:data-audit -- --source=<path>` | 只读预览来源派生数据；报告不保存确认 token         | `artifacts/automation/source-audit` |
| `npm.cmd run automation:nightly -- --quick`            | 健康、模型、图片基准、来源审计和播放器冒烟         | `artifacts/automation/nightly`      |

`automation:benchmark -- --full` 会使用 1000 张图片并增加 Media Search preparation A/B。`automation:nightly -- --full` 还会执行 `ci:verify`、双语 UI 和主题矩阵，适合受控夜间 runner，不适合每次编辑后运行。

## 安全边界

- 健康报告只允许固定的 npm 只读命令，并为 stdout/stderr 保留有界尾部；它不构建、不安装、不联网、不删除。
- 模型编排器的默认 quick 检测不会触发下载。即使指定 repair id，也必须同时满足执行、下载和原许可证三类参数才会调用安装器。
- 性能脚本验证素材目录为可读普通目录，并拒绝素材与输出路径重叠。没有 baseline 时状态为 `completed-without-baseline`，不是性能回退通过；full 模式的 Media Search A/B 写入 `artifacts/automation` 时不会更新 `artifacts/benchmark/media-preparation-pipeline/latest.json`。
- 来源审计只调用 preview 路径；报告中的 `token` 被剥离，脚本没有 `--execute` 或删除分支，报告路径也不能位于被审计来源内。
- 夜间编排默认脱敏路径、按阶段落盘日志并继续收集错误；full 模式缺少固定数据集或审计来源时失败关闭。
- GitHub workflow 只是可执行配置。当前仓库没有 Git remote，且没有可验证的在线自托管 runner，因此 `VAL-709` 保持阻塞。

## 当前验收记录

- 健康报告专项测试通过；真实 Windows `toolchain` 阶段退出 0。
- 模型安全编排及联合既有安装器/预检契约测试通过。真实 quick 检测显示本地/受管模型与 Ollama 可用，CUDA 缺失被明确报告，且没有执行安装、下载或许可接受。
- 固定素材性能编排的参数、隔离、日志、比较和失败关闭契约已通过专项测试；`D:\PxHereDataset\images\pxhere-000000` 的 quick `--plan` 验证通过且未创建输出目录。
- 来源派生数据审计与夜间编排专项测试通过；均验证输出路径隔离、失败继续汇总、token/路径脱敏和原素材不变边界。
- `npm.cmd run verify` 已完整执行并以 exit 0 结束，覆盖 TypeScript、ESLint、Prettier、顶层 `npm test` 和受检 Renderer 构建；据此 `VAL-707` 更新为 `verified`。
- 真实最终 source audit：`artifacts/automation/source-audit/pxhere-readonly-20260824-final.json` 为 `passed`，用时 159,554 ms；Native 索引为 1,000 条、图片模型向量为 1,000 条、主体向量为 1 条，总计 2,001 条派生记录。源目录前后均为 2,000 个文件、2,628,188,974 bytes，metadata SHA-256 一致，`originalFilesAffected=0`、`readOnlyInvariantsPassed=true`。该来源没有关联视频记录，另有 2 个白名单审计文件中的 5 条来源路径痕迹按策略保留。
- 真实最终 quick benchmark：`artifacts/automation/pxhere-quick-20260824-final/report.json` 对 16 张图片执行 3 轮配对 A/B，并与 `pxhere-quick-20260824-2040` 按 10% 阈值比较；报告为 `failed`。内容、向量索引、DINO/CLIP Embedding 和 warm 零重复推理 parity 均通过，但 Library Ready P50/P95 为 14,903.01/15,188.90 ms，总耗时 P50/P95 为 19,174.12/19,433.61 ms，其中 Library Ready P95 相对基线增加 10.674%，超过阈值；A/B 自身还记录 P50 收益仅 7.17%、主进程 RSS P95 超预算，以及 GPU 峰值 3,079/4,096 MiB（75.17%）的环境余量限制。
- 上述 quick benchmark 仍是历史诊断失败证据，不是获批的稳定基线，也未用于放宽门禁。固定硬件正式基线已在 2026-08-26 完成：`artifacts/benchmark/fixed-hardware-first-build/latest.json` 指向 `baseline-20260826-final-accepted/report.json`，三轮 1000 图均通过，Library Ready P50/P95 为 `265833.94/270172.98 ms`、波动率 `2.26%`，并已固化后续时间、内存和系统空闲内存控制线；据此 `VAL-708` 更新为 `verified`。
- 当前机器状态为 `verified=8`、`active=0`、`blocked=[VAL-709]`、`selected=null`。`VAL-709` 仍缺 Git remote、受保护分支和可验证的在线自托管 runner，因此继续保持 `blocked`。
