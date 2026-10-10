# PxHere 1000 张图片准备速度优化方案

> 状态：部分实施  
> 实施状态：`PREP-011` 已验证；`PREP-012/014` 已筛选并保留当前策略；`PREP-013/017` 已评估后暂缓；`PREP-015` 严格 parity 失败后拒绝  
> 更新日期：2026-08-22  
> 范围：Image Search 首次准备的 Native 扫描、DINO、CLIP、调度与资源治理  
> 基准语料：`pxhere-000000`，1000 张受支持图片，2,627,418,359 bytes（约 2.45 GiB）  
> 替代文档：无

## 当前结论

当前 DirectML 路径还有优化空间，但已经没有明显的阶段空等可消除。1000 张三轮受控 A/B 中，重叠流水线的搜索可用 ready P50/P95 为 `225.924/227.986 s`；Native 扫描与 DINO 同时结束在约 `132 s`，CLIP 随后仍有约 `92 s` 串行尾部。向量索引提交只有约 `0.176 s`，ready 未归因开销不超过约 `1.1 s`，都不是下一轮目标。

`PREP-011` 已把瓶颈进一步归因：DINO 的读取/解码占核心 batch 时间 `63.14%`，CLIP 的读取/解码与预处理占 `78.24%`；Native 的纯枚举只有 `0.010 s`，producer 的长等待是解码 consumer 造成的反压。`PREP-012` 随后完成三轮筛选，当前 `jobs=2,batch=4` 仍是两个模型的最快安全组合；更大 batch 未过资源门禁，没有候选进入 1000 图决赛。完整资源轮最低空闲内存 `3.97 MiB`，因此不提高默认并发，也不启用完整 RawImage 双缓冲。

`PREP-014` 又在同一 256 图时间窗完成 scan `2/3/4` × jobs `1/2` 的 18 轮整链路矩阵：当前 `scan=3,jobs=2,batch=4` 的 ready P50/P95 为 `77.287/85.061 s`，scan=2 或 jobs=1 均慢 `22.30%–49.32%`；scan=4 被现有内存策略安全限制为有效 scan=3，不能参与排名。`PREP-015` 对 256 张 JPEG 做 stb/WIC 逐图影子比较，仅 `38/256` 完全一致，`218/256` 至少一个感知哈希不同，因此 WIC 候选在性能接入前已被拒绝。两项都没有进入 1000 图决赛，生产调度和解码路径保持不变。

`PREP-017` 随后实现深度 1 的低内存 CLIP tensor 预取：单独 CLIP 的 256 图三轮 P50 改善 `5.084%`，1000 图长轮改善 `11.143%`，并降低约 `1.01 GiB` 子进程峰值 RSS。首轮 1000 图暴露的两张 RGBA 边界差异已由“非三通道回退原路径”修复；最终向量摘要完全一致。但完整 overlap 准备流水线的 256 图三轮 ready P50 仅改善 `0.513%`，未达到 5% 门槛，所以生产默认仍关闭，任务标记为 `deferred`。

本方案按“先把时间归因准确，再调参数，最后才改流水结构”的顺序推进。DirectML 第一阶段的启用目标是同机同语料 ready P50 至少再改善 `5%`，即不高于 `214.6 s`；组合优化的进阶目标是至少改善 `10%`，即不高于 `203.3 s`。这些是验收门槛，不是尚未测量的收益承诺。

| 优先级 | 方向                                  | 当前判断                                                  | 默认接入条件                               |
| ------ | ------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| P0     | `PREP-011` 阶段细分与完整资源曲线     | 已验证：遥测 P50 开销 +0.149%，1000 图资源采样 0 错误     | 已通过                                     |
| P1     | `PREP-012` DirectML batch/worker 调优 | 已筛选：当前 `jobs=2,batch=4` 最快，无 ≥5% 入围候选       | 保留当前 `auto` 与显式参数                 |
| P2     | `PREP-013` 单模型有界双缓冲           | 占比已触发，但当前内存余量不满足完整 RawImage 深度 2      | 暂缓；只允许未来 tensor 级有界候选重评     |
| P2     | `PREP-014` 扫描与 Embedding 联合调度  | 已筛选：当前 `scan=3,jobs=2,batch=4` 是最快合格组合       | 保留当前策略；scan=4 继续服从资源上限      |
| P3     | `PREP-015` Native JPEG 解码候选       | 已拒绝：WIC 影子结果 `218/256` 至少一个 hash 不一致       | 不启用；未来候选仍须双 hash 逐项完全一致   |
| P2     | `PREP-017` CLIP 低内存 tensor 预取    | 单模型与内存通过；完整 ready P50 仅改善 0.513%            | 默认关闭；只保留显式诊断开关和测试证据     |
| 条件项 | `PREP-004` CUDA provider              | 既有 PoC 的 DINO/CLIP P50 分别约 `1.896×/2.264×`          | 许可证批准后完成发布、soak 和回退门禁      |
| 暂缓   | `PREP-016` USN/提权路径               | 当前 `D:` 卷为 `volume-access-denied`，冷首建仍要读取解码 | 不要求管理员权限；只在温更新证据充分时重开 |

## 目标与非目标

### 目标

1. 缩短从点击“准备素材库”到 DINO、CLIP、active-set revision 和向量索引全部可搜索的真实墙钟时间。
2. 保持 Native、DINO、CLIP、索引数量、向量质量、暂停/停止/恢复、失败重试和原子提交语义不变。
3. 让每次试验都能回答慢在读取、解码、预处理、推理、持久化、队列等待还是资源争用。
4. 只把同机同语料三轮 A/B 中稳定获益的策略接入 `auto`，保留显式用户参数和旧策略回退。

### 非目标

1. 不减少扫描范围，不跳过 DINO 或 CLIP，不提前发送 ready，也不把后台缩略图耗时混入搜索可用时间。
2. 不改变模型、输入尺寸、归一化、向量维度、Float16/Float32 持久格式、Native 双 hash 或搜索排序语义。
3. 不在 4 GiB GPU 上直接并行运行完整 DINO 与 CLIP 阶段，不用 OOM 后静默漏项换取速度。
4. 不要求用户以管理员身份运行，不新增提权服务，不把 CUDA/cuDNN 在许可批准前加入默认发行包。
5. 不优先优化低于秒级的向量索引、manifest 保存或 UI 进度计算。

## 当前关键路径

```text
Native 扫描 ───────────────┐
                           ├─ 最慢者约 132 s ─→ CLIP 约 92 s ─→ 索引/校验约 1 s ─→ ready
DINO committed-path 流 ────┘
```

串行基线中 Native、DINO、CLIP 各约 `89.6/91.0/90.4 s`；重叠后 Native 和 DINO 均增加到约 `132 s`。这说明当前 17.08% 总收益是真实的，但 CPU、内存带宽或磁盘读取争用消耗了理论重叠空间。全程时间线没有检测到中途停顿，因此不能用增加轮询频率、缩短阶段交接或修改进度条解决。

`PREP-011` 已确认扫描指标中的 `enumMs` 主要是有界队列反压：最终长测纯目录枚举 `0.010 s`，queue wait `145.817 s`，解码聚合 `420.063 s`，三个 worker 忙碌时间只相差 `0.404 s`。因此不优化枚举轮询或无界扩大队列；后续只影子评估保持双 hash 完全一致的解码候选。

## PREP-011：阶段细分与资源基线

### 采集内容

Native 按聚合阶段记录：

1. 纯目录枚举时间、队列提交等待和队列深度，不再把反压混进枚举时间。
2. 文件读取字节/耗时、签名检查、图片解码、灰度转换、DiffHash/DctHash、记录提交和索引保存。
3. worker 活跃数、每 worker 完成量、队列高水位和取消等待；只记录聚合值，不记录路径。

DINO/CLIP 按 batch 记录：

1. 队列等待、文件读取、解码、模型预处理、tensor 拼装、推理、归一化/后处理、IPC 返回和向量持久化。
2. batch 大小、成功/失败/重试数、瞬时吞吐、主/子进程 RSS、系统空闲内存、GPU 利用率与显存。
3. 模型加载与首批启动单独计时，避免把启动延迟误判为处理中停顿。

### 边界与验收

- 继续写逐事件 `*.timeline.ndjson` 和汇总 `stage-analysis.json/md`；异常退出后已落盘事件仍可读取。
- 不写源目录、文件名、完整路径或原始图像内容；样本只使用不可逆 ID。
- 仪表化与关闭仪表化的 256 图三轮 P50 差异不超过 `1%`，数量、摘要和向量 parity 完全通过。
- 使用已修复的 `nvidia-smi` 2 秒超时采样器补跑至少一轮完整 1000 图重叠资源曲线；采样失败必须显式报告，不能记为 0。

### 完成结果

- 256 图关闭/开启详细指标的三轮 ready P50 为 `61.515/61.607 s`，开销 `+0.149%`；六轮 Native、DINO、CLIP、索引和源快照摘要一致。
- 1000 图最终轮获得 `1187` 个资源样本、`0` 错误、`0` process-race skip，且无需检查点恢复；主进程峰值 RSS `767.17 MiB`，child 聚合峰值约 `2931.50 MiB`，GPU 峰值 `1960/4096 MiB`。
- DINO 前推理阶段占 `63.14%`，CLIP 占 `78.24%`；`PREP-013` 和 `PREP-006` 的触发条件成立。Native 解码远高于纯枚举，`PREP-015` 可进入严格 parity 的影子评估。
- 详细结果见 [PREP-011 图片准备阶段归因与完整资源曲线验证](../benchmark/2026-08-22-image-preparation-stage-attribution-prep011.md)。

## PREP-012：DirectML batch 与 worker 调优

### 试验矩阵

先在固定 256 图分层子集上筛选，再把最多 3 个候选带入完整 1000 图三轮交错 A/B：

| 维度   | 候选                         | 说明                                           |
| ------ | ---------------------------- | ---------------------------------------------- |
| 模型   | DINO、CLIP 分开测            | 允许 `auto` 为两个模型选择不同组合             |
| worker | `1`、`2`                     | 比较一个大 batch 与两个并行 session 的资源效率 |
| batch  | `4`、`8`、`16`               | 内存门禁拒绝的组合记录为 skipped，不强行启动   |
| 测量   | 冷启动、稳定吞吐、完整工作流 | 不用单次最快值代替三轮 P50/P95                 |
| 顺序   | 交错/轮换                    | 降低文件缓存、温度和系统后台任务带来的顺序偏差 |

### 筛选结果

- DINO 当前 `jobs=2,batch=4` P50 `35.728 s`；单 worker `64.565 s`，慢 `80.71%`。
- CLIP 当前 `jobs=2,batch=4` P50 `34.603 s`；单 worker batch 4 为 `49.838 s`，慢 `44.03%`；单次可运行的 batch 8 也慢 `9.15%`。
- 所有已运行候选向量 cosine 为 `1`、fallback 为 0、资源采样错误为 0；其余 batch 8/16 组合由生产 auto 策略记录为 `skipped`。
- 没有 ≥5% 候选，所以不运行 1000 图决赛、不修改产品策略。详见 [PREP-012 矩阵验证](../benchmark/2026-08-22-embedding-policy-matrix-prep012.md)。

生产策略只调整 `requestedBatchSize=0` 的自动模式：

1. 显式 `1..16` 用户选择保持原样，不被自动策略覆盖。
2. 每个模型独立记录选择结果、内存快照和原因；资源信息缺失时回到保守 `batch=4`。
3. OOM、provider 失败或系统内存跌破安全线时，当前未完成输入按 `16 → 8 → 4` 降级重试，并记录降级；不得丢图或生成部分 ready。
4. 候选必须同时改善隔离模型吞吐和完整 ready，避免只让 CLIP 单测更快却加剧与扫描的争用。

### 启用门禁

- 完整 1000 图三轮 ready P50 至少改善 `5%`，P95 和最大单轮不能稳定回退超过 `3%`。
- DINO/CLIP 数量、维度、有限值、单位范数通过；最低 cosine `≥0.999`、最大绝对误差 `≤0.01`、平均 Top-10 重合 `≥0.99`。
- 主/子进程 RSS P95 增量不超过 `max(15%, 64 MiB)` 的现有预算；GPU 峰值不超过设备 `75%`，相对基线 P95 增量不超过 `256 MiB`。
- 无 OOM、provider 意外回退、commit-feed drop、重复推理或源文件变化。

## PREP-013：单模型有界双缓冲

只有 `PREP-011` 证明“读取 + 解码 + 预处理 + tensor 拼装”占某一模型稳定阶段至少 `10%` 时才实施。它不等同于 `PREP-006` 的 DINO/CLIP 跨模型像素复用：本项只在同一个子进程中让 batch N 推理时准备 batch N+1，风险和生命周期更小。

占比条件已经满足，但资源条件没有满足：当前双 worker 三轮最低空闲内存约 `315 MiB`，完整 1000 图轮最低 `3.97 MiB`。直接 Sharp 路径配对慢 `2.95%`，提前释放 RawImage 引用也未降低墙钟或峰值 RSS，两个实验均已撤回。完整 RawImage 深度 2 会放大现有峰值，当前标记为 `deferred`；未来只允许在 tensor 级、严格字节上限和低内存即时回退都成立时重评。

设计边界：

1. 队列深度固定为 2；按文件编码字节、解码后字节和 batch 数三重限额，不能随素材数增长。
2. 低内存、暂停、取消、provider 回退或当前 batch 失败时立即停止预取并释放下一批缓冲。
3. DINO 继续使用 DINO 预处理，CLIP 继续使用 CLIP 预处理；两者不共享变换后的 tensor。
4. 预取只改变执行重叠，不改变提交顺序、重试 ID、向量顺序或最终 active-set revision 栅栏。

若完整 ready 收益低于 `5%`、前处理占比不足或 RSS/VRAM 超门禁，则标记 `deferred`，不继续扩大队列。

## PREP-014：扫描与 Embedding 联合调度

当前扫描单独约 `89.6 s`，与 DINO 重叠后约 `132.0 s`；因此不能分别选择“扫描最快参数”和“DINO 最快参数”。本轮已在 `PREP-012` 的当前 embedding 组合上完成以下完整流水线矩阵：

- Native worker：`2 / 3 / 4`。
- Embedding worker：`1 / 2`。
- batch：只使用 `PREP-012` 入围组合，避免矩阵无界膨胀。
- 评价函数：首先满足正确性和资源门禁，再最小化 ready P50；单阶段最快不作为启用理由。

若固定组合在不同资源压力下不稳定，只允许复用现有资源治理器做保守降级，不新建第二套调度器。任何动态策略都必须有确定上限、选择原因、降级日志和一键回到当前 `scan=3, jobs=2, batch=4` 的路径。

三轮结果中，当前组合 ready P50/P95 为 `77.287/85.061 s`。scan=2/jobs=2 慢 `22.30%`，scan=2/jobs=1 慢 `47.97%`，scan=3/jobs=1 慢 `49.32%`；请求 scan=4 的六轮因启动时仅约 `2.79–3.29 GiB` 可用内存，被现有生产策略限制为有效 scan=3，并按 `skipped-resource-policy` 记录。18 轮的 Native、DINO/CLIP、索引与源快照 parity 全部通过，资源采样 `9618` 个、错误 0，但没有至少快 5% 的候选，因此保留当前策略。详见 [PREP-014 联合调度矩阵验证](../benchmark/2026-08-22-image-joint-scheduling-prep014.md)。

## PREP-015：Native JPEG 解码候选

当前扫描的安全双 hash 路径仍以 stb 全尺寸解码后转灰度；代码中虽存在 WIC 缩放解码候选，但直接接入可能改变通道元数据、DiffHash/DctHash 和近重复搜索排序，因此不能作为无风险开关。

`PREP-011` 已满足 Native 解码占比触发条件，本轮按以下边界完成影子 A/B：

1. 覆盖当前 1000 图、JPEG 方向/色彩空间样本，以及 PNG/WebP/GIF/BMP、超大图、损坏图和解码炸弹边界。
2. 逐图比较宽、高、通道数、DiffHash64、DctHash64、失败分类和最终 Native 记录摘要；要求完全一致，不使用近似阈值。
3. 保留 SEH/解码尺寸/编码大小限制和 stb 回退；WIC 初始化、失败与回退必须可观测。
4. 只有扫描阶段 P50 至少改善 `10%` 且完整 ready 至少改善 `5%` 才默认启用，否则保留为未启用实验。

256 张 JPEG 中，宽、高、通道和解码成功分类均完全一致，但仅 `38/256` 全字段一致；DiffHash64 不一致 `171/256`，DctHash64 不一致 `148/256`，合计 `218/256` 至少一个哈希不同。严格 parity 不接受近似值，因此候选直接拒绝，不再建设集成扫描开关，也不运行 1000 图性能决赛。生产继续使用 SEH 保护的 stb 全尺寸解码与原双哈希语义；详见 [PREP-015 Native JPEG WIC 影子解码验证](../benchmark/2026-08-22-native-jpeg-shadow-prep015.md)。

## PREP-017：CLIP 低内存 Tensor 预取

候选把 lookahead 固定为每个 CLIP 子进程一个 batch、tensor 上限 `16 MiB`、领取下一批时系统空闲内存下限 `1 GiB`。三通道输入在 Sharp 解码图中直接缩放到 CLIP 最短边 224，再由原 processor 完成中心裁剪和归一化；非三通道、超限或契约不确定输入使用原解码器。

单独 CLIP 的 256 图三轮 P50 从 `35.462 s` 降至 `33.659 s`，1000 图从 `125.756 s` 降至 `111.743 s`，完整向量摘要一致，1000 图子进程峰值从 `3097.85 MiB` 降至 `2067.19 MiB`。但最终完整准备三轮 ready P50 只从 `79.822 s` 降至 `79.413 s`，改善 `0.513%`；P95、RSS、VRAM、fallback、资源采样和源只读虽均通过，仍按统一门禁 `reject-and-defer`。只有显式设置 `REASONIX_EMBEDDING_TENSOR_PREFETCH=1` 才能复现实验。详见 [PREP-017 验证](../benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)。

## 条件项与暂缓项

### PREP-004：CUDA provider

既有 PoC 显示 CUDA 的单模型收益最大，但约 1.98 GiB 可选运行时仍受许可证和分发决策约束。许可批准后采用独立可选安装、完整性校验和 `CUDA → DirectML → CPU` 回退，并完成 30 轮、60 分钟 soak、三轮冷启动和固定语料质量门禁。以当前 225.924 秒基线计算，正式候选的端到端目标为至少改善 `30%`（P50 不高于约 `158.1 s`）；未达到也不能用 PoC 倍率代替产品结论。

### PREP-016：USN 与提权

当前 `D:` 卷 USN 为 `volume-access-denied`。即使目录枚举更快，冷首建仍需读取并解码全部 2.45 GiB 图片，因此 USN 不进入当前 DirectML P0/P1。产品不要求管理员运行，也不安装提权 helper。只有温更新的大目录基准证明纯发现阶段占比显著，且用户明确接受权限方案时，才重新评估只读 USN 路径。

### 暂不并行 DINO 与 CLIP

在 4 GiB GPU 上同时保留两套模型 session 可能放大显存、内存带宽与 DirectML 队列争用。当前先优化各模型内部 batch 和预取；只有完整资源曲线证明 `1+1` session 在 GPU 75% 预算内，并且影子流水线有稳定端到端收益，才另立任务评估跨模型 wavefront。默认 ready 语义始终要求双模型精确覆盖。

## 数据、IPC、UI 与兼容边界

1. 新增数据仅为 benchmark 聚合时间和资源采样，不进入用户向量库、Native 索引或同步数据。
2. 若生产日志增加选择原因，只传递枚举值、batch、worker 和聚合计数；IPC 不传原图字节或绝对路径。
3. UI 不增加必须理解的新设置；简单模式继续使用 `auto`，高级模式的显式 batch/worker 选择保持原语义。
4. ready、暂停、停止、重试、恢复和后台缩略图状态不改；优化失败只降级执行策略，不降级结果完整性。
5. 旧索引、旧缓存和旧任务无需迁移；所有候选均可关闭并回到当前实现。

## 安全、失败恢复与回滚

1. 所有真实性能测试复制样本到隔离目录、使用独立 `userData`，源目录运行前后做快照；只清理本轮已验证属于临时根目录的输出。
2. 时间线继续去标识，不保存文件名、完整路径、图像内容、向量原文或模型密钥。
3. 每项生产候选使用独立策略开关；未达到门禁、资源采样缺失或发生 OOM 时保持/恢复当前策略。
4. batch 降级必须重试同一批输入；取消后不能提交未完成批次，崩溃恢复继续依赖现有精确覆盖和 revision 栅栏。
5. 不修改用户原图、真实素材库权威数据、模型文件、许可证状态或安装包内容。

## 实施顺序与交付物

1. **阶段 A：证据补全（已完成）。** `PREP-011` 已生成修复后完整资源曲线和细分阶段报告；未改产品调度。
2. **阶段 B：低风险调优（已完成筛选）。** `PREP-012` 的 256 图三轮矩阵没有产生至少快 5% 的候选，因此 1000 图决赛不适用，`auto` 策略保持不变。
3. **阶段 C：证据触发优化（已完成筛选）。** `PREP-013` 的两个低风险影子候选均无收益，完整 RawImage 深度 2 又未过内存门禁，已暂缓；`PREP-015` 的 WIC 候选因 `218/256` 哈希不一致被拒绝。
4. **阶段 D：整链路联合验证（已完成筛选）。** `PREP-014` 的 18 轮矩阵没有产生 ≥5% 候选，当前 `scan=3,jobs=2,batch=4` 保持不变。
5. **阶段 E：低内存 tensor 预取（已完成筛选）。** `PREP-017` 单模型与资源门禁通过，但完整 ready 收益仅 0.513%，默认关闭并暂缓。
6. **阶段 F：条件 provider。** `PREP-004` 只在许可证批准后推进；`PREP-016` 维持暂缓。

每阶段必须产出原始去标识 JSON、逐事件 NDJSON、阶段分析 Markdown、机器可读门禁结果、正确性/资源对照和拒绝候选原因。失败试验保留证据，不用重复加大并发重试。

## 验证入口

现有入口：

```powershell
npm.cmd run benchmark:image-search:preparation:ab -- --dataset="D:\PxHereDataset\images\pxhere-000000" --sample=1000 --runs=3 --backend=gpu --jobs=2 --batch-size=4 --timeout-ms=1800000
npm.cmd run benchmark:image-search:preparation:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\<timestamp>"
npm.cmd run benchmark:image-search:joint-scheduling -- --dataset="D:\PxHereDataset\images\pxhere-000000" --sample=256 --rounds=3 --scan-workers=2,3,4 --embedding-jobs=1,2 --batch-size=4 --backend=gpu
npm.cmd run benchmark:image-search:joint-scheduling:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\<timestamp>"
npm.cmd run benchmark:image-search:jpeg-shadow -- "D:\PxHereDataset\images\pxhere-000000" --sample=256 --scan-workers=3
npm.cmd run benchmark:image-search-simple-embeddings
npm.cmd run benchmark:image-search:embedding-prefetch:analyze
npm.cmd run benchmark:image-search-simple-scan-workers
node --test tests/native-decode.test.cjs tests/native-hash.test.cjs tests/native-scan.test.cjs tests/search-library-preparation-benchmark.test.cjs tests/image-preparation-pipeline.test.cjs tests/clip-image-decode.test.cjs tests/embedding-tensor-prefetch.test.cjs tests/embedding-tensor-prefetch-analysis.test.cjs
npm.cmd run docs:check
```

`PREP-011` 已扩展 benchmark 参数、聚合报告和去标识阶段指标；`PREP-012/014` 的资源约束矩阵均未产生入围候选，`PREP-015` 未通过严格哈希 parity，`PREP-017` 未通过完整 ready 5% 收益门槛，因此生产 `auto`、显式参数、batch 4 回退和默认 Native/CLIP 解码路径都未修改。后续仍只有通过三轮收益、资源、正确性和回退门禁后才允许修改产品策略。

## 证据

- [PxHere 1000 张图片准备速度与阶段间隔诊断](../benchmark/2026-08-22-pxhere-1000-image-preparation-diagnostic.md)
- [PREP-011 图片准备阶段归因与完整资源曲线验证](../benchmark/2026-08-22-image-preparation-stage-attribution-prep011.md)
- [PREP-012 DirectML batch/worker 受资源约束矩阵验证](../benchmark/2026-08-22-embedding-policy-matrix-prep012.md)
- [PREP-014 图片扫描与 Embedding 联合调度矩阵验证](../benchmark/2026-08-22-image-joint-scheduling-prep014.md)
- [PREP-015 Native JPEG WIC 影子解码验证](../benchmark/2026-08-22-native-jpeg-shadow-prep015.md)
- [PREP-017 CLIP 低内存 Tensor 预取验证](../benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)
- [PREP-005 图片准备增量流水线验证](../benchmark/2026-08-22-image-preparation-pipeline-prep005.md)
- [图片搜索与视频建库“准备素材库”性能优化 TODO](2026-08-22-search-library-preparation-performance-todo.md)
- [DINO / CLIP CUDA provider PoC](../benchmarks/2026-08-07-dino-clip-cuda-poc.md)

## 当前验证状态

| 项目           | 结果                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 基线与阶段数据 | 通过：1000 图三轮 A/B、四轮详细阶段比例与最终完整资源轮方向一致                                                                    |
| 遥测性能       | 通过：256 图三轮 P50 开销 +0.149%，六轮结果摘要和源快照一致                                                                        |
| 优化收益       | 已筛选：`PREP-012/014` 无 ≥5% 入围项；`PREP-013` 暂缓；`PREP-015` 哈希 parity 失败；`PREP-017` 完整 ready 仅 +0.513%；生产策略不变 |
| 功能与数据变更 | 通过：诊断字段默认关闭；未修改 ready、模型、向量、哈希/索引格式或用户数据                                                          |
| 长时资源曲线   | 通过：最终 1000 图 1187 个样本、0 错误、无需恢复；最低空闲内存 3.97 MiB 已纳入后续候选拒绝条件                                     |
| CUDA 分发许可  | 未验证：仍等待独立批准                                                                                                             |
