# NekoSearch AI 审核反馈驱动个性化搜索方案

> 状态：部分实施，默认关闭  
> 版本：1.1  
> 更新日期：2026-07-17  
> 范围：NekoSearch、Image Search、Vector Retrieval、AI Suggestions  
> 当前实现：[NekoSearch 当前实施基线](../current/2026-07-14-neko-search-implementation.md)  
> 专项审计：[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)  
> 上游方案：[NekoSearch 智能素材分类方案](2026-07-09-neko-search-classification-plan.md)  
> 替代文档：无

## 快速导航

1. [结论](#1-结论)
2. [目标与非目标](#3-目标与非目标)
3. [反馈语义](#5-反馈语义)
4. [架构与数据流](#6-架构与数据流)
5. [算法方案](#7-算法方案)
6. [数据结构与 IPC](#8-数据结构与-ipc)
7. [性能与失败恢复](#10-性能与失败恢复)
8. [实施阶段](#13-实施阶段)
9. [验收标准](#14-验收标准)

## 1. 结论

当前 `AI Suggestions` 已经提供 `Accept`、`Reject`、`Ignore` 和 `Undo Accept`，因此第一阶段不应在搜索结果中再增加一套重复的“相关/不相关”按钮。

推荐新增一层“审核反馈搜索模型”，把现有审核结果转化为分类或标签范围内的正负样本，并接入 Image Search 的全库召回与精排：

```text
全库 CLIP/DINO/Hash 基础召回
  + 已确认分类/标签的多中心补召回
  + Accept 正样本提升
  + Reject 目标级负样本抑制
  -> 有界个性化精排
  -> TopK 搜索结果
```

该方案不重新训练完整 CLIP/DINO，不重新生成全库 embedding，不把搜索范围限制为已分类素材，也不改变现有 AI Suggestions 审核交互。审核数据只作为可删除、可重建、可关闭的本地个性化层。

## 2. 当前能力与缺口

### 2.1 已有能力

| 能力 | 当前模块 | 可复用内容 |
| --- | --- | --- |
| AI 建议审核 | `electron/assetLibraryService.ts` | `reviewAssetSuggestions()`、`undoAssetSuggestions()` |
| 分类正关系 | `asset_categories.jsonl` | `confirmed`、`manual_override`、`confirmedByUser` |
| 标签正关系 | `asset_tags.jsonl` | 已确认标签与来源、置信度 |
| 拒绝关系 | `suggestions.jsonl` | `rejected` 状态及 category/tag 目标 |
| 素材元数据 | `electron/assetMetadataStore.ts` | 稳定素材 ID、路径、missing/archived 状态 |
| CLIP 文本检索 | `electron/semanticSearchService.ts` | 全库 CLIP embedding 扫描、TopK 堆、进度 |
| DINO 以图搜图 | `electron/rerankService.ts` | Hash、DINO、颜色和形状候选合并与精排 |
| 向量分片 | `electron/assetLibraryEmbeddingSource.ts` | 流式读取现有 DINO/CLIP shards |
| 模型与 GPU | Vector/Embedding 服务 | CLIP/DINO 推理、CPU/GPU 后端与模型状态 |
| 固定样本测试 | `tests/`、`docs/benchmark/` | Recall、人工标注、性能基准的现有结构 |

### 2.2 当前缺口

P0/P1 首轮已把审核与 CLIP 文本搜索连接起来：

1. `Accept`、`Reject`、`Undo Accept` 和手动关系变化会递增 feedback revision。
2. 反馈模型从已确认分类/标签和目标级 Reject 构建有界正负多中心。
3. `searchSemanticImages()` 在可靠匹配分类/标签名称时可补候选并执行 `±0.12` 有界重排。
4. 无模型、模型损坏、目标未激活或设置关闭时保持基础 CLIP 搜索。

当前缺口：DINO 以图搜图尚未接入；没有独立真实标注集 A/B；`force` mode 没有独立的 Image Search 查询语义。2026-07-16 已完成默认关闭和 NekoSearch `Learning` 显式开关，固定门禁通过前不自动为新资料库启用。同日补充 Category 显式样本搜索：它直接选择目标分类并使用审核后的正负原型扫描全库，不依赖文本目标激活，也不受 `Learning` 开关控制。

## 3. 目标与非目标

### 3.1 目标

1. 复用现有 `Accept/Reject/Undo Accept`，不增加重复审核入口。
2. 让人工确认样本改善分类词、标签词和相近查询的搜索准确率。
3. 保持所有有效 embedding 参与基础召回或 ANN 检索。
4. 支持多外观、多场景分类，不使用单一平均向量压扁类别。
5. 使用 Reject 作为目标级负样本，降低错误结果反复出现概率。
6. 审核变化后增量标脏并后台更新，搜索不中断。
7. 个性化层失效时自动退回当前基础搜索，不让搜索不可用。
8. 提供可复现的准确率与性能基准，只有实测提升后才默认启用。

### 3.2 非目标

1. 第一阶段不微调整个 CLIP、DINO 或视觉 Transformer。
2. 不把未分类素材自动视为负样本。
3. 不把 Reject 理解为“该图片对所有查询都不相关”。
4. 不使用未经用户确认的 `suggested` 或 `low_confidence` 数据训练。
5. 不删除、移动或覆盖原始图片与现有 embedding shards。
6. 不在 Renderer 中执行向量计算或读取本地向量文件。
7. 不承诺改善所有任意文本查询；个性化只在可靠匹配到分类/标签时介入。

## 4. 设计原则

1. **基础召回优先**：个性化层只能补召回和重排，不能替代全库 CLIP/DINO 搜索。
2. **目标级反馈**：正负样本必须绑定 `categoryId` 或 `tagId`。
3. **人工优先**：手动分类和参考图权重高于 AI 建议确认。
4. **负反馈保守**：Reject 只抑制对应目标，不传播到其他类别。
5. **多中心表达**：一个分类允许多个视觉原型，避免人物、角度和背景被平均掉。
6. **有界影响**：反馈分数设置最大提升和最大降权，避免错误模型覆盖基础语义。
7. **派生数据可重建**：反馈模型不是事实源，删除模型目录后可从审核数据完整重建。
8. **可观测和可回滚**：每次搜索记录是否应用反馈、模型版本、耗时和降级原因。

## 5. 反馈语义

### 5.1 正样本

| 来源 | 作为正样本 | 建议初始权重 |
| --- | --- | --- |
| 手动分类/标签 | 是 | `1.00` |
| 用户指定的分类参考图 | 是 | `1.00` |
| AI Suggestion 经用户 Accept | 是 | `0.85` |
| 用户确认的聚类转分类 | 是 | `0.75` |
| 未确认 AI suggestion | 否 | `0` |

权重是初始建议值，必须通过固定样本集校准，不作为不可修改常量。

### 5.2 负样本

`Reject` 只产生一个目标级负样本：

```text
(assetId, categoryId, negative)
```

或：

```text
(assetId, tagId, negative)
```

例如，用户拒绝“图片 A 属于白底产品图”，只能说明 A 是“白底产品图”的负样本，不能推断 A 不是“数码产品”“桌面场景”或其他标签。

### 5.3 不参与学习的状态

- `ignored`
- `suggested`
- `low_confidence`
- 已移除或 missing 的素材
- 缺少目标分类/标签的无效建议
- embedding 模型或维度与当前模型不匹配的记录

### 5.4 撤销和修改

1. `Undo Accept` 删除对应 AI 正关系后，反馈模型 revision 必须递增。
2. Reject 改为 Accept 时，先移除负样本，再加入正样本。
3. 分类或标签被删除时，对应反馈模型必须删除。
4. 分类重命名不会改变图片原型，但必须重建文本标签向量。
5. 素材软删除时从模型中排除；恢复后重新纳入。

## 6. 架构与数据流

### 6.1 模块边界

```text
AI Suggestions / manual assignments
  -> AssetFeedbackSource
  -> FeedbackModelBuilder (background task)
  -> FeedbackModelStore (atomic snapshot)
  -> PersonalizedRerankService
  -> semanticSearchService / rerankService
  -> Image Search results + score reasons
```

建议新增：

```text
electron/assetFeedbackSource.ts
electron/assetFeedbackModelBuilder.ts
electron/assetFeedbackModelStore.ts
electron/personalizedRerankService.ts
electron/assetFeedbackIpc.ts
shared/ipc/asset-feedback.ts
tests/asset-feedback-model.test.cjs
tests/asset-feedback-search.test.cjs
```

首轮实现按现有模块边界收敛为：

```text
electron/assetFeedbackModel.ts          # 目标激活、多原型构建、有界反馈评分
electron/assetFeedbackModelService.ts   # revision、原子快照、旧模型热回退、构建调度
electron/assetLibraryEmbeddingSource.ts # 从现有 CLIP 二进制缓存按路径读取向量
electron/assetLibraryService.ts         # 事实快照、标脏与 15 秒防抖重建
electron/semanticSearchService.ts       # 全库扫描、原型补候选和反馈精排
shared/ipc/asset-feedback.ts            # 状态和 IPC 类型
tests/asset-feedback-model.test.cjs     # 目标激活、多原型和正负反馈边界
```

没有为了文件名与方案完全一致而增加仅转发的空模块；IPC 继续复用现有
`assetLibraryIpc.ts`，事实抽取留在素材库服务，算法和派生模型存储保持独立。

`electron/assetLibraryService.ts` 只负责在审核完成后通知反馈服务标脏，不继续承载训练和搜索算法。

### 6.2 审核更新数据流

```text
User Accept / Reject / Undo
  -> assetLibrary:* IPC guard
  -> reviewAssetSuggestions / undoAssetSuggestions
  -> flush suggestions + assignments
  -> increment feedbackRevision
  -> mark feedback model dirty
  -> debounce background rebuild
  -> write temporary snapshot
  -> validate snapshot
  -> atomic rename + hot swap
```

数据库关系必须先成功持久化，再更新 revision。反馈模型构建失败不能回滚用户审核，只保留旧模型并显示 `dirty/error`。

### 6.3 文本搜索数据流

```text
Text query
  -> CLIP text embedding
  -> identify matching category/tag targets
  -> one full CLIP shard scan or ANN query
       a. base query Top candidateK
       b. activated prototype Top categoryCandidateK
  -> union and deduplicate candidates
  -> bounded feedback rerank
  -> TopK
```

### 6.4 以图搜图数据流

```text
Query image
  -> Hash + DINO query embedding
  -> existing base candidates
  -> infer high-margin matching feedback targets
  -> target prototype supplemental candidates
  -> Hash/DINO/base feature score
  -> bounded feedback rerank
  -> TopK
```

如果查询图无法高置信度匹配任何分类或标签，反馈层不介入，结果与当前搜索保持一致。

### 6.5 Category 显式样本搜索数据流

```text
选择 Category
  -> 读取该目标的 Accept/手动分类/参考图正样本和 Reject 负样本
  -> missing/dirty 时自动重建当前 revision
  -> 最多 4 个代表中心在一次顺序扫描中执行全库 CLIP 召回
  -> 最多 16 个正原型和 8 个负原型对有界候选精排
  -> 默认排除已审核素材
  -> 返回严格有界 TopK、样本计数、revision、耗时和分数拆解
```

该入口解决“已经按分类审核了大量样本，但仍必须输入分类文字才能触发反馈”的产品偏差。它是显式目标检索，不需要根据文字或查询图片猜测目标 Category。

## 7. 算法方案

### 7.1 为什么不能只求一个平均向量

“人物手持产品图”可能同时包含不同人物、产品、姿势、背景和构图。把几千张图片直接平均会得到一个不代表任何真实子分布的中心，导致：

1. 少数风格被多数风格覆盖。
2. 边界样本与错误样本拉偏中心。
3. 分类样本越多，平均中心不一定越准确。
4. 相似度分数集中，难以区分正负样本。

因此必须使用多中心或样本缓存，而不是单中心。

### 7.2 双特征空间

反馈模型分别保留 CLIP 和 DINO 原型，不直接拼接原始向量：

- CLIP：文本语义、标签名、类别名称、文字搜图。
- DINO：外观结构、主体形状、以图搜图、相似素材。

文本查询主要使用 CLIP 反馈分数；以图搜图主要使用 DINO 反馈分数。两者在最终层做分数融合，避免不同维度和分布未经校准直接拼接。

### 7.3 多中心正样本模型

每个分类或标签按模型分别构建原型：

显式 Category Sample Search 保留最多 128 个去重正样本。全库候选召回时，把全部正样本聚合为最多 4 个有最低支持度的球面聚类中心；候选精排时回到原始审核样本，不用少量 medoid 代替人工事实。

正样本使用最近两个样本的平均相似度。样本少于 8 个时退回最近一个，避免小样本分类被过度平滑：

```text
positiveScore(x, target) = mean(top2(cos(x, acceptedSample_i)))
```

该修复来自 2026-07-16 的真实数据排查：旧平方根压缩把 75 个以上有效正样本压成 3 个原型，且远点初始化会优先保留离群图，和“直接使用全部人工筛选结果”的产品语义冲突。

### 7.4 负样本与 hard negatives

负样本来源：

1. 用户对该目标明确 Reject 的素材。
2. 其他相邻分类中与正样本最接近的已确认素材，作为低权重 hard negatives。
3. 不使用所有未分类素材作为负样本。

显式样本搜索保留最多 128 个目标级负样本，并使用最近 Reject 形成 hard-negative margin：

```text
negativeScore(x, target) = max(cos(x, rejectedSample_j))
feedbackMargin = positiveScore - 0.65 * negativeScore
```

目标级 Reject 仍不得传播到其他 Category。权重来自当前本机审核集留一法诊断，后续需要独立数据集重新校准。

### 7.5 Tip-Adapter 风格缓存

少量高质量样本使用键值缓存：embedding 是 key，category/tag 是 value。查询时根据与缓存 key 的相似度生成类别分数，再与原始 CLIP/DINO 分数融合。

该思路参考 [Tip-Adapter](https://arxiv.org/abs/2207.09519)，但本项目不能把十万级审核样本逐个参与每次查询，因此必须通过代表样本、多中心或 ANN 压缩缓存。

### 7.6 查询目标激活

反馈层只在查询可靠对应到分类或标签时启动。

文本查询激活顺序：

1. 分类/标签名称精确匹配：`gate = 1.0`。
2. 规范化别名匹配：`gate = 0.9`。
3. CLIP 文本向量与分类提示词高相似：按校准阈值映射到 `0..1`。
4. 无可靠目标：`gate = 0`。

以图搜图激活条件：查询图对正中心的分数必须同时满足最低阈值和正负 margin；否则不应用分类反馈。

一次查询最多激活 3 个目标，避免大量弱相关分类共同污染排序。

### 7.7 全库召回与补召回

仅重排基础 TopK 无法找回已经被基础模型漏掉的图片，因此需要两路候选：

1. 基础查询对全部有效 embedding 执行搜索，保留 `candidateK`。
2. 每个激活的分类原型对同一全库索引补召回 `categoryCandidateK`。
3. 合并去重后再排序。

建议初始值：

```text
candidateK = clamp(max(topK * 10, 1000), 1000, 10000)
categoryCandidateK = clamp(max(topK * 3, 300), 300, 3000)
```

当后端使用 streaming shards 时，基础查询和已激活原型必须在同一次顺序扫描中计算，避免每个原型重复扫描全库。当持久 ANN 可用时，可分别查询并合并候选。

### 7.8 有界重排

初始重排公式：

```text
feedbackScore = positiveScore - gamma * negativeScore
feedbackBoost = clamp(gate * lambda * calibrate(feedbackScore), -0.12, 0.12)
finalScore = clamp(baseScore + feedbackBoost, 0, 1)
```

建议初始 `lambda`：

| 场景 | 初始值 |
| --- | --- |
| 分类/标签名称精确查询 | `0.30` |
| 分类/标签语义匹配查询 | `0.20` |
| 以图搜图高 margin 分类 | `0.15` |
| 无可靠分类目标 | `0` |

这些值必须在固定样本集上调优。反馈层不得让一个低基础相关度结果仅凭类别分数跃升到顶部；可增加最低 `baseScore` 门槛和最大排名提升限制。

### 7.9 轻量分类器的升级条件

多中心方案稳定后，可为样本充足的目标训练 one-vs-rest 逻辑回归或线性 probe：

```text
positive >= 30
explicit/hard negative >= 30
validation split available
```

分类头只读取冻结的 CLIP/DINO embedding，不更新主模型。只有当验证集指标稳定优于多中心模型时才启用；否则继续使用多中心缓存。

完整 CLIP/DINO 微调属于后续实验，不进入本方案 P0/P1。

## 8. 数据结构与 IPC

### 8.1 事实源

不复制审核事实，继续以现有数据为准：

```text
asset_categories.jsonl
asset_tags.jsonl
category_references.jsonl
suggestions.jsonl
assets.jsonl + archived-assets.json
```

反馈模型是派生缓存，不是新的分类事实源。

### 8.2 派生模型目录

```text
app.getPath('userData')/asset-library/search-feedback/
  state.json
  manifest.json
  category-models.jsonl
  tag-models.jsonl
  clip-prototypes.f32
  dino-prototypes.f32
  previous/
```

`previous/` 最多保留一个最后可用快照。模型构建成功并验证后，通过临时文件加 rename 原子替换。

### 8.3 建议共享类型

```ts
type FeedbackModelState = 'not_built' | 'ready' | 'dirty' | 'building' | 'error'

interface FeedbackModelStatus {
  state: FeedbackModelState
  revision: number
  builtRevision?: number
  categoryModels: number
  tagModels: number
  positiveSamples: number
  negativeSamples: number
  clipCoverage: number
  dinoCoverage: number
  builtAt?: number
  buildMs?: number
  error?: string
}

interface FeedbackSearchSettings {
  enabled: boolean
  autoRebuild: boolean
  maxActiveTargets: number
  maxBoost: number
  textWeight: number
  imageWeight: number
}

interface FeedbackRerankBreakdown {
  applied: boolean
  revision?: number
  targetIds: number[]
  positiveScore?: number
  negativeScore?: number
  boost?: number
  baseRank?: number
  finalRank?: number
  reasons: string[]
}
```

### 8.4 建议 IPC

由 Asset Library 管理模型生命周期：

```text
assetLibrary:getFeedbackModelStatus
assetLibrary:rebuildFeedbackModels
assetLibrary:getFeedbackSettings
assetLibrary:saveFeedbackSettings
assetLibrary:clearFeedbackModels
assetLibrary:onFeedbackProgress
```

停止构建可以复用现有 `assetLibrary:stopTask`，并扩展：

```ts
AssetLibraryTaskType |= 'feedback_model'
```

搜索请求扩展：

```ts
interface SemanticSearchRequest {
  text: string
  topK?: number
  requestId?: string
  feedbackMode?: 'off' | 'auto' | 'force'
}

interface LayeredSearchRequest {
  // existing fields
  feedbackMode?: 'off' | 'auto' | 'force'
}
```

搜索响应扩展：

```ts
feedbackApplied?: boolean
feedbackRevision?: number
feedbackTargets?: Array<{ kind: 'category' | 'tag'; id: number; gate: number }>
feedbackMs?: number
```

每条结果可以携带可选 `FeedbackRerankBreakdown`。Renderer 只接收分数与原因，不接收完整原型向量。

### 8.5 Revision 与缓存失效

下列动作必须增加 `feedbackRevision`：

- Accept
- Reject
- Undo Accept
- 手动分类/移除分类
- 手动添加/移除标签
- 添加/移除分类参考图
- 分类或标签删除、重命名
- 素材 archive/restore/missing 状态变化
- CLIP/DINO embedding 模型版本变化

`manifest.builtRevision !== state.revision` 时模型状态为 `dirty`。搜索可以继续使用旧模型，但必须在响应中标注旧 revision；超过可配置陈旧阈值后自动退回基础搜索。

## 9. UI 与状态设计

### 9.1 AI Suggestions

保持现有交互：

- `Accept`
- `Reject`
- `Ignore`
- `Undo Accept`

审核成功后只增加轻量状态提示，例如：

```text
Search learning: updating
```

不新增重复的“相关/不相关”按钮。

### 9.2 NekoSearch 状态入口

在高级区域增加紧凑状态：

```text
Search Learning: Ready r42
Positive 3,820 / Negative 617 / Targets 28
[Rebuild] [Settings] [Reset model]
```

`Reset model` 只删除派生模型文件，不删除审核、分类和标签数据。

### 9.3 Image Search

高级模式增加：

- `Personalized rerank` 开关，模型通过基准后默认开启。
- 状态：`Off / Ready / Dirty / Degraded`。
- Scores 展开时显示：基础分、反馈 boost、命中分类/标签和模型 revision。

简单模式不增加额外按钮，自动使用已验证且 ready 的模型。

### 9.4 解释信息

结果原因示例：

```text
CLIP semantic match
Matched confirmed tag: 白底产品图
Boosted by 3 accepted prototypes
Demoted by rejected examples
```

不得展示“AI 已学习”但实际使用旧模型或未应用反馈的误导性文案。

## 10. 性能与失败恢复

### 10.1 性能目标

以下是目标值，实施后必须实测：

| 项目 | 目标 |
| --- | --- |
| 搜索额外 P95 延迟 | `<= 50 ms`，不含 CLIP/DINO 查询 embedding 推理 |
| 候选精排规模 | 默认 `<= 10,000` |
| 原型常驻内存 | `<= 128 MB` |
| 构建额外峰值内存 | `<= 256 MB` |
| Renderer 主线程长任务 | `0` |
| Main 事件循环单次阻塞 | `< 16 ms`，循环定期 yield 或使用 worker |
| 模型切换 | 原子热切换，搜索不中断 |

原型点积是轻量 CPU 运算，不应为追求 GPU 利用率强行搬到 GPU。GPU 继续用于 CLIP/DINO embedding 推理；大规模模型构建可在 worker/child process 中使用 CPU SIMD 或可选 GPU 批处理。

### 10.2 构建策略

1. 审核动作只增加 revision，不同步阻塞 UI 构建模型。
2. 自动构建使用 1–3 秒 debounce 合并连续审核。
3. 构建过程流式读取 shards，不一次性加载十万级向量。
4. 每个目标有原型数量上限。
5. 构建支持进度、速度、ETA 和停止。
6. 构建期间搜索继续使用最后一个 ready 快照。

### 10.3 失败恢复

| 失败 | 行为 |
| --- | --- |
| 无反馈模型 | 使用当前基础搜索 |
| 模型 dirty | 默认继续旧模型并标注 revision，后台重建 |
| 模型文件损坏 | 隔离损坏文件，回退 `previous/` 或基础搜索 |
| 模型版本不匹配 | 禁止加载并重建 |
| 构建取消 | 保留旧模型，删除临时文件 |
| 构建进程崩溃 | 启动时清理 `.tmp`，旧快照继续可用 |
| 分类/标签被删除 | 删除对应派生模型，不影响其他目标 |
| 搜索超时 | 跳过反馈层并记录 degradation reason |

## 11. 安全与数据质量

1. 所有 IPC ID、数量、枚举和设置值继续经过 main process guard。
2. 原型向量文件只由 main/worker 读取，不暴露任意文件路径给 Renderer。
3. 所有数据保持本地，不上传审核图片、标签或 embedding。
4. 只使用用户已确认关系和明确 Reject，阻止 AI 自己训练自己。
5. 对每个目标限制单一路径、重复图组和单文件夹的最大权重，防止近重复样本淹没模型。
6. 使用 hash/近重复组进行去重采样，避免同一图片副本制造虚假高准确率。
7. 极端离群正样本先进入低权重或待审计集合，不直接拉动所有中心。
8. 清除反馈模型不得删除分类、标签、建议或原始素材。
9. 不新增物理删除图片能力。

## 12. 准确率验证方案

### 12.1 固定标注集

新增：

```text
tests/fixtures/image-search-feedback/
docs/benchmark/2026-xx-xx-image-search-feedback-baseline.md
```

标注集不得直接复用训练样本作为测试结果。按 diffHash/dctHash 近重复组分组后再切分 train/validation/test，避免同图副本泄漏。

最低建议覆盖：

1. 至少 10 个有实际价值的分类或标签。
2. 每个目标至少 30 个正样本和 30 个明确或 hard negative。
3. 每个目标至少 5 个文本查询，包括名称、别名和描述词。
4. 至少 20 个以图搜图查询。
5. 同时覆盖英文、中文、截图、人物、产品、场景和近重复图。
6. 保留一组不匹配任何分类的通用查询，用于检测个性化污染。

### 12.2 指标

- `Precision@20`
- `Recall@50`
- `nDCG@20`
- `mAP`
- Reject intrusion rate：被明确 Reject 的目标对进入 Top20 的比例
- 通用查询回归率
- 搜索 P50/P95 延迟
- 构建时间、峰值内存和模型文件体积

### 12.3 对照实验

必须同时运行：

```text
A: current base search
B: base + positive multi-prototype
C: base + positive + rejected negatives
D: base + lightweight classifier (optional)
```

只有 B/C/D 在独立测试集上超过 A，才允许默认启用。

## 13. 实施阶段

### P0：反馈语义与可观测性

1. 新增 feedback revision、dirty 状态和模型状态 IPC。
2. 从现有 assignments/suggestions 生成正负样本快照。
3. Accept、Reject、Undo、手动关系变化后正确失效缓存。
4. 建立无重复样本的专项测试。
5. 搜索尚不改变排序，先以 shadow mode 记录候选分数。

完成条件：审核状态、正负样本计数、撤销和 revision 全部可验证。

### P1：多中心模型与文本搜索

1. 构建 CLIP 分类/标签多中心和负中心。
2. 文本查询目标激活。
3. 基础全库召回与分类原型补召回在一次 streaming scan 中完成。
4. 有界反馈重排接入 `searchSemanticImages()`。
5. UI 显示模型状态、revision 和反馈解释。
6. 固定标注集达到验收门槛后才默认开启。

### 13.1 2026-07-15 首轮实现状态

已完成：

1. `Accept`、`Reject`、`Undo Accept`、手动分类/标签、参考图、聚类确认、素材移除/恢复和同步变化均在事实写盘成功后递增 feedback revision。
2. 事实快照只读取人工确认关系；手动关系权重 `1.00`、Accept `0.85`、确认聚类 `0.75`、Reject 为目标级负样本 `1.00`，未确认/忽略/missing/removed 数据不参与。
3. 每个目标有界采样最多 128 个正样本、64 个负样本，并构建最多 16 个正原型、8 个负原型；原型选择为确定性的最远优先多中心，不使用单一平均向量。
4. 派生状态和模型写入 `asset-library/search-feedback/state.json` 与 `manifest.json`，使用临时文件加 rename；构建失败继续使用内存中的旧模型，用户审核事实不回滚。
5. 优先扫描现有 `clip_embedding_paths.jsonl` 并随机读取 `clip_embedding_cache.f32`，避免仅为少量审核样本解析约 2.57 GiB 的 CLIP JSONL；缓存失效时再回退原 JSONL 流式读取。
6. 文本查询只在分类/标签名精确匹配、完整英文词匹配或可靠 CJK 包含匹配时激活反馈，避免 `girl` 错误匹配 `girlfriend`；单次最多激活 3 个目标。
7. CLIP 基础检索仍扫描全部有效 embedding。反馈激活时保留最多 `max(1000, TopK*10)`、上限 10,000 个基础候选，并补入激活目标的正原型路径后执行 `±0.12` 有界重排。
8. 全库扫描已改为有界唯一候选堆；不再为整库候选保留对象和排序，内存随候选上限增长而不是随 18 万级素材量增长。
9. 模型 dirty 后 15 秒无其他 NekoSearch 长任务会后台重建；`Build Search Learning` 可立即重建，状态显示 `state`、`builtRevision/revision` 和目标数。
10. 搜索响应返回是否应用反馈、revision、stale、耗时、激活目标和单结果 `feedbackBoost`；无模型、无可靠目标或构建失败时保持原 CLIP 排序。

仍需验收或后续实现：

1. 尚未建立独立 train/test 切分的真实人工标注集，不能宣称准确率已达到第 14.2 节门槛。
2. P2 DINO 以图搜图反馈、高 margin 目标激活和 hard negatives 尚未接入；当前反馈层只改善 CLIP 文本语义搜索。
3. 分类/标签别名、描述文本和多语目标激活尚未实现；当前采用保守名称匹配，任意近义查询不会强行套用反馈。
4. 外部参考图必须已有 CLIP embedding 才能进入本轮文本反馈模型；只有 DINO 缓存的参考图会计入 skipped，不阻断其原有参考图分类功能。
5. 固定样本 A/B、P50/P95、峰值内存和 Reject intrusion rate 仍需在真实库上记录后再调整权重与阈值。

### 13.2 2026-07-15 审计校准

专项审计确认首轮工程链路存在，2026-07-16 已完成第一批门禁整改：

1. 新资料库默认 `enabled: false`，NekoSearch 顶部 `Learning` checkbox 可显式启停。
2. Learning 关闭时 dirty revision 不再触发自动后台重建；用户重新开启或手动构建后恢复。
3. 已有 userData 的持久化选择保持兼容，不静默覆盖用户当前行为。
4. 审核 assignment 已绑定 `suggestionId`，普通写操作已与长任务互斥；跨 JSONL 崩溃事务仍待 SQLite。
5. `force` mode 尚未形成区别于 `auto` 的完整行为，应实现或删除，避免伪设置。
6. 固定样本通过前仍不允许把 Learning 改成新资料库默认开启。

详细证据和验收顺序见[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)。

### 13.3 2026-07-17 主体检索修正

Category Sample Search 的 CLIP v2 已完成：最多 128 个正样本和 128 个目标级 Reject 全部参与有界评分，旧 `3 + 3` 离群 prototype 压缩已移除，正样本采用 Top-2 支持，最近 Reject 权重为 `0.65`。现有审核集留一法 AUC 约为 `0.97`，但真实全库结果仍不能稳定命中用户指定主体。

该差异说明问题不再主要是“样本没有参与”，而是全局 CLIP 特征与主体身份目标不一致。后续实现调整为两阶段检索：

```text
全库 CLIP 粗召回 3,000-5,000
  -> DINO Category 正负样本主体外观精排
  -> 可选 object_crop 局部主体验证
  -> TopK
```

实施前置条件：

1. 将约 4GiB DINO JSONL 转换为带版本、维度和路径映射的 Float16 连续向量缓存。
2. 搜索阶段通过 mmap 或分块随机读取候选行，不允许交互查询重扫完整 JSONL。
3. DINO 与 CLIP 分数分别归一化；初始权重只作为实验值，建议 `0.75 / 0.25`，必须由固定标注集选择。
4. Category 级 Reject 只抑制当前目标，不进入全局负样本。
5. 二进制缓存缺失、损坏或版本不一致时降级到当前 CLIP v2，不阻断基础搜索。
6. 外部参考图后续支持人工框选主体，写入独立 `object_crop` embedding，不覆盖全局 embedding。

当前明确状态：CLIP v2 已实现并通过工程回归；2026-07-17 已完成 DINO Float16 缓存和 Category Sample Search 的 CLIP 召回 + DINO 精排首轮接入。主体 crop、融合权重 A/B 和真实全库准确率门禁仍未实现。

### P2：DINO 以图搜图与 hard negatives

1. 已完成：DINO Float16 连续缓存和 path-to-row 索引。
2. 已完成：Category 全部有界 DINO 正负样本模型。
3. 已完成：接入 CLIP 粗召回后的 DINO Category 精排，缺失或覆盖不足时回退 CLIP。
4. 待完成：加入高 margin 目标激活和主体 crop 可选验证。
5. 待完成：从邻近分类挖掘低权重 hard negatives。
6. 部分完成：已测缓存构建、样本覆盖和精排吞吐；仍缺独立全库准确率、内存和长时间 UI 响应基准。

### P3：轻量分类器与主动审核

1. 对样本充足目标训练 one-vs-rest 线性分类头。
2. 使用独立验证集决定多中心或分类头的 winner。
3. AI Suggestions 优先展示高不确定性且多样化的样本，提高单位审核量的信息价值。
4. 仍不自动接受建议。

### P4：可选模型适配实验

只有 P1–P3 不能达到业务指标时，才评估轻量 CLIP adapter 或新多语模型。完整主模型微调必须独立立项，包含显存、重新 embedding、模型兼容和回滚方案。

## 14. 验收标准

### 14.1 功能验收

1. Accept 后对应目标正样本增加，Reject 后负样本增加。
2. Ignore 不改变模型样本。
3. Undo Accept 后正关系移除并使模型 dirty。
4. 分类/标签删除后不会再激活旧模型。
5. Removed/missing 素材不参与模型和搜索结果。
6. 反馈模型关闭或损坏时基础搜索完整可用。
7. 搜索响应能说明是否应用反馈及使用的 revision。
8. 所有有效 embedding 仍参与基础全库搜索或 ANN 召回。

### 14.2 准确率门槛

以下为建议首轮门槛，需要由真实标注集确认：

1. 激活分类查询的 `nDCG@20` 相对基础搜索提升至少 `8%`。
2. `Precision@20` 不低于基础搜索。
3. `Recall@50` 下降不超过 `1%`。
4. Reject intrusion rate 相对基础搜索下降至少 `50%`。
5. 通用、未激活查询的 `nDCG@20` 回归不超过 `2%`。
6. 不能只报告训练样本或重复图片上的结果。

### 14.3 性能门槛

1. 反馈精排附加 P95 延迟不超过 `50 ms`。
2. 打开 Image Search/NekoSearch 不同步加载全量反馈样本。
3. 构建期间窗口可拖动、输入和切换，不出现明显掉帧。
4. 停止构建后子进程、worker、文件句柄和临时文件均释放。
5. 180K 级素材实测峰值内存符合第 10.1 节目标，未达到时不得默认开启。

### 14.4 工程验证

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run test:asset-library
npm.cmd run test:vector-pipeline
npm.cmd run test:image-feedback-search   # 新增
npm.cmd run build:renderer
npm.cmd run smoke:ui
```

## 15. 文件改动清单

| 文件 | 设计改动/首轮映射 |
| --- | --- |
| `shared/ipc/asset-feedback.ts` | 反馈模型、设置、进度和结果解释类型 |
| `shared/vectorTypes.ts` | 搜索请求/响应增加 feedback mode 与统计 |
| `electron/assetLibraryService.ts` | 审核成功后标记 feedback revision |
| `electron/assetFeedbackSource.ts` | 从现有事实源生成正负样本 |
| `electron/assetFeedbackModelBuilder.ts` | 流式构建多中心与负中心 |
| `electron/assetFeedbackModelStore.ts` | 原子快照、版本校验、hot swap、回滚 |
| `electron/personalizedRerankService.ts` | 目标激活、补召回、分数校准和解释 |
| `electron/semanticSearchService.ts` | 文本搜索接入反馈候选与重排 |
| `electron/rerankService.ts` | 以图搜图接入反馈精排 |
| `electron/assetFeedbackIpc.ts` | 状态、设置、重建和清除 IPC |
| `src/components/AssetLibraryPanel.tsx` | Search Learning 状态与管理入口 |
| `src/components/ImageSearchPanel.tsx` | 高级模式开关和反馈解释 |
| `tests/asset-feedback-model.test.cjs` | 语义、revision、撤销、损坏恢复测试 |
| `tests/asset-feedback-search.test.cjs` | 固定样本准确率和回归测试 |

## 16. 明确禁止的实现

1. 把一个分类的所有图片直接平均成唯一中心。
2. 把 Reject 当成全局负样本。
3. 使用未确认 AI 建议训练下一轮 AI 建议。
4. 只在已分类 Assets 中搜索，绕过全库 embedding。
5. 每次 Accept 都同步重扫全库并阻塞 Renderer。
6. 为每个原型分别完整扫描 shards，造成 N 倍 I/O。
7. 直接覆盖当前 `finalScore`，不给反馈影响设置上限。
8. 在搜索结果中复制一套与 AI Suggestions 相同的审核按钮。
9. 为了轻量分类需求直接微调整个 CLIP/DINO。
10. 没有独立测试集就宣称准确率提升。

## 17. 迁移、回滚与兼容

1. P0 不迁移现有 assignments 和 suggestions，只读取它们。
2. 首次启用时构建派生模型；没有模型时行为与当前版本一致。
3. `feedbackMode: off` 可立即关闭个性化，不需要删除数据。
4. 删除 `search-feedback/` 只会清除派生缓存，下次可重建。
5. 新模型构建失败时继续使用最后一个通过验证的快照。
6. CLIP/DINO 模型版本或维度变化时旧反馈模型自动失效。
7. 发布初期使用 shadow mode，只记录指标，不改变用户排序。
8. 固定样本与真实使用指标通过后，再逐步对简单模式默认启用。

## 18. 决策摘要

| 决策 | 结论 |
| --- | --- |
| 是否新增搜索结果相关/不相关按钮 | P0/P1 不新增，复用 AI Suggestions |
| Accept 的含义 | 对目标分类/标签的正样本 |
| Reject 的含义 | 仅对该目标的负样本 |
| Ignore 的含义 | 不进入模型 |
| 是否搜索全部 embedding | 是，基础召回范围不缩小 |
| 是否只做重排 | 否，同时用原型补召回避免基础 TopK 漏图 |
| 类别表示 | CLIP/DINO 分离的多中心与负中心 |
| 是否完整微调模型 | 否，先用缓存、多中心和可选线性分类头 |
| 模型存储 | 独立派生快照，可删除、重建、回滚 |
| 默认开启条件 | 固定测试集准确率、性能和回归门槛全部通过 |

## 19. 参考资料

- [Rocchio relevance feedback，Stanford IR Book](https://nlp.stanford.edu/IR-book/html/htmledition/the-rocchio-algorithm-for-relevance-feedback-1.html)
- [Tip-Adapter: Training-free Adaption of CLIP](https://arxiv.org/abs/2207.09519)
- [CLIP: Learning Transferable Visual Models From Natural Language Supervision](https://arxiv.org/abs/2103.00020)
- [DINOv2: Learning Robust Visual Features without Supervision](https://arxiv.org/abs/2304.07193)

## 20. 文档状态说明

本文档的 P0/P1 首轮工程实现已经落地，当前版本可把现有 AI Suggestions 审核结果用于 CLIP 文本搜索和显式 Category 样本搜索。2026-07-17 已继续完成 DINO Float16 派生缓存和 Category Sample Search 的 CLIP 召回 + DINO 精排首轮接入。该结论只代表功能链路、降级和工程回归通过，不代表真实搜索准确率已经达到第 14.2 节门槛。主体 crop 和真实全库固定标注集 A/B 仍是发布验收的前置条件。当前事实以[NekoSearch 当前实施基线](../current/2026-07-14-neko-search-implementation.md)、[专项审计](../audits/2026-07-18-neko-search-complete-audit.md)和代码测试结果为准。
