# 阶段 D3：embedding 追加增量日志设计

> 状态：当前
> 更新日期：2026-08-17
> 范围：Embedding JSONL 与 generation 增量双写
> 替代文档：无

日期：2026-08-05

本文延续 [DSK-06 权威二进制向量库设计与迁移](2026-07-30-authoritative-vector-store.md)（下称"07-30 设计"），为兼容窗口关闭前的最后一类写入口（embedding 追加）设计权威存储的自然生长机制。文中函数名、行号与行为均按当前代码核实。

## 问题

当前循环：embedding 追加只写 JSONL（`appendEmbeddingNoUpsertAsync`，`electron/vectorDatabaseService.ts:631`，经 `embeddingAppendChain` 串行化，只追加一行 JSONL，不写 generation）→ generation 的 `imports`（path/size/mtimeMs，`electron/authoritativeVectorStore.ts:21`）与新源统计失配 → `ensureEmbeddingF16Cache`（`electron/embeddingF16Cache.ts:724`）经 `openAuthoritativeVectorStore` 的 `expectedSourcePaths` 比对判定失配，回退派生缓存重建 → 重新迁移。D2a（第一百一十三批）已让重迁移走 `extendEmbeddingF16Cache`（`electron/embeddingF16Cache.ts:489`）增量合并，但"追加 → 失配 → 重建 → 重迁移"循环本身仍在：每次追加后、下次迁移前，所有同步新鲜度判定（`readFreshEmbeddingF16Cache`、`describeEmbeddingVectorSource`）都退回 `jsonl:` 口径，派生索引按 shard 漂移失效。

D3 目标：追加路径在写 JSONL 的同时，向当前 generation 追加增量段，使权威存储随追加自然生长；追加不再打破新鲜度指纹，派生缓存/ANN/帧索引不再因追加而重建。最终让 GC 后约 7.62 GiB（迁移前口径 13 GB）的 JSONL shard 退役进入清理预览——兼容窗口关闭的最后条件：Media Search 已在 D2c 关闭，"embedding 追加"与"诊断/导出"两类入口已分别由阶段 1-2（第一百一十六/一百一十七批）与阶段 3（第一百一十八批）关闭，JSONL 退役只剩阶段 4 评估。

## 决策

采用**双写 JSONL + generation 增量日志**：`appendEmbeddingNoUpsertAsync` 在既有 JSONL 追加之后，向当前 generation 的从属增量日志追加同一向量（F16 编码 + 路径行），并用增量提交点（`delta.json`）记录已提交行数与源尾部锚点。`CURRENT` 仍是唯一权威提交点；`delta.json` 是其从属提交点，只锚定在 `CURRENT` 引用的 generation 之上。JSONL 的兼容导入日志地位本阶段不变。

每个模型条目（modelName/embeddingType/dim）一个增量目录：

- `vector-store/incremental/<model>__<type>/delta.f16`：追加的 F16 向量行，编码语义与 `encodeNormalizedVector`（`electron/embeddingF16Cache.ts:318`）完全一致（先 L2 归一、F16-LE），保证增量段与全量重建逐字节可对应；
- `delta.paths.jsonl`：追加的 `{row, path}` 行，`row` 从 generation 的 `count` 起顺延；
- `delta.json`：增量提交点，记录 `version`、基座 `generation`、模型三元组、`deltaCount`、基座 `count`/`sourceRecordCount`，以及逐源尾部锚点 `{path, size, mtimeMs, tailSha256}`。

读取层把"generation + 有效增量日志"视为单一复合快照：`count = 基座 count + deltaCount`，行定位先查基座、越界行落入增量段。新鲜度判定的锚定关系：**JSONL 源锚定增量日志**（锚点不匹配即忽略增量），增量日志锚定 generation（基座 generation 不等于 `CURRENT` 即忽略增量），增量永不反向锚定 JSONL 或 generation。

## 方案比较

| 方案 | 追加成本与读取 | 事务/恢复 | 结论 |
| --- | --- | --- | --- |
| 双写 JSONL + 增量日志 | 每次追加多写 `dim*2` 字节向量 + 一行路径 + 一次小文件提交；读取为基座+增量复合，ANN/帧索引指纹可保持稳定 | `delta.json` 为从属提交点；半截写按提交行数截断恢复；任何失配退化为现状（失配回退重建） | 采用 |
| 单一权威 append-only 存储，JSONL 仅导入导出 | 最省空间，没有双写 | 追加即改权威存储，崩溃窗口直接影响唯一副本；诊断/导出入口（如 `getVectorMaintenanceStats` 逐行扫 shard 统计，`electron/vectorMaintenanceService.ts:270-275`）与召回门禁（`scripts/verify-vector-generation-recall.cjs` 以 shard 为 F32 对照源）同时失去 JSONL 依据，需要一次性改造全部消费方 | 兼容窗口内风险过高，作为 JSONL 退役后的终态候选，本阶段不采用 |
| 定期增量迁移批处理 | 追加零额外成本；批处理窗口集中 I/O | 复用 D2a 全链路，无新恢复协议 | 循环仍在：窗口之间派生缓存照样失配重建，只是重建更便宜；不满足"追加自然生长"目标，不采用（可经现有维护页手动触发，已是现状） |

失败语义分析（崩在每一步会怎样）：

- 双写方案：崩在 JSONL 之前，无变化；崩在 JSONL 半截行，`delta.json` 未提交，锚点 size 与实际不符，增量被忽略，行为等同现状（D2a 的行边界检查 `electron/embeddingF16Cache.ts:541-549` 同样拒绝该尾部，回退全量）；崩在增量段半截，`delta.json` 未提交，重启后按已提交 `deltaCount` 截断增量段；崩在 `delta.json` rename 半截，临时文件残留、旧提交点完好。任何一步失败的最坏结果都是"增量不可用、回到现状循环"，不会产生错误读取。
- 单一权威方案：崩在追加半截且无 JSONL 对照时，无法区分"最后一行可信与否"，必须引入校验和行或 WAL，否则权威读取源自身可能携带半行；恢复失败没有第二副本兜底。
- 批处理方案：崩在批处理中等同 D2a 现状（staging 不提交、旧 `CURRENT` 不动），但窗口期内的追加依旧制造失配，崩溃恢复语义没有任何改善。

## 崩溃一致性协议

写入顺序（在既有 `embeddingAppendChain` 串行链内，仍单写者）：

1. 追加 JSONL 行（现状，不变）；
2. 追加 F16 向量行到 `delta.f16`、路径行到 `delta.paths.jsonl`；
3. 重写 `delta.json`（临时文件 + rename，与 `CURRENT` 切换同一原子原语）提交新的 `deltaCount` 与源尾部锚点。

反向顺序（先增量后 JSONL）被明确禁止：它会产生"增量已提交而 JSONL 没有对应行"的窗口，违背"JSONL 锚定增量"的恢复方向。持久化级别与现状一致（`appendFile` + rename，不新增 fsync 要求；`CURRENT` 切换今天也是同一级别）。

重启后一致性校验（首次读取或首次追加前执行一次）：

1. 读 `CURRENT` 与 manifest（既有 `readCurrentAuthoritativeManifest`），再读 `delta.json`：`version` 匹配、`generation` 等于 `CURRENT`、模型三元组与 manifest 条目一致；
2. 逐源复核锚点：`stat.size >= 锚点 size`（大于表示锚点之后又有追加，属于"JSONL 领先增量"，增量有效但不完整，读取层按复合快照可见、尾部差额仍走失配回退）；`stat.size == 锚点 size` 时再比对 `mtimeMs` 与 `tailSha256`；
3. 结构复核：`delta.f16` 尺寸 `== deltaCount * dim * 2`，`delta.paths.jsonl` 行数 `== deltaCount`；
4. 追加写入者在追加前先把增量段截断到已提交 `deltaCount`（清理上次崩溃的未提交尾部），再继续步骤 2-3。

写入者比读取者更严格（阶段 1 实施澄清）：第 2 步的 `stat.size > 锚点 size` 宽容（"JSONL 领先增量"）仅适用于读取层。追加写入者要求 `stat.size == 锚点 size` 精确匹配后再比对 `mtimeMs`/`tailSha256`；否则继续追加会让新增量行跳过 JSONL 领先的行、与源行错位，且锚点推进后该缺口不再可见，违背"任何一步失败的最坏结果都是增量不可用"的失败语义。因此写入者在此情形整体忽略（删除）增量目录、退化为现状，等下一次迁移重建基座。写入者的截断恢复（第 4 步）相应只在"增量段有未提交尾部、而源锚点仍精确匹配"时触发——例如断电丢失了 JSONL 追加却保留了已写出的增量段。

任一校验失败：忽略（并可删除）整个增量目录，读取与迁移回到现状路径。半截写恢复因此只有"截断到提交点"一种动作，不做逐行修复。

与迁移 IPC / 向量 GC 的互斥：沿用既有互斥矩阵，不新增锁——embedding 构建在迁移/GC/清理运行时被拒绝启动（`electron/vectorIpc.ts:238-254`），迁移与 GC 预览/执行在 embedding 任务活动时同样被拒绝（`electron/vectorIpc.ts:582-681`）。新增两条规则：

- 迁移与 GC 启动前必须等待追加链排空（复用 `flushVectorDatabaseWrites` 语义，新增增量链 flush），然后重新 stat 源；排空后锚点之外的追加不存在，`extendEmbeddingF16Cache` 既有的闭环 stat 复核（`electron/embeddingF16Cache.ts:681-692`）继续兜底——若仍有追加穿插，增量迁移返回 null 回退全量，安全由构造保证；
- 迁移成功切换 `CURRENT` 或 GC 压实 shard 后，旧增量目录的基座 generation / 源锚点自然失效（校验第 1、2 步拒绝），执行方顺带删除该目录，不留孤儿。

## manifest 演进

- 基座 manifest version 保持 1，不改 staging/校验/`CURRENT` 切换协议。`imports` 条目新增**可选**字段 `tailSha256`：把第一百一十三批边界①（mtime 不变的原地改写检测不到）一并纳入设计。锚点定义：源文件在锚定 size 处结尾的最后 64 KiB（不足则全量）窗口的 SHA-256，校验成本 O(64 KiB)，不需要全量重哈希。`readCurrentAuthoritativeManifest` 的 imports 校验（`electron/authoritativeVectorStore.ts:131-137`）目前只检查 path/size/mtimeMs，对额外字段天然宽容；旧版本应用读到带 `tailSha256` 的 manifest 不受影响，新版本对缺失该字段的旧 manifest 按"无锚点"处理（退化为现有 size+mtime 判定）。因此不需要 version 升到 2。
- `delta.json` 独立携带 `DELTA_VERSION = 1`，与 manifest version 解耦演进；校验失败即整体忽略，不存在半兼容读取。
- `tailSha256` 的诚实边界：同尺寸、同 mtime 且改写不在尾部 64 KiB 窗口内的原地改写仍检测不到；它与 extend 证明的 size/mtime/行边界检查叠加使用，不声称替代全量哈希（迁移提交前的全量 SHA 校验不变）。

## 对现有消费方的影响面

- `ensureEmbeddingF16Cache` 失配回退（`electron/embeddingF16Cache.ts:194-212`）：读取顺序变为"generation + 有效增量"→ 现状路径。增量有效时直接返回复合句柄，不再触发派生缓存重建；增量缺失或失效时行为与今天完全一致。`readFreshEmbeddingF16Cache` / `readExistingEmbeddingF16Cache` 同步获益。
- `describeEmbeddingVectorSource`（`electron/embeddingF16Cache.ts:241`）：generation 指纹从 `generation:<代>:<count>:<sourceRecordCount>` 演进为含增量计数的形态（如 `generation:<代>:<count+δ>:<sourceRecordCount+δ>`）。追加后指纹稳定切换而非跌回 `jsonl:`，Media Search 帧索引（D2c 挂载点）在追加后保持新鲜，不再因追加重建。
- 召回门禁（`scripts/verify-vector-generation-recall.cjs:39-46`）：当前以 `expectedSourcePaths=[shard]` 精确比对 size+mtime，追加后句柄直接为 null、门禁失败。门禁须升级为接受"generation + 增量"复合快照：JSONL（F32 精确）对照集合改为基座 + 增量段的并集；双读对照的数据源仍是 JSONL shard 本身，口径不变。
- `vectorAnnIndex` 指纹（`electron/vectorAnnWorker.ts`）：`sourceFingerprint` 覆盖 `count`/`sourceRecordCount`/`sourceFiles`，且 ANN 文件名取自 `cache.vectorPath` basename。复合句柄的 meta 必须如实反映 `count+δ`，使 ANN 在追加后按指纹失配。第一百二十一批已在失配后增加安全的增量扩展：基座身份/尾锚和既有 delta 提交前缀尾锚全部吻合时只签名新增行，否则全量重建；这不改变本设计的复合快照协议。
- 诊断/导出入口：`getVectorMaintenanceStats`（`electron/vectorMaintenanceService.ts:253-309`）逐行扫两个 shard 统计记录数/唯一图片数，是"诊断/导出"类中最大的 JSONL 读出口；阶段 3 改为读 generation + 增量段路径索引，JSONL 仅保留为迁移导入源与召回门禁对照源。GC active-set 口径（合并索引/manifest/素材库 JSONL，`vectorGcService`）不受影响——GC 对象是 shard 内容本身。
- `extendEmbeddingF16Cache`：增量日志存在时，迁移的增量合并基座从"旧 generation"变为"generation + 已提交增量"，增量段行作为已合并内容整块保留，只合并锚点之后的 JSONL 尾部；锚点不可证明时回退现状（generation 基座 / 全量）。

## 分阶段实施清单

### 阶段 1：增量日志写入器（最小、可独立验证）

- 改动文件：新增 `electron/embeddingIncrementLog.ts`（追加、提交点重写、启动截断恢复、一致性校验）；`electron/vectorDatabaseService.ts`（`appendEmbeddingNoUpsertAsync` 链内挂接双写，同步变体 `appendEmbeddingNoUpsert`（`electron/vectorDatabaseService.ts:608`）同口径处理）。
- 专项测试：`tests/embedding-increment-log.test.cjs`——追加后增量段字节与 JSONL 行逐条对应（F16 编码对齐 `encodeNormalizedVector`）；崩在 JSONL 半截行/增量半截/delta.json 半截三种恢复；锚点失配整体忽略；并发追加串行不交错。
- 验收标准：读取路径零改动，全部既有测试（含 `test:vector-pipeline`）无回归；增量段内容与"对同一 JSONL 尾部跑 `encodeNormalizedVector`"的结果逐字节一致。
- 回退方式：写入开关关闭或删除 `incremental/` 目录即回到现状；无读取端耦合，回退零风险。

### 阶段 2：读取端复合快照与指纹演进

- 改动文件：`electron/embeddingF16Cache.ts`（复合句柄、`describeEmbeddingVectorSource` 指纹）、`electron/authoritativeVectorStore.ts`（可选 `tailSha256` 校验）、召回门禁 `scripts/verify-vector-generation-recall.cjs` 与 `electron/vectorGenerationRecall.ts`（复合口径）、迁移服务排空规则（`electron/vectorStoreMigrationService.ts` / `electron/vectorIpc.ts` 互斥注释级接线）。
- 专项测试：追加后 `readFreshEmbeddingF16Cache` 不返回 null、帧索引指纹不跌回 `jsonl:`；ANN 指纹随 `count+δ` 变化强制重建一次；召回门禁在"generation + 增量"下通过、在增量失效时明确失败。
- 验收标准：追加 embedding 后不再触发派生缓存重建与帧索引重建；`test:vector-pipeline`、召回合成测试全绿；真实数据小批量追加后召回门禁通过。
- 回退方式：读取端开关回退到仅 generation 判定（忽略增量目录），行为等同阶段 1 完成态。

阶段 2 实施澄清（第一百一十七批，与上文不一致处以实施为准）：

- 帧索引"保持新鲜"经 `embeddingVectorSourceStabilityKey` 落地：`describeEmbeddingVectorSource` 指纹保持 `generation:<代>:<count+δ>:<sourceRecordCount+δ>` 形态（如实反映追加），帧索引/帧统计签名改用只含代身份的 stability key——同代追加签名稳定，换代或退回 `jsonl:` 口径仍失效。
- 读取侧校验只读（不截断、不删除增量目录）；对源文件 ENOENT 从严判失效。基座 manifest imports 的可选 `tailSha256` 字段已在第一百一十九批补齐：新迁移写入锚定 size 处最后 64 KiB 的 SHA-256，提交前复核源未变化；读取端仅在字段存在时校验，旧 manifest 缺失字段继续退化为 size + mtime 判定，manifest version 保持 1。
- 召回门禁脚本改经 `readFreshEmbeddingF16Cache` 取复合句柄，沿用 manifest 默认校验，不含逐文件 sha256 复核。
- `extendEmbeddingF16Cache` 已在第一百二十批改为以“基座 generation + 已提交增量段”为增量迁移基座：delta 的 F16 行直接按需复制，只解析各源 `delta.json` 锚点之后的 JSONL 领先尾部；跨基座、delta 与尾部的 latest-revision-wins 顺序及全量重建字节等价性由专项回归锁定。

### 阶段 3：诊断/导出入口改读复合快照

- 改动文件：`electron/vectorMaintenanceService.ts`（统计改读路径索引）、其余以 `getEmbeddingStorePaths` 为只读统计源的低频入口。
- 专项测试：统计口径与 JSONL 逐行扫描基线一致（记录数、唯一图片数）。
- 验收标准：维护页统计不再扫多 GiB shard；JSONL 的剩余角色收敛为"迁移导入源 + 召回门禁对照源 + 追加写目标"。
- 回退方式：统计入口切回 JSONL 扫描，口径等价。

阶段 3 实施澄清（第一百一十八批，与上文不一致处以实施为准）：

- 统计口径：记录数 = `sourceRecordCount + δ`（与新鲜度指纹同一近似：会被重建跳过的追加行只推进锚点不计 δ）；唯一图片数 = 基座路径索引 ∪ 已提交增量段路径索引的去重 path 数，未提交增量尾部不计。
- 运行时回退：无有效 generation 时统计入口回退到 JSONL 逐行扫描（与"任何失配退化为现状"的失败语义一致）；增量目录失效而 generation 有效时退化为仅基座口径，不判整体失败。
- 排查结论：`getVectorMaintenanceStats` 是诊断/导出类中唯一逐行扫 shard 取数的入口；其余 `getEmbeddingStorePaths` 消费方均为搜索/构建数据路径（`embeddingService`、`vectorIndexService`、`mediaSearchFrameIndex` 的 JSONL 回退分支等），非只读统计源，不在本阶段改动。

### 阶段 4（后续，不在本设计承诺内）：JSONL 退役评估

- 双写稳定运行 N 个维护周期（含至少一次真实崩溃恢复观察与一次召回门禁复跑）后，再评估把 JSONL shard 纳入高风险清理预览；legacy `image_embeddings.jsonl` 是整文件重写源（第一百一十三批边界②），其退役条件单独评估，不随 shard 一并处理。

## 非目标

- 本阶段不改变 JSONL 的权威/兼容导入日志地位；双写稳定运行 N 个周期前，JSONL 不进入任何清理预览。
- 不动基座 manifest version、staging、`CURRENT` 切换与全量 SHA 校验协议。
- 不改 F16 编码、latest-revision-wins 合并语义与 ANN 算法参数；ANN 增量签名已由第一百二十一批作为独立专项实现，不属于本设计阶段 1-3 的协议承诺。
- 不引入跨进程文件锁：写入者仍是 Electron 主进程内串行链，迁移/真实数据操作继续要求应用单实例（与第一百一十~一百一十三批的真实执行纪律一致）。
- 不处理 legacy `image_embeddings.jsonl` 的 generation 化；其整文件重写只会令锚点失效、回退现状，不阻塞本设计。
- 不做 embedding jobs 的 epoch/owner/heartbeat 账本（属阶段 D 另一分支，第一百一十一批边界②）。

## 验证

本批为设计决策记录，不实施代码。文中函数名、行号、互斥矩阵与指纹口径均按当前工作树核实（`electron/vectorDatabaseService.ts`、`electron/embeddingF16Cache.ts`、`electron/authoritativeVectorStore.ts`、`electron/vectorStoreMigrationService.ts`、`electron/vectorAnnWorker.ts`、`electron/vectorMaintenanceService.ts`、`electron/vectorIpc.ts`、`scripts/verify-vector-generation-recall.cjs`）。实施阶段的专项测试与验收标准见上节清单。
