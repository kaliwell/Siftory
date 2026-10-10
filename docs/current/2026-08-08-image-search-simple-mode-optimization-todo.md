# Image Search Simple 模式专项优化 TODO

> 状态：当前
> 更新日期：2026-08-17
> 范围：Image Search Simple 模式机器可读优化队列
> 替代文档：无

> 建立日期：2026-08-08
>
> 真实只读数据集：`D:\dataset\images\pxhere-000000`（1000 张 JPEG，2,627,418,359 bytes）
>
> 下一项：`npm.cmd run todo:image-search-simple-next`
>
> 结构校验：`npm.cmd run todo:image-search-simple-check`
>
> 扫描基准：`npm.cmd run benchmark:image-search-simple -- <dataset> --addon=<fast_scanner.node>`
>
> 推理基准：`npm.cmd run benchmark:image-search-simple-embeddings -- <dataset> --sample=64 --jobs=2 --batch-sizes=4,8,16`
>
> 端到端基准：`npm.cmd run benchmark:image-search-simple-e2e -- <dataset> --jobs=2 --batch-size=4 --backend=gpu --compact`
>
> Auto batch 验收：`npm.cmd run benchmark:image-search-simple-e2e -- <dataset> --jobs=2 --batch-size=0 --backend=gpu --defer-thumbnails --compact`

所有真实数据集测试只读取源图片；索引、缩略图缓存和测试输出使用临时目录并在结束后清理。

## 已测结果

### Native 扫描与缩略图

| 场景                                     |     时间 |        吞吐 | 关键结果                                       |
| ---------------------------------------- | -------: | ----------: | ---------------------------------------------- |
| 冷扫描，3 workers，不建缩略图            |  94.11 s |  10.63 张/s | 1000/1000，双哈希摘要一致                      |
| 冷扫描，3 workers，建缩略图              | 107.07 s |   9.34 张/s | 缩略图额外约 12.96 s                           |
| 冷扫描，4 workers，128 MiB JPEG 保留预算 |  82.28 s |  12.15 张/s | 可用内存充足时现有自适应策略自动升到 4 workers |
| 温更新                                   | 92.86 ms | 10,769 张/s | 1000 unchanged，零解码、零哈希                 |

在这个单层、2000 个目录项的数据集上，D 盘 USN 因权限回退到普通枚举不是主要瓶颈；冷扫描主要耗时是 JPEG 解码。首次 Simple 建库会等待缩略图队列排空，因而缩略图约 10–13 秒仍在关键路径上。

固定 128 MiB 与 256 MiB JPEG 保留预算的同条件 A/B：128 MiB 为 82.28 秒、峰值 RSS 增量 1073.63 MiB；256 MiB 为 82.61 秒、峰值 RSS 增量 1259.80 MiB。虽然源文件回读从 452 次降到 276 次，但速度没有提升且内存增加，因此不采用扩大默认预算。

低内存 3/4-worker 复核否决了放宽 4-worker 门槛。候选门槛测试的首轮 3-worker 扫描为 95.36 秒，过程中可用内存最低降至 1446 MiB；下一轮请求 4 workers 时安全上限已降为 2，说明该状态下强开 4 workers 会增加分页风险。恢复生产门槛后的独立复测从 2560/2455 MiB 可用内存启动，请求 3/4 均安全限制为 3 workers，耗时 95.92/97.42 秒、最低可用内存 1589/1859 MiB，1000 条双哈希摘要完全一致。结合高内存 4-worker 的既有 82.28 秒结果，结论是现有自适应门槛能在内存充足时提速，而低内存下不应释放第 4 个解码 worker；候选代码已撤销，仅保留只读诊断基准。

### DINO / CLIP DirectML 推理

64 张固定样本、双 worker、向量维度和有限数检查全部通过：

| 模型 / batch |       吞吐 | 双 worker 工作集 | 对 batch 4 数值一致性                 |
| ------------ | ---------: | ---------------: | ------------------------------------- |
| DINO / 4     | 10.33 张/s |      1017.60 MiB | 基线                                  |
| DINO / 16    | 12.44 张/s |      1694.35 MiB | cosine min=1，max abs diff=0          |
| CLIP / 4     |  8.84 张/s |      1169.19 MiB | 基线                                  |
| CLIP / 16    |  9.54 张/s |      2020.16 MiB | cosine min=1，max abs diff=0.00000371 |

单 worker、batch 4 为 DINO 7.03 张/s、CLIP 6.58 张/s；现有 Simple 默认双 worker 分别提升约 44.7% 和 27.5%。batch 16 有进一步收益，但额外工作集约 0.68–0.85 GiB；batch 8 复测收益约 1%，额外工作集约 0.5 GiB。因此固定提高默认 batch 不合适，应实现带内存/显存保护的显式 Auto 档。

Auto batch 已实现为显式 `0` 档位：每次模型启动时按模型、worker 数、实时可用 RAM，以及可获取时的 NVIDIA 实时显存，在 4/8/16 中选择；手动 1–16 保持原值，CPU/CUDA 未标定路径保守使用 4。低内存 1000 图验收时 DINO/CLIP 启动可用 RAM 分别为 3314/3498 MiB、显存 3272 MiB，均正确回退 batch 4；两模型摘要与固定基线完全一致，ANN 1000 条。高内存 16 档的数值一致性和速度收益沿用前述真实 64 图 A/B，策略边界另由 RAM/VRAM 单测覆盖。

### 1000 图端到端与关键路径优化

生产服务一致的隔离基准连续两轮完成 1000/1000 Native 索引、1000 DINO、1000 CLIP 和 1000 条 DINO ANN，源数据只读且两次向量摘要稳定。基线总库就绪时间为 262.06 秒：Native 扫描与缩略图 82.80 秒、DINO 88.79 秒、CLIP 88.77 秒、两次准备合计 0.40 秒、ANN 0.13 秒。

Simple 扫描改为不在关键路径生成缩略图，向量库与 ANN 就绪后再启动 Native 后台补全。优化后库就绪约 243.21 秒，提前约 18.85 秒（7.2%）；后台缩略图最终 1000/1000、零失败。两次准备仅占总时间约 0.15%，因此准备结果复用从高价值自动项降为大规模递归目录触发项。

完整测试同时发现并修复 DINO 正常终止事件误伤下一次 CLIP 准备的生命周期竞态；连续多轮 DINO → CLIP 构建均未再出现 `SIGTERM` 中断。

## 机器可读任务表

| Rank | ID      | Value | Mode        | Dependencies | Status   | Validation                                                     | Task                                                                                   |
| ---: | ------- | ----: | ----------- | ------------ | -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
|    1 | SMP-001 |   100 | auto        | -            | verified | real scan digest + embedding dimensions + lint                 | 建立真实只读扫描基准、DINO/CLIP 多 worker/多 batch 基准和质量/工作集报告               |
|    2 | SMP-009 |    99 | auto        | SMP-001      | verified | sequential DINO/CLIP lifecycle regression + repeated real E2E  | 忽略已移出 active set 的陈旧 worker exit 事件，防止 DINO 正常终止误停下一次 CLIP 准备  |
|    3 | SMP-002 |    98 | auto        | SMP-001      | verified | isolated 1000-image end-to-end report + phase totals           | 建立完整 Simple 临时向量库基准，记录扫描、缩略图、两次准备、DINO、CLIP、ANN 各阶段时间 |
|    4 | SMP-003 |    95 | auto        | SMP-002      | verified | library ready -18.85s + thumbnails eventually 1000/1000        | 让 Native thumbs 退出首次 Simple 建库关键路径，在向量库就绪后低优先级补齐缩略图        |
|    5 | SMP-005 |    91 | auto        | SMP-002      | verified | exact 1000-image digests + ANN parity + RAM/VRAM guard tests   | 增加显式 Auto batch：按实时可用内存、显存、worker 数和模型选择 4/8/16，保留用户手动值  |
|    6 | SMP-006 |    84 | auto        | SMP-002      | verified | low-memory guard engaged; unsafe threshold relaxation rejected | 重新标定 Native 扫描 4-worker 内存门槛；只在无分页压力时释放低内存状态下的解码吞吐     |
|    7 | SMP-007 |    60 | observation | SMP-001      | verified | matched 128/256 MiB A/B                                        | 拒绝扩大缩略图 JPEG 默认保留预算：无速度收益且峰值内存增加                             |
|    8 | SMP-004 |    20 | triggered   | SMP-002      | deferred | preparation >=3% of E2E + accepted input parity                | 仅当大规模递归目录让两次准备达到总耗时 3% 时复用目录枚举、预览映射和输入验证结果       |
|    9 | SMP-008 |    15 | triggered   | SMP-002      | deferred | elevated USN/enum parity on large recursive tree               | 仅在大规模递归目录出现枚举瓶颈时测试管理员 USN；当前平面数据集温更新已为 92.86 ms      |

## 自动推进规则

1. 自动选择只领取 `Mode=auto`、状态为 `pending` / `in_progress`、依赖均为 `verified` 的最高 Value 项。
2. 每项先在独立分支标为 `in_progress`，实现后标为 `implemented`；完整验收并合入主分支后才标为 `verified`。
3. 真实图片始终只读；所有 embedding、索引和缩略图输出必须写入隔离临时目录。
4. 性能优化必须同时记录正确性摘要、吞吐和资源代价。吞吐差异小于 3% 默认视为噪声，除非至少三轮中位数证明稳定收益。
5. 批量或并发策略不得仅凭当前一次高可用内存测试改成固定高值；低内存回退是验收条件。
