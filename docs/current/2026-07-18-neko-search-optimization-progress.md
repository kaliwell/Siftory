# NekoSearch 当前优化进度

> 状态：当前
> 实施状态：当前进度快照
> 更新日期：2026-07-28
> 综合健康度：87/100（2026-07-22 功能完成度估计；当前发布门禁未通过）
> 代码基线：[NekoSearch 智能素材分类实施基线](2026-07-14-neko-search-implementation.md)  
> 专项审计：[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)
> 最新综合审计：[2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)

## 当前结论

NekoSearch 的分类、标签、参考图、AI Suggestions、Sample Search、Similar Search、反馈学习、聚类、Category Group、软删除和恢复已经形成可用闭环。普通素材分页已使用 SQLite 投影，主素材与关系数据的关键写入具备 fail-closed、事务 journal、备份和恢复保护。

当前核心日常流程完成度约 87%；对照完整智能素材管理方案约 69%。2026-07-19 至 07-20：关系数据规模化（SQLite 阶段 0-4）与首个固定真实标注准确率基线（NKS-P1-04）均已完成，系统级故障注入此前已落地。

“发布阻断项已全部消除”只代表 2026-07-22 当时的专项评估，已被 2026-07-28 综合审计取代。当前 NekoSearch 准确率门禁仍因扫描延迟回退而失败；开发态 UI smoke 的中文语言耦合已由 REL-01 修复并完成中英文验证，但当前安装器 packaged smoke 尚未补做。生产依赖、磁盘增长、国际化和随包许可证也仍是全项目 P1；因此当前只能作为内部可用功能，不能据此判定达到对外发布条件。

## 2026-07-28 综合复核

| 项目              | 当前结果                                                                                                                         | 判断                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 完整工程门禁      | `npm.cmd run verify`：444 项测试，440 通过、0 失败、4 项因隔离工作树无模型实物而跳过；typecheck/build/format 通过，lint 5 条警告 | 核心代码门禁稳定                           |
| NekoSearch 准确率 | test01 的 P@20/P@50/nDCG@20=1.0，R@50=0.641，Reject intrusion=0                                                                  | 质量指标保持基线，但单分类代表性不足       |
| NekoSearch 性能   | 扫描 p95 62,507.1ms；基线 36,984.9ms；回退约 69%                                                                                 | **准确率门禁失败**                         |
| 聚类快照          | 209 组，purity 加权中位 0.8059，未分组比例 0.8397                                                                                | purity 达到观察阈值，未分组比例仍高        |
| UI smoke          | REL-01 已改用稳定标识；开发态 `zh-CN`、`en` 双语 smoke 和运行时语言往返切换通过                                                  | 开发态门禁恢复；packaged smoke 仍待 REL-03 |
| 用户数据          | 应用用户数据约 14.64 GiB，向量分片约 8.42 GiB，扫描日志约 800 MiB                                                                | 需要轮转、配额、垃圾回收与清理入口         |

准确率的完整阈值和原始报告位置见[准确率门禁工具链](../benchmark/2026-07-18-neko-search-accuracy-gate.md)。全项目发布判断见[2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)。

## 执行身份与协作边界（2026-07-22）

1. 当前文档整理执行者：`Codex / GPT-5 系列`；精确模型小版本未公开，不作猜测。
2. ①b 的执行者：`Kimi/coder`，归属 Kimi 运行时；用户于 2026-07-22 明确确认该项已完成，Codex 不追溯认领其实现。
3. Codex 当前接手范围为②及后续顺序任务；②修改 stats/clusters 读路径，不改写①b worker 的计算和状态契约。
4. 后续接手必须先执行[模型、运行时与文档确认规范](../reference/model-runtime-and-document-confirmation.md)。

## 当前优化任务清单（2026-07-22 执行顺序）

按优先级逐项执行，每项要求：对应测试、typecheck/lint/format 全绿、相关基准或真实库验证、文档同步。

| 顺序 | 任务                                                                | 范围                                                                                       | 执行系统   | 所有者     | 状态（2026-07-22）                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①a   | buildAssetClusters 聚类迁 worker                                    | 3 遍 f16 + 压缩 k-means + 残差 pass + 2 遍 CLIP 语义细分全管线                             | 历史已完成 | 未追溯     | **已完成**：`assetClusteringWorker.ts` 落地，真实库只读验证两次运行完全一致（209 组 / 35,319 成员 / eligible 176,386，语义细分 75 组，单次约 161s，零写入）                                                  |
| ⑤    | 空库备份无法恢复缺陷                                                | 补种核心文件、恢复回归测试并纳入测试链                                                     | 历史已完成 | 未追溯     | **已完成**：备份创建时补种子 `assets.jsonl`（空文件）与 `state.json`（`{"nextId":1}`）；回归覆盖备份后脏核心状态替换和 Search Learning 元数据还原，已纳入 `test:asset-library`，2026-07-22 专项链 91/91 通过 |
| ①b   | feedback 重建 + Sample Search + buildCategoryAssetCluster 迁 worker | feedback 模型计算、CLIP 召回 + DINO 重排移出主进程；写库与单例状态留主进程                 | Kimi       | Kimi/coder | **已完成**：状态来源为用户 2026-07-22 明确确认；Codex 后续整链验证覆盖 feedback worker 测试，`test:asset-library` 91/91 通过                                                                                 |
| ②    | stats/clusters 聚合计数优化                                         | stats p95 122.8ms（目标 <100ms）、clusters p95 147.79ms（目标 <50ms）；覆盖索引与 SQL 聚合 | Codex      | Codex      | **已完成**：同一 187k/100k 合成基准最终 stats p95 57.18ms、clusters p95 37.61ms；SQLite/JSONL 逐项一致，asset-library 91/91、SQLite 18/18 通过                                                               |
| ③    | 路线图 31：参考图即时 embedding 后端                                | `assetLibraryService.ts` 的固定 CPU 后端改读用户向量设置                                   | Codex      | Codex      | **已完成**：读取 `vector-settings.json`；仅明确选择 GPU 时启用 GPU，缺失、非法或损坏设置均安全回退 CPU；专项回归已入链                                                                                       |
| ④    | NKS-P2-03 批量关系更新 O(n²) 查找                                   | 批量分类/打标签 `findIndex` 改 `assetId:targetId` Map 或 SQL upsert                        | Codex      | Codex      | **已完成**：分类和标签批量更新统一使用复合键 Map，SQLite/JSONL 的 1,200 素材等价回归通过                                                                                                                     |
| ⑥    | commitPreparedPath 断电窗口                                         | localFileTransaction 无 journal 的 final 替换窗口（此前记录为 known-limitation）           | Codex      | Codex      | **已完成**：增加同目录 durable journal、目录同步、启动/访问恢复与越界 journal 拒绝；故障注入覆盖 final-aside 后强杀恢复                                                                                      |
| ⑦    | NKS-P2-06 搜索结果 task/result ID                                   | Sample/Similar 结果只存进程内单例，连续任务互相覆盖                                        | Codex      | Codex      | **已完成**：结果携带 task/result ID；每类保留最近 10 份会话结果，IPC 精确查询，Renderer 丢弃过期响应；专项缓存与契约回归通过                                                                                 |
| 收尾 | 全量验证 + 文档同步                                                 | typecheck、lint、format、全量测试、构建、真实库/专项基准与文档更新                         | Codex      | Codex      | **已完成**：`npm.cmd run verify` 全绿；281/281 测试通过，native 与 renderer/main/preload/worker 构建成功                                                                                                     |

明确不做（目标边界）：人工标注与新分类建设（需用户操作）、OCR/filename/视频关键帧（路线图明确最后）、Duplicate Finder 集成与聚类人工干预（大功能，需单独方案确认）、assetLibraryService/Panel 结构拆分（纯重构无收益验证）。

⑤ 已关闭该维护缺口：`tests/asset-library-backup-portable.test.cjs` 现有 8 项，已挂入 `test:asset-library` 和总测试链。

## 本轮完成

### 长任务 worker 迁移第二批之聚类（NKS-P2-02，2026-07-20）

1. `electron/assetClusteringWorker.ts`：buildAssetClusters 全管线迁 worker——签名微桶路由、压缩 k-means、精确纯度 pass、自适应残差 pass、CLIP 语义细分（observe/bestSemanticSeed）；主进程保留语义标签生成（主进程 CLIP 文本模型）与全部落库。
2. 进度按 stage 映射回原百分比分段；取消与第一批同一 SAB 桥接；`vectorSignature` 上移 `assetClustering.ts` 共享。
3. 真实库只读验证（`scripts/verify-clustering-worker.cjs`，不写库）：两次完整运行逐组一致——209 组、35,319 成员、eligible 176,386、202+128 中心、语义细分 75 组；单轮约 161s（此前主进程同量级时长现在完全不阻塞 UI）。
4. 测试：`tests/asset-task-workers.test.cjs` 增加聚类 3 项（端到端分组结构、确定性与 scope 过滤、取消），累计 10 项。测试 fixture 发现签名机制特性：12-bit 签名读分量符号，0 与正数不可区分，合成向量需带符号模式设计。

### 空库备份可恢复性修复（2026-07-20）

1. `assetLibraryBackup.ts` 创建备份时补种子缺失的 `assets.jsonl`（空）与 `state.json`（`{"nextId":1}`），空库备份从此满足恢复侧资产索引要求；恢复侧 guard 不变（缺索引文件的旧备份仍拒绝，属异常态）。
2. 回归测试：空库（仅 search-feedback）→ 备份 → manifest 含种子文件并通过哈希校验 → 写入备份后脏核心状态 → 恢复精确替换为空索引/初始状态，并还原原 Search Learning 元数据。
3. 顺带修复维护缺口：`asset-library-backup-portable.test.cjs` 此前未挂入任何测试链，其 fixture 停留在 manifest v1 时代（`tags.jsonl`）已失效；fixture 更新为 v2（`.migrated` 命名），2026-07-22 套件 8/8、`test:asset-library` 91/91 通过。

### stats/clusters 聚合计数优化（②，2026-07-22）

1. 基线复现（187,000 素材、100,000 分类关系、50,000 建议、100,000 聚类成员，20 次）：stats p95 122.8ms、clusters p95 147.79ms，均未达目标。
2. `AssetLibraryDatabase` 增加 `(status, asset_id)` 与 `(cluster_group_id, similarity DESC, asset_id)` 覆盖索引；正式分类、引用、建议状态、分类/标签数量改为 SQLite 标量计数，inactive ID 以 500 条分块扣除，避免变量上限和大数组物化。
3. 聚类列表改为 SQLite 每组聚合 `COUNT/SUM`；inactive 成员按 `asset_id` 索引分块扣除。每组预览按覆盖索引流式读取，找到 8 个活跃素材立即停止，不再把 100,000 个成员对象搬入主进程。
4. `AssetMetadataStore.activitySummary()` 用一次遍历同时得到 active、archived 和 inactive ID，替代 stats 的三次全素材扫描。
5. 最终同基准：stats p95 57.18ms（目标 <100ms，较基线约 -53%），clusters p95 37.61ms（目标 <50ms，约 -75%）；另外两次优化后复测分别为 65.56/34.72ms、65.37/35.05ms，均稳定达标。
6. 正确性回归加入“最高相似度成员已 missing”的场景，验证聚合计数、均值和 Top8 均保持活跃素材语义；SQLite/JSONL 输出逐项一致。`test:asset-library` 91/91、`test:asset-library-sqlite` 18/18、typecheck、ESLint、Prettier 全部通过。
7. 代价：新增两个持久索引会增加 SQLite 体积和首次 JSONL 导入写放大；本次合成环境 setup 约 3.9–4.6s。索引只在初建时构建，日常打开使用 `IF NOT EXISTS`，收益集中在高频 stats/clusters 读取。

### 参考图 embedding 后端统一（③，2026-07-22）

1. 参考图即时 embedding 不再固定 `backend: 'cpu'`，改为读取用户数据目录中的 `vector-settings.json`，与向量功能的 CPU/GPU 选择保持一致。
2. 安全边界采用保守白名单：只有设置值严格为 `gpu` 才启用 GPU；文件缺失、字段非法或 JSON 损坏时均回退 CPU，避免设置损坏导致参考图导入不可用。
3. 回归覆盖缺失设置、GPU、非法值和损坏 JSON；`test:asset-library` 已入链验证。

### 批量关系更新 Map 化（④ / NKS-P2-03，2026-07-22）

1. 分类分配、SQLite 标签分配和 JSONL 标签分配的现有关系定位由循环内 `find/findIndex` 改为 `assetId:targetId` 复合键 Map，消除批量更新的 O(n²) 查找放大。
2. 保持原有更新/插入语义、ID 与事务边界不变；现有 1,200 素材 SQLite/JSONL 等价回归和 `test:asset-library-sqlite` 18/18 通过。

### commitPreparedPath 断电恢复（⑥，2026-07-22）

1. `localFileTransaction` 在 final 替换前写入同目录 `.transaction.json` durable journal，并在 journal 发布、目标替换和清理阶段同步目录，关闭旧实现 final-aside 后断电无法判定提交状态的窗口。
2. `recoverPreparedPathTransactions` 校验 journal 的目录归属和目标/临时/备份路径；合法的 prepared 事务完成替换，路径逃逸或结构异常的 journal 拒绝执行。
3. 新准备事务、File Manager 目录读取及模型状态读取前都会扫描恢复；运行期异常仍优先回滚旧目标。
4. 故障注入已将原 known limitation 改为强杀恢复断言；文件事务 4/4、故障注入 13/13 通过。残余边界是硬件或文件系统不兑现 flush 语义，此类故障无法由应用层 journal 完全消除。

### 搜索结果 task/result 身份与会话历史（⑦ / NKS-P2-06，2026-07-22）

1. Category Sample Search 与 Similar Search 响应新增 `taskId`、`resultId`；主进程不再只保留一个可覆盖单例，而是每种结果保留最近 10 份有界会话历史。
2. IPC 支持按 task、result 或二者联合精确查询；二者不匹配时返回空结果。旧的数字 category 参数仍在主进程兼容层接受，公开 preload 契约使用查询对象。
3. Renderer 记录当前搜索任务 ID，并为两类结果分别维护请求 generation；旧任务完成事件、迟到 IPC 响应不会覆盖新任务界面。
4. 本轮明确不持久化完整 hit 快照：进程重启后历史仍会清空，以免恢复已删除、归档或重新评分后的陈旧素材结果。若以后需要跨重启恢复，应只持久化查询与结果摘要并重新验证素材状态。
5. 新增有界缓存的精确查询、任务替换、淘汰、清空和身份冲突回归；`test:asset-library` 94/94、IPC validation 4/4、preload contract 1/1 通过。

### 长任务 worker 迁移第一批（NKS-P2-02 部分，2026-07-20）

1. 新骨架 `electron/assetTaskWorkerHost.ts`：worker_threads + `workerData` 一次性输入 + SharedArrayBuffer/Atomics 取消位（`stopAssetLibraryTask` 同步置位，与 `task.cancelled` 语义一致）+ 进度消息回主进程重放 `publishProgress`（renderer 契约不变）；dev 下回退解析 `dist-electron/`（loadTsModule 脚本场景）。
2. Similar Search 迁 worker（`assetSimilarSearchWorker.ts`）：DINO f16 全量扫描 + 有界 top-K 堆移出主进程；主进程保留查询向量读取、hit 组装与结果态。真实库对照：与改前基线逐 hit 一致（232,653 条向量、50 hits，assetId+score 全同，脚本 `scripts/verify-similar-service-parity.cjs`）。
3. 建议扫描迁 worker（`assetSuggestionScanWorker.ts`，`reference`/`text_label` 两模式）：直击 O(向量数×目标数) 主进程放大；标签 CLIP 文本向量与参考图即时 embedding 保留主进程预处理；结果回主进程走既有 `replaceGeneratedSuggestions` 落库（sqlite/mirror/ID 序列零改动）。真实库集成验证：两次全量生成 2,500 行逐行一致、零排除对违规、目标分类正确（`scripts/verify-suggestion-worker.cjs`）。
4. 纯函数拆分：`electron/assetEmbeddingStream.ts`（electron-free 的流式 JSONL 读取、`normalizedVector`、`shiftedCosine`），`assetLibraryEmbeddingSource.ts` 改为注入 `getEmbeddingStorePaths` 的薄包装，公开 API 不变。
5. `AssetMetadataStore.activePathIndexEntries()`：活跃素材 id+pathKey 快照，供 worker 做素材归属判定（18 万条约 40MB structured clone，一次性成本）。
6. 测试：`tests/asset-task-workers.test.cjs` 7 项（线性 oracle 对照、reviewed 排除、maxPerTarget 截断、stop 位取消、确定性、reference 证据链），已入 `test:asset-library` 链；全套 277/277。
7. 打包：vite 新增 2 个 worker entry，`package.json` extraResources 增加 2 份 worker js；两个 worker bundle 经检查零 electron 依赖。
8. 未迁（后续批）：`buildAssetClusters`（3 遍 f16 + 2 遍 CLIP + 标签生成）、`startCategorySampleSearch`、`buildCategoryAssetCluster`、feedback 模型重建——后三者耦合 feedback 单例与主进程 CLIP 文本模型，按审计阶段 B 第 3 条统一处理。

### 首个正式准确率基线与标注工具链 sqlite 兼容（NKS-P1-04 完成，2026-07-20）

1. 标注工具链接入 sqlite 关系数据源：阶段 4 迁移后关系 JSONL 改名 `.migrated`，`tests/guard-utils.cjs` 新增 `relationJsonlDir()`——未迁移库直读 JSONL，已迁移库先 `exportJsonl` 到临时目录再读；标注工具与准确率基准（聚类质量）均已接入，`smoke`/`status`/`prepare` 全链路验证通过。
2. `prepare` 与 `neko-search-accuracy-benchmark.cjs` 新增 `--category=id|name` 单分类过滤（候选池构建、就绪门禁、评估与基线全部按过滤后数据集执行）。
3. test01（id=12，57 条 confirmed 正样本）候选池 147 张，人工标注 147/147 完成（122 条 manual）。
4. 首个正式基线已写入 `docs/benchmark/neko-search-accuracy-baseline.json`（2026-07-20，单分类 test01，主门禁变体 hybrid）：P@20=1.0、P@50=1.0、R@50=0.641、nDCG@20=1.0、Reject intrusion@20=0、扫描 p95 36,984.9ms、聚类 purity 加权中位 0.8016（≥0.80 达标）。
5. 指标解读边界：候选池包含 confirmed 正样本本身且充当原型，P@K 接近满分、4 变体结果一致属预期；该基线的主要价值是后续算法变更的同数据集回归对照（`--gate`），不代表全库真实精度的绝对水平。单分类宏平均代表性有限，后续随新分类建设扩充。
6. `girlsockhighheels`（537 条）与 `dual-validation-test`（65 条）为历史临时分类；其标注保留在 judgments 文件中（717 条 stale，prepare 自动忽略，不删除）。

### 生产依赖安全修复（NKS-P1-05）

1. 运行时可达性验证为零：`adm-zip` 仅被 `onnxruntime-node/script/install-utils.js`（postinstall 的 CUDA NuGet 下载路径）引用，运行时 `dist/` 无引用；`win32/x64` 默认安装 requirements 为空，不触发下载；应用自身无 ZIP 解压代码；packaged 应用不执行 postinstall。
2. `package.json` 增加 `overrides` 将 `adm-zip` 固定到 `^0.6.0`（修复 CVE-2026-39244 / GHSA-xcpc-8h2w-3j85），`npm ls adm-zip` 确认为 `0.6.0`。
3. `npm rebuild onnxruntime-node` 成功，onnxruntime-node 1.24.3 正常加载，完整 `npm test`（215 项）全部通过。
4. `npm audit --omit=dev --audit-level=high` 由 3 个 high 归零。
5. 剩余边界：`adm-zip@0.6.0` 的 `extractEntryTo` 改为保留子目录，仅影响 Linux x64 显式 CUDA 安装的 NuGet 解压路径；本项目使用 CPU 后端且 win32 默认安装不走该路径。

### 准确率门禁工具链（NKS-P1-04 工具部分）

1. 新增 `tests/neko-search-annotation.cjs` + 标注 UI：固定人工标注集工具，子命令 `prepare / serve / status / evaluate / backup / restore / smoke`；候选池 = CLIP Top60 + DINO Top60 + 已审核 + 20 随机；审核状态预填 seeded 标签，manual 标签永不被覆盖。
2. 新增 `tests/neko-search-accuracy-benchmark.cjs`：CLIP / DINO / Hybrid / Hybrid+反馈 4 变体全库评估；Precision@20/50、Recall@50、nDCG@20、Reject intrusion@20、扫描延迟 p50/p95、留一法 AUC 诊断、聚类 purity 中位；`--write-baseline` 记录基线、`--gate` 回归门禁（Reject intrusion >5% 或较基线 +1pt 即失败，阈值明细见 benchmark 文档）。
3. 新增 `tests/neko-search-cluster-quality.test.cjs`：聚类确定性、`minSimilarity` 纯度过滤、追加稳定性、自适应簇数边界的合成回归，已加入 `npm test` 链（总测试数 215→220）。
4. 真实库只读 `prepare` 已跑通：分类 5（girlsockhighheels）563 候选、537 条 seeded relevant；分类 6（douni）无 confirmed 正样本跳过。
5. 基准就绪门禁实测：标注未完成时正确报缺口并 exit 2。
6. 使用文档：[NekoSearch 准确率门禁工具链](../benchmark/2026-07-18-neko-search-accuracy-gate.md)。
7. 剩余：人工标注完成前不记录正式基线、不启用 `--gate`；当前仅 1 个可评估分类，宏平均代表性有限。

### 事务故障注入与目录 fsync（NKS-P1-02/P1-03 剩余项）

1. 新增 `tests/transaction-fault-injection.test.cjs`（13 项，已入 `npm test` 链，总测试数 220→233），覆盖两类新手法：fs patch 注入（ENOSPC 第 2 个 stage 写入、EPERM journal rename、EACCES recover rename、EIO fsync、assetMetadata rename 失败幂等重试、目录 fsync 容错）和子进程强杀断电（journal 发布后、两个 stage rename 之间、writeSnapshot tmp 孤儿、restore journal 续做）。
2. 真实只读权限测试（chmod 0o444）兼容两种平台结果，但断言"禁止半提交"（target 要么全旧要么全新）。
3. `electron/jsonLinesTransaction.ts` 补齐目录 fsync 策略：同步 `syncDirectory`（open+fsync，catch 吞掉，与 `assetMetadataTransaction.ts` 同款 Windows 折中），journal 发布后、stage 替换后、journal 删除后各一次；测试 spy 验证 ≥3 次调用且失败不阻断提交。
4. `commitPreparedPath`（localFileTransaction）原有断电窗口已于 2026-07-22 关闭：同目录 durable journal 可在 final-aside 后强杀场景完成恢复，原 known-limitation 测试已替换为恢复成功断言。
5. Windows 上目录 fsync 实测不可用（fsyncSync 目录句柄 EPERM），目录项持久化依赖 OS，与既有 assetMetadataTransaction 策略一致。

### 路径型 IPC 分模块所有权审计（路线图 32）

1. 完成 Image Search、Media Search、File Manager、Duplicate Finder 四模块审计，结果写入 `docs/audits/2026-07-18-path-ipc-ownership-audit.md`。
2. 新发现 1 个 P1：`imageSearch:saveIndex` 任意路径写（PIO-P1-01）；8 个 P2（`startScan` `\x1f` 注入、缩略图无 path guard、Media Search EXT 未 ID 化等）；8 个 P3。
3. `ipc-capability-matrix.md` 登记滞后：漏登 `saveIndex`、`duplicates:openPath` 等 15+ 条，待加固时同步。

### PIO-P1-01 修复与 packaged smoke 扩展

1. `imageSearch:saveIndex` 去参数化：IPC 不再接收 Renderer 路径，写位置由主进程状态解析（`saveImageIndexToDefaultLocation`：当前 segment 路径 → userData 索引根 → APPDATA 默认）。preload、IPC 契约、`imageSearchBridge` 同步去掉路径参数。该 IPC 在 Renderer 无任何调用方，属死角攻击面清除。
2. `electron/uiSmokeService.ts` 新增 `runtimeCheck`（11 项布尔）：DINO/CLIP 模型状态（packaged 时断言 `installedPath` 在 `process.resourcesPath` 下）、native addon 连接与版本、备份创建/列表/校验/恢复/pre_restore/分类完整。
3. `tests/electron-ui-smoke.cjs` packaged 模式追加 stdout `Native addon loaded: fast_scanner` 证据断言。
4. **packaged smoke 已全绿**（2026-07-18，adm-zip override 后首次完整构建）：模型 dino/clip true、native fast_scanner 0.4.3 connected、备份 6 项全 true、stdout 证据 true。
5. 发现产品级缺陷（未修，另行立项）：不含任何素材的库产生的备份无法恢复（`restoreAssetLibraryBackup` 硬性要求备份含 `assets.jsonl`）；smoke 以播种空文件绕过。
6. `docs/reference/ipc-capability-matrix.md` 补登 `imageSearch:saveIndex`（W 级）。

### PIO P2 加固（第一批）

1. PIO-P2-01：`normalizeFsPath` 拒绝控制字符（阻断 `\x1f` 扫描根注入）与 >4096 字符路径；`startImageSearchScan` 增加 statSync 目录校验。
2. PIO-P2-03：缩略图四条 channel 统一 `safeShellPath` 校验；`fm-get-file-icons` 限 200 条；`fm-get-folder-thumbnails` maxCount≤32、maxDim 限 [32,256]。
3. PIO-P2-05（部分）：`searchMultimodal` 补图片扩展名白名单（对齐 `searchFramesByImage`）；`detectSubtitles` 的 videoId 化留待后续。
4. 验证：typecheck、lint、guards 7/7、fm-security 15/15、media-search 27/27、ipc-validation 4/4 全绿。
5. PIO-P2-04（Media Search EXT ID 化）：`openMediaAtTime` 只收 videoId 经 manifest 权威解析；`revealInExplorer` 收 `{videoId | scanPath}`，scanPath 限已知扫描根（对话框/已扫描/manifest 祖先）；`normalizeOpenMediaAtTimeInput` 退役，`timestampMs` 转为保留字段；UI smoke 通过。

### PIO P2 加固（第二批）

1. PIO-P2-06：`normalizeUserPath` 拒绝控制字符与 >4096 字符路径（影响 File Manager delete/copy/move 全链）。
2. PIO-P2-07：`openSafeShellPath` 拒绝 UNC 执行（`\\host\share\x.exe` 不可经 `shell.openPath` 启动）；reveal/浏览保持允许——File Manager 浏览网络驱动器是合法用法，UNC 只在执行面封堵。
3. PIO-P2-02：`imageSearch:loadIndex` 要求存在且为文件，`loadManifest`/`repairManifest` 要求存在且为目录。
4. `tests/guards.test.cjs` 新增 2 项（控制字符/超长路径拒绝、UNC 执行拒绝与 reveal 放行），guards 套件 7→9 项。

### 产品完整性与准确率评估（第一批）

0. 删除历史导出 + 手动永久清理（路线图 29 完成）：History 区 Export（save dialog 导出完整回收历史 JSON）+ `assetLibrary:purgeMetadataDeletions`（restoredOnly 清已恢复记录；全清必须 confirm:true，UI 两次确认 armed 模式）；sqlite/dual/jsonl 三模式一致行为，purge 跳过保留策略属预期语义（用户显式动作）。
1. 分类树拖拽 + 最近分类（路线图 26）：分类管理树支持拖拽改父级（拖到目标分类改父、拖到顶部虚线区回根），带自身/后代环检测拒绝；`updateCategory(id, {parentId})` 契约复用。CATEGORY TREE 头部新增 Recent 快捷切换 chips（最近 5 个选中分类）。批量改分类此前已存在（Assign selected）。分类来源统计待服务侧排期。
1. 标签编辑 UI（路线图 25）：Categories & Tags 标签 chip 新增内联编辑（名称 + 颜色 + Enter/Esc），接线既有 `assetLibrary:updateTag` IPC——此前契约/preload/handler 齐备仅缺 UI 入口。
1. 资料库报告导出（路线图 27 部分）：顶部工具栏新增 Report 按钮，`assetLibrary:exportLibraryReport` IPC 经 save dialog 导出 JSON 报告（统计、分类、标签、删除历史汇总，全部走既有只读 API）。标签分布聚合与证据对比待服务侧排期。
1. 准确率模型路线评估（路线图 19）：新建 `docs/designs/2026-07-18-neko-search-accuracy-model-evaluation.md`，评估主体 crop（推荐优先，向量空间兼容、可增量）、OCR 辅助（依赖 worker）、多语言 CLIP/SigLIP（需全库重建，暂缓）三条路线，给出与准确率门禁联动的试点协议。
1. Duplicate Finder 集成方案（路线图 24）：新建 `docs/designs/2026-07-18-neko-search-duplicate-integration.md`——完全重复（SHA-256 分组 worker）+ 近重复（复用 native dHash 索引，零重解码）+ 处置统一走既有软归档（`archiveAssetLibraryAssets`，无物理删除），审核流复用 AI Suggestions 框架（`suggestions.source='duplicate'` 预留槽位启用）。实施排在 SQLite 阶段 3 后。
1. 聚类人工干预与稳定 Lineage 方案（路线图 23）：新建 `docs/designs/2026-07-18-neko-search-cluster-lineage-plan.md`——合并/拆分/成员移动三操作（origin 标记 + lineage 事件表）、重算身份继承（Jaccard ≥ 0.5 继承命名/confirmed 状态）、人工干预组重算不删。实施排在 SQLite 阶段 3 后。
1. Duplicate Finder 集成阶段 A 核心（路线图 24）：`electron/libraryDuplicateGroups.ts` 建成——权威路径清单输入的完全重复分组（大小预分组 → 流式 SHA-256 → ≥2 成组），定宽并发池（默认 16）、协作式取消、冗余字节统计、确定性输出；专项测试 8/8（跨目录归组、缺失跳过、排序确定性、5MB 流式哈希与直算一致）。组落库与审核流接线排在 SQLite 阶段 3 后。
1. 路线图 17/18/22 状态：基线记录工具（`--write-baseline`）与门禁阈值（Reject intrusion ≤5%、purity 中位 ≥0.80 警告）已就绪，激活阻塞于人工标注；达标前不调整默认算法阈值（持续执行）。

### SQLite 关系迁移（阶段 0-3）

1. 阶段 0：`electron/assetLibraryDatabase.ts` 建成——`node:sqlite`（WAL + synchronous=FULL），schema v1 共 9 表，复合唯一索引齐备；幂等导入、`exportJsonl` 回滚导出、`verifyAgainstJsonl` 双跑比对。
2. 阶段 1（dual 影子双写）：`storageMode` 三态 flag（init 选项 > env > settings > 默认 dual）；12 个事务调用点 + 13 个 flush 点挂影子重灌；影子失败只 warn。
3. 阶段 2（读路径 SQL 化）：7 项读取经 `withShadowRead` 分流；15 组新旧 deepEqual；分类过滤分页 p95 33.2ms、建议分页 p95 41.1ms 达标。
4. 阶段 3（写路径 SQLite 权威化，2026-07-19）：`withSqliteWrite`（COMMIT 成功才动内存镜像，失败 ROLLBACK + fail-closed）+ 9 个关系 store `setMemoryOnly` 纯内存镜像 + `library_meta next_id:<table>` 序列分配。§4 表 C 全部落地：upsert 批量（IN 500/批 + ON CONFLICT，manual 优先三态零改动）、delete/restore 分类标签（trash SQL 裁剪 50 条/32MiB）、建议审核/撤销、参考图、聚类组级联替换。sqlite 模式下 12 个 `runJsonLinesTransaction` 调用点全部退役。
5. 备份 manifest v2：`VACUUM INTO` 快照 `asset-library.sqlite`（SHA-256 入 manifest），9 个关系 JSONL 改名 `.jsonl.migrated` 列入清单；恢复向后兼容——v1 备份（仅 JSONL）自动重导入，v2 备份（含 sqlite）直接替换；dual 恢复时 `exportJsonl` 回写保持权威一致。
6. 测试：`asset-library-sqlite-mode` 6 项（端到端迁移改名、upsert 两模式逐字段 deepEqual、SQL trash 裁剪、exportJsonl 回滚演练、v1 备份恢复重导入、子进程 COMMIT 前断电故障注入）；全套 272/272。
7. 真实库 dual 预检（2026-07-18，临时副本）：dual 模式启动导入真实库形状成功，`verifyAgainstJsonl` 全部一致。真实库本身未写入。
8. 维护项 36 常规门槛（2026-07-19 只读验证）：真实库 228,710 条关系记录、0 坏行；最新备份 SHA-256 校验通过。

### SQLite 阶段 4：默认 sqlite 切换与 dual 退役（2026-07-19）

1. 真实库 dual 验证（文档要求的切换前置）：dual 模式启动真实库生成 `asset-library.sqlite`；新建只读诊断工具 `scripts/validate-relation-parity.cjs` 确认 9 张关系表计数+哈希与 JSONL 逐表一致；真实写操作（分类创建/删除/撤销、19 条素材分类、493 条建议生成、手动备份创建+校验）后复验仍全一致。
2. 默认切换：`resolveAssetLibraryStorageMode` 默认值与非法回退从 `'dual'` 改为 `'sqlite'`；`'dual'` 成为非法值，存量 settings/env 中的 dual 配置自动回退 sqlite。
3. dual 机制删除：`shadowReloadRelationStores`（16 个调用点）、`runRelationStoresTransaction` 包装（12 个调用点改为直调 `runJsonLinesTransaction`）、备份恢复后 dual 回写分支、无调用方的 `AssetLibraryDatabase.replaceAllRelations`。
4. `jsonl` 模式保留为应急逃生门：sqlite 异常时先恢复备份或把 `.jsonl.migrated` 改回 `.jsonl`，再以 `FLOATING_CLOCK_ASSET_STORAGE_MODE=jsonl` 启动；逃生门已在真实库形状的临时副本上演练通过（`scripts/drill-jsonl-escape-hatch.cjs`）。
5. **切换演练暴露并修复一个阶段 3 缺陷**：dual 期间经影子重灌进入 SQLite 的记录不推进 `library_meta` 的 `next_id` 序列，切换 sqlite 后首次写对应表会触发 UNIQUE 约束失败（fail-closed 正确生效，数据无损）。修复：`AssetLibraryDatabase.reconcileIdSequences()` 在每次 init 时把各表序列提升到 MAX(id)+1；新增回归测试（out-of-band 插入后重启写成功）。该缺陷只影响 dual→sqlite 切换路径，阶段 3 前不存在。
6. 真实库 sqlite 首启验证：8 个关系 JSONL 自动改名 `.migrated`，9 表计数与迁移前一致；sqlite 写路径演练（`scripts/drill-sqlite-write.cjs`：创建→删除→撤销→清理）通过。
7. 测试调整：`tests/asset-library-dual.test.cjs`（7 项 dual 专属）退役，新建 `tests/asset-library-storage-mode.test.cjs`（3 项：模式优先级与默认 sqlite、dual 非法回退、jsonl 不建库、purge 双模式一致）；sqlite-mode 套件新增序列 reconcile 回归（6→7 项）；`asset-relation-benchmark` 改 sqlite 模式。全套 270/270。
8. sqlite 模式关系基准：分类过滤分页 p95 45.8ms、建议分页 p95 33.5ms 达标；stats/clusters 未达项与阶段 2 相同（node:sqlite 逐行物化地板，非本次回归）。
9. 边界说明：stats 的 `totalAssets` 是活跃素材数（真实库 180,016，总记录 187,370 减去 missing/archived）；`listAssetClusters` 只列有活跃成员的未忽略组（真实库 214/217）。

### 备份便携化与 JSONL 容量防护（路线图 28、12）

0. 请求过期保护（路线图 15 / NKS-P2-05）：`loadSuggestions`/`loadClusters`/`loadReferences`/`loadCategoryAssets` 接入独立 generation ref，与 `loadAssets` 同模式丢弃过期响应，快速切换分类/筛选时旧请求不再覆盖新状态。
1. 备份便携导出/导入/单份删除（28）：`assetLibrary:exportBackup / importBackup / deleteBackup` 三条新 IPC（dialog 主进程权威选径、backupId 严格校验防逃逸）；导出前 verify、目标已存在拒绝覆盖、导入 id 冲突自动加 `-imported-<ts>` 后缀、删除两次确认（5 秒 armed）；导入后复用既有 restore 链路。Backups 视图加 Import/Export/Delete 按钮。专项测试 7/7。
2. JSONL 容量防护（12）：`JsonLinesStore` 新增 options——`maxLineBytes`（默认 32 MiB，兼容删除回收大记录）、`maxFileBytes`、`maxRecords`、`validate(record)` 逐字段钩子。加载侧：超长行/validate 失败记 corruption（锁写保读）、超文件/记录数上限 fail-closed；写入侧：validate 失败与超行拒绝且不消耗自增 id、超记录数拒绝。新增测试 5 项（10/10 通过）。
3. 维护项 34 已消除：`asset-selection-range.test.cjs` 改用 `loadTsModule`，`MODULE_TYPELESS_PACKAGE_JSON` 警告消失。

### 删除历史容量与恢复

1. `metadata_deletion_trash.jsonl` 增加 50 条和 32 MiB 双上限。
2. 未恢复记录优先保留，已恢复记录按时间淘汰；最新单条超限记录仍至少保留一条。
3. 分类/标签删除、历史写入和旧记录裁剪在同一 JSONL 事务内提交。
4. Categories & Tags 增加 `History`，支持分页浏览容量、关系数量和恢复状态。
5. 支持按记录 ID 恢复指定分类或标签；原 `Undo last` 复用同一恢复逻辑。
6. 真实已有删除历史不会在启动时被静默裁剪，保留策略仅在后续新删除时执行。

### Shell 操作所有权收紧

1. NekoSearch 的 `Open/Folder` 不再接受 Renderer 传入的任意文件路径。
2. preload 和 IPC 契约改为只接收正整数 asset ID。
3. 主进程从权威 `AssetMetadataStore` 解析路径，再执行存在性和协议校验。
4. 未知 ID、`missing=true` 素材和路径字符串会被拒绝。
5. Assets、分类详情、Sample Search、Similar Search 和 AI Suggestions 已全部迁移为 ID 调用。
6. 已归档但仍属于权威素材库的素材继续支持打开和定位。

### 文档一致性

1. `NKS-P2-08` 已更新为“已解决”。
2. `NKS-P2-09` 已更新为“已解决”，并从安全剩余风险列表移除。
3. 当前审计、安全评分、测试数量和后续优先级已经同步。

## 最近验证基线

以下表格是 2026-07-22 在本轮 ②/③/④/⑥/⑦ 收尾后执行的**历史基准**，用于保留实现轨迹；它不覆盖上方 2026-07-28 综合复核。未标注“本轮未重跑”的历史基准保持原记录。

| 验证项               | 命令                                                                           | 结果                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript           | `npm.cmd run typecheck`                                                        | 通过                                                                                                                                       |
| Lint                 | `npm.cmd run lint`                                                             | 通过                                                                                                                                       |
| Format               | `npm.cmd run format:check`                                                     | 通过                                                                                                                                       |
| 完整测试套件         | `npm.cmd test`                                                                 | 281/281 通过（新增参考图后端 1、prepared-path 越界恢复 1、搜索结果身份缓存 2；含故障注入 13、SQLite 专项 18、Asset Library 94、Native 29） |
| 完整构建门禁         | `npm.cmd run verify`                                                           | 通过；覆盖 typecheck、lint、format、全量测试、native 重编译及 renderer/main/preload/全部 worker 构建                                       |
| Similar worker 对照  | `node scripts/verify-similar-service-parity.cjs`                               | 通过；服务+worker 与改前基线逐 hit 一致（232,653 向量、50 hits）                                                                           |
| 建议扫描 worker 验证 | `node scripts/verify-suggestion-worker.cjs`                                    | 通过；真实库两次生成 2,500 行逐行一致、零排除对违规                                                                                        |
| 关系一致性诊断       | `node scripts/validate-relation-parity.cjs`                                    | 通过；真实库 9 表计数+哈希与 JSONL 逐表一致（dual 验证期，含真实写后复验）                                                                 |
| sqlite 写路径演练    | `node scripts/drill-sqlite-write.cjs`                                          | 通过；真实库创建→删除→撤销→清理                                                                                                            |
| jsonl 逃生门演练     | `node scripts/drill-jsonl-escape-hatch.cjs`                                    | 通过；临时副本 jsonl 模式读取真实库形状数据                                                                                                |
| IPC 注册             | `npm.cmd run test:ipc-registration`                                            | 4/4 通过                                                                                                                                   |
| Preload 契约         | `npm.cmd run test:preload-contract`                                            | 1/1 通过                                                                                                                                   |
| onnxruntime 加载     | `npm rebuild onnxruntime-node` + Node 加载冒烟                                 | 通过，1.24.3 正常加载                                                                                                                      |
| Electron UI Smoke    | `npm.cmd run smoke:ui`                                                         | 通过，分类创建/删除/恢复、History、Similar、Category Group、Sample Search 全部通过                                                         |
| 标注工具自测         | `npm.cmd run annotation:neko:smoke`                                            | 通过                                                                                                                                       |
| 标注数据集构建       | `npm.cmd run annotation:neko:prepare`                                          | 通过；563 候选、537 seeded，只读真实库                                                                                                     |
| 基准就绪门禁         | `npm.cmd run benchmark:neko-search:accuracy`                                   | 通过；标注缺口 26 正确报出并 exit 2                                                                                                        |
| 首个正式准确率基线   | `node tests/neko-search-accuracy-benchmark.cjs --category=12 --write-baseline` | 通过（2026-07-20）；test01 基线已写入 `docs/benchmark/neko-search-accuracy-baseline.json`，`--gate` 可启用                                 |
| Asset Catalog 基准   | `npm.cmd run benchmark:asset-catalog`                                          | 180k 构建 2.28s，普通页中位 2.81ms（上一轮结果，本轮未重跑）                                                                               |
| Asset Relation 基准  | `npm.cmd run benchmark:asset-relation`                                         | 2026-07-22：分类过滤 p95 36.79ms、建议分页 40.61ms、stats 57.18ms、clusters 37.61ms，四项均达标                                            |
| 生产依赖审计         | `npm.cmd audit --omit=dev --audit-level=high`                                  | 通过，0 个 high                                                                                                                            |

UI Smoke 已覆盖分类创建、删除、History 记录显示、指定恢复、Similar 入口、Category Group、标签创建、Sample Search 和返回 Assets。

## 当前数据边界

1. 真实资料库只读检查结果为 187,370 条素材、0 个坏行、`nextId=187371` 和 11 条归档记录。
2. 本轮没有修改、删除或移动真实原始图片。
3. 本轮没有在真实 18 万素材上执行全量建议或聚类重算。
4. 删除历史保留策略不会在启动时主动改写已有历史。
5. NekoSearch 之外的 Image Search、Media Search、File Manager 和 Duplicate Finder 仍使用各自路径型 IPC，需要按模块分别审计所有权，不能机械套用 asset ID。

## 剩余优化项

### P1 发布前优先

1. 恢复准确率门禁性能：优化向量分片读取、垃圾回收、二进制缓存或 ANN，使同机同数据集扫描 p95 回到基线 1.5 倍以内。
2. 扩充多分类人工标注：当前只有 test01 单分类，且 147 条候选中仅 48 条为 manual，不能把满分 P@K 解释为全库泛化质量。
3. ~~修复开发态 UI smoke 的语言耦合并覆盖中文和英文。~~（REL-01 已完成）；下一步由 REL-03 重新验证当前安装器的模型、native addon、备份与恢复。
4. 与全项目整改联动处理生产依赖、磁盘增长、国际化和随包许可证；这些不属于 NekoSearch 算法本身，但会阻断包含该功能的正式发布。
5. 已完成的历史 P1：`adm-zip` 当时的可达性评估、首个单分类基线、关系数据 SQLite 阶段 0-4。它们作为历史里程碑保留，但不能抵消当前门禁失败。

### P2 可靠性与规模

1. ~~为 JSONL 增加逐字段 schema、单行长度和总记录数限制，明确坏行与整体损坏策略。~~（已完成 2026-07-18：`JsonLinesStore` 增加 maxLineBytes/maxFileBytes/maxRecords/validate，见“本轮完成”。）
2. ~~将长向量搜索和聚类任务进一步迁移到 worker/ANN，降低 Electron 主进程长任务压力。~~（worker 批次已完成：Similar Search、建议扫描、聚类、Category Sample Search、Category Group 与 feedback 重建均已迁移；ANN/倒排仍属长期独立优化。）
3. ~~增加真实磁盘满、权限撤销、设备 I/O 错误、断电和安装包环境故障注入。~~（已完成 2026-07-18：故障注入 13 项，见“本轮完成”。）
4. ~~补充 packaged UI Smoke，验证安装包内模型、native addon、备份和恢复路径。~~（已完成 2026-07-18：runtimeCheck 11 项全绿，见“本轮完成”。）
5. 关系数据迁入 SQLite 后，将删除历史快照拆表或压缩，并增加导出和手动永久清理。（导出已完成 2026-07-18；拆表随 SQLite 阶段 3 的 trash 表落地；手动永久清理待服务侧排期。）

### 维护与安全（路线图 30-36 状态）

1. 路线图 30（OCR、filename 分类、Media Search 视频关键帧接入）：按路线图自身排序**维持最后接入**；OCR 作为辅助特征的评估已写入 `docs/designs/2026-07-18-neko-search-accuracy-model-evaluation.md`，待 worker 迁移（路线图 10）后立项。
2. 路线图 31（参考图即时 embedding CPU/GPU 统一）：**已完成（2026-07-22）**，即时参考图 embedding 读取用户向量后端设置，异常设置安全回退 CPU。
3. 路线图 35（主素材与关系 schema 统一、防双重模型漂移）：由 SQLite 迁移设计覆盖——关系数据以 `asset-library.sqlite` 为唯一权威，JSONL 仅作导入来源与导出回滚（`exportJsonl`），素材本体保持 `assets.jsonl` + 只读投影不变。
4. 路线图 32、33、34、36：已完成（见“本轮完成”各节）。

## 建议实施顺序

本清单的 ①a、⑤、①b、②、③、④、⑥、⑦及其当时的全量验证均已完成。下一阶段不再沿用旧修复顺序，应先恢复扫描性能门禁，再扩充准确率基线的新分类覆盖，然后修复双语 UI/packaged smoke；全项目依赖、磁盘与许可证 P1 并行纳入发布整改。

已完成的历史能力：固定真实标注集和首个准确率基线、关系数据 SQLite 迁移（阶段 0-4）、worker 两批迁移、stats/clusters 聚合、参考图后端统一、批量关系 Map 化、prepared-path 断电恢复、搜索结果身份与会话历史、JSONL schema/容量防护、系统级故障注入，以及 2026-07-18 当时版本的 packaged smoke。算法默认阈值调整和发布候选版本都必须重新通过当前 `--gate` 与双语 packaged smoke。

## 新对话读取顺序

1. 本文档：掌握当前进度、当前门禁和下一步。
2. [2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)：查看最新发布判断、磁盘、依赖和验证证据。
3. [准确率门禁工具链](../benchmark/2026-07-18-neko-search-accuracy-gate.md)：查看阈值、当前失败结果和数据集边界。
4. [完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)：查看 2026-07-18 专项问题证据和评分依据。
5. [实施基线](2026-07-14-neko-search-implementation.md)：查看功能流程、数据结构和历次实现细节。
6. [分类数据恢复记录](2026-07-18-neko-search-category-data-recovery.md)：查看数据丢失原因、恢复范围和保护措施。
