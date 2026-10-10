# 真实向量追加与崩溃恢复验证

日期：2026-08-07
范围：`VAL-001` 已授权维护窗口内的小批量真实写入；未删除、迁移或清理用户数据

## 结论

真实 DINO 数据完成 2 条小批量追加，复合快照计数、唯一图片数和追加后的召回门禁全部一致。随后分别向增量向量段与路径索引注入未提交尾部，正常恢复流程将文件逐字节恢复到最后提交点，证明崩溃尾部不可见且可恢复。

| 指标                                  |        写入前 |        写入后 | 结果   |
| ------------------------------------- | ------------: | ------------: | ------ |
| DINO 记录数                           |       321,002 |       321,004 | +2     |
| DINO 唯一图片数                       |       320,356 |       320,358 | +2     |
| CLIP 记录数                           |       317,268 |       317,268 | 未改变 |
| CLIP 唯一图片数                       |       316,622 |       316,622 | 未改变 |
| DINO 缺失 / malformed                 |         0 / 0 |         0 / 0 | 对齐   |
| DINO 分数等价 recall@50 均值 / 最小值 | 0.9999 / 0.98 | 0.9999 / 0.98 | 通过   |
| DINO self top-1 分数等价率            |         1.000 |         1.000 | 通过   |
| DINO score error p99                  |       6.08e-4 |       6.08e-4 | 通过   |

追加后的 CLIP 只读复检也保持 0 缺失、0 malformed、分数等价 recall@50 均值/最小值 1.0000/1.00、self top-1 分数等价率 1.000、score error p99 3.94e-4。真实召回门禁 2/2 模型通过。

## 安全流程

- 命令默认为只预览；真实执行必须显式提供精确确认串 `--confirm=REAL_VECTOR_APPEND`。
- 候选仅取自真实 pending/failed 作业，且必须不在权威快照中；报告只输出不可逆短哈希，不输出个人路径。
- 模型执行前核对文件尺寸与 SHA-256，图片先检查文件签名，再用 `sharp` 实际解码。
- 首轮选中的 2 个 BMP 虽有合法文件头，但实际解码失败；流程在任何向量写入前终止。由此补上了解码预检，复核确认真实 shard/delta 的尺寸和修改时间均未变化。
- 正式批次选择 2 个可解码 TIFF，通过隔离 CPU worker 生成 768 维、单位范数 DINO 向量，并沿正式 `appendEmbeddingNoUpsertAsync` 双写链提交。
- 崩溃演练前在独占临时目录备份增量提交文件；注入 3 字节未提交 F16 尾部和 7 字节 malformed 路径尾部后，重置进程内增量状态并调用正常 prepare/recovery。
- 恢复后逐文件校验尺寸和 SHA-256，与提交点完全一致；任何恢复异常都会先从安全备份还原再报错。
- 全程未清理、删除或迁移数据，未改写源图片，未触发 CLIP 追加。

## 自动化与验证

- `npm.cmd run validate:vector-real-append -- --user-data-dir=<userData>`：只读预览。
- `npm.cmd run validate:vector-real-append -- --user-data-dir=<userData> --execute --confirm=REAL_VECTOR_APPEND`：授权批次与可恢复崩溃尾部演练；本次已完成，不应作为日常重复命令。
- `npm.cmd run verify:vector-generation-recall -- <userData>`：追加后真实只读复检 2/2 通过，耗时 390.6 秒。
- `node --test tests/vector-maintenance-composite-stats.test.cjs tests/vector-real-append-validation.test.cjs`：7/7 通过。
- `npm.cmd run test:vector-pipeline`：130/130 通过，2 项外部 CUDA 夹具条件跳过。
- `npm.cmd run typecheck` 与定向 ESLint：通过。

维护统计新增定向入口，只读取显式 `vectorDbDir` 下的 generation、已提交 increment 与必要 shard；真实维护校验无需构建无关的图片索引和素材库清单。
