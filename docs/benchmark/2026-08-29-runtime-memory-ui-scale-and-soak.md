# 运行内存：UI 生命周期、规模上限与混合长稳入口

日期：2026-08-29

## 结论

- 图片搜索面板完整执行 600 次关闭/打开，完成 `600/600`，门禁通过。
- 100 万行视频帧 manifest 的计数、25 条预览和点查询通过；查询阶段 JS 堆增长约 `0.61 MiB`。
- 10 万与 50 万条合成向量均采用流式扫描，Top-K 完全一致，峰值 JS 堆增长分别约 `34.51 MiB` 和 `34.47 MiB`。
- 混合长稳 runner 已落地，完整批次固定为搜索 `60%`、UI 生命周期 `20%`、取消恢复 `10%`、播放/用户模型 `10%`。正式验收仍要求安静环境下每轮 2 小时、共三轮。

## UI 生命周期证据

命令：

```powershell
npm.cmd run benchmark:memory -- --scenario=ui-churn --cycles=600 --runs=1 --timeout-ms=600000
```

| 指标 | 结果 |
| --- | ---: |
| 完成循环 | 600 / 600 |
| Documents 增量 | 0 |
| JS event listeners 增量 | -47 |
| DOM nodes 增量 | -81 |
| Renderer used heap 增量 | 3,050,784 B |
| 进程树后段 Private Bytes 斜率 | -437,510,803 B/min |

图片搜索是保留任务状态的面板，关闭后实例仍挂载但祖先容器隐藏。测试据此检测真实可见性，而不错误要求 DOM 节点被卸载。

## 规模上限证据

命令：

```powershell
npm.cmd run benchmark:memory:scale
```

| 场景 | 行数 | 构建 | 查询/扫描 | 峰值堆增长 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| Manifest SQLite | 1,000,000 | 4,872.90 ms | 825.13 ms（20 轮） | 643,360 B（终点） | 通过 |
| Vector streaming | 100,000 | 199.27 ms | 213.88 ms | 36,189,688 B | Top-K 通过 |
| Vector streaming | 500,000 | 1,003.45 ms | 1,058.45 ms | 36,139,344 B | Top-K 通过 |

向量规模夹具使用 8 维单位向量，只验证记录规模、SQLite 流式读取、有限 Top-K 状态和内存窗口，不替代 512/768 维真实模型的质量与性能门禁。测试数据完全合成，临时数据库在结束后删除。

## 混合长稳入口

```powershell
node scripts/run-runtime-memory-mixed-soak.cjs --duration-min=120 --plan
npm.cmd run benchmark:memory -- --scenario=mixed-soak --runs=3 --duration-min=120
```

runner 会逐批执行真实 ANN 查询、Electron 面板生命周期、取消/退出回归和八类用户模型会话。任何子门禁、素材只读证明、输出上限或时长门禁失败，整轮均失败。当前 GPU 后台负载不满足正式 preflight，因此尚未接受三轮 2 小时结果。

## 故障与恢复门禁

```powershell
npm.cmd run test:runtime-memory:faults
```

共 88 项通过，覆盖取消、暂停、Native worker 提前退出、子进程崩溃/超时/OOM/输出洪泛、F16 短读与变更、ENOSPC、generation/model 切换、应用退出和下次请求恢复。用户模型子进程 stderr 额外经过 4 KiB 上限与绝对路径脱敏，避免故障堆栈把用户或临时目录写入日志。

正式 UI 内存场景现在通过 `--artifact-parent` 在 `artifacts/benchmark/runtime-memory` 下创建独立原始证据目录；报告、stdout 与 stderr 会脱敏绝对路径和凭据。3 次诊断循环复测通过，针对新目录的绝对路径扫描为零命中。历史 UI smoke 报告为保留可追溯性不会被自动删除，正式验收只接受新隔离目录中的证据。

## 缩略图 GPU lanes 诊断矩阵

可重复入口：

```powershell
npm.cmd run benchmark:memory -- --formal --scenario=thumbnail-matrix --runs=3 --dataset=D:\PxHereDataset\images\pxhere-000000
```

正式命令会在每轮重负载前自动执行 10 分钟静默预检并绑定不可变 accepted GPU 基线；默认按 `1/2/8` jobs 顺序运行每档 10,000 图，记录请求 jobs、实际 lanes、吞吐、整树 Private Bytes、显存峰值/回落、缓存写入和源只读证明。独立的 `benchmark:memory:thumbnail-matrix` 保留为诊断入口，不作为正式接受证据。2026-08-29 先完成了 16 图诊断矩阵：

| 请求 jobs | 实际 GPU lanes | 耗时 | GPU 完成 | 回退/失败 | 显存终点 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 5,635 ms | 16 / 16 | 0 / 0 | 751 MiB |
| 2 | 2 | 3,599 ms | 16 / 16 | 0 / 0 | 751 MiB |
| 8 | 2 | 3,791 ms | 16 / 16 | 0 / 0 | 751 MiB |

矩阵发现并修复了 `jobs=1` 被偶数校验回退为 4 的问题；批大小仍保持偶数约束。16 GiB 当前策略把请求 8 收敛为 2 个实际 lanes，避免无收益的 BrowserWindow/WebGL context 扩张。生命周期计量也按规范增加 5 次不计数预热，三组 renderer 文档/节点均零增长，listener 增量分别为 `0/-5/0`。由于本轮 GPU 利用率不满足正式静默预检，这些数字仅作正确性和归因，不替代 10k 正式结论。

## 同进程搜索回收证据

旧版搜索 soak 每 50 次重新启动进程，无法证明单个长期存活进程没有累积。现已改为一次预热、一个 ANN worker、固定 8 个真实查询向量轮换，并由外部采样器持续观察整棵进程树：

```powershell
npm.cmd run benchmark:memory -- --scenario=search-soak --cycles=100
```

2026-08-29 完成 `100/100`：结果摘要稳定，源向量与路径表快照未变化，搜索 P50 `920.90 ms`、P95 `973.11 ms`；Private Bytes 峰值 `1,642,299,392 B`、终点 `550,305,792 B`，后 2/3 窗口斜率约 `+3.23 MiB/min`，没有向峰值单调爬升。对应报告为 `runtime-memory-2026-08-29T04-56-57-921Z.json`，原始 250 ms 采样为 `search-soak-samples-zIvcm0/process-tree.jsonl`。结合 600 次 UI 打开/关闭、Object URL 成对释放和 128 MiB LRU 专项测试，RMO-044 已满足验收条件。

## 工程门禁与模型子进程回归

全量验证发现主体裁剪仍按换行 JSON 读取 DINO 子进程输出，而 DINO 子进程已经切换为有界 `EMB1` 二进制帧。该不一致会让 `SubjectCropEmbedder.create()` 等待 120 秒后失败。调用端现与建库路径共用二进制帧解码、维度校验、溢出失败关闭和 pending 请求统一释放：真实模型连续多图、坏图片后恢复两组用例均通过，单次模型启动由超时恢复到约 `0.8–1.5 s`。

建库主服务继续拆出 epoch ledger、进度/遥测和任务播种模块；`embeddingService.ts` 从原先 2053 行收敛到格式化后 1818 行。构建图以当前实测值设置向下约束：Embedding 入口上限 1825 行、Main 可达模块上限 300，后续增长会直接失败。视频 Frame Index 保持独立懒加载 chunk，主进程没有静态值导入。

2026-08-29 最终门禁结果：

- `npm.cmd run verify` 完整通过；TypeScript、格式、全量 Node 测试、Native 重建、28 例确定性 Native 图片 fuzz 和受检渲染器构建全部通过。
- Lint 为 `0 errors / 3 warnings`；三条均为固定硬件基线文件中既有的未使用符号，不是本轮新增错误。
- 双语 UI 冒烟通过，主题/缩放矩阵 `6/6` 通过；打包后的中英文 UI 也通过。
- 在线包资源核验通过：26 个必需资源、175 个打包文件，缺失、旧版重复、禁用载荷、敏感载荷和 manifest 问题均为 0。
- 新在线安装包为 `release/Siftory Online Setup 1.0.0.exe`，大小 `177,341,789 B`，SHA-256 `FB04CBDD013B7A67A2847E58D107D4E7743BFF3CA27E971DEAF2C6106FD4E854`。该包是工程验证产物，不代表签名、商业许可和固定硬件内存控制线已经获批。

## 正式环境阻塞

验证结束后重新采集 30 秒诊断预检：AC 供电、CPU P95 `3%`、磁盘 P95 `3%`、可用物理内存约 `4.26 GiB`、Commit 比例约 `45.35%`、残留产品进程为 0；但 GPU P95 为 `35%`，高于正式静默门禁 `10%`，并且当前没有可追溯的 accepted GPU baseline。GPU 上同时存在系统桌面、Chrome、QQ、ChatGPT 等用户进程，本轮未擅自关闭。

360 安全环境独立采样 `10` 次并通过，记录到安全卫士、主动防御进程与服务版本；没有关闭实时防护，也没有创建排除项。原始证据位于 `artifacts/benchmark/runtime-memory/security/security-environment-2026-08-29T05-47-10-9978445Z.json`。因此 RMO-005、RMO-027、RMO-036、RMO-045、RMO-047、RMO-050、RMO-052 和 RMO-055 仍不能标记为正式验收完成。
