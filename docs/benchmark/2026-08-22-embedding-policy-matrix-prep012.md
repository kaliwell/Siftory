# PREP-012 DirectML batch/worker 受资源约束矩阵验证

> 状态：筛选完成，保留当前策略  
> 日期：2026-08-22  
> 数据集：PxHere `pxhere-000000` 的固定 256 图子集，495,113,164 bytes  
> 当前基线：DINO/CLIP 均为 `jobs=2, batch=4`；更大 batch 只在 auto 内存与显存门禁允许时测试

## 结论

`PREP-012` 没有产生可进入 1000 图决赛的候选，生产 `auto` 和显式用户参数均保持不变：

- DINO `jobs=2,batch=4` 三轮 P50 为 `35.728 s`；`jobs=1,batch=4` 为 `64.565 s`，相对当前慢 `80.71%`。
- CLIP `jobs=2,batch=4` 三轮 P50 为 `34.603 s`；`jobs=1,batch=4` 为 `49.838 s`，相对当前慢 `44.03%`。
- CLIP `jobs=1,batch=8` 只在一轮资源窗口通过预检，耗时 `37.771 s`，仍比当前 P50 慢 `9.15%`；没有继续占用长测时间。
- batch 8/16 的其余组合被现有 `selectEmbeddingBatchSize` RAM/VRAM 门禁明确跳过，没有强行运行到 OOM。

因此没有组合满足“256 图至少快 5%”的入围条件，1000 图三轮决赛按设计不适用。这个结果不是“优化失败后忽略数据”，而是用门禁避免把更慢或资源不足的参数写入默认策略。

## 测试方法

矩阵使用独立模型子进程，交错执行三轮 `jobs=1/2, batch=4`。第一轮同时尝试 batch 8/16；每个候选启动前复用生产 auto 策略检查系统内存、总内存、空闲显存、模型和 worker 数。每个已运行候选记录：

- 每 batch 队列等待、运行时加载、读取/解码、预处理、推理、后处理和 fallback；
- 主/子进程 CPU、RSS、I/O、系统最低空闲内存、GPU 显存/利用率和进程数；
- 全部向量摘要、逐候选余弦/最大绝对差、源快照和采样错误；
- 去标识 `*.timeline.ndjson`，不包含源路径、文件名或向量正文。

三轮顺序为 `1→2`、`2→1`、`1→2`，避免总由同一候选先享受缓存或较低温度。

## 三轮结果

| 模型 | Jobs | Batch | 轮数 |      P50 |      P95 | 相对当前 | 前推理占比 P50 | 最低系统空闲 | Child RSS 峰值 | GPU 峰值 | 采样错误 | 决策                               |
| ---- | ---: | ----: | ---: | -------: | -------: | -------: | -------------: | -----------: | -------------: | -------: | -------: | ---------------------------------- |
| DINO |    1 |     4 |    3 | 64.565 s | 78.408 s | -80.714% |        40.020% |  1343.52 MiB |    1574.44 MiB | 3081 MiB |        0 | 拒绝：速度低于基线                 |
| DINO |    2 |     4 |    3 | 35.728 s | 40.413 s |       0% |        44.942% |   315.41 MiB |    2923.25 MiB | 3394 MiB |        0 | 保留当前                           |
| CLIP |    1 |     4 |    3 | 49.838 s | 50.811 s | -44.027% |        62.728% |  1522.28 MiB |    1644.17 MiB | 3066 MiB |        0 | 拒绝：速度低于基线                 |
| CLIP |    1 |     8 |    1 | 37.771 s | 37.771 s |  -9.153% |        75.947% |  2616.97 MiB |    1594.85 MiB | 1839 MiB |        0 | 拒绝：首轮已低于基线且后续余量不足 |
| CLIP |    2 |     4 |    3 | 34.603 s | 35.772 s |       0% |        64.343% |   316.38 MiB |    3025.16 MiB | 3594 MiB |        0 | 保留当前                           |

正值才表示提速。P50/P95 使用最近秩，不选择单次最快值。双 worker 虽然更快，但 DINO/CLIP 最低系统空闲内存分别只有 `315.41/316.38 MiB`，所以不能放宽 batch 门禁。

## 被资源门禁跳过的组合

| 模型 | Jobs | Batch | 原因                                                                         |
| ---- | ---: | ----: | ---------------------------------------------------------------------------- |
| DINO |    1 |  8/16 | auto 只允许 batch 4；初始空闲内存/显存不足                                   |
| DINO |    2 |  8/16 | 即使阶段间资源恢复，batch 8 的估算需求仍比空闲内存高约 29 MiB；batch 16 更高 |
| CLIP |    1 |    16 | 当时 auto 上限为 batch 8                                                     |
| CLIP |    2 |  8/16 | 双 worker 下 auto 上限为 batch 4；后续 GPU 空闲曾降到约 1051 MiB             |

`skipped` 不解释为耗时 0，也不参与 P50；报告保留每次预检的可用内存、显存、策略上限和枚举原因。

## 正确性与安全

| 门禁                 | 结果                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| DINO jobs 1/2 parity | min/mean cosine `1/1`，最大绝对差 `0`，三轮摘要一致                                                              |
| CLIP jobs 1/2 parity | min/mean cosine `1/1`，最大绝对差 `0`，三轮摘要一致                                                              |
| CLIP batch 8 parity  | min/mean cosine `1/1`，最大绝对差 `0.00000529`，在既有阈值内                                                     |
| 成功/fallback        | 每个已运行组合 256/256 成功，失败 0，fallback batch 0                                                            |
| 资源采样             | 所有已运行候选合计错误 0，无检查点恢复                                                                           |
| 源只读               | 三份报告的 256 图快照均为 SHA-256 `686a2439f6353bba24c6e625c6994e65866dfac9757afe2e79171ae5c3c8eae0`，运行后不变 |
| 去标识               | JSON/NDJSON 不记录源路径和文件名；每 batch 日志只含模型、jobs、batch、阶段聚合值                                 |

## 后续候选的影子拒绝

阶段归因之后额外验证了两个不改变向量算法的 CLIP 微优化，均未接入：

1. **本地文件直接交给 Sharp。** 配对默认解码为 `33.431 s`，直接 Sharp 为 `34.415 s`，候选慢 `2.95%`。child 读取量从约 `1.65 GiB` 降到 `0.73 GiB`，但没有转化为墙钟收益；向量摘要一致。实验分支已移除。
2. **tensor 生成后提前释放 RawImage 引用。** 影子轮为 `35.050 s`，没有超出当前 `33.431–35.772 s` 波动范围，child RSS 峰值也未下降。说明实际内存释放受 V8/Sharp 生命周期控制；实验改动已移除。

基于当前 jobs=2 基线最低空闲内存约 `315 MiB`、1000 图完整轮最低仅 `3.97 MiB`，深度 2 的完整 RawImage 双缓冲不满足资源门禁，`PREP-013` 在这台 16 GiB/4 GiB 机器上暂缓。后续若实现 tensor 级、有严格字节上限的预取，仍须重新通过 256 图和 1000 图门禁。

## 复现与产物

```powershell
node tests/image-search-simple-embedding-benchmark.cjs "D:\PxHereDataset\images\pxhere-000000" --sample=256 --models=dino,clip --jobs-list=1,2 --batch-sizes=4,8,16 --backend=gpu --stage-metrics --resource-interval-ms=100 --timeout-ms=600000 --json-out=<matrix.json> --timeline-out=<matrix.timeline.ndjson>
node scripts/analyze-embedding-policy-matrix.cjs --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep012"
```

- 机器生成的矩阵分析（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep012/matrix-analysis.md`）
- Round 1（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep012/matrix-256-r1.json`）
- Round 2（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep012/matrix-256-r2.json`）
- Round 3（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep012/matrix-256-r3.json`）
- [PREP-011 阶段归因](2026-08-22-image-preparation-stage-attribution-prep011.md)
- [速度优化方案](../current/2026-08-22-image-preparation-speed-optimization-plan.md)


2026-09-24 归档说明：以上 `artifacts/` 路径为未随源码分发的本机历史证据位置。源码副本不包含这些原始产物；历史摘要保留，不代表在当前副本重新运行或验证。
