# Image Search 指定文件夹多层索引编辑

> 状态：当前
> 实施状态：已实现并通过专项验证
>
> 日期：2026-08-02
>
> 范围：Native/Hash、DINO、CLIP 文件夹级索引删除；不删除源图片

## 用户结论

Data Editor Manager 现在可以处理一个指定绝对文件夹下的三类图片索引：

| 索引层        | 可执行操作                              | 删除后的直接影响                              | 恢复方式                    |
| ------------- | --------------------------------------- | --------------------------------------------- | --------------------------- |
| Native / Hash | 删除该文件夹及其子目录的 Native 记录    | Hash/基础图片搜索不再返回这些图片             | 重新 Start Scan             |
| DINO          | 删除该文件夹及其子目录的 DINO embedding | Similar、主体重排等 DINO 能力暂不覆盖这些图片 | 重新构建缺失 DINO embedding |
| CLIP          | 删除该文件夹及其子目录的 CLIP embedding | 文本语义检索暂不覆盖这些图片                  | 重新构建缺失 CLIP embedding |

这里的“编辑”是安全的文件夹级删除和随后重建，不是直接手工修改高维浮点向量。DINO/CLIP
向量由模型生成，任意手改会破坏维度、归一化和缓存一致性，因此界面不提供逐值编辑。

## 使用方法

1. 打开 Image Search → Advanced → Data Editor Manager。
2. 在查询框输入完整绝对文件夹路径并执行 Search。
3. 点击“管理文件夹索引”。
4. 勾选 Native/Hash、DINO、CLIP 中需要处理的层，默认三层全选。
5. 点击“分析所选索引层”，核对每层的唯一图片数、物理记录数、命中字节和临时空间。
6. 第一次点击删除按钮进入确认状态；再次确认后才开始改写。
7. 等待进度完成。重写阶段允许取消；进入最终提交阶段后不再接受取消。

若希望三种搜索结果保持一致，通常应三层全选。只选其中一层是高级维护操作，会在重新构建前
有意造成该文件夹的搜索能力不对称。

## 数据结构和一致性处理

- Native/Hash 继续通过现有 manifest、segment 和 overlay 写入链删除。
- DINO/CLIP 从 `vector-db/embeddings` 下对应的 `__global.jsonl` 权威分片流式筛除；扫描只解析
  每行的 `imageId`，不把高维向量反序列化进内存。
- 路径匹配为“等于目标文件夹”或“位于目标文件夹加分隔符之下”，大小写和 `/`、`\` 差异
  归一化；例如 `images-old` 不会被 `images` 误删。
- 预览同时报告唯一图片数 `count` 与物理 JSONL 行数 `recordCount`。二者不同时表示 shard
  内同一路径存在重复记录，而不是多张图片。
- 相关旧式 embedding/job/native 辅助记录按模型族清理；DINO F16/ANN、CLIP F32/path cache
  和向量 manifest 会失效并在下次使用时重建。正在运行的分层搜索会先协作式停止，进程内
  ANN/CLIP 缓存也会释放。

## 事务与安全边界

1. **只删索引**：源文件夹及源图片不执行写入、移动或删除。
2. **先预览再确认**：确认令牌有效期 15 分钟且只能使用一次；执行前再次核对每个 shard 的
   文件大小与修改时间，预览后发生变化则拒绝执行并要求重新分析。
3. **历史路径可维护**：配置内 Scan Paths 直接允许；已经从设置移除的历史文件夹，只有在
   预览确实找到索引数据时才允许继续。越界且零命中的路径拒绝执行。
4. **禁止整盘误操作**：盘符根和网络共享根不能作为目标；需要选择其下的具体文件夹。
5. **磁盘预检**：执行前要求至少具备“预计新 shard 大小 + 64 MiB”可用空间。
6. **流式原子改写**：新 shard 写入同目录临时文件，完成并校验删除数后才通过 rename 切换；
   不一次性载入 12 GiB 级 JSONL，也不在原文件上就地截断。
7. **恢复备份**：旧 shard 保存为带元数据的 `.gc-backup-*`，默认保留 7 天并由现有存储维护
   机制管理。因此执行完成后不会立刻释放全部磁盘空间。
8. **取消和错误**：重写阶段取消或切换中失败会删除临时输出并反向恢复已经切换的向量 shard；
   最终 Native/辅助索引提交属于跨存储边界，结果会逐层返回实际删除数和警告，不能把它视为
   单一数据库的全局 ACID 事务。
9. **互斥**：文件夹编辑与 Image Search 扫描/搜索、embedding 构建、DINO/CLIP cache 构建、
   Vector GC、向量迁移和相关存储清理互斥，避免同时改写同一数据域。

## 指定数据集只读健康检查

对用户截图所示的 PxHere `images` 文件夹执行了真实数据只读分析，没有执行确认删除，也没有
改动源图片或用户索引：

| 层   | 唯一图片 | 物理记录 | 命中 JSONL 字节 | 被扫描的权威 shard |
| ---- | -------: | -------: | --------------: | -----------------: |
| DINO |   57,953 |   57,953 |   953,788,813 B |    8,045,586,193 B |
| CLIP |   57,953 |   57,953 |   642,131,156 B |    5,460,308,954 B |

- 两个向量层的图片数和物理行数完全一致，未发现该文件夹内的 DINO/CLIP 重复行差异。
- 2026-08-03 全量目录已把“净多 10 条”拆解为两个方向：15 条 Native 同时缺 DINO/CLIP，
  另有 5 条 DINO+CLIP-only，因此 `57,963 - 15 + 5 = 57,953`。具体路径见
  [全量数据总览实施记录](2026-08-03-image-search-data-overview-implementation.md)。
- 两个大 shard 合计约 12.58 GiB，只读预览耗时 32.501 秒；若执行，预计需要
  11,909,975,178 B（约 11.09 GiB）临时空间。速度主要受顺序磁盘读取和 JSONL 文本体积约束。
- “命中 JSONL 字节”用于描述被移除的逻辑记录规模，不等于立即可释放空间；旧完整 shard
  仍会作为 7 天恢复备份保留。

## 性能判断

当前实现已避免解析向量数组和大对象峰值，删除阶段为 O(shard 字节数) 的有界内存顺序 I/O。
对现有 JSONL 权威格式而言，这是安全且可预测的实现。进一步显著提速需要把权威存储迁移为
分块二进制向量与独立 path table，使按路径过滤无需重写整个全局 shard；该优化会触及权威
数据格式，必须经过双写、召回一致性、断电恢复和回滚门禁后才能启用。

## 验证

```text
npm.cmd run test:image-search-data-folders  50/50 passed
npm.cmd run test:vector-pipeline             53/53 passed
npm.cmd run test:i18n-static                 5/5 passed
npm.cmd run test:preload-contract            2/2 passed
npm.cmd run test:ipc-registration            7/7 passed
npm.cmd run test:ipc-validation              4/4 passed
npm.cmd run test:guards                      24/24 passed
npm.cmd run typecheck                        passed
npm.cmd run format:check                     passed
npm.cmd run build:renderer                   passed
```

专项测试覆盖：多层真实小 shard 删除、路径边界、源文件不变、预览后 shard 变化拒绝、未配置且
零命中路径拒绝、取消后 shard 字节级不变，以及 IPC/preload/Renderer/i18n 契约。

未验证边界：没有在真实 12.58 GiB 用户 shard 上执行删除；没有对安装包内的最终 UI 做人工
点击 smoke。真实数据处理仍应由用户在预览数字确认无误后主动执行。
