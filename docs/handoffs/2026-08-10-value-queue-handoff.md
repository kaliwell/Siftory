# 价值优化队列交接（2026-08-10）

> 读者：下一位接手本项目的人或代理。本文档汇总 2026-08-09 至 2026-08-10 会话的全部进展、
> 当前状态、运维事实和待决事项。权威任务表始终是
> `docs/current/2026-08-07-value-ranked-optimization-todo.md`（`npm.cmd run todo:value-next` 选择下一项）。

## 本轮已完成（均已合入 main 并 verified）

| 任务    | 提交      | 内容                                                                                                                            |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| VAL-039 | `27a446d` | 设置 → Data 区"清除图搜处理数据"按钮：确认弹窗 preview 后直删 Native 索引、缩略图、扫描日志、整个 vector-db；busy 守卫 + 链接防护 |
| （修复) | `27a446d` | 真实使用发现 Native 段文件 mmap 常驻导致 EBUSY；删除前先 `clearImageIndex()` 解除映射并 dispose ANN worker                        |
| VAL-022 | `2aa489b` | 审计确认 VAL-034 已完成代码级修复；本项补齐 scope starvation 夹具（变异验证有效）并把游离测试接入 `test:vector-pipeline`          |
| VAL-035 | `e60f882` | DINO ANN scope 以路径快照下推到 worker 候选选择（先于 topK 堆）；快照缺失时保持旧行为，精确回退做安全网                           |
| VAL-027 | `8cba7a0` | 未审查 ONNX 导入检查移入一次性子进程（堆上限/超时/崩溃恢复/有界分帧）；打包链同步                                                 |

另有一笔运维提交 `a4a199f`：VAL-003 观察计划任务改为 wscript 隐藏启动（见下）。

## 进行中

- **VAL-037**（`fix/subject-embedding-boundaries`，value 95）：隔离并严格校验 subject/face/person embedding
  输出与缓存，显式 negative 状态 + 损坏安全降级。复用 VAL-027 的 `userModelRuntimeHost` 生命周期，扩展子进程
  `run` 操作。注意：通过导入检查的模型仍可能在 `session.run` 时行为异常，hostile tensor 夹具必须覆盖。

## 下一项（VAL-037 完成后按价值与依赖排序）

1. **VAL-038**（92，`fix/vector-source-integrity-proof`）：authoritative/delta/derived F16 统一缓存证明，阻止落盘损坏进入搜索与 ANN。
2. **VAL-036**（88，`fix/semantic-scope-state`）：区分 Native scope 缺失/有效空库/损坏，损坏时禁止静默扩大为全 CLIP 搜索。注意空 scope 现有行为已被 VAL-022 夹具钉住，实施时需同步更新该夹具。
3. **VAL-028**（86，`perf/semantic-search-worker`）：CLIP F16 解码+点积迁出主进程。VAL-035 已记录交接：scope 集合目前按查询克隆，迁 worker 时应按 generation 共享。
4. **VAL-029**（85，`fix/electron-ai-security-hardening`）、**VAL-031**（73）、**VAL-033**（73）、**VAL-032**（65）随后。

## 需要用户/授权人决策的事项（自动化不能越权）

1. **DINO authoritative generation 迁移（紧）**：用户 2026-08-10 清空 vector-db 重建向量后，CLIP 召回门禁已通过
   （32 查询），但 DINO authoritative generation/composite snapshot 缺失或过期。VAL-003 周期计数因此无法开始。
   自动探测给出的命令（真实数据操作，需用户明确授权后执行）：
   `npm.cmd run vector-store:migrate -- "%APPDATA%\floating-clock-electron" --execute`
2. **VAL-011**：项目 EULA + ONNX Runtime GPU + CUDA + cuDNN + CUDA worker 共 5 项审批仍全部 `pending`，
   等待真实授权人签核（材料见 `docs/current/2026-08-09-val-011-license-approval-packet.md`）。审批通过后计划任务
   会自动运行限定回归，无需人工触发。
3. **VAL-026 / VAL-030**：Native index/Data Catalog 重建授权、正式发布签名与异机灾备，仍 blocked。

## 运维事实

- **计划任务 `Reasonix-VAL003-Observations`**：登录 + 每日 20:10 触发，动作已改为
  `wscript.exe scripts/run-value-observations-hidden.vbs`（隐藏窗口；S4U 方案在本机报 0x800706F7 已弃用）。
  任务注册/恢复/检查脚本在忽略版本控制的 `artifacts/`（`restore-val003-task.ps1`、`start-val003-task.ps1`、
  `check-val003-task.ps1`）。
- **VAL-003 周期**：因向量库重建按规则从 0/3 重新累计；需 3 个相隔 ≥24 小时且 evidence contract 一致的召回周期。
  上述 DINO 迁移完成前周期不会计数。最新报告：`artifacts/value-optimization/last-run.json`。
- **约束**：不触发系统关机；不处理 ACC-02；不伪造审批或维护周期。

## 工作规则速查（本轮验证有效的流程）

1. `todo:value-next` 选任务 → 建分支（`fix|feat|perf|docs|task/<名>`）→ TODO 表置 `in_progress` 并提交 `docs(todo)`。
2. 实现 + 夹具测试（只用临时目录，真实用户数据只读）→ 跑门禁：`typecheck`、`lint`、`format:check`、相关测试包、
   全量 `verify`。
3. 提交信息格式（hook 强制）：`<type>(<scope>): <summary>` + 正文段落 + trailer
   `Executor-System` / `Executor-Model` / `Task` / `Validation`。pre-commit 会跑 preflight + 暂存快照验证。
4. 合入：`git checkout main && git merge --ff-only <branch>`；TODO 表置 `verified` 并附证据记录。
   禁止直接在 main 提交（pre-commit 拒绝）。
5. 每项完成时审计相邻链，新发现回填 TODO 表（VAL-035/036/037/038 都是这样来的）。
