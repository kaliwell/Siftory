# 内存与资源生命周期自动优化 TODO

> 状态：当前  
> 更新日期：2026-08-28  
> 范围：远程传输、文件管理、缩略图与媒体搜索主进程缓存、启动期资源维护、Renderer 同步存储、活动面板与异步回调生命周期  
> 后续专项：[运行内存与峰值内存完整优化 TODO](2026-08-28-runtime-memory-optimization-todo.md)  
> 替代文档：无

## 当前结论

真实 Electron 渲染进程经过 5 轮预热和 600 轮图片/视频搜索面板重复打开、关闭、展开与折叠后，强制 GC 堆内存进入平台期；后 400 轮仅波动约 83 KiB，DOM 节点固定为 2015，未发现本轮 UI 的线性泄漏。

本轮确认的三条无上限对象保留、文件系统 Watcher 异常清理缺口和媒体图片缓存字节预算缺口均已关闭。对应专项测试、相关测试链、类型、格式、架构、构建与真实 Electron 冒烟均通过；本结论不声称覆盖所有第三方 Native、GPU 驱动或模型运行时泄漏。

追加启动卡顿复核发现：真实 `thumbcache` 有 126,251 个文件、约 1.00 GiB，旧启动路径会立即逐文件 `stat` 并排序；单独实测耗时约 3.8 秒，而资产库 SQLite 同步初始化仅约 36 ms。缩略图容量维护现已移到首屏后 120 秒，24 小时内去重，文件状态并发由 64 降为 16，并可在退出时取消；修复后的真实数据启动中页面目标约 2.53 秒出现，前 20 秒未执行该全目录扫描。

再次复核用户反馈的“仍然很卡”后，真实 Renderer 采样确认了第二个独立根因：`ImageSearchPanel` 首次同步读取 `localStorage` 时单次阻塞 6,393 ms，形成约 7.3 秒 JavaScript 长任务。图片搜索、视频搜索和缩略图重建的 UI 偏好现已迁入应用的异步 JSON 设置通道，生产 Renderer 不再接触 `localStorage`。相同真实用户数据复测中，10 秒采样的最大长任务降至 91 ms、最大动画帧间隔从约 6,956 ms 降至 375 ms、最大定时器停顿从约 7,364 ms 降至 132 ms，存储调用为 0。

第三次针对“面板仍卡”的冷启动剖析又移除了若干叠加项：已关闭的新手引导不再执行隐藏的存储盘点；媒体缓存统计改为异步、合并且显式触发；图片默认索引不再由 Renderer 重复加载；折叠区未展开前不再挂载模型、维护和诊断组件；音频语义状态使用异步持久化摘要，不再同步打开 814 份转写 JSON；空结果网格不再触发工作区几何读取。`fast_scanner 0.5.30` 进一步在原生 Worker 内构建 266,536 条路径映射、读取失败路径摘要，并在同一次遍历中排除缩略图缓存，完成回调只交换容器所有权。搜索区按工作流步骤分帧挂载，开发环境的 React StrictMode 改为显式诊断开关。真实数据最终复测中，四个已保存面板约 1.20 秒出现、约 1.43 秒补齐展开内容，4 秒窗口内没有任何大于等于 50 ms 的 JavaScript 长任务；本次进程已关闭。

2026-08-19 全窗口审计补齐了活动任务与短生命周期回调：Duplicate Finder 和 Remote Terminal 隐藏时继续挂载，避免扫描/SSH 会话被销毁；Batch Rename 在启动前订阅进度并在重新进入时读取权威状态；File Manager 的 resize RAF、Image Search 通知计时器和 Batch Rename 监听均在替换或卸载时释放。双语 Electron UI 冒烟完整加载 14/14 面板，未出现控制台错误或窗口崩溃。

## 执行身份与边界

| 字段       | 当前值                                                 |
| ---------- | ------------------------------------------------------ |
| 执行系统   | Codex                                                  |
| 所有者     | Codex/coder                                            |
| 模型信息   | GPT-5 系列；精确版本未公开                             |
| 外部代理   | 无已确认的本任务外部代理                               |
| 分支/提交  | 当前共享未提交现场；不创建提交，不改动本任务范围外文件 |
| 文档入口   | `docs/README.md`                                       |
| 事实优先级 | 当前代码与本次测试 > 当前文档 > 历史审计               |

## 自动任务队列

| 顺序 | ID      | 任务                                                           | 执行系统 | 所有者      | 状态   | 验收标准                                                                     |
| ---- | ------- | -------------------------------------------------------------- | -------- | ----------- | ------ | ---------------------------------------------------------------------------- |
| 1    | MEM-001 | 限制远程传输历史并在任务终止后释放含凭据的内部 Job             | Codex    | Codex/coder | 已完成 | 仅保留有界展示元数据；完成/失败 Job 不再驻留；压力测试通过                   |
| 2    | MEM-002 | 为上传/下载选择令牌增加 TTL 回收、数量上限和 Renderer 销毁清理 | Codex    | Codex/coder | 已完成 | 过期、超限、已消费及所属 Renderer 销毁的令牌均可回收                         |
| 3    | MEM-003 | 将 `.lnk` 解析缓存改为按条目数和估算字节数共同约束的 LRU       | Codex    | Codex/coder | 已完成 | 新条目触发确定性 LRU 淘汰，缓存不再无上限增长                                |
| 4    | MEM-004 | 修复目录 Watcher 报错、取消订阅、Renderer 销毁和应用退出清理   | Codex    | Codex/coder | 已完成 | 定时器与 Watcher 均关闭；重复关闭安全；主进程退出显式清理                    |
| 5    | MEM-005 | 将媒体图片 Data URL 缓存增加总字节预算                         | Codex    | Codex/coder | 已完成 | 同时受 3000 项和 128 MiB 约束；清空后计数与权重归零                          |
| 6    | MEM-006 | 将缩略图全目录容量维护移出首屏启动关键路径                     | Codex    | Codex/coder | 已完成 | 启动不立即遍历缓存；延迟且按日去重；低并发执行；退出可取消；真实启动验证通过 |
| 7    | MEM-007 | 移除搜索面板启动路径的 Renderer 同步存储初始化                  | Codex    | Codex/coder | 已完成 | 偏好走异步设置通道；源码与构建无面板存储调用；真实长任务复测通过             |
| 8    | MEM-008 | 消除隐藏组件、索引恢复与面板首开叠加的主线程工作               | Codex    | Codex/coder | 已完成 | 隐藏区零轮询；大索引在 Native Worker 恢复；面板分帧挂载；真实冷启动无 ≥50 ms 长任务 |
| 9    | MEM-009 | 隐藏活动扫描与远程会话时保留任务所有者                         | Codex    | Codex/coder | 已完成 | Duplicate Finder 和 Remote Terminal 隐藏后任务/会话不因卸载丢失             |
| 10   | MEM-010 | 补齐 Renderer RAF、通知计时器和任务监听的卸载清理              | Codex    | Codex/coder | 已完成 | 替换或卸载后不保留过期回调；重新进入可从主进程权威状态恢复                   |

## 实施约束

1. 运行中与排队中的用户任务不因历史淘汰而丢失；上限只淘汰终态展示记录。
2. 传输历史不得保存密码、私钥口令或文件内容；凭据只保留到该任务运行结束。
3. TTL 回收不新增常驻轮询定时器，避免为修复泄漏引入新的生命周期对象。
4. LRU 权重使用 UTF-8 字节数作保守、确定性的进程内预算，不把条目数误当成内存上限。
5. Watcher 清理必须幂等，并保护旧 Watcher 的迟到错误事件不删除同路径的新实例。
6. 不读取、修改或清理真实素材库、模型目录、远程服务器及用户凭据。
7. 缩略图缓存仍保持 1 GiB 目标上限；延迟维护只能改变执行时机和资源强度，不能取消容量治理。
8. 不为兼容旧偏好重新读取 Renderer 同步存储；首次迁移只重置界面调优项，不影响素材、索引、模型或任务数据。
9. 延迟挂载只影响尚未显示的折叠内容或最多两个动画帧内的展开区；用户主动展开后保留组件状态，任务运行中的面板仍按原策略保持挂载。

## 已完成修复

1. `electron/remoteTransferService.ts` 将终态展示历史限制为最近 200 项；运行中和排队任务不参与淘汰。内部 Job 在完成、失败、排队取消或应用退出时从 Map 删除，并显式移除 `password`、`passphrase`、Client 与 Stream 引用。
2. `electron/remoteTerminalTransferIpc.ts` 将文件选择令牌限制为 256 项和 5 分钟 TTL；签发时清理过期项，超限淘汰最旧项，消费后立即删除，并在所属 `WebContents` 销毁时批量清理。
3. `electron/boundedAsyncQueue.ts` 新增可复用的条目数与权重双限制 LRU；`electron/thumbnailIpc.ts` 的快捷方式解析缓存使用 1024 项与 4 MiB 预算。
4. `electron/fileManagerIpc.ts` 为 Watcher 建立 Renderer 所有权计数；报错、最后一次取消订阅、Renderer 销毁及应用退出均使用幂等关闭路径，清除防抖定时器并关闭 OS Watcher。
5. `electron/mediaSearchImageCache.ts` 的 Data URL LRU 同时限制为 3000 项和 128 MiB，并公开不含路径或内容的计数/权重统计供回归检查。
6. `electron/main.ts` 在正常退出路径显式调用文件 Watcher 与远程传输清理，不依赖进程被操作系统强制回收。
7. `electron/thumbnailDiskCache.ts` 新增延迟、按日去重且可取消的缓存维护调度，维护完成时间使用原子替换的小型状态文件持久化；全目录状态读取并发从 64 降到 16。`electron/main.ts` 只在窗口创建后安排维护，不再于 `whenReady` 起点立即扫描。
8. `shared/searchUiPreferences.ts` 统一定义并校验图片/视频搜索界面偏好；`App.tsx`、`useStore.ts` 和 `useAutoSaveSettings.ts` 负责异步加载、迁移与保存。图片搜索、视频搜索、Embedding 控件及缩略图重建控件已移除全部 `localStorage` 读写；生产环境的媒体性能日志也不再通过同步存储开关。
9. 产品就绪检查默认不再递归统计存储；存储占用改为用户显式触发。媒体缓存盘点改为异步单次遍历、请求合并和代次缓存，首屏不再同步 `stat` 数万文件。
10. 图片索引默认恢复由主进程独占，Renderer 识别同一路径后不再重复加载。`fast_scanner 0.5.30` 在异步 Worker 内直接构建路径 Map、失败路径 Map 和缓存排除集合，完成阶段使用移动赋值，不再在主线程二次遍历全部记录。
11. 视频/音频语义运行时状态增加短期缓存、在途请求合并和空闲降频；音频转写统计增加轻量目录签名与 `transcript-stats.json` 异步摘要，摘要缺失时立即返回 `pending`，后台并发补算。
12. 图片、视频搜索的折叠区只在首次展开时挂载；初始展开的工作流按 01/02/03 分帧提交。设置折叠区采用同样的首次展开挂载语义。开发环境仅在 `VITE_REACT_STRICT_MODE=1` 时启用双挂载诊断。
13. 空结果虚拟网格跳过 `scrollTop` 写入、布局测量和恒等状态更新；透明窗口形状同步合并 Resize/Mutation 事件并在面板稳定后执行。
14. `panelRegistry` 将 Duplicate Finder 和 Remote Terminal 标记为隐藏时保留，避免活动扫描和 SSH 会话因切换可见性而卸载；Duplicate Finder 挂载时会恢复完成态结果。
15. File Manager 卸载时取消待执行的 resize RAF 并清空待处理引用；Image Search 新通知会先清理旧计时器，组件卸载时再释放当前计时器。
16. Batch Rename 在面板挂载时建立进度监听、卸载时释放，并通过 `getProgress` / `getResults` 恢复快速完成或重新进入的任务状态。

## 验证

| 项目                      | 命令                                                                                                                                                                  | 当前结果                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 远程传输                  | `npm.cmd run test:remote-transfer`                                                                                                                                    | 通过：8/8                                                           |
| 文件管理 Watcher          | `npm.cmd run test:fm-watcher`                                                                                                                                         | 通过：11/11                                                         |
| 文件管理与缩略图链        | `npm.cmd run test:fm-security`                                                                                                                                        | 通过：50/50；包含文件夹大小与稳定大小排序                           |
| 启动维护专项              | `node --test tests/thumbnail-rebuild-pipeline.test.cjs`                                                                                                               | 通过：13/13；含延迟、按日去重与取消回归                             |
| 搜索偏好与同步存储防回归  | `npm.cmd run test:settings`                                                                                                                                           | 通过：64/64；含偏好校验、异步持久化字段和面板零同步存储断言         |
| 搜索面板 UI 契约          | `npm.cmd run test:ui-smoke-contract`                                                                                                                                  | 通过：28/28；要求完整 14 个主面板                                  |
| 图片数据与媒体 UI 定向链  | `npm.cmd run test:image-search-data-folders`；媒体 UI 定向测试                                                                                                        | 通过：63/63；37/37                                                  |
| 媒体搜索链                | `npm.cmd run test:media-search`                                                                                                                                       | 通过：195/195                                                       |
| Native 索引与解码链       | `npm.cmd run test:native`                                                                                                                                             | 通过：71/71；包含 Worker 内恢复与缓存路径排除                       |
| Worker、关闭与远程压力    | `node --test tests/remote-stress.test.cjs tests/image-search-shutdown.test.cjs tests/embedding-worker-lifecycle.test.cjs tests/user-model-runtime-isolation.test.cjs` | 通过：20/20                                                         |
| IPC 与测试可达性          | `node --test tests/ipc-registration.test.cjs tests/qa-toolchain-coverage.test.cjs`                                                                                    | 通过：14/14                                                         |
| TypeScript                | `npm.cmd run typecheck`                                                                                                                                               | 通过                                                                |
| Lint                      | `npm.cmd run lint`                                                                                                                                                    | 通过：0 错误；0 warning                                             |
| 格式                      | `npm.cmd run format:check`                                                                                                                                            | 通过                                                                |
| 架构                      | `npm.cmd run test:architecture`                                                                                                                                       | 通过：435 模块无分层违规；main/preload/renderer 为 278/21/148       |
| 文档                      | `npm.cmd run docs:check`                                                                                                                                              | 通过                                                                |
| Renderer/Main/Worker 构建 | `npm.cmd run build:renderer`                                                                                                                                          | 通过                                                                |
| 真实 Electron 冒烟        | 双语 `zh-CN` / `en` 全窗口 UI smoke                                                                                                                                   | 均通过：14/14 面板、0 缺失、0 控制台错误、0 崩溃                    |
| 真实数据启动探针          | 本机 PowerShell + Electron DevTools Protocol，12 秒采样                                                                                                               | 通过：页面目标 2,533 ms；前 20 秒未触发缩略图维护；本项目进程已关闭 |
| 真实 Renderer 长任务复测  | Electron DevTools Protocol，真实用户数据，重载后 10 秒采样                                                                                                            | 通过：存储调用 0；最大长任务 91 ms；最大帧间隔 375 ms；实例已关闭   |
| 最终冷启动与原生恢复复测  | 真实用户数据、266,536 条图片记录、四个已保存可见面板；CDP 4 秒采样                                                                                                    | 通过：面板约 1.20 秒出现、1.43 秒完整；≥50 ms 长任务 0；实例已关闭 |

## 剩余风险

- JavaScript 强制 GC 采样不能证明 Native addon、GPU 驱动或 ONNX Runtime 内部绝对没有泄漏；这些需要长时间真实建库 soak 和进程 RSS/Private Bytes 对照。
- 模型会话、向量 mmap 和操作系统文件缓存会造成“RSS 不立即下降”，不能仅凭任务结束后 RSS 未回落判定泄漏。
- 本轮未运行数小时真实图片/视频全量建库 soak；内部 Online 安装候选已经构建并通过归档冒烟，但未签名、未绑定干净提交，不能替代发布前 L3 设备与 packaged matrix 验证。
- 当前工作区为大量既有改动组成的未提交现场；本任务只报告实际触碰文件和实际运行的验证，不伪造提交编号。
