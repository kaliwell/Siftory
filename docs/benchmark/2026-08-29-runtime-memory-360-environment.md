# 360 实时防护环境三轮证据（RMO-053）

> 日期：2026-08-29  
> 结论：通过；360 全程保持启用，未添加排除项

## 三轮采样

每轮采样 10 次，间隔 1 秒；报告不包含可执行文件绝对路径。

| 轮次 | 状态 | 360 防护/病毒库 | 360 进程 Private Bytes 峰值合计 | 备注 |
| --- | --- | --- | ---: | --- |
| 1 | passed | enabled / up-to-date | 341.17 MiB | 包含一次 `LiveUpdate360.exe` |
| 2 | passed | enabled / up-to-date | 320.59 MiB | 常驻进程 |
| 3 | passed | enabled / up-to-date | 318.58 MiB | 常驻进程 |

最大与最小相差约 7.1%，差异可由第一轮出现的更新进程解释，不构成异常离散。三轮均检测到 360 安全卫士、主动防御服务和启用状态；没有停止进程、服务或实时防护，也没有写入杀毒排除配置。

原始证据位于 `artifacts/benchmark/runtime-memory/security/`：

- `security-environment-2026-08-29T05-47-10-9978445Z.json`
- `security-environment-2026-08-29T06-31-25-0413347Z.json`
- `security-environment-2026-08-29T06-32-04-8971760Z.json`

这份证据只关闭安全软件环境采样任务，不替代 RMO-005 的正式静默硬件三轮基线；GPU 桌面噪声不合格时，正式性能轮仍必须判为环境无效。
