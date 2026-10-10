# 默认入口、固定性能基线与运行时加固自动 TODO

> 状态：当前  
> 更新日期：2026-08-26  
> 范围：`src/`、`electron/`、`native/`、`scripts/`、`tests/`  
> 执行系统：Codex/coder  
> 所有者：Codex/coder（主执行）；Codex/coder/project_product_ux；Codex/coder/project_architecture_quality；Codex/coder/skills_mcp_audit  
> 选择命令：`npm.cmd run todo:foundation-next`  
> 结构校验：`npm.cmd run todo:foundation-check`  
> 自动验收：`npm.cmd run todo:foundation-auto`  
> 替代文档：无

## 结论

本 TODO 把本轮要求限定为三个可独立验收的结果：统一默认入口；在同一硬件和同一只读素材上形成连续三次首次建库基线；拆分热点模块并加固模型伴随文件和 Native 解码边界。原有图片、视频、素材库和高级能力继续保留，不更改索引、搜索结果或用户素材语义。

代码、专项测试和真实三轮证据现已全部通过；脚本、生成计划或复用旧报告均不算完成。机器状态为 `verified=7`、`active=0`、`blocked=[]`、`selected=null`。

## 机器可读任务

| Rank | ID      | Value | Mode | Dependencies                                      | External blockers | Branch                                      | Status      | Validation                                             | Task                                                                                   |
| ---: | ------- | ----: | ---- | ------------------------------------------------- | ----------------- | ------------------------------------------- | ----------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
|    1 | VAL-801 |   100 | auto | -                                                 | -                 | `ux/unified-default-entry`                  | verified | product information architecture + focused UI tests    | 默认只保留一个来源中心和一个主搜索入口，高级图片、视频、素材库与管理面板按需展开       |
|    2 | VAL-802 |    99 | auto | -                                                 | -                 | `perf/fixed-hardware-baseline-harness`      | verified | baseline contracts + plan is read-only                 | 固定 CPU、GPU、内存、软件和数据集指纹，记录逐轮时间线、首次 Ready 与进程内存峰值       |
|    3 | VAL-803 |    98 | auto | VAL-802                                           | -                 | `perf/three-run-first-build-baseline`       | verified | three real isolated 1000-image runs + accepted limits  | 在同一硬件连续执行三次首次建库，生成 P50/P95、波动率、RSS 峰值与后续回退控制线          |
|    4 | VAL-804 |    97 | auto | -                                                 | -                 | `architecture/oversized-module-split`       | verified | line budget + existing behavior regression tests       | 拆分超大热点模块，保持公开 API、数据库格式、性能路径和原有行为不变                    |
|    5 | VAL-805 |    96 | auto | -                                                 | -                 | `security/model-companion-integrity`        | verified | companion size/SHA-256/download-state tests            | 对模型伴随文件执行固定清单、大小、SHA-256、流式上限、临时文件和原子提交校验            |
|    6 | VAL-806 |    95 | auto | -                                                 | -                 | `security/native-bounded-fuzz`              | verified | deterministic corpus + isolated crash/timeout gate     | 对 Native 图片入口执行固定种子、恶意尺寸、截断和随机语料的有界子进程 fuzz             |
|    7 | VAL-807 |    94 | auto | VAL-801,VAL-802,VAL-803,VAL-804,VAL-805,VAL-806  | -                 | `qa/product-foundation-final-gate`          | verified | focused suite + typecheck + architecture + docs checks | 接入统一自动入口，复核任务状态、文档、类型、架构、模型完整性与 Native 安全回归         |

## 固定执行边界

1. UI 只改变默认信息架构和展开方式，不删除既有面板、IPC、设置或索引能力；旧的面板可见性设置必须迁移到一个确定的新默认值。
2. 性能基线固定使用 `D:\PxHereDataset\images\pxhere-000000` 的确定性 1000 图样本、GPU、2 个任务、batch 4 和 `overlap` 首建流水线，三轮分别使用隔离 `userData`，不得写真实用户库或修改素材。
3. 每轮必须保留完整 JSON、受限 stdout/stderr 和 NDJSON 阶段时间线。任一轮崩溃、超时、资源采样缺失、向量数量不一致、源文件变化或软件指纹变化均失败关闭。
4. 第一份通过报告建立控制线；后续相同硬件、数据集和配置自动比较首次 Ready P95、主/子/合计 RSS P95 与系统空闲内存下限。不同指纹不得混入趋势。
5. 模型已下载状态必须同时依赖主文件与伴随文件完整性；网络响应不得一次性无界读入内存，失败不得留下可被误判为可用的目标文件。
6. Native fuzz 只使用专属系统临时目录和固定资源预算，不读取用户素材，不把异常退出、访问冲突或挂死解释为“安全拒绝”。
7. 不下载模型、不删除索引、不修改用户素材、不发布 release，也不把 ASan/LibFuzzer 尚未覆盖的范围宣称为已证明安全。

## 验收命令

| 项目             | 命令                                                                                                            | 完成条件                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| TODO 结构        | `npm.cmd run todo:foundation-check`                                                                             | 7 个唯一任务、依赖闭合、无外部阻塞                          |
| 默认入口         | `node --test tests/product-information-architecture.test.cjs tests/product-first-run-guide.test.cjs`            | 一个来源中心、一个主搜索入口，高级入口可恢复                |
| 基线契约         | `node --test tests/fixed-hardware-performance-baseline.test.cjs`                                                | 参数、指纹、内存门禁和回退比较失败关闭                      |
| 真实基线         | `npm.cmd run automation:performance-baseline -- --establish`                                                    | 固定指纹下 3/3 首建通过并写入 `latest.json`                 |
| 模型伴随文件     | `npm.cmd run test:model-download`                                                                               | 大小、哈希、流式上限、临时清理和下载状态测试通过            |
| Native fuzz      | `node --test tests/native-image-fuzz.test.cjs tests/native-decode.test.cjs`                                      | 固定语料摘要一致；无崩溃、超时、异常退出或临时目录残留      |
| 热点拆分         | `npm.cmd run test:architecture` 及素材库数据库专项测试                                                          | 新模块职责单一，层级合法，公开 API 和持久化语义不变         |
| 最终自动验收     | `npm.cmd run todo:foundation-auto`                                                                              | 所有专项、类型、架构和文档门禁通过；真实基线证据已经存在    |

## 当前证据

- 统一入口专项用例 `17/17` 通过：默认界面只有一个来源中心和一个主搜索入口，图片、视频、素材库及管理工具仍可从按需展开的高级入口恢复，原有 IPC、索引与结果语义未删除。
- 固定硬件基线契约用例 `35/35` 通过。`artifacts/benchmark/fixed-hardware-first-build/latest.json` 已在 2026-08-26 接受 `baseline-20260826-final-accepted/report.json`；指针文件 SHA-256 为 `3533af7d8310b710c26e5b170cb2f47ae0bf026111b97588388c305e5ccdf137`，接受报告 SHA-256 为 `29a34b9300b0aa673bec55632735799ac5bab70eb93768b967723b166673bfe2`。
- 正式基线固定使用 1000 图、GPU、`overlap`、2 个任务、batch 4、2 个扫描 worker，三轮均通过且 DINO/CLIP 实际 provider 均仅为 DirectML、无 fallback。Library Ready P50/P95 为 `265833.94/270172.98 ms`，波动率 `2.26%`；主、子、合计 RSS P95 分别为 `687.50/3317.94/3951.75 MiB`，系统最低空闲内存为 `1350.56 MiB`。
- 已建立后续控制线：Library Ready P95 `297190.28 ms`，主、子、合计 RSS P95 分别为 `790.63/3815.63/4544.51 MiB`，系统空闲内存下限 `1012.92 MiB`。三轮原始 JSON、受限日志和 NDJSON 时间线均由 accepted report 绑定。
- 素材库数据库已拆为 `assetLibraryDatabase.ts`（1387 行）、`assetLibraryDatabaseRecords.ts`（717 行）和 `assetLibraryDatabaseSchema.ts`（75 行）；模型服务已拆为 `modelService.ts`（404 行）与 `modelServiceCompanions.ts`（356 行）。架构和既有行为专项回归通过。
- 模型下载/完整性测试 `115/115` 通过，覆盖 HTTPS、固定清单、大小、SHA-256、安全路径、重复项、总量上限、流式写入、原子修复和失败清理。
- Native 固定 fuzz 的 28 个语料摘要为 `a37af86f5da880cbaf610bef44f809a6cc83296a799c57c4e31cd2893c73c042`，与既有解码回归合计 `13/13` 通过；无崩溃、超时、异常退出或专属临时目录残留。
- 最终门禁已复核 TODO 契约、专项测试、TypeScript、架构、Renderer 构建、模型完整性、Native 安全回归和 accepted baseline，`VAL-807` 更新为 `verified`。

## 剩余风险

- 子进程 RSS 是采样时刻的直接子进程近似合计，报告必须保留该口径，不能伪装成操作系统级精确归因。
- GPU 指标由 `nvidia-smi` 提供；GPU 后端缺少可用硬件指纹时基线直接失败。
- Native 有界 fuzz 能捕获进程可观察的崩溃、挂死和错误接受，但不替代后续独立 ASan/LibFuzzer 工具链。
- `latest.json` 采用排他创建并禁止覆盖；极端中断若发生在首次指针写入期间，解析会失败关闭但需要依据报告 SHA 进行人工审计恢复，后续可作为非阻断 P2 原子发布加固项。

## 变更记录

- 2026-08-25：建立机器可读 TODO，开始默认入口、固定三轮基线、热点拆分、模型伴随文件完整性和 Native fuzz 自动实施。
- 2026-08-26：统一入口、模块拆分、模型伴随文件校验和 Native fuzz 完成；固定硬件 1000 图三轮正式基线通过并写入不可变 `latest.json`，7 个任务全部更新为 `verified`。
