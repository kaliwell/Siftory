# NekoSearch 分类数据丢失恢复记录

> 日期：2026-07-18  
> 状态：当前
> 实施状态：已完成可恢复数据回写，并增加删除回收与撤销机制

## 1. 现象与结论

`Categories & Tags` 数据丢失不是单纯的前端筛选或刷新问题。现场文件显示：

- `categories.jsonl`、`asset_categories.jsonl`、`category_references.jsonl`、`suggestions.jsonl` 在 2026-07-18 13:25:16 同时被提交为空文件。
- 这四个 store 的组合与“删除分类”事务完全一致。
- `tags.jsonl` 已不存在，`asset_tags.jsonl` 也为空，因此旧标签不能从当前 store 还原。
- Clusters 的人物语义分组只写 `cluster_groups.jsonl` 和 `cluster_group_assets.jsonl`，不是本次分类 store 清空的直接写入方。
- 原事务在成功提交后不保留旧目标文件，现场也没有找到更早的用户数据备份。因此，已经被覆盖且没有留在 Cluster 数据中的旧手动分类、标签和审核关系不能完整恢复。

## 2. 已执行恢复

恢复前已复制完整资产库到：

```text
<APP_DATA>\asset-library-recovery\before-recovery-20260718-133112
```

恢复完成后又保存了一份关键分类、标签、Cluster 和反馈状态快照：

```text
<APP_DATA>\asset-library-recovery\after-recovery-20260718-135100
```

从仍然存在的 confirmed 语义 Cluster 中恢复：

| 分类 | 素材关系数 |
| --- | ---: |
| Cosplay photos | 590 |
| Real model photos | 315 |
| Wedding portraits | 250 |
| 合计 | 1,155 |

恢复结果：

- `categories.jsonl`：3 个正式分类。
- `asset_categories.jsonl`：1,155 条 confirmed 分类关系。
- 关系校验：0 个无效分类 ID、0 个无效素材 ID、0 个重复素材/分类对。
- 恢复分类记录保存 `sourceClusterGroupId`，后续可追溯其来源 Cluster。
- Search Learning revision 已标记为 dirty；服务初始化会在 revision 不一致时调度后台重建。实测启动后由 `revision 281 / builtRevision 280` 更新为 `281 / 281`。

## 3. 防止再次丢失

### 3.1 持久化删除回收记录

新增 `metadata_deletion_trash.jsonl`。删除分类或标签时，同一个 JSONL 事务先保存：

- 被删除的分类或标签；
- 分类/标签与素材的关系；
- 分类参考图；
- 相关 AI Suggestions。

事务成功后才从正式 store 移除数据。回收记录不触碰原始图片文件。

### 3.2 撤销最近一次删除

`Categories & Tags` 增加 `Undo last delete`：

- 恢复最近一次尚未撤销的分类或标签删除。
- 使用新的安全 ID 恢复，避免与后来创建的数据冲突。
- 同步恢复关系、参考图和 Suggestions，并重映射关联 ID。
- 恢复来源为 Cluster 的分类时，将对应 Cluster 状态恢复为 confirmed。
- 撤销后标记 Search Learning 派生模型为 dirty。

### 3.3 误触保护

- 分类/标签删除仍需两次确认。
- 确认状态现在 5 秒后自动失效，不会跨越长时间操作一直保持 armed。
- 删除来源 Cluster 的正式分类时，对应 Cluster 回到 suggested，可再次转为分类。

### 3.4 全库元数据备份与恢复

- 启动后自动创建每日 SHA-256 快照，默认保留最近 7 份。
- NekoSearch 顶部 `Backups` 支持立即备份、列表、校验和选择恢复。
- 每次恢复前强制创建 `pre_restore` 保护快照。
- 恢复使用独立 journal；中途退出后在下次启动继续，校验失败时停止初始化和写入。
- 快照覆盖分类、标签、关系、建议、聚类、参考图关系、删除回收记录和 Search Learning 状态；可重建的 SQLite catalog 不作为权威备份。

## 4. 验证

2026-07-18 已通过：

- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `npm.cmd run test:asset-library`：54/54
- `npm.cmd run test:ipc-registration`：4/4
- `npm.cmd run test:preload-contract`：1/1
- `npm.cmd run smoke:ui`

UI smoke 使用独立临时 userData，实际执行“创建分类 -> 删除分类 -> 撤销删除 -> 确认分类重新出现”。结果：

```text
categoryCreated: true
categoryDeleted: true
categoryRestored: true
consoleErrors: 0
```

## 5. 当前边界

本次只能恢复仍可由 confirmed Cluster 证明的 3 个分类和 1,155 条关系。被成功覆盖、且没有历史备份或 Cluster 证据的旧分类名称、标签、Accept/Reject 状态不能可靠推测，不能伪造恢复。

后续仍建议将分类、标签、建议和审核关系迁移到 SQLite，并增加便携导出/导入和系统级磁盘故障测试。删除回收负责误删撤销，版本化快照负责整库恢复，两者已经形成互补保护。
