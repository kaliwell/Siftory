# Image Search 审计进度 - 2026-06-29

## 本轮目标

自动逐步优化、验证、修复 Image Search 当前功能中的结构问题、逻辑问题、安全问题、死代码和大数据量稳定性风险。

## 已完成修复

1. 大数据稳定性
   - `imageSearchService` 扫描完成后不再自动调用旧的 `seedEmbeddingJobs()`。
   - 避免 Build 前把 5GB+ `image_embeddings.jsonl` 全量读入内存。
   - `embeddingService.seedEmbeddingJobs()` 增加大文件保护：embedding store 超过 512MB 时跳过旧 job seeding，并写入诊断日志。

2. 模型状态拆分
   - 前端不再用一个 `modelStatus` 同时代表 DINO 和 CLIP。
   - Image Search 面板分别显示 DINO / CLIP 状态。
   - DINO 与 CLIP 下载按钮、构建按钮按各自模型状态启用。

3. IPC 和路径安全
   - 模型名增加白名单，只允许 `dinov2_vitb14` 与 `clip_vit_base_patch32`。
   - `startEmbeddingBuild` 对 `scanPaths` 做目录存在性、目录类型、去重和数量上限校验。
   - `searchLayered` 对查询图片路径做 `safeShellPath` 与 `fs.statSync().isFile()` 校验。
   - 非法或不存在的图片路径会返回 degraded response，不再直接进入搜索流程。

4. Rerank 可诊断性
   - 清理 `rerankService` 中未使用类型和变量。
   - overlay 过滤掉的丢失文件数量写入 `degradationReasons`，便于排查“结果少”的情况。

5. 死代码清理
   - 删除旧 `electron/embeddingWorker.ts` worker-thread 路径。
   - 当前 embedding 构建只保留 `clipEmbeddingChild.ts` 与 `dinoEmbeddingChild.ts` 子进程隔离方案。
   - `vite.config.mjs` 删除旧 `embeddingWorker.ts` 构建入口。
   - `package.json` 删除旧 `embeddingWorker.js` extraResources 配置。
   - 删除 stale `dist-electron/embeddingWorker.js`，避免旧产物被 `dist-electron/**/*` 打入 asar。

## 验证结果

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过，无 error，剩余 warning 为既有 `any`/未使用项告警。
- `npm.cmd run test:guards`：通过。
- `npm.cmd run test:ipc-validation`：通过。
- `npm.cmd run test:vector-pipeline`：通过。
- `npm.cmd run build`：通过，已重新生成 `release/win-unpacked` 和安装包。
- `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

## 当前剩余风险

1. `image_embeddings.jsonl` 已达到 GB 级，append-only 方案优先保证稳定，但长期应迁移到按模型分文件、SQLite 或二进制向量库。
2. CLIP Semantic 已有二进制 cache；DINO/通用 embedding 仍需要继续做分模型存储、压缩和 compaction。
3. lint 仍有大量 warning，主要是历史 `any` 类型和未使用变量，不影响本轮构建，但后续应分模块清理。

## 第二轮优化 - 2026-06-30

### 目标

继续降低 GB 级 `image_embeddings.jsonl` 带来的稳定性和性能风险，先做兼容式分片落地，不强制迁移旧数据。

### 已完成

1. Embedding 分模型分片写入
   - 新增分片目录：`vector-db/embeddings/`。
   - 新生成 embedding 不再继续追加到旧总文件 `image_embeddings.jsonl`。
   - 新写入路径按模型和类型拆分，例如：
     - `vector-db/embeddings/dinov2_vitb14__global.jsonl`
     - `vector-db/embeddings/clip_vit_base_patch32__global.jsonl`
   - 旧 `image_embeddings.jsonl` 保持只读兼容，不破坏已有 DINO/CLIP 数据。

2. 兼容读取
   - `getEmbeddingStorePaths()` 会优先返回模型分片，再返回旧总文件。
   - Build Embeddings 前的 existing scan 同时扫描新分片和旧总文件，避免重复构建。
   - Build Index 和以图搜图 streaming vector search 同时读取新分片和旧总文件。
   - 小数据内存索引路径也能读取新分片。

3. Semantic CLIP 多源 cache
   - Semantic 搜索的 CLIP cache 不再只盯旧 `image_embeddings.jsonl`。
   - cache 构建源改为 `clip_vit_base_patch32__global.jsonl` + 旧总文件的组合。
   - cache 元信息记录 `sourcePaths`、合计 size、最大 mtime，用于判断是否需要重建。

4. Streaming TopK 优化
   - 旧逻辑每命中一条向量都 `sort()` 一次。
   - 新逻辑只维护 TopK 容器，超过 TopK 后替换当前最低分，扫描完成后只排序一次。
   - 对大文件全量 streaming search 更稳，CPU 开销更低。

### 已验证

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过，无 error，剩余 warning 为既有历史告警。
- `npm.cmd run test:guards`：通过。
- `npm.cmd run test:ipc-validation`：通过。
- `npm.cmd run test:vector-pipeline`：通过。
- `npm.cmd run build`：通过，已重新生成 release。
- `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

### 当前策略

1. 新数据进入分片文件，旧数据继续兼容读取。
2. 暂不自动重写 5GB+ 旧总文件，避免一次性迁移造成长时间卡顿或磁盘风险。
3. 后续可以继续做手动/后台 compaction：按模型从旧总文件流式抽取到分片，验证完成后再提示用户清理旧总文件。

## image_embeddings.jsonl Compaction - 2026-06-30

### 已执行

1. 新增脚本：
   - `scripts/compact-embeddings.cjs`
   - 功能：流式读取旧 `image_embeddings.jsonl`，按 `modelName + embeddingType + imageId` 去重并拆分到 `vector-db/embeddings/*.jsonl`。

2. 已完成实际迁移：
   - 源文件：
     `<APP_DATA>\vector-db\image_embeddings.jsonl`
   - 源文件大小：约 `5592.99 MB`
   - 扫描总行数：`423,007`
   - 有效行数：`423,007`
   - malformed 行：`0`
   - 缺关键字段行：`0`
   - 重复行：`0`

3. 拆分结果：
   - `vector-db\embeddings\dinov2_vitb14__global.jsonl`
     - 行数：`211,510`
     - 大小：约 `3338.36 MB`
   - `vector-db\embeddings\clip_vit_base_patch32__global.jsonl`
     - 行数：`211,497`
     - 大小：约 `2254.63 MB`

4. 旧总文件处理：
   - 旧 `image_embeddings.jsonl` 已改名为：
     `image_embeddings.jsonl.pre-shard-1782819895692.bak`
   - 该备份大小约 `5592.99 MB`。
   - 当前没有直接删除备份，避免迁移后立即不可恢复。

### 验证

- 分片文件行数复核通过，合计 `423,007` 行。
- 打包后的 `release\win-unpacked\FloatingClock.exe` smoke test 通过，启动 5 秒后仍在运行。

### 空间说明

- 活动 embedding 数据已从单个 5.46GB 总文件拆为两个模型分片。
- 因旧总文件仍作为 `.bak` 备份保留，所以磁盘空间暂未释放。
- 确认搜索和构建都正常后，可删除该 `.bak`，预计释放约 `5.46GB`。
