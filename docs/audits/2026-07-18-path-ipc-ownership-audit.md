# 路径型 IPC 所有权分模块审计

> 状态：当前  
> 更新日期：2026-07-18  
> 范围：Image Search、Media Search、File Manager、Duplicate Finder  
> 参照系：NKS-P2-09 整改标准（ID 化 + `openSafeShellPath`/`revealSafeShellPath` 统一包装 + 白名单 + preload/IPC 双层校验）

## 1. 目的与范围

NKS-P2-09 将 NekoSearch 的 shell 打开操作迁移为只收 asset ID、主进程权威解析路径。本审计对其余四个使用路径型 IPC 的模块逐一复核所有权边界，检查登记与实现一致性，产出各模块加固清单。审计为静态代码审计，符号链接/UNC 等推演结论已标注验证方法。

## 2. 当前结论

四个模块均无 shell 拼接（全部 argv/JSON/直接 API 调用），删除类操作只有 File Manager 且只走 `shell.trashItem`。主要差距：

1. ~~**P1**：`imageSearch:saveIndex` 允许 Renderer 指定任意路径写索引文件，无写入目录白名单。~~（已解决 2026-07-18：IPC 去参数化，写位置由主进程权威状态解析。）
2. **P2 集中区**：`imageSearch:startScan` 无控制字符过滤（`\x1f` 是 native 分隔符，可注入额外扫描根）；缩略图四条 channel（`fm-get-thumbnail*`、`fm-get-file-icons`）无 path guard、部分无数量上限；Media Search 的两个 EXT 型 shell 打开（`openMediaAtTime`、`revealInExplorer`）仍收 Renderer 任意路径，未做 NKS-P2-09 等效 ID 化。
3. **共性问题**：`safeShellPath` 不拒 UNC、无单路径长度上限；preload 层全部裸透传无双层校验；`ipc-capability-matrix.md` 登记滞后于实现（漏登 `saveIndex`、`loadIndex`、`repairManifest`、`duplicates:openPath` 等）。

File Manager 因是通用文件浏览器，无法照搬 NekoSearch 的 ID 化，建议收敛手段为"主进程已列出路径缓存命中制" + UNC/协议拒绝。Duplicate Finder 无 P1 项（全部只读遍历或 showItemInFolder）。

## 3. 问题清单

### P1 高优先级

| 编号 | 模块 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| ~~PIO-P1-01~~（已解决 2026-07-18） | Image Search | `imageSearchIpc.ts:116-120` → `imageSearchService.ts:710` | `imageSearch:saveIndex` Renderer 指定任意写路径，可能覆盖已有文件（native 是否排他创建未验证） | ~~写入位置固定化/去参数化~~ 已实施：IPC 去参数化，写位置由主进程状态解析（`saveImageIndexToDefaultLocation`），preload/契约/桥接同步去掉路径参数；typecheck、lint、IPC 三套件测试通过 |

### P2 中优先级

| 编号 | 模块 | 位置 | 问题 |
| --- | --- | --- | --- |
| ~~PIO-P2-01~~（已解决 2026-07-18） | Image Search | `imageSearchGuards.ts:6-23`、`imageSearchService.ts:572` | ~~`startScan` 无控制字符过滤（`\x1f` 注入额外扫描根）、无目录校验、无长度上限~~ 已修：`normalizeFsPath` 拒绝控制字符与 >4096 字符路径，`startImageSearchScan` 增加 statSync 目录校验 |
| ~~PIO-P2-02~~（已解决 2026-07-18） | Image Search | `imageSearchIpc.ts:122-138` | ~~`loadIndex`/`loadManifest`/`repairManifest` 无目录校验与根白名单，C++ 解析任意文件~~ 已修：loadIndex 要求存在且为文件，loadManifest/repairManifest 要求存在且为目录 |
| ~~PIO-P2-03~~（已解决 2026-07-18） | Image Search / File Manager | `thumbnailIpc.ts:281, 388, 339` | ~~`fm-get-thumbnail(-batch)` 无 path guard（`.svg` 任意读回传）；`fm-get-file-icons` 无数量上限~~ 已修：四条 channel 统一 `safeShellPath` 校验，`fm-get-file-icons` 限 200 条，`fm-get-folder-thumbnails` maxCount≤32、maxDim 限 [32,256] |
| ~~PIO-P2-04~~（已解决 2026-07-18） | Media Search | `mediaSearchIpc.ts:585, 592` | ~~`openMediaAtTime`/`revealInExplorer` 收 Renderer 任意路径，无 manifest 归属校验~~ 已修：`openMediaAtTime` 只收 videoId 经 manifest 权威解析（missing 拒绝）；`revealInExplorer` 收 `{videoId \| scanPath}`，scanPath 限已知扫描根（对话框/已扫描/manifest 祖先，新增 `isRevealableMediaScanPath` 纯函数 + 3 项测试）；`normalizeOpenMediaAtTimeInput` 退役；UI smoke 通过 |
| ~~PIO-P2-05~~（部分解决 2026-07-18） | Media Search | `mediaSearchIpc.ts:597, 662-663` | ~~`searchMultimodal` 缺图片扩展名白名单~~ 已对齐 `searchFramesByImage`；`detectSubtitles` 任意文件 ffprobe 探测仍未修（建议 videoId 化） |
| ~~PIO-P2-06~~（已解决 2026-07-18） | File Manager | `pathGuards.ts:41` | ~~`normalizeUserPath` 不拒控制字符/协议样式/UNC、无长度上限~~ 已修：拒绝控制字符与 >4096 字符路径。UNC 不拒属产品决策（File Manager 浏览网络驱动器为合法用法），执行面风险由 PIO-P2-07 的修复覆盖 |
| ~~PIO-P2-07~~（已解决 2026-07-18） | File Manager | `pathGuards.ts:69-77` | ~~`safeShellPath` 不拒 UNC（`\\host\share\x.exe` 可达 `shell.openPath` 执行远程可执行文件）~~ 已修：`openSafeShellPath` 拒绝 UNC 执行；reveal/浏览保持允许（合法 NAS 用法） |
| ~~PIO-P2-08~~（部分解决 2026-07-18） | Duplicate Finder | `ipcValidation.ts:19-23`、`duplicateFinderService.ts:23-31` | ~~`normalizeFolderPath` 无长度上限、不拒控制字符~~ 已修：限 4096 字符 + 拒绝控制字符。扫描根白名单属产品决策（用户手输任意根为设计内能力），维持现状并登记 |

### P3 低优先级

| 编号 | 模块 | 问题 |
| --- | --- | --- |
| ~~PIO-P3-01~~（已解决 2026-07-18） | File Manager | ~~`fileManagerIpc.ts:557,567` 跨设备 move 物理删除源文件（不可恢复）~~ 已修：跨设备 move 的源改走 `shell.trashItem`（回收站，符合应用 FS 规则）；trashItem 失败时报错且源保留（安全失败方向） |
| PIO-P3-02 | 全部 | preload 层裸透传无运行时校验（纵深防御缺口，全 app 风格一致） |
| PIO-P3-03 | Image Search | `openFile`/`openFolder` 搜索结果场景可 ID 化（已包装，属纵深防御） |
| ~~PIO-P3-04~~（已解决 2026-07-18） | Media Search | ~~`getFrameImageDataUrl` 缓存根前缀校验不解符号链接~~ 已修：`readMediaSearchImageDataUrl` 增加 `fs.realpathSync` 真实路径二次包含校验，读取也改走真实路径；junction 逃逸测试固化（media-search-guards 17/17） |
| PIO-P3-05 | Duplicate Finder | `openPath` 可改 (groupIndex, fileIndex) ID 化（可选加固，reveal 不执行文件、已有 safeShellPath 包装，维持现状并登记）；channel 名与 showItemInFolder 行为不符 |
| ~~PIO-P3-06~~（已解决 2026-07-18） | Duplicate Finder | ~~junction/符号链接逃逸依赖 Dirent 语义，无测试固化~~ 已修：`tests/duplicate-finder.test.cjs` 新增 junction 实测，确认 worker 不递归 junction（4/4 通过） |
| ~~PIO-P3-07~~（已解决 2026-07-18） | Media Search | ~~`openMediaAtTime` 的 `timestampMs` 校验后未使用（无效参数）~~ 随 PIO-P2-04 转为契约保留字段并注明用途 |
| ~~PIO-P3-08~~（已解决 2026-07-18） | 全部 | ~~无单路径长度上限~~ 已随 P2 批次补齐（normalizeFsPath/normalizeUserPath/normalizeFolderPath 均限 4096） |

## 4. 与 ipc-capability-matrix 登记的差异

1. 漏登：`imageSearch:saveIndex`、`loadIndex`、`repairManifest`、`hashImage`、`validatePath`；`fm-get-folder-thumbnails`、`fm-get-file-icons`、`fm-create-directory`、`fm-rename-file`、`fm-watch-dir`；`mediaSearch:searchFramesByImage`、`searchMultimodal`、`detectSubtitles`、`validatePath`、`buildFrameEmbeddings`；`duplicates:openPath` 及各模块查询类 channel。
2. `startScan` 登记"path guard、目录校验"与实现不符（走的是 `normalizeScanPaths`，无控制字符/存在性检查）。
3. 矩阵未记录 UNC 未拒绝、跨设备 move 物理删除源、缩略图无 path guard 三个已知边界。

## 5. 验证方法与不确定项

1. UNC 穿透结论基于 `safeShellPath` 正则静态推演；可用 `loadTsModule` 对 `safeShellPath('\\\\host\\share\\x.exe')` 补断言实测。
2. `saveIndex` 的 native 打开标志需查 `native/` 源码确认是否排他创建。
3. junction 逃逸（Media Search 缓存根、Duplicate Finder 递归）需运行时构造 junction 实测。
4. Renderer 是否存在非 manifest 来源调用 `openMediaAtTime`/`revealInExplorer`（影响 ID 迁移可行性）：需在 `src/` grep 确认入参来源。

## 6. 下一步

按 PIO-P1-01 → P2 → P3 顺序加固；每次加固后同步 `ipc-capability-matrix.md` 登记并补专项测试（参照 `tests/file-manager-security.test.cjs` 模式）。Media Search 的 ID 化（PIO-P2-04）可直接复用 NKS-P2-09 的 `resolveAssetLibraryAssetPath` 模式。
