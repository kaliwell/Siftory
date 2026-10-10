# DSK-06 权威二进制向量库设计与迁移

> 状态：当前
> 更新日期：2026-08-17
> 范围：权威 Float16 generation 向量存储
> 替代文档：无

日期：2026-07-30

## 决策

权威快照采用“按 generation 分目录的连续 Float16 向量文件 + 流式 JSONL 路径元数据”。
`CURRENT` 是唯一提交点；它只在新 generation 的文件尺寸、行数和 SHA-256 全部通过后切换。

每个模型条目记录：

- `modelName`、`embeddingType`、`dim`、`dtype=f16-le`、`count`；
- 向量文件和路径文件的名称、字节数、SHA-256；
- 每个路径行的 `row`、`path`、字节 `offset`；
- 导入源的路径、尺寸和修改时间；
- generation、创建时间和 manifest 校验和。

## 方案比较

| 方案 | 空间与读取 | 事务/恢复 | 结论 |
| --- | --- | --- | --- |
| 连续 F16 generation | F32 的 50%；可顺序读取、随机定位，也可由操作系统映射 | staging 完整校验后切 `CURRENT`；旧 generation 可回退 | 采用 |
| 连续 F32 generation | 精度最高，但占用和 I/O 为 F16 的 2 倍 | 与 F16 相同 | 仅作为精确导入/导出或基准对照 |
| SQLite BLOB | 元数据事务方便；大 BLOB 读取通常产生额外复制，跨 worker 访问复杂 | SQLite 自带事务 | 不作为主向量载体；适合关系元数据 |
| 单一 mmap 文件 | mmap 是访问方式，不是完整格式；Windows 下替换被映射文件也更难 | 仍需另行设计 manifest、代际和恢复 | 当前连续 F16 文件已兼容未来只读 mmap，不单独采用 |

分块的边界是 model/embeddingType 文件和 generation。单个向量可通过
`offset = row * dim * 2` 定位，迁移过程不会把数 GB 向量展开到 JS 对象。

## 迁移与失败语义

维护页的 `Preview Binary Migration` 先做只读源统计。用户明确确认后：

1. 从现有 JSONL 流式构建/刷新 F16 导入缓存；
2. 以 1 MiB 块复制向量并计算 SHA-256，逐行重写路径元数据和 offset；
3. 写入 staging manifest，重新校验所有文件；
4. 将 staging 重命名为 generation，最后原子替换 `CURRENT`。

取消、源损坏、空间不足、校验失败或提交失败都不会修改旧 `CURRENT`。未被
`CURRENT` 引用的 staging 会删除；已完成但未提交的 generation 和旧 generation
会进入安全清理预览。

## 读取与更新一致性

所有经过 `ensureEmbeddingF16Cache` 的图片搜索、相似搜索、聚类、反馈和 DINO
重排入口会优先读取当前权威 generation。ANN 指纹包含 generation 文件信息，
切换后不会复用旧 ANN。

如果导入 JSONL 在切换后继续增长或被改写，读取层会检测尺寸/mtime 不一致并
暂时回退到刷新后的导入缓存，避免新 embedding 被旧 generation 静默遮住。重新
执行迁移后，新 generation 再次成为权威读取源。若已确认移除导入副本，源文件
缺失不会使已校验的 generation 失效。

## 清理边界

切换后，既有 F32/F16 派生缓存会自动出现在 `Preview Cleanup` 的
`F32/F16 caches` 项；后续旧 generation 出现在 `Old vector generations` 项。
两类均仍需用户明确确认。

当前不把原始 embedding JSONL 列为可删除项：embedding 追加写仍以它作为
双写目标之一；Media Search 帧索引自 D2c 起优先读 generation（失配时
回退 JSONL），迁移与召回门禁分别以它为导入源与 F32 对照源。诊断/导出
入口已在 D3 阶段 3（第一百一十八批）改读 generation + 增量段路径索引，
不再逐行扫 shard。该副本只保留在迁移兼容窗口：随着"embedding 追加"与
"诊断/导出"两类入口相继关闭，JSONL 的剩余角色已收敛为"迁移导入源 +
召回门禁对照源 + 追加写目标"，其退役（纳入高风险清理预览）属阶段 4
评估事项，需双写稳定运行 N 个维护周期后再评估。增量日志的设计决策记录见
[阶段 D3：embedding 追加增量日志设计](2026-08-05-embedding-append-incremental-log-design.md)。

## 真实数据只读评估

2026-07-30 对当前用户数据只读取文件尺寸：

- CLIP + DINO JSONL：13,123,115,303 bytes；
- 现有 DINO F16：295,339 行、453,640,704 bytes；
- 按相同行数估算双模型 generation（含两份路径元数据）：约 839,015,636 bytes；
- C 盘当时可用空间：30,266,146,816 bytes；
- `vector-store` 尚不存在，未执行真实迁移，实际写入和删除均为 0。

## 验证

专项测试覆盖流式迁移、offset、全量校验、原子代际切换、取消保留旧
`CURRENT`、源更新回退、截断损坏拒绝和旧 generation 清理预览。真实用户数据
本批只允许只读容量评估，不自动迁移或删除。
