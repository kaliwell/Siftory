# RMO-033 Embedding 实时资源治理验收

> 日期：2026-08-29  
> 结论：工程与策略门禁通过；固定 1000 图三轮性能矩阵仍归 RMO-036

## 生产链路

- 统一资源监视器每 5 秒采集 Electron 进程组、受管后代 Private Bytes、系统空闲 RAM 和可用时的真实 GPU VRAM。
- 压力原因使用进入 2 个样本、退出 3 个样本的迟滞；缺少平台指标时不伪造数值。
- 活跃 Embedding 建库把实时快照交给 `decideEmbeddingRuntimeResources`。Auto 模式可以调整 batch 和 worker；手动/default batch 保持用户原值。
- 内存或显存压力下，新工作收敛为 1 worker、batch 4。仅回收没有活动任务的 child；活动批次完成后再退出，待处理队列不清空。
- 高余量恢复后按 Provider 上限补回 worker 并继续派发；无效或非有限并发遥测安全收敛为 1 worker。

## 策略边界

| 快照 | 决策 | 结果 |
| --- | --- | --- |
| 16 GiB RAM，空闲 8 GiB；8 GiB VRAM，空闲 4 GiB | 2 worker / batch 16 | 高余量维持并行 |
| 16 GiB RAM，空闲 5 GiB；4 GiB VRAM，空闲 2.5 GiB | 2 worker / batch 8 | 中等余量不无故串行 |
| RAM 或 VRAM pressure | 1 worker / batch 4 | 有界降级 |
| 压力解除且恢复高余量 | 从 1 worker 回到 2 worker / batch 16 | 队列继续执行 |
| 并发遥测为 `NaN` | 1 worker | fail-closed |

2026-08-29 09:15 的本机只读快照为：总 RAM `16,781,979,648 B`、空闲 RAM `1,241,182,208 B`、总 VRAM `4,294,967,296 B`、空闲 VRAM `2,959,081,472 B`。生产策略返回 `limited-live-headroom`、1 worker、batch 4；没有为了长测关闭用户程序或放宽门槛。

历史固定 16 GiB 基线的主进程加子进程 RSS P95 为 `3,951.75 MiB`，低于 4 GiB 资源控制线；PREP-012 真实 DirectML 筛选也证明 jobs 2 / batch 4 比单 worker 快，而 batch 8/16 在余量不足时会被拒绝。当前实现 identity 的 1000 图 AB/BA/AB、综合峰值和 Library Ready P95 仍由 RMO-036 验收，不能用策略单测替代。

## 验证

```powershell
node --test tests/embedding-runtime-resource-policy.test.cjs tests/runtime-resource-pressure.test.cjs tests/image-preparation-pipeline.test.cjs
npm.cmd run typecheck
npm.cmd run verify
```

专项共 17 项通过，覆盖整树/VRAM 采样解析、迟滞、高中低余量、恢复、无效遥测、活动 worker 保护、队列不清空、流式背压、取消和最终覆盖。随后完整 `verify` 通过，包括向量流水线、真实模型、Native 重建/fuzz 和 checked build。
