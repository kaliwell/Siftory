# NekoSearch 多维审计

> 状态：已替代  
> 更新日期：2026-07-16  
> 范围：`electron/asset*`、`src/components/AssetLibrary*`、NekoSearch IPC、数据存储、搜索反馈模型及相关测试  
> 替代文档：[2026-07-18 NekoSearch 完整多维审计](2026-07-18-neko-search-complete-audit.md)

## 快速入口

- [当前结论](#当前结论)
- [评分与完成度](#评分与完成度)
- [高优先级问题](#高优先级问题)
- [中优先级问题](#中优先级问题)
- [性能与规模](#性能与规模)
- [安全与恢复](#安全与恢复)
- [优化路线](#优化路线)
- [验证记录](#验证记录)

## 目的与范围

本审计从功能完整性、结构、逻辑与数据一致性、搜索准确率、性能效率、安全、失败恢复、复用、扩展性、死代码和测试覆盖等维度检查 NekoSearch 当前实现。

审计方法包括：

1. 逐层检查 React UI、preload 契约、IPC handler、服务、JSONL 存储和向量数据源。
2. 使用当前真实用户数据进行只读规模统计和耗时测量。
3. 用临时目录复现取消任务后的内存/磁盘状态差异。
4. 运行类型检查、Lint、专项测试、Renderer 构建、UI 冒烟测试和依赖安全检查。
5. 对照分类方案和审核反馈搜索方案检查实现偏差。

未运行会改写真实素材库的全量参考图建议、标签建议和聚类任务。2026-07-16 整改后已重新生成 NSIS 并完成归档完整性检查，但尚未执行 packaged UI 和干净 Windows VM 安装测试。

## 当前结论

NekoSearch 已具备可用的分类闭环骨架：素材同步、分类与标签、外部参考图、AI 建议审核、聚类入口、软归档和审核反馈模型均已有实现；类型、构建、IPC 契约和基础 UI 冒烟测试通过。

2026-07-15 审计时还不适合在十万级素材库上作为“无人值守自动分类系统”发布。主要原因不是按钮缺失，而是以下基础问题：

1. 取消同步会留下仅存在于内存的半完成状态。
2. 长任务与普通写操作可并发，跨多个 JSONL 文件的更新没有事务边界。
3. 十八万素材元数据和数 GB 向量在 Electron 主进程中全量扫描、解析和排序。
4. 参考图分类和聚类算法仍是启发式近似，无法稳定表达多模态分类。
5. 审核反馈重排在固定标注集验收前已默认启用，与设计门槛相反。
6. UI 尚未形成完整的纠错、撤销、合并、拆分和批量审核工作流。

结论：**基础纵向链路可用，工程健康度中等；大库性能、状态一致性和准确率验证仍是发布阻断项。**

## 2026-07-16 第一批整改进度

第一批整改后估算综合健康度由 **68/100** 提升到 **74/100**。这是工程风险重估，不替代固定准确率样本和故障注入验收。

| 审计项                | 状态           | 本轮结果                                                                                |
| --------------------- | -------------- | --------------------------------------------------------------------------------------- |
| P1-01 同步取消不回滚  | 已修复         | 使用临时 Map 和双临时文件；成功提交后才替换活动内存                                     |
| P1-02 任务/普通写竞态 | 部分修复       | IPC 普通写统一串行队列，长任务与待保存写操作互斥；跨 JSONL 崩溃事务仍待 SQLite          |
| P1-03 主进程全量排序  | 部分修复       | 当前页改为有界最佳候选堆，前端增加 200ms 去抖和过期响应丢弃；全量 Map 仍待迁移          |
| P1-07 反馈默认门禁    | 已修复主要缺陷 | 新资料库默认关闭，新增显式 `Learning` 开关；关闭时不自动后台重建；`force` mode 仍待清理 |
| P1-08 索引 OOM 边界   | 已修复主要缺陷 | 限制记录、路径区、segment/manifest/overlay 字节和 segment 数量，拒绝目录逃逸            |
| 审核目标与撤销身份    | 已修复         | 严格验证建议、active 素材和分类/标签；assignment 持久化 `suggestionId`                  |

真实 180,034 active 素材只读复测：

| 排序                  |     审计基线 |                第一批整改后 |
| --------------------- | -----------: | --------------------------: |
| 名称排序，首屏 100 条 | 493.4ms 平均 | 55.3ms 平均；暖机约 42-44ms |
| 大小排序，首屏 100 条 | 126.7ms 平均 |                  8.9ms 平均 |
| 最近更新，首屏 100 条 |  23.7ms 平均 |                 29.2ms 平均 |

当时仍未解决：元数据 SQLite 迁移、数 GB 向量 worker/ANN、跨 store 崩溃事务、正式聚类算法与 lineage、固定准确率 A/B 和完整 UI 纠错闭环。此处保留 2026-07-16 快照；聚类质量算法已在 2026-07-18 整改，详见文末 P1-06 复核。

## 2026-07-16 第二批整改进度

第二批整改后估算综合健康度由 **74/100** 提升到 **77/100**。本轮主要修复会直接影响分类召回和任务可观测性的逻辑缺陷，仍不代表准确率已经通过发布门槛。

| 审计项                   | 状态                      | 本轮结果                                                                                     |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------- |
| P1-04 主进程向量解析     | 部分修复                  | embedding 改为 1MiB 逆序分块流，候选 TopK 改为最小堆；JSON 解析仍在主进程，worker/ANN 未完成 |
| P1-05 参考图单中心       | 已修复主要缺陷            | 每张参考图保留为独立 prototype，按最佳模式匹配并记录实际证据图                               |
| P1-06 聚类范围           | 当时部分修复              | `maxAssets` 只统计 active 素材；压缩桶算法和代表图已于 2026-07-18 替换，lineage 仍待完成     |
| P2-01 重复向量旧记录优先 | 已修复 Asset Library 路径 | 同路径采用最新追加有效记录；全局 CLIP cache 离线 compact 仍待完成                            |
| P2-02 外部参考图失效     | 已修复任务路径            | 分类前重新检查存在性、大小和 mtime；变化后清除旧参考 embedding，删除后标为 missing           |
| P2-03 任务反馈           | 部分修复                  | 长任务增加平滑 ETA；批量纠错、合并和拆分工作流仍未完成                                       |

真实 3.81GiB DINO JSONL 只读短基准：逆序读取最新 2,000 个唯一向量耗时 **187ms**，处理 31.56MiB，Node heap 增量约 0.22MiB。

## 2026-07-16 第三批整改进度

第三批整改后估算综合健康度由 **77/100** 提升到 **80/100**。本轮收口分类阈值和核心多 JSONL 操作的崩溃一致性；SQLite catalog、向量 worker/ANN、正式聚类 lineage 和真实准确率门禁仍未完成。

| 审计项                | 状态                  | 本轮结果                                                                                                       |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| P1-02 跨 store 半提交 | 已修复核心 JSONL 路径 | 新增同盘暂存快照、写前 journal、启动恢复和异常内存回滚；覆盖分类/标签删除、建议确认/撤销、聚类替换和聚类转分类 |
| P1-05 分类阈值仅在 UI | 已修复持久化缺陷      | `referenceThreshold` 写入分类记录；旧分类兼容默认 0.82；全分类任务逐分类取值，显式请求仍可覆盖                 |
| 故障恢复测试          | 已增加                | 覆盖双 store 正常提交、action 异常回滚，以及只替换首个文件后重启恢复                                           |

事务 journal 不改变现有 JSONL 格式，不接触或删除原素材；它解决核心关系文件的半提交恢复，但不能替代 SQLite 的索引查询、schema migration 和跨 `AssetMetadataStore` 的统一事务能力。

## 2026-07-16 第四批整改进度

第四批整改后估算综合健康度由 **80/100** 提升到 **83/100**。本轮完成 SQLite Catalog 第一阶段和构建产物清理；它解决普通素材分页的全量 Map 扫描，但尚未迁移分类、标签、建议和向量关系。

| 审计项               | 状态               | 本轮结果                                                                                                              |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| P1-03 主进程全量排序 | 已修复普通分页路径 | 新增 `asset-catalog.sqlite` 派生投影；最近、名称、大小、归档和路径查询下推 SQLite；关系筛选保留内存回退               |
| Catalog 一致性       | 已建立保守边界     | JSONL 仍是权威源；文件指纹与行数一致才启用投影；失败自动回退；归档支持增量更新                                        |
| Catalog 首建卡顿     | 已降低             | 每 2048 条单独事务并让出事件循环；18 万条合成数据约 2.17s，投影约 50.73 MiB                                           |
| 常用分页性能         | 已达本阶段目标     | 18 万条最新页中位 2.45ms；offset 90,000 名称页中位 9.78ms；路径子串中位 30.89ms                                       |
| 构建输出累积         | 已修复             | Electron 主入口先清空、其余入口追加，TypeScript build info 移到 `node_modules/.cache`；输出保持 8 文件、366,472 bytes |

FTS5 trigram 路径索引试验已撤销：首建由约 2.2s 增到约 14.9s，查询没有改善。当前不以索引体积和同步时间换取无实测收益的复杂度。

## 评分与完成度（2026-07-15 审计基线）

| 维度                |       评分 | 判断                                                    |
| ------------------- | ---------: | ------------------------------------------------------- |
| 功能纵向闭环        |     78/100 | 主路径已能运行，管理和纠错能力不完整                    |
| 结构与职责边界      |     65/100 | 模块已有分层，但核心服务和面板过大                      |
| 逻辑与数据一致性    |     62/100 | 存在取消残留、并发竞态和多存储非事务写入                |
| 性能与效率          |     52/100 | 十万级列表可用但会阻塞，多 GB AI 任务位于主进程         |
| 搜索/分类准确率工程 |     58/100 | 有反馈闭环，无固定样本门禁；参考图和聚类近似过强        |
| 安全                |     82/100 | Electron 基线良好，仍有本地恶意索引导致内存耗尽风险     |
| 失败恢复            |     66/100 | 单文件原子替换较好，跨文件一致性和取消回滚不足          |
| 现有能力复用        |     85/100 | 充分复用 Image Search 向量、缩略图、虚拟网格和 IPC 契约 |
| 可扩展性            |     62/100 | 数据契约清晰，但 JSONL 全量模型和单体服务限制扩展       |
| 测试覆盖            |     64/100 | 基础测试通过，缺少故障注入、真实任务和大规模回归        |
| 文档一致性          |     65/100 | 方案较完整，当前实施文档存在相互矛盾的状态描述          |
| **综合健康度**      | **68/100** | **可继续内部使用和迭代，不建议直接宣称大库生产就绪**    |

按原始智能分类方案估算：

- 当前可用纵向闭环完成度：约 **78%**。
- 完整产品方案完成度：约 **55%**。
- 当前真实库已分类比例约 **0.026%**，说明工程路径存在，但真实工作流验证样本仍很少。

## 架构与数据流

当前主链路为：

```text
AssetLibraryPanel
  -> typed preload API
  -> assetLibraryIpc
  -> assetLibraryService
  -> metadata / taxonomy / suggestions / assignments / clusters JSONL stores
  -> Image Search manifest + DINO/CLIP embedding stores
```

积极结构包括：

1. NekoSearch 作为独立懒加载面板注册，未侵入 Image Search 主 UI。
2. IPC 类型、参数 guard、服务和存储已有分层。
3. 稳定素材 ID 与 missing/archived 覆盖层避免因为索引变化丢失人工分类。
4. 素材网格复用 `ThumbnailImage` 和虚拟可见区域渲染。
5. 删除 Neko 元数据不会删除用户原始文件。

主要结构债务：

- `electron/assetLibraryService.ts` 约 1707 行，同时承担任务编排、分类 CRUD、向量读取、建议生成、审核、聚类和反馈模型更新。
- `src/components/AssetLibraryPanel.tsx` 约 1409 行，同时承担四个页面、任务状态和多数异步请求。
- 服务使用进程级 singleton 和可变 `activeTask`，不利于多资料库、隔离测试和任务恢复。
- JSONL 存储普遍没有显式 schema version 和迁移机制。

## 高优先级问题

### P1-01 取消同步没有回滚内存状态

**位置：** `electron/assetMetadataStore.ts:353-423`

**整改状态：2026-07-16 已修复并新增取消前后内存/磁盘一致性回归测试。**

同步循环在持久化前直接修改 `records`、`idsByPath` 和 `nextId`；取消检查发生在循环中，抛错后没有恢复快照。临时数据复现结果：

```text
cancel_error=Asset sync cancelled
in_memory_after_cancel=true,true,false
on_disk_after_cancel=false,false,false
```

影响：界面显示任务已停止，但本进程内已经接受部分新素材；后续任意一次保存可能把半完成状态写入磁盘。原图不会丢失，但任务状态语义和元数据一致性错误。

建议：在临时 Map/事务中构建结果，成功后一次交换；或记录变更日志并在取消/异常时回滚。必须增加取消前、中、后的内存与磁盘一致性测试。

### P1-02 长任务与普通写操作存在竞态，跨存储更新没有事务

**整改状态：2026-07-16 已修复核心 JSONL 路径，整体仍为部分完成。** 普通写 IPC 已串行化并与长任务互斥，审核增加目标校验和 `suggestionId` 绑定。分类/标签删除、建议确认/撤销、聚类替换和聚类转分类使用可恢复写前 journal；SQLite catalog 和 `AssetMetadataStore` 跨域事务仍待完成。

**位置：**

- `electron/assetLibraryService.ts:168-218`
- `electron/assetLibraryService.ts:653-663`
- `electron/assetLibraryService.ts:1172-1287`
- `electron/assetLibraryService.ts:1384-1480`
- `electron/vectorDatabaseService.ts:192-203`
- `electron/vectorDatabaseService.ts:248-250`
- `electron/assetSuggestionReview.ts:21-48`

审计基线中，`activeTask` 只防止两个长任务同时运行，不阻止分类删除、标签删除、审核、归档等普通写操作。整改后统一写队列已关闭该竞态。

审计基线中，审核路径未严格验证建议 ID、目标分类/标签和素材状态，多个 JSONL 也缺少整体提交边界。整改后核心关系写使用同盘 staged snapshots 和 journal；进程在替换中途退出时，下次启动会完成剩余替换。

审计基线中，撤销按 `(assetId, targetId, source)` 查找关系。整改后 assignment 持久化并按 `suggestionId` 绑定撤销。

建议：引入资料库 revision 和单写者事务队列；任务提交时校验 revision，审核操作在一个 SQLite transaction 中完成。UI 在冲突任务期间禁用对应写操作。

### P1-03 元数据全量驻留并在 Electron 主进程同步扫描/排序

**整改状态：2026-07-16 部分修复。** 分页只维护 `offset + limit` 个最佳候选，名称排序实测平均下降约 88.8%；全量元数据驻留和扫描仍待 SQLite。

**位置：**

- `electron/assetMetadataStore.ts:59-69`
- `electron/assetMetadataStore.ts:126-178`
- `electron/assetMetadataStore.ts:320-350`
- `electron/assetLibraryService.ts:524-570`
- `src/components/AssetLibraryPanel.tsx:188-209`
- `src/components/AssetLibraryPanel.tsx:251-253`
- `src/components/AssetLibraryPanel.tsx:454-459`

当前 180,034 个 active 素材会全部加载到两个 Map；每次列表请求扫描全部记录并对所有匹配项完整排序。分类/标签映射也在请求中重建。前端筛选文本每次按键立即发 IPC，没有 debounce、请求 generation 或过期响应保护。

真实库只读测量：

| 项目                 |      结果 |
| -------------------- | --------: |
| 首次 `getStats`/载入 |  948.9 ms |
| RSS 增量             | +217.6 MB |
| heap 增量            | +157.9 MB |
| 最近排序，暖机平均   |   23.7 ms |
| 查询 `png`，暖机平均 |   32.8 ms |
| 按名称排序，暖机平均 |  493.4 ms |
| 按大小排序，暖机平均 |  126.7 ms |

名称排序可阻塞主进程约半秒；连续筛选请求还可能由旧响应覆盖新响应。

建议：将素材目录迁移到 SQLite，建立 `status/path/name/mtime/size/category/tag` 索引并使用数据库分页排序；前端增加 150-250ms debounce、请求序号和取消/丢弃过期响应。

### P1-04 AI 任务在主进程解析数 GB JSONL

**整改状态：2026-07-16 部分修复。** Asset Library 流改为逆序分块读取，latest-wins 不需要全量向量驻留；候选保留改为最小堆。JSON 解析和相似度计算仍在 Electron 主进程，长期方案仍是 binary/ANN worker。

**位置：**

- `electron/assetLibraryEmbeddingSource.ts:44-109`
- `electron/assetLibraryService.ts:1079-1095`
- `electron/assetLibraryService.ts:1119-1124`
- `electron/assetLibraryService.ts:1235-1264`
- `electron/assetLibraryService.ts:1333-1361`
- `electron/assetLibraryService.ts:1534-1565`

参考图建议、文本标签建议和聚类会在 Electron 主进程逐行 `JSON.parse` DINO/CLIP 向量。当前数据规模：

| 数据              |      大小 |
| ----------------- | --------: |
| `assets.jsonl`    |  70.2 MiB |
| DINO JSONL        |  3.81 GiB |
| CLIP JSONL        |  2.57 GiB |
| CLIP binary cache | 481.5 MiB |

每 250ms 主动 yield 只能降低单次冻结，不能消除 JSON 解析、分配和 GC 对 UI 的影响。参考图路径在部分情况下会先扫描一次寻找参考向量，再扫描一次全库候选。外部参考图 fallback 固定使用 CPU 且串行，单张超时可达 180 秒。

审计基线中的候选保留会线性寻找最差项；整改后已替换为有界最小堆，单次候选更新由 `O(K)` 降为 `O(log K)`。

建议：优先读取紧凑二进制向量或持久 ANN 索引；推理和全库扫描移入 worker/utility process；TopK 使用最小堆；按模型版本、路径和 mtime 去重压缩向量。

### P1-05 参考图分类把多种视觉概念压成单一中心

**整改状态：2026-07-16 已修复主要缺陷。** 分类保留独立 prototype，使用最佳匹配模式并记录实际命中参考图；分类专属阈值已持久化并用于批量任务。固定样本校准仍待完成。

**位置：** `electron/assetLibraryService.ts:1068-1076`、`electron/assetLibraryService.ts:1197-1207`

审计基线会把同一分类的参考图平均成 centroid，难以表示多背景、多姿态类别；整改后每张参考图作为独立 prototype，按最佳模式匹配。

审计基线中的阈值只存在于 UI；现已按分类持久化，但还没有固定人工标注集验证 Recall@K、Precision@K、Accept rate 和 Reject intrusion。

建议：后续只在固定标注集 A/B 通过时调整 prototype 聚合策略和各分类持久阈值。

### P1-06 聚类是 10 位符号哈希分桶，不是稳定语义聚类

**整改状态：2026-07-16 部分修复。** `maxAssets` 现在统计当前 active 素材，不再由前部无关 embedding 消耗名额；符号分桶、代表图近似和重算覆盖 lineage 仍未解决。

**位置：**

- `electron/assetLibraryService.ts:1513-1519`
- `electron/assetLibraryService.ts:1528-1565`
- `electron/assetLibraryService.ts:1580-1604`
- `electron/assetClustering.ts:150-185`

算法只抽取 DINO 向量中 10 个均匀坐标的正负号，最多形成 1024 个桶。进入同一桶的无关素材无法再拆开；代表图是排序后的第一张，不是 medoid；同桶成员共享桶级相似度。

`maxAssets=200000` 实际限制的是全局 embedding 前 20 万行，而不是当前 active 库中的 20 万素材，后部 active 素材可能完全不参与。重新计算直接 `replaceAll` 聚类组和成员，会覆盖用户重命名、确认、忽略及历史。

建议：使用 mini-batch K-Means/HDBSCAN/ANN 邻接分量；先过滤 active ID 再计数；代表图取 medoid；将“聚类运行”和“用户确认后的正式组”分离并保留 lineage。

### P1-07 审核反馈搜索在准确率门禁前默认启用

**整改状态：2026-07-16 已修复默认门禁。** 新资料库默认关闭，UI 提供显式 `Learning` 开关，关闭时停止自动后台重建；已有用户的持久化选择保持兼容。

**位置：**

- `docs/designs/2026-07-15-neko-search-feedback-search-plan.md:81`
- `docs/designs/2026-07-15-neko-search-feedback-search-plan.md:662`
- `electron/assetFeedbackModelService.ts:100-108`
- `electron/assetFeedbackModelService.ts:467-487`
- `electron/vectorIpc.ts:318-319`
- `src/components/AssetLibraryPanel.tsx:1282-1291`

设计要求固定标注集 A/B 证明改善后才默认启用，代码却默认 `enabled: true`，搜索默认 `auto`。NekoSearch UI 只有重建入口，没有 off/auto 控制。`force` 类型存在，但评分路径没有形成与 `auto` 不同的有效行为。

当前真实数据中不存在 `search-feedback/manifest.json`，说明反馈模型尚未在真实库形成可验证基线。

建议：默认关闭；提供显式开关、模型版本、样本数和生效原因；固定样本门禁通过后再灰度启用；删除或完整实现 `force`。

### P1-08 Image Search 索引解析上限可导致主进程内存耗尽

**整改状态：2026-07-16 已完成第一层硬化。** 已增加聚合预算、manifest/overlay 上限和目录边界测试；长期仍建议迁移 mmap worker。

**位置：**

- `electron/assetLibraryIpc.ts:95-97`
- `electron/assetLibraryGuards.ts:183-184`
- `electron/imageIndexAssetSource.ts:44-47`
- `electron/imageIndexAssetSource.ts:103-110`
- `electron/imageIndexAssetSource.ts:128-192`

IPC 可传入任意本地 manifest 路径。解析器允许最多 500 万记录和 2GB 路径区，并在主进程一次性分配 offsets、paths、metadata、hashes 和记录对象；manifest 还可引用绝对 segment 路径。

这是本地可用性/renderer compromise 防御问题，不是远程代码执行。恶意或损坏索引可使进程 OOM。

建议：只允许当前 Image Search 数据目录中的已登记 manifest；在分配前检查所有 section 总字节和文件边界；设置符合产品规模的内存预算；使用流式读取或 mmap worker。

## 中优先级问题

### P2-01 向量流优先保留旧重复记录

**整改状态：2026-07-16 已修复 Asset Library 读取路径。** JSONL 按 1MiB 块从尾部逆序读取，同一路径只接受最新追加的有效向量，并设置 4MiB 单行上限。全局 CLIP binary cache 的离线去重压缩仍是独立剩余项。

`electron/assetLibraryEmbeddingSource.ts:57-90` 对同路径采用首条记录；append-only shard 中新 embedding 可能被忽略。当前 CLIP binary cache 有 246,534 行、228,606 个唯一路径，重复 17,928 行，占 7.27%。抽样重复向量中存在非完全一致项。

建议：按模型版本和 `(path, mtime)` 采用最新有效记录；离线 compact；统一批量路径读取与全流读取的去重语义。

### P2-02 外部参考图不会自动失效

**整改状态：2026-07-16 已修复分类任务路径。** 参考分类开始前重新 `stat` 手动素材；删除后持久化 `missing`，大小或 mtime 变化后清除旧参考 embedding 并重新推理。

`electron/assetMetadataStore.ts:249-317` 导入时记录文件状态，但后续 sync 只维护 `image_search` 来源。外部参考文件移动、删除或修改后仍可能保持 active，embedding cache 也可能因旧 mtime 被复用。单张导入还会重写完整约 70MB `assets.jsonl`。

建议：使用受管参考图库副本，或在任务前重新 stat 并按 mtime 失效；批量导入一次事务保存。

### P2-03 用户纠错闭环不完整

**整改状态：2026-07-16 部分修复。** 共享 `etaMs` 已由平滑增量速率计算并显示在 NekoSearch 进度条；其余批量纠错、证据管理、合并和拆分入口仍未完成。

当前 UI 缺少以下关键操作：

1. Assets 网格移除分类/标签关系和批量撤销。
2. Suggestions 展示证据参考图、批量接受/拒绝、改到其他分类。
3. Clusters 合并、拆分、删除和成员编辑。
4. 分类 parent 移动、description、icon、sort order 编辑。
5. 参考图权重和分类专属阈值编辑。
6. 重复/近重复专项流程与 Duplicate Finder 结果复用。
7. Media Search 关键帧进入统一素材分类。
8. 任务 ETA/速率展示；共享契约已有 `etaMs`，服务和 UI 尚未完整使用。

### P2-04 文档状态自相矛盾

`docs/current/2026-07-14-neko-search-implementation.md` 同时存在“审核反馈待实施”和“P0/P1 已实现”等冲突描述，并对素材同步是否逐文件 stat 给出不同说法。

建议：将其改成按能力矩阵列出“已实现/部分实现/未实现/未验证”，旧判断移入变更记录，不在当前基线中并列保留。

### P2-05 模块过大并存在低价值分支

核心服务和面板承担过多职责；`AssetFeedbackMode='force'` 当前没有独立语义。候选排序、审核关系修复和任务状态散落在单体服务中，增加修改回归风险。

建议拆分：

- `assetCatalogService`
- `assetTaxonomyService`
- `assetSuggestionService`
- `assetReviewService`
- `assetClusteringService`
- `assetTaskCoordinator`
- UI hooks 与四个独立 view

## 功能完整性

| 能力                     | 状态     | 说明                                               |
| ------------------------ | -------- | -------------------------------------------------- |
| 从 Image Search 同步素材 | 已实现   | 大库可运行，但取消回滚和 catalog 性能需修复        |
| 分类/标签 CRUD           | 部分实现 | 基础创建、改名、颜色可用；层级和详细属性编辑不完整 |
| 手动批量分类/打标签      | 已实现   | 缺少 Assets 侧完整移除与撤销体验                   |
| 本地选择/剪贴板参考图    | 已实现   | 缺少文件失效和受管副本机制                         |
| 参考图 AI 建议           | 部分实现 | 可运行，算法、阈值和大库执行架构需升级             |
| 文本标签建议             | 部分实现 | CLIP 链路存在，中文和准确率无固定门禁              |
| Accept/Reject/Undo       | 部分实现 | 基础审核存在，事务、身份绑定和批量操作不足         |
| 搜索反馈模型             | 部分实现 | 已接入重排，默认启用策略与设计不符                 |
| 聚类自动分组             | 原型     | 分桶算法和重算覆盖行为不满足正式管理要求           |
| 重复/近重复整理          | 未集成   | 项目已有 Duplicate Finder，可复用而未接入          |
| OCR 分类                 | 未实现   | 后续能力                                           |
| 视频关键帧分类           | 未实现   | Media Search 已有帧索引，可作为后续复用入口        |
| 分类导入/导出/迁移       | 未实现   | 大库维护和恢复所需                                 |

## 性能与规模

### 当前真实数据快照

| 项目                       |      数量 |
| -------------------------- | --------: |
| `assets.jsonl` 行数        |   187,370 |
| active 素材                |   180,034 |
| 已分类 active 素材         |        47 |
| 未分类 active 素材         |   179,987 |
| archived 素材              |         7 |
| 分类                       |         1 |
| 标签                       |         0 |
| 外部参考图                 |         1 |
| 分类关系                   |        54 |
| 建议总数                   |       500 |
| confirmed / rejected       |   54 / 98 |
| suggested / low confidence | 160 / 188 |
| 聚类组                     |         0 |

### 性能判断

1. 虚拟网格解决了 DOM 卡片数量，不解决 Electron 主进程的全量查询和排序。
2. JSONL 适合 append log 和小规模恢复，不适合作为十八万行交互式 catalog 的唯一查询层。
3. AI 任务的主要瓶颈是磁盘吞吐、JSON 解析、GC 和 O(NxM) 相似度，不只是 GPU 推理。
4. recurring task 不应重复解析 2.5-3.8GiB JSONL；应使用 compact binary/ANN 和增量 checkpoint。
5. 外部参考图单张导入重写完整 catalog，写放大明显。

## 安全与恢复

### 已有安全基线

1. Electron 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
2. 新窗口默认拒绝，导航受限。
3. React 文本默认转义，未发现 NekoSearch 直接 HTML 注入。
4. IPC guard 限制 ID、分页数量和多数文本长度。
5. NekoSearch 清理和归档只修改元数据，不删除原始素材。
6. 单个 JSONL store 采用临时文件加 rename，降低单文件半写风险。
7. `npm audit --omit=dev --audit-level=high` 报告 0 个漏洞。

### 恢复缺口

1. 跨 store 操作没有 write-ahead log 或事务恢复。
2. 取消任务不能保证内存回滚。
3. JSONL 没有统一 schema version、migration 和 revision。
4. 聚类重算覆盖人工状态，没有 lineage。
5. 缺少“校验并修复孤儿关系”的维护命令。

## 复用、扩展性与死代码

### 复用评价

合理复用：Image Search manifest、DINO/CLIP embedding、模型缓存、缩略图、虚拟网格、typed IPC、进度事件、窗口 shell guard 和稳定素材 ID。

尚可复用：Duplicate Finder 的 hash/phash 分组、Media Search 的关键帧 catalog、现有 ANN/binary cache、通用任务协调器和性能日志。

禁止形成的新重复：不得再为 NekoSearch 单独实现另一套模型下载、缩略图生成、原图删除、窗口管理或大文件 JSONL 全量搜索。

### 扩展性判断

当前数据模型已保留 `source/status/confidence`，核心 JSONL 写也有恢复 journal 和统一任务队列；增加高数据量来源前仍应完成 SQLite catalog，避免全量 Map 和跨 `AssetMetadataStore` 关系继续扩张。

### 低价值/待清理逻辑

- `AssetFeedbackMode='force'` 当前没有独立行为，应实现或删除。
- 重复向量记录应 compact，而不是长期依赖运行时 first-seen 去重。
- 聚类桶级相似度和首图代表逻辑不应继续作为正式算法扩展。
- 当前实施文档中的互斥状态描述应归档，避免成为错误开发依据。

未发现可在本次审计中直接判定并安全删除的大块不可达模块；“未完成 UI”不等于死代码。

## 测试缺口

现有 13 个 NekoSearch 专项测试、IPC 注册测试、preload 契约和 UI 冒烟测试均通过，但缺少：

1. 取消同步回滚测试。
2. 真实 `buildReferenceSuggestions` / `buildTagSuggestions` 完整任务测试。
3. 审核状态机、未知 ID、目标删除和写失败故障注入测试。
4. 分类删除与建议任务并发测试。
5. 聚类重算保留人工状态和 promotion 测试。
6. 十八万素材排序、快速输入和过期 IPC 响应测试。
7. 外部参考文件删除/修改后的失效测试。
8. 超大或损坏 index section 的拒绝测试。
9. 固定人工标注集上的搜索反馈 A/B 准确率测试。
10. 数据迁移、断电恢复和孤儿关系修复测试。

## 优化路线

### 阶段 A：一致性和发布阻断项

1. 修复同步取消回滚。
2. 引入 catalog revision、单写者队列和跨关系事务。
3. 严格验证审核建议、目标和素材状态，按 suggestion ID 绑定撤销。
4. 限制索引来源和分配预算。
5. 反馈搜索默认关闭，待准确率门禁通过再启用。

### 阶段 B：大库性能

1. 元数据迁移 SQLite，保留 JSONL 作为导入/导出或 append journal。
2. 列表分页、筛选和排序全部下推数据库索引。
3. UI 增加 debounce、请求 generation 和过期响应丢弃。
4. DINO/CLIP 全库任务移到 worker/utility process。
5. 使用 compact binary/ANN、最小堆和增量 checkpoint。
6. 压缩重复向量并统一 latest-wins 规则。

### 阶段 C：准确率和管理闭环

1. 使用固定标注集校准已持久化的多 prototype 分类阈值。
2. 建立固定人工标注集，记录 Recall@K、Precision@K、Accept rate 和 Reject intrusion。
3. 替换 10 位分桶聚类，保留用户组 lineage。
4. 补全证据图、批量审核、改类、撤销、移除、合并和拆分。
5. 接入 Duplicate Finder，之后再扩展 OCR 和 Media Search 帧。

### 验收标准

1. 任意取消点后内存和磁盘状态完全一致。
2. 故障注入后不存在 orphan suggestion、assignment、reference 或 cluster member。
3. 十八万素材暖机后所有列表排序 P95 小于 50ms，旧请求不能覆盖新筛选结果。
4. 打开 NekoSearch 后主进程额外 heap 目标小于 80MB。
5. 全库任务不在 Electron 主线程解析多 GB JSONL，事件循环卡顿 P95 小于 50ms。
6. recurring task 不再全量解析 JSONL；支持断点、取消和进度恢复。
7. 反馈重排只在固定样本 A/B 改善且 Reject intrusion 不恶化时默认启用。
8. 聚类需报告 coverage、purity 抽样和稳定性；重算不覆盖人工确认结果。
9. 损坏或超预算索引在分配前被拒绝，不导致 OOM。

## 已完成修复与有效能力

本次为审计，不修改生产代码。当前代码中已经存在并验证有效的基础能力包括：

1. NekoSearch 面板懒加载与虚拟网格。
2. typed preload/IPC 契约和基础参数 guard。
3. 稳定素材 ID、missing/archived 状态和不删除原图的安全边界。
4. 分类层级循环保护。
5. 外部图片选择和剪贴板参考图导入。
6. Accept、Reject、Undo 和有界反馈重排基础链路。
7. 单 JSONL 文件的临时写入加 rename。
8. 行级损坏隔离和旧反馈模型 fallback。

## 验证记录

| 项目                    | 命令/方法                                     | 结果                                                                                                    |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| NekoSearch 专项测试     | `npm.cmd run test:asset-library`              | 24/24 通过，约 1.19s                                                                                    |
| IPC 注册                | `npm.cmd run test:ipc-registration`           | 4/4 通过                                                                                                |
| preload 契约            | `npm.cmd run test:preload-contract`           | 1/1 通过                                                                                                |
| TypeScript              | `npm.cmd run typecheck`                       | 通过                                                                                                    |
| Lint                    | `npm.cmd run lint`                            | 通过                                                                                                    |
| Vector 回归             | `npm.cmd run test:vector-pipeline`            | 16/16 通过，363ms                                                                                       |
| Renderer 构建           | `npm.cmd run build:renderer`                  | 通过；Neko chunk 29.62kB，gzip 7.89kB                                                                   |
| Electron UI 冒烟        | `npm.cmd run smoke:ui`                        | 通过，3793ms；六面板及 Neko 分类/标签创建检查通过，0 console error                                      |
| SQLite Catalog 合成基准 | `npm.cmd run benchmark:asset-catalog`         | 180,000 条：首建 2172.92ms；50.73 MiB；最新页 2.45ms；深名称页 9.78ms；路径子串 30.89ms（中位）         |
| 多 store 故障恢复       | 临时 JSONL 正常/异常/半提交回归               | 通过：双 store 全提交、action 异常全回滚、重启完成剩余替换                                              |
| 依赖安全                | `npm.cmd audit --omit=dev --audit-level=high` | 0 vulnerabilities                                                                                       |
| 取消一致性              | 临时数据故障回归                              | 通过：取消后内存、磁盘和 next ID 保持上次提交状态                                                       |
| 真实库只读基准          | 当前 userData catalog                         | 通过；数据见“性能与规模”                                                                                |
| DINO 逆序流短基准       | 当前 3.81GiB DINO JSONL                       | 2,000 个唯一向量 187ms；31.56MiB；heap +0.22MiB                                                         |
| 全量真实 AI 任务        | 未执行                                        | 未验证：会读取数 GB 并改写真实 Neko 数据                                                                |
| NSIS 安装包             | `npm.cmd run smoke:installer:archive`         | 通过；572.83 MiB、176 files、SHA-256 `FC88D99B2CCFADB51C778386AE02947B2A1921304550023AFBC93600B3018BDD` |

## 剩余风险与下一步

P1-01 已完成，P1-02 的核心 JSONL 操作已有可恢复提交边界，P1-03 已完成普通素材分页的 SQLite 投影。P1-06 的桶级共享分数已于 2026-07-18 替换为 DINO Float16 两阶段聚类和逐图纯度过滤。下一步应把分类、标签、建议等关系筛选迁入统一 SQLite schema，逐步收口全量 Map，再把其余向量任务迁移到 worker/ANN；不应通过增加并发路数掩盖主进程 I/O 和解析问题，也不应扩大自动分类默认范围。

随后完成向量 worker/ANN、准确率门禁、聚类 lineage 和人工合并/拆分。UI 功能补齐应建立在一致数据层之上，避免对不稳定的 JSONL 多存储状态继续叠加操作入口。

## 2026-07-18 P1-06 整改复核

原审计关于 10-bit 符号桶、桶级共享相似度和首图代表的发现仍作为历史问题保留；当前代码已完成以下替换：

1. 使用已有 DINO Float16 缓存，12-bit 微桶只负责有界粗路由。
2. 第二遍逐图计算成员与目标中心的原始 cosine，低于 `Purity` 的成员不写入聚类。
3. 组内平均分来自实际成员，代表图选择最接近中心的成员。
4. 默认 `Groups 96`、`Min size 5`、`Purity 0.76`，避免以低阈值追求覆盖率。
5. 200,000 向量只读基准耗时约 28.3 秒，coverage 17.63%，保留成员平均 cosine 0.8531；用户实际重算反馈效果明显改善。

整改结论：**旧桶级纯度缺陷已修复，P1-06 从“阻断”降为“部分完成”。** 仍未验收固定人工标注集上的 cluster purity/coverage、不同重算之间的成员稳定性、用户组 lineage，以及合并/拆分后的状态保留。粗路由本身仍是启发式，但最终成员不再直接继承粗桶分数。

## 审计限制

1. 未对用户真实库执行会写入建议或聚类结果的任务。
2. 未进行断电、磁盘满、权限拒绝和杀进程恢复测试。
3. 未形成覆盖中文、产品图、人物图和场景图的固定人工标注样本。
4. 性能数据来自当前机器和当前真实库，用于定位数量级，不代表所有设备。

## 变更记录

- 2026-07-15：建立 NekoSearch 多维审计基线，记录真实库规模、取消一致性复现、性能测量、发布阻断项和分阶段验收标准。
- 2026-07-16：记录第一批整改：取消快照提交、写队列、审核校验、反馈开关、索引安全预算、请求去抖和有界分页排序。
- 2026-07-16：生成整改版 NSIS 并通过归档完整性检查；packaged UI 与干净 VM 安装仍待发布前验证。
- 2026-07-16：记录第二批整改：embedding latest-wins 逆序流、多 prototype 参考分类、候选最小堆、外部参考图失效、active 聚类范围和 ETA。
- 2026-07-16：记录第三批整改：分类专属阈值持久化、核心 JSONL 多 store 写前 journal、启动恢复和半提交故障回归。
- 2026-07-16：记录第四批整改：SQLite 素材查询投影、指纹校验/内存回退、18 万条性能基准和 Electron 构建输出清理。
- 2026-07-18：记录 Clusters 质量整改：DINO Float16 缓存、12-bit 粗路由、逐图原始 cosine 纯度过滤、真实缓存基准和用户实际库定性验证。
