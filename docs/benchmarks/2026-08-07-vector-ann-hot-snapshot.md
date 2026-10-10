# Vector ANN hot snapshot optimization

> 日期：2026-08-07<br>
> 任务：`VAL-002`<br>
> 范围：合成向量与派生 ANN 文件；未读取或修改真实用户数据

## 问题

ANN worker 会保留最近一次搜索的内存索引，但旧 key 包含完整 source fingerprint。只要 committed delta
追加一批向量，key 就变化，worker 会重新读取 base F16 与全部 delta，使用 `Buffer.concat` 复制完整向量，
并重新解析 base 与 delta 的所有路径。磁盘签名虽然能够增量扩展，最大的向量和路径 I/O 仍然是 O(base + delta)。

## 实现

- worker 把 F16 向量与 ANN 签名保存为连续、只追加的内存分段；精排与候选收集直接跨分段读取。
- base generation fingerprint、base/delta 向量尾哈希、已提交路径前缀尾哈希和派生签名文件身份均一致时，
  只从上次 commit offset 读取新 delta 向量和 UTF-8 路径行。
- 签名文件先截断到旧 metadata commit point，再只追加新签名并 `fsync`；metadata 仍作为最后原子提交标记。
- count 不变而 source metadata 变化时只更新 metadata，不读取向量或路径。
- generation、向量前缀、路径前缀或派生文件发生变化时拒绝热复用，重新载入完整快照；ANN 失败时上层
  仍保留 exact Float16 搜索回退。
- 连续热追加最多保留 64 个分段，超过上限后完整重载一次，避免长期 worker 产生无界分段。

## 可验证结果

合成测试使用 4,096 行、32 维 Float16 base，然后提交 4 行 delta：

| 指标 | 结果 |
| --- | ---: |
| 复用 base 向量 | 262,144 bytes |
| 新读取 delta 向量 | 256 bytes |
| 本次向量读取占最终快照 | 0.098% |
| snapshot load mode | `delta-only` |

测试还验证：

- 两轮含中文路径的 delta 追加均只读取后缀；下一次相同快照为零向量/路径 I/O。
- 热追加签名文件与删除派生文件后的完整重建逐字节一致，搜索结果一致。
- 分段签名候选和分段 F16 精排与连续 Buffer 结果一致。
- delta 向量前缀、路径前缀或 generation 改变时强制完整快照重载。
- 大小不变的 source metadata 更新进入 `metadata-only`，不读取向量和路径。

验证命令：

```powershell
npm.cmd run test:vector-ann
npm.cmd run test:vector-pipeline
```

真实库 benchmark 脚本增加了 `snapshotLoadMode`、`vectorBytesRead`、`pathBytesRead` 和
`reusedVectorBytes` 字段，但本任务没有运行它，避免在缺少维护授权时读取真实用户向量。
