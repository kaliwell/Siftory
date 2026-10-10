# 按盘符或文件夹清理图片/视频派生数据

> 状态：部分实施  
> 更新日期：2026-08-24  
> 范围：Settings、Image Search、Media Search、向量与视频语义数据  
> 执行系统：Codex  
> 替代文档：无

## 当前结论

应用已提供正式的按来源清理入口：`Settings → Data & Reset → Delete generated data by source`。用户可以选择一个在线盘符根目录或普通文件夹，先预览，再删除该范围内图片和视频文件产生的索引、模型向量及其他派生数据。

2026-08-23 18:47，用户在真实来源 `D:\dataset\images` 上执行删除后的只读复检发现：Native、DINO/CLIP、诊断与拒绝缓存、缩略图和视频派生层均已无目标记录，原始素材未被删除或改写；但是 `subject-embeddings/embeddings.jsonl` 仍保留 17 条 `crop:subject` 向量。该结论是整改前的真实数据证据，继续保留，不能因代码测试通过而改写为已删除。

2026-08-24 已完成工程整改：主体裁剪、人脸和行人 ReID 共用的独立主体向量缓存已接入来源预览、原子事务和内存失效；历史自动化轨迹采用“默认保留、显式选择后仅清理固定白名单”的策略。隔离夹具回归通过，但尚未在新实现上再次执行真实来源删除，所以真实数据验收仍待 `SRC-008` 完成。

该入口不删除来源目录中的原始图片和视频，也不删除已安装模型、设置或人工维护的素材库分类/标签。图片和视频帧共用的 DINO/CLIP JSONL 分片只移除命中来源的记录；混合多个来源的二进制 generation/ANN 等共享可重建缓存整体失效并删除，其他来源保留的权威向量记录用于后续重建。

## 用户流程

1. 在设置页选择盘符，或用系统文件夹选择器选择目录。
2. 点击 `Analyze generated data`，核对分类、记录数、文件数和预计可释放空间。
3. 确认界面显示 `Original files affected: 0`，再点击 `Confirm delete generated data`。
4. 查看成功结果或错误；如果预览超过 15 分钟、数据已变化或任务仍在运行，应重新分析。

## 删除与保留范围

| 数据域   | 删除内容                                                                                         | 保留内容                                       |
| -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 图片搜索 | Native 范围索引、DINO/CLIP 命中行、精确可定位的缩略图、项目预览及旧向量记录                      | 原图、其他来源的权威向量行                     |
| 视频搜索 | 视频/帧 manifest 行、抽帧与缩略图、帧向量、转写、OCR、音频 staging、说话人状态、任务检查点       | 原视频、其他来源的视频与帧记录                 |
| 视频语义 | 所选 video ID 对应的 generation、segment、event、person、job 和 preference 行                    | 其他 video ID 的 SQLite 记录                   |
| 共享缓存 | 受影响模型的 F16/ANN 缓存、帧索引缓存、统计缓存和旧二进制 vector-store generation                | 模型文件、源 JSONL 中其他来源的有效记录        |
| 主体检索 | `subject-embeddings` 中命中来源的 crop/face/osnet 向量和 negative marker，原子提交后失效内存缓存 | 其他来源主体向量与原始图片                     |
| 审计轨迹 | 仅在显式选择时结构化过滤固定白名单中的来源字段或匹配行                                           | 默认保留审计轨迹；普通日志始终不在扫描范围     |
| 素材库   | 无                                                                                               | 人工分类、标签、集合、反馈、备份与稳定素材身份 |

统计中 SQLite 页和共享缓存不能精确按单个来源拆分时，界面标记为估算值；最终结果按实际删除文件报告释放空间。

## 安全与一致性设计

- 使用 15 分钟、单次消费的随机预览 token；不存在、过期或重放的 token 均拒绝。
- 来源必须当前存在，且是普通目录或盘符根目录；拒绝符号链接、空路径、控制字符和超长输入。
- 专用入口显式允许盘符根目录；既有 Image Search 文件夹索引编辑入口仍默认拒绝文件系统根目录。
- 预览保存 JSONL/JSON 文件的大小和修改时间；执行前再次比对，避免分析后数据变化造成错删。
- 扫描、抽帧、Embedding、向量维护或其他冲突任务运行时关闭式拒绝；持久化视频/音频任务也会再次检查。
- 图片和视频帧共享的 DINO/CLIP 分片只执行一次流式原子重写；单行限制 32 MiB，并在切换前检查临时空间。
- 事务失败时回滚已切换的 JSONL/JSON；成功后清除事务备份，避免被删除的向量在备份中残留。
- 只依据规范化来源路径、视频 ID 和受管目录建立关联。缩略图文件名是单向哈希，因此预览会受限遍历来源目录中的文件名与 mtime 来重建缓存键；不读取文件内容、不跟随链接，也不改写原始素材。
- Native 来源删除会在逻辑删除持久化后强制执行物理压实；单段加 tombstone 也会生成干净的新段，释放旧 mmap 句柄后再删除旧 `.idx`，并验证来源计数、overlay、replaced/deleted 均为零。
- 没有任何视频 ID 命中时，视频共享帧向量、统计和转写缓存不计入预览，也不会删除。
- `embedding_failures.jsonl`、`embedding_diagnostics.jsonl` 及其保留备份和输入拒绝缓存按 `imageId`/路径边界原子过滤，其他来源记录保留。
- `subject-embeddings` 复用相同的来源边界规则，在事务写入期间阻塞并刷新持久层，提交后按键同步清除内存中的 crop/face/osnet 向量和 negative marker。
- 历史任务轨迹默认保留；显式 `remove-source-traces` 只允许处理固定受管白名单，JSON 结构化脱敏、日志逐行过滤，禁止目录级泛化删除。

## 关键实现入口

- `electron/sourceDerivedDataCleanupService.ts`：范围预览、token、指纹、事务和图片/视频级联编排。
- `electron/vectorIpc.ts`：IPC 注册、任务互斥、Native/缩略图/项目预览/旧向量清理与运行时缓存失效。
- `electron/imageSearchFolderDataService.ts`：多路径共享向量分片预览与单次原子重写。
- `electron/thumbnailDiskCache.ts`：按来源路径、mtime、版本和尺寸桶精确反查缩略图缓存，包括未进入 Native 快照的失败图片。
- `electron/subjectEmbeddingStore.ts`：主体裁剪、人脸和行人 ReID 的独立追加式向量缓存，提供来源预览、原子过滤、写入协调和内存缓存失效。
- `native/fast_scanner.cc`：释放异步保存遗留的 mmap/文件句柄，支持单段 tombstone 压实和旧段删除结果报告。
- `electron/videoSemanticDatabase.ts`：按 video ID 预览并级联删除视频语义记录。
- `src/components/SourceDerivedDataCleanup.tsx`：盘符/文件夹选择、预览、确认、进度与结果界面。

## 真实数据复检

本节只记录 2026-08-23 用户主动执行删除后的只读结果。Codex 没有再次触发删除，也没有写入真实来源或用户索引。

| 数据层          | 只读证据                                                               | 结果                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 原始素材        | Node 递归枚举文件数量、大小和 mtime                                    | 通过：58,000 JPG + 58,000 JSON，共 116,000 个文件、197,716,121,594 bytes；清理时段新增或改写 0 个                                      |
| Native 逻辑状态 | `loadManifestAsync` + `getIndexPathStats('D:\\dataset\\images')` | 通过：目标 0 条、0 bytes；索引为 v4 `segment_mmap`、1 个活动段、208,413 条其他来源记录、overlay/replaced/deleted 均为 0、path map 健康 |
| Native 物理状态 | 对 `image-search-index` 全目录执行大小写不敏感字节扫描                 | 通过：活动段、旧段、目录和失败路径文件中目标路径命中 0                                                                                 |
| 向量与诊断      | 对完整 `vector-db` 执行 `rg -a -i --count-matches dataset`       | 通过：两份 DINO/CLIP 主分片合计 10,598,447,876 bytes，连同颜色/形状特征、诊断、失败、拒绝、备份和召回缓存均命中 0                      |
| 缩略图          | `previewThumbnailCacheForFolder(..., 'D:\\dataset\\images', [])` | 通过：扫描 58,000 张源图，匹配缓存 0 个、0 bytes，`complete=true`、无警告                                                              |
| 视频派生数据    | 源目录视频扩展名枚举 + `media-search` 全目录字节扫描                   | 通过：源视频 0 个，媒体派生目录目标路径命中 0；其他来源的媒体数据保持不变                                                              |
| 事务与任务      | 清理临时/备份命名扫描 + 进程检查                                       | 通过：无本次清理事务残留，无后台扫描或向量重建任务                                                                                     |
| 主体向量        | 解析 `subject-embeddings/embeddings.jsonl` 的命中行，不读取源图片      | **失败：仍有 17 条 `crop:subject` 记录，约 277,700 bytes**                                                                             |

另外发现 4 个 `value-automation` 历史重建日志/状态文件仍含 251 行来源路径文本，共 36,459 bytes。它们不参与当前检索和模型推理，不属于现有界面统计口径；若验收目标是“不保留任何来源痕迹”，仍需制定受管日志保留与删除策略。素材库及其备份中的来源引用属于界面明确承诺保留的人工元数据，不计为清理失败。

## 自动化验证

| 项目                   | 命令                                                 | 结果                                                                                        |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 范围隔离与原文件保护   | `npm.cmd run test:source-derived-cleanup`            | 通过：69/69；覆盖主体向量、审计轨迹白名单、历史 overlay、零视频、缓存字节、诊断与孤立缩略图 |
| 主体向量存储           | `node --test tests/subject-embedding-store.test.cjs` | 通过：5/5；覆盖持久化、来源过滤和缓存一致性                                                 |
| Native 物理压实        | `node --test tests/native-segment-v3.test.cjs`       | 通过：8/8；单段 tombstone 后 overlay 消失、旧路径字节消失且段目录只保留新段                 |
| 视频语义级联           | `node --test tests/video-semantic-database.test.cjs` | 通过                                                                                        |
| Media Search 全回归    | `npm.cmd run test:media-search`                      | 通过：217/217                                                                               |
| 图片文件夹编辑回归     | `npm.cmd run test:image-search-data-folders`         | 通过：新增最后 mmap 段物理退休回归；完整结果以本轮自动门禁报告为准                          |
| 设置页回归             | `npm.cmd run test:settings`                          | 通过：64/64                                                                                 |
| IPC 权限与注册         | `npm.cmd run test:ipc-registration`                  | 通过：7/7                                                                                   |
| Preload 契约           | `npm.cmd run test:preload-contract`                  | 通过：2/2                                                                                   |
| 国际化静态检查         | `npm.cmd run test:i18n-static`                       | 通过：7/7                                                                                   |
| TypeScript             | `npm.cmd run typecheck`                              | 通过                                                                                        |
| Renderer/Electron 构建 | `npm.cmd run build:renderer`                         | 通过；保留既有 chunk 大小和动态/静态导入提示                                                |
| 文档结构与相对链接     | `npm.cmd run docs:check`                             | 通过                                                                                        |
| 文档规范回归           | `node --test tests/documentation-standard.test.cjs`  | 通过：3/3                                                                                   |
| Markdown 格式          | `npx.cmd prettier --check <本次 4 个目标文档>`       | 通过                                                                                        |

上述自动删除测试只使用系统临时目录中的隔离夹具。真实 D 盘部分仅保留用户此前主动删除后的只读盘点证据；本轮没有读取图片内容或再次执行真实删除。当前结论属于未提交工作区；正式发行仍需完成真实只读复验，并以干净提交和安装包实测为准。

## 未完成项与验收标准

1. 由用户在包含 2026-08-24 整改的新构建中重新执行一次真实来源删除；是否清理受管审计轨迹必须由用户显式选择，默认保留。
2. 删除后再做只读复验。验收必须同时满足：原始素材数量/mtime 不变；Native、DINO/CLIP、主体向量、诊断、拒绝、缩略图和视频派生记录均为 0；无事务残留；素材库保留项不变。

## 已知边界

- 离线或已卸载盘符当前不能作为范围执行，因为执行阶段需要再次验证同一来源仍然存在。
- 缩略图仅在缓存键能由来源文件路径和 mtime 精确复现时删除；超过 200 万文件或 50 万目录的安全上限、无法读取的目录及链接目标会保留并给出警告。其他无法证明归属的历史孤立文件继续由全局 App Storage 清理和向量 GC 管理。
- 受管审计轨迹默认保留，因此未选择 `remove-source-traces` 时出现路径痕迹属于设计结果，不等同于检索/模型派生数据仍在；普通日志不属于可选清理范围。
- 删除共享可重建缓存后，其他来源的第一次搜索或维护任务可能触发重建；其权威记录和原始素材不受影响。
- 操作不提供撤销。成功事务不保留包含已删除向量的恢复副本，重要元数据应在执行前单独备份。
