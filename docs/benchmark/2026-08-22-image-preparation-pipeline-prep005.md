# PREP-005 图片准备增量流水线验证

> 状态：当前  
> 更新日期：2026-08-22  
> 范围：Image Search Native 扫描、DINO/CLIP 补建、向量索引提交与简单模式准备入口  
> 对应任务：`PREP-005`  
> Git 基线：`e51fd1f462266c3ecf59d92f03494c8f67ab74f1`；共享工作区有未提交改动  
> 替代文档：无

## 结论

图片“准备素材库”已从 renderer 串行执行“扫描 → DINO → CLIP → 索引”改为主进程持久准备任务：模型准备与 Native 扫描同时开始，Native 只把已经提交到权威目录的路径交给有界 DINO 流；扫描结束后再对最终 active set 执行 DINO/CLIP 精确覆盖、revision 栅栏和向量索引提交。任何流式分块都不会提前宣告素材库 ready。

固定 16 张只读图片、GPU、2 worker、batch 4 的三轮交错 A/B 中，串行 ready P50/P95 为 `9,591.02/9,603.27 ms`，重叠流水线为 `8,099.36/8,127.40 ms`，P50 改善 `15.55%`，超过 10% 启用门槛。三轮的 Native、DINO、CLIP 和索引数量均为 16；DINO/CLIP 最低余弦为 `1`、最大绝对误差为 `0`、平均 Top-10 重合为 `1`。温更新二次运行没有新增提交、失效或重复推理，源文件和真实用户库均未写入。

同日补充的 [PxHere 1000 张阶段诊断](2026-08-22-pxhere-1000-image-preparation-diagnostic.md) 将相同条件扩展到 2.45 GiB 真实语料。三轮串行/重叠 ready P50 为 `272.451/225.924 s`，改善 `17.08%`；全程逐秒仪表化没有发现扫描、DINO 或 CLIP 中途停顿，证明 16 张门禁收益在该语料规模上仍成立。

## 实现边界

1. `native/fast_scanner.cc` 增加默认关闭的 committed-path feed。只有路径映射和 Native 索引提交成功后才入队；队列同时受 4,096 条和 8 MiB 限制，每次最多排出 256 条。溢出计数可观测，最终全量覆盖会修复任何漏掉的通知，feed 本身不是权威数据源。
2. `electron/imagePreparationPipeline.ts` 同时启动模型准备与扫描，只对已提交且发生变化的图片批量失效旧向量。DINO 路径先缓冲到真实 batch，再使用最多 2 个受现有 provider/显存策略约束的 worker 流式构建，避免把扫描逐条提交放大为 singleton 推理。
3. 流结束后重新读取最终权威 active set，分别执行 DINO 和 CLIP 精确覆盖。只有扫描已持久化、两模型覆盖完整、active-set revision 未变化且最终 DINO 向量索引提交成功，任务才进入 `done`。
4. `electron/embeddingStreamController.ts` 的追加路径支持替换已知项，配合 `vectorDatabaseService` 有界批量失效，确保同一路径内容变化后不会被流内去重错误跳过。
5. 主进程保存任务状态并通过 IPC 推送进度；Image Search 面板隐藏或 renderer 重建后可重新获取进行中任务。Native 缩略图仍在 ready 后后台补全，不进入搜索可用关键路径。
6. 停止入口登记并调用该准备任务自己的扫描、下载和 Embedding 取消句柄，不直接停止后续由其他窗口创建的全局任务。异常、取消和正常结束都会关闭流、关闭 feed 并清除任务句柄。

协议按职责拆为 `shared/ipc/image-preparation.ts`，避免把 preload 合同继续膨胀。主进程可达构建图由 281 增至 283，恰好对应图片准备协调器与独立 IPC 合同；架构预算同步锁定为 283，既有热文件行数上限未放宽。

没有修改模型、向量维度、F16/F32 持久格式、Native 索引格式、ANN 语义、扫描范围、缩略图参数或用户源文件。

## 正确性、恢复与安全

| 门禁                | 结果                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| committed 边界      | 通过：Native 行为测试只返回成功提交的 2 条路径；feed 关闭时不产生记录                              |
| 最终覆盖            | 通过：三轮均为 16 Native、16 DINO、16 CLIP、16 索引；中间分块不改变 ready                          |
| generation/revision | 通过：最终 active set 变化会拒绝 ready；向量索引不会在旧 revision 上提交                           |
| feed 溢出恢复       | 通过：drop 数保持可观测，最终精确覆盖会补建未收到通知的路径                                        |
| 温更新              | 通过：二次运行 committed/invalidated 均为 0，DINO/CLIP completed 与 failed 均为 0，skipped 均为 16 |
| 取消与停止          | 通过：只停止该流水线拥有的扫描与 Embedding；取消句柄在任务结束时清空                               |
| 向量与邻居          | 通过：三轮两模型最低余弦 1、最大绝对误差 0、单位范数误差不高于 `6.67e-16`、Top-10 重合 1           |
| UI 恢复             | 通过：renderer 从主进程快照恢复四阶段进度；极快终态不会被迟到的启动响应重复处理                    |
| 用户数据            | 通过：每轮独立 `userData`；源快照运行前后相同；`realLibraryWritten=false`                          |

进程崩溃后不会伪造原任务仍在运行；用户重试时复用已持久化 Native/向量结果并由最终覆盖补齐缺项。也就是说，恢复语义是可重复、可校验的幂等重跑，而不是依赖 renderer 内存继续旧 Promise。

## 固定 A/B 条件

| 项目      | 值                                                                                     |
| --------- | -------------------------------------------------------------------------------------- |
| 语料      | `D:\PxHereDataset\images\pxhere-000000` 中按固定顺序选取 16 张图片；运行期间只读       |
| Embedding | GPU、2 worker、batch 4；两组使用同一 provider、模型和向量验证器                        |
| 次数      | 3 个成对轮次，奇偶轮交替串行/重叠顺序；P95 为 nearest-rank                             |
| 温更新    | 每个重叠冷运行后在同一隔离库再运行一次，强制验证零重复推理                             |
| 隔离      | 每个子进程独立临时 `APPDATA`/`userData`；样本复制到隔离目录，报告使用去标识相对路径 ID |

## 三轮性能与资源

| 指标               |          串行 P50 / P95 |          重叠 P50 / P95 | 变化或判断                                  |
| ------------------ | ----------------------: | ----------------------: | ------------------------------------------- |
| 工作流 ready       |  9,591.02 / 9,603.27 ms |  8,099.36 / 8,127.40 ms | P50 改善 15.55%                             |
| Native 扫描        |  1,691.36 / 1,718.87 ms |  1,931.69 / 1,941.31 ms | +14.21%，属于主动与 DINO 重叠的阶段         |
| hash/index 保存    |        19.00 / 22.42 ms |        23.54 / 30.49 ms | P50 增加 4.54 ms，低于绝对噪声下限          |
| 向量索引提交       |          5.64 / 6.83 ms |          4.02 / 4.63 ms | P50 改善 28.72%                             |
| 最终验证           |        18.23 / 19.18 ms |        12.25 / 14.23 ms | P50 改善 32.80%                             |
| 主进程峰值 RSS     |     736.71 / 737.33 MiB |     743.44 / 762.26 MiB | P50 +0.91%；P95 +24.93 MiB，预算内          |
| 子进程合计峰值 RSS | 2,324.25 / 2,343.81 MiB | 2,203.54 / 2,402.00 MiB | P50 -5.19%；P95 +58.19 MiB，预算内          |
| GPU 绝对峰值       |       1,243 / 1,293 MiB |       1,244 / 1,244 MiB | P95 下降 49 MiB；占 4,096 MiB 的 30.37%     |
| 子进程峰值活动数   |                   3 / 3 |                   3 / 3 | 未增加；重叠报告另含温更新校验的 2 次短启动 |

扫描耗时上升来自刻意让扫描与 DINO 争用一部分 CPU/I/O，是参与流水线的阶段；端到端仍稳定超过 10% 门槛。向量索引与最终验证没有回退，显存峰值未增加，前台可搜索信号也没有等待后台缩略图排空。

## 迭代记录

1. 最初把 DINO 重叠并发限制为 1，三轮串行/重叠 P50 为 `9,482.05/9,772.44 ms`，回退 `3.06%`，未启用。
2. 将受控上限恢复为 2 后，逐条 committed 通知仍触发 singleton 推理，三轮 P50 为 `9,424.90/9,128.96 ms`，只改善 `3.14%`，仍未达到门槛。该失败报告保留在 `artifacts/benchmark/image-preparation-pipeline/2026-08-22_06-45-34-692/`。
3. 最终增加 batch 4 路径缓冲，只有完整批次或扫描尾部才派发。三轮 P50 改善达到 `15.55%`，且 DINO/CLIP 摘要与串行基线完全一致。通过报告位于 `artifacts/benchmark/image-preparation-pipeline/2026-08-22_06-49-33-714/`。

诊断结果没有删除；并发 1 的单轮材料保留在 `artifacts/benchmark/image-preparation-pipeline/diagnostic-concurrency-1/`。这些结果说明收益来自“有界重叠 + 保持真实 batch”，不是无上限提高并发。

## 验证入口

```powershell
npm.cmd run benchmark:image-search:preparation:ab -- --runs=3 --sample=16 --backend=gpu --jobs=2 --batch-size=4
node --test tests/image-preparation-pipeline.test.cjs tests/search-setup-workflow.test.cjs tests/native-scan.test.cjs
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

最新通过报告指针位于 `artifacts/benchmark/image-preparation-pipeline/latest.json`；当前 1000 张三轮完整报告位于 `artifacts/benchmark/image-preparation-pipeline/2026-08-22_09-31-27-503/`。原始 JSON、逐轮 NDJSON 时间线、阶段间隔分析和去标识向量比较由 runner 生成且不作为产品运行时输入，长期结论以本文及 1000 张阶段诊断为准。

## 剩余风险与下一步

1. 当前已覆盖固定 16 图门禁和 1000 图、2.45 GiB 真实语料；更大规模、机械盘和不同 GPU 现场仍应继续观察 feed drop、磁盘争用与长时间内存趋势，最终精确覆盖会保持正确性。
2. GPU 数据来自全设备 `nvidia-smi`，不是单进程归因；因此同时保留 worker 上限、绝对峰值、串行对照和设备占比。
3. `PREP-004` 仍等待 CUDA 分发许可证批准；本项没有改变许可状态。`PREP-006` 只有在解码剖析达到 10% 触发线时才实施，下一项无需批准的自动任务是 `PREP-007` 查询候选优化。
