# Embedding 子进程内存与生命周期验收（RMO-030/034/035）

> 日期：2026-08-29  
> 结论：RMO-030、RMO-034、RMO-035 的工程门禁通过；RMO-031/032/033/036 仍按各自性能与正式环境门禁推进。

## RMO-030：分批内存归因

- DINO、CLIP 每批可选记录 RSS、Private Bytes、external、ArrayBuffer、解码 RGB 字节和临时 Tensor 字节。
- Provider 选择独立记录请求后端、实际 Provider、回退状态和原因；字段经过大小、枚举和数值边界校验，不包含图片绝对路径。
- 遥测默认关闭，仅在 `REASONIX_EMBEDDING_STAGE_METRICS=1` 时采样详细批指标；主进程只保留有界汇总。
- 既有 PREP-011 三轮 256 图对照中，详细阶段指标 P50 开销为 `+0.149%`，低于 1% 门禁。

## RMO-034：所有权与退出

- 完成、停止、错误和新一轮切换均汇入 `stopAllWorkers()`；清空流控制器、准备队列和任务队列，并终止 DINO、CLIP 与 preparation child。
- child 终止同时关闭 stdin/stdout/stderr；Provider/GPU Session 随唯一所有者子进程退出，不留主进程静态 Session。
- 实时资源压力只回收没有活动任务的 child；活动批完成后再按新并发上限退出，已提交结果与待处理队列不丢失。
- 88 项故障矩阵以及 worker lifecycle 专项覆盖取消、崩溃、短读、代际切换、重复停止和下一轮重试。

## RMO-035：传输与 Buffer/Tensor 所有权

- embedding child 返回向量使用长度前缀二进制帧，不再把向量 Base64 化，也没有扩大单行输出上限。
- decoder 对任意 Pipe 分片、连续控制帧、维度/编码不匹配、损坏头和超长帧均 fail-closed。
- 每个解码向量拥有独立 `Float32Array`；不会引用下一次 Pipe/SQLite 读取可能复用的缓冲区，也不存在 use-after-transfer。
- 模型真实运行回归已恢复到约 0.8–1.5 秒，不再触发旧 JSON 行协议造成的 120 秒超时。

## 本次专项回归

```text
33 tests passed
```

覆盖：`embedding-child-binary-protocol`、`embedding-decode-budget`、`embedding-runtime-resource-policy`、`embedding-vector-validation`、`embedding-worker-lifecycle`、`runtime-resource-pressure`。TypeScript 双配置检查同时通过。

完整固定硬件 jobs/batch/overlap 三轮矩阵仍归 RMO-036，不用本报告替代。
