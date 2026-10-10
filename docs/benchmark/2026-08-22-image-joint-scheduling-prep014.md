# PREP-014 图片扫描与 Embedding 联合调度矩阵验证

> 状态：筛选完成，保留当前策略  
> 日期：2026-08-22  
> 数据集：PxHere `pxhere-000000` 固定 256 图子集，495,113,164 bytes  
> 当前基线：Native scan=3、Embedding jobs=2、batch=4、DirectML

## 结论

`PREP-014` 没有产生可进入 1000 图决赛的候选，生产 `scan=3,jobs=2,batch=4` 保持不变。

- 当前基线三轮 ready P50/P95 为 `77.287/85.061 s`。
- scan=2/jobs=2 的 P50 为 `94.524 s`，相对基线慢 `22.30%`；scan=2/jobs=1 慢 `47.97%`。
- scan=3/jobs=1 的扫描 P50 可降到 `37.205 s`，但完整 ready P50 增加到 `115.407 s`，慢 `49.32%`；减少 Embedding worker 只把瓶颈转移到 DINO/CLIP 串行尾部。
- 请求 scan=4 时，六轮启动可用内存只有约 `2.79–3.29 GiB`，现有生产内存策略把有效 worker 安全限制为 3。因此它被记录为 `skipped-resource-policy`，不能将实际 scan=3 的耗时冒充 scan=4 结果。
- 没有候选达到 256 图 ready P50 至少改善 5% 的入围门槛，1000 图三轮决赛不适用。

本轮绝对耗时高于较早的 `61.607 s` 仪表化基线，主要环境差异是测试期间系统/GPU 全局负载较高。六个组合按三轮交错顺序在同一时间窗运行，因此本报告只使用同窗相对结果，不与旧时段绝对值直接判优。

## 三轮矩阵

| 请求 scan | 有效 scan | Embedding jobs | 轮数 | Ready P50 | Ready P95 | 相对基线 | Scan ready P50 | DINO ready P50 | 最低空闲内存 |      GPU 峰值 | 决策                   |
| --------: | --------: | -------------: | ---: | --------: | --------: | -------: | -------------: | -------------: | -----------: | ------------: | ---------------------- |
|         2 |         2 |              1 |    3 | 114.360 s | 114.647 s |  -47.97% |       54.587 s |       61.113 s |   951.68 MiB | 2649/4096 MiB | 拒绝：ready 更慢       |
|         2 |         2 |              2 |    3 |  94.524 s |  94.888 s |  -22.30% |       55.881 s |       57.068 s |   296.37 MiB | 2991/4096 MiB | 拒绝：ready 更慢       |
|         3 |         3 |              1 |    3 | 115.407 s | 121.852 s |  -49.32% |       37.205 s |       63.168 s |  1537.53 MiB | 2660/4096 MiB | 拒绝：Embedding 长尾   |
|         3 |         3 |              2 |    3 |  77.287 s |  85.061 s |       0% |       43.841 s |       44.692 s |   536.27 MiB | 2998/4096 MiB | 保留当前               |
|         4 |         3 |              1 |    3 |    不判定 |    不判定 |   不适用 |       37.236 s |       62.953 s |  1068.03 MiB | 2731/4096 MiB | 跳过：资源策略限制为 3 |
|         4 |         3 |              2 |    3 |    不判定 |    不判定 |   不适用 |       45.236 s |       46.411 s |   592.41 MiB | 2958/4096 MiB | 跳过：资源策略限制为 3 |

P50/P95 使用最近秩；正收益才表示比当前组合快。scan=4 两行保留实际观测时间仅用于证明资源策略生效，不参与候选排名。

## 正确性、资源与安全

| 门禁             | 结果                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Native parity    | 18 份报告的 256 条宽高/双哈希摘要完全一致                                                                           |
| DINO/CLIP parity | 两模型稳定向量摘要跨 18 轮一致；每轮均为 256/256                                                                    |
| 索引与覆盖       | 向量索引数量/维度一致；Embedding 失败 0、fallback batch 0、commit-feed drop 0                                       |
| 资源采样         | 合计 9618 个样本、错误 0、process-race skip 0                                                                       |
| 当前基线资源     | 最低空闲内存 536.27 MiB；主进程 RSS 峰值 822.76 MiB；child 聚合峰值约 3140.53 MiB；GPU 峰值 2998/4096 MiB（73.19%） |
| 源只读           | 18 轮源快照均为 SHA-256 `686a2439f6353bba24c6e625c6994e65866dfac9757afe2e79171ae5c3c8eae0`，运行后未变              |
| 去标识           | JSON/NDJSON 不保存源路径、文件名、向量正文或图像内容                                                                |

## 为什么不调整参数

1. scan=2 延长了解码关键路径，释放的资源没有抵消扫描墙钟损失。
2. jobs=1 虽降低 child RSS 和显存，但 DINO/CLIP 尾部显著变长，不满足完整 ready 目标。
3. scan=4 在当前可用内存下不属于生产策略允许的实际组合；强行绕过内存门禁与本任务安全边界冲突。
4. 所有可执行候选 P50 都是负收益，因此无需再占用 1000 图长测时间。

## 复现与产物

```powershell
npm.cmd run benchmark:image-search:joint-scheduling -- --dataset="D:\PxHereDataset\images\pxhere-000000" --sample=256 --rounds=3 --scan-workers=2,3,4 --embedding-jobs=1,2 --batch-size=4 --backend=gpu --timeout-ms=900000 --out-dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep014"
npm.cmd run benchmark:image-search:joint-scheduling:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep014"
```

- 机器生成矩阵分析（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep014/matrix-analysis.md`）
- 矩阵执行清单（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep014/matrix-manifest.json`）
- [PREP-011 阶段归因](2026-08-22-image-preparation-stage-attribution-prep011.md)
- [PREP-012 Embedding 策略矩阵](2026-08-22-embedding-policy-matrix-prep012.md)


2026-09-24 归档说明：以上 `artifacts/` 路径为未随源码分发的本机历史证据位置。源码副本不包含这些原始产物；历史摘要保留，不代表在当前副本重新运行或验证。
