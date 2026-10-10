# 2026-08-05 工作交接：向量存储（D2b–D3）与 FastScanner（FS-07P–07S）

> 项目：FloatingClock Electron
> 交接日期：2026-08-05
> 交接范围：向量存储线（阶段 D2b、D2c、D3-1/2/3）与 FastScanner native 线（FS-07P/Q/R/S）当日全部进度、当前状态与下一阶段入口。
> 事实来源：`git log`、批次记录（[项目审计整改进度](../current/2026-07-28-project-audit-remediation.md) 第一百一十四至一百一十八批）、FastScanner 系列记录（[全项目详细优化方案](../current/2026-07-28-project-optimization-plan.md) 第 12 节）。

## 1. 今日 commit 时间线（9 个，均已在 main，新→旧）

| Commit | 一句话说明 |
| --- | --- |
| `f45a4ba` | feat(vectors)：D3 阶段 3——`getVectorMaintenanceStats` 诊断/导出入口改读复合快照，维护页统计不再逐行扫多 GiB JSONL shard（批次 118，vector-pipeline 102/102）。 |
| `fa77f95` | feat(vectors)：D3 阶段 2——读取端复合快照（基座 generation + 已提交增量段），追加后派生缓存/帧索引不再重建（批次 117，99/99）。 |
| `8d39f96` | feat(vectors)：D3 阶段 1——`electron/embeddingIncrementLog.ts` 追加双写 JSONL + generation 增量日志（批次 116，94/94）。 |
| `77de584` | docs(vectors)：D3 设计决策记录，见 [embedding 追加增量日志设计](../current/2026-08-05-embedding-append-incremental-log-design.md)。 |
| `cc59699` | docs(fastscanner)：FS-07S——多 env 并发写索引隔离评估（纯评估未改代码），见 [评估报告](../current/2026-08-05-fastscanner-multienv-write-eval.md)。 |
| `2355e1f` | fix(fastscanner)：FS-07R——确认 addon 仅主进程单 env 加载，真实缺口是 `uiSmokeService` 的 `app.exit` 绕过 will-quit，已补握手并加守卫测试（`tests/image-search-shutdown.test.cjs` 7/7）。 |
| `8522bee` | feat(vectors)：D2c——Media Search 帧索引改读权威 generation（批次 115，vector-pipeline 88/88、media-search 32/32）。 |
| `dba7d98` | fix(fastscanner)：FS-07P+Q——10 个 N-API 旧入口缺参 UB 修复 + topK（≤1000）/threshold（0..64）钳制，fast_scanner 0.5.24，双 ABI 重建，native 65/65。 |
| `1ac7dad` | perf(vectors)：接手并提交上个会话遗留 WIP——CLIP 语义搜索私有 F32 缓存退役，统一到共享 F16 权威缓存（D2b，批次 114 为补记）。 |

上一条（本日之前）为 `cf8e55f perf(vectors): incremental authoritative store migration with append-only proof`。

## 2. 向量存储线：当前状态

- 阶段 D1、D2a/b/c、D3-1/2/3 全部完成。JSONL 兼容窗口的三类入口（Media Search 帧索引、embedding 追加、诊断/导出）已全部关闭。
- JSONL shard 角色已收敛为：迁移导入源 + 召回门禁对照源（F32 对照，刻意保留）+ 追加写目标。
- 读取端口径：消费方读"基座 generation + 已提交增量段"复合快照；追加 embedding 后派生 F16 缓存与帧索引不再重建，ANN 按指纹失配重建一次（设计约定）。
- 批次记录：第一百一十四批（D2b 补记）至第一百一十八批（D3-3），均在 `docs/current/2026-07-28-project-audit-remediation.md`。

### 下一阶段入口

- **D3 阶段 4（未启动）**：评估 JSONL shard 退役进清理预览。按设计（`docs/current/2026-08-05-embedding-append-incremental-log-design.md` "阶段 4"节），前提是双写稳定运行 N 个维护周期（含至少一次真实崩溃恢复观察与一次召回门禁复跑）后再评估；legacy `image_embeddings.jsonl` 的退役条件单独评估，不随 shard 一并处理。

### 已知留后续的小项（不阻塞，来自批次 117/118 边界记录）

1. 基座 manifest imports 的可选 `tailSha256` 字段未实施（设计标注可选，留待随迁移写入侧一并落地）。
2. 召回门禁复合路径无逐文件 sha256 复核（沿用 manifest 默认校验，manifest 哈希校验仍在）。
3. 读取侧对源文件 ENOENT 从严判失效（与 `openAuthoritativeVectorStore` 的宽容口径不同，属刻意从严）。
4. `extendEmbeddingF16Cache` 未增量化（增量存在时仍从旧基座合并完整 JSONL 尾部，结果正确，属性能优化留待后续）。
5. ANN 每次追加提交后按指纹重建一次（设计约定，ANN 增量化仍为后续优化）。
6. 真实数据小批量追加后的召回门禁复跑、真实维护页统计复核：留维护窗口按既有真实执行纪律执行。
7. ~~完整 `npm test` 在本轮 D3 改动后尚未重跑~~ **已闭环（2026-08-05）**：交接文档提交后对 `195b2d7` 工作树执行完整 `npm test`（41 步 `&&` 链），退出码 0，收尾 `test:native` 65/65 全绿，运行日志在 ignored `artifacts/npm-test-2026-08-05.log`。各 D3 commit 的 Validation trailer 中的 not-run 记录为当时事实，保留不改。

## 3. FastScanner 线：当前状态

- FS-07O→07S 全部完成，交接文档所有明示/暗示待办清零；当前版本 **0.5.24**（`native/fast_scanner.cc` 的 `GetNativeVersion`），Node/Electron 双 ABI 已重建，native 65/65 通过。
- FS-07P+Q：全部搜索/哈希/扫描/manifest N-API 入口缺参早退报错；topK clamp 1..1000、threshold clamp 0..64，同步/异步一致。
- FS-07R：Worker/controller 关闭路径取消握手补全；确认 addon 仅主进程 `imageSearchService` 单 env 加载，守卫测试禁止 Worker/Child 加载。
- FS-07S：多 env 并发写索引隔离评估——失败关闭语义完备，无"持有租约的 env 退出后租约泄漏"死角；禁令精确化为"语义上仍不支持多 env 并发写（fail-fast 不排队，调用方须串行化），架构上已被租约失败关闭保护不致索引损坏"。
- 长期 backlog（不阻塞，6 项：写准入排队、写者归一、读快照语义、关闭握手扩展等）在 `docs/current/2026-08-05-fastscanner-multienv-write-eval.md`；新增 addon env 前须先完成该差距清单。
- 系列逐条记录与"FastScanner 交接状态"节在 `docs/current/2026-07-28-project-optimization-plan.md` 第 12 节。

## 4. 发布队列状态（`npm run todo:next` 口径）

- LIC-01（项目许可证与第三方声明清单）：进行中，需版权负责人决策，工程侧无法自动推进。
- ACC-02（扩展真实人工标注分类）：按用户决定暂缓（103 项人工标注）。
- ACC-03 被 ACC-02 阻塞；REL-04 被 BLD-03/LIC-02/REL-03/ACC-03/I18N-04 链阻塞（表内状态均为"待做"）。
- 其余 32 项任务全部"已验证"，**工程侧自动可执行任务已清空**；`ARC-01` 已验证（旧文档"当前第一个可自动执行 TODO 是 ARC-01"的表述已于本次交接同步更正）。

## 5. 工作区状态

- 仅余 10 个仅行尾差异的配置文件未提交：`.editorconfig`、`.githooks/commit-msg`、`.githooks/pre-commit`、`.githooks/pre-push`、`.gitignore`、`.gitmessage`、`.prettierrc`、`build-installer.bat`、`build.bat`、`scripts/verify-multilingual-text-encoder-parity.py`——均刻意未动，**不要 stage**。
- 未跟踪 `start.bat`：刻意未动；其纳管/忽略/保留按 GIT-01 记录由用户单独决定。
- 提交前务必 `git status` 复核，只 add 目标文件，不用 `git add -A` / `git add .`。

## 6. 执行惯例速查

- **禁止直接提交 main**：任务分支 → pre-commit hook（privacy/typecheck/lint/format）→ `.gitmessage` 四个 trailer（`Executor-System` / `Executor-Model` / `Task` / `Validation`，各恰好一次）→ `git merge --ff-only` 回 main → 删分支。详见 [Git 工作流与提交机制](../reference/git-workflow-and-commit-policy.md)。
- 测试用单项 `test:*` script（如 `npm.cmd run test:vector-pipeline`、`npm.cmd run test:native`、`node --test tests/image-search-shutdown.test.cjs`）；完整 `npm test` 是 41 步 `&&` 链，耗时显著，留维护窗口跑。
- commit message 含 Context/Changes 段落；docs 提交 scope 惯例为 `docs(<子系统>)`，如 `docs(vectors)`、`docs(fastscanner)`。
- 批次记录追加在 `docs/current/2026-07-28-project-audit-remediation.md`（下一批为第一百一十九批）；FastScanner 系列记录追加在 `docs/current/2026-07-28-project-optimization-plan.md` 第 12 节。
- Validation 纪律：记录命令、通过数量和未验证项；not-run 必须注明原因，不得把"已编码"写成"已完成"。

## 7. 给下一位执行者的第一批建议动作

1. ~~维护窗口跑完整 `npm test`~~ **已完成（2026-08-05，退出码 0）**；剩余维护窗口事项：真实数据小批量追加后复跑召回门禁（`scripts/verify-vector-generation-recall.cjs`），并复核真实维护页统计与 JSONL 扫描基线一致（批次 117/118 验证记录口径）。
2. **D3 阶段 4 评估前提观察**：观察双写在 N 个维护周期内稳定运行（含至少一次真实崩溃恢复观察与一次召回门禁复跑），满足前提后再启动 JSONL shard 退役进清理预览的评估；前提未满足不动 JSONL。
3. **LIC-01 决策清单整理**：为版权负责人整理待决策项清单（许可证与第三方声明、YOLO/FFmpeg 合规处置选项），推动 LIC-01 闭环，解锁 LIC-02 → REL-04 发布链。
