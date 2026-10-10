# 1000 次固定搜索耐久诊断（RMO-050）

> 日期：2026-08-29  
> 结论：本场景通过；RMO-050 整体仍需正式 2 小时混合 soak 三轮  
> 原始报告：`artifacts/benchmark/runtime-memory/search-soak-1000-diagnostic/runtime-memory-2026-08-29T07-08-51-948Z.json`

## 场景与边界

- 同一搜索 worker 连续执行 1000 轮固定查询，每轮包含 8 个查询样本。
- 使用现有只读 F16 索引快照；测试前后校验源文件不变。
- 每 250 ms 采集一次 Windows 进程树内存，共 5740 个样本；同时记录 GPU 显存。
- 本轮是在正式环境预检 GPU P95 超标后执行的诊断，不冒充固定硬件正式三轮结果。

## 结果

| 指标 | 结果 |
| --- | ---: |
| 完成轮数 | 1000 / 1000 |
| 总时长 | 1,490,564 ms（约 24.84 分钟） |
| 搜索 P50 | 1,469.91 ms |
| 搜索 P95 | 1,526.33 ms |
| 结果摘要 | 1000 轮完全一致 |
| 整树 Private Bytes 峰值 | 1,815,838,720 B（约 1,731.72 MiB） |
| 整树 Private Bytes 终值 | 729,788,416 B（约 696.00 MiB） |
| 后 2/3 Private Bytes 斜率 | −88,485 B/分钟（约 −0.084 MiB/分钟） |
| 最低系统空闲内存 | 4,227,207,168 B（约 3.94 GiB） |
| GPU 显存增量峰值 | 87 MiB |
| 源文件只读校验 | 通过 |

## 判断

该场景没有发现随查询次数持续增长的进程树私有内存：终值显著低于峰值，后 2/3 窗口斜率为负，结果摘要稳定，源索引保持只读。因此，RMO-050 的“1000 次固定查询”子项具备通过证据。

RMO-050 仍保持 `进行中`，因为 600 次 UI 生命周期虽已有专项证据，正式环境下的 2 小时混合 soak 三轮和每周 8 小时诊断尚未全部完成；当前正式预检还受 GPU 静默条件阻塞。

复现：

```powershell
npm.cmd run benchmark:memory -- --scenario=search-soak --cycles=1000 --runs=1 --timeout-ms=1800000 --output-dir=artifacts/benchmark/runtime-memory/search-soak-1000-diagnostic
```
