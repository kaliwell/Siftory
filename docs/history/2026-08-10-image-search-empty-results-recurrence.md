# 2026-08-10 以图搜图空结果复发事件

> 状态：历史快照
> 更新日期：2026-08-10
> 范围：Image Search Standard/Precise、DINO F16/ANN 首次缓存准备
> 执行系统：Codex
> 模型信息：GPT-5 系列；精确版本未公开
> 关联事件：[2026-07-30 以图搜图空结果事件](2026-07-30-image-search-empty-results-incident.md)
> 修复提交：`9b30927`

## 摘要

2026-08-10 用户报告 Image Search“相似搜索没有结果，语义搜索有结果”。只读检查确认 Native 图片数据和 DINO embedding 均存在，故障集中在 DINO 大库首次搜索缓存准备阶段：当前没有可用的 DINO F16 缓存，Standard/Precise 查询需要从约 6.8 GB 的 DINO JSONL 创建缓存，但旧代码把缓存创建也纳入默认 30 秒查询超时。任务每次尚未完成就被取消，随后退化为 Hash-only；普通视觉相似图片没有近重复 Hash 候选时，界面最终显示空结果。

提交 `9b30927` 取消普通交互查询的隐式截止时间，只在调用方明确传入 `timeoutMs` 时执行超时；用户仍可通过“停止搜索”主动取消。修复合入并重启应用后，用户确认问题解决。

## 影响

- 影响入口：简单模式的图片相似搜索，以及高级模式的 Standard/Precise 图片搜索。
- 典型表现：语义搜索能够返回结果，但使用查询图片搜索时结果为空。
- 未受影响：CLIP 语义检索、DINO embedding 生成结果、用户原始图片和 Native 索引数据。
- 数据安全：诊断过程只读检查用户数据；修复未删除、迁移或重写用户图片与权威向量 JSONL。

## 现场证据

| 项目 | 现场值 | 结论 |
| --- | ---: | --- |
| DINO JSONL | 6,799,781,187 bytes；411,636 个物理记录行 | DINO 向量源存在且规模较大 |
| CLIP JSONL | 642,132,717 bytes；57,953 个物理记录行 | 语义检索数据存在 |
| CLIP F16 元数据 | 57,953 条 | CLIP 已有可直接使用的搜索缓存 |
| DINO F16 缓存 | 不存在 | DINO 首次相似搜索必须准备派生缓存 |
| 旧向量 manifest | 2,652 条 | manifest 明显早于当前 DINO 数据；它是陈旧信号，但不是本次大库检索的数据源 |
| DINO 最近构建诊断 | completed 353,683；failed 615；skipped 54,779 | embedding 构建已完成，空结果并非“没有生成 DINO 向量” |

按当前 411,636 条、768 维 Float16 估算，仅向量主体约为 603 MiB，另有路径索引和 ANN 派生文件。该准备工作不可能稳定地在 30 秒内完成。

## 根因链

1. `electron/rerankService.ts` 的 `searchLayered` 启动 DINO 查询向量生成和 `searchVectorIndex`。
2. `electron/vectorIndexService.ts` 检测到 embedding 源超过内存索引阈值，进入 F16/ANN 搜索路径。
3. 现场没有 DINO F16 缓存，`searchF16Embeddings` 调用 `ensureEmbeddingF16Cache` 从 6.8 GB JSONL 首次生成缓存。
4. `searchLayered` 使用 `req.timeoutMs ?? 30000` 包裹整个向量 Promise，缓存准备也被计入 30 秒。
5. 超时把 `timedOut` 设为真；同一个 `isCancelled` 回调使缓存生成中止，临时结果不能成为下一次查询的可复用缓存。
6. 下一次相似搜索再次从零开始，并再次在 30 秒后取消，因此故障可以无限重复。
7. 超时后搜索降级为 Hash-only。查询图若没有近重复 Hash 候选，合并候选数为 0，最终无结果。
8. CLIP 已有完整 F16 缓存，所以语义搜索不经过上述首次准备瓶颈，形成“语义有结果、相似无结果”的差异。

## 与 2026-07-30 事件的关系

两次事件的共同点是：交互搜索生命周期与数 GiB DINO 派生缓存准备耦合，固定 30 秒超时会把可恢复的准备过程变成稳定空结果。

2026-07-30 的现场存在一份结构完整但相对源 JSONL 过期的 DINO 缓存，当时的修复重点是允许交互搜索复用最后一份完整缓存。本次现场完全没有 DINO F16 缓存，因此“复用旧缓存”没有可用对象，仍会触发首次生成并被超时取消。这说明旧防回归规则没有覆盖“源数据存在但派生缓存缺失”的状态。

## 修复

提交 `9b30927` 包含以下修改：

1. 在 `electron/rerankService.ts` 增加 `waitForVectorSearch`，将超时策略集中为可测试函数。
2. 未提供 `timeoutMs` 时不再创建隐式 30 秒计时器，让首次 F16/ANN 缓存准备能够完成。
3. 只有调用方显式传入正数 `timeoutMs` 时才执行超时，并保留 Hash-only 降级行为。
4. 保留原有搜索序列取消机制；用户点击“停止搜索”仍会使 `isCancelled` 生效。
5. 在 `shared/vectorTypes.ts` 明确 `timeoutMs` 的契约：省略表示无截止时间、但仍可由用户取消。
6. 将 `tests/rerank-cascade.test.cjs` 纳入 `test:vector-pipeline`，锁定“无隐式超时、显式截止仍有效”的行为。

## 验证

| 项目 | 命令或证据 | 结果 |
| --- | --- | --- |
| 现场数据检查 | PowerShell 只读统计 DINO/CLIP JSONL、F16 元数据和诊断日志 | 通过；确认 DINO 缓存缺失与数据规模 |
| 专项测试 | `node --test tests/rerank-cascade.test.cjs` | 3/3 通过 |
| 向量管线 | `npm.cmd run test:vector-pipeline` | 203 项：201 通过、2 项因 CUDA fixture 环境跳过 |
| TypeScript | `npm.cmd run typecheck` | 通过 |
| Lint | 相关文件专项 ESLint；提交快照全量 `npm.cmd run lint` | 通过 |
| 格式 | 提交快照 `npm.cmd run format:check` | 通过 |
| 构建 | `npm.cmd run build:renderer` | 通过；Renderer、Electron 主进程及 DINO/CLIP 子进程均成功构建 |
| 用户验收 | 修复合入、重启并复测相似搜索 | 通过；用户明确确认“解决了” |

未执行完整安装包 smoke 和 `npm.cmd test` 全套；本次边界由相关向量管线、生产构建与真实界面用户验收覆盖。

## 防回归规则

1. DINO 回归必须覆盖三种缓存状态：缓存新鲜、缓存过期但完整、缓存完全缺失。
2. 交互查询不得使用短固定超时反复取消无法在该时限内完成且无法续做的派生数据准备。
3. 若调用方需要截止时间，必须显式提供 `timeoutMs`，并在 UI 中保留可见的降级原因。
4. 用户主动停止和系统超时必须保持不同语义：默认长准备可由用户停止，但不能被隐藏的 30 秒计时器取消。
5. “语义有结果、相似无结果”应优先对比 CLIP/DINO 的缓存存在性、缓存记录数和源文件新鲜度，不应直接重建或删除权威数据。
6. 真实诊断先使用只读探针；不得因为 manifest 陈旧就删除 embedding、F16 或 ANN 文件。

## 剩余风险与后续建议

- 当前修复保证首次缓存最终能够完成，但首次搜索仍承担约 600 MiB DINO 缓存和 ANN 的准备等待，用户体验取决于磁盘吞吐。
- 更完整的长期方案是：DINO embedding 构建结束后后台刷新 F16/ANN，或提供明确的“准备相似搜索索引”阶段，使交互查询只消费已完成快照。
- 进度 UI 后续应区分“生成查询向量”“创建 F16 缓存”“构建 ANN”“检索候选”，避免长时间显示笼统的“向量搜索”。
- `vector_index_manifest.json` 的 2,652 条陈旧计数容易误导诊断；应评估在 embedding 构建完成或大库缓存提交后更新其状态，但不得把 manifest 当成权威向量计数。

## 时间线

1. 2026-08-10：用户报告“图片搜索相似搜索没有结果，语义有结果”。
2. 只读诊断确认 DINO/CLIP 源数据存在，DINO 最近构建已完成。
3. 缓存目录确认只有 CLIP F16，DINO F16 缺失；结合 30 秒默认超时定位根因。
4. 提交 `9b30927` 完成超时策略修复、契约说明和回归测试。
5. 修复通过向量测试、类型检查、Lint 和生产构建后快进合并到 `main`。
6. 用户重启并复测，确认问题解决，事件关闭。
