# 按来源派生数据清理自动优化 TODO

> 状态：部分实施  
> 更新日期：2026-08-24  
> 范围：Native 物理压实、来源缓存隔离、诊断、缩略图、主体向量与历史任务痕迹清理  
> 执行方式：Codex 自动完成，真实来源只读验证，写入测试仅使用临时夹具  
> 当前所有者：Codex/root  
> 替代文档：无

## 目标

修正“逻辑上已删除、物理文件仍残留”、无视频命中时误报/误删共享缓存，以及主体模型独立缓存未进入来源清理的问题。保持原始图片、原始视频、模型、人工素材库元数据及其他来源的数据不变。

| ID      | 优先级 | 状态     | 执行系统 | 所有者     | 自动验收                                                                                         | 内容                                                                                                        |
| ------- | ------ | -------- | -------- | ---------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| SRC-001 | P0     | verified | Codex    | Codex/root | `npm.cmd run test:source-derived-cleanup`                                                        | Native 删除后强制压实，清除 tombstone、overlay 和被替换的旧段                                               |
| SRC-002 | P0     | verified | Codex    | Codex/root | `npm.cmd run test:source-derived-cleanup`                                                        | 图片来源无视频命中时，不删除且不计入视频共享缓存                                                            |
| SRC-003 | P1     | verified | Codex    | Codex/root | `npm.cmd run test:source-derived-cleanup`                                                        | 按来源清理 embedding failure、diagnostic、诊断备份和输入拒绝缓存                                            |
| SRC-004 | P1     | verified | Codex    | Codex/root | `npm.cmd run test:source-derived-cleanup`                                                        | 扫描来源文件身份并清理未进入 Native 快照的孤立缩略图                                                        |
| SRC-005 | P1     | verified | Codex    | Codex/root | `npm.cmd run todo:source-cleanup-auto`                                                           | 更新预览口径、文档、类型检查、回归测试与构建证据                                                            |
| SRC-006 | P0     | verified | Codex    | Codex/root | `npm.cmd run test:source-derived-cleanup` + `node --test tests/subject-embedding-store.test.cjs` | 将 `subject-embeddings` 纳入按来源预览与原子清理，同步失效内存缓存，覆盖 crop/face/osnet 与 negative marker |
| SRC-007 | P1     | verified | Codex    | Codex/root | 受管日志夹具 + `npm.cmd run test:source-derived-cleanup`                                         | 默认保留审计痕迹；仅在显式选择时结构化清理固定白名单文件，不扫描或删除普通日志                              |
| SRC-008 | P0     | blocked  | Codex    | Codex/root | 用户执行删除后进行真实只读复验                                                                   | 依赖 `SRC-006`；验证原素材不变，Native/DINO/CLIP/主体向量/缩略图/视频派生数据均为 0，且无事务残留           |

## 当前结论

- `SRC-006` 已完成：主体向量进入来源预览和事务，按规范化来源边界原子过滤 `crop:*`、`face:*`、`osnet:*` 与 negative marker，并在提交后同步失效内存缓存。
- `SRC-007` 已完成：默认保留审计轨迹；显式 `remove-source-traces` 只处理固定白名单中的受管 JSON/日志，JSON 执行结构化脱敏，日志仅过滤来源匹配行，不遍历或删除普通日志。
- `npm.cmd run test:source-derived-cleanup` 通过 69/69；`node --test tests/subject-embedding-store.test.cjs` 通过 5/5。全量 `npm.cmd test` 于 2026-08-24 通过，包含 Native 73/73、Media Search 217/217 和相关回归。
- Native 版本提升到 `fast_scanner 0.5.31`。异步 manifest 热切换不再泄漏 mmap、mapping handle 或 file handle；单段 tombstone 可以物理压实，测试确认旧路径字节、overlay 和旧段均消失。
- 已逻辑删除但仍有历史 overlay 的来源可以重新分析：即使来源 Native 计数为 0，预览仍提供维护目标并在执行时压实。
- 图片模型缓存的文件数和字节已进入预览与最终释放统计；没有视频命中时，四类视频共享缓存保持不变。
- 用户已在 2026-08-23 18:47 对真实 `D:\PxHereDataset\images` 再次执行删除；Codex 随后仅做只读复检，没有再次触发真实删除。
- 2026-08-23 的真实复检仍是当前真实数据证据：`subject-embeddings/embeddings.jsonl` 有 17 条 `crop:subject` 记录，历史自动化白名单文件仍有来源痕迹。它们产生于新实现接线之前；代码整改通过不等于这些既有记录已经被删除。

## 真实复检证据

| 检查项               | 结果                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 原始素材保护         | 58,000 JPG + 58,000 JSON，共 197,716,121,594 bytes；清理时段改写 0 个                                                    |
| Native               | 目标 0 条/0 bytes；v4 单活动段、208,413 条其他记录、overlay/replaced/deleted 为 0、path map 健康；物理字节扫描无目标路径 |
| DINO/CLIP 与辅助向量 | 完整 `vector-db` 扫描目标路径 0；两份主分片合计 10,598,447,876 bytes                                                     |
| 诊断/失败/拒绝       | 目标路径 0                                                                                                               |
| 缩略图               | 扫描 58,000 张源图，命中 0 个/0 bytes，扫描完整且无警告                                                                  |
| 视频                 | 源视频 0 个，`media-search` 目标路径 0；其他来源缓存保留                                                                 |
| 主体向量             | **失败：17 条 `crop:subject`，约 277,700 bytes**                                                                         |
| 历史任务痕迹         | 4 个 `value-automation` 文件仍含 251 行目标路径，共 36,459 bytes；不参与当前检索，但严格无痕口径尚未满足                 |
| 事务与后台任务       | 无来源清理临时/回滚文件，无后台扫描或向量重建任务                                                                        |

## 下一执行顺序

1. `SRC-006`、`SRC-007` 的工程实现和隔离夹具门禁已经完成。
2. 由用户决定是否在新构建中再次对真实来源执行删除，以及是否显式勾选清理受管审计痕迹；默认策略仍保留审计记录。
3. `SRC-008`：删除完成后仅做真实来源只读复验；主体向量等派生数据全部为 0、原始素材不变后，才能把真实数据验收标为完整通过。

## 自动化边界

- 自动命令只修改项目代码和系统临时目录中的隔离测试夹具。
- 不对 `D:\PxHereDataset\images` 或其他真实素材执行第二次删除。
- Native 物理压实必须在原子 manifest 切换后验证；压实失败不得伪报完整成功。
- 来源目录遍历只读取文件名和时间戳，不读取、改写或删除原始素材。
- 素材库及其备份属于明确保留项；不得为了得到全盘字符串命中 0 而删除人工分类、标签、集合、反馈或稳定素材身份。
