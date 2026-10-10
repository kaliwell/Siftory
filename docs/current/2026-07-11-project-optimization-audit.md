# FloatingClock 项目优化方向审计 - 2026-07-11

> 状态：历史快照
> 实施状态：2026-07-11 审计基线
> 基线日期：2026-07-11  
> 最后更新：2026-07-12  
> 配套交接：[2026-07-12 优化交接](2026-07-12-optimization-handoff.md)

## 1. 文档目的

本文档记录 2026-07-11 的真实代码状态、已关闭问题、剩余风险和下一阶段优化方向。后续优化应以本文为基线，不再重复执行旧文档中已经完成的 main.ts 拆分、面板 lazy load、IPC 完整性、safeEval 替换和 MediaSearch 同步索引优化。

本阶段不实现 NekoSearch 智能素材分类新功能，优先完成现有功能的性能测量、准确率回归和自动化验收。

## 2. 审计范围与证据

范围：

- Renderer：`src/`
- Electron 主进程、IPC、服务和 child process：`electron/`
- IPC 类型契约：`shared/`
- 自动化测试与 benchmark：`tests/`
- 构建和发布配置：`package.json`、`vite.config.mjs`
- 当前进度文档：`docs/current/2026-07-12-optimization-handoff.md`

本轮直接执行：

```text
npm.cmd run test:ipc-registration   2/2 passed
npm.cmd run test:preload-contract   1/1 passed
npm.cmd audit --audit-level=high    found 0 vulnerabilities
```

最近连续验证：

```text
npm.cmd run typecheck               passed
npm.cmd run lint                    passed
npm.cmd run test:media-search       20/20 passed
npm.cmd run build:renderer          passed
npm.cmd run benchmark:media-search:vectors
```

向量评分基线：20,000 x 512 维，24.54 ms，约 815,036 vectors/s，checksum 10000.867281。

## 3. 当前规模快照

| 区域 | 约文件数 | 约行数 | 说明 |
| --- | ---: | ---: | --- |
| `src/` | 69 | 17,912 | React UI、store、面板和样式 |
| `electron/` | 约 80 | 18,825 | IPC、索引、模型、扫描、终端和文件服务 |
| `shared/` | 3+ | 1,672 | IPC 聚合契约及领域契约 |
| `tests/` | 22 个 test 文件 | 3,995 | 服务、守卫、契约、native 和固定样本 |

关键事实：

- `electron/main.ts`：268 行，已不直接承载业务 IPC。
- 最大服务：`semanticSearchService.ts` 约 1,232 行、`embeddingService.ts` 约 1,131 行。
- 最大 UI：`useStore.ts` 约 1,139 行、`RemoteTerminalPanel.tsx` 约 1,057 行。
- `shared/ipc-contract.ts` 约 1,034 行，MediaSearch 契约已开始独立拆包。
- `mediaSearchFrameIndex.ts` 约 597 行，是后续持久化索引演进的主要边界。

## 4. 总体健康度

| 维度 | 评分 | 判断 |
| --- | ---: | --- |
| 结构 | 94/100 | main 和 IPC 已按领域拆分，剩余是大服务内部职责偏多 |
| 逻辑正确性 | 93/100 | 固定向量、TopK、scope、并发重建均有回归；缺真实素材标注集 |
| 性能 | 92/100 | 同步索引加载/重建已移除；manifest JSON 和逐文件检查仍可能成为瓶颈 |
| 安全 | 95/100 | sandbox、契约校验、路径守卫、凭据保护和 0 高危漏洞状态良好 |
| 复用 | 92/100 | scope、vector math、TopK、model/panel registry 已形成公共边界 |
| 可扩展性 | 91/100 | 新模型和新面板已有注册入口；JSONL 数据层仍限制大规模扩展 |
| 测试与发布 | 92/100 | 服务和契约覆盖较强；缺 Electron GUI smoke 与真实安装包自动验收 |

综合健康度：约 93/100。当前属于稳定可用、可继续迭代状态，不存在阻断发布的 P0 代码问题。

## 5. 已关闭的旧问题

以下旧审计项已经完成，后续不得继续作为“未完成任务”重复推进：

1. `electron/main.ts` IPC 拆分：已完成，当前 268 行。
2. ImageSearch、MediaSearch、RemoteTerminal、AppStorage、DuplicateFinder lazy chunk：已完成。
3. dynamic/static import warning：已消除。
4. IPC 注册完整性和 Preload 契约测试：已建立并通过。
5. `safeEval` 动态执行：已替换为手写表达式解析器。
6. shell path 统一封装、RemoteTerminal profile 校验：已完成主要加固。
7. MediaSearch frame index 同步加载和同步重建：交互路径已改为异步流式处理。
8. DINO/CLIP 完成后同步重建卡顿：已改为异步、并发合并。
9. 全量候选对象和全量排序：已改为有界 TopK。
10. 每候选完整余弦范数计算：已改为单位向量点积。
11. 运行时 `number[]` 向量：已改为 `Float32Array`，并增加 256 MB 多模型缓存预算。

## 6. 当前真实问题

### 6.1 P0：无阻断项

当前没有需要紧急修复的数据破坏、安全高危或核心功能不可用问题。

### 6.2 P1：需要优先测量和优化

#### A. Manifest 重复同步解析

`loadVideoManifest()` 和 `loadVideoFrameManifest()` 仍存在 `readFileSync(...).split()`。搜索、统计、构建和 UI refresh 可能重复读取同一个 JSONL。

方向：

- 建立基于 `size + mtime` 签名的只读 manifest cache。
- 交互搜索使用缓存快照；扫描写入或 Clear Video Data 时显式失效。
- 大 manifest 首次加载增加异步 reader，避免主进程长阻塞。

验收：10 万 frame manifest 冷加载、热加载分别记录耗时；热加载目标小于 20 ms。

#### B. 搜索前逐帧 `existsSync`

Image/Text search 当前会对 scope 内每个 frame image 执行存在检查。机械盘、网络盘或大量小文件会放大延迟。

方向：

- manifest cache 同时维护 ready frame catalog。
- 搜索阶段先信任 `status=done` 与 catalog；只对最终 TopK 结果做存在复核。
- 发现丢失文件时异步标记 stale，不在主搜索循环阻塞修复。

验收：结果不得返回已删除图片；10 万条 manifest 搜索准备阶段不执行 10 万次同步 stat。

#### C. 真实素材准确率基准缺失

当前 fixed samples 能验证算法没有回归，但不能证明真实语义质量。

方向：

- 建立不含隐私素材的固定图片/视频查询集。
- 每个查询记录 expected Top10/Top50、最低命中数和允许误差。
- 分开统计 DINO 以图搜图、CLIP 以图搜图、CLIP 文本搜索。
- 中文语义搜索暂不通过机翻补救，单独记录模型能力边界。

验收：每次模型、归一化、索引格式或排序修改都输出 Recall@K 和固定差异报告。

#### D. GUI smoke 缺失

服务测试无法覆盖透明窗口、层级、拖放、剪贴板和面板挂载问题。

方向：

- 增加 Electron smoke：启动、打开五个主要面板、检查白屏和 console error。
- MediaSearch 覆盖选择路径、Refresh、Query/Paste、结果缩略图挂载。
- 打包后 `win-unpacked` 再执行一次启动 smoke。

验收：CI/本地单命令完成，失败保留截图和 renderer console 日志。

### 6.3 P2：达到阈值后再实施

#### A. 二进制持久化 Frame Index

JSONL 便于调试，但加载时需要 JSON.parse，并重复保存路径和字段名。

建议格式：meta + path dictionary + contiguous Float32 matrix。先做只读并行格式和一致性校验，不直接删除 JSONL fallback。

启动条件：真实 frame index 冷加载 P95 超过 1 秒，或单模型 RSS 增量超过 512 MB。

#### B. Worker/native ANN

当前评分基线约 815K vectors/s，10 万条纯评分理论为百毫秒级，暂不支持立即引入 worker 的收益假设。

启动条件：排除 manifest、existsSync、JSON 解析后，评分阶段 P95 仍超过 250 ms；或者索引超过 200K 且用户明确需要低延迟重复搜索。

#### C. 大模块继续拆分

优先候选：`semanticSearchService.ts`、`embeddingService.ts`、`useStore.ts`、`RemoteTerminalPanel.tsx`。

原则：只在新增功能或明确测试边界时拆分，不以减少行数为目标；每次拆分必须先补契约或状态回归测试。

## 7. 推荐执行顺序

### 第一阶段：性能定位与缓存，预计低到中风险

1. 给 MediaSearch 搜索增加阶段计时：manifest、scope/catalog、index freshness、index load、embedding、score、result mapping。
2. 建立 video/frame manifest 签名缓存和显式失效机制。
3. 移除搜索准备阶段的大批量 `existsSync`，改为 ready catalog + TopK 复核。
4. 增加 10K/100K synthetic manifest benchmark。

### 第二阶段：准确率与 UI 验收，中风险

1. 建立真实素材固定查询集和 Recall@K 报告。
2. 增加 Electron 开发态 UI smoke。
3. 增加 `win-unpacked` 启动与主要面板 smoke。
4. 将性能与准确率报告写入 `docs/benchmark/`，保留历史基线。

### 第三阶段：数据层升级，条件触发的中高风险

1. 依据第一阶段数据决定是否增加二进制 frame index。
2. 只有评分阶段达到阈值才迁移 worker/native ANN。
3. 保留 JSONL 回滚路径和格式版本号，完成新旧索引一致性测试后再默认启用。

## 8. 下一轮明确任务

下一轮建议只做第一阶段第 1、2 项：

1. 新增 MediaSearch 分阶段计时结构与 benchmark 输出。
2. 为 `video_files.jsonl`、`video_frames.jsonl` 建立签名缓存和失效测试。

不要直接开始 worker、ANN、SQLite 或 NekoSearch 新功能。先用真实数据证明瓶颈，再选择架构升级。

## 9. 发布判断

当前版本可继续作为稳定开发基线：类型、Lint、MediaSearch、IPC、Preload 和依赖安全检查均通过。发布前仍建议执行完整 `npm test`、正式 `npm run build` 和一次安装包人工 smoke；本轮未重新执行完整 native rebuild 和 NSIS 安装流程，因此不把它们声明为本轮已验证。

## 10. 2026-07-11 第一阶段推进结果

已完成第一阶段第 1、2 项，并推进第 3 项：

1. 修复 video/frame manifest cache signature 未包含绝对文件路径的问题。不同测试目录或数据目录即使文件大小和 mtime 相同，也不会交叉复用缓存。
2. 新增显式 `invalidateVideoManifestCache`、`invalidateVideoFrameManifestCache`，并在 manifest 写入后同步更新 records、count、done count 和 ready catalog。
3. 新增 ready frame manifest catalog。同一个 manifest 签名下，重复搜索不再对所有帧重复执行 `existsSync`。
4. 最终有界候选集仍复核图片存在性；即使 catalog 建立后文件被外部删除，也不会返回失效结果。
5. Image、Text、Similar 搜索响应新增 `manifestMs`、`indexMs`、`embeddingMs`、`scoringMs`、`totalMs`。
6. MediaSearch UI 成功消息显示总搜索耗时，为真实使用诊断提供直接反馈。
7. 新增相同大小、相同 mtime、不同目录的 manifest cache 隔离测试，以及外部删除帧后的结果复核测试。

验证：

- `typecheck`：通过。
- `lint`：通过。
- MediaSearch：21/21 通过。
- renderer/Electron build：通过。

下一项调整为第一阶段第 4 项：建立 10K/100K synthetic manifest benchmark，分别测量冷加载、热缓存、ready catalog 和搜索准备阶段。取得数据后再决定是否需要异步 manifest reader 或二进制 manifest。

## 11. 2026-07-12 交互与 Image Search 修复

本轮处理三个用户可见问题：

1. Prompt Edit 拖动撕裂：根因不是单纯刷新率不足，而是拖动时 React/store 每帧更新位置、textarea paint、DOM style observer 和 Electron `setShape` IPC 每帧同时运行，导致 Chromium/DWM 合成队列积压。
2. `DraggablePanel` 新增可选 compositor drag。Prompt Edit 拖动期间只更新 `translate3d`，复用已合成纹理；松开鼠标后才提交最终 React 位置。
3. Prompt Edit 移除 `will-change: left, top`，改用拖动期间动态 `will-change: transform`，并关闭背面绘制。
4. 原生 overlay shape 在面板交互时由每帧 IPC 改为约 80 ms 节流；视觉面板仍按显示器帧率移动，shape 只承担输入区域跟随。
5. 全局 Toggle 增加 350 ms 去抖，过滤全局快捷键按住时的重复触发。
6. 全局隐藏现在始终隐藏 Electron 原生窗口，不再因为某个面板启用了 visibility lock 而停留在半隐藏状态；再次按键恢复保存的面板可见性。
7. Image Search 结果新增 `Similar` 按钮，直接复用 `runImageQuery(result.path)`，支持 Fast/Standard/Precise 当前模式、TopK 和进度反馈。

验证：typecheck、lint、IPC registration 2/2、preload contract 1/1、MediaSearch 21/21、renderer/Electron build 均通过。

手动验收重点：长文本 Prompt Edit 连续拖动 10 秒观察撕裂；快速按住/单击 Ctrl+Shift+Alt+Q 验证一次按键只切换一次；Image Search 点击任意结果 Similar 后确认查询路径和结果刷新。

## 12. 2026-07-12 拖动低频回归与结果渲染优化

用户复测发现 Prompt Edit 有改善，但所有面板拖动出现低频感。确认这是上一轮 shape 80 ms 跟随造成的裁剪回归：DOM 面板按帧移动，Electron 原生 shape 仍停留在旧位置，超出区域需要等待下一次 shape IPC 才显示。

修复：

1. 面板交互开始时只调用一次 `setOverlayShape`，临时扩展到完整工作区。
2. 拖动/缩放期间不再跟踪 shape，不发送持续 IPC，也不会裁剪已移动面板。
3. 交互结束后重新测量所有可见面板并恢复精确 shape。
4. Prompt Edit 继续保留 compositor transform 拖动。

大量结果掉帧优化：

1. 新增复用 hook `useVirtualGrid`，按滚动位置、容器宽度和固定行高计算可视索引范围。
2. Image Search 的 Large/List 与 Media Search 的 Frames/Videos 仅挂载可视行及上下各 3 行缓冲；离开窗口的卡片和缩略图会卸载，不再累积 DOM。
3. 结果集合、筛选或视图切换后自动重置滚动位置，防止旧偏移使新结果显示空白。
4. Media frame 图片原有 IntersectionObserver 懒加载继续保留，缓冲区中的卡片也不会过早读取图片数据。
5. Media 视频结果修复网格列数少于单元格数造成的隐式换行，固定单行高度保证虚拟窗口计算稳定。

验证：typecheck、lint、MediaSearch 21/21 和 renderer/Electron build 通过。

## 13. 2026-07-12 全局 Toggle 试错与最终结论

### 13.1 用户可见现象

问题先后出现了三个阶段：

1. `Ctrl+Shift+Alt+Q` 需要按三次，后来缩短为需要按两次，才能隐藏界面。
2. 第一次隐藏和显示正常，但从第二轮开始，隐藏后窗口画面仍留在桌面。
3. 残留画面无法点击，说明输入窗口已经隐藏或 Shape 已失去交互区域，但 Windows 合成器仍保留透明窗口的最后一帧。

### 13.2 试错过程

#### 方案一：仅在渲染层切换 Zustand 状态

最初由渲染层收到热键事件后执行 `toggleGlobalVisibility()`，再根据结果调用 `hideWindow()`。

问题：

- 原生窗口可见性、React 面板可见性和保存的 `globalVisible` 状态分别更新，存在时序差。
- visibility lock、设置恢复和重复事件可能使面板状态已改变，但原生窗口仍未隐藏。
- 该方案无法保证第一次热键一定作用于原生窗口。

结论：全局热键的原生显示/隐藏不能由渲染层状态间接决定。

#### 方案二：增加 350 ms 去抖

在主进程热键回调增加 350 ms 间隔，过滤按键按住时 Windows 产生的重复触发。

效果：消除了单次按键的重复回调风险，但没有解决需要多次按键的问题。

结论：去抖只处理输入重复，不处理主进程与渲染层状态不一致。

#### 方案三：主进程直接隐藏，但使用 `BrowserWindow.isVisible()` 判断方向

将隐藏动作提前到 Electron 主进程；如果 `isVisible()` 为真就隐藏，否则显示。

问题：透明、无边框、动态 Shape 的覆盖窗口中，`isVisible()` 与用户实际看到的合成画面并不总是一致。第一次按键可能错误进入显示分支，因此仍需第二次才能隐藏。

结论：不能用 `isVisible()` 作为此类透明覆盖窗口的 Toggle 状态源。

#### 排查多实例

检查到一个 Electron 主进程及三个 renderer/GPU/utility 子进程，属于正常进程结构，没有发现两个独立应用实例争抢全局快捷键。

结论：本次问题不是多实例造成，但项目后续仍可补充 single-instance lock，防止用户同时运行开发版和安装版。

#### 方案四：主进程维护明确的隐藏状态

新增主进程级 `globalWindowHidden`：

- 初始为显示状态。
- 第一次热键固定设为隐藏并调用 `hide()`。
- 第二次热键固定设为显示并调用 `showInactive()`。
- `hide-window` 和 `show-window` IPC 同步更新同一状态。

效果：解决了第一次热键方向判断错误，但第二轮隐藏仍可能留下不可点击画面。

#### 方案五：清理重复显示和残留 Shape

继续检查发现两个独立的显示时序问题：

1. 主进程显示分支已经执行 `showInactive()`，渲染层收到事件后又异步调用 `showWindow()`。这个重复显示可能晚于下一次隐藏完成，从而重新显示窗口。
2. 所有 React 面板卸载后，Shape 同步函数因 `elements.length === 0` 直接返回，原生窗口继续保留上一次非空 Shape；Windows 合成器可能显示不可交互的最后一帧。

最终修复：

1. 移除显示事件中的重复异步 `showWindow()`。
2. 主进程隐藏前先执行 `mainWindow.setShape([])`，再执行 `hide()`。
3. 渲染层检测到没有可见面板时不再直接返回，而是提交空 Shape。
4. 每次显示事件都强制触发 `panel-visibility-changed`，重新测量并恢复当前面板 Shape。
5. 保留 350 ms 去抖，仅负责过滤重复按键，不参与可见性判断。

### 13.3 最终状态机

隐藏顺序：

1. 热键回调将 `globalWindowHidden` 设为 `true`。
2. 原生窗口执行 `setShape([])`。
3. 原生窗口执行 `hide()`。
4. 通知渲染层保存并隐藏面板状态。
5. 渲染层再次确认空 Shape。

显示顺序：

1. 热键回调将 `globalWindowHidden` 设为 `false`。
2. 原生窗口执行 `showInactive()` 并恢复置顶等级。
3. 通知渲染层恢复保存的面板可见性。
4. 渲染层无条件触发 Shape 重建。

### 13.4 可复用经验

1. Electron 透明窗口需要同时管理原生可见性、DOM 可见性和原生 Shape，三者不能互相推断。
2. Toggle 应由主进程持有明确状态，渲染层只负责同步 UI，不应反向决定原生窗口是否隐藏。
3. `isVisible()` 适合普通窗口状态查询，不适合作为透明动态 Shape 覆盖窗口的唯一状态机。
4. 所有显示/隐藏动作必须只有一个责任方，避免主进程与渲染层重复调用 `show()`。
5. “画面存在但无法点击”应优先检查合成残影、空输入区域和旧 Shape，而不是继续调整快捷键去抖。
6. 无可见元素是需要提交空 Shape 的有效状态，不能作为跳过同步的优化条件。

最终由用户连续实测确认：首次及后续多轮隐藏/显示均正常，不再需要重复按键，也不再出现不可点击残影。

### 13.5 单实例风险关闭（2026-07-12）

Toggle 修复期间排查过多实例，但当时代码仍未主动阻止重复应用启动。现已补齐：

1. 主进程必须获得 `requestSingleInstanceLock()` 才继续初始化。
2. 第二次启动只唤醒现有窗口，不再创建额外透明窗口或争抢全局快捷键。
3. 第二实例恢复与 Toggle 显示共用 `revealGlobalWindow()`，保持原生可见性状态和 renderer 面板状态一致。
4. guards 7/7、开发态及 `win-unpacked` Electron UI smoke 5/5 均通过。

因此，“开发版/安装版或重复启动实例争抢全局快捷键”从开放风险改为已关闭。若需要并行运行两套完全独立配置，应显式使用不同 `userData`，而不是绕过实例锁。

## 14. 启动 IPC 竞态关闭（2026-07-12）

审计发现主窗口原先早于大部分 IPC handler 创建；RemoteTerminal handler 还要等 profile 文件读取完毕后才注册。快速 renderer 可能在 handler 不存在时调用 preload API，造成首次加载失败但刷新后恢复。

当前状态：

1. Image Search、Media Search、App Storage、Duplicate Finder、App Core、Remote Terminal、File Manager、Vector IPC 均先于 `createWindow()` 注册。
2. Remote Terminal profile 异步读取不阻塞窗口，但所有 profile 相关 handler 共享初始化 Promise。
3. IPC registration 测试新增启动顺序和 readiness barrier 断言，目前 3/3 通过。
4. RemoteTerminal 相关功能测试 15/15 通过，开发态和打包态 GUI smoke 均为 5/5。

因此，“renderer 首次请求早于主进程 handler 注册”从开放风险改为已关闭。

## 15. FFmpeg 首次状态错误关闭（2026-07-12）

此前异步工具预热与状态读取分离：首次请求返回 pending，但 UI 把 pending 显示成 missing，并且预热完成后没有自动刷新。这是状态编排错误，不是工具文件缺失。

当前状态：

1. 首次状态 IPC 等待共享的异步 ffmpeg/ffprobe 探测，不阻塞主线程。
2. 并发请求合并为同一 Promise，避免重复启动工具进程。
3. 配置 generation 防止旧目录探测覆盖用户刚选择的新目录。
4. 开发态隔离数据 smoke 已确认首次显示 `ffmpeg: ok / ffprobe: ok`。
5. MediaSearch 22/22、IPC registration 4/4、开发态和打包态 GUI smoke 5/5 均通过。

因此，“首次打开 MediaSearch 错误提示 FFmpeg missing，Refresh 后才恢复”从开放风险改为已关闭。

## 16. FFmpeg 预热与完整测试基线（2026-07-12）

FFmpeg/ffprobe 异步探测现在在工具配置初始化后立即启动，并与窗口及 renderer 加载并行。开发态 UI smoke 从 3,528 ms 降到 2,693 ms，约减少 23.7%，同时保持首次状态准确。

完整工程测试已重新执行：`npm test` 共 125/125 通过，其中 native 正确性 29/29。项目当前不再把“尚未执行完整 native rebuild/test”列为开放验证项。

已知构建提示：Node 24 会对 node-gyp 13 的 Python 探测输出 `DEP0190`。调用栈位于第三方 `node-gyp/lib/util.js`；项目构建封装已明确使用 `shell: false`，当前不通过修改依赖安装目录规避提示。后续升级 node-gyp 时复查该上游问题即可。

当前主要剩余验证：

1. 真实素材搜索 Recall@K 基线。
2. NSIS 安装、启动、升级覆盖和卸载人工 smoke。
3. 只有真实索引冷加载或评分达到既定阈值时，才启动二进制 Frame Index 或 native ANN。

## 17. 正式安装包基线（2026-07-12）

最新 NSIS 已通过完整构建、打包应用 GUI smoke 和 7-Zip 归档测试。依赖安全审计为 0 vulnerabilities，安装包 SHA-256 已记录，`release` 已恢复为只保留最终安装包。

发布阻断项不再包括“安装包未重新生成”或“归档完整性未知”。剩余发布风险为：

1. Authenticode 未签名。
2. 使用默认 Electron 图标。
3. 尚未在干净 VM 验证安装、升级覆盖和卸载。
4. 真实素材 Recall@K 报告尚未建立。

## 18. 真实素材准确率基线（2026-07-12）

真实 MediaSearch Frame Index 已建立自动 Recall@K 基准：9,423 帧、915 个视频、100 个跨视频查询，DINO 与 CLIP 两次运行指标完全一致。

结论：

1. Same Video R@10：DINO 94%，CLIP 98%。
2. Adjacent R@10：DINO 79%，CLIP 82%。
3. 索引 JSONL 加载约 755 ms，精确评分 P95 小于 8 ms。
4. 当前数据未达到二进制索引或 ANN 的触发阈值，相关架构升级继续保持暂停。
5. “真实素材以图搜视频 Recall@K 未建立”从开放项改为已关闭。

剩余准确率风险仅限文本语义搜索；该项需要人工标注 query-to-frame ground truth，不能从视频归属自动推导。

## 19. 文本语义评测基础设施（2026-07-12）

人工文本语义评测不再缺少工具和候选集：当前已从真实 9,423 帧索引生成 12 个中英概念、1,748 个候选，并提供本地标注 UI、原子标签存储、白名单图片读取和 @10/@20/@50 评测器。

该风险尚未完全关闭，因为人工判断数仍为 0。完成标签前只能确认评测基础设施可用，不能用空指标评价 CLIP 文本语义准确率。标注方法和统计边界见 `docs/benchmark/2026-07-12-media-search-text-annotation-dataset.md`。

后续复查已关闭“部分标注被当成负样本”的统计风险：正式 Precision、Pooled Recall 和 nDCG 现在受覆盖率门槛保护，报告必须达到 `publishable: true` 才能作为最终准确率基线。标注 UI 的未标优先、撤销、预加载和不确定项复核也已完成；开放项只剩人工判断本身。

## 20. 顶部导航卡顿与窗口残影关闭（2026-08-18）

用户实机复现顶部快捷导航拖动卡顿、跨层残影和松手跳位。根因由三条路径叠加：导航位置在每个 `mousemove` 帧写入 Zustand，使首次引导、任务中心和设置自动保存一起重渲染；`MutationObserver` 同时因内联样式变化重复测量全部面板；工作区根的 `overflow: hidden` 仍允许焦点触发不可见的程序化滚动。

当前修复：

1. 导航拖动使用独立合成层 `translate3d`，每帧只改 DOM transform，松手后才提交一次最终位置。
2. 面板交互开始时继续一次性扩展原生 Shape；交互期间 MutationObserver 不再测量或排队 Shape IPC，结束后恢复精确 Shape。
3. 交互期间暂停导航 `backdrop-filter`，保持稳定 paint containment、背面隐藏和不透明表面，减少透明 Electron 窗口的重绘负担。
4. 工作区根从 `overflow: hidden` 改为 `overflow: clip`，保持裁剪但不再成为可被焦点滚动的容器；Electron 回归已确认拖动前后 `rootScrollTop = 0` 且位置无跳变。
5. 任务中心展开时暂时收起首次引导，避免两个大型实时状态区同时把导航撑出视口；“开始使用”按钮会先退出任务中心再恢复引导。
6. UI smoke 新增真实鼠标事件回归，验证拖动中使用 transform、模糊暂停、宽高稳定、松手清理、最终坐标正确且根容器不滚动。

验证：导航/布局/UI smoke 合约 22/22、TypeScript、ESLint、Prettier、Renderer/Electron build 均通过；隔离 Electron 中文 1366×768、125% 缩放运行 `ok: true`，`compositorDragStable: true`。窗口撕裂仍需用户在实际显示器刷新率和显卡驱动组合下连续拖动复核，自动截图不能替代长时间动态观察。
