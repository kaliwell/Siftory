# 价值优化队列交接（2026-08-11）

> 读者：下一位接手本项目的人或代理。本文档汇总 2026-08-11 会话的全部进展、当前状态、运维事实和待决事项。
> 权威任务表始终是 `docs/current/2026-08-07-value-ranked-optimization-todo.md`（`npm.cmd run todo:value-next` 选择下一项）。
> 上一份交接：`docs/handoffs/2026-08-10-value-queue-handoff.md`。

## 队列状态快照（2026-08-11 19:20 左右）

- **39 项：34 verified / 0 active / 0 ready / 4 blocked / 1 deferred（87% 完成）**
- `next` 为 null：自动队列已清空，剩余全部需要人工授权或触发条件。

## 本轮已完成（均已合入 main 并 verified）

| 任务    | 提交      | 内容                                                                                                                                            |
| ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-037 | `0db62b8` | subject/face/person 用户 ONNX 推理统一移入隔离子进程；embedding 严格校验；缓存 tombstone；显式 negative reason；暖子进程 unref + 空闲释放          |
| VAL-038 | `a45dee6` | authoritative/delta/derived F16 统一完整性证明（size+SHA-256，memo 化）；消费者全部 fail-closed；delta/derived 升 v3，v2 安全失效；ANN 建索引前重验 |
| VAL-036 | `1ed54cd` | Native scope 三态区分：absent/valid-empty 保留全库回退，corrupt fail-closed（CLIP 零结果 + DINO 拒绝一切候选 + `[semantic-scope]` 信号）           |
| VAL-028 | `04377cd` | CLIP 语义 F16 扫描迁入融合 worker（查找表内联解码+点积）；scope 按 scopeId 共享；SAB 取消；78K warm P95 54ms，主进程 GC 6→0                        |
| VAL-029 | `0013e92` | 主 Session 权限 deny-default；CSP 收紧（无 http(s) 外联）；IPC origin 精确信任；AI API 认证失败锁定 + SSE 并发上限                                  |
| VAL-031 | `a59e999` | authoritative generation 就绪即预热 DINO ANN；预热与按需构建字节一致；搜索抢占预热；首查 112.9ms→22.7ms                                             |
| VAL-033 | `b8297ba` | ipc-contract 944→221 行 barrel 化；imageSearchService 1930→1639 行；新增 `check-layering.cjs`/`check-build-graph.cjs`（预算只降不升），套件 `test:architecture` |
| VAL-032 | `4344f5a` | 召回观测迁入低优先级 worker；256 MiB 内存上限 + spill 分块流式扫描；未变化源复用验证矩阵；峰值 RSS 增量 150→52 MiB                                  |

每项均有对应 `docs(todo): start/verify` 提交和 TODO 表尾部的进展记录（含测试证据与遗留边界）。

## 剩余事项（自动化不能越权，需用户/授权人决策）

1. **VAL-003**（92，observation）：~~DINO generation 迁移~~ **已于 2026-08-11 经用户授权执行完成**
   （`--execute`，2/2 模型，760 MB，0 错误，generation `20260811114205797-5fd15010`；CLIP 57,953 / DINO 411,636
   快照均 ready，详见 TODO 表 2026-08-11 进展记录）。当前仅剩周期累计：3 个相隔 ≥24 小时的稳定召回周期，
   由计划任务 `Reasonix-VAL003-Observations` 自动完成，预计 2026-08-14 前后满足，届时评估 JSONL shard 退役。
2. **VAL-011**（93，approval）：5 项许可证审批（项目 EULA、ONNX Runtime GPU、CUDA、cuDNN、CUDA worker）仍
   `pending`，材料见 `docs/current/2026-08-09-val-011-license-approval-packet.md`。
3. **VAL-030**（93，approval）：依赖 VAL-011 + 项目 EULA/第三方许可/签名密钥/远端备份。
4. **VAL-026**（94，approval）：真实 Native index 与 Data Catalog 重建授权。
5. **VAL-008**（30，deferred/triggered）：等待"第二个加载 FastScanner addon 的 env"实际出现才启动，非计划性工作。

## 运维事实

- **计划任务 `Reasonix-VAL003-Observations`**：登录 + 每日 20:10 触发，`wscript.exe scripts/run-value-observations-hidden.vbs`
  隐藏窗口运行。管理脚本在忽略版本控制的 `artifacts/`（restore/start/check-val003-task.ps1）。
- **最新观测报告**：`artifacts/value-optimization/last-run.json`。
- **约束**：不触发系统关机；不处理 ACC-02；不伪造审批或维护周期；真实用户数据（`%APPDATA%\floating-clock-electron`）只读。

## 工作规则速查（本轮验证有效的流程）

1. `todo:value-next` 选任务 → 建分支 → TODO 表置 `in_progress` 并提交 `docs(todo)`。
2. 实现 + 临时夹具测试 → 门禁：相关测试包、`typecheck`、`lint`、`format:check`、全量 `verify`；注意 VAL-033 新增
   `test:architecture`（分层规则 + 构建图预算，热点模块行数只降不升）。
3. 提交信息 hook 强制格式：`<type>(<scope>): <summary>` + 正文 + trailer `Executor-System`/`Executor-Model`/`Task`/`Validation`。
4. 合入：TODO 表置 `verified` + 进展记录 → `--check` 通过 → docs 提交 → `git checkout main && git merge --ff-only <branch>`。禁止直接在 main 提交。
5. 工作区长期存在的噪声（勿动）：未跟踪 `start.bat`、CRLF 修改的 `.editorconfig`/`.githooks/*` 等、并发 Codex 代理的
   `docs/README.md` 与 `docs/designs/*` 改动（含未跟踪 `2026-08-11-local-nas-ai-asset-discovery-architecture.md`）。

## 代理协作经验（本轮实战教训）

- 实现代理上下文会膨胀：长任务链中定期换全新代理（简报写足背景），resume 超 256K 会 401。
- 后台代理疑似挂起（wire 日志 >10 分钟无更新）时：`TaskStop` 后 resume 即可恢复。
- 代理离场未提交时：检查其 `artifacts/commit-msg-*.txt` 已就绪，可复跑 verify 后代为提交（保持 hook 格式）。
