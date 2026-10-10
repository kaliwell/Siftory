# FastScanner 多 env 并发写索引隔离评估（FS-07S）

> 状态：当前
> 实施状态：评估完成（纯评估，未改代码）
> 日期：2026-08-05
> 适用范围：FastScanner native addon（fast_scanner 0.5.24，`native/fast_scanner.cc`）
> 关联条目：FS-07F（共享 IndexRuntime 所有权）、FS-07G（单写者租约）、FS-07H/J（teardown 协议）、FS-07R（单 env 加载事实）

## 1. 评估范围与依据

本评估回答三个问题：(a) `single-writer-process-shared` 在多 env 下的失败关闭语义是否完备；(b) 在当前"addon 仅主进程单 env 加载"的现实约束下，交接文档中"当前仍不得宣称支持多 env 并发写索引"的禁令应如何精确化；(c) 若未来要支持多 env 并发写，差距清单是什么。

通读的代码与测试：

- 租约机制：`IndexRuntime::tryAcquireWriter`/`releaseWriter`/`writerStatus`（fast_scanner.cc:754-765）、`IndexWriteLease`（:785-790）、`try_acquire_index_writer`（:792-797）、`index_writer_busy_error`/`reject_index_writer_busy`（:799-801、:922-929）。
- 全部 15 个调用点：同步 scan（:2023）、clear（:2184）、edit-delete/purge/purge-segment/repair/upsert（:2427/:2443/:2482/:2519/:2544）、save/load-manifest、save/load-segment、repair-manifest（:2806/:3022/:3081/:3114/:3132）；异步 load/save/compact（:3396/:3580/:3885）。
- 状态暴露：`GetNativeStatus` 的 `indexWriteMode`/`indexWriterActive`/`indexWriterOperation`（:1925-1928）。
- 所有权结构：`acquire_shared_index_runtime` 弱引用服务（:776-783）、`AddonContext`（:906-914）、`finalize_addon_context`（:4050-4066）、`IndexRuntime::~IndexRuntime`（:1595）。
- 释放路径：scan_worker 出口 `writeLease.reset()`（:1534）；异步 complete 回调 `delete d`（如 :3388-3389、CompactAsyncComplete、SaveManifestAsyncComplete）；创建/排队失败分支 `delete d`（如 :3405-3406）。
- 回归测试：`tests/native-scan.test.cjs` 的"shared index admits only one writer across addon environments"（跨 env 单写者准入）与"stopScanAsync retains its scan runtime while a worker env exits early"（worker env 早退后 `indexWriterActive` 归 false）；`tests/image-search-shutdown.test.cjs` 的"no worker or child process loads the fast_scanner addon directly"守卫。

## 2. (a) 失败关闭语义完备性：完备，无租约泄漏死角

**冲突路径全部可观测、可恢复。** 15 个调用点中，`tryAcquireWriter` 失败分支一律不改任何状态（token 未分配、`activeWriterOperation` 不变），同步入口返回 `{ok:false,error:"Index write busy: <当前写者操作>"}`，异步入口返回 rejected Promise；当前写者操作同时经 `GetNativeStatus` 的 `indexWriterActive`/`indexWriterOperation` 暴露。调用方收到的是带写者身份的确定性失败，可安全重试或放弃，无半写状态。

**持有租约的 env 退出后租约必然释放，逐路径核实：**

- 扫描租约：作为参数移入 `scan_worker` 线程（:2040），线程出口统一 `writeLease.reset()`（:1534），`catch(...)` 异常路径汇入同一出口。env finalizer 先 `request_scan_stop` + `stop_scan_sync` join 扫描线程（:4054-4055）再 `delete context`，因此 finalizer 返回前扫描租约必已释放；worker env 早退回归（native-scan.test.cjs）实测 `indexWriterActive` 归 false。
- 异步租约：存入 AsyncData 的 `shared_ptr<IndexWriteLease>` 成员，complete 回调 `delete d` 时析构释放。Node-API 保证 env teardown 前每个 async work 的 complete 回调必被调用（含 `napi_cancelled`/`napi_closing` 状态），且 `AsyncWorkRegistry::beginTeardown` 在 active 集合排空前不移除 async cleanup hook（:832-841），teardown 会等待在飞的 load/save/compact 完成或取消。创建/排队失败分支同样 `delete d`（:3405-3406）。
- 同步租约：栈上 `shared_ptr`，函数返回或异常栈展开即释放，不可能跨调用存活。
- 生命周期悬垂：`IndexWriteLease` 自身持有 `shared_ptr<IndexRuntime>`（:786），即使 AddonContext 先析构，IndexRuntime 也活到租约释放之后；`releaseWriter` 用单调递增 token 匹配（:759-762），无 ABA 复用问题。
- 硬崩溃：租约是进程内内存状态，进程崩溃即整体消亡，不存在"崩溃 env 留下租约阻塞其他 env"的跨进程语义。

**两处已知弱点（非缺陷，记录备查）：**

1. 租约状态不含持有者 env 标识，`indexWriterOperation` 只有操作名；多 env 场景下定位写者需结合各 env 日志。属可观测性增强项。
2. 若扫描线程陷入不可中断的原生操作，finalizer 的 join 会挂起该 env 的 teardown。这是"卡住"而非"泄漏"，且发生在进程退出路径上，不污染其他 env；磁盘侧另有 manifest.tmp/staging 的回滚与原子替换兜底。

**结论：失败关闭语义完备，未发现需要改代码的真实缺陷。**

## 3. (b) 禁令精确化：架构上已安全，语义上不支持，现实中不会触发

三层事实应区分表述：

- **架构层**：并发写不会损坏索引。即使未来出现第二个加载 addon 的 env，全部写路径统一经单写者租约准入，冲突失败关闭且带写者身份可观测；跨 env 准入与 worker env 早退释放均有回归覆盖。
- **语义层**：仍不支持多 env 并发写。租约是 fail-fast 而非排队——冲突写直接失败返回，调用方必须自行串行化；读路径虽有 `shared_mutex` 读写互斥保证单操作一致，但没有跨操作的快照/事务语义，一个 env 写入期间另一个 env 的多次读可能观察到写前与写后的混合视图。
- **现实层**：FS-07R 已确认 addon 仅在主进程 `imageSearchService` 单 env 加载，`tests/image-search-shutdown.test.cjs` 守卫禁止任何 `*Worker.ts`/`*Child.ts` 直接加载 addon，因此多 env 写竞争在当前产品中根本不会发生；风险点只剩"未来某改动悄悄引入第二个 addon env"，而该风险由守卫测试兜底。

精确化后的禁令：**不得宣称支持多 env 并发写索引（语义上不提供并发写，冲突写失败关闭需调用方串行化）；架构上并发写已被单写者租约失败关闭保护、不致索引损坏；当前单 env 加载 + 守卫测试使该场景不会发生，新增 addon env 前必须完成第 4 节差距清单。**

## 4. (c) 支持多 env 并发写的差距清单（backlog，不实施）

1. **写准入升级**：fail-fast 改为带超时的排队等待，或对可交换的编辑类操作（delete/purge/upsert）做写锁内合并；否则并发写对调用方表现为随机失败。
2. **写者归一或编排协议**：要么写入集中到单一 owner env、其他 env 经 IPC 转发（推荐，改动最小），要么在 JS 层建立跨 env 任务编排，明确 scan/编辑/持久化的串行顺序。
3. **读一致性语义**：多 env 并发写读时需要快照或代际语义（可基于现有 `segmentGeneration` 扩展），保证一个逻辑查询内的多次读观察到同一视图。
4. **租约诊断增强**：记录持有者 env 标识、获取时刻与等待/拒绝计数，`GetNativeStatus` 相应扩展。
5. **关闭握手扩展**：每个新增加载 addon 的 env 都必须接入 FS-07K/R 级 will-quit 幂等握手与 teardown drain；守卫测试从"禁止"改为"白名单 + 握手审查"。
6. **崩溃恢复约定**：进程崩溃后 manifest.tmp/staging 残留与半写 segment 的启动期清理策略需在多写者场景下重新审查（当前 Rollback 只覆盖进程内异常路径）。
