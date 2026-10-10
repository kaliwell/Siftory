# IPC 能力分级矩阵

> 状态：当前  
> 更新日期：2026-09-25

本文档用于约束 preload 暴露能力，避免 IPC 数量增长后权限边界失控。

## 分级

| 等级   | 含义                          | 要求                                               |
| ------ | ----------------------------- | -------------------------------------------------- |
| R      | 只读查询                      | 参数需做类型和大小限制                             |
| W      | 写入本地配置或缓存            | 必须限制写入位置和 payload 大小                    |
| FS     | 本地文件系统能力              | 必须走 path guard，删除优先回收站                  |
| EXT    | 打开外部程序或系统 shell 能力 | 必须走 `openSafeShellPath` / `revealSafeShellPath` |
| PROC   | 启动子进程或调用外部工具      | 必须固定可执行文件来源，禁止 shell 拼接            |
| NET    | 远程网络连接                  | 必须校验 profile、host、port 和凭据边界            |
| SECRET | 凭据读写                      | 必须使用 safeStorage 或不落盘                      |

## 当前高权限能力

| 领域            | 示例 IPC                                                                   | 等级     | 当前控制                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppCore         | `open-folder`, `open-config-dir`                                           | EXT      | 统一走 `openSafeShellPath`                                                                                                                                            |
| AppCore         | `app:openThirdPartyLicenses`                                               | R/FS/EXT | 无参数；仅打开安装 resources/legal 或开发 appPath/legal；拒绝缺失、空目录、非目录和重定向 junction，经 `openSafeShellPath` 打开；只返回固定错误码，不返回本地路径或接受许可 |
| FileManager     | `fm-open-file`, `fm-open-in-explorer`                                      | EXT      | 统一走 `openSafeShellPath` / `revealSafeShellPath`                                                                                                                    |
| FileManager     | `fm-delete-files`                                                          | FS       | `normalizePathList` + `shell.trashItem`                                                                                                                               |
| FileManager     | `fm-copy-files`, `fm-move-files`                                           | FS       | 路径规范化、数量上限、禁止复制/移动到自身                                                                                                                             |
| Thumbnail       | `fm-get-thumbnail`, `fm-get-thumbnails-batch`                              | FS       | batch 上限、文件大小上限、缓存                                                                                                                                        |
| ImageSearch     | `imageSearch:startScan`, `imageSearch:loadManifest`                        | FS       | path guard、目录校验、native scanner                                                                                                                                  |
| ImageSearch     | `imageSearch:saveIndex`                                                    | W        | 无参数；写位置由主进程状态解析（当前 segment 路径或 userData 索引根），Renderer 不可指定                                                                              |
| ImageSearch     | `imageSearch:previewFolderDataEdit`                                        | R/FS     | 绝对路径 guard、精确子树边界、只读流式 shard 扫描、15 分钟一次性令牌                                                                                                  |
| ImageSearch     | `imageSearch:executeFolderDataEdit`                                        | W/FS     | 仅接受主进程签发令牌；shard 指纹与磁盘复核、原子切换、7 天恢复备份、任务互斥，不删除源图片                                                                            |
| ImageSearch     | `imageSearch:getFolderDataEditProgress`, `cancelFolderDataEdit`            | R/W      | 无路径参数；只读进度或设置当前单任务取消标记，最终提交阶段拒绝取消                                                                                                    |
| ImageSearch     | `imageSearch:getDataOverview`, `listDataFolders`, `getDataCatalogProgress` | R        | 固定 `userData` registry；分页上限 200；只读当前已校验 SQLite generation；Renderer 不接收数据库路径                                                                   |
| ImageSearch     | `imageSearch:startDataCatalogBuild`, `cancelDataCatalogBuild`              | R/W      | 无路径参数；输入源由主进程 registry 解析；后台 worker、协作取消、源指纹复核、磁盘预检、staging 校验后原子切换；与索引/向量写任务互斥                                  |
| ImageSearch     | `imageSearch:openDataStoreLocation`                                        | EXT      | 仅接受最长 64 的固定 `storeId`；主进程白名单解析并拒绝符号链接/`userData` 越界，再走 `openSafeShellPath`                                                              |
| ImageSearch     | `imageSearch:openFile`, `imageSearch:openFolder`                           | EXT      | 统一 shell wrapper                                                                                                                                                    |
| ImageSearch     | `fileDrag:start`                                                           | EXT      | 仅接受主进程搜索结果签发的短期 token；绑定 sender/main frame、源文件 size/mtime，拖出前再次验证且只传递原文件                                                         |
| AppStorage      | `appStorage:scan`                                                          | FS/PROC  | 扫描根限制、系统命令使用 `execFile`                                                                                                                                   |
| DuplicateFinder | `duplicates:scan`, `duplicates:findLargest`                                | FS       | 参数验证、worker 隔离                                                                                                                                                 |
| BatchRename     | `batchRename:start`                                                        | FS       | 三个目录参数统一 `normalizeUserPath`（拒绝控制字符/超长路径）；仅向用户选定的 outputDir 复制文件，不删除/不移动源文件；单任务运行守卫                                 |
| BatchRename     | `batchRename:stop`, `getProgress`, `getResult`, `selectFolder`             | R        | 无路径参数；目录由主进程 dialog 选定                                                                                                                                  |
| SubjectSearch   | `subject:detect`, `subject:search`                                         | FS       | `normalizeUserPath` 校验查询图路径；topK 限 1–1000；搜索走既有 searchLayered 只读链路，临时 crop 文件写入 os.tmpdir 并即时清理                                        |
| SubjectSearch   | `subject:selectImage`                                                      | R        | 无路径参数；文件由主进程 dialog 选定                                                                                                                                  |
| MediaSearch     | `videoIndex:startScan`, `mediaSearch:buildFrames`                          | FS/PROC  | path guard、ffmpeg/ffprobe 能力探测                                                                                                                                   |
| MediaSearch     | `mediaSearch:openMediaAtTime`, `mediaSearch:revealInExplorer`              | EXT      | videoId 从 manifest 权威解析；scanPath 限已知扫描根（对话框/已扫描/manifest 祖先）                                                                                    |
| MediaSearch     | `mediaSearch:getFrameImageDataUrl`                                         | FS       | 仅允许 media-search 数据目录内图片                                                                                                                                    |
| Vector          | `vector:downloadModel`                                                     | NET/W    | 固定模型名称，写入模型目录                                                                                                                                            |
| Vector          | `vector:startEmbeddingBuild`                                               | PROC     | 子进程隔离，模型名和并发限制                                                                                                                                          |
| Vector          | `vector:stopLayeredSearch`                                                 | R        | 无参数；仅 bump 主进程搜索序列取消当前 layered/subject 搜索，不读写文件                                                                                               |
| Vector          | `vector:clearProcessedImageData`                                           | W/FS     | 无参数；仅删除 userData 下派生数据（image-search-index/thumbcache/vector-db/扫描日志）；扫描/索引/embedding/迁移/清理任务 busy guard 互斥；realpath 越界与符号链接防护 |
| NekoSearch      | `assetLibrary:syncFromImageIndex`                                          | R/W      | 只读取受控 Image Search manifest，写入固定 `userData/asset-library`                                                                                                   |
| NekoSearch      | `assetLibrary:assignCategory`, `assignTag`, `buildClusters`                | W        | ID/数量/阈值 guard，单长任务，可取消，不修改原素材                                                                                                                    |
| NekoSearch      | `assetLibrary:buildDuplicateGroups`                                        | W        | 无参数；输入为主进程权威素材路径清单（无 Renderer 路径），单长任务可取消；仅写 `duplicate_exact` 组，不触碰素材文件                                                   |
| NekoSearch      | `assetLibrary:applyDuplicateGroup`                                         | W        | cluster id 正整数 guard + mutation 串行；仅软归档非代表成员（可恢复），无物理删除                                                                                     |
| NekoSearch      | `assetLibrary:buildNearDuplicateGroups`                                    | W        | threshold 限 1–16；输入为主进程权威素材哈希（无 Renderer 路径、无文件读取），单长任务可取消；仅写 `duplicate_near` 组                                                 |
| NekoSearch      | `assetLibrary:mergeClusters`, `splitCluster`, `moveClusterMembers`         | W        | ID 数组上限（64/10000）+ mutation 串行；只改组与成员关系，不触碰素材文件                                                                                              |
| NekoSearch      | `assetLibrary:listClusterLineage`                                          | R        | groupId 正整数 guard、limit 上限                                                                                                                                      |
| SubjectSearch   | `sam:status`, `sam:segment`                                                | FS       | `normalizeUserPath` 校验图片路径；points 限 1–8 个、坐标范围校验；只读推理，不写文件                                                                                  |
| NekoSearch      | `assetLibrary:openAsset`, `revealAsset`                                    | EXT      | 统一走 `openSafeShellPath` / `revealSafeShellPath`                                                                                                                    |
| NekoSearch      | `assetLibrary:exportBackup`, `importBackup`, `deleteBackup`                | FS       | backupId 严格校验（`normalizeAssetLibraryBackupId`）；导出/导入目标目录由主进程 dialog 选定；写操作限用户选定目录与 `asset-library-backups` 备份根；复制后强制 verify |
| RemoteTerminal  | `remoteTerminal:connect`, `testConnection`                                 | NET      | profile 校验、host fingerprint 校验                                                                                                                                   |
| RemoteTerminal  | `remoteTerminal:saveCredential`                                            | SECRET   | Electron safeStorage                                                                                                                                                  |
| RemoteTerminal  | `remoteTerminal:enqueueUpload`, `enqueueDownload`                          | FS/NET   | selection token 绑定 sender，冲突策略显式                                                                                                                             |
| RemoteTerminal  | `remoteTerminal:collectMetrics`                                            | NET/PROC | 远程命令只在已授权连接上执行                                                                                                                                          |

## 新增 IPC 检查清单

新增 IPC 前必须确认：

1. 是否已加入 `shared/ipc-contract.ts` 的 `ElectronAPI`。
2. 是否已在 `electron/preload.ts` 实现。
3. 是否已有 main process handler。
4. `tests/ipc-registration.test.cjs` 是否通过。
5. `tests/preload-contract.test.cjs` 是否通过。
6. 参数是否限制类型、长度、数量和路径边界。
7. 如果会打开本地路径，是否使用 `openSafeShellPath` / `revealSafeShellPath`。
8. 如果会写文件，是否限制写入目录。
9. 如果会启动进程，是否使用固定 argv 和 `shell: false`。
10. 如果会处理凭据，是否避免明文落盘。
