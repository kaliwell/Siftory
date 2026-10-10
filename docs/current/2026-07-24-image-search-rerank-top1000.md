# Image Search Top 1000 Reranking 优化

> 状态：当前  
> 更新日期：2026-07-24  
> 范围：Image Search Precise 模式的大候选集颜色/形状精排  
> Git 边界：仓库已初始化但仍无首个提交；本轮属于未提交现场

## 执行身份

- 执行身份：Codex。
- 模型信息：GPT-5 系列；运行时未提供可可靠确认的精确小版本。
- 本轮没有启动 Codex 子代理，也没有读取或代替 Kimi agents。

## 根因

Top 1000 的 UI 请求会拉取最多 2,000 个 Hash 候选和 3,000 个向量候选，合并后可能有
约 5,000 条记录。旧 Precise reranking 对每条记录执行以下操作：

1. 重复查询 query 和 candidate 的颜色、形状特征；每条候选实际最多 8 次查询。
2. 特征查询使用 `Array.filter` 扫描整个 JSONL 内存缓存。当前颜色和形状库各有 41,401
   条记录，因此复杂度接近 `候选数 × 特征记录数`。
3. 缺失特征时逐候选串行处理；颜色读取一次图片，形状又执行 metadata、RGBA、灰度流程。
4. 每次追加特征前都会提前序列化整个约 32 MiB 颜色缓存作为故障恢复快照。
5. Precise 会为全部合并候选生成特征，即使最终只返回 Top 1000。

## 已完成

### O(1) 特征索引

`JsonLinesStore` 增加可复用的 `uniqueKey` 二级索引和 `getByUniqueKey`：

- 首次读取 JSONL 时建立 `Map`；
- 后续单条查询为 O(1)；
- insert、insertMany、update、replace、delete、rollback 和 reset 会维护或失效索引；
- 颜色和形状 store 以 `imageId` 为唯一键；
- 其他 JSONL store 后续也可以复用同一能力。

### 写入恢复快照延迟生成

追加写入不再无条件序列化整个 store。只有前一项写入已经失败、确实需要全量恢复时，才生成
快照。原有 fail-closed、写队列和故障后全量恢复行为保留，并通过已有故障测试。

### 两阶段精排

Precise 先按 Hash＋DINO 基础分数稳定排序，再对以下候选使用颜色和形状：

```text
feature pool = min(合并候选数, max(200, 返回 TopK × 2))
```

因此 Top 1000 最多精排 2,000 个高概率候选，仍返回完整 1,000 条结果；其余候选继续使用
Hash＋DINO 基础分数。该设计是级联 reranker，不是减少用户要求的返回数量。

### 缺失特征的交互预算

- 每次交互查询最多增量生成 32 张缺失图片的颜色/形状特征。
- 使用 6 路有界并发，同一图片的颜色和形状任务并行。
- 后续查询会继续复用并逐步补齐缓存。
- 新搜索可取消旧 reranking；不会继续为几千张图片在后台串行解码。
- 响应增加 `featureRerankCandidateCount`、`featurePreparedCount`、
  `featureDeferredCount` 和 `featureMs`，便于继续测量。

这里的颜色/形状提取主要是 CPU 解码与文件 I/O，不属于 DINO GPU 推理。提高 GPU jobs 不会
直接提高这一阶段速度。

## 真实数据结果

当前真实特征库：

| 项目         |            数量/大小 |
| ------------ | -------------------: |
| 颜色特征     | 41,401 条，约 32 MiB |
| 形状特征     | 41,401 条，约 13 MiB |
| 重复 imageId |                    0 |

### 查表基准

对 1,000 个真实 imageId 模拟旧循环的每候选 8 次查询：

| 场景                       |        耗时 |
| -------------------------- | ----------: |
| 旧线性查询                 | 5,787.14 ms |
| 新索引首次查询             |    29.16 ms |
| 新索引热查询               |     0.33 ms |
| 2,000 条颜色＋形状实际打分 |     5.42 ms |

### 完整 Top 1000 reranking 模拟

使用 5,000 个真实存在路径作为合并候选，返回 1,000 条：

| 场景                   | 总 reranking |
| ---------------------- | -----------: |
| 首次加载 41,401 条特征 |       695 ms |
| 同进程第二次查询       |       422 ms |
| feature pool           |        2,000 |
| 返回结果               |        1,000 |

### 全缺失缓存测试

在临时空数据库中使用 100 张真实图片：

| 指标           |     结果 |
| -------------- | -------: |
| 返回耗时       | 2,123 ms |
| 本轮新生成     |       32 |
| 延后到后续查询 |       68 |
| 提取失败       |        0 |

旧行为会继续处理全部缺失图片；Top 1000/2,000 精排候选下可能持续几十秒到数分钟。现在交互
查询具有固定的单轮增量上限。

## 验证

```text
npm.cmd run typecheck
node --test tests/rerank-cascade.test.cjs \
  tests/vector-database-persistence.test.cjs \
  tests/vector-pipeline.test.cjs \
  tests/embedding-f16-cache.test.cjs \
  tests/vector-ann-index.test.cjs \
  tests/vector-ann-worker.test.cjs \
  tests/preload-contract.test.cjs \
  tests/ipc-registration.test.cjs
npm.cmd run build:renderer
```

结果：

- TypeScript 通过。
- 38/38 项相关测试通过。
- 新增 Top 1000 级联精排测试：5,000 合并候选、2,000 feature pool、返回 1,000，
  结果第一名和计数均正确。
- 新增唯一键索引增删改一致性测试；热查询不会重新遍历全部记录。
- Renderer、main、preload 和全部 Worker 构建通过。
- 项目完整 `npm.cmd test` 通过；日志包含 23 个 `fail 0` 测试组，没有失败标记。

## 剩余边界

1. 首次加载 45 MiB JSONL 仍需约 0.27 秒；后续可迁移为 SQLite 或紧凑二进制特征表。
2. 单张超大图、损坏图片、机械盘随机读取仍会影响最多 32 张的本轮增量提取时间。
3. Top 1000 采用 2 倍候选池。要调整倍数，必须用标注集比较精排前后的 Recall/NDCG，
   不能只追求更低耗时。
4. 当前图片仍分别执行颜色和形状 sharp 管线。统一为一次解码需要特征版本迁移，否则会造成
   旧缓存与新缓存的分布不一致。
5. 当前交互预算优先保证响应速度；延后的候选仍使用 Hash＋DINO 基础分数，并会在后续查询
   中逐步补齐特征。

## 构建产物

完整 `npm.cmd run build` 已通过，包含 TypeScript、Electron 原生模块、Electron Builder
和 NSIS：

```text
release/FloatingClock Setup 1.0.0.exe
大小：600,744,548 bytes
时间：2026-07-24 12:29:00
SHA-256：57A55F160271046C311543F48D9FE2A4328380577D65021D632E44D68634769C
```

本轮没有自动安装或覆盖当前运行版本。
