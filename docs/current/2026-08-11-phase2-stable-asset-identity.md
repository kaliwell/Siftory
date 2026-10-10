# Phase 2 稳定素材身份实施说明（2026-08-11）

> 状态：部分实施
> 实施状态：进行中，待复验
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md`（第 7.1–7.4、9.3、14 节 Phase 2）
> 权威边界：`docs/reference/2026-08-11-storage-authority-boundaries.md`
> 分支：`feat/phase2-stable-asset-identity`

## 交付物

| 层 | 文件 | 职责 |
| --- | --- | --- |
| shared | `shared/ipc/asset-identity.ts` | `AssetIdStrategy`、`AssetMemberRole`（original/preview-proxy/raw-companion/sidecar）、`AssetMember`、`AssetIdentity`、shadow 报告与文件动作 DTO、`ASSET_IDENTITY_IPC` 通道 |
| electron | `electron/assetIdentityResolver.ts` | 纯函数身份解析（方案 7.2 策略阶梯）、成员角色分类、user-visible 过滤 |
| electron | `electron/assetIdentityStore.ts` | `asset-identities.jsonl`（素材库目录内）稳定 ID ↔ 身份键 ↔ 路径 + 成员映射持久化 |
| electron | `electron/assetIdentityService.ts` | 主进程身份解析服务：`resolveForPath`、`repairMovedFile`、`buildShadowReport`；进程级单例 `getAssetIdentityService` |
| electron | `electron/fileActionService.ts` | 统一打开/定位：AssetId → original 成员 → pathGuards 校验后执行；preview-proxy 永不作为原文件 |
| electron | `electron/assetIdentityIpc.ts` + preload/`electron-api.ts` | `catalog:identity/resolve|shadowReport|repair`、`catalog:fileActions/open|reveal`（复用已声明的 `catalog` 域能力推导） |
| electron | `electron/discoveryCatalogDatabase.ts` | 新增 `filesystem_identity` 索引与 `findFileEntryByFilesystemIdentity`/`repathFileEntryByIdentity`（移动修复，不产生重复 FileEntry） |
| electron | `electron/assetMetadataStore.ts` | 新增 `repathAsset`：同卷移动后按身份重指向记录路径，asset id 不变 |
| electron | `electron/assetLibraryBackup.ts` | `asset-identities.jsonl` 纳入备份/恢复托管名单 |
| tests | `tests/asset-identity.test.cjs`（`npm run test:asset-identity`，已接入总 `test` 串） | 见下「验收映射」 |

## 关键决策

1. **AssetId 稳定策略（方案 7.2）**：优先 `fs:<卷序列号>:<文件索引/FRN>`（Node 在 Windows/NTFS 的 stat `dev`/`ino`，同卷重命名不变，已实测）；不可用时回退 `path:<规范化路径>`（Phase 1 路径策略）。AssetId = `asset_` + sha256(identityKey) 前 24 位十六进制，确定性生成。内容 hash 只用于内容确认/重复合并，不参与身份（方案 7.2 规则 4）。
2. **权威边界取舍（相对方案 7.4 建议表）**：方案 7.4 建议在统一目录中建 `assets`/`asset_members` 表。按边界图，素材身份记录权威是 assets.jsonl，本文不新建资产权威表：稳定 ID 映射与成员关系落在素材库目录的 `asset-identities.jsonl`（assets.jsonl 的既定迁移路径旁产物），可由文件系统身份重解析全量重建，并纳入备份；`discovery-catalog.sqlite` 只加 `filesystem_identity` 索引与按身份重指向方法，不篡夺 assets.jsonl 权威。assets.jsonl 的数字 `id` 仍是标签/分类的外键。
3. **AssetMember 规则**：`classifyMemberRole` 按路径分类——工程预览缓存目录内一律 `preview-proxy`；`.xmp/.aae/.pp3/.dop/.cos/.on1` 为 `sidecar`；RAW 扩展名且同目录有同干名原图时为 `raw-companion`；否则 `original`。`userVisibleMembers` 只放行 `original`；preview-proxy 不进入身份映射、文件动作拒绝以原文件身份打开/定位它。
4. **Shadow projection**：`buildShadowReport(素材库记录)` 对比统一身份映射与现有 asset-catalog 投影（assets.jsonl 读出侧），产出 matched / onlyInLibrary（未解析）/ onlyInUnified（库中无记录）及原因；只读，不替换现有读取路径。
5. **统一文件动作**：`fileActionService` 先解析 AssetId → original 成员路径，再走既有 `pathGuards`（UNC 执行禁令等不变）；IPC 通道挂 `catalog:` 域（能力矩阵已声明，open/reveal 自动推导 EXT）。渲染层接线到各面板入口留作后续（见缺口 2）。
6. **移动修复**：同卷移动后 `repairMovedFile` 按 filesystem identity 找回 AssetId 并重指向映射；`repathAsset` 保持 assets.jsonl 记录 id 不变更新路径（标签/分类按 id 随行）；`repathFileEntryByIdentity` 更新发现目录行不产生重复。

## 验收映射

| 验收标准 | 证据 |
| --- | --- |
| 搜索、素材库和重复组对同一文件返回同一稳定 ID | `tests/asset-identity.test.cjs`「stable id: search, asset library and duplicate groups resolve the same file to one AssetId」（三入口同一解析器同一 AssetId，重复解析不产生重复映射）+「filesystem identity (volume/FRN) is preferred and survives a same-volume rename」 |
| 预览代理永远不会被当成用户可见原文件 | 「preview proxies are never user-visible originals」（角色分类、userVisibleMembers 过滤、代理不入映射、文件动作拒绝打开代理）+「asset members cover original, raw companion and sidecar」 |
| 文件移动后标签、分类和索引可以按身份修复 | 「same-volume move repairs identity, asset record and catalog index」（真实 NTFS 重命名：AssetId 不变、记录 id 不变路径重指向、目录行按身份重指向无重复） |
| 备份恢复覆盖新增 ID 映射 | 「backup and restore cover the asset identity mapping」（备份含 asset-identities.jsonl → 删除 → 恢复 → 映射仍可解析同一 AssetId） |

另：「unified file actions resolve AssetId to the original before shell execution」覆盖统一打开/定位（假 shell 验证只在解析为 original 后才调用）。

## 验证记录

- `npm run test:asset-identity`：8 项全过（2026-08-11）。
- `npm run test:architecture`（layering + build-graph）：通过。
- `npm run typecheck`：通过。
- `npm run test:discovery-catalog`：8 项全过（防回归）。
- `npm run test:asset-library`（130 项）、`npm run test:asset-library-sqlite`（19 项）：全过（防回归）。
- `npm run test:ipc-validation`、`test:ipc-registration`、`test:preload-contract`：通过（新通道经既有 `catalog` 域能力推导与 preload 镜像门禁）。

## 剩余缺口

1. 渲染层接线：素材库/搜索面板的现有打开/定位/拖出入口尚未改走 `assetIdentity.*` API（拖出 drag-out 的 AssetId 化也未接）；当前只到 IPC 层。
2. 移动修复目前覆盖身份映射 + assets.jsonl + discovery catalog；asset-library.sqlite 的标签/分类按 id 自动随行已论证但未做端到端 UI 验证；image-search manifest/向量索引的路径键修复（reconcile）留 Phase 3。
3. Shadow projection 报告尚无 UI 出口与定时运行机制；一致率指标未接入遥测。
4. SFTP/挂载网络源的身份策略（方案 7.2 第 3 条）随 Phase 4 适配器落地。
5. `filesystem_identity` 的批量回填：native 扫描器目前不上报 FRN，发现目录行的 filesystem_identity 多数仍为空，移动修复依赖身份服务按 stat 解析。
