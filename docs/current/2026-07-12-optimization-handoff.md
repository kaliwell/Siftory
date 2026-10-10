# FloatingClock 优化进度交接 - 截至 2026-07-12

> 状态：当前  
> 起始日期：2026-07-10  
> 最后更新：2026-07-22  
> 配套审计：[项目优化方向审计](2026-07-11-project-optimization-audit.md)
> 最新专项审计：[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)

## 交接目标

本文档最初阶段先不做 NekoSearch 智能素材分类；该限制已失效。NekoSearch 已在 2026-07-14 至 2026-07-15 形成首轮纵向链路，当前状态以[实施基线](2026-07-14-neko-search-implementation.md)和[专项审计](../audits/2026-07-18-neko-search-complete-audit.md)为准。

本轮用户明确指定的剩余主要优化项：

1. `electron/main.ts` IPC 拆分。
2. Electron dynamic/static import warning 清理。
3. 搜索准确率固定样本测试。

## 2026-07-22：千条图片结果快速滚动优化

本轮针对 Image Search 返回 1000 项后快速滚动卡顿实施公共层修复，不建立 Image Search 私有缩略图分支。

1. 新增通用 `BoundedBatchScheduler`：请求按 key 去重、批量执行、队列上限 64、支持 AbortSignal 取消；压力下先淘汰最旧低优先级任务，避免快速扫过的离屏缩略图继续占用后端。
2. `ThumbnailImage` 的图片请求键改为 `path@targetSize`，组件卸载或滚动降载时取消尚未开始的请求；Image Search 与 NekoSearch 当前视口使用高优先级。IntersectionObserver 改为所有实例共享一个观察器。
3. `useVirtualGrid` 新增 `isScrolling`：滚动期间 overscan 从 3 行收缩为 1 行，停止 120ms 后恢复；滚动帧不再重复调用 `getBoundingClientRect()`，内容相对位置只在布局测量时更新。
4. Image Search 在快速滚动时只渲染占位，停止后加载当前可见缩略图；请求尺寸由 192px 降为 160px，对应实际约 150px 显示。NekoSearch Assets/Suggestions 与 Media Search Frames 复用同一滚动降载能力。
5. 虚拟内容层使用 `contain: layout paint` 和 `translate3d` 定位，降低滚动范围变化引起的布局/绘制传播。
6. 专项验证：1000 请求模拟中 980 个离屏请求均在进入 loader 前取消，仅处理最后 20 个当前请求；1000 结果、720px 高、4 列高速窗口最多挂载 28 项。新增调度器 4 项、虚拟网格 2 项回归，`test:fm-security` 22/22、Media Search 30/30、Asset Library 94/94、Native 29/29、typecheck/lint/format 和生产构建通过。
7. 验证边界：完整 `verify` 的全部代码测试通过，但最后 `build:native` 无法清理正在运行的 `fast_scanner.node`（项目 dev Electron 进程自 21:33 起持有文件）；本轮未修改 native。关闭该开发实例后需补跑一次 `npm.cmd run verify` 以完成 native 重编译门禁。
8. 后续二期候选：把磁盘 `.thumb` Base64 文本改为二进制图片并通过受限自定义协议加载，进一步降低 IPC 复制和约 33% Base64 膨胀；实施前需单独完成协议目录逃逸安全审计。

## 当前状态

### 已完成

1. `electron/main.ts` IPC 拆分继续推进：
   - `imageSearch:*` 已拆到 `electron/imageSearchIpc.ts`。
   - `appStorage:*` 已拆到 `electron/appStorageIpc.ts`。
   - `duplicates:*` 已拆到 `electron/duplicateFinderIpc.ts`。
   - `main.ts` 当前约 2478 行。

2. Electron 构建 warning 已处理：
   - 之前 `npm run build:renderer` 会出现 Vite dynamic/static import warning。
   - 已统一处理 `ffmpegService`、`videoScanService`、`videoFrameService`、`videoFrameSearchService`、`vectorDatabaseService`、`mediaSearchFrameIndex` 的动态/静态 import 混用。
   - `mediaSearchFrameIndex` 当前作为独立懒加载 chunk 输出。
   - 最新 `npm run build:renderer` 通过，且无 dynamic/static import warning。

3. 搜索准确率固定样本测试已添加：
   - 新增 `tests/media-search-fixed-samples.test.cjs`。
   - 使用临时 media-search 目录和临时 vector-db。
   - 手工写入 video frame manifest 与 CLIP embedding shard。
   - 覆盖相似帧搜索固定样本排序、TopK 限制、候选数量、自身帧排除。
   - 已加入 `package.json` 的 `test:media-search`。

4. 测试过程中发现并修复结构问题：
   - `electron/vectorDatabaseService.ts` 原先在模块加载时就解析 `app.getPath('userData')`。
   - 这会让 Node 测试环境加载失败，也增加主进程启动耦合。
   - 已改为 `JsonLinesStore` 懒解析 `filePath`，实际访问数据库时才解析路径。

5. MediaSearch cache 测试已按当前策略修正：
   - 当前 `Clear Cache` 应保留 manifest、frames、vectors 等可搜索数据。
   - 只清理 thumbnails、ocr、temp 等可丢弃缓存。
   - 这是为了避免再次出现“清缓存后数据没了”的问题。

6. 继续完成 MediaSearch IPC 全量迁出：
   - 新增 `electron/mediaSearchIpc.ts`，承接全部 `mediaSearch:*` 和 `videoIndex:*` IPC handler。
   - 新增 `electron/mediaSearchImageCache.ts`，集中处理 MediaSearch frame/thumbnail dataUrl LRU 缓存。
   - 新增 `electron/mediaSearchScope.ts`，集中处理 scanPaths/scope 路径归一化和范围判断。
   - 新增 `electron/mediaSearchQueryImage.ts`，集中处理查询图片类型校验。
   - 新增 `electron/mediaFrameEmbeddingState.ts`，集中处理 frame embedding build 完成后的 frame index 自动重建状态。
   - `electron/main.ts` 已不再直接注册 `mediaSearch:*` / `videoIndex:*` handler。
   - `electron/main.ts` 当前约 1771 行。

## 本轮主要改动文件

### 新增

- `electron/duplicateFinderIpc.ts`
- `electron/mediaSearchIpc.ts`
- `electron/mediaSearchImageCache.ts`
- `electron/mediaSearchScope.ts`
- `electron/mediaSearchQueryImage.ts`
- `electron/mediaFrameEmbeddingState.ts`
- `tests/media-search-fixed-samples.test.cjs`
- `docs/current/2026-07-12-optimization-handoff.md`

### 修改

- `electron/main.ts`
- `electron/mediaTaskQueue.ts`
- `electron/vectorDatabaseService.ts`
- `electron/videoFrameService.ts`
- `electron/videoFrameSearchService.ts`
- `tests/media-search-guards.test.cjs`
- `package.json`
- `docs/audits/2026-07-09-project-multidimensional-audit.md`

## 最新验证结果

已通过：

```bash
npm run lint
npm run typecheck
npm run test:media-search
npm run build:renderer
```

其中：

- `test:media-search`：13/13 通过。
- `build:renderer`：通过，无 Vite dynamic/static import warning。
- 2026-07-10 后续验证：MediaSearch IPC 全量迁出后，`lint`、`typecheck`、`test:media-search`、`build:renderer` 均通过。

注意：

- 当前目录不是 Git 工作树，`git status` 不可用。
- 后续对比变更需要以文件内容和构建验证为准。

## 目前剩余优化项

### P0：继续拆分 `electron/main.ts`

建议顺序：

1. `mediaSearch:*` IPC：已完成。
2. 拆 `vector:*` IPC。
3. 拆 `remoteTerminal:*` IPC。
4. 最后整理通用窗口、设置、热键 IPC。

注意事项：

- MediaSearch IPC 已迁出；后续重点转向 Vector / RemoteTerminal IPC。
- Vector IPC 仍包含模型下载、embedding build、vector settings、maintenance、search 等较多职责，建议分批迁移。

### P1：扩展固定样本测试

当前只有“相似帧搜索”固定样本。

建议新增：

1. 文本搜视频固定样本。
2. 以图搜视频固定样本。
3. 跨盘符 / scanPaths scope 过滤固定样本。
4. frame index 失效后自动重建固定样本。

### P1：启动卡顿继续排查

之前已优化过 MediaSearch 打开卡顿，但仍建议继续检查：

1. 面板打开时是否同步读取大 manifest。
2. 是否同步统计 embedding stats。
3. 是否同步加载大量缩略图。
4. `getStatus` 是否触发不必要的磁盘扫描。

### P2：文档和测试脚本整理

建议：

1. 将 MediaSearch 固定样本测试单独记录到审计文档。
2. 为 IPC 拆分建立 checklist，避免 handler 遗漏。
3. 如果后续恢复 Git，先做一次完整变更快照。

## 下一轮建议执行顺序

1. 跑一次当前基线：

```bash
npm run lint
npm run typecheck
npm run test:media-search
npm run build:renderer
```

2. 继续拆 `vector:*` IPC，建议先拆低耦合部分：
   - `vector:getModelStatus`
   - `vector:downloadModel`
   - `vector:cancelDownload`
   - `vector:deleteModel`
   - `vector:getEmbeddingProgress`
   - `vector:getVectorIndexStatus`

3. 拆完后立刻跑：

```bash
npm run typecheck
npm run build:renderer
npm run test:media-search
```

4. 再扩展固定样本测试。

## 2026-07-10 后续优化进度：Vector IPC 全量迁出

本轮继续完成 `electron/main.ts` 结构优化，已将 `vector:*` IPC 从主进程入口迁出到独立模块。

完成内容：

1. 新增 `electron/vectorIpc.ts`，集中注册并维护全部 `vector:*` handler。
2. 已迁出的 handler 覆盖模型状态、模型下载/删除、embedding build、索引构建、以图搜图、语义搜索、特征提取、vector settings、vector maintenance。
3. Vector/Rerank 初始化也迁入 `registerVectorIpc()`，包括 `initModelService`、`initVectorDatabase`、`setHashDelegate`、`onModelStatusChanged`、`onEmbeddingProgress`。
4. MediaSearch frame embedding 完成后自动触发 frame index 重建的逻辑仍保留，通过 `handleMediaFrameEmbeddingProgress()` 在 `vectorIpc.ts` 内转发。
5. `electron/main.ts` 当前约 1564 行，`electron/vectorIpc.ts` 当前约 387 行。
6. 当前 `main.ts` 中已无 `ipcMain.handle('vector:*')` 残留。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:media-search
npm.cmd run build:renderer
```

结果：

- `typecheck`：通过。
- `lint`：通过。
- `test:media-search`：13/13 通过。
- `build:renderer`：通过，未出现 dynamic/static import warning。

剩余主要优化项：

1. 继续拆 `remoteTerminal:*` IPC，建议按 profiles、connection、sftp、transfer 分组。
2. 对 ImageSearch / MediaSearch / Vector 搜索准确率补更多固定样本，尤其覆盖跨盘符、scope 过滤、索引重建后结果稳定性。
3. 继续排查 prompt 编辑窗口移动卡顿和 Chromium latency 日志，重点检查透明窗口、置顶窗口、拖拽移动时的重绘路径。

## 2026-07-10 后续优化进度：RemoteTerminal profiles/credentials IPC 子集迁出

本轮在 Vector IPC 全量迁出后，继续拆分 `remoteTerminal:*` 的低耦合子集。

完成内容：

1. 新增 `electron/remoteTerminalProfileIpc.ts`。
2. 已迁出以下 handler：
   - `remoteTerminal:listProfiles`
   - `remoteTerminal:saveProfile`
   - `remoteTerminal:deleteProfile`
   - `remoteTerminal:credentialStatus`
   - `remoteTerminal:saveCredential`
   - `remoteTerminal:deleteCredential`
3. `main.ts` 保留 RemoteTerminal 的 connection / SFTP / transfer handler，下一轮可以继续按功能域拆分。
4. `electron/main.ts` 当前约 1511 行，`electron/remoteTerminalProfileIpc.ts` 当前约 60 行。

本轮验证：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：13/13 通过。
- `npm.cmd run build:renderer`：通过，未出现 dynamic/static import warning。

下一步建议：

1. 继续拆 `remoteTerminal:sftp` 类 handler：list/listPaged/mkdir/rename/remove。
2. 再拆 `remoteTerminal:transfer` 类 handler：choose upload/download、enqueue upload/download、transfer list/cancel/clear。
3. 最后拆 terminal connection 类 handler：connect/test/metrics/disconnect/write/resize 与 callback wiring。

## 2026-07-10 后续优化进度：RemoteTerminal SFTP IPC 迁出

本轮继续按交接建议拆分 `remoteTerminal:*` IPC，将 SFTP 相关 handler 从 `electron/main.ts` 迁出。

完成内容：

1. 新增 `electron/remoteTerminalSftpIpc.ts`，集中注册以下 handler：
   - `remoteTerminal:listRemoteDirectory`
   - `remoteTerminal:listRemoteDirectoryPaged`
   - `remoteTerminal:mkdirRemote`
   - `remoteTerminal:renameRemote`
   - `remoteTerminal:removeRemote`
2. 新增 `electron/remoteTerminalCredential.ts`，抽出 `normalizeCredentialRequest`、`normalizeCredentialFields`、`resolveStoredCredential`，供当前 connection/transfer 和新 SFTP IPC 复用。
3. `electron/main.ts` 不再直接导入 `remoteSftpService`，也不再直接注册 SFTP handler；生命周期中改为调用 `registerRemoteTerminalSftpIpc(app.getPath('userData'))`。
4. `electron/main.ts` 当前约 1200 行；`electron/remoteTerminalSftpIpc.ts` 约 171 行；`electron/remoteTerminalCredential.ts` 约 56 行。

本轮额外修复：

1. `vite.config.mjs` 固定 dev server 监听 `127.0.0.1`，避免 Windows 上 Vite 只监听 IPv6 loopback 导致 Electron `ERR_CONNECTION_REFUSED`。
2. `electron/main.ts` 开发模式加载 dev server 增加重试，并将 DevTools 改为仅在 `FLOATING_CLOCK_OPEN_DEVTOOLS=1` 时自动打开。
3. `electron/devServerGuard.ts` 将 `localhost` 规范为 `127.0.0.1`；对应 guard 测试已更新。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:remote-sftp
npm.cmd run test:remote-terminal
npm.cmd run test:remote-transfer
npm.cmd run test:remote-stress
npm.cmd run build:renderer
node --test tests\guards.test.cjs
```

结果：

- 以上验证均通过。
- 实测 `npm.cmd run dev` 后 Vite 显示 `http://127.0.0.1:5173/`，未再出现 `Failed to load URL` / `ERR_CONNECTION_REFUSED`。

下一步建议：

1. 继续迁出 `remoteTerminal:transfer` handler：`chooseUploadFile`、`chooseDownloadDirectory`、`enqueueUpload`、`enqueueDownload`、`listTransfers`、`cancelTransfer`、`clearTransferHistory`。
2. 再迁出 terminal connection handler：`connect`、`testConnection`、`collectMetrics`、`disconnect`、`write`、`resize`，同时迁移 callback wiring。
3. 继续补 RemoteTerminal IPC 注册完整性测试，防止 handler 拆分后遗漏。

## 2026-07-10 后续优化进度：RemoteTerminal Transfer IPC 迁出

本轮继续拆分 `remoteTerminal:*` IPC，将 transfer 相关 handler 和 transfer 事件回调从 `electron/main.ts` 迁出。

完成内容：

1. 新增 `electron/remoteTerminalTransferIpc.ts`，集中注册以下 handler：
   - `remoteTerminal:chooseUploadFile`
   - `remoteTerminal:chooseDownloadDirectory`
   - `remoteTerminal:enqueueUpload`
   - `remoteTerminal:enqueueDownload`
   - `remoteTerminal:listTransfers`
   - `remoteTerminal:cancelTransfer`
   - `remoteTerminal:clearTransferHistory`
2. transfer selection token 管理已从 `main.ts` 迁入 `remoteTerminalTransferIpc.ts`，包括 upload-file / download-directory token 的创建、校验、过期和 sender 绑定。
3. transfer conflict policy 归一化已从 `main.ts` 迁入 `remoteTerminalTransferIpc.ts`。
4. `setTransferCallback()` 也迁入 `registerRemoteTerminalTransferIpc()`，由该模块负责向 renderer 发送 `remoteTerminal:onTransferChanged`。
5. `electron/main.ts` 不再直接导入 `remoteTransferService`；生命周期中改为调用 `registerRemoteTerminalTransferIpc(() => mainWindow, app.getPath('userData'))`。
6. `electron/main.ts` 当前约 1015 行；`electron/remoteTerminalTransferIpc.ts` 约 195 行。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:remote-transfer
npm.cmd run test:remote-sftp
npm.cmd run test:remote-terminal
npm.cmd run test:remote-stress
npm.cmd run test:media-search
npm.cmd run build:renderer
node --test tests\guards.test.cjs
```

结果：

- 以上验证均通过。
- `electron/main.ts` 中已无 transfer handler 残留；transfer handler 只存在于 `electron/remoteTerminalTransferIpc.ts`。

下一步建议：

1. 继续迁出 terminal connection handler：`connect`、`testConnection`、`collectMetrics`、`disconnect`、`write`、`resize`。
2. 将 `setDataCallback()` / `setStatusCallback()` 一并迁入 connection IPC 模块，让 `main.ts` 不再直接维护 RemoteTerminal 事件转发。
3. 迁出完成后跑完整 `npm.cmd run verify` 或等价分段验证。

## 2026-07-10 后续优化进度：RemoteTerminal Connection IPC 迁出

本轮完成 `remoteTerminal:*` 最后一组 connection/session handler 迁出，RemoteTerminal IPC 已按 profile / SFTP / transfer / connection 四组拆分。

完成内容：

1. 新增 `electron/remoteTerminalConnectionIpc.ts`，集中注册以下 handler：
   - `remoteTerminal:connect`
   - `remoteTerminal:testConnection`
   - `remoteTerminal:collectMetrics`
   - `remoteTerminal:disconnect`
   - `remoteTerminal:write`
   - `remoteTerminal:resize`
2. `setDataCallback()` / `setStatusCallback()` 已迁入 `registerRemoteTerminalConnectionIpc()`，由该模块负责向 renderer 发送：
   - `remoteTerminal:onData`
   - `remoteTerminal:onStatusChanged`
3. `electron/main.ts` 不再直接导入 `listProfiles`、`saveProfile`、`connect`、`testConnection`、`collectMetrics`、`disconnect`、`write`、`resize`、`setDataCallback`、`setStatusCallback`。
4. `electron/main.ts` 当前约 844 行；`electron/remoteTerminalConnectionIpc.ts` 约 182 行。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:remote-terminal
npm.cmd run test:remote-transfer
npm.cmd run test:remote-sftp
npm.cmd run test:remote-stress
npm.cmd run test:media-search
npm.cmd run build:renderer
node --test tests\guards.test.cjs
```

结果：

- 以上验证均通过。
- `electron/main.ts` 中已无 RemoteTerminal connection/transfer/SFTP handler 注册残留；RemoteTerminal IPC 已完成模块化迁出。

下一步建议：

1. 继续整理 `main.ts` 中剩余通用窗口、设置、热键、缩略图相关 IPC；可优先拆设置/窗口控制这类低耦合 handler。
2. 补 IPC 注册完整性测试，枚举预期 channel 并防止后续拆分遗漏。
3. 若要继续性能优化，转向 prompt 编辑窗口拖动卡顿和启动同步 IO 审计。

## 2026-07-10 后续优化进度：App Core IPC 迁出

本轮继续整理 `electron/main.ts` 中剩余低耦合 IPC，将通用窗口、设置、热键和 overlay shape 相关逻辑迁出。

完成内容：

1. 新增 `electron/appCoreIpc.ts`，集中注册以下 handler：
   - `open-folder`
   - `copy-to-clipboard`
   - `browse-folder`
   - `hide-window`
   - `show-window`
   - `set-transparency`
   - `set-ignore-mouse`
   - `set-overlay-shape`
   - `get-hotkey-status`
   - `register-hotkey`
   - `unregister-hotkey`
   - `load-settings`
   - `save-settings`
   - `load-config`
   - `save-config`
   - `get-work-area`
   - `open-config-dir`
2. 将 `registerGlobalHotkeys()` 迁入 `appCoreIpc.ts`，通过 `getMainWindow()` / `getWorkArea()` / `ensureWindowOnTop()` 注入运行时状态，避免新模块直接持有窗口全局变量。
3. `electron/main.ts` 不再直接导入 settings store 和通用 IPC validation helper。
4. `electron/main.ts` 当前约 616 行；`electron/appCoreIpc.ts` 约 252 行。
5. `electron/main.ts` 当前剩余直接注册的 IPC 主要是缩略图/文件图标相关 4 个 handler，后续可继续迁出为 thumbnail/icon IPC 模块。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
node --test tests\guards.test.cjs
npm.cmd run test:settings
npm.cmd run test:remote-terminal
npm.cmd run test:media-search
npm.cmd run test:fm-security
npm.cmd run test:fm-watcher
npm.cmd run build:renderer
```

结果：

- 以上验证均通过。
- 通用窗口、设置、热键和 overlay shape handler 已只存在于 `electron/appCoreIpc.ts`。

下一步建议：

1. 继续拆 `main.ts` 中缩略图/文件图标相关 IPC：`fm-get-thumbnail`、`fm-get-folder-thumbnails`、`fm-get-file-icons`、`fm-get-thumbnails-batch`。
2. 拆完后 `main.ts` 将基本只剩窗口创建、生命周期装配、display metrics 和少量共享初始化。
3. 再补 IPC 注册完整性测试或转向 prompt 编辑窗口拖动卡顿审计。

## 2026-07-10 后续优化进度：Thumbnail/Icon IPC 迁出

本轮完成 `electron/main.ts` 中最后一组直接 IPC handler 迁出，将文件缩略图和文件图标相关逻辑移入独立模块。

完成内容：

1. 新增 `electron/thumbnailIpc.ts`，集中注册以下 handler：
   - `fm-get-thumbnail`
   - `fm-get-folder-thumbnails`
   - `fm-get-file-icons`
   - `fm-get-thumbnails-batch`
2. 缩略图缓存、LRU 清理、PSD 预览提取、Sharp fallback、`.lnk` 目标解析和批量缩略图限流逻辑已从 `main.ts` 迁出。
3. `evictThumbCache()` 已迁入 `thumbnailIpc.ts`，由 `main.ts` 在启动时调用 `evictThumbCache(app.getPath('userData'))`。
4. `electron/main.ts` 当前约 237 行；`electron/thumbnailIpc.ts` 约 361 行。
5. `electron/main.ts` 当前已无直接 `ipcMain.handle(...)` 注册；主进程入口基本只负责窗口创建、生命周期装配、display metrics 和服务初始化。

本轮验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:fm-security
npm.cmd run test:fm-watcher
npm.cmd run test:settings
npm.cmd run test:remote-terminal
npm.cmd run test:remote-transfer
npm.cmd run test:remote-sftp
npm.cmd run test:remote-stress
npm.cmd run test:media-search
node --test tests\guards.test.cjs
npm.cmd run build:renderer
```

结果：

- 以上验证均通过。
- IPC 结构拆分主目标已基本完成：`main.ts` 已无直接 handler 注册。

当前剩余优化项状态：

1. `electron/main.ts` IPC 拆分：已完成主目标。后续只建议补 IPC 注册完整性测试。
2. Electron dynamic/static import warning：当前 `build:renderer` 通过，未出现 dynamic/static import warning。
3. 搜索准确率固定样本测试：已有相似帧固定样本，后续可继续扩展文本搜视频、以图搜视频、scope 过滤、frame index 自动重建样本。
4. 性能审计：后续重点转向 prompt 编辑窗口拖动卡顿、启动同步 IO、缩略图批量加载真实场景。

## 2026-07-11 继续优化：MediaSearch 作用域一致性与固定样本

本轮重新核验代码后确认，RemoteTerminal 的 profile、SFTP、transfer、connection IPC 均已完成迁出；`electron/main.ts` 当前约 268 行，旧交接记录中“继续拆 RemoteTerminal”的任务已经完成，不应重复执行。

本轮新增完成：

1. `videoFrameSearchService.ts` 删除自有的重复 scanPaths 规范化和前缀判断，统一复用 `mediaSearchScope.ts`。
2. 新增预编译作用域 matcher：每次搜索只解析一次所选盘符/目录，避免对每一帧重复执行全部 scope 的 `path.resolve`。
3. 固定样本新增同名前缀目录隔离场景：选择 `library-a` 时，`library-a-copy` 中的帧不得进入语义搜索或以图搜视频结果。
4. 保留并验证跨目录过滤、TopK、固定向量排序、索引源变化后自动重建等准确率约束。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：16/16 通过。
- `npm.cmd run build:renderer`：通过；未出现 dynamic/static import warning。

当前结构优化阶段已基本完成。后续更适合继续做真实素材准确率基准、Electron UI smoke 自动化，以及大规模 frame index 异步/持久化检索优化；这些属于独立的中高风险工作，不应与新功能开发混在同一轮。

## 2026-07-11 继续优化：Frame Index 异步加载

针对 MediaSearch 首次搜索可能卡住 Electron 主进程的问题，本轮继续完成：

1. 新增 `loadFrameIndexAsync`，使用逐行流式读取替代交互搜索路径中的 `readFileSync(...).split()`。
2. Image Search Video、Semantic Search Video、Similar Frame 三条搜索路径均改为等待异步 frame index。
3. 同模型、同索引签名的并发加载自动合并，多个同时到达的搜索不会重复读取大索引。
4. 读取结束前如果索引文件签名发生变化，不写入旧缓存；索引失效时同时清除加载缓存。
5. 保留同步 `loadFrameIndex`，仅供当前维护/兼容调用，降低一次性改动范围。
6. 新增并发异步加载固定测试，验证两个并发调用共享同一个缓存 Map，且完整读取 4 条固定向量。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：17/17 通过。
- `npm.cmd run build:renderer`：通过。

剩余的大规模索引风险主要是 `ensureFrameIndexFresh/buildFrameIndex` 在索引过期时仍为同步重建。下一步若继续压缩搜索卡顿，应将“索引新鲜度检查 + 重建”迁入 worker/child process，并使用原子替换；该改动涉及任务进度、取消和并发写保护，风险高于本轮异步读取。

## 2026-07-11 继续优化：Frame Index 异步重建

本轮继续消除上述同步重建风险：

1. 新增 `ensureFrameIndexFreshAsync` 与 `buildFrameIndexAsync`，embedding shard 通过流式逐行读取，不再在交互搜索中同步扫描完整 JSONL。
2. 以图搜视频、语义搜视频、相似帧搜索均改为等待异步新鲜度检查和重建。
3. embedding 构建完成后的自动 frame index 更新也改为异步，不再在进度达到 100% 后调用同步重建造成界面突然卡顿。
4. 同时到达的重建请求合并到同一个 Promise，避免搜索、embedding 完成回调重复重建索引。
5. 同步和异步重建均使用进程/时间戳唯一临时文件，降低并发任务争用固定 `.tmp` 的风险；完成后原子 rename 替换正式索引。
6. 新增并发异步重建固定测试，验证两个并发请求得到一致的 4 条索引结果且无错误。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：18/18 通过。
- `npm.cmd run build:renderer`：通过。

当前已知的主线程同步大文件读取和过期索引重建路径已经从交互搜索链移除。剩余大规模瓶颈是 JSON 解析和向量 Map 仍运行、常驻于 Electron 主进程；当 frame 数量继续扩大到数十万级时，应迁移至 worker/child process 或持久化 ANN，而不是继续扩大 JSONL 内存索引。

## 2026-07-11 继续优化：大候选集响应性与内存

本轮继续优化数万到数十万帧的评分阶段：

1. 清理 `videoFrameSearchService.ts` 和 `videoFrameService.ts` 中不可到达的旧 embedding shard fallback。索引为空时函数此前已经返回，因此旧 `else` 永远不会执行，却保留了同步 `readFileSync(...).split()` 风险。
2. 新增 cooperative event-loop yield。Image、Text、Similar 三类向量评分每处理 512 条向量主动让出一次事件循环，使窗口移动、绘制和 IPC 进度事件不会被长评分循环持续阻塞。
3. 新增公共 `mediaSearchTopK.ts`。候选数组达到 `max(1000, TopK * 4)` 后立即裁剪到 TopK，避免 TopK=50 时仍复制、保存和全量排序十万条 frame record。
4. TopK 裁剪保持最终分数降序与固定样本结果不变，同时显著限制搜索阶段的临时对象数量。
5. 新增 1500 条固定分数测试，验证有界候选集仍保留最高 10 条结果。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：19/19 通过。
- `npm.cmd run build:renderer`：通过，主进程 bundle 约 219.72 KB，未出现动态/静态导入警告。

剩余性能边界：cooperative yield 可以保持界面响应，但总向量计算仍由主进程 CPU 执行。若真实索引达到数十万级且搜索耗时仍不可接受，下一步应将 cosine scoring 迁到 worker/native ANN；这属于架构升级，而不是继续微调当前循环。

## 2026-07-11 继续优化：归一化点积评分

本轮降低每个候选向量的 CPU 计算量：

1. `normalizeFrameVector` 现在执行真实 L2 单位化，而不再只做数字校验；非法、维度错误和零向量会被拒绝。
2. 新建 frame index 时写入单位向量；加载旧 frame index 时也会即时单位化，因此不要求用户重新 Build Frames/CLIP/DINO 即可兼容。
3. 图片查询和文本查询向量每次搜索只单位化一次。
4. Image、Text、Similar 三类搜索改用 `normalizedCosineScore`，每个候选只计算点积，不再重复计算查询范数、候选范数和平方根。
5. 分数仍保持原来的 `[0, 1]` 映射，TopK 排序和 UI 百分比语义不变。
6. 新增 512 维固定向量数学等价测试；原始余弦与单位向量点积分数误差小于 `1e-12`，并验证零向量拒绝。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：20/20 通过。
- `npm.cmd run build:renderer`：通过，无动态/静态导入警告。

本轮将每候选向量循环内约三组乘法累加和两次平方根降低为一组点积累加。总搜索仍为线性扫描，但在迁移 worker/native ANN 前，当前 JavaScript 精确搜索路径的主要可复用计算已被消除。

## 2026-07-11 继续优化：Frame Index 运行时内存

本轮降低大型 frame index 常驻内存：

1. 磁盘 `frame_embedding_index.jsonl` 格式保持不变，避免数据迁移和强制重新 Build。
2. 同步/异步加载后的运行时向量由 JavaScript `number[]` 改为连续 `Float32Array`。
3. 单个 512 维向量的连续数值区固定为 2048 字节；相比普通 JS 数组，减少元素存储和对象开销，并提高点积遍历的内存局部性。
4. shard fallback 找到的单条向量同样转换为 `Float32Array`，保证运行时评分类型一致。
5. 新增 256 MB frame index 多模型缓存预算。DINO/CLIP 缓存总量超过预算时，保留当前模型并淘汰旧模型，避免切换模型后内存长期翻倍。
6. 单个模型即使超过预算仍会保留，确保当前搜索可完成；预算只控制多个模型缓存叠加。
7. 测试新增运行时类型和 `512 * 4` byteLength 断言。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：20/20 通过。
- `npm.cmd run build:renderer`：通过，无动态/静态导入警告。

当前线性精确搜索在 I/O、重建、候选内存、评分计算和运行时向量存储方面的主要低风险优化已完成。继续显著提升需要 worker/native ANN，并应单独建立性能基线和回归窗口。

## 2026-07-11 继续优化：评分热循环与性能基线

本轮在决定是否迁移 worker 前建立可重复基线，并清理评分热循环：

1. `normalizedCosineScore` 移除每维 `Number()` 和 `|| 0` 转换；输入已经由索引/查询归一化阶段保证为有限数值，热循环直接执行乘加。
2. TopK 裁剪使用模块级分数函数，不再为每个候选创建新的箭头函数闭包。
3. 新增 `benchmark:media-search:vectors`，默认使用 20,000 个确定性的 512 维 `Float32Array`，输出耗时、吞吐、checksum、向量字节数和内存统计。
4. 可通过 `MEDIA_SEARCH_BENCH_VECTORS` 调整到 1,000 至 200,000 条，用于后续 worker/native ANN 前后对比。

本机基线：

- vectors：20,000。
- dim：512。
- 精确评分耗时：24.54 ms。
- 吞吐：约 815,036 vectors/s。
- 向量连续内存：40,960,000 bytes。
- checksum：10000.867281。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run test:media-search`：20/20 通过。
- `npm.cmd run benchmark:media-search:vectors`：通过。
- `npm.cmd run build:renderer`：通过。

结论：当前机器上纯点积评分 10 万向量理论约百毫秒级，已不是首要瓶颈。现阶段直接引入评分 worker 会增加进程启动、索引重复加载和作用域 IPC 成本，收益未被基线支持。下一轮应优先测量真实索引加载、JSON 解析、manifest `existsSync` 和结果映射，再决定 worker 或二进制持久化索引。

## 2026-07-11 继续优化：Manifest Cache 与搜索阶段计时

1. video/frame manifest 签名加入绝对路径，修复不同数据目录相同 size/mtime 时可能错误复用缓存的问题。
2. manifest 写入后同步刷新 records/count/done/ready 派生缓存，并提供显式失效入口。
3. 搜索使用 ready frame catalog，避免每次 Query 对全部帧重复 `existsSync`。
4. 最终有界候选集继续检查文件存在性，外部删除的帧不会进入结果。
5. Image/Text/Similar 响应新增 manifest/index/embedding/scoring/total 五阶段耗时，UI 显示总耗时。
6. 新增缓存目录隔离和外部删除回归测试。

验证结果：typecheck、lint、build 通过，MediaSearch 21/21 通过。下一项是 10K/100K manifest 冷/热加载 benchmark。

## 2026-07-12 Prompt Edit、Toggle 与 Image Similar

- Prompt Edit 使用 compositor transform 拖动，松开后才提交 store 位置，减少 textarea 重绘。
- 面板交互期间 overlay shape 从每帧 IPC 改为 80 ms 节流，避免 Display/LatencyInfo 队列积压。
- Ctrl+Shift+Alt+Q 增加 350 ms 去抖；全局隐藏不再被单面板 visibility lock 阻止。
- Image Search 每条结果新增 Similar，复用当前图片查询模式继续搜索。
- typecheck、lint、IPC/Preload 契约、MediaSearch 21/21 和构建通过。

## 2026-07-12 拖动 Shape 与大量结果

- 修复 80 ms shape 跟随导致所有面板分段显示的回归：交互开始扩展为完整工作区，结束后恢复精确 shape，期间不持续发送 shape IPC。
- 新增 `useProgressiveRender`。
- Image Search 初始挂载 48/80 条结果；Media Search 初始挂载 60/100 条结果，滚动时分批追加。
- 结果卡使用 `content-visibility: auto`，Media frame 图片继续按可见区域懒加载。
- typecheck、lint、MediaSearch 21/21 和构建通过。

## 2026-07-12 搜索结果虚拟化、单次 Toggle 与 TopK 对齐

- `useProgressiveRender` 已被 `useVirtualGrid` 替代。旧实现滚动后会永久保留已加载结果，新实现仅挂载可视行及上下各 3 行缓冲。
- Image Search 的 List/Large 结果和 Media Search 的 Videos/Frames 结果均使用同一套虚拟网格，窗口外的缩略图与卡片会卸载。
- 新搜索或结果集合改变时自动重置滚动位置，避免旧滚动偏移导致新结果空白。
- Media Search 视频行修复 9 个单元格仅定义 8 列造成的隐式换行，稳定单行高度以支持准确虚拟化。
- Ctrl+Shift+Alt+Q 由 Electron 主进程在首次热键回调中直接隐藏原生窗口，渲染进程只同步面板状态；再次触发直接显示并恢复状态。
- Media Search TopK 改为与 Image Search 一致的 20、50、100、200、500、1000 预设，默认 50；IPC 与搜索服务上限同步提升到 1000。
- 验证通过：typecheck、lint、guards 6/6、IPC registration 2/2、Preload contract 1/1、MediaSearch 21/21、完整 build 与 NSIS 打包。

### Toggle 二次修正

- 运行验证发现透明 Shape 窗口的 `BrowserWindow.isVisible()` 与用户实际看到的面板状态可能不一致，第一次热键因此错误进入显示分支。
- 热键改为维护明确的主进程隐藏状态：首次按键固定隐藏，第二次固定显示；`hide-window` / `show-window` IPC 同步更新同一状态。
- 不再使用 `isVisible()` 决定 Toggle 方向；350 ms 仅用于过滤同一次按键的重复回调。
- 第二轮运行验证发现 Windows 透明窗口隐藏后可能残留不可点击的最后一帧：隐藏前现在主动执行 `setShape([])`，无可见面板时渲染层也会提交空 Shape。
- 移除显示事件中重复的异步 `showWindow()`，避免延迟显示覆盖下一次隐藏；每次显示事件都强制触发 Shape 重建。

## 2026-07-12 继续优化：10K/100K Manifest Preview Cache

1. 新增 `benchmark:media-search:manifests`，覆盖 10K/100K video/frame manifest 的完整加载及 UI Preview 冷/热路径。
2. 基准确认完整 manifest 热缓存 P95 约 1.6 ms，但 Preview 每次仍完整读取 JSONL；100K Video/Frame Preview P95 分别为 82.465 ms 和 70.436 ms。
3. Video Preview 新增 1,000 条最近记录签名缓存，Frame Preview 新增 2,000 条最近记录签名缓存。
4. 完整加载、manifest 写入、显式 invalidation 与 Preview cache 已形成统一生命周期；文件签名变化会自动重载。
5. 新增读盘次数回归测试，验证同签名重复 Preview 不读盘，append 后自动失效。
6. 优化后 100K Video Preview 热加载 P95 为 2.371 ms，降低约 97.1%；Frame Preview 为 3.389 ms，降低约 95.2%。
7. 完整报告：`docs/benchmark/2026-07-12-media-search-manifest-cache-benchmark.md`。

验证结果：typecheck、lint、MediaSearch 22/22、manifest benchmark 通过。冷加载约 74–166 ms，尚未达到引入 worker 或二进制 manifest 的触发阈值。

## 2026-07-12 继续优化：Electron UI 冒烟自动化

1. 新增 `electron/uiSmokeService.ts` 与 `tests/electron-ui-smoke.cjs`，以隔离 `userData` 启动真实 Electron BrowserWindow。
2. 自动挂载 Image Search、Media Search、Remote Terminal、App Storage、Duplicate Finder 五个懒加载核心面板。
3. 同时验证 DOM 完整性、renderer console error、崩溃文本、截图尺寸和非透明像素，避免只检查“进程仍存活”的假通过。
4. 测试模式跳过全局热键和 always-on-top，并使用隔离目录；不会读取或改写用户真实布局、索引和终端配置。
5. 透明隐藏窗口截图会保留旧合成帧，已通过测试时短暂 `showInactive()` 强制重绘；正式启动路径不变。
6. 测试布局使用隔离 CSS，而不直接改写面板内联位置，避免触发布局持久化观察器。
7. 开发构建冒烟通过：5/5 面板，0 console error，0 crashed panel，3,720 ms，非透明像素抽样 155,520。
8. `win-unpacked` 打包构建冒烟通过：5/5 面板，0 console error，0 crashed panel，8,833 ms，非透明像素抽样 155,520。
9. 本机打包测试需给测试进程传入 `--no-sandbox` 才能稳定合成隐藏透明窗口；该参数不写入安装包，正式 BrowserWindow 仍为 `sandbox: true`。

验证命令：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:ipc-registration
npm.cmd run test:preload-contract
npm.cmd run smoke:ui
npx.cmd electron-builder --win --dir
npm.cmd run smoke:ui:packaged
```

完整报告：`docs/benchmark/2026-07-12-electron-ui-smoke-report.md`。

## 2026-07-12 继续优化：单实例保护与窗口恢复

1. 主进程启动阶段新增 `app.requestSingleInstanceLock()`；未获得锁的重复应用立即退出，不再重复注册全局快捷键或创建第二个透明覆盖窗口。
2. 已存在实例收到 `second-instance` 时恢复原窗口，而不是创建新窗口。
3. `appCoreIpc.ts` 新增复用入口 `revealGlobalWindow()`，统一完成以下动作：清除主进程隐藏状态、`showInactive()`、恢复置顶、通知 renderer 恢复面板。
4. 全局 Toggle 的显示分支与第二实例恢复共用同一函数，避免再次产生主进程和 renderer 重复 `show()` 的时序问题。
5. 新增 guard 回归测试，锁定实例锁、第二实例监听和窗口恢复调用，guards 由 6/6 增至 7/7。
6. Electron 开发态冒烟通过：5/5 面板，0 console error，0 crashed panel，2,772 ms。
7. 重新生成 `win-unpacked` 后打包态冒烟通过：5/5 面板，0 console error，0 crashed panel，2,666 ms。

验证命令：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:guards
npm.cmd run test:ipc-registration
npm.cmd run test:preload-contract
npm.cmd run smoke:ui
npx.cmd electron-builder --win --dir
npm.cmd run smoke:ui:packaged
```

边界：本轮刷新了 `release/win-unpacked`，未重新压缩 NSIS 安装器。单实例锁按 Electron 的 `userData` 实例范围工作；UI smoke 使用独立临时 `userData`，不会与用户正在运行的正式实例争锁。

## 2026-07-12 继续优化：启动 IPC 注册屏障

问题：主窗口此前在 IPC 注册完成前执行 `createWindow()`。renderer 如果加载较快，会在 Image Search、Media Search 或 Remote Terminal handler 尚未注册时发出请求。Remote Terminal 尤其需要先 `await loadProfiles()`，竞态窗口更明显，可能表现为首次打开面板数据为空或 `No handler registered`，刷新后又恢复。

修复：

1. 所有主功能 IPC 现在先注册，最后才执行 `createWindow()` 加载 renderer。
2. Remote Terminal profile 读取改为后台 Promise，不阻塞 BrowserWindow 创建。
3. Profile、SFTP、Transfer、Connection 四组 handler 共用同一个 `profilesReady` 屏障；只有真正依赖 profile 的请求才等待初始化完成。
4. profile 保存、删除、凭据校验、连接、SFTP 和传输请求不会再与启动读取互相覆盖。
5. 新增 IPC 启动顺序回归断言：核心 handler 必须位于 `createWindow()` 之前，四组 RemoteTerminal 模块必须等待 profile 初始化。

验证结果：

- TypeScript：通过。
- ESLint：通过，0 warning。
- Remote Terminal：4/4。
- Remote SFTP：2/2。
- Remote Transfer：4/4。
- Remote Stress：5/5，包括 200 次并发 profile 保存。
- IPC registration：3/3。
- 开发态 Electron UI smoke：5/5，2,654 ms，0 console error。
- 重新生成 `win-unpacked` 后打包态 smoke：5/5，2,695 ms，0 console error。

边界：本轮没有改变 profile 文件格式、SSH 凭据存储或 IPC channel；属于启动编排和初始化一致性优化。NSIS 安装器未重新压缩。

## 2026-07-12 继续优化：FFmpeg 首次状态准确性

问题：MediaSearch 首次 `getStatus` 以前只调用 `warmFfmpegStatusCache()` 启动后台探测，然后立即读取缓存。新进程缓存为空时会返回 `status pending`，UI 将其显示为 `ffmpeg: missing / ffprobe: missing`。探测完成后没有状态事件触发刷新，因此即使工具实际存在，也要用户手动 Refresh 才显示 `ok`。

修复：

1. `warmFfmpegStatusCache()` 改为返回共享 Promise；同一配置下的并发状态请求只执行一组 ffmpeg/ffprobe 子进程探测。
2. `mediaSearch:getStatus` 异步等待该 Promise 后再构造状态；等待期间不使用 `spawnSync`，不会阻塞 Electron 主线程。
3. 增加配置 generation。用户切换或清除 FFmpeg 目录后，旧探测即使延迟返回也不能覆盖新配置状态。
4. 用户主动保存/清除工具目录仍保留同步强制验证，确保操作结果立即明确。
5. IPC 回归测试新增首次状态必须等待异步工具发现的断言，IPC registration 由 3/3 增至 4/4。

验证结果：

- TypeScript：通过。
- ESLint：通过，0 warning。
- MediaSearch：22/22。
- IPC registration：4/4。
- 开发态 UI smoke：5/5，3,528 ms，0 console error；隔离新数据目录首次截图直接显示 `ffmpeg: ok / ffprobe: ok`。
- 重新生成 `win-unpacked` 后打包态 smoke：5/5，2,689 ms，0 console error。

取舍：首次轻量状态响应会等待异步工具探测完成，因此该 IPC 可能比旧的“立即返回 pending”慢；但 BrowserWindow 和 MediaSearch shell 不被阻塞，且用户拿到的是一次准确结果，不再需要手动刷新。

## 2026-07-12 继续优化：FFmpeg 并行预热与完整回归

1. 主进程读取已保存的 FFmpeg 配置后立即启动 `warmFfmpegStatusCache()`，不再等 MediaSearch 首次状态请求才开始。
2. 探测 Promise 与 IPC、BrowserWindow、renderer 初始化并行；状态请求到达时复用正在执行或已经完成的结果。
3. 开发态 Electron UI smoke 从上一轮 3,528 ms 降到 2,693 ms，减少约 23.7%，首次状态仍为 `ffmpeg: ok / ffprobe: ok`。
4. 启动顺序测试锁定预热必须位于 `initMediaToolConfig()` 之后、`createWindow()` 之前，防止探测错误目录或退回延迟启动。
5. 执行完整 `npm test`：全部 125 项通过，包含 guards、IPC、preload、设置、文件管理、安全、App Storage、Duplicate Finder、MediaSearch、RemoteTerminal、SFTP、Transfer、压力测试、Vector Pipeline、native rebuild 和 29 项 native 正确性测试。
6. Node 24 的 `DEP0190` 调用栈已定位到 `node-gyp 13` 的 Python 探测 `node-gyp/lib/util.js`。项目 `scripts/build-native.cjs` 本身使用 `spawnSync(..., shell: false)`；不修改 `node_modules` 隐藏上游警告。
7. 重新生成 `win-unpacked` 后打包态 UI smoke 5/5 通过，0 console error。该次刚重写 ASAR 后冷启动为 8,576 ms，功能正常；后续性能比较应使用多次 P50/P95，而不是单个冷样本。

验证命令：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:ipc-registration
npm.cmd run smoke:ui
npm.cmd test
npx.cmd electron-builder --win --dir
npm.cmd run smoke:ui:packaged
```

当前发布验证剩余项缩小为：重新压缩 NSIS 安装器并执行安装/卸载人工 smoke，以及使用真实素材建立 Recall@K 准确率报告。

## 2026-07-12 继续优化：正式 NSIS 与归档 Smoke

1. `npm audit --audit-level=moderate`：0 vulnerabilities。
2. `npm run build` 全链路通过，重新生成 renderer、main、preload、workers、Electron ABI native、`win-unpacked` 和 NSIS。
3. 最新 `win-unpacked` GUI smoke：5/5 面板，0 console error。
4. 新增 `smoke:installer:archive`，使用 electron-builder 7-Zip 对 NSIS 数据执行完整性测试并生成 JSON 报告。
5. 安装包 193 个归档文件全部通过，结果 `Everything is Ok`。
6. 最新安装包大小 804,104,029 bytes（766.85 MiB），SHA-256 为 `6DB0164CD88D04827AD507BC9DFF74B77BF3165B1C8C1AA2380BAA3D30B87E9F`。
7. Authenticode 状态为 `NotSigned`，仍使用默认 Electron 图标；这两项属于正式发布品牌/信任项。
8. 验证后按既定规则清理 `release`，当前只保留 `FloatingClock Setup 1.0.0.exe`。

没有在宿主机执行静默安装/卸载，因为生产 NSIS 会修改 HKCU 卸载项和桌面快捷方式。该项保留给干净 Windows VM。完整报告：`docs/benchmark/2026-07-12-release-installer-verification.md`。

## 2026-07-12 继续优化：真实素材 Recall@K

1. 新增 `benchmark:media-search:recall`，直接读取现有帧清单和 Frame Index，不重新生成 embedding、不修改用户数据。
2. 使用 Same Video 与 Adjacent 两类自动 ground truth，输出 Recall@1/5/10/20/50、MRR、索引加载和精确评分耗时。
3. 当前数据覆盖 9,423 帧、915 个视频、801 个可评估视频；manifest/index/vector 错误均为 0。
4. DINO Same Video R@10 为 94%，Adjacent R@10 为 79%；CLIP 分别为 98% 和 82%。
5. DINO Adjacent R@1 为 37%，高于 CLIP 的 27%，因此默认以图搜视频继续使用 DINO 合理。
6. 259.5 MB JSONL 索引加载约 755 ms，低于 1 秒二进制索引触发阈值。
7. DINO/CLIP 精确评分 P95 分别约 7.76 ms 和 5.53 ms，远低于 250 ms ANN 触发阈值。
8. 两次运行 Recall/MRR 完全一致；当前不引入二进制 Frame Index 或 native ANN。

完整报告：`docs/benchmark/2026-07-12-media-search-real-recall-baseline.md`。剩余准确率工作仅为人工标注的文本语义查询集，不能用 Same Video 自动标签替代。

## 2026-07-12 继续优化：人工文本语义标注集

1. 新增 12 个中英配对概念，覆盖人物、动物、动漫、游戏、截图、文档、广告、食物和自然场景。
2. 从现有 9,423 帧 CLIP Index 生成 1,748 个去重候选，合并中英 TopK、路径词法命中和固定随机负样本。
3. 新增本地人工标注页面，支持相关、不相关、不确定、键盘快捷键和断点继续。
4. 标签通过串行化原子写入保存；图片接口仅服务候选白名单，服务只监听 localhost。
5. 新增评测器，按中英文输出 Precision、Judged Precision、Pooled Recall 和 nDCG（@10/@20/@50）。
6. `annotation:text:smoke` 已验证状态 API、真实帧读取和错误请求处理。
7. 当前人工判断仍为 0，不能声明文本语义准确率已达标；下一步是完成人工标注并冻结基线。

完整说明：`docs/benchmark/2026-07-12-media-search-text-annotation-dataset.md`。

### 人工标注效率与评测防误报优化

1. 标注页面默认跳过已明确判断项，并预加载下一张候选；分类与全局进度实时显示。
2. 增加清除当前标签和 `Ctrl+Z` 撤销，降低快速键盘标注的误操作成本。
3. `unsure` 不计入完成度，并会作为待复核项重新出现。
4. 未完整覆盖 TopK 时 Precision 为 `null`；候选池未完整判断时 Pooled Recall、nDCG 为 `null`。
5. 报告增加 coverage、readyConcepts 与 publishable，阻止零标签或部分标签被误报为正式准确率。
6. 保存队列可从单次磁盘写入失败中恢复，指标 readiness 已纳入 HTTP smoke。

### TopK 优先调度与聚合指标

1. 默认标注顺序调整为 Top10、Top20、Top50、其余候选四级队列。
2. 每一级在 12 个概念之间轮转，优先建立跨概念可比较的 Precision@K。
3. UI 实时显示当前概念的中英文联合 Top10/20/50 覆盖情况，可关闭评测优先并按分类处理。
4. evaluation 新增英文、中文独立的宏平均 Precision、Judged Precision、Pooled Recall 和 nDCG。
5. 每组聚合指标记录 readyConcepts；正式宏平均 Precision/Recall/nDCG 未达到覆盖门槛时保持 `null`。Macro Judged Precision 明确作为部分标注观察值单独保留。

### 数据集完整性与标注审计

1. 候选集生成稳定 SHA-256 指纹，当前指纹为 `b5434b8240113b8ccd75081ccdcf57963a411a1c4a70703829b54f3ac61cf752`。
2. `annotation:text:status` 校验重复概念/候选、排序越界、非法标签、陈旧标签和候选图片缺失。
3. 当前真实数据校验结果：1,748 个候选，0 缺失文件、0 陈旧标签、0 错误、0 warning。
4. 完整性错误会强制 `publishable: false`，防止标签与候选版本错配后发布错误结果。
5. 每次标签变更写入 `judgment-events.jsonl`，记录时间、数据集指纹、前值和后值。
6. 完整文件系统校验只在加载、status 和 evaluate 时执行；单次保存只做常数时间计数更新。

### 标签备份与受保护恢复

1. `annotation:text:backup` 生成同时包含数据集和标签指纹的独立快照。
2. 已有人工标签时，标注服务启动自动备份；相同指纹不会重复建立快照。
3. 默认只保留最近 20 个快照，避免长期标注产生无界存储增长。
4. `annotation:text:restore -- <backup-file> --confirm` 只允许恢复备份目录内文件。
5. 恢复前校验数据集指纹、标签结构和陈旧项，并自动备份恢复前状态。
6. 缺少确认参数和目录逃逸测试均已通过；当前标签文件未在测试中改写。

### 标注进度与动态 ETA

1. 标注页增加整体进度条、百分比、当前 TopK 阶段和本次会话速度。
2. 完成至少 2 个明确判断后，按实际标签间隔计算剩余 ETA；暂停或新会话不会沿用失真的旧速度。
3. `annotation:text:status` 同步输出四阶段完成数。
4. 当前工作量：Top10 230、Top20 增量 229、Top50 增量 674、其余候选 615，总计 1,748。
5. 阶段总数与候选池一致，UI 脚本语法、status 和 HTTP smoke 均通过。

### 标注服务 HTTP 与日志可靠性

1. 异步 HTTP handler 增加统一异常边界，文件和磁盘异常不再产生未处理 Promise。
2. 图片读取增加流错误处理，`existsSync` 后文件被删除也不会中断服务进程。
3. 请求增加对象类型校验；非法 JSON、`null` 和超过 4 KiB 的 body 分别返回 400/413。
4. 响应增加 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Cache-Control: no-store`。
5. `judgment-events.jsonl` 达到 5 MiB 自动轮转，最多保留 5 个历史文件。
6. HTTP 加固 smoke、status、Node 语法和 ESLint 均通过。

### 启动门禁与优雅关闭

1. 标注服务在监听端口前检查候选和标签完整性；错误状态只允许先通过 `annotation:text:status` 排查，不进入写入流程。
2. `SIGINT/SIGTERM` 触发停止接收请求，并等待当前原子写入队列完成后关闭连接。
3. 合成夹具验证有效数据可用，非法标签和缺失图片会触发完整性失败。
4. 真实 1,748 项数据继续通过门禁；Node 语法、HTTP smoke、status 和 ESLint 均通过。

## 2026-07-13 审计 P1 整改闭环

本轮按 `docs/audits/2026-07-13-project-multidimensional-audit.md` 完成全部 4 项 P1，当前无已知 P0/P1：

1. File Manager 覆盖复制/移动改为事务提交：新内容先写入目标同级 prepared path，旧目标改名备份，提交失败自动恢复。新增文件、目录、失败回滚和跨设备相关测试。
2. Vector JSONL 写队列支持失败恢复、完整快照补偿、`flush()` 和持久化健康状态；单行损坏写入 corruption report，其余记录继续加载；孤儿清理由循环重写改为每个 store 一次批量删除。
3. 模型下载改为流式 pipeline、增量 SHA256、背压、节流进度和 AbortSignal。状态查询不再反复读取下载中的大文件，已安装模型通过 stat/摘要 sidecar 避免每次重新哈希。
4. 安装包排除 legacy 重复 CLIP 和非 Windows x64 ONNX Runtime；发布清理脚本仅在预期安装包存在时执行，最终 `release/` 只保留安装包。
5. `verify` 现包含 typecheck、lint、format check、完整 tests 和 Renderer build；原 17 个格式问题已清零。

最终验证基线：

```text
Tests:             138/138 passed
Packaged UI smoke: 5/5 panels, 0 console errors, 5,937 ms
Archive smoke:     174 files, Everything is Ok, 10,287 ms
Installer size:    603,696,333 bytes (575.73 MiB)
Installer SHA256:  9B6BEB48960D0BC1ADFC7D1368619EADFB7305AC86CEB7418CAD278DE0D51C1C
Release contents:  FloatingClock Setup 1.0.0.exe only
npm audit:         0 vulnerabilities (moderate threshold)
```

下一阶段只处理 P2/P3：完成人工文本语义标注、在干净 Windows VM 验证安装/升级/卸载、配置正式图标与签名、合并重复布局实现、按职责拆分大模块并逐步拆分共享 IPC 契约。不要在没有新性能证据时提前替换 Frame Index 或引入 ANN。

## 2026-07-13 Image/Media Search 简单模式与高级模式

专项实现说明：[Image Search / Media Search 简单与高级模式](../designs/2026-07-13-search-experience-modes-design.md)。

为降低首次使用时的操作成本，Image Search 和 Media Search 已统一增加两级使用模式：

1. 默认进入 `Simple`，只显示路径、查询和一键准备素材库所需的核心控件。
2. `Advanced` 保留原有扫描方式、模型、CPU/GPU、索引、缓存和维护控件。
3. 两个面板分别持久化用户的模式选择；任务运行期间锁定模式切换，避免中途卸载控制器或改变任务参数。
4. 公共 `SearchExperienceModeBar` 和 `SearchSetupProgress` 统一模式切换、步骤、总进度、错误和取消反馈。

Image Search 的 `Prepare Library` 串行执行：

1. 更新扫描所选图片路径。
2. 检查并准备 DINO 模型。
3. 补齐缺失的 DINO embedding。
4. 检查并准备 CLIP 模型。
5. 使用保存的 GPU 路数补齐缺失的 CLIP embedding。
6. 构建 DINO 向量索引。

Media Search 的 `Prepare Library` 串行执行：

1. 扫描所选视频路径和元数据。
2. 提取视频关键帧。
3. 检查并准备 DINO 模型，稳定路径默认使用 CPU 构建帧 embedding。
4. 检查并准备 CLIP 模型，使用 GPU 和受控路数构建帧 embedding。
5. embedding 完成后的现有异步 Frame Index 更新继续生效，搜索范围仍由所选路径约束。

任务可靠性处理：

- 一键流程复用现有 IPC、扫描器、模型下载器和 embedding 服务，不建立第二套索引或数据目录。
- 公共 workflow 状态机将子任务进度映射到总进度，并支持失败短路、AbortSignal 和显式停止。
- Image Search 停止会同时停止扫描、embedding 和模型下载；Media Search 停止会同时停止媒体任务、embedding 和模型下载。
- embedding 枚举阶段增加取消检查，取消后的旧任务不会在目录枚举结束后重新切回 `running`。
- Media Search 在 FFmpeg/FFprobe 不可用时不会启动半成品流程，而是明确提示切换高级模式配置工具目录。

验证结果：

```text
Search workflow tests: 5/5 passed
Media Search tests:     27/27 passed
Full verify:            143/143 passed
Development UI smoke:   5/5 panels, 0 console errors, 2,957 ms
Mode checks:            Image/Media default Simple, Advanced visible, Simple restored
Renderer build:         112 modules, passed
```

完整 `verify` 首次失败不是代码回归，而是 21:20 启动的开发版 Electron PID `133444` 正在加载 `fast_scanner.node`，Windows 因此拒绝 node-gyp 覆盖文件。使用 `tasklist /m fast_scanner.node` 定位并关闭该旧实例后，Native rebuild、29 项 Native 测试和 Renderer 构建全部通过。以后执行 Native rebuild 前应先关闭加载该模块的开发实例。

发布边界已于 2026-07-14 闭环：最新双模式和 Image Large 已重新打入 NSIS，并通过 packaged UI 与归档完整性验证；旧 575.73 MiB 数据只保留为历史基线。

### Image Search 固定 Large 结果视图

1. 删除 Image Search 的 `list | large` 状态和 View 下拉框，旧配置不再可能把结果切回 List。
2. `ImageSearchResultGrid` 固定使用 180 px 最小列宽、226 px 行高、150 x 150 缩略图和四按钮底部网格。
3. 继续使用 `useVirtualGrid`，固定 Large 不会恢复视口外缩略图的全量渲染。
4. Media Search 的 Videos/Frames 结果视图保持原样。
5. UI smoke 新增 `listViewOptionAbsent`，最新结果为 5/5 面板、0 console error、2,927 ms。

## 2026-07-14 最新 NSIS 发布闭环

1. 完整 `verify` 再次通过：143/143 tests、typecheck、lint、format 和 Renderer build 全部成功。
2. 生成包含 Simple/Advanced 和 Image Large 的 `FloatingClock Setup 1.0.0.exe`。
3. packaged UI smoke 通过：5/5 面板、0 console error、8,972 ms；Image List 选项不存在。
4. 安装包归档检查通过：176 个文件、5,816 ms、退出码 0。
5. 最新安装包为 603,920,601 bytes（575.94 MiB），SHA-256 为 `1D8A74FC2ADA9802D2670B13AD1C573DC95C5A764007188691D786CEFFAEA9DE`。
6. `release:clean` 已删除 `win-unpacked`、blockmap 和构建元数据，`release/` 只保留安装包。
7. Authenticode 仍为 `NotSigned`；干净 VM 安装、升级、卸载仍是独立 P2 发布项。

完整报告：`docs/benchmark/2026-07-14-release-installer-verification.md`。

## 2026-07-14 React Hooks 与工具链门禁闭环

1. 安装 `eslint-plugin-react-hooks`，启用 `react-hooks/rules-of-hooks` 和 `react-hooks/exhaustive-deps`。
2. `npm run lint` 从仅检查 `src/ electron/ shared/` 扩展到同时检查 `tests/ scripts/`。
3. CLI 测试和构建脚本允许使用 `console` 输出，但仍保留其余 ESLint 规则；两个真实脚本错误已修复。
4. 初次启用 Hooks 规则发现 14 个依赖警告，现已全部清零：稳定化面板尺寸、文件管理激活回调、远程凭据对象，并修复分页偏移、目录刷新、watcher 和联动面板的陈旧闭包风险。
5. 完整 `npm.cmd run verify` 在 48.3 秒内通过：typecheck、0-warning lint、format、143/143 tests 和 Renderer/Electron 构建全部成功。
6. 575.94 MiB 安装包生成于本轮源码修复之前。本轮按“避免重复长时间打包”的约束未重建 NSIS；下次正式发布需重新执行 packaged UI smoke 和安装包归档 smoke。

## 2026-07-15 NekoSearch 多维审计交接

以下内容是 2026-07-15 的历史快照；其中单中心、1024 符号桶、事务和 catalog 等状态已有后续整改，当前结论以本文件后续日期章节及[当前实施基线](2026-07-14-neko-search-implementation.md)为准。

1. 综合健康度 68/100；当前纵向功能闭环约 78%，完整分类方案约 55%。
2. 已验证基础能力：素材同步、分类/标签、外部参考图、建议审核、聚类入口、软归档、反馈搜索首轮链路、虚拟网格和 typed IPC。
3. 发布阻断项：同步取消不回滚、长任务与普通写操作竞态、跨 JSONL 非事务、180K catalog 主进程全量排序、数 GB 向量主进程解析、反馈搜索未过 A/B 却默认启用。
4. 准确率阻断项：参考图仍使用单中心；聚类依赖最多 1024 个符号桶；缺少固定人工标注集和真实聚类 purity/coverage 基线。
5. 安全重点：Image Search manifest 解析允许极端 section 分配，应限制来源、总字节和主进程内存预算。
6. 下一步顺序：一致性事务 -> SQLite catalog -> worker/binary ANN -> 准确率门禁 -> UI 纠错闭环 -> Duplicate/Media Search 接入。
7. 审计验证通过：NekoSearch 13/13、IPC 注册 4/4、preload 1/1、typecheck、lint、Renderer build、UI smoke、依赖安全 0 high vulnerability。
8. 未验证：真实库全量建议/聚类写入任务、故障注入恢复、NSIS 重打包和干净 VM 安装。

完整问题位置、真实库规模和验收标准见[2026-07-18 NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)。

## 2026-07-16 NekoSearch 第一批整改

1. 同步改为临时快照提交，取消后内存和磁盘保持上次成功状态。
2. 普通写 IPC 串行化并与长任务互斥；审核增加 active asset/target 校验和 `suggestionId` 撤销绑定。
3. 新资料库 Search Learning 默认关闭，新增显式 `Learning` checkbox，关闭时不自动后台重建。
4. index parser 新增 100 万记录、路径区、segment/manifest/overlay 字节、segment 数量和目录逃逸限制。
5. Assets 查询增加 200ms 去抖、过期响应丢弃和有界分页候选堆。
6. 180,034 active 素材名称排序由约 493.4ms 降到平均 55.3ms，大小排序由约 126.7ms 降到 8.9ms。
7. 验证通过：NekoSearch 16/16、IPC validation 4/4、IPC registration 4/4、preload 1/1、typecheck、lint、format、Renderer build、Electron UI smoke 3917ms/0 console error。
8. 下一步：SQLite 事务 catalog、向量 worker/ANN、参考图多 prototype、聚类 lineage 和固定准确率 A/B。
9. 已生成整改版 `FloatingClock Setup 1.0.0.exe` 并通过归档 smoke：606,669,677 bytes（578.57 MiB）、176 files、SHA-256 `C6341E80D060C940F3BD090DF07261928F5FC25ED804962B6BDE60DA168756DC`；packaged UI 与干净 VM 安装尚未执行。

## 2026-07-16 NekoSearch 第二批整改

1. embedding JSONL 改为 1MiB 逆序分块读取，重复路径采用最新追加记录，单行限制 4MiB。
2. 参考分类改为多 prototype 最佳模式匹配，并把实际命中代表图写入 suggestion evidence。
3. Reference/Tag TopK 候选改为最小堆；聚类上限改为 active 素材计数。
4. 手动参考图任务前重新 `stat`，mtime/size 变化会失效缓存，删除会持久化 missing。
5. NekoSearch 长任务增加平滑 ETA 显示。
6. 真实 3.81GiB DINO 文件短基准：最新 2,000 个唯一向量 187ms，处理 31.56MiB，heap +0.22MiB。
7. 验证通过：NekoSearch 19/19、Vector 16/16、typecheck、lint、format、Renderer/Electron build、UI smoke 3813ms/0 console error。
8. 健康度估算提升到 77/100；下一步仍是 SQLite 事务 catalog、向量 worker/ANN、正式聚类 lineage 和固定准确率 A/B。

## 2026-07-16 NekoSearch 第三批整改

1. 分类专属 `referenceThreshold` 已持久化，旧分类默认 0.82；批量参考分类逐分类取值。
2. 新增 `jsonLinesTransaction.ts`：同盘 staged snapshots、写前 journal、启动恢复和 action 异常内存回滚。
3. 分类/标签删除、建议确认/撤销、聚类替换和聚类转分类已接入多 store 恢复事务。
4. 聚类自动创建分类也进入同一事务，不再留下先落盘的空分类。
5. NekoSearch 专项测试 23/23；IPC 4/4、preload 1/1、Vector 16/16、typecheck、lint、format 均通过。
6. Renderer/Electron build 和六面板 UI smoke 通过：3646ms，0 console error，Neko chunk 29.62kB/gzip 7.89kB。
7. 健康度估算提升到 80/100；SQLite catalog、向量 worker/ANN、聚类 lineage 和真实标注 A/B 仍为下一阶段。

## 2026-07-16 NekoSearch 第四批整改

1. 新增 `assetCatalogProjection.ts`，使用 Electron/Node 内置 `node:sqlite`，不增加第三方原生依赖或模型体积。
2. `assets.jsonl` 继续作为权威源；`asset-catalog.sqlite` 只做可重建查询投影，按 JSONL/state/archive 指纹和行数校验，失败自动回退内存列表。
3. 无分类/标签/未分类条件的 Assets 分页已下推 SQLite；关系筛选仍走原 Map，行为保持兼容。
4. 18 万条合成基准：首建 2172.92ms、投影 50.73 MiB；最新页 2.45ms；offset 90,000 名称页 9.78ms；路径子串 30.89ms（中位）。
5. FTS5 trigram 试验因首建增至约 14.9s且查询无改善已撤销，保留严格子串搜索。
6. 修复 `dist-electron` 历史哈希 chunk 累积：主入口先清空、preload/worker 后追加；TypeScript build info 移到 `node_modules/.cache`；输出由数百文件收口到 8 文件、366,472 bytes。
7. 验证通过：NekoSearch 24/24、IPC validation 4/4、IPC registration 4/4、preload 1/1、typecheck、lint、完整构建和六面板 UI smoke（3793ms，0 console error）。
8. 健康度估算提升到 83/100。下一步：SQLite 关系表迁移、向量 worker/ANN、固定标注 A/B、聚类 lineage 和完整故障/发布验证。
9. 清理输出后重新生成 NSIS：600,654,760 bytes（572.83 MiB），归档 smoke 通过，SHA-256 `FC88D99B2CCFADB51C778386AE02947B2A1921304550023AFBC93600B3018BDD`；`release/` 仅保留该安装包。

## 2026-07-18 NekoSearch Clusters 质量整改

1. 旧的 10-bit 符号桶方案已停止使用。旧实现最多形成 1,024 个桶，桶内成员共享分数和代表图，容易把视觉内容不同的素材混入同一大组。
2. 新增 DINO Float16 缓存顺序读取能力，保持路径与向量逐行映射，Clusters 不再为每次重算重复解析数 GiB embedding JSONL。
3. 新算法先用 12-bit 微桶和加权 K-Means 做粗路由，再逐张读取真实 DINO 向量，以原始 cosine 执行第二阶段纯度过滤；不达阈值的素材保持未分组。
4. 平均相似度改为实际保留成员的真实分数，代表图改为最接近组中心的成员。
5. UI 默认值为 `Groups 96`、`Min size 5`、`Purity 0.76`，Groups 上限为 256；内容仍杂时优先提高 Purity 到 0.80-0.85。
6. 真实缓存只读基准处理 200,000 个 DINO 向量：约 28.3 秒，得到 60 个有效组，保留 35,258 个高置信成员，coverage 17.63%，平均 cosine 0.8531，最低 0.76。
7. NekoSearch 专项测试 30/30 通过，新增 Float16 路径/向量映射和粗路由后逐图剔除离群成员回归；typecheck、lint、format、IPC 与 UI smoke 均通过。
8. 用户在实际素材库重算后反馈“效果好多了”，证明大杂组问题明显缓解。该反馈是定性验证；下一阶段仍需固定标注集 purity/coverage、重算稳定性、组 lineage，以及手动合并/拆分。
