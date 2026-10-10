# 视频帧向量流式规模验收（RMO-042）

> 日期：2026-08-29  
> 结论：通过  
> 原始报告：`artifacts/benchmark/runtime-memory/scale/report.json`

## 验收范围

- 完全使用合成路径与合成向量，不读取真实图片、视频或用户索引。
- manifest 覆盖 100 万行；视频帧向量分别覆盖 CLIP 512 维和 DINO 768 维的 10 万、50 万条记录。
- 查询使用生产实现 `scanVideoFrameVectors`、生产评分函数 `normalizedCosineScore` 和有界 Top-K；每组都与确定性精确答案比较。
- 工作数据库只创建在 `artifacts/benchmark/runtime-memory/scale` 的隔离临时目录，结束后自动删除；只保留摘要报告。

## 结果

| 模型 | 维度 | 帧数 | 临时 SQLite | 建库 | 全量扫描 | Heap 峰值增量 | RSS 峰值增量 | Top-10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| CLIP | 512 | 100,000 | 446.43 MiB | 1.73 s | 1.96 s | 8.16 MiB | 30.69 MiB | 精确一致 |
| CLIP | 512 | 500,000 | 2.18 GiB | 7.96 s | 8.86 s | 12.67 MiB | 22.64 MiB | 精确一致 |
| DINO | 768 | 100,000 | 446.43 MiB | 1.60 s | 1.93 s | 9.22 MiB | 36.89 MiB | 精确一致 |
| DINO | 768 | 500,000 | 2.18 GiB | 8.19 s | 9.25 s | 10.41 MiB | 21.45 MiB | 精确一致 |

100 万行 manifest 的构建耗时 6.14 秒，20 轮 count/preview/find 共 1.31 秒；查询后 Heap 仅增加 0.61 MiB，RSS 增加 1.52 MiB。

## 工程结论

1. 正式视频图片搜索、文本搜索和相似帧搜索均使用 SQLite 逐行迭代，不在查询期创建全量向量 Map 或全量评分数组。
2. 每一行的 BLOB 都复制到当前回调独占的 `Float32Array`，避免 SQLite 行缓冲生命周期造成悬空引用；回调返回后即可回收。
3. Top-K 候选受请求 `topK` 上限约束，取消检查和事件循环让步均保留。
4. 50 万帧下 Heap/RSS 峰值没有随 2.18 GiB 数据库线性增长，满足“按窗口而非总行数增长”的门禁。
5. 同步 Map/JSONL 接口仅保留给历史测试与诊断；生产管线的默认依赖固定为 `buildFrameIndexAsync`，搜索固定走 `scanFrameIndexVectors`。

## 复现

```powershell
npm.cmd run benchmark:memory:scale
```

门禁：所有规模 `scanned === rows`、Top-K 精确一致、查询 Heap 峰值增量不超过 64 MiB、RSS 峰值增量不超过 256 MiB。
