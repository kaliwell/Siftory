# PREP-008 NekoSearch ANN 候选与精确重排验证

> 状态：已验证  
> 日期：2026-08-22  
> 范围：素材库分类样本搜索和聚类准备中的 CLIP 候选扫描  
> 权威产物：`artifacts/benchmark/neko-ann-prep008/latest.json`

## 结论

PREP-008 已通过同机、同一真实活跃集上的三轮受控 A/B。NekoSearch 默认复用统一 ANN worker，以 4 个正样本中心批量召回约 10% 活跃 CLIP 行，再读取原始 512 维 Float16 向量执行既有正负反馈精确评分；之后的 DINO 精确重排、稳定排序和返回数量保持不变。完整 CLIP 精确扫描仍可由任务选项或 `FLOATING_CLOCK_NEKO_EXACT_SCAN=1` 启用，也继续作为任何 ANN 异常、空召回或索引不可用时的自动兜底。

最终三轮的完整 CLIP 扫描 P50/P95 为 5,184.71/5,267.35 ms，ANN 候选加精确评分为 1,573.32/1,613.74 ms，P95 改善 69.36%。Top-20 和 Top-50 与精确结果完全一致，Top-100 重合 99%，首位一致率 100%；人工标注指标、公共结果的精确分数、负样本抑制和 active filter 均无回退。

## 生产实现

1. CLIP F16 缓存准备接口可同时返回完整只读 handle 和 worker 文件描述符，NekoSearch 不再为接入 ANN 重建另一份向量快照。
2. 同一分类最多 4 个反馈中心通过一次 `search-batch` 请求进入统一 ANN worker。缓存、最新有效行和 active scope 只构造一次，避免逐中心重复传输 26.6 万条 scope。
3. NekoSearch 使用独立的 10% 候选比例；Image Search 的 PREP-007 默认值仍为 20%，两条产品路径没有互相改变质量策略。
4. ANN 只返回候选行。分类 worker 重新从原始 CLIP Float16 缓存读取这些行，并继续调用既有 `scoreAssetFeedbackTarget`，因此正中心、多模态正样本、目标级负样本和稳定 tie-break 语义不变。
5. CLIP 精确评分后仍保留最多 1,000–20,000 个粗候选，再按原有 DINO 正负原型做精确重排。ANN 不提供最终展示分数，也不绕过 DINO。
6. active path key 在 ANN 候选生成前过滤；worker 对候选行再次做边界校验并只接受 eligible asset。取消标志贯穿缓存准备、ANN worker、CLIP 精确评分和 DINO 重排。
7. ANN worker 缺失、过期、损坏、批量结果数量不一致、召回为空或其他异常时，任务记录警告并自动执行原来的完整精确扫描。环境变量 `FLOATING_CLOCK_NEKO_EXACT_SCAN=1` 可强制诊断路径。
8. IPC 结果只新增可选诊断字段：扫描模式、ANN 唯一候选数、CLIP 粗候选数和索引行数；未改变既有命中、反馈或聚类合同。

## 正式 A/B

执行命令：

```powershell
npm.cmd run benchmark:neko-search:prep008
```

固定输入为 440,462 条真实 CLIP F16 向量、266,001 个活跃素材、一个已完整审核分类（73 个正样本、62 个负样本）、4 个反馈中心、最终 Top-100 和每中心 Top-1,000。真实向量与路径索引以硬链接只读挂载到固定前缀临时目录；派生 ANN 只写临时目录。运行前后对向量、路径、meta、素材清单、标注集和判断集做大小、mtime 与分段 SHA-256 快照。

| 指标 | 门槛 | 最终结果 | 状态 |
| --- | ---: | ---: | --- |
| Top-20 / Top-50 重合 | Top-50 ≥ 98% | 100% / 100% | 通过 |
| Top-100 重合 | 记录 | 99% | 记录 |
| 首位一致率 | 100% | 100% | 通过 |
| 公共结果最大精确分数误差 | ≤ 0.000001 | 0 | 通过 |
| Precision@20 / Precision@50 | 下降 ≤ 2pt | 1 / 1，零下降 | 通过 |
| Recall@50 | 下降 ≤ 1pt | 0.6849，零下降 | 通过 |
| nDCG@20 | 相对下降 ≤ 2% | 1，零下降 | 通过 |
| Reject intrusion@20 | 上升 ≤ 1pt | 0，零上升 | 通过 |
| active filter 违规 | 0 | 0 | 通过 |
| 精确 / ANN P95 | ANN 至少改善 30% | 5,267.35 / 1,613.74 ms，改善 69.36% | 通过 |
| 源输入不变 | 必须 | `true` | 通过 |
| 派生输出隔离 | 必须 | `true` | 通过 |

最终归档为 `artifacts/benchmark/neko-ann-prep008/2026-08-22_08-11-00-405/report.json`。ANN 每中心内部候选约 26,204 行，相当于完整索引的 5.95%、当前活跃集的 9.85%；4 个中心合并为 3,436 个唯一精确评分行。候选召回 P95 为 1,369.80 ms，原始 Float16 精确评分 P95 为 243.81 ms。隔离预热为 3,756.74 ms；预热后的进程 RSS 为 1,341.15 MiB，相对测量点增加 609.76 MiB，该值包含完整 CLIP F16 快照、路径、旧派生签名和 Q8 投影，并非 PREP-008 独占净增量。

## 被拒迭代

首个实现为每个中心顺序调用 ANN，并沿用 20% 活跃候选。归档 `2026-08-22_08-03-58-966` 的质量完全一致，但 P95 只改善 25.32%，低于 30% 门槛，因此未启用。将 NekoSearch 候选收敛到 10% 后，顺序版本 `2026-08-22_08-05-52-412` 刚好达到 30.80%；随后增加批量查询，让 4 个中心共享缓存和 active scope，最终把改善扩大到 69.36%。

## 完整精确诊断

另行执行：

```powershell
npm.cmd run benchmark:neko-search:accuracy -- --gate
```

完整 CLIP+DINO exact 工具链成功跑完 6 个扫描样本。当前主变体 `hybrid` 的 Precision@20、Precision@50 和 nDCG@20 均为 1，Recall@50 为 0.6410，Reject intrusion@20 为 0；warm exact P95 为 17,791.8 ms。命令最终退出为门禁失败，唯一原因是当前活跃集为 266,001 条，指纹与 2026-07-30 基线的 245,171 条不同。该结果只能证明完整诊断链可运行以及当前绝对质量正常，不能伪装成跨数据集性能/质量对比通过；本报告的通过判定来自同一当前活跃集上的 exact/ANN 受控 A/B。

## 回归覆盖

- `npm.cmd run test:vector-ann`：40/40 通过，包含批量查询、共享 scope、候选比例、取消、损坏/过期索引和精确回退合同。
- `npm.cmd run test:asset-library`：141/141 通过，包含 ANN 预筛与完整 CLIP 精确评分一致、active filter、负反馈和 DINO worker 合同。
- `npm.cmd run test:neko-search-cluster`：27/27 通过。
- `npm.cmd run test:unified-search`：57/57 通过。
- `npm.cmd run test:vector-pipeline`：235 通过、2 个依赖外部 CUDA fixture 的用例按设计跳过、0 失败。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`、`npm.cmd run test:architecture`：通过；主进程构建图保持 283/283，没有为复用 ANN 放宽预算。

## 边界

1. 正式 A/B 刻意让 exact 和 ANN 两侧都停在变更边界后的 CLIP 精确评分，用来隔离验证候选生成；完整 DINO/hybrid 链由独立 exact 门禁验证。未来改变 DINO 候选数、权重或评分函数时，必须增加包含 DINO 的新受控 A/B，不能沿用本报告。
2. 当前人工数据只有一个完整审核分类，10% 是保守的产品默认值；在增加多分类标注前不得继续下调。
3. 完整 exact 模式是诊断与安全回退，不是默认性能路径。数据集发生变化时必须重新建立可比基线或做同一快照的 before/after，不能直接覆盖旧基线。
4. 本次没有改写 CLIP/DINO 源向量、素材元数据、标注数据、既有 ANN 文件格式或用户源素材。
