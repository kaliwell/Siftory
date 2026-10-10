# 图片搜索与视频建库“准备素材库”性能优化 TODO

> 状态：当前  
> 更新日期：2026-08-22  
> 范围：Image Search 与 Media Search 的一键“准备素材库”链路；附带已建库查询和 NekoSearch 派生准备的关联优化  
> 替代文档：无

## 当前结论

仍有明确的速度优化空间，但不能再把普通列表、热缓存或单纯提高并发当作主方向。按预期收益和现有证据排序：

1. **视频抽帧建库**：`PREP-002` 已验证并默认启用本地有界单输入批次，固定长视频语料 P50 改善 55.53%，FFmpeg 启动数由 71 降至 8；挂载网络候选回退 163.08%，因此继续使用现有多输入批量。
2. **视频准备流水线**：`PREP-003` 已验证并默认接入简单模式。已提交帧检查点会驱动常驻 DINO 会话与 CPU 抽帧重叠；最终仍等待 DINO、CLIP 精确覆盖和帧索引提交。固定长视频语料端到端 P50 改善 15.37%。
3. **图片 DINO/CLIP 建库**：`PREP-005` 已验证并默认接入简单模式。模型准备与扫描并行，Native 已提交路径按真实 batch 驱动 DINO 流，最终仍以 DINO/CLIP 精确覆盖、active-set revision 和向量索引提交为 ready 门禁；固定 16 图三轮 P50 改善 15.55%，1000 图、2.45 GiB 真实语料三轮 P50 改善 17.08%，温更新零重复推理。
4. **已建库查询与 NekoSearch**：`PREP-007` 已把 Image Search ANN 候选从约 65%–91% 收敛到 20%，热查询 P95 改善 83.04%；`PREP-008` 进一步让 NekoSearch 的 4 个 CLIP 反馈中心共享一次 active scope，以约 10% 活跃候选做原始 Float16 正负反馈精确评分，三轮受控 A/B 的 P95 改善 69.36%，Top-20/50、人工指标、首位、负样本与 active filter 均无回退。
5. **全量数据目录刷新**：`PREP-009` 已验证并默认接入。无变化刷新三轮均不读取权威向量，P95 为 12.452 秒；隔离追加只读源的 13.5141%，相对干净全量改善 76.72%，路径、目录、统计与逻辑 SHA 均和全量重建一致。
6. **CLIP 低内存 tensor 预取**：`PREP-017` 已完成筛选。单独 CLIP 的 256 图三轮 P50 改善 5.084%、1000 图改善 11.143%，但完整“一键准备”256 图三轮 ready P50 仅改善 0.513%，未过 5% 门槛；因此默认关闭并标记 `deferred`。完整向量摘要一致，内存明显下降，非三通道自动回退原解码器。
7. **扫描/Embedding 联合调度与 Native JPEG**：`PREP-014` 的 18 轮矩阵未找到比 `scan=3,jobs=2,batch=4` 至少快 5% 的合格组合；`PREP-015` 的 WIC 影子解码有 `218/256` 图片至少一个感知哈希不一致。两项均已完成筛选，不改生产策略。
8. **普通 UI、列表排序和热 Manifest**：已经不是本专项的主要瓶颈，不为追求表面速度重复改写。

`PREP-001` 已完成隔离基线；`PREP-002`、`PREP-003`、`PREP-005`、`PREP-007`、`PREP-008`、`PREP-009` 和 `PREP-011` 已通过各自的正确性、失败恢复、安全、资源、性能与质量门禁。`PREP-012` 已完成三轮 256 图筛选：两个模型的当前 `jobs=2,batch=4` 都显著快于单 worker，batch 8/16 又受现有 RAM/VRAM 门禁限制，因此没有候选进入 1000 图决赛。`PREP-013` 的完整 RawImage 双缓冲不满足内存门禁；其低内存后继方案 `PREP-017` 虽通过单模型和资源门禁，但完整 ready 收益不足，仍默认关闭。`PREP-014` 的整链路矩阵确认当前 `scan=3,jobs=2,batch=4` 仍是最快合格组合；`PREP-015` 则因 WIC 与 stb 双哈希严格 parity 失败而拒绝。生产 `auto`、Native/CLIP 默认解码路径、真实源图片/视频、现有 Manifest、权威向量和搜索索引格式均保持不变。

## 执行身份与工作区边界

| 字段       | 当前值                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 文档建立者 | Codex/root                                                                                               |
| 执行系统   | Codex                                                                                                    |
| 模型信息   | GPT-5 系列；精确小版本未公开                                                                             |
| 外部代理   | 无                                                                                                       |
| 文档入口   | `docs/README.md`                                                                                         |
| 当前分支   | `feat/phase3-staged-index-unified-search`                                                                |
| Git 基线   | `e51fd1f462266c3ecf59d92f03494c8f67ab74f1`；共享工作区已有大量未提交改动，本任务不提交、不回退范围外文件 |
| 当前任务   | `PREP-017` 已完成自动筛选并 `deferred`：端到端 ready 收益 0.513%，候选只保留显式诊断开关                 |

任务表中的“所有者=未分配”表示本文只排定工作，不声明已有模型、代理或人工正在实施。

## 目标与非目标

### 目标

1. 缩短 Image Search 和 Media Search 一键准备从点击到“可搜索”的真实墙钟时间。
2. 优先消除重复启动进程、重复打开/解码文件、串行阶段空转和大规模全量点积。
3. 保留现有增量复用、暂停、停止、恢复、失败回退、原子提交和资源治理语义。
4. 每项优化同时记录正确性、吞吐、P50/P95、内存、显存、磁盘读取和失败数，拒绝只改善 UI 进度数字的方案。

### 非目标

1. 不改变默认抽帧规格：本地仍为 3 秒间隔、最多 3600 帧、384px；mounted-network 仍为 15 秒间隔、最多 240 帧、256px。
2. 不取消 DINO 或 CLIP，不降低图片/视频搜索质量，不用减少结果或缩小扫描范围换取速度。
3. 不降低 JPEG 质量、SQLite 持久性、文件/模型完整性校验、路径授权或派生数据原子提交强度。
4. 不在 4 GiB 显存设备上盲目增加 DirectML、CUDA 或 Qwen3-VL 并发；任何并发变化必须经过显存峰值和长时间 soak。
5. 不在 NVIDIA 许可审批完成前把约 1.98 GiB CUDA/cuDNN 可选运行时改为默认捆绑。
6. 不修改、删除、移动或覆盖用户原图、原视频、真实素材库权威数据和已有模型。
7. 不通过把 queued/skipped 计成 completed、提前显示 100% 或隐藏阶段来制造“更快”的观感。

## 当前可复用能力

后续实施必须复用下列现有能力，避免重复造轮子：

1. Native 自适应扫描 worker、签名预过滤、温更新跳过和后台缩略图补全。
2. DINO/CLIP 已存在 ID 的 F16/F32 路径索引、append-tail 读取、负缓存、真实 batch 和受显存约束的 worker 数。
3. CUDA → DirectML → CPU 的受控 provider 回退、固定模型哈希、provider parity 和可选运行时完整性校验。
4. 向量 generation、增量段、F16 cache、常驻 ANN worker、协作取消、精确兜底和 Recall 门禁。
5. Media Search 已完成帧复用、Manifest 缓存、按 `videoId:timestampMs` 跳过已完成帧、任务暂停/停止和统一调度器接线。
6. 资源治理器的 CPU、内存、显存和磁盘压力降级策略。

## 现有证据基线

不同基准的数据规模和文件体积不同，数字不可直接横向相除；它们只用于定位阶段瓶颈。`PREP-001` 已在当前代码和固定语料上建立新的可比较基线。

| 链路                  | 最近证据                                                                                       | 当前判断                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 当前隔离三轮基线      | 16 图工作流 ready P50/P95 9.557/9.882 秒；3 视频固定语料 5.645/5.679 秒                        | DINO/CLIP 仍占主导；图片缩略图已按当前简单模式在 ready 后后台补全   |
| Image Search 一键准备 | 1000 图三轮串行/重叠 ready P50 为 272.451/225.924 秒；重叠扫描/DINO 各约 132 秒，CLIP 约 92 秒 | 下一步先细分读取/解码/推理，再调 batch/worker；索引和阶段交接可忽略 |
| 长任务 Embedding      | 真实运行后半段队列派发约 19.18–20.08 张/秒                                                     | 已有 ID 扫描问题已修复，下一步是 provider、解码和流水化             |
| CUDA provider PoC     | DINO P50 1.896×；CLIP image P50 2.264×；输出近似一致                                           | NVIDIA 设备存在明确加速路径，但须完成发布与长期稳定性门禁           |
| Image Search ANN      | 440,450 行、50 样本：热查询 P50/P95 0.910/0.960 秒；平均 Recall@50 99.88%；候选 20%            | PREP-007 已验证；最终仍以完整 768 维 Float16 精确重排               |
| 本地视频抽帧          | 每 3 秒一帧；代码对每个待建帧调用一次 `generateVideoCoverThumbnailAsync`，默认并发 1           | 进程/文件打开/seek 放大尚无当前真实端到端数据，列为首要测量和优化项 |
| 网络视频抽帧          | 单视频一个 FFmpeg 进程，但参数仍为每个时间点重复 `-ss` 与 `-i`                                 | 已减少进程数，仍不等于单输入单解码；需按稀疏 seek 特性 A/B          |
| 深度视频语义          | llama.cpp 持续推理平均 11.456 秒/段、P95 16.643 秒、最大显存 2219 MiB                          | 模型推理占主导；4 GiB 设备保持单并发，先做证据复用与预取            |
| NekoSearch 分类扫描   | 440,462 行、266,001 活跃项：exact/ANN P95 5.267/1.614 秒；Top-50 100%；活跃候选约 10%          | PREP-008 已验证；完整 exact 仍作为诊断与自动失败回退                |
| 数据目录刷新          | 当前 11.36 GiB：全量 129.129 秒；无变化 P50/P95 12.171/12.452 秒且向量读取为 0                 | PREP-009 已验证；严格追加复用分片，非追加变化安全回退全量           |
| 扫描/Embedding 调度   | 256 图 18 轮矩阵：当前组合 ready P50/P95 77.287/85.061 秒；其余可比组合慢 22.30%–49.32%        | PREP-014 已筛选；保留 `scan=3,jobs=2,batch=4`                       |
| Native JPEG 候选      | 256 张 WIC/stb 影子对比：218 张至少一个双哈希字段不一致                                        | PREP-015 严格 parity 失败；继续使用现有 SEH/stb 路径                |
| CLIP tensor 预取      | 单模型 256 图 +5.084%、1000 图 +11.143%；完整 ready 256 图仅 +0.513%                           | PREP-017 默认关闭并 `deferred`；保留显式诊断与非三通道回退证据      |
| UI 冷启动             | 四个保存面板约 1.20 秒出现、1.43 秒完整，4 秒内无 ≥50 ms JS 长任务                             | 不再列入本专项 P0                                                   |

证据入口：

- [Image Search Simple 模式专项优化 TODO](2026-08-08-image-search-simple-mode-optimization-todo.md)
- [图片搜索与视频建库“准备素材库”三轮基线](../benchmark/2026-08-22-search-library-preparation-baseline.md)
- [PxHere 1000 张图片准备速度与阶段间隔诊断](../benchmark/2026-08-22-pxhere-1000-image-preparation-diagnostic.md)
- [PREP-011 图片准备阶段归因与完整资源曲线验证](../benchmark/2026-08-22-image-preparation-stage-attribution-prep011.md)
- [PREP-012 DirectML batch/worker 受资源约束矩阵验证](../benchmark/2026-08-22-embedding-policy-matrix-prep012.md)
- [PREP-014 图片扫描与 Embedding 联合调度矩阵验证](../benchmark/2026-08-22-image-joint-scheduling-prep014.md)
- [PREP-015 Native JPEG WIC 影子解码验证](../benchmark/2026-08-22-native-jpeg-shadow-prep015.md)
- [PREP-017 CLIP 低内存 Tensor 预取验证](../benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)
- [PxHere 1000 张图片准备速度优化方案](2026-08-22-image-preparation-speed-optimization-plan.md)
- [DINO / CLIP GPU 构建吞吐异常事件](2026-07-31-embedding-gpu-throughput-incident.md)
- [DINO / CLIP CUDA provider PoC](../benchmarks/2026-08-07-dino-clip-cuda-poc.md)
- [Image Search ANN 优化](2026-07-24-image-search-ann-optimization.md)
- [PREP-007 Image Search Q8 投影 ANN 验证](../benchmark/2026-08-22-vector-ann-q8-projection-prep007.md)
- [PREP-008 NekoSearch ANN 候选与精确重排验证](../benchmark/2026-08-22-neko-search-ann-prep008.md)
- [PREP-009 Image Search 数据目录增量刷新验证](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)
- [llama.cpp 本机性能趋势](../benchmarks/2026-08-15-vid-017-llama-cpp-local-performance.md)
- [全量数据目录真实性能基准](../benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)
- `artifacts/neko-search-accuracy/latest.json`（2026-08-17，只读产物）

## PREP-001 验证结果

1. 新增图片/视频端到端 runner、100 ms 常驻资源采样器和统一三轮聚合入口；真实源文件只读，所有索引、向量、帧和缩略图只写带固定前缀的临时目录。
2. 固定 GPU、2 worker、batch 4；图片使用当前简单模式的 deferred thumbnail 路径。图片工作流 ready P50/P95 为 9,557.03/9,881.73 ms，后台缩略图排空 P50 为 2,923.63 ms。
3. 视频 CFR、VFR、截断损坏固定语料的工作流 ready P50/P95 为 5,644.59/5,678.75 ms；7 个计划帧中 6 个成功，损坏视频稳定产生 1 个预期失败。
4. Native、视频、帧、DINO、CLIP、ANN/帧索引的固定精度和位级摘要三轮一致；源文件快照不变，报告绝对路径泄露检查为空。
5. `workflowReadySignalMs` 测量主进程索引提交后前端工作流可显示 ready 的时点；无界面 runner 不测 React 实际 paint，未把该延迟记为 0。完整数据见[三轮基线](../benchmark/2026-08-22-search-library-preparation-baseline.md)。

## PREP-002 验证结果

1. 本地视频按最多 12 帧、最多 30 秒跨度组成单输入批次；输出先写私有 `.partial.jpg`，成功退出且非空后才重命名。批次部分失败只对缺失帧走原逐帧回退。
2. CFR 120 秒、VFR 90 秒和截断损坏输入的三轮 A/B 中，本地抽帧与 Manifest 提交 P50/P95 从 4,937.06/5,066.00 ms 降至 2,195.51/2,297.15 ms，P50 改善 55.53%；FFmpeg 启动数从 71 降至 8。
3. 挂载网络分组单输入 P50 为 760.18 ms，现有多输入批量为 288.95 ms，候选回退 163.08%；因此网络维持 `multi-input` 默认，候选标记 `deferred`。
4. 本地和网络各自的时间点、状态及 JPEG 位级摘要三轮一致；所有成功 JPEG 可解码且宽度正确。部分失败、运行中取消、Manifest 重命名故障、源快照和私有临时文件清理均通过。
5. 完整实现与数据见[PREP-002 视频抽帧验证](../benchmark/2026-08-22-video-frame-extraction-prep002.md)。

## PREP-003 验证结果

1. 新增源 fingerprint 绑定的原子帧检查点；崩溃后只恢复已提交且仍属于授权作用域的非链接、非空输出，源变化会使全部相关派生帧、Embedding 和帧索引失效。
2. 新增统一视频准备协调器：CPU 抽帧提交批次后立即追加到常驻 DINO 会话；重叠期 1 worker，抽帧结束后恢复既有 DirectML 上限；CLIP 对最终权威集合只构建一次。
3. ready 仍要求抽帧完成、DINO 精确覆盖、CLIP 精确覆盖和帧索引提交四项全部成立；停止只取消该准备任务拥有的 FFmpeg/Embedding，部分检查点可安全恢复。
4. CFR 120 秒、VFR 90 秒和截断损坏输入的三轮交错 A/B 中，工作流 ready P50/P95 从 12,200.12/12,274.78 ms 降至 10,325.15/10,345.27 ms，P50 改善 15.37%。
5. 三轮均保持 69 ready 帧、DINO/CLIP 各 69 条覆盖、138 条索引和 Top-10 重合 1.0；主 RSS P95 增加 7.58 MiB、子进程 P95 增加 11.30 MiB，显存相对串行 P95 增加 157 MiB且绝对峰值占 4 GiB 设备 37.04%。
6. 结构终检将流会话、准备子进程协议和 worker 结果解析拆出热服务；`embeddingService.ts` 从 1,980 行降至 1,735 行，主进程构建图 281/281 通过。拆分后真实短流程保持 19 ready、DINO/CLIP 各 19 条、38 条索引且无缺失。
7. 完整实现、门禁解释与数据见[PREP-003 视频准备分块流水线验证](../benchmark/2026-08-22-media-preparation-pipeline-prep003.md)。

## PREP-005 验证结果

1. Native 扫描增加默认关闭、4,096 条/8 MiB 有界的 committed-path feed；只有索引与路径映射提交成功后才通知，drop 可观测且最终精确覆盖会补齐遗漏。
2. 模型准备与扫描并行；变化路径先有界失效旧向量，再按 batch 4、最多 2 worker 驱动常驻 DINO 流。扫描结束后对最终 active set 补齐 DINO/CLIP，并通过 revision 栅栏后提交向量索引。
3. 主进程任务状态可跨面板隐藏和 renderer 重建恢复；ready 后才启动后台缩略图。停止只取消本准备任务拥有的扫描、下载和 Embedding，不会直接停止其他窗口后来创建的任务。
4. 固定 16 图、GPU、2 worker、batch 4 的三轮交错 A/B 中，ready P50/P95 从 9,591.02/9,603.27 ms 降至 8,099.36/8,127.40 ms，P50 改善 15.55%。
5. 三轮均保持 16 Native、16 DINO、16 CLIP 和 16 索引；两模型最低余弦 1、最大绝对误差 0、Top-10 重合 1。温更新 committed/invalidated/completed/failed 均为 0，skipped 各 16。
6. 主 RSS P50 增加 0.91%，GPU P95 从 1,293 MiB 降至 1,244 MiB，子进程峰值活动数保持 3；源快照不变、隔离 `userData`、真实素材库未写。
7. 完整实现、失败迭代、资源与门禁解释见[PREP-005 图片准备增量流水线验证](../benchmark/2026-08-22-image-preparation-pipeline-prep005.md)。
8. 同条件扩展到 1000 图、2.45 GiB 真实语料后，三轮串行/重叠 ready P50/P95 为 `272.451/274.676 s` 与 `225.924/227.986 s`，P50 改善 17.08%；额外全程仪表化运行未发现扫描、DINO 或 CLIP 中途停顿。下一轮方案见[1000 图速度优化方案](2026-08-22-image-preparation-speed-optimization-plan.md)。

## PREP-007 验证结果

1. 生产 ANN worker 在最新有效行和授权 scope 上使用固定 128 维、逐维比例尺的 Q8 内存投影召回最多 20% 候选，再以原始 768 维 Float16 做既有精确重排；小 scope 会优先满足请求数量。
2. committed delta 只量化新增行；若新值超出旧比例尺，热追加会在派生签名提交前失败并转为完整重建，避免静默 clipping。v1 SimHash 文件、generation、完整性证明和精确扫描回退均保留。
3. 440,450 行真实 DINO 缓存连续三轮各取 50 个分层样本，平均 Recall@50 均为 99.88%、最差均为 98%、查询图首位一致率均为 100%，候选固定为 88,090 行（20%）。
4. 三轮精确/ANN 热查询 P50 分别落在 5,510–5,688/889–910 ms，P95 为 5,661–5,944/942–960 ms；P95 改善 83.04%–84.08%，聚合加速 5.71×–6.09×。
5. Q8 投影本体约 53.77 MiB；隔离冷预热 3,777.70–3,960.40 ms。三轮源向量、路径和 meta 的运行前后快照一致，正式报告只保存路径哈希，派生索引只写本次临时目录。
6. 完整实现、被拒绝的 SimHash 方案、资源边界与报告入口见[PREP-007 Image Search Q8 投影 ANN 验证](../benchmark/2026-08-22-vector-ann-q8-projection-prep007.md)。

## PREP-008 验证结果

1. NekoSearch 默认通过统一 ANN worker 一次批量查询最多 4 个反馈中心，共享只读 CLIP F16 缓存、最新有效行和 active scope；Image Search 的 20% 产品策略不变，NekoSearch 独立使用约 10% 活跃候选。
2. ANN 只生成候选行，worker 仍读取原始 512 维 Float16 向量执行既有正中心、多模态正样本和目标级负样本精确评分，之后的 DINO 精确重排、稳定排序与返回合同未改。
3. 440,462 行真实 CLIP 缓存、266,001 个活跃素材、73 个正样本和 62 个负样本的三轮受控 A/B 中，完整扫描/ANN P50 为 5,184.71/1,573.32 ms，P95 为 5,267.35/1,613.74 ms，P95 改善 69.36%。
4. Top-20/50 重合均为 100%，Top-100 为 99%，首位一致率 100%，公共结果精确分数误差为 0；Precision@20/50、Recall@50、nDCG@20、拒绝侵入和 active filter 均无下降或违规。
5. `FLOATING_CLOCK_NEKO_EXACT_SCAN=1` 可强制完整诊断；ANN 缺失、损坏、过期、空召回或批量结果异常会自动回退 exact。独立完整 CLIP+DINO exact 门禁成功运行，但因当前活跃集 266,001 条与旧基线 245,171 条不同而按设计判为不可比较，未覆盖或伪报旧基线通过。
6. 完整实现、被拒绝的 20% 顺序方案、资源边界与报告入口见[PREP-008 NekoSearch ANN 候选与精确重排验证](../benchmark/2026-08-22-neko-search-ann-prep008.md)。

## PREP-009 验证结果

1. 目录 schema v2 以固定 8 MiB chunk-tree 覆盖权威源全部字节，并保存有界前缀证明、source identity/order/layer、namespace 和精确统计；v1 或证明不足的旧目录自动全量重建。
2. 严格 append-tail 只重算旧 partial chunk 与新增尾部，未变化源完整复用；Native 新增/属性变化增量应用，Native 删除、源缩短/替换、前缀改写、namespace/分片集合变化和 GC/压实均安全回退全量。
3. 变更前状态写入临时 `changed_paths`，只对受影响路径的目录祖先应用差量并重算直接子目录数；测试逐行比较 `indexed_paths`、`folder_rollups` 与干净全量结果。
4. 当前 12,194,373,682 bytes 真实向量源的全量构建为 129.129 秒、584.35 MiB RSS、206.58 MiB SQLite；三轮无变化 P50/P95 为 12.171/12.452 秒，向量 full/tail 读取均为 0。
5. 隔离 80,000 行/层加 2,000 条 DINO 追加只读 13.5141% 源字节，增量 1.273 秒、干净全量 5.468 秒，改善 76.72%；汇总与逻辑 SHA 一致，真实源运行前后快照不变。
6. 完整实现、失效矩阵、两次未达门槛迭代和正式产物见[PREP-009 Image Search 数据目录增量刷新验证](../benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)。

## PREP-014 筛选结果

1. 固定 256 图、DirectML batch 4，以交错/轮换顺序完成 scan `2/3/4` × jobs `1/2` 共 18 轮完整流水线；每轮都记录 Native、DINO、CLIP、索引、逐阶段时间线和独立资源曲线。
2. 当前 `scan=3,jobs=2,batch=4` 的 ready P50/P95 为 `77.287/85.061 s`。其余实际可比组合慢 `22.30%–49.32%`，没有候选达到至少改善 5% 的门槛。
3. 请求 scan=4 的六轮被生产内存策略限制为有效 scan=3，按 `skipped-resource-policy` 记录，不把其观测耗时冒充 scan=4 结果。
4. 18 轮 Native、DINO/CLIP、索引与源快照 parity 全部通过；资源样本合计 `9618` 个，采样错误和 process-race skip 均为 0；1000 图决赛不适用。
5. 完整矩阵、门禁和机器分析见[PREP-014 图片扫描与 Embedding 联合调度矩阵验证](../benchmark/2026-08-22-image-joint-scheduling-prep014.md)。

## PREP-015 筛选结果

1. 在相同 256 张 JPEG 上，以当前 SEH/stb 扫描记录为基线，调用既有 WIC 缩放单图路径做逐图影子比较；诊断字段默认关闭，不改变生产快照结构。
2. 宽、高、通道和成功分类均为 `256/256` 一致，但仅 `38/256` 全字段一致；DiffHash64 不一致 `171/256`、DctHash64 不一致 `148/256`，共 `218/256` 至少一个哈希不同。
3. 严格 parity 失败后直接拒绝候选；未建设集成扫描开关、未比较不等价执行模型的性能，也未运行 1000 图决赛。
4. Native 格式/限制/生命周期专项回归合计 `53/53` 通过，源快照未变；完整结果见[PREP-015 Native JPEG WIC 影子解码验证](../benchmark/2026-08-22-native-jpeg-shadow-prep015.md)。

## PREP-017 验证结果

1. 每个 CLIP 子进程只允许一个当前 batch 和一个下一 batch；深度固定为 1，tensor 上限 `16 MiB`，只有系统空闲内存至少 `1 GiB` 且未暂停/停止时才领取下一批。DINO、CPU 和 CUDA 未接入本候选。
2. 完整 RawImage 预取在 16 图烟测中使子进程聚合峰值增加约 `400 MiB`，已自动拒绝。最终路径只对三通道输入在解码图中完成最短边 224 的 affine resize，再交给原 processor 中心裁剪和归一化。
3. 16 图共 `2,408,448` 个预处理值逐值一致；首轮 1000 图发现两张 RGBA PNG 的融合插值不等价，门禁自动拦截。修复后非三通道自动回退原解码器，两张边界样本和最终 1000 图向量摘要均完全一致。
4. 256 图三轮交错 A/B 的耗时 P50 为 `35.462/33.659 s`，改善 `5.084%`；候选 P95/最大轮 `33.670 s`，低于基线 `38.180 s`。候选子进程 RSS P50 `1845.04 MiB`，低于基线 `2878.62 MiB`，三轮 fallback 和采样错误均为 0。
5. 1000 图单模型长轮为 `125.756/111.743 s`，改善 `11.143%`；子进程峰值 `3097.85/2067.19 MiB`，GPU 峰值未增加，源快照与完整向量摘要一致。该结果只取得完整 ready 测试资格。
6. 完整 overlap 流水线 256 图三轮 ready P50 为 `79.822/79.413 s`，仅改善 `0.513%`；P95、RSS、VRAM、摘要、fallback、采样和源只读均通过，但最终机器判定因 `p50-improvement-below-5-percent` 为 `reject-and-defer`。
7. 生产默认保持关闭；仅 `REASONIX_EMBEDDING_TENSOR_PREFETCH=1` 可复现实验。完整证据见[PREP-017 CLIP 低内存 Tensor 预取验证](../benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)。

## 机器可读任务表

状态仅使用 `pending`、`in_progress`、`implemented`、`verified`、`deferred`、`blocked`。性能项完成代码但尚未跑完正确性和真实基准时只能标为 `implemented`，不能标为 `verified`。

| Rank | ID       | Scope                     | Mode         | Dependencies                 | Owner      | Status   | Task                                                                                                               | Verification gate                                                                                                                                          |
| ---: | -------- | ------------------------- | ------------ | ---------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | PREP-001 | cross-cutting             | auto         | -                            | Codex/root | verified | 建立当前代码的图片与视频一键准备分阶段基准，记录扫描、抽帧、DINO、CLIP、ANN/帧索引、提交和 UI 可搜索时间           | 固定只读语料；输出写临时目录；至少三轮 P50/P95；记录 CPU/RSS/VRAM/读写字节、数量、失败数和结果摘要；不写真实库                                             |
|    2 | PREP-002 | media/frame extraction    | auto         | PREP-001                     | Codex/root | verified | 将本地逐帧 FFmpeg 启动改为单输入或有界分段批处理；对网络稀疏采样分别比较分组 seek 与现有多输入批量                 | 本地/网络、CFR/VFR、长视频和损坏输入覆盖；时间点、帧数、尺寸、可解码性、失败回退、取消与原子 Manifest 一致；抽帧阶段三轮中位数至少改善 20%，否则保留旧路径 |
|    3 | PREP-003 | media/pipeline            | auto         | PREP-002                     | Codex/root | verified | 以已提交的视频/帧分块为水位线，让 CPU 抽帧与 GPU Embedding 重叠执行，避免等待全库抽帧后才开始 DINO/CLIP            | 部分分块不得提前宣告库 ready；停止/恢复无重复、无漏帧；源变化正确失效；端到端三轮中位数至少改善 10%，其他阶段无超过 3% 的稳定回退                          |
|    4 | PREP-004 | embedding/provider        | approval     | PREP-001                     | 未分配     | pending  | 在许可批准后完成 NVIDIA CUDA 可选运行时的产品入口、状态展示和受控选择，同时保留 DirectML/CPU 回退                  | 30 轮 P50/P95、60 分钟 soak、显存峰值、三轮冷启动、64 张许可明确语料 Recall/邻居重合、篡改/缺失回退全部通过；未经批准不得默认捆绑                          |
|    5 | PREP-005 | image/pipeline            | auto         | PREP-001                     | Codex/root | verified | 把图片一键准备改成基于已提交扫描分块的增量流水线，并允许模型准备与不冲突的扫描阶段重叠                             | generation 边界、active set、断点恢复、取消、失败重试和最终向量数量与串行基线一致；温更新保持零重复推理；稳定端到端收益达到 10% 才启用                     |
|    6 | PREP-006 | embedding/decode          | triggered    | PREP-001, PREP-011           | 未分配     | pending  | 仅当剖析证明图像读取/解码/预处理占模型阶段至少 10% 时，评估一次解码后为 DINO/CLIP 复用有界像素缓冲                 | 保持两模型各自预处理规范；向量有限、单位范数和维度不变；固定语料 Top-K/Recall 不回退；内存预算和低内存回退通过；收益不足则 `deferred`                      |
|    7 | PREP-007 | image/query               | auto         | PREP-001                     | Codex/root | verified | 使用 128 维 Q8 投影把 Image Search ANN 候选限制到 20%，再以原始 768 维 Float16 精确重排                            | 候选 20%；平均 Recall@50 99.88%、最差 98%、查询图第一名 100%；热查询 P95 改善 83.04%；损坏/过期索引继续精确回退                                            |
|    8 | PREP-008 | neko/query                | auto         | PREP-001, PREP-007           | Codex/root | verified | 复用统一 ANN 为 NekoSearch 分类扫描批量生成约 10% 活跃候选，原始 Float16 正负反馈精确评分后继续 DINO 精确重排      | 同集 exact/ANN P95 改善 69.36%；Top-50、人工指标、首位、精确分数、active filter 与负样本语义一致；完整 exact 诊断和异常回退保留                            |
|    9 | PREP-009 | catalog/preparation       | auto         | PREP-001                     | Codex/root | verified | 为全量数据目录增加 append-tail、持久源 fingerprint、未变化分片复用和受影响祖先 rollup 增量更新                     | 无变化向量读取为 0；追加只读 13.5141%，比全量快 76.72%；替换/删除/GC 等正确失效；路径、目录、统计与逻辑 SHA 和全量一致                                     |
|   10 | PREP-010 | video/deep semantics      | triggered    | PREP-001                     | 未分配     | pending  | 若“视频建库”包含 Qwen3-VL 深度语义，增加有界帧证据读取/Base64 LRU 与下一段预取；只在质量门禁通过时评估自适应段合并 | 4 GiB 保持单推理并发；8×10 语义接受率、严格 JSON、时间点和幻觉门禁不回退；缓存受字节上限约束；模型推理仍占绝对多数时不为微小收益扩大结构                   |
|   11 | PREP-011 | cross-cutting/telemetry   | auto         | PREP-005                     | Codex/root | verified | 细分 Native 枚举/反压/读取/解码/hash/提交及 DINO/CLIP 读取/预处理/推理/持久化时间，并补跑修复后的完整资源曲线      | 256 图三轮遥测 P50 开销 +0.149%，摘要一致；1000 图 1187 个资源样本、0 错误且无需检查点恢复；时间线不含源路径                                               |
|   12 | PREP-012 | embedding/policy          | auto         | PREP-011                     | Codex/root | deferred | 在固定分层语料上比较 DINO/CLIP 的 jobs 1/2 与 batch 4/8/16，为两个模型独立选择受内存约束的 DirectML 自动组合       | 三轮 256 图当前组合分别快 80.71%/44.03%；更大 batch 未过资源门禁，无 ≥5% 候选，故不进入 1000 图决赛且不改 `auto`                                           |
|   13 | PREP-013 | embedding/prefetch        | triggered    | PREP-011                     | Codex/root | deferred | 若单模型读取/解码/预处理占稳定阶段至少 10%，以深度 2 的有界双缓冲让下一 batch 预处理与当前 batch 推理重叠          | 占比已触发，但当前 jobs=2 最低空闲约 315 MiB、长轮最低 3.97 MiB；两个低风险影子候选无收益，完整 RawImage 双缓冲不满足资源门禁                              |
|   14 | PREP-014 | image/resource schedule   | experimental | PREP-011, PREP-012           | Codex/root | deferred | 已比较 Native worker 2/3/4 与 embedding jobs 1/2；当前 `scan=3,jobs=2,batch=4` 仍是最快合格组合                    | 18 轮 parity 和资源采样通过；其余可比组合慢 22.30%–49.32%，scan=4 被资源策略限制，无 ≥5% 候选，故不进入 1000 图决赛                                        |
|   15 | PREP-015 | native/decode             | triggered    | PREP-011                     | Codex/root | deferred | 已影子评估 JPEG WIC/缩放候选；不接入现有扫描路径                                                                   | 宽高/通道/成功分类一致，但 218/256 至少一个双哈希字段不一致；严格 parity 失败，候选拒绝且生产继续使用 SEH/stb                                              |
|   16 | PREP-016 | scan/usn                  | approval     | PREP-011                     | 未分配     | deferred | 当前 `D:` USN 权限不足；只在温更新大目录证明纯发现占比显著且用户接受权限方案时重评，不为冷首建安装提权 helper      | 默认非管理员路径必须完整可用；不得新增静默提权；冷/温扫描数量与失效一致；没有明确净收益和权限批准时保持 `deferred`                                         |
|   17 | PREP-017 | embedding/tensor-prefetch | experimental | PREP-011, PREP-013, PREP-014 | Codex/root | deferred | 三通道 CLIP 输入融合解码到最短边 224，并以每子进程一个下一 batch 的上限和原 processor tensor 重叠 DirectML 推理    | 单模型 256 图 +5.084%、1000 图 +11.143%，但完整 ready P50 仅 +0.513%；摘要/资源/回退通过；未达 5% 门槛，生产默认关闭                                       |

## 推荐执行顺序

1. `PREP-001` 已把两个“一键准备”链路的同机同语料阶段数据补齐，后续继续使用该固定基线。
2. `PREP-002` 已完成视频抽帧 A/B；本地启用候选，网络保留旧路径。
3. `PREP-003` 已在原子检查点和精确最终覆盖上启用 CPU/GPU 重叠。
4. `PREP-005` 已启用图片 committed-path/DINO 重叠，并保留最终精确覆盖与向量索引栅栏。
5. `PREP-011` 已补齐 Native 与 DINO/CLIP 内部阶段、队列反压和修复后长时资源曲线；详细指标默认关闭，只增加去标识诊断，不改调度。
6. `PREP-012` 已完成模型独立的 DirectML batch/worker 三轮筛选；没有 ≥5% 入围候选，1000 图决赛不适用，显式参数、`auto` 和 batch 4 回退均未修改。
7. `PREP-013` 已因当前内存证据暂缓；`PREP-015` 已完成 WIC/stb 影子比较并因 `218/256` 双哈希不一致拒绝；既有 `PREP-006` 仍需独立 A/B、质量与资源门禁。
8. `PREP-014` 已完成 18 轮完整流水线联合矩阵，没有 ≥5% 候选，当前 `scan=3,jobs=2,batch=4` 保持不变。
9. `PREP-004` 继续等待 provider 分发批准；CUDA 分发审批与技术实现保持分离。
10. `PREP-016` 保持暂缓，不为当前冷首建要求管理员权限或新增提权服务。
11. `PREP-007`、`PREP-008` 和 `PREP-009` 已分别完成 Image Search、NekoSearch 与素材库增量目录门禁；不重复优化低于秒级的索引提交。
12. `PREP-010` 独立于普通“准备素材库”；不得用减少语义证据或提高 4 GiB GPU 并发换速度。
13. `PREP-017` 已按“小样本 parity → 单模型 256 图三轮 → 1000 图长轮 → 完整 ready 256 图三轮”自动完成；Alpha 差异被门禁拦截并修复，但最终 ready 收益仅 0.513%，故默认关闭并 `deferred`。

## 统一验收门禁

### 正确性与功能

1. 图片 Native 记录、DINO/CLIP 向量覆盖、ANN 行数和 active set 与基线一致；无重复、无漏项、无错误 tombstone 复活。
2. 视频计划时间点、frameId、Manifest 状态、源视频映射和搜索命中聚合语义保持一致。
3. 暂停、停止、应用退出、重启恢复、磁盘满、损坏媒体、模型失败及 provider 回退均有回归覆盖。
4. 旧缓存、旧索引和旧任务可继续读取或安全重建；不得静默改变用户数据格式。

### 性能与资源

1. 固定硬件、固定语料、固定电源模式下至少三轮；报告中位数、P95 和单轮最大值，不只选择最快一次。
2. 同时记录墙钟时间、CPU、RSS、GPU/VRAM、磁盘读取、子进程数和失败/重试数。
3. 默认把小于 3% 的差异视为噪声；低于任务表收益门槛的复杂实现不得默认启用。
4. 提速不得造成不可控内存增长、显存争抢、机械盘随机 I/O 放大或前台搜索明显卡顿。
5. 所有真实素材只读，输出使用受控临时目录；测试结束只能清理本次生成且路径验证通过的临时数据。

### 搜索质量

1. ANN 只负责候选召回，最终结果继续精确重排；索引不可用时保留精确兜底。
2. DINO/CLIP provider 或预处理变化必须通过向量 parity、Top-K 邻居重合和 Recall 门禁。
3. 视频抽帧实现变化必须对 CFR、VFR、短视频、长视频和关键帧稀疏视频验证时间点与搜索召回。
4. Qwen3-VL 相关性能变化继续使用既有 8×10 人工语义门禁，不得只凭严格 JSON 或耗时放行。

## 验证命令入口

下列入口均默认使用隔离输出；不得让 benchmark 写入真实 `userData`。

```powershell
npm.cmd run benchmark:image-search-simple
npm.cmd run benchmark:image-search-simple-embeddings
npm.cmd run benchmark:image-search-simple-e2e
npm.cmd run benchmark:image-search:embedding-prefetch:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep017-e2e-256"
npm.cmd run benchmark:image-search:preparation:ab -- --runs=3 --sample=16 --backend=gpu --jobs=2 --batch-size=4
npm.cmd run benchmark:image-search:preparation:ab -- --dataset="D:\PxHereDataset\images\pxhere-000000" --runs=3 --sample=1000 --backend=gpu --jobs=2 --batch-size=4 --timeout-ms=1800000
npm.cmd run benchmark:image-search:preparation:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\<timestamp>"
npm.cmd run benchmark:image-search:joint-scheduling -- --dataset="D:\PxHereDataset\images\pxhere-000000" --sample=256 --rounds=3 --scan-workers=2,3,4 --embedding-jobs=1,2 --batch-size=4 --backend=gpu
npm.cmd run benchmark:image-search:joint-scheduling:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\<timestamp>"
npm.cmd run benchmark:image-search:jpeg-shadow -- "D:\PxHereDataset\images\pxhere-000000" --sample=256 --scan-workers=3
npm.cmd run benchmark:search-library-preparation -- --image-sample=16 --video-limit=3 --runs=3 --backend=gpu --jobs=2 --batch-size=4
npm.cmd run benchmark:media-search
npm.cmd run benchmark:media-search:preparation -- --help
npm.cmd run benchmark:media-search:preparation:ab -- --runs=3 --backend=gpu --jobs=2 --batch-size=4 --fixture-cfr-seconds=120 --fixture-vfr-seconds=90 --interval-ms=3000 --width=256
npm.cmd run benchmark:video-frame-extraction:ab -- --runs=3 --fixture-seconds=120 --width=256
npm.cmd run benchmark:media-search:ipc-scan
npm.cmd run benchmark:media-search:vectors
npm.cmd run benchmark:media-search:manifests
npm.cmd run benchmark:media-search:recall
npm.cmd run benchmark:vector-ann:prep007
npm.cmd run benchmark:neko-search:prep008
npm.cmd run benchmark:data-catalog:prep009
npm.cmd run benchmark:embedding-provider-poc -- --help
npm.cmd run benchmark:neko-search:accuracy
node --test tests/search-library-preparation-benchmark.test.cjs
node --test tests/clip-image-decode.test.cjs tests/embedding-tensor-prefetch.test.cjs tests/embedding-tensor-prefetch-analysis.test.cjs
node --test tests/video-frame-extraction.test.cjs
node --test tests/video-frame-checkpoint.test.cjs tests/media-preparation-pipeline.test.cjs tests/image-preparation-pipeline.test.cjs

npm.cmd run test:media-search
npm.cmd run test:vector-pipeline
npm.cmd run test:vector-ann
npm.cmd run test:architecture
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
```

## 本次文档验证

| 项目               | 结果                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前代码入口复核   | 通过：对照图片简单模式 deferred thumbnail、视频有界单输入/网络多输入策略、Embedding 与索引提交                                                                                                                                                            |
| 基准工具单测       | 通过：PREP-001/002/003/005/009/011/012/014/015 runner、资源采样与聚合入口安全；向量 parity 使用既有固定门槛                                                                                                                                               |
| 隔离性能与质量门禁 | 通过：PREP-002 +55.53%；PREP-003 +15.37%；PREP-005 小语料 +15.55%、1000 图 +17.08%；PREP-007 +83.04%；PREP-008 +69.36%；PREP-009 追加 +76.72%；PREP-011 +0.149%；PREP-012/014 保留当前策略；PREP-015 拒绝；PREP-017 因完整 ready 仅 +0.513% 而 `deferred` |
| 正确性与安全       | 通过：检查点、revision、取消所有权、双模型覆盖、ANN 精确回退、源只读、目录 append/失效与逐行全量 parity；WIC 哈希差异未进入生产                                                                                                                           |
| 结构与拆分后冒烟   | 通过：既有热文件上限未放宽；主进程图保持 283/283；目录 67/67、向量流水线 235 通过且 2 跳过                                                                                                                                                                |
| 文档规范与相对链接 | 通过：文档标准、目标文件 Prettier/ESLint/TypeScript 与 `git diff --check` 均通过                                                                                                                                                                          |
| 生产代码与用户数据 | 已修改准备调度、检查点、committed feed、ANN 候选和可重建目录 v2；未改权威格式或真实用户数据                                                                                                                                                               |
| 提交               | 未创建：共享工作区存在范围外未提交改动                                                                                                                                                                                                                    |

## 状态更新规则

1. 开始任务时补充执行系统、带来源所有者、分支/worktree 和精确文件范围，再把状态改为 `in_progress`。
2. 代码完成但仅通过单测时标为 `implemented`；跑完任务表对应的真实性能与质量门禁后才标为 `verified`。
3. 外部批准未完成只能标为 `blocked`，不得把技术可行性写成许可或发布批准。
4. 方案没有稳定收益或资源代价过高时标为 `deferred`，保留 A/B 数据和拒绝原因，不继续堆叠并发参数。
5. 每次状态变化同步更新本文日期、验证记录和 `docs/README.md`；事实冲突时采用当前代码与本次测试结果优先。
