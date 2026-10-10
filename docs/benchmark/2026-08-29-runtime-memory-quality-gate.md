# 真实向量与 NekoSearch 三轮质量/内存门禁（RMO-027）

> 日期：2026-08-29  
> 结论：通过  
> 向量原始报告：`artifacts/benchmark/runtime-memory/quality-gate-final2/report.json`  
> NekoSearch 原始报告：`artifacts/benchmark/neko-ann-prep008/2026-08-29_07-18-14-599/report.json`

## 真实向量三轮

固定执行 3 轮，每轮对 CLIP 与 DINO 各抽取 200 个分层真实查询，执行 F32 权威源与 F16 generation 的精确 Top-50 比较。三轮均重新启动评估进程，并在 CLIP 完成后等待其 recall worker 退出，再启动 DINO worker。

| 模型 | 有效向量 | F32 源记录 | rank-equivalent Recall@50 最小值 | Top-1 等价率最小值 | P99 分数误差最大值 | 耗时 P50/P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CLIP 512D | 383,840 | 383,840 | 1.0000 | 1.0000 | 0.0003891 | 163.18 / 164.84 s |
| DINO 768D | 445,575 | 446,576 | 1.0000 | 1.0000 | 0.0006317 | 266.55 / 268.78 s |

DINO 的物理源记录比 latest-wins 有效集多 1001 条，全部被规范覆盖规则折叠；有效集与 F16 generation 对齐 445,575 条，缺失、畸形、零范数、非有限和维度错误均为 0。严格路径 Recall 仍作为近重复边界诊断保留，不代替以精确 F32 分数判定的 rank-equivalent 门禁。

## 峰值内存

每 500 ms 采集 Node 验收进程及 recall worker 的完整 Windows 进程树。任一轮 Private Bytes 超过 2 GiB 即判失败。

| 轮次 | Private 峰值 | WS 峰值 | 最低系统空闲内存 | 样本数 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 891.04 MiB | 871.05 MiB | 2549.97 MiB | 835 |
| 2 | 1853.78 MiB | 1805.73 MiB | 1900.45 MiB | 857 |
| 3 | 1822.97 MiB | 1776.08 MiB | 1905.62 MiB | 849 |

最差 Private 峰值 1853.78 MiB，低于 2 GiB 门禁约 9.5%。第一轮明显更低，但没有把它当作稳态；后两轮高值和此前一次 2.12 GiB 失败诊断均被保留。失败诊断定位到 CLIP/DINO 共用 worker 时回收时机不稳定，修复后模型切换会等待旧 worker 实际退出。

评估器本身也改为有界结构：F32 源超过 256 MiB 后使用隔离磁盘 spill，文件后备总量上限 4 GiB；F16 generation 不再完整扩成 F32 常驻数组，CLIP/DINO 解码窗口分别为 16/24 MiB。原始采样位于报告所列 `samples/*.jsonl`，不含命令行、绝对路径或工作目录。

由于三轮最低系统空闲内存低于正式环境的 4 GiB 门槛，本报告只接受质量、源只读和验收进程 2 GiB 上限，不冒充固定硬件首次建库控制线。

## NekoSearch 与 scope

NekoSearch 对 383,840 条 CLIP、266,001 个 active 素材、4 个反馈中心执行三轮 exact/ANN 比较：

- Top-1 与 Top-50 三轮完全一致，Top-100 最小重合 0.99；共同结果分数最大误差为 0。
- Precision@20、Recall@50、nDCG@20 与 reject intrusion 均零下降，active scope 违规为 0。
- exact/ANN P95 为 4223.79/2407.38 ms，改善 43%。
- 权威向量、路径、资产和人工标注前后抽样哈希完全一致，派生索引仅存在于隔离临时目录。

主体、反馈和语义 scope 的确定性边界另由 `semantic-search-scope`、`rerank-cascade` 与 ANN worker 专项回归覆盖；本轮没有更改默认召回比例、排序、阈值或产品搜索行为。

复现：

```powershell
npm.cmd run benchmark:memory:quality-gate -- --output-dir=artifacts/benchmark/runtime-memory/quality-gate-final2
npm.cmd run benchmark:neko-search:prep008
```
