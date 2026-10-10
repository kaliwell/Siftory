# 剩余价值优化自动推进器

> 状态：当前
> 更新日期：2026-08-17
> 范围：价值 TODO 的安全探测、调度与证据保存
> 替代文档：无

日期：2026-08-08

## 目标

`npm.cmd run todo:value-auto` 对价值 TODO 中仍未完成且进入固定允许列表的任务执行安全探测，并把
可重复证据写入 `artifacts/value-optimization/`。实现型任务由 `todo:value-next` 选出，再由执行器按
独立分支、测试、验收和合并的顺序推进；脚本不会把任意代码任务当成可直接运行的命令。

## 自动步骤

| 任务    | 自动执行                                                                                | 完成判定                                   | 硬边界                       |
| ------- | --------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| VAL-011 | 校验 CUDA runtime manifest、默认不捆绑状态和 4 项许可证决定；审批通过后运行限定技术回归 | 技术门禁、真实审批和审批后技术回归全部通过 | 不自动接受许可证或下载运行时 |
| VAL-003 | 运行双模型真实召回门禁；失败时生成 vector-store 迁移预览                                | 3 个成功周期，周期间隔至少 24 小时         | 不自动删除 JSONL             |
| VAL-005 | 调用正式 Storage Cleanup 只读预览并输出类别、风险、文件数和估算字节                     | 没有候选，或用户在 UI 重新预览并明确选择   | 不执行删除、不复用过期 token |
| VAL-008 | 扫描生产 Electron 源码中的 `fast_scanner.node` 加载点                                   | 第二个生产 env 出现后进入实现队列          | 未触发时不预先增加复杂度     |

## 命令

```powershell
# 只显示计划，不运行探测、不写状态
npm.cmd run todo:value-auto:dry-run

# 自动执行所有安全探测并保存状态
npm.cmd run todo:value-auto

# 只推进一项
npm.cmd run todo:value-auto -- --task=VAL-003
```

状态文件是 `artifacts/value-optimization/automation-state.json`，最新报告是
`artifacts/value-optimization/last-run.json`。目录已被 `.gitignore` 排除，不会把机器状态或用户数据
提交到仓库。报告只保留汇总、哈希和相对源码路径，不保存清理候选的真实文件路径。

## 状态流转

自动推进器本身不改写 TODO 状态。原因是 `approval` 任务需要真实责任人，`triggered` 任务必须先出现
产品需求，`observation` 任务必须积累跨时间证据。报告中的 `completionReady=true` 是执行器可以建立
分支、完成专项验收并更新 TODO 的唯一自动流转信号；失败证据不会被计入稳定周期。

`VAL-011` 使用两阶段 fail-closed 门禁。审批仍为 pending 时只检查 manifest、默认不捆绑边界和审批
字段，不运行或代替法律决定；四项组件及项目 EULA 的真实审批全部合格后，自动运行 CUDA 安装器参数、
online/offline profile、哈希下载/离线缓存、worker provider gate 和 DirectML 回退的限定回归。只有该
审批后回归也通过，报告才会输出 `completionReady=true`；测试失败不会因审批字段合格而被掩盖。

`VAL-020`–`VAL-024`、`VAL-027`–`VAL-029`、`VAL-031`–`VAL-036` 等属于实现型 `auto` 任务，由
`todo:value-next` 按价值、状态和依赖排序领取，不加入本脚本的只读探测 allowlist。它们必须在独立
分支完成实现和验收后再更新状态；每项还要审计相邻链，并把新发现回填价值 TODO。真实向量补算、
Native/Catalog 重建、许可证、签名和发布仍保持 `approval` / `blocked`，不会因自动队列而越权执行。

## 第一轮结果

- VAL-011：清单通过、CUDA 仍默认不捆绑；4 项发布决定均为 pending。
- VAL-003：embedding shard 当前为空，迁移预览源字节为 0；需要重新生成数据后开始 3 周期计数。
- VAL-005：只读预览 830,725,787 字节，未删除任何文件。
- VAL-008：生产加载点仍为 1，未触发。

## 当前进度快照（2026-08-09 20:55 CST）

| 项目             | 当前证据                                                                                                             | 状态                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| VAL-005          | 已删除 11,996 个已授权派生/旧文件，释放 830,725,787 字节；fresh preview 为 0，最新素材库备份仍受保护                 | `verified`              |
| DINO/CLIP 重建   | DINO 与 CLIP 各有 79,194 条 current-state 有效向量；generation `20260809120822669-510e58f8`；双模型召回门禁 2/2 通过 | 完成                    |
| VAL-003          | 相同 evidence contract 与 snapshot 下已接受 1/3 个周期；0 个周期失效                                                 | 等待第 2 个真实时间窗口 |
| VAL-003 下一窗口 | `2026-08-10T12:10:52.860Z`（北京时间 2026-08-10 20:10:52）；第 3 个周期仍须与第 2 个成功周期相隔至少 24 小时         | 自动调度                |
| VAL-011 技术门禁 | runtime manifest 通过，CUDA 组件保持 `defaultBundled=false`                                                          | 完成                    |
| VAL-011 审批     | 项目 EULA、ONNX Runtime GPU、CUDA、cuDNN、CUDA worker 共 5 项均为 `pending`                                          | 等待真实授权人          |
| VAL-011 后置回归 | `waiting-for-prerequisites`；审批通过后才运行限定技术回归                                                            | 尚未运行                |

Windows 计划任务 `Reasonix-VAL003-Observations` 当前为 `Running`。它在登录时启动、每日触发，并在进程内按
VAL-003 的权威 `dueAt` 与 VAL-011 的一小时审批轮询间隔调度；状态文件使用单实例锁，报告写入
`artifacts/value-optimization/last-run.json`。当前运行约束是不触发系统关机，计划任务本身也不包含关机命令。

2026-08-10 任务启动方式改为隐藏运行：动作由直接调用 `node.exe` 改为 `wscript.exe` 包装
`scripts/run-value-observations-hidden.vbs`（GUI 子系统 + 窗口样式 0），登录触发不再弹出控制台窗口；任务主体、
触发器（登录 + 每日）与调度参数不变。曾评估 S4U 非交互方式，但该机 S4U 任务 `/run` 报 0x800706F7
（占位程序接收到错误数据），故未采用。注册/恢复辅助脚本保存在忽略版本控制的 `artifacts/`（`restore-val003-task.ps1`、
`start-val003-task.ps1`、`check-val003-task.ps1`）。

## 当前进度快照（2026-08-10 12:20 CST，取代 2026-08-09 快照）

| 项目              | 当前证据                                                                                                                         | 状态               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| VAL-039           | 设置面板清除图搜派生数据按钮已合入 main（`27a446d`），含 mmap EBUSY 修复；真实运行验证通过                                       | `verified`         |
| VAL-022           | scope starvation 夹具 5/5（变异验证有效），接入 `test:vector-pipeline`（`2aa489b`）                                              | `verified`         |
| VAL-035           | DINO ANN scope 下推到 worker 候选选择，回退 parity 夹具通过（`e60f882`）                                                         | `verified`         |
| VAL-027           | 未审查 ONNX 导入检查移入隔离子进程，夹具 6/6，`test:model-download` 77 通过（`8cba7a0`）                                         | `verified`         |
| VAL-037           | subject/face/person embedding 边界隔离，`fix/subject-embedding-boundaries`                                                       | `in_progress`      |
| VAL-003           | 向量库重建后 0/3 重新累计；2026-08-10 03:23 UTC 探测：CLIP 门禁通过（32 查询），DINO authoritative generation 缺失，周期暂不计数 | 等待 DINO 迁移授权 |
| VAL-003 DINO 迁移 | `vector-store:migrate --execute` 为真实数据操作，探测只给预览（sourceBytes 27,536,728），未自动执行                              | 等待用户授权       |
| VAL-011 审批      | 项目 EULA 与四项组件仍全部 `pending`；技术门禁通过，`defaultBundled=false`                                                       | 等待真实授权人     |
| VAL-011 后置回归  | `waiting-for-prerequisites`；审批全部通过后由计划任务自动运行限定回归                                                            | 尚未运行           |

整体交接说明见 `docs/handoffs/2026-08-10-value-queue-handoff.md`。计划任务运行中（隐藏窗口）；当前约束不变：
不触发系统关机、不处理 ACC-02、不伪造审批或维护周期。

本快照只记录已经存在的证据，不把等待时间计为周期，不修改 `legal/license-decisions.json`，也不处理
ACC-02。下一次文档状态更新应以新的 `last-run.json`、维护周期记录或授权人签署的审批证据为依据。

## 计划任务安全加固（2026-08-12）

2026-08-10 的隐藏启动方式已被取代。360 对未签名 VBS、`wscript.exe` 登录持久化、隐藏启动和
长期驻留轮询的组合触发启发式告警后，计划任务已改为每天 20:10 直接执行 `node.exe`，不再登录触发，
也不再经过 VBS。`scripts/schedule-value-observations.cjs` 现在只检查一次前置状态、执行一次安全探测并
退出；向量前置任务未完成时输出结构化 `skipped` 结果，不会在后台等待。VAL-011 的审批复查频率由
每小时降为每日；真实授权、数据删除和 TODO 状态边界保持不变。详细证据见
`docs/current/2026-08-12-value-observation-scheduler-hardening.md`。
