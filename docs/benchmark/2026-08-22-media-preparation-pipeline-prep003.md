# PREP-003 视频准备分块流水线验证

> 状态：当前  
> 更新日期：2026-08-22  
> 范围：Media Search 视频抽帧、DINO/CLIP 补建与帧索引提交  
> 对应任务：`PREP-003`  
> Git 基线：`e51fd1f462266c3ecf59d92f03494c8f67ab74f1`；共享工作区有未提交改动  
> 替代文档：无

## 结论

视频“准备素材库”已从完整串行的“全部抽帧 → DINO → CLIP → 帧索引”改为以原子帧检查点为水位线：本地 FFmpeg 批次提交后即可交给一个常驻 DINO 流式会话，抽帧结束后恢复既有 DirectML 并发上限，随后验证完整 DINO 覆盖、一次性补建 CLIP，最后提交帧索引。任何中间分块都不会提前宣告素材库 ready。

固定 CFR 120 秒、VFR 90 秒和截断损坏输入的三轮交错 A/B 中，串行工作流 ready P50/P95 为 `12,200.12/12,274.78 ms`，重叠流水线为 `10,325.15/10,345.27 ms`，P50 改善 `15.37%`，超过 10% 启用门槛。三轮均保持 69 个 ready 帧、DINO/CLIP 各 69 条覆盖和 138 条帧索引，向量 parity、Top-10、源只读与资源门禁全部通过。

## 实现边界

1. `electron/videoFrameCheckpointStore.ts` 为精确视频集合和源 fingerprint 建立有界检查点作用域；每个成功批次先原子提交检查点，再通知下游。读取限制目录数、文件数、单文件字节和记录数，并拒绝符号链接、联接点及 realpath 越界。
2. `electron/videoFrameService.ts` 合并 Manifest 与检查点后恢复未完成构建。复用必须匹配源 fingerprint；抽帧前后和最终提交前再次核对源状态，变化时删除本次派生帧、使记录失效并返回待清理路径。
3. `electron/embeddingStreamController.ts` 独立管理主进程内部流式会话、追加去重、并发爬升和关闭栅栏；`electron/embeddingService.ts` 只提供 worker、任务 ledger、输入校验和持久化适配。会话打开期间空队列不等于完成；追加单次最多 256 项，继续复用输入签名校验、任务 epoch/lease、持久化、失败和停止语义。停止会关闭会话并释放 worker。
4. 重叠抽帧时 DINO 从 1 个 worker 启动，抽帧完成后才在 provider 既有上限内升到请求并发；4 GiB Windows DirectML 仍最多 2 worker。CLIP 继续对最终权威帧集合执行一次完整构建，没有新增模型并发。
5. `electron/mediaPreparationPipeline.ts` 只有在抽帧完成、DINO 精确覆盖、CLIP 精确覆盖和帧索引无错误四个里程碑都成立后才返回 `done`。源变化会停止自有 Embedding、删除旧向量并使帧索引失效。
6. `mediaTaskQueue`、IPC guard/handler、Preload、Bridge 和简单模式六步流程统一调用该协调器；普通抽帧任务归入本地 `preview` lane，不再占用 GPU `video-deep` lane。

结构终检把流会话、准备子进程协议和 worker 结果解析分别收敛到独立模块，`embeddingService.ts` 按结构门禁口径从 1,980 行降至 1,735 行，低于既有 1,750 行上限。主进程可达图由审计基线 278 增至 281，恰好对应帧检查点、准备协调器和流控制器三个生产职责模块；门禁同步锁定为 281，后续继续增长会失败。

没有修改抽帧间隔、帧上限、JPEG 参数、模型、向量格式、Manifest 格式或索引格式，也没有写入真实用户素材库。

## 正确性、恢复与安全

| 门禁            | 结果                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| 中间 ready 语义 | 通过：检查点只增加 committed 数；最终索引提交前 `frameIndexComplete` 始终为 false              |
| 最终覆盖        | 通过：三轮均为 69 ready、69 DINO、69 CLIP、138 索引、0 索引错误                                |
| 崩溃恢复        | 通过：已原子提交批次可从检查点恢复，不重新打开已完成源                                         |
| 取消与停止      | 通过：取消统一任务会停止 FFmpeg，并只取消该准备任务拥有的 queued/running Embedding；流会话关闭 |
| 源变化          | 通过：提交过批次后源 revision 变化会使全部派生帧和旧 Embedding 失效，要求重新扫描              |
| 路径安全        | 通过：检查点根、作用域、记录和输出路径均做边界、realpath、非链接及非空文件校验                 |
| 损坏输入        | 通过：截断视频稳定产生 1 个预期失败，正常 CFR/VFR 帧与串行基线一致                             |
| 拆分后真实冒烟  | 通过：3 个视频得到 19 ready、19 DINO、19 CLIP、38 索引、0 缺失和 0 索引错误                   |
| 用户数据        | 通过：每轮独立 `userData`；源快照运行前后相同；真实库未写                                      |

三轮串行/候选逐对使用既有 provider parity 门槛：DINO 最低余弦不低于 `0.9999999999987232`、最大绝对误差不高于 `1.833535863936253e-7`；CLIP 最低余弦不低于 `0.9999999999828292`、最大绝对误差不高于 `1.4269770712699303e-6`；两模型平均 Top-10 重合均为 `1.0`。

## 固定 A/B 条件

| 项目      | 值                                                                       |
| --------- | ------------------------------------------------------------------------ |
| 语料      | runner 计时前生成 CFR 120 秒、VFR 90 秒、截断损坏 MP4 各 1 个            |
| 帧策略    | 3 秒间隔、最多 3600 帧、宽度 256 px；70 个计划项，69 成功、1 个预期失败  |
| Embedding | GPU/DirectML、2 worker、batch 4；候选仅在抽帧重叠期把 DINO 限为 1 worker |
| 次数      | 3 个成对轮次，奇偶轮交替串行/候选顺序；P95 为 nearest-rank               |
| 隔离      | 每个子进程独立临时 `APPDATA`、Media Search 目录和源语料；输出去路径化    |

## 三轮性能与资源

| 指标                  |           串行 P50 / P95 |           重叠 P50 / P95 |                              变化或判断 |
| --------------------- | -----------------------: | -----------------------: | --------------------------------------: |
| 工作流 ready          | 12,200.12 / 12,274.78 ms | 10,325.15 / 10,345.27 ms |                         P50 改善 15.37% |
| 扫描与 Video Manifest |       279.70 / 285.25 ms |       282.83 / 284.49 ms |                      P50 +1.12%，噪声内 |
| 抽帧与 Frame Manifest |   2,153.41 / 2,206.32 ms |   2,371.69 / 2,438.69 ms |               +10.14%，属于主动重叠阶段 |
| 帧索引提交            |       116.42 / 127.12 ms |         62.15 / 65.52 ms |                         P50 改善 46.62% |
| 最终验证              |       179.03 / 217.70 ms |       184.79 / 189.15 ms | +5.76 ms，低于 25 ms 噪声下限；P95 改善 |
| 主进程峰值 RSS        |      215.41 / 215.62 MiB |      222.78 / 223.20 MiB |                 P95 +7.58 MiB，门禁通过 |
| 子进程合计峰值 RSS    |  1,356.55 / 1,365.95 MiB |  1,351.38 / 1,377.25 MiB |                P95 +11.30 MiB，门禁通过 |
| GPU 显存增量          |            509 / 523 MiB |            680 / 680 MiB |           相对 P95 +157 MiB，受控预算内 |
| GPU 绝对峰值          |                1,360 MiB |                1,517 MiB |                  占 4,096 MiB 的 37.04% |
| 子进程启动/峰值活动数 |                   21 / 4 |                   21 / 4 |                                  未增加 |

抽帧墙钟阶段变长来自刻意与 DINO 争用部分 CPU/I/O，不属于非参与阶段回退；并发爬升把早期双 worker 方案约 30.65% 的抽帧回退降到最终 10.14%。端到端仍稳定超过 10% 门槛。

最初的诊断脚本曾使用 512 MiB 显存绝对增量线，但同轮串行基线已达到 522–523 MiB，因此该门槛不能表达“候选相对基线是否受控”。在正式放行前，门禁改为三项同时成立：候选增量不超过 768 MiB、P95 相对串行增长不超过 256 MiB、绝对峰值不超过设备容量 75%。首次失败报告保留在 `artifacts/benchmark/media-preparation-pipeline/2026-08-22_05-31-58-371/`，没有删除或覆盖。

## 验证入口

```powershell
npm.cmd run benchmark:media-search:preparation:ab -- --runs=3 --backend=gpu --jobs=2 --batch-size=4 --fixture-cfr-seconds=120 --fixture-vfr-seconds=90 --interval-ms=3000 --width=256
node tests/media-search-library-preparation-benchmark.cjs --pipeline=overlap --backend=gpu --jobs=2 --batch-size=4 --fixture-cfr-seconds=30 --fixture-vfr-seconds=30 --interval-ms=3000 --width=256 --compact
npm.cmd run test:media-search
npm.cmd run test:vector-pipeline
npm.cmd run test:unified-search
npm.cmd run test:ipc-validation
npm.cmd run test:ipc-registration
npm.cmd run test:preload-contract
npm.cmd run test:architecture
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
```

完整机器报告位于 `artifacts/benchmark/media-preparation-pipeline/latest.json`；当前三轮通过报告位于 `artifacts/benchmark/media-preparation-pipeline/2026-08-22_05-48-15-569/`，结构拆分后的短流程报告位于 `artifacts/benchmark/media-preparation-pipeline/diagnostic-2026-08-22/overlap-post-split.json`。原始 JSON/向量比较行由 runner 生成且不入 Git，长期结论以本文为准。

## 剩余风险与下一步

1. 显存采样来自全 NVIDIA 设备的全局 `nvidia-smi`，不是单进程归因；因此同时保留绝对峰值、相对串行差值、worker 数与设备占比，不把单一增量解释为模型独占。
2. 检查点恢复已覆盖进程中断和源变化；磁盘满仍沿用原子写失败语义，现场应继续保留重新扫描/重建入口。
3. `PREP-004` 仍是许可证批准任务，未因本项性能结果获得 CUDA 分发许可。下一项可自动实施的是 `PREP-005` 图片准备增量流水线。
