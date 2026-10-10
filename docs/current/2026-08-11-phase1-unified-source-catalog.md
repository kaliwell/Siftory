# Phase 1 统一来源与文件目录实施说明（2026-08-11）

> 状态：部分实施
> 实施状态：进行中，待复验
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md`（第 5、6、7、9.3、12.1、14 节）
> 权威边界：`docs/reference/2026-08-11-storage-authority-boundaries.md`
> 分支：`feat/phase1-unified-source-catalog`，提交 b85108c、3ed750e

## 交付物

| 层 | 文件 | 职责 |
| --- | --- | --- |
| shared | `shared/ipc/discovery-catalog.ts` | `DataSource`、`FileEntry`、`ScanSession`、`IndexState` 契约；`SourceAdapter` 接口（方案 6.2）；IPC DTO 与 `DISCOVERY_CATALOG_IPC` 通道常量 |
| electron | `electron/discoveryCatalogDatabase.ts` | `discovery-catalog.sqlite`（schema v1）：sources / file_entries / scan_sessions / index_states；按 `(source_id, path_key)` 幂等 upsert；每批次独立事务提交 |
| electron | `electron/sourceAdapter.ts` | `LocalNtfsSourceAdapter`：封装现有 native 扫描（USN 优先、目录枚举回退），轮询已提交索引记录流式产出 `DiscoveryBatch`；`mounted-network`/`sftp` 仅保留类型与接口占位 |
| electron | `electron/sourceCatalogService.ts` | 应用服务：来源增删、probe、扫描编排（串行化，native 单例）、取消、状态订阅、目录查询 |
| electron | `electron/discoveryCatalogIpc.ts` | `sources:list/add/remove/probe`、`sources:scan/start|cancel|status`、`catalog:query/stats`；薄 handler + 输入钳制 |
| preload | `electron/preload.ts` + `shared/ipc/electron-api.ts` | `discoveryCatalog` API 镜像；状态事件 `sources:scan/statusChanged` |
| renderer | `src/components/DiscoverySourcesSection.tsx`（挂入 `ImageSearchPanel`） | 来源列表（可用性/阶段/后端/回退原因/文件数）、添加来源、扫描/取消/移除、文件名搜索框 |
| tests | `tests/discovery-catalog.test.cjs`、`tests/source-adapter-contract.test.cjs` | 见下「验收映射」 |

## 关键决策

1. **FileEntry 稳定身份（Phase 1）**：按方案 6.3/7.2 的路径策略退化档——`sourceId + 规范化路径`（win32 小写）。native 索引当前不暴露卷/FRN 身份，`filesystem_identity` 列已预留，Phase 2 升级。取消、重启、重复扫描均走同一 upsert，不产生重复行。
2. **权威边界**：`discovery-catalog.sqlite` 是来源/文件条目/扫描会话/索引阶段的权威；实现中没有任何对 native manifest、`assets.jsonl`、`asset-library.sqlite`、`asset-catalog.sqlite` 的写操作，遵守 Phase 0 冻结边界第 3 条。
3. **发现面**：native 扫描当前只枚举图片文件，因此 Phase 1 目录镜像该发现面（含 native 的 USN→目录枚举回退及退化原因）。扩展到全文件类型需要 native 增加 enumerate-all 入口，列为后续工作。适配器按来源根过滤进程全局 native 索引中的记录，避免跨根污染。
4. **D1 先行**：批次提交即写 `index_states(file_entry_id, 'discovered', 'ready')`，目录查询为纯 SQL 词法搜索，不依赖任何 AI 模型；D2+ 阶段未实现。
5. **扫描串行**：native addon 是进程级单例，服务层强制同一时间只有一个来源扫描；取消保留已提交批次，会话标记 `cancelled`；只有完整成功扫描才更新 `lastSuccessfulScanAt`，不做 missing 标记（方案 6.2 约束 3，reconcile 留给后续阶段）。
6. **发现性能**：适配器每 250ms 轮询一次 native 进度并 diff 快照，扫描线程本身不受投影影响；大批量下的快照 diff 成本列为 Phase 2 前的性能复查项（对照 Phase 0 基线，不允许超过 ~10% 发现回退）。

## 验收映射

| 验收标准 | 证据 |
| --- | --- |
| AI 模型未下载时仍可完成路径、大小和文件名搜索 | `tests/discovery-catalog.test.cjs`「lexical path/size/name search needs no AI model」（纯 SQL 词法搜索，无模型依赖） |
| 扫描中可以查询已提交批次 | 同文件「committed batches are queryable while the scan is still running」（扫描运行中查询到批次 1） |
| USN 不可用时显示回退原因，结果完整性与目录枚举基线一致 | 「USN fallback reason surfaces on session, status and source list」；`tests/source-adapter-contract.test.cjs`「local NTFS adapter discovers exactly the directory-enumeration baseline」（真实 native 扫描结果集 == fs 目录枚举基线；enum 后端必须带回退原因） |
| 取消、重启和重复扫描不会产生重复 FileEntry | 「cancel keeps committed batches and rescan never duplicates entries」+「service + native adapter: cancel, restart and rescan stay duplicate-free」（真实 native，FileEntryId 稳定） |

## 验证记录

- `npm run test:discovery-catalog`：8 项全过（2026-08-11）。
- `npm run test:architecture`（layering + build-graph）：通过。
- `npm run typecheck`：通过。
- `npm run test:ipc-validation`、`test:ipc-registration`、`test:preload-contract`：通过（新通道经能力声明与 preload 镜像门禁）。
- `npm run test:i18n-static`、`test:ui-smoke-contract`、`test:settings`：通过。
- `npm run test:native-scan`：24 项全过（native 行为未改动）。
- 提交钩子（preflight + privacy + typecheck + lint + prettier）两次提交均全绿。

## 剩余缺口

1. 全文件类型发现（非图片）依赖 native enumerate-all 入口。
2. 卷/FRN 稳定身份与盘符变化修复（Phase 2 身份策略）。
3. 完整 reconcile 后的 missing 标记与派生清理策略（方案 12.3）。
4. 来源视图目前是 ImageSearchPanel 内嵌区块；独立「数据源」一级导航面板（含设置持久化与面板注册）留待 Phase 6 信息架构收敛时做。
5. 大批量投影 diff 的性能复查（对照 Phase 0 基线）。
