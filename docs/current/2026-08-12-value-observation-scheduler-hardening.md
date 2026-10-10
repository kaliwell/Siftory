# Value observation scheduler hardening

> 状态：当前  
> 更新日期：2026-08-12  
> 范围：VAL-003/VAL-011 Windows 计划任务  
> 替代文档：无

## 原因

旧的 Windows 计划任务在登录时通过未签名的 `wscript.exe`/VBS 包装器隐藏启动
`node.exe`，随后由 Node 进程长期驻留并轮询。虽然探测逻辑不联网、不提权、不接受许可证，
这种“登录持久化 + 隐藏脚本解释器链 + 常驻轮询”的组合容易触发终端安全软件的启发式检测。

## 修复

- 删除 `scripts/run-value-observations-hidden.vbs`。
- `scripts/schedule-value-observations.cjs` 改为单次执行：检查向量修复状态、运行一次
  VAL-003/VAL-011 安全探测、输出下一次建议时间，然后退出。
- 向量重建未完成时输出结构化 `skipped` 结果并退出，不再在后台等待。
- Windows 计划任务仅保留每日触发，直接执行受信任安装路径下的 `node.exe`，不再登录触发，
  不使用隐藏窗口参数，不分离子进程。
- 探测器创建 allowlist 子进程时不再设置 `windowsHide: true`，整个任务链均不主动隐藏窗口。
- 单实例锁继续保留，用于防止计划任务与人工执行重叠。

系统任务 `Reasonix-VAL003-Observations` 已在 2026-08-12 完成迁移。旧常驻 Node 进程已
停止；当前任务没有登录触发器，每天 20:10 运行一次，最长执行 2 小时。

## 保持不变的安全边界

- 不删除 JSONL 或其他用户数据。
- 不自动接受或伪造许可证审批。
- 不修改价值 TODO 的状态。
- 仅运行既有 allowlist 中的 VAL-003 和 VAL-011 探测。

计划任务动作应为：

```text
程序：C:\Program Files\nodejs\node.exe
参数：<project>\scripts\schedule-value-observations.cjs
工作目录：<project>
触发器：每天 20:10
最长运行时间：2 小时
```

## 验证

| 项目         | 命令或证据                                                 | 结果                                              |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| 专项测试     | `node --test tests/value-optimization-automation.test.cjs` | 16/16 通过                                        |
| 格式         | `npx.cmd prettier --check ...`                             | 通过                                              |
| 静态检查     | `npx.cmd eslint ...`                                       | 通过                                              |
| 计划任务 XML | `schtasks /Query /TN "Reasonix-VAL003-Observations" /XML`  | 直接 Node、0 个登录触发器、1 个每日触发器、`PT2H` |
| 进程检查     | 按脚本绝对路径查询 `Win32_Process`                         | 旧常驻实例为 0                                    |

未执行真实 VAL-003 召回 smoke；它会读取真实向量库并可能运行较长时间。调度外壳使用
不存在的临时向量状态做单次退出 smoke，不读写真实自动化状态。
