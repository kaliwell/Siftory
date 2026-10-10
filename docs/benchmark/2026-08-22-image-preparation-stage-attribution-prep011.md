# PREP-011 图片准备阶段归因与完整资源曲线验证

> 状态：已验证  
> 日期：2026-08-22  
> 数据集：PxHere `pxhere-000000`，1000 张受支持图片，2,627,418,359 bytes  
> 范围：Native 扫描、DINO、CLIP、持久化、逐阶段时间线和资源采样；不改变产品调度、模型、向量或搜索语义

## 结论

`PREP-011` 已通过。详细指标默认关闭，启用后的 256 图三轮 ready P50 为 `61.607 s`，关闭时为 `61.515 s`，差异 `+0.149%`，低于 `+1%` 开销上限。六轮 Native、DINO、CLIP 摘要、索引数量和源快照完全一致。

1000 图完整长测采集到 `1187` 个资源样本，采样错误为 `0`，没有依赖检查点恢复。阶段证据显示：

- Native 的纯文件系统枚举只有 `0.010 s`；原 `enumMs` 的绝大部分是有界队列反压。worker 负载均衡，瓶颈集中在安全解码与 hash，而不是目录遍历。
- DINO 的读取/解码占核心 batch 时间 `63.14%`；CLIP 的读取/解码与预处理合计占 `78.24%`。两者都显著超过 `PREP-013` 的 `10%` 触发线。
- 干净长测的系统最低空闲内存只有 `3.97 MiB`，因此不能直接把 batch 或 worker 调大。`PREP-012` 必须先做带资源拒绝条件的 256 图筛选，再进入 1000 图三轮决赛。

本项只补充去标识聚合诊断，并把遥测从额外 stdout 帧优化为既有结果帧内联；没有修改默认 batch、worker、ready 门禁或用户数据格式。

## 实现与日志边界

| 层级            | 新增归因                                                                        | 传输与安全边界                                                                              |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Native scanner  | 纯枚举、队列等待/阻塞、高水位、读取字节/耗时、提交耗时、worker 完成量与忙碌时间 | `REASONIX_NATIVE_STAGE_METRICS=1` 才启用；只记录聚合值，不记录路径                          |
| DINO/CLIP child | 队列等待、运行时加载、读取/解码、预处理、推理、后处理、fallback 和 batch 墙钟   | `REASONIX_EMBEDDING_STAGE_METRICS=1` 才启用；指标内联到每批第一个既有结果帧，不增加结果行数 |
| 主进程          | batch/项目成功失败数、持久化操作、总/最大耗时和 pending 高水位                  | 协议验证数值边界、batch 上限与计数关系；丢弃任意额外字段                                    |
| Benchmark       | 阶段开始/结束、进度变化间隔、阶段归因、资源与正确性摘要                         | NDJSON 增量落盘；源路径、文件名和图像内容不写入时间线                                       |
| 资源 sidecar    | 主/子进程 CPU、RSS、I/O，系统空闲内存，GPU/显存和进程数                         | 5 秒不可变编号检查点；最终文件缺失时才逆序恢复；采样失败与进程退出竞态分开计数              |

## 256 图遥测开销门禁

固定 `pipeline=overlap`、`jobs=2`、`batch=4`、DirectML 和 deferred thumbnails。最终开启组使用内联指标实现；早期额外 stdout 指标帧的试验不计入最终组。

| 模式             |  Round 1 |  Round 2 |   Round 3 | ready P50 | 相对关闭 P50 |
| ---------------- | -------: | -------: | --------: | --------: | -----------: |
| 关闭详细指标     | 61.515 s | 61.065 s |  63.253 s |  61.515 s |            - |
| 开启内联详细指标 | 61.607 s | 60.052 s | 105.232 s |  61.607 s |    `+0.149%` |

开启组第三轮开始时 GPU 已占用 `2692/4096 MiB`，运行中系统最低空闲内存为 `15.39 MiB`，因此它是可解释的资源压力最大值，不代表遥测自身开销。它仍保留在三轮数据中，没有被删除；P50 门禁可抵抗该单轮外部压力。

所有六轮均满足：Native/DINO/CLIP/向量索引各 `256` 条，源快照不变；Native、DINO、CLIP 和源快照各自只有一个唯一摘要。

## 1000 图详细阶段归因

以下取自最终无采样错误的 `instrumented-overlap-1000-resource-v5.json`。batch/worker 阶段值是并行 worker 聚合时间，可以大于对应墙钟时间。

### Native scanner

| 指标                |                           结果 | 判断                                     |
| ------------------- | -----------------------------: | ---------------------------------------- |
| 扫描墙钟            |                      161.826 s | 与 DINO 重叠，不能和 DINO 墙钟相加       |
| 纯文件系统枚举      |                        0.010 s | 不是优化目标                             |
| producer 队列等待   |                      145.817 s | 反映 consumer 解码反压，不是独立空等     |
| 队列阻塞提交        |              901/1000（90.1%） | 队列持续有界，不能靠扩大队列解决计算瓶颈 |
| 文件读取            | 13.696 s / 2,627,418,359 bytes | worker 聚合；约 182.95 MiB/s             |
| 图片解码            |                      420.063 s | worker 聚合；Native 主成本               |
| hash                |                       48.429 s | worker 聚合；次于解码                    |
| 记录提交            |                        0.014 s | 不是优化目标                             |
| 队列峰值            |                             96 | 符合当前有界队列                         |
| worker 完成量跨度   |                          26 张 | 三个 worker 为 318–344 张                |
| worker 忙碌时间跨度 |                        0.404 s | 负载均衡，不需要按文件大小重新排队       |

### DINO 与 CLIP

| 模型 | Batches / items | Runtime load | Decode/normalize | Preprocess | Inference | Postprocess | 前推理占比 | Persistence | Queue wait |
| ---- | --------------- | -----------: | ---------------: | ---------: | --------: | ----------: | ---------: | ----------: | ---------: |
| DINO | 250 / 1000      |      1.288 s |        124.254 s |        0 s |  70.000 s |     1.248 s |     63.14% |    12.927 s |    0.111 s |
| CLIP | 250 / 1000      |      4.370 s |        148.136 s |   23.372 s |  42.245 s |     1.073 s |     78.24% |    11.034 s |    0.135 s |

两个模型均为 `1000` 成功、`0` 失败、`0` fallback。四轮可读的 1000 图详细诊断中，DINO 前推理占比稳定在 `61.35%–63.14%`，CLIP 稳定在 `78.24%–79.04%`，不是单轮偶然值。

### 墙钟与资源

最终长测的 ready 为 `276.270 s`，其中扫描 `161.826 s`、DINO 推理与持久化 `162.165 s`、CLIP `111.167 s`、向量索引 `0.229 s`。该轮发生严重系统内存压力，因此只用于阶段比例、资源上界和正确性验证，不替代既有三轮 ready P50 `225.924 s` 性能基线。

| 资源                         |                                结果 |
| ---------------------------- | ----------------------------------: |
| 资源样本 / 错误 / 检查点恢复 |                       1187 / 0 / 否 |
| 主进程峰值 RSS               |                          767.17 MiB |
| 子进程聚合峰值 RSS（近似）   |                         2931.50 MiB |
| 最大单个 child RSS（近似）   |                         1668.75 MiB |
| 系统最低空闲内存             |                            3.97 MiB |
| GPU 基线 / 峰值 / 增量       |               1089 / 1960 / 871 MiB |
| GPU 总显存 / 峰值利用率      |                      4096 MiB / 99% |
| 主进程 / child 读取（近似）  | 6,478,163,230 / 6,327,357,493 bytes |

## 正确性、恢复与安全门禁

| 门禁       | 结果                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Native     | 1000 条；SHA-256 `54d4dee6ca91e9fb118d2c9fdffbddee759c7521b6bab478f64f892fa3ad2561`                                         |
| DINO       | 1000 条；稳定摘要 `996958e15245c5f12466af4d99e89538c222e34f63c17d6f74e41e198f3a7d29`                                        |
| CLIP       | 1000 条；稳定摘要 `694ab1faa33184dedd54a1bfd520fab5d3b3cc177db1822c8a13dfcc6385a7ef`                                        |
| 向量索引   | built，1000 条，DINO 768 维                                                                                                 |
| 温更新     | 797.58 ms；committed/invalidated/dropped 均为 0；两模型均跳过 1000 条                                                       |
| 后台缩略图 | 1000/1000，失败 0；不计入 searchable ready                                                                                  |
| 源只读     | 运行前后 1000 条、2,627,418,359 bytes、SHA-256 `f53e912991a9c7385d33b1833b2a65ffc26cce92784c178661e8a788d9430437`，保持不变 |
| 隔离       | 独立临时 `userData`；未写真实素材库、模型、Manifest 或用户索引                                                              |
| 协议       | 非负有限数、batch 上限、成功/失败计数和模型归属均验证；路径与额外字段不会进入指标                                           |
| 采样恢复   | 大字节计数改用 double；检查点不覆盖旧文件；最终轮无需恢复且错误为 0                                                         |

## 后续优化决策

1. `PREP-012` 是下一执行项，但 batch 8/16 或双 worker 候选必须先检查系统内存与显存余量；资源不足时记录 `skipped`，不强行启动。只在 256 图入围后做 1000 图三轮交错 A/B，收益不足 `5%` 不改 `auto`。
2. `PREP-013` 已被证据触发。优先评估单模型、深度 2、字节有上限的解码/预处理双缓冲，让 batch N 推理时准备 batch N+1；取消、低内存和 OOM 必须立即释放并回到当前路径。
3. `PREP-015` 只进入影子评估。纯枚举已经足够快；任何 JPEG 缩放解码候选必须逐图保持宽高、通道、DiffHash64 和 DctHash64 完全一致，否则不得接入。
4. `PREP-006` 的跨 DINO/CLIP 解码复用同样满足 10% 证据条件，但结构和内存风险高于单模型双缓冲，排在 `PREP-012/013` 之后。

## 复现与产物

```powershell
node tests/image-search-simple-e2e-benchmark.cjs "D:\PxHereDataset\images\pxhere-000000" --sample=256 --backend=gpu --pipeline=overlap --jobs=2 --batch-size=4 --defer-thumbnails --stage-metrics --compact --timeout-ms=1800000 --json-out=<report.json> --timeline-out=<timeline.ndjson>
node scripts/analyze-image-preparation-stages.cjs --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep011"
node --test tests/embedding-vector-validation.test.cjs tests/search-library-preparation-benchmark.test.cjs tests/native-scan.test.cjs tests/image-preparation-pipeline.test.cjs
```

- 机器生成的阶段分析（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep011/stage-analysis.md`）
- 最终 1000 图报告（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep011/instrumented-overlap-1000-resource-v5.json`）
- 最终增量时间线（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep011/instrumented-overlap-1000-resource-v5.timeline.ndjson`）
- [速度优化方案](../current/2026-08-22-image-preparation-speed-optimization-plan.md)
- [图片搜索与视频建库性能 TODO](../current/2026-08-22-search-library-preparation-performance-todo.md)


2026-09-24 归档说明：以上 `artifacts/` 路径为未随源码分发的本机历史证据位置。源码副本不包含这些原始产物；历史摘要保留，不代表在当前副本重新运行或验证。
