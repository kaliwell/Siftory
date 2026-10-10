# PREP-009 Image Search 数据目录增量刷新验证

> 状态：已验证  
> 日期：2026-08-22  
> 范围：Data Editor 全量目录的 append-tail、源指纹、未变化分片复用与受影响目录祖先汇总  
> 权威产物：`artifacts/benchmark/data-catalog-prep009/latest.json`

## 结论

PREP-009 已通过正确性、安全、资源和真实数据性能门禁。目录 schema 升级为 v2；已有 v2 快照满足严格追加条件时，新 generation 复制上一代不可变 SQLite，只验证源前缀并读取旧末尾不完整的 8 MiB chunk 加新增尾部，未变化向量分片不再全量读取。变更路径只更新自身和受影响的目录祖先；不满足条件时自动执行原有全量重建。

当前真实 DINO/CLIP 权威源共 12,194,373,682 bytes（约 11.36 GiB）。三轮无变化刷新均报告 `fullBytesRead=0`、`tailBytesRead=0`，P50/P95 为 12.171/12.452 秒；相对同轮全量 129.129 秒，P95 缩短约 90.36%。隔离的 80,000 行/层追加语料中，只读取 3,173,392 / 23,482,000 bytes（13.5141%），增量刷新 1.273 秒，对照全量 5.468 秒，改善 76.72%。两类验证的汇总与逻辑 SHA-256 均和干净全量重建一致。

真实图片、向量 JSONL、Native 索引和现有目录 generation 全程只读；正式基准只在隔离临时目录生成派生 SQLite。

## 生产实现

1. `source_files` 持久化源顺序、层、物理键、size/mtime、抽样 SHA-256、完整 chunk-tree 根、前缀证明、model/type namespace 和精确行统计；`source_chunks` 保存固定 8 MiB chunk 的 SHA-256。chunk-tree 覆盖源文件每个字节，不以抽样哈希代替完整内容指纹。
2. 目录服务只把已提交且校验通过的 v2 catalog 作为 `previousDatabasePath` 交给 worker。worker 在新的 staging generation 中复制它，不原地修改当前或上一代数据库。
3. 未变化源必须同时匹配 source id、顺序、层、物理键、大小、mtime、抽样哈希和已保存 chunk 根，才能完全复用。
4. append-tail 还要求旧前缀证明通过、旧长度停在换行边界、每层只有一个物理源且该源只有一个 model/type namespace。扫描从旧长度所在的 8 MiB chunk 起点开始，重算该部分 chunk 和新增尾部，较早完整 chunks 直接复用。
5. Native 新增或属性变化通过临时 `next_native` 表做集合差分；Native 移除/tombstone 会使增量路径失效并执行干净全量重建，避免旧目录记录复活。
6. 追加行精确更新 DINO/CLIP 行数、字节数、重复修订、malformed 和源统计；namespace 改变会中止增量并转全量。源缩短、同尺寸改写、前缀改写、分片集合/顺序变化、GC/压实、修复性替换和 schema v1 同样安全失效。
7. `changed_paths` 在更新前保存旧状态。增量汇总只对旧/新路径的目录链做差量更新，再重算受影响节点的直接子目录数并删除空节点；完整构建仍使用 SQLite `iterate()` 流式生成全部 rollup。
8. 12 GiB 全量行扫描由逐字节 JavaScript 循环改为 `Buffer.indexOf(0x0a)`；8 MiB 单行上限、超长行 malformed 计数、取消检查和事务边界不变。
9. catalog 逻辑 SHA-256 绑定 source snapshot、规范化 roots、按序源完整指纹/统计和稳定汇总。小型门禁另行逐行比较 `indexed_paths` 与 `folder_rollups`，因此没有把摘要相等冒充为行级证明。
10. worker 公共消息与输入输出类型拆到独立 contract 模块；路径链和目录汇总也独立拆分。主进程不再因 type-only 依赖遍历 worker 实现图，架构预算仍为 283，没有放宽。

## 正确性与失效矩阵

| 场景 | 预期与结果 |
| --- | --- |
| 无变化 generation | 复用两个向量源；向量 full/tail 读取均为 0；汇总与 SHA 一致 |
| 单层 append，含新增、重复和 malformed | 只读旧 partial chunk + tail；统计、路径行、目录行和干净全量逐行一致 |
| Native-only 新增或元数据变化 | 增量应用，不读取向量分片；受影响祖先精确更新 |
| Native 移除/tombstone | 增量失效，自动全量重建，不保留旧可见记录 |
| 源缩短、同尺寸替换、旧前缀改写 | 完整性证明或 stat/fingerprint 失配，自动全量重建 |
| model/type namespace 或源集合/顺序变化 | 自动全量重建，避免跨 namespace 错算 duplicate |
| GC、压实、修复性源替换 | 作为非追加变化失效并全量重建 |
| 取消 | 返回 cancelled；不会把取消误当失效后继续全量，也不会提交 staging |
| schema v1、损坏或 `quick_check` 失败的旧目录 | 不复用，安全全量构建 v2 |

## 正式基准

执行命令：

```powershell
npm.cmd run benchmark:data-catalog:prep009
```

正式通过产物：`artifacts/benchmark/data-catalog-prep009/2026-08-22-08-58-44-894/report.json`。

### 当前真实只读数据

| 指标 | 结果 |
| --- | ---: |
| Native 当前有效记录 | 266,372 |
| CLIP / DINO bytes | 4,915,701,546 / 7,278,672,136 |
| 向量源总 bytes | 12,194,373,682 |
| 路径并集 | 440,907 |
| Native / DINO / CLIP 唯一项 | 266,372 / 440,450 / 440,462 |
| 三层完整 | 265,927 |
| missing DINO / missing CLIP | 445 / 445 |
| vector-only | 174,535 |
| duplicate / malformed | 0 / 0 |
| 目录节点 | 26,832 |

当前源已经过其他维护，与 2026-08-03 的 975,971 行、12.578 GiB 历史快照不同；旧、新健康计数不能直接解释为本优化造成的数据变化。

### 全量与无变化刷新

| 指标 | 门槛 | 结果 | 状态 |
| --- | ---: | ---: | --- |
| 全量端到端 | ≤150 秒 | 129.129 秒 | 通过 |
| 全量 worker | 记录 | 129.127 秒 | 记录 |
| 全量峰值 RSS | ≤700 MiB | 584.35 MiB | 通过 |
| SQLite | ≤256 MiB | 206.58 MiB | 通过 |
| 无变化刷新 P50 / P95 | 不重读权威向量 | 12.171 / 12.452 秒 | 通过 |
| 三轮 `fullBytesRead` | 0 | 0 / 0 / 0 | 通过 |
| 三轮 `tailBytesRead` | 0 | 0 / 0 / 0 | 通过 |
| 汇总 / catalog SHA parity | 必须一致 | true / true | 通过 |
| 源文件不变 / 派生输出隔离 | 必须 | true / true | 通过 |

全量 129.129 秒相对 2026-08-03 同机历史 127.323 秒慢 1.42%，低于统一 3% 噪声阈值；RSS 基本持平，SQLite 更小。无变化刷新仍需复制约 206.58 MiB 的上一代 SQLite、执行 `quick_check` 和有界前缀证明，因此不是零耗时，但不再顺序读取全部权威向量。

### 隔离追加 A/B

| 指标 | 结果 |
| --- | ---: |
| 追加前记录 | 80,000 / 层 |
| DINO 追加 | 2,000 行 |
| 追加后源大小 | 23,482,000 bytes |
| 实际尾部读取 | 3,173,392 bytes（13.5141%） |
| 增量刷新 | 1,273.12 ms |
| 干净全量对照 | 5,468.37 ms |
| 改善 | 76.72% |
| 汇总 / catalog SHA parity | true / true |
| 构建模式 | `incremental` |

真实权威源严格只读，所以追加 A/B 使用结构等价的隔离合成源；真实源用于一次全量校准和三轮无变化复用，两者职责没有混淆。

## 被拒绝的迭代

- `2026-08-22-08-48-15-407`：全量 159.834 秒，超过 150 秒绝对门槛；无变化 P95 13.567 秒。未放行。
- `2026-08-22-08-53-56-338`：降低 catalog SHA 计算开销后，无变化 P95 降至 9.822 秒，但全量仍为 162.173 秒。未放行。
- 最终版本保留完整指纹与一致性门禁，仅把全量 JSONL 换行定位改为 `Buffer.indexOf`，全量回到 129.129 秒后才标记 `verified`。

失败迭代继续保留在 `artifacts/benchmark/data-catalog-prep009/`，没有删除或用最终结果覆盖。

## 回归覆盖

- `node --test tests/image-search-data-overview.test.cjs`：15/15 通过。
- `npm.cmd run test:image-search-data-folders`：67/67 通过。
- `npm.cmd run test:vector-pipeline`：235 通过，2 个依赖外部 CUDA fixture 的用例按设计跳过，0 失败。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run test:architecture`：通过；主进程 283/283，catalog worker 29/120。
- ESLint、Prettier、文档门禁与 `git diff --check` 见同日最终验证记录。

## 边界

1. append-tail 是严格优化路径，不是新的权威数据格式。任何证明不足都回到完整扫描；不得为了命中增量而放宽 source identity、namespace、前缀或换行边界检查。
2. `catalogSha256` 是源内容/统计/稳定摘要的逻辑身份，不是 SQLite 文件字节哈希。需要证明具体路径或目录行时，继续使用逐行 parity 测试。
3. Native 删除当前使用全量回退。若未来要做删除增量，必须另行证明路径 latest-wins、空目录删除、child count 和 vector-only 转换，不能沿用本次追加证据直接放行。
4. 无变化刷新主要剩余成本是 SQLite generation 复制和完整性检查；若继续优化，应优先评估受控快照复用或 copy-on-write 能力，并保持 current/previous 两代和原子切换语义。
