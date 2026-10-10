# 存储权威边界图（Phase 0 冻结，2026-08-11）

> 状态：Phase 0 基线冻结。本文梳理当前各持久化存储的权威职责，作为 Phase 1+ 统一来源（DataSource / FileEntry / Discovery Catalog）的边界依据。任何存储职责变更必须先更新本文。
> 代码依据：`electron/authoritativeVectorStore.ts`、`electron/embeddingIncrementLog.ts`、`electron/embeddingF16Cache.ts`、`electron/assetLibraryDatabase.ts`、`electron/assetCatalogProjection.ts`、`electron/assetMetadataStore.ts`、`native/fast_scanner.cc`。

## 总览

| 存储                             | 位置                                                                                                   | 权威职责                                                                                          | 可重建性                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Image Search manifest + segments | `%APPDATA%/floating-clock-electron/image-search-index/manifest.json` + segment 文件                    | 感知 hash 索引（diffHash64/dctHash64）、路径、尺寸、文件大小、mtime 的权威记录                    | 可从原文件全量重扫重建，成本高                                              |
| Embedding JSONL 分片             | embedding 缓存目录下 `<base>.paths.jsonl`（追加日志）                                                  | embedding 向量的**最终权威来源**；一切派生存储损坏时回退到它                                      | 原始来源，不可从其他派生物重建（需重跑模型）                                |
| 权威向量库（generation store）   | `vector-store/CURRENT` + `generations/<gen>/manifest.json` + `vectors.f16` / `paths`（带 sha256 证明） | 已校验的复合向量代（generation）权威快照，搜索/ANN 的读取基线                                     | 可从 JSONL 重放重建；损坏时 fail-closed 回退 JSONL                          |
| Embedding 增量日志               | `vector-store/incremental/<model>__<type>/delta.f16` + `delta.paths.jsonl` + `delta.json`              | 追加双写的**从属提交点**，加速增量读取                                                            | 从属物；任何校验失败即丢弃，回退 JSONL-only                                 |
| 素材记录 JSONL                   | `assets.jsonl`（AssetMetadataStore）                                                                   | 素材身份记录（id、path、kind、source、宽高、hash、missing/archived）的权威                        | 原始来源                                                                    |
| Asset Library SQLite             | `asset-library.sqlite`（AssetLibraryDatabase，schema v2）                                              | 用户整理数据权威：tags、categories、asset_tags/asset_categories、suggestions、category_references | 用户数据，不可自动重建；已从 JSONL 迁移                                     |
| Asset Catalog SQLite             | `asset-catalog.sqlite`（AssetCatalogProjection，schema v3）                                            | **非权威投影**：assets.jsonl 的列表/排序/FTS 加速视图                                             | 完全可重建；`source_fingerprint` + 记录数校验新鲜度，失败即 DELETE 全量重建 |
| 缩略图缓存                       | native thumbnail sidecar/rebuilder 缓存目录                                                            | 预览缩略图                                                                                        | 完全可重建                                                                  |
| ANN 索引                         | `electron/vectorAnnIndex.ts` 派生物                                                                    | 近似最近邻加速结构                                                                                | 可从权威向量库/JSONL 重建                                                   |

## 各存储详述

### 1. Image Search manifest（native，感知 hash 索引）

- 由 `native/fast_scanner.cc` 的 `saveIndexToManifest` / `loadManifest` / `repairManifestFromSegments` 管理。
- `manifest.json` 指向若干 segment 文件；segment 保存路径字节、每记录元数据（宽高、大小、mtime）与 diff/dct hash 数组；支持 mmap 只读挂载 + 内存 overlay 追加模式。
- 职责：D1 级别（无 AI 模型）的路径/大小/文件名与相似图搜索的唯一索引来源。
- 边界：不保存用户标签/分类，不保存 embedding；删除/替换路径以 tombstone + replaced 集合处理。

### 2. Embedding JSONL 分片（embedding 最终权威）

- `embeddingF16Cache.ts` 读取侧的注释与回退逻辑明确：source JSONL 是权威，F16 缓存、generation、increment 全部可由其重建。
- 追加写；读侧容忍 "JSONL ahead of increment" 的快照（返回最后完整缓存 + 合并新增 JSONL 行）。
- 任何派生存储（F16 缓存、generation、delta）损坏或过期都回退到扫描 JSONL。

### 3. 权威向量库（authoritativeVectorStore）

- 结构：`CURRENT`（generation 名 + manifestSha256）→ `generations/<gen>/manifest.json`（version 2）→ `vectors.f16`（f16-le）+ `paths`，每文件带 sha256。
- 读入 fail-closed：CURRENT 校验 manifest 哈希、manifest 校验条目哈希，任一失败返回 null（回退 JSONL），不使用损坏数据。
- 导入来源锚定：每个 entry 记录 imports（path/size/mtime/tailSha256/可选 chunkIntegrity），源文件变化即失效。

### 4. Embedding 增量日志（embeddingIncrementLog）

- 写序固定：先 JSONL 行 → delta 段 → `delta.json` 提交点（tmp + rename 原子切换，与 CURRENT 同一原语）。
- `delta.json` 是**从属**提交点，锚定在 CURRENT 引用的 generation 上；JSONL 分片保持权威。
- 校验失败（含 version 2 旧提交、缺少内容证明）丢弃整个 increment 目录，降级为 JSONL-only 追加。

### 5. 素材记录 JSONL（assets.jsonl）与 Asset Catalog 投影

- `AssetMetadataStore` 持有内存记录表，`assets.jsonl` 为权威持久化；维护 `nextId`、missing/archived 状态、与 image-search manifest 的同步指纹。
- `asset-catalog.sqlite` 是其投影：`isFresh(sourceFingerprint, expectedCount)` 不通过即 `replaceAll` 全量重建；更新失败重建失败仅告警，不影响 JSONL 权威。
- 结论：catalog SQLite 可以随时删除，不丢失任何用户数据。

### 6. Asset Library SQLite（用户整理数据权威）

- 表：categories / tags / asset_categories / asset_tags / category_references / suggestions / library_meta / schema_migrations。
- 记录 `migrated_from_jsonl` 元数据，表示已从旧 JSONL 存储迁移；这是标签、分类、建议、确认状态的唯一权威。
- 清理 UI 规则（方案 13.3）：删除模型/向量/缓存不得触碰本库。

### 7. 可重建缓存层

- 缩略图：native sidecar 队列生成，仅 JPEG 源；删除不影响索引与用户数据。
- ANN：向量 ANN 派生于权威向量库/JSONL，可重建。
- F16 embedding 缓存：JSONL 的物化视图，可重建。

## 冻结结论（Phase 0 → Phase 1 输入）

1. **两级权威**：文件发现与 hash 的权威是 native manifest/segments；embedding 的权威是 JSONL 分片；用户整理数据的权威是 `asset-library.sqlite`；素材身份记录的权威是 `assets.jsonl`。
2. **一切 SQLite catalog、F16、generation、delta、ANN、缩略图都是可重建派生物**，不得作为唯一数据源。
3. Phase 1 的统一 Discovery Catalog 必须以投影身份接入，不得反向改写上述权威；`FileEntry` 的稳定身份在 Phase 2 之前以 native manifest 路径键 + `assets.jsonl` 的 id 为准。
4. USN 状态文件（`usn-state.json`）是增量扫描游标，丢失只导致全量重扫，不属于权威数据。
