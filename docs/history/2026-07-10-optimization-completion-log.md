# 优化完成记录 - 2026-07-10

## 本轮已完成

1. IPC 完整性回归
   - 新增 `tests/ipc-registration.test.cjs`。
   - 校验 preload 暴露的 invoke channel 与 main process handler 一致。
   - 已加入 `npm test`。

2. 路径与 shell 能力收口
   - 强化 `safeShellPath`，拒绝空路径、控制字符、NUL、URL scheme、`.`、`..`。
   - 新增 `openSafeShellPath` / `revealSafeShellPath`，统一封装 `shell.openPath` 与 `showItemInFolder`。
   - 替换 AppCore、AppStorage、DuplicateFinder、FileManager、ImageSearch、MediaSearch 中的直接 shell 打开路径。
   - 补充负向测试，非法路径不会触发 shell 调用。

3. RemoteTerminal profile 校验
   - 新增统一 normalize/validate。
   - 限制 id、host、port、authType、privateKeyPath、hostFingerprint、tags 等字段。
   - 修复 profile path 全局缓存导致多 userDataPath 测试互相污染的问题。
   - 补充非法字段拒绝和 private key profile 规范化测试。

4. MediaSearch 打开与运行时性能
   - 面板仍保持 lazy chunk。
   - 首次打开只显示轻量 shell，完整面板改为 idle 挂载。
   - 后台大面板预加载从并发 `Promise.all` 改成延迟、idle、串行加载，降低打开 MediaSearch 时的主线程竞争。
   - cache stats 加 10 秒缓存，clear cache/data 强制刷新，避免频繁递归统计目录。
   - overlay shape 从 200ms 固定 DOM 扫描改为 ResizeObserver + MutationObserver + 1500ms 兜底。

5. Renderer 分包
   - ImageSearch、MediaSearch、RemoteTerminal、AppStorage、DuplicateFinder 均为 lazy chunk。
   - 当前构建中主 renderer chunk 约 265 KB，MediaSearch 独立 chunk 约 33.9 KB，ImageSearch 独立 chunk 约 50.6 KB，RemoteTerminal 独立 chunk 约 42.7 KB。

6. Calculator 安全
   - `safeEval` 移除 `new Function`。
   - 改为手写算术表达式 parser，仅支持数字、空白、括号、`+ - * /` 和兼容的旧运算符乱码输入。
   - 新增 `tests/safe-eval.test.cjs` 并加入 `npm test`。

7. 维护噪音清理
   - 清理 ImageSearchPanel 中残留的乱码分隔注释。
   - 源码扫描未再发现 `鈹`、`鈺`、`鈫`、`鈥`、`new Function`、`eval(`。

## 已验证

已通过以下验证：

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd audit --audit-level=high
npm.cmd run build
```

结果：

- TypeScript 检查通过。
- ESLint 通过。
- 完整测试链通过，包括 native build 与 native correctness 测试。
- `npm audit --audit-level=high` 显示 `found 0 vulnerabilities`。
- Windows 打包构建完成，输出到 `release/`。

## 本轮未自动拆分的高风险长期项

以下属于架构级大改，当前没有在自动优化中直接拆分，避免引入大面积回归：

1. `src/stores/useStore.ts` 完整拆分为 slices。
2. `semanticSearchService.ts` / `embeddingService.ts` 深度拆分为多服务。
3. JSONL 存储升级为 SQLite/RocksDB/LMDB 等本地索引。
4. Electron UI smoke 自动化测试框架。

这些项建议单独建分支推进，每项都需要更细的迁移测试和回归窗口。

## 继续优化进度

2026-07-10 后续继续按审计文档推进，新增完成：

1. Preload contract 回归
   - 新增 `tests/preload-contract.test.cjs`。
   - 使用 TypeScript AST 比对 `shared/ipc-contract.ts` 的 `ElectronAPI` 与 `electron/preload.ts` 的 `api` 实现。
   - 已加入 `npm test`。

2. MediaSearch 复用抽取
   - 新增 `electron/mediaSearchVectorMath.ts`。
   - 统一 `normalizeFrameKey`、`cosineScore`、frame vector dim、vector normalize。
   - 替换 `videoFrameSearchService`、`videoFrameService`、`mediaSearchFrameIndex` 中的重复实现。

3. MediaSearch 图片按需加载
   - 新增 `mediaSearch:getFrameImageDataUrl` IPC。
   - 搜索结果不再默认携带批量 `imageDataUrl`。
   - `MediaSearchResultsView` 改为 `IntersectionObserver` 可见后按需请求单张 frame image。

4. Frame index meta
   - `frame_embedding_index.jsonl` 旁新增 `frame_embedding_index.meta.json`。
   - 记录 manifest / embedding shard 签名、entries、errors、builtAt。
   - freshness 优先使用 meta source signature，旧索引仍保留 mtime fallback。

5. Benchmark 与 native 产物治理
   - 新增 `benchmark:media-search` 与 `benchmark:media-search:ipc-scan` npm scripts。
   - 新增 `docs/benchmark/README.md`。
   - `.gitignore` 补充 `native/build-electron/`、`native/build-node/`。
   - 新增 `docs/reference/native-build-artifacts.md`。

6. IPC 权限边界文档
   - 新增 `docs/reference/ipc-capability-matrix.md`。
   - 将 IPC 能力分为 R/W/FS/EXT/PROC/NET/SECRET。
   - 固化新增 IPC 前的检查清单。

7. Model registry 起步
   - 新增 `electron/modelRegistry.ts`。
   - 集中 DINO/CLIP 的 dim、child entry、默认 backend、能力标签。
   - MediaSearch frame vector dim 与 query embedding child 入口已改为读取 registry。

8. Shared IPC contract 拆包
   - 新增 `shared/ipc/media-search.ts`，承载 MediaSearch 领域类型与 channel 常量。
   - `shared/ipc-contract.ts` 删除 MediaSearch 旧内联定义，改为 type import + re-export。
   - `shared/ipc-contract.ts` 从约 1269 行降至约 973 行，MediaSearch 领域类型独立为约 272 行。
   - `tests/preload-contract.test.cjs` 与 TypeScript 检查覆盖拆包后的 ElectronAPI 聚合契约。

9. Panel registry 起步
   - 新增 `src/config/panelRegistry.ts`。
   - ImageSearch、MediaSearch、RemoteTerminal、AppStorage、DuplicateFinder 的 lazy loader、可见性 key、错误边界名、预加载顺序集中配置。
   - `src/App.tsx` 删除五段重复 lazy panel JSX，改为 registry map 渲染。

10. Model registry 继续接入
   - `semanticSearchService` 的 CLIP embedding dim 改为读取 `modelRegistry`。
   - `embeddingService` 的 child process entry 与 GPU backend 判断接入 `modelRegistry`。
   - 新增模型时需要修改的硬编码点继续减少。
