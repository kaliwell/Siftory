# 运行内存正式环境预检

> 日期：2026-08-29  
> 窗口：600.581 秒 / 74 个样本  
> 结论：该历史窗口未通过；当时 GPU 静默失败且 accepted GPU 基线尚未接入。当前 accepted 基线已恢复，但该历史窗口仍不得追认

## 观测值

| 项目 | 观测 | 门禁 | 结果 |
| --- | ---: | ---: | --- |
| AC 供电 | 是 | 必须为是 | 通过 |
| CPU P95 | 4% | ≤20% | 通过 |
| 磁盘 P95 | 1% | ≤20% | 通过 |
| 可用物理内存 | 6,248,902,656 B（约 5.82 GiB） | ≥4 GiB | 通过 |
| Commit 比例 | 39.22% | ≤75% | 通过 |
| 残留产品进程 | 0 | 0 | 通过 |
| GPU P95 | 27% | ≤10% | **失败** |
| 已接受 GPU baseline | 当时未接入 | 正式比较需要 | **历史窗口不完整** |

正式 1000 图三轮、GPU 生命周期、10k 缩略图矩阵、2 小时混合长稳和新控制线接受均不得使用本窗口。没有关闭桌面程序、浏览器、QQ、ChatGPT 或 360，也没有通过提高阈值绕过失败。

再次验收时应先让桌面 GPU 保持空闲，然后原样执行：

```powershell
npm.cmd run benchmark:memory:preflight
```

只有返回 `evaluation.status=passed` 后，才启动正式三轮工作负载。

## 当前 accepted 基线与自动绑定

后续工具补强已从固定硬件不可变接受指针恢复 GPU 环境基线：三轮起始占用为 `1060/1060/1036 MiB`，正式比较值取 `1060 MiB`，GPU 总显存 `4096 MiB`，接受报告 SHA-256 为 `29a34b9300b0aa673bec55632735799ac5bab70eb93768b967723b166673bfe2`。解析过程会稳定重读接受报告和三轮原始报告，并校验路径、大小、摘要、硬件 identity 与不超过 `256 MiB` 的离散范围。

`benchmark:memory:preflight` 和 `benchmark:memory -- --formal` 均自动绑定该证明。正式模式下手填的 `--gpu-baseline-mib` 若与 accepted 值不同会直接拒绝；这避免任意数字绕过正式环境门禁。accepted 基线恢复不改变本页历史采样的失败结论，也不代替当前代码的 RMO-005 三轮内存基线。

## 后续短窗复核

正式预检后又以已观测显存 `494 MiB` 做了 62.091 秒诊断复核：CPU P95 `3%`、磁盘 P95 `1%`、可用物理内存约 `5.94 GiB`、残留产品进程 `0`，但 GPU P95 仍为 `26%`。Windows GPU Engine 采样显示主要活动来自 `dwm`（桌面合成器）和 `WindowsTerminal`，不是 Siftory 残留进程。这说明失败是持续桌面环境噪声，不是一次偶发尖峰；正式门禁仍不放宽，也不会自动关闭用户应用或 360。

## 正式入口失败关闭回放

补强后的正式入口实际运行了 `thumbnail-matrix,dino-fused-shadow`，但只执行预检：缩略图轮观测到 `805,707,776 B` 可用 RAM、GPU `1776 MiB`、GPU 利用率 `43%`；DINO 第一配对轮观测到 `704,524,288 B` 可用 RAM、Commit `75.24%`、GPU `1788 MiB`。两者均绑定 accepted `1060 MiB` 证明并返回 `incomplete`；DINO 报告明确为 `completedMatrixEntries=0`，没有启动六次建库。

对应报告位于：

- `artifacts/benchmark/runtime-memory/formal-gates-20260829-current/runtime-memory-2026-08-29T10-07-20-970Z.json`
- `artifacts/benchmark/runtime-memory/formal-dino-preflight-replay/runtime-memory-2026-08-29T10-08-34-158Z.json`

预检现在会对已经使整轮不可挽回的 AC、RAM、Commit 或残留产品进程失败记录 `quietWindow.earlyTermination` 并提前返回，避免无意义等待；成功环境以及仍可能恢复的 CPU/磁盘/GPU 静默条件仍要求完整 600,000 ms。该优化只缩短必败路径，不改变正式通过条件。
