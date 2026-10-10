# NAS 技术主链实施跟踪（2026-08-11）

> 状态：部分实施
> 实施状态：进行中
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md`
> 顺序决策：先做 Phase 0-6 技术主链；商业化事项（Phase 7）后置，完成前安装包仅为内部候选。

## 阶段状态

| 阶段    | 内容                                               | 状态                    | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 | 冻结边界与真实基准（10万/100万文件）               | verified                | 报告 `docs/current/2026-08-11-phase0-baseline-report.md`（含第 7 节复验记录）；原始数据 `benchmarks/phase0-baseline-2026-08-11.json`（10万档复跑：枚举 1869.8ms、首次路径 71.3ms、full 17.6s、缩略图 5.43ms/张、搜索 0.19ms/查询、embedding digest 复现一致）+ `benchmarks/phase0-baseline-1m-2026-08-11.json`（100万档：枚举 12.9s、full 197.5s）；USN 档降级（需管理员）；边界图 `docs/reference/2026-08-11-storage-authority-boundaries.md`；复现命令 `npm run benchmark:phase0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase 1 | 统一数据源 + Discovery Catalog                     | verified                | 提交 b85108c（契约+适配器+目录+IPC）、3ed750e（UI 来源视图）、891d8dc（文档）；父代理复验：`npm run test:discovery-catalog` 8 项全过（验收四条各有对应测试）、`test:architecture`/`test:ipc-validation`/`test:preload-contract` 全绿；契约 `shared/ipc/discovery-catalog.ts`，库 `electron/discoveryCatalogDatabase.ts`（独立 discovery-catalog.sqlite，幂等 upsert），适配器 `electron/sourceAdapter.ts`；设计补充 `docs/current/2026-08-11-phase1-unified-source-catalog.md`（含遗留缺口：native 仅枚举图片、FRN 身份留 Phase 2、独立来源面板留 Phase 6）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase 2 | 稳定素材身份（AssetId/AssetMember）                | verified                | 提交 0d7689c；父代理复验：`test:asset-identity` 8/8、`test:discovery-catalog` 8/8、`test:asset-library` 全绿、`test:architecture` 通过；契约 `shared/ipc/asset-identity.ts`，解析 `electron/assetIdentityResolver.ts`（卷/FRN 优先、路径回退），映射存储 `electron/assetIdentityStore.ts`（asset-identities.jsonl，纳入备份），服务 `electron/assetIdentityService.ts`（含 shadow 报告与移动修复），统一文件动作 `electron/fileActionService.ts` + `assetIdentityIpc.ts`；`assetMetadataStore.repathAsset`（id 不变重指向）、`discoveryCatalogDatabase` 按 filesystem_identity 重指向；`npm run test:asset-identity` 8 项全过（验收四条各有对应测试），`test:architecture`/`typecheck`/`test:discovery-catalog`/`test:asset-library`(130)/`test:asset-library-sqlite`(19)/IPC 三门禁全绿；设计补充 `docs/current/2026-08-11-phase2-stable-asset-identity.md`（含 7.4 建议表与边界图的取舍说明；遗留缺口：渲染层动作入口未接线、manifest/向量路径修复留 Phase 3、FRN 批量回填依赖 native 上报） |
| Phase 3 | 分阶段索引 + 统一 AI 搜索                          | in_progress             | 2026-08-12 检查点：D1、D3/D4（含 legacy 单次读取复合扫描）、D5、D6 与 CLIP/主体 P0 查询均已进入统一调度器；legacy 扫描以 queued 预约后持有 local 车道至工程预览和 manifest 落盘，D5 持有 GPU 车道至真实子进程终态。文本语义、参考图主体、显式主体矩形选区和资源库 exact/near 重复组已接入统一结果。`test:unified-search` 37/37、media 36/36、subject 40/40、image-search data 63/63、embedding/vector 定向回归 73/73，typecheck/lint/full build/architecture/IPC 全绿；隔离 Electron 冒烟 7 面板、0 崩溃、0 console error。vector pipeline 最近完整基线为 219 pass/2 skip（本轮全量复跑 240 秒超时，不计作新通过）。仍缺真实 Electron 专项点击与真实库召回验收，故不标 verified。详见 `docs/current/2026-08-11-phase3-staged-index-unified-search.md`。                                                                                                                                                                                                                                        |
| Phase 4 | 挂载网络盘与 SFTP adapter（含 NAS 离线、按需预览） | implementation_complete | 2026-08-12：`mounted-network` 与 SFTP metadata-only adapter 已接入 Sources/Catalog，均默认只读并使用独立远程预算。搜索结果可经一次性 action token 和 Transfer Queue 安全取回；前 12 个可见 SFTP 图片进入有界按需 WebP 预览链路，Catalog 持久化 D3 ready/stale，UI 明确区分预览和 AI 索引深度。mounted-network 可在抽样身份核验后原位修复重挂载根路径并保留 source/file ID。`test:discovery-catalog` 38/38、remote transfer 4/4、IPC 7/7、preload 2/2，typecheck/lint/format/architecture/i18n 和 Electron 冒烟全绿。代码与受控自动化已完成；仍需用户提供可控 NAS/SFTP 与测试凭据完成真实连接、断线、权限和吞吐验收，之前不得标记 verified。详见 `docs/current/2026-08-12-phase4-mounted-network-sources.md`。                                                                                                                                                                                                                                                                                  |
| Phase 5 | 统一视频搜索结果                                   | implementation_complete | 2026-08-12：Media Search 扫描后批量建立稳定 AssetId，并把已注册本地/mounted-network 来源的视频投影到 Discovery Catalog，重复投影保留 fileEntryId。统一搜索新增 video-frame/subtitle lane，同一视频的画面与字幕命中聚合回权威原视频和最多 8 个时间点；结果显示路径、来源、大小、时长，并只用既有 videoId 动作打开。前 12 个视频结果按 `frameId` 受控加载代表帧，主进程从权威 manifest 反查并沿用缓存边界、链接逃逸和大小防护，不向 Renderer 暴露缓存路径。来源策略持久化到 video manifest：本地保持高召回抽帧，mounted-network 使用 15 秒/240 帧/256px、单视频批量且单并发策略；SFTP 不隐式下载原视频并明确显示需受控取回。清理派生数据不删除原视频或稳定身份。`test:unified-search` 47/47、media 36/36、identity 9/9、i18n 7/7，typecheck/lint/format 全绿。本地实现已完成；仍需真实视频集记录召回、时间误差和空间基准后才能标 verified，精确 seek 播放器列为后续增强。详见 `docs/current/2026-08-12-phase5-unified-video-search.md`。                                                         |
| Phase 6 | 产品界面收敛与安装包技术优化（内部候选）           | in_progress             | 2026-08-12：主界面新增“搜索、来源、素材库、整理、任务、设置”六域工作台导航，用户可直接进入统一 Sources、搜索/建库、素材整理和统一调度摘要，不再依赖 Image/Media/Neko 内部模块名。Remote Terminal 已归入“来源 → 远程来源高级工具”，设置页同步独立分组；稳定面板 ID 和数据/配置键不变。Electron smoke 新增真实点击检查，六域、来源定位、任务摘要和远程工具置顶均通过；7 个核心面板、0 崩溃、0 console error。既有 Online/Offline profile、按需模型、资源清单和 release gate 已审计确认复用；相关测试 77/77，设置/备份/迁移/清理组合 43/43。NSIS 两个 profile 显式保留用户数据，升级、回滚、导出、清理和卸载说明已落盘。仍需自动更新的更新源/通道/签名决策及新安装包 packaged 双语验收，故保持 in_progress。详见 `docs/current/2026-08-12-phase6-product-delivery.md`。                                                                                                                                                                                                                           |

## Phase 0 范围（来自方案第 14 节）

1. 技术范围已获用户批准（2026-08-11，技术主链先行，商业化后置）。
2. 对本机可用环境（NTFS SSD；HDD/移动盘/挂载 NAS 如可用）建立真实基准。
3. 固定 10 万/100 万文件合成结构和至少一组脱敏真实素材集。
4. 记录首次路径/大小出现、全量发现、缩略图、hash、embedding 和搜索延迟。
5. 交付可复现 benchmark 命令和原始报告。
6. 明确当前 manifest、SQLite、向量和缓存的权威边界图。

## Phase 1 范围（来自方案第 6、14 节）

1. 新增 `DataSource`、`FileEntry`、`ScanSession` 和 `IndexState` 契约。
2. 以适配器封装当前 Native 本地扫描。
3. 将发现批次投影到统一 Discovery Catalog。
4. UI 首屏显示来源、路径、大小和扫描阶段。

验收：AI 模型未下载时仍可完成路径、大小和文件名搜索；扫描中可查询已提交批次；USN 不可用时显示回退原因且结果完整性与目录枚举基线一致；取消、重启和重复扫描不产生重复 `FileEntry`。

## Phase 2 范围（来自方案第 7、14 节）

1. 为 Image Search 和 Asset Library 建立稳定 `AssetId` 映射。
2. 保留现有索引文件，以 shadow projection 验证统一目录结果。
3. 引入 `AssetMember`，支持工程预览、RAW companion 和 sidecar。
4. 统一打开、定位和原文件拖出动作。

验收：搜索、素材库和重复组对同一文件返回同一稳定 ID；预览代理永远不会被当成用户可见原文件；文件移动后标签、分类和索引可按身份修复；备份恢复覆盖新增 ID 映射。

## Phase 3 范围（来自方案第 8、9、14 节）

1. 接入统一任务调度和优先级。
2. 合并元数据、文件名、图片语义、主体和重复召回结果。
3. 为结果增加 `indexState` 和退化原因。
4. 可见区域优先生成预览和 embedding。

验收：D1 不被 GPU/视频任务阻塞；AI 未完成时先返回元数据结果，完成后可增量增强排序；向量损坏、模型缺失和任务失败均有可操作状态，不返回误导性空结果；现有准确率门禁和索引完整性测试不下降。

## LAP 对标优化切片（2026-08-12）

- [x] 智能相册第一版：保存并恢复 Asset Library 的查询、分类、标签、未分类、移除状态和排序条件。
- [x] 智能相册持久化、IPC 边界、中文/英文界面、资产库备份恢复覆盖和自动化测试。
- [x] Electron 真实点击验收智能相册创建、切换、更新和删除；`smartAlbumCrud: true`，0 崩溃、0 console error。
- [x] 跨图片、视频、NAS/SFTP 的稳定 AssetId 素材收集篮：命名集合、幂等收集、跨来源动作、备份恢复与自动化验收。
- [x] 智能相册规则第二阶段 A：来源、媒体类型和修改日期范围。
- [x] 评分与收藏权威元数据、批量操作及智能相册规则；原子持久化、SQLite Catalog、备份和 Electron smoke 均已覆盖。
- [x] 素材收集篮重命名、手动排序、原子批量加入和统一搜索结果拖放加入。
- [x] Asset Library 批量所选、Media Search 视频/帧结果均已提供统一收集入口，并复用稳定 AssetId。
- [x] 独立一级统一搜索页面支持打开、定位、收集和短期授权远端下载动作。
- [x] SAM 精细主体蒙版通过短期、发送者绑定能力安全接入统一搜索，Renderer 不接触蒙版缓存路径。
- [ ] 下一切片：移动修复失败后提供受控的一键重建派生索引动作。

## 工作约束

- 禁止直接在 main 提交；分支 → 验证 → ff-only 合入。
- 提交信息必须符合 hook 格式（type(scope): summary + 正文 + Executor-System/Executor-Model/Task/Validation 四行 trailer）。
- 真实用户数据只读；基准使用合成语料或脱敏素材。
- 现有 benchmark 脚本优先复用：`benchmark:native*`、`benchmark:image-search-simple*`、`benchmark:asset-catalog`、`benchmark:media-search*`。
