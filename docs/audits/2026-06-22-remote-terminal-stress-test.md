# Remote Terminal 压力测试报告（2026-06-22）

## 测试环境

- Windows 11 10.0.22631
- Node.js 24.16.0
- Electron 42.4.1
- ssh2 1.17.0
- 本机没有运行或监听 22 端口的 SSH 服务。

## 自动化入口

```powershell
npm.cmd run test:remote-stress
```

压力测试位于 `tests/remote-stress.test.cjs`，不加入日常 `npm test`，避免常规验证受机器 I/O 波动影响。

## 测试结果

| 场景 | 负载 | 结果 | 典型耗时 |
| --- | ---: | --- | ---: |
| SSH 主机指纹校验 | 25,000 次 | 通过 | 17-19 ms |
| SFTP 远程路径规范化 | 100,000 次 | 通过 | 75-84 ms |
| Profile 并发保存 | 200 个并发写入 | 修复后连续 6 轮通过 | 262-282 ms |
| 本地传输原子替换 | 200 个并发文件 | 通过 | 通常 145-155 ms，单轮 I/O 抖动 419 ms |
| SSH 失败连接清理 | 50 个并发拒绝连接 | 通过，无 session 残留 | 9 ms |

指纹测试单轮堆内存增量约 5 MiB；路径测试约 8.5-9 MiB，均低于测试设置的 64 MiB 上限。

## 压测发现与修复

首次执行时，200 个并发 `saveProfile` 会同时覆盖 `remote-terminal-profiles.json`，生成交叉写入的无效 JSON，解析在第 53,802 字节失败。

修复方案：

- 每次保存生成不可变 JSON 快照。
- 所有 profile 写入进入进程内串行 Promise 队列。
- 先写入 `.tmp`，成功后 rename 替换正式文件。
- 写盘失败不再静默返回成功，而是向 IPC 调用方返回错误。

修复后连续执行 5 轮完整压力测试，随后再执行包含拒绝连接场景的最终压力测试，全部通过。

## 回归验证

- `npm.cmd run test:remote-terminal`：2 项通过。
- `npm.cmd run test:remote-sftp`：2 项通过。
- `npm.cmd run test:remote-transfer`：4 项通过。
- `npm.cmd run typecheck`：通过。

## 未覆盖范围

- 没有真实 SSH/SFTP 服务，因此未测试并发握手、认证、PTY 数据吞吐、SFTP 大目录和真实上传/下载。
- 未测试高延迟、丢包、连接中断、服务端限流及主机密钥在并发连接期间变化。
- 未进行持续数小时的 soak test，也未测量 Electron renderer/xterm 长时间输出时的内存曲线。

## 下一阶段建议

1. 准备隔离的 OpenSSH 测试容器或虚拟机，使用专用低权限账号和测试密钥。
2. 执行 50-100 个并发 SSH 握手、10-20 个并发 PTY 会话和至少 10 GiB 的持续终端输出测试。
3. 使用 1 KiB、1 MiB、1 GiB 文件组合验证 SFTP 队列、取消、断线回滚及临时文件清理。
4. 对 10,000 项以上远程目录测试当前 `readdir` 内存峰值，并推进真正的流式分页。
