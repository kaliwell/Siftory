# PxHere 1000 张图片准备速度与阶段间隔诊断

> 状态：通过  
> 日期：2026-08-22  
> 范围：Image Search Native 扫描、DINO、CLIP、向量索引、温启动校验与后台缩略图  
> 语料：`pxhere-000000`，1000 张受支持图片，2,627,418,359 bytes（约 2.45 GiB）  
> 环境：Windows 10.0.22631、i7-12700H、16 GiB RAM、4 GiB NVIDIA GPU、Node 24.16.0

## 结论

固定 GPU、2 个 embedding worker、batch 4 的三轮交错 A/B 全部通过。串行 ready P50/P95 为 `272.451/274.676 s`，扫描与 DINO 重叠后的 ready P50/P95 为 `225.924/227.986 s`，P50 改善 `17.08%`，每一对运行分别改善 `17.75%`、`17.42%`、`15.87%`。

额外执行的一轮 1000 张全程仪表化重叠测试在 `225.147 s` ready，与三轮区间一致。扫描、DINO、CLIP 的完整进度序列均未检测到中途停顿；较长间隔只出现在模型首批启动。当前真正的耗时来自三个持续工作阶段，不是阶段交接空等或随机挂起。

| 指标               |      串行 P50 |      重叠 P50 | 判断                               |
| ------------------ | ------------: | ------------: | ---------------------------------- |
| 搜索可用 ready     |     272.451 s |     225.924 s | 改善 17.08%                        |
| Native 扫描        |      89.552 s |     131.995 s | 与 DINO 争用 CPU/I/O 后变慢 47.39% |
| DINO 推理与持久化  |      90.975 s |     132.126 s | 与扫描重叠，二者关键路径约 133 s   |
| CLIP 推理与持久化  |      90.360 s |      92.001 s | 仍是 DINO 后约 91–92 s 的串行尾部  |
| 向量索引提交       |       0.176 s |       0.176 s | 可忽略，不是瓶颈                   |
| ready 未归因开销   | 0.680–1.117 s | 0.735–1.019 s | 没有明显阶段空洞                   |
| ready 后后台缩略图 |     约 99.3 s |     约 99.3 s | 不阻塞搜索可用信号                 |

## 进度间隔诊断

全程仪表化重叠运行使用约 1 秒目标采样间隔；分析器把最大进度间隔区分为 `startup`、`mid-run` 和 `tail`，并使用采样频率自适应阈值，避免把采样本身或首次模型加载误报为卡顿。

| 阶段        | 样本 | 采样间隔 P95 | 进度变化最大间隔 | 位置            | 中途停顿 |
| ----------- | ---: | -----------: | ---------------: | --------------- | -------: |
| Native 扫描 |  131 |      1.035 s |          1.056 s | mid-run         |        0 |
| DINO        |  112 |      1.527 s |          2.516 s | startup，0 → 8  |        0 |
| CLIP        |   72 |      1.661 s |          4.593 s | startup，0 → 12 |        0 |

扫描全程保持 3 个 worker，逐步从 0 增长到 1000；DINO 在扫描提交路径到达后持续消费，稳定阶段约 `7.5–7.8 image/s`；CLIP 稳定阶段约 `10.8–10.9 image/s`。三轮内容摘要一致，instrumented 运行的稳定 DINO/CLIP 摘要也与 A/B 相同。

## 慢点归因

1. `D:` 卷的 USN 快速路径返回 `volume-access-denied`，Native 扫描回退为目录枚举。串行三轮的枚举墙钟时间约 `79.653–84.516 s`；解码和 hash 为多 worker 累计 CPU 时间，不能与墙钟时间直接相加，但证明主要工作发生在枚举、图片解码和指纹计算内。
2. 重叠模式把原本约 180 秒的“扫描 + DINO”串行段压缩为约 133 秒关键路径；代价是两者因 CPU、内存和磁盘争用分别变慢，但净收益稳定超过 15%。
3. CLIP 只能在完整 DINO 覆盖后执行，仍贡献约 91–92 秒尾部，是下一轮最有价值的优化目标。不能在不改变 ready 正确性语义的情况下直接提前宣告完成。
4. 向量索引、manifest 保存和阶段交接都低于秒级，不值得优先优化。
5. 后台缩略图约 99 秒，但 ready 已经发出；它影响“全部后台工作结束”，不影响首次搜索可用时间。

## 日志与可复现性

基准 runner 现在为每轮自动生成：

- 原始去标识 JSON：完整阶段时间、正确性、安全门禁和逐秒计数。
- `*.timeline.ndjson`：边运行边落盘的阶段开始/结束、pipeline 里程碑、队列、worker、吞吐、主进程 RSS 与系统空闲内存；异常或超时后仍可查看已写事件。
- `stage-analysis.json` / `stage-analysis.md`：阶段对比、采样频率、最大变化间隔、间隔位置、疑似中途停顿和资源采样状态。
- 时间线不记录源目录、完整路径或文件名。

重叠 DINO 的日志订阅已从“收尾阶段订阅”改为整个 pipeline 生命周期独立订阅；主运行采样与后续 warm verification 分离。16 张仪表化冒烟测试验证 DINO 从 0 到完成均可见，时间线 50 个事件中未发现源路径或文件名。

长达 326 秒的资源 sidecar 在结束时未产出汇总，因此本轮 1000 张测试不把 child RSS/GPU 缺失值解释为 0。根因边界位于外部 `nvidia-smi` 可能长时间阻塞；采样器已增加 2 秒进程超时和 `failureCode`。修复后的 12 秒验证得到 90 个样本、0 错误；4 张 GPU pipeline 收尾验证得到 40 个样本、0 错误、完整 child/GPU 指标，但尚未用修复版重新执行完整 1000 张资源曲线。阶段时间线和主进程 RSS 不受该 sidecar 缺口影响。

## 正确性与安全

- 三轮 serial/overlap 的 Native、DINO、CLIP、向量索引均为 1000 条。
- 三对 DINO/CLIP 最低 cosine 为 1、最大绝对误差为 0、Top-10 重合为 1。
- warm verification 为 0 新提交、0 失效、0 重复推理；commit-feed dropped 为 0。
- 测试使用隔离 `userData`，没有写入真实素材库。
- 源图片运行前后快照一致；测试没有改写 `D:\PxHereDataset\images\pxhere-000000`。

## 产物与命令

完整产物目录：`artifacts/benchmark/image-preparation-pipeline/2026-08-22_09-31-27-503/`。

```powershell
npm.cmd run benchmark:image-search:preparation:ab -- --dataset="D:\PxHereDataset\images\pxhere-000000" --sample=1000 --runs=3 --backend=gpu --jobs=2 --batch-size=4 --timeout-ms=1800000
npm.cmd run benchmark:image-search:preparation:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22_09-31-27-503"
```

后续运行会在 A/B 完成后自动调用阶段分析器，无需再手工生成明细报告。

下一轮实施优先级、量化门禁和回滚条件见[PxHere 1000 张图片准备速度优化方案](../current/2026-08-22-image-preparation-speed-optimization-plan.md)。
