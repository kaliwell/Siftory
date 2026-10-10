# RMO-032 DINO 融合预处理影子验证

> 日期：2026-08-29  
> 状态：边界张量阶段通过，候选仍默认关闭

## 已完成

- 主进程下发的 DINO 任务继续包含模型 manifest 的 `inputSize`。
- 将当前 DINO 全尺寸 Sharp 解码抽成独立、可测试的基线路径；生产 child 默认仍调用该基线，行为未变。
- 新增默认不接入生产的候选：在同一 Sharp graph 内完成 EXIF 旋转、白底 Alpha 合成、sRGB 三通道归一化和 shortest-edge=256 双三次缩放，再交给原 processor 做中心裁剪与归一化。
- 使用已安装的本地 DINO processor 对 EXIF orientation=6 JPEG、RGBA PNG、灰度 PNG、可恢复截断 JPEG 做输入张量逐值比较，全部零差异。
- 10 万/50 万条 DINO 768 维视频帧流式 Top-K 规模验证已通过，但这是向量存储/评分证据，不替代融合候选的真实模型三轮验证。
- 基线与候选均拒绝超像素上限的合成输入。

## 防误启用

候选只允许由显式诊断开关调用；`dinoEmbeddingChild.ts` 未设置开关时固定使用 `readDinoImage` 基线。源码守卫同时检查开关必须严格等于字符串 `1`、候选必须位于条件分支、不得硬编码启用。只有固定 1000 图连续三轮的向量、Top-K、Library Ready P95、整树 Private Bytes、GPU/VRAM 和源只读门禁全部通过，才允许讨论启用。

## 专项验证

```powershell
node --test tests/dino-image-decode.test.cjs tests/clip-image-decode.test.cjs
```

本轮 10/10 通过（DINO 2 项、CLIP 8 项）。如果本机未安装 DINO processor，DINO 张量测试会明确 skip，不能将 skip 当成正式通过。

## 端到端影子入口与冒烟

新增显式诊断开关 `REASONIX_DINO_FUSED_SHADOW=1`，普通产品启动、普通建库和基准均保持关闭。E2E 工具只在传入 `--dino-fused-shadow=1` 时为该次隔离子进程设置开关，并在 finally 恢复原环境。

固定 16 张 PxHere、DirectML、overlap、jobs 2、batch 4 的基线/候选冒烟结果：

| 指标 | 基线 | 候选 |
| --- | ---: | ---: |
| Library Ready | 14,815.01 ms | 11,557.11 ms |
| DINO 全向量 SHA-256 | `5ee6622c…1105a` | `5ee6622c…1105a` |
| CLIP 全向量 SHA-256 | `da8adb0d…da03d` | `da8adb0d…da03d` |
| Native 扫描 SHA-256 | `a7db11f6…19d1d` | `a7db11f6…19d1d` |
| 索引数量 | 16 | 16 |
| provider fallback | 无 | 无 |
| 源文件变化/残留 child | 无/无 | 无/无 |

冒烟证明候选已贯通“扫描→DINO→CLIP→持久化→索引→Library Ready”，且完整向量逐字节摘要一致；它不替代 1000 图三轮。

## 1000 图自动矩阵

新增 `dino-fused-shadow` 正式场景，固定执行 `AB / BA / AB` 六次 1000 图隔离建库。三次配对轮各自先完成 10 分钟正式预检并绑定同一份不可变 accepted GPU 基线；总入口不会再用一次外层预检代替三个真实起点。矩阵强制检查：

- Native、DINO、CLIP 完整摘要在六次运行中一致，DINO 摘要因此同时约束向量与确定性 Top-K。
- DirectML 无 fallback，索引数量为 1000，候选 Library Ready P95 不回退 5%。
- 候选 child RSS 峰值不高于基线最差值 64 MiB 以上。
- 所有运行使用隔离 userData，源快照不变，退出时没有 benchmark child。

矩阵汇总器同时读取 E2E 控制台摘要和实际落盘的公开报告结构：扫描摘要取自 `scan.digest`、索引数量取自 `vectorIndex.status`、模型摘要优先取自 `embeddingDigests`。真实 16 图报告回放已确认不会将顶层 DINO 诊断对象误当向量摘要，也不会把性能失败误写成源数据安全失败。

本次预检只有 `3,425,796,096 B`（约 3.19 GiB）空闲内存，低于 4 GiB 安全门槛，因此机器报告为 `incomplete`，没有启动六次重负载：

历史诊断证据位于 `artifacts/benchmark/runtime-memory/dino-fused-shadow/matrix/report.json`；新正式入口为每次执行创建独立 run-id 目录，不复用或覆盖旧报告。

复现：

```powershell
npm.cmd run benchmark:memory -- --formal --scenario=dino-fused-shadow --runs=1 --dataset=D:\PxHereDataset\images\pxhere-000000
```

独立的 `benchmark:memory:dino-fused-shadow` 保留为默认关闭候选的短诊断入口；未显式传入 `--formal` 时不会产生可接受的正式矩阵证据。

## 工程回归

2026-08-29 在候选默认关闭状态完成 `npm.cmd run verify`，TypeScript、Lint、格式、全部产品/媒体/向量测试、Native 重编译、74 项 Native 测试（含 28 例确定性图片 fuzz）和 checked renderer/Electron build 均通过。Lint 保留 3 条既有未使用函数 warning，无 error。
