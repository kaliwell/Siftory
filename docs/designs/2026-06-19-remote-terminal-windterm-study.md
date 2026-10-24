# Remote Terminal: WindTerm 学习与重构方案

更新时间：2026-06-19

## 参考对象

WindTerm 是一个成熟的 SSH/Telnet/Serial/Shell/SFTP 客户端。公开仓库：

- https://github.com/kingToolbox/WindTerm
- https://github.com/kingToolbox/WindTerm/wiki

本项目只学习产品结构和交互方法，不复制 WindTerm 实现，也不扩展到 SFTP、端口转发、跳板机、脚本自动化等高风险范围。

## WindTerm 值得学习的方法

1. 会话是第一等对象，不是临时连接按钮。
   - profile 保存 host、port、username、auth type、key path、tags、last connected。
   - 敏感信息仍然不落盘，password/passphrase 每次连接时临时输入。

2. 连接状态必须精确。
   - `connecting` 只代表 TCP/SSH 正在建立。
   - `connected` 必须等 shell stream 创建成功后才进入。
   - auth failed、timeout、shell failed、remote closed 要有明确用户可读文案。

3. tab 是 session 的视图。
   - 连接成功才创建可交互 tab。
   - 连接失败不创建空白 tab，只在状态区展示错误。
   - close tab 必须释放 main process session。

4. terminal emulator 与 SSH transport 分层。
   - renderer 只负责 xterm 渲染、输入和 resize。
   - main process 负责 ssh2 连接、shell、stream 生命周期。
   - renderer 不读取 private key 文件，不保存密码。

5. 恢复和隐藏要保持状态一致。
   - 原生窗口 hidden/visible 与 renderer 面板 `globalVisible` 必须同步。
   - 全局隐藏后再次显示时，应恢复上次隐藏前的面板集合。

## 当前已落地的重构点

1. 修复 xterm 样式缺失。
   - 加载 `xterm/css/xterm.css`，避免隐藏 textarea 直接显示在界面上。

2. 修复全局隐藏后需要按两次才显示。
   - 主进程窗口不可见时先 `showInactive()`。
   - 立即发送 `show-global-visibility` 给 renderer。
   - renderer 恢复 `savedVisibility` 中的面板状态。

3. 修复连接状态语义。
   - `connected` 只在 `client.shell()` 成功后发出。
   - shell 创建失败会清理 session 并返回 error。

4. 修复认证失败的 UI 行为。
   - 连接失败不再创建空白 terminal tab。
   - `All configured authentication methods failed` 归一化为可理解的认证失败文案。
   - password profile 没有输入密码时不发起连接。

5. 增加 keyboard-interactive 兼容。
   - 部分 SSH 服务端禁用直接 password auth，但允许 keyboard-interactive。
   - 当前用同一临时密码响应 keyboard-interactive prompt。

6. 连接成功后更新 `lastConnectedAt`。
   - 只更新非敏感 profile 元数据。

7. 新增自动连接测试接口。
   - IPC：`remoteTerminal:testConnection`
   - Renderer API：`window.electronAPI.remoteTerminal.testConnection(req)`
   - 测试 SSH 握手和认证，不创建 shell，不创建 terminal tab。
   - 返回 `ok / stage / durationMs / message`，用于 UI 自动测速和故障诊断。
   - 支持 password、privateKey、agent；password/passphrase 仍只通过本次调用临时传入，不落盘。

8. 新增批量测试入口。
   - UI：profile 列表顶部 `Test All`。
   - 自动测试不需要交互密钥的 profile。
   - password/privateKey 等需要临时 secret 的 profile 默认跳过，避免保存或复用敏感信息。
   - 单个 profile 仍可点击 `Test` 并输入临时 secret 后测试。
   - 列表内显示最近一次测试的 OK/FAIL、耗时、失败阶段和错误摘要。

9. 新增基于测试结果的列表排序和过滤。
   - 排序：Name / Latency / Recent。
   - 过滤：All / OK / Fail。
   - Latency 排序优先显示测试成功且延迟低的 profile，其次显示失败项，最后显示未测试项。

10. 持久化最近测试结果。
    - profile 增加 `lastTest` 非敏感元数据。
    - 保存字段：`ok / stage / durationMs / message / testedAt`。
    - 不保存 password、passphrase、private key 内容。
    - 应用重启后可继续显示上次测试结果，并可用于 Latency 排序。

11. 修复 `ssh2` keyboard-interactive 认证接入。
    - Windows OpenSSH 可连通但应用失败时，根因是 `ssh2` 的 keyboard-interactive 不是 `config.onKeyboardInteractive` 配置项。
    - 正确方式是监听 client 的 `keyboard-interactive` 事件，并用本次输入的临时密码响应 prompts。
    - `connect` 和 `testConnection` 都已接入该事件。
    - host key 首次确认不是本次失败原因：`ssh2` 默认未配置 `hostVerifier` 时会自动接受 host key。

12. 修复空用户名误报认证失败。
    - 空用户名示例 profile 显示为 `@203.0.113.10:22`，说明 username 为空。本文地址均为文档示例地址。
    - Windows 终端成功命令是 `ssh example-user@203.0.113.10`，因此 profile 填写实际 SSH 用户名。
    - 主进程保存 profile 时要求 username。
    - renderer 保存按钮要求 username。
    - connect/test 在 username 为空时直接提示 `Username is required`，不再进入 SSH 认证流程。

13. 实现每个 session 独立 xterm buffer。
    - 旧逻辑：切换 `activeTabId` 时 dispose 当前 xterm，再创建新 xterm，导致屏幕内容丢失。
    - 新逻辑：每个 sessionId 对应一个 xterm 实例和一个 DOM 容器。
    - tab 切换只切换容器 `display`，不销毁 xterm。
    - SSH 输出按 sessionId 写入对应 xterm，不依赖当前激活 tab。
    - 关闭 tab 或 session 断开时才 dispose 对应 xterm。

## 后续重构路线

补充规划：

- 便携凭据与服务器监控能力见 `docs/designs/2026-06-19-remote-terminal-credentials-monitoring-plan.md`。
- WindTerm 学习文档继续聚焦 session / tab / terminal 交互。
- ServerBox 类能力单独作为服务器状态和凭据管理路线推进。

第一阶段：稳定 SSH 终端

- 拆分 `RemoteTerminalPanel`：
  - `RemoteTerminalSidebar`
  - `RemoteTerminalTabs`
  - `RemoteTerminalViewport`
  - `RemoteTerminalProfileEditor`
  - `useRemoteTerminalSessions`
- 每个 session 独立 xterm buffer，切 tab 不丢屏幕内容。
- 断开连接后保留最后输出和状态，允许用户手动关闭 tab。
- 扩展自动测试：
  - 按最近可用性做更细的排序。

第二阶段：接近 WindTerm 的会话管理体验

- profile 分组和 tag 筛选。
- 最近连接排序。
- duplicate profile。
- reconnect。
- profile import/export，但继续禁止导出敏感信息。

第三阶段：安全增强

- known_hosts 管理。
- host fingerprint 首次确认。
- 私钥路径由主进程 file dialog 选择，不允许 renderer 任意读取。
- 可选系统凭据管理器，不保存明文密码。

## 验收标准

- 错误密码：不创建空白 tab，状态区显示认证失败。
- 正确密码：连接成功后出现 terminal tab，可输入命令并看到输出。
- 关闭 tab：main process session 被释放。
- `Ctrl+Shift+Alt+Q`：隐藏后再次按一次即可恢复，不需要按两次。
- 显示锁：锁定显示的 remote terminal 不被全局隐藏。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

## 2026-06-19 进度记录

已完成：

- WindTerm 风格的 session / tab / terminal transport 分层已经在现有实现里落地一部分。
- 右侧 Dashboard 已拆分出独立组件 `src/components/remote-terminal/ServerDashboard.tsx`。
- 连接后保留终端和一条紧凑状态栏，不再让概览完全消失。
- 视觉策略已经明确回到透明风格，只提高文字亮度，不再堆不透明底。

当前重点：

- 继续把 `RemoteTerminalPanel` 拆成更小的子模块。
- 保持“连接、测试、监控”这三条主路径稳定。
- 后续优先补 known_hosts / fingerprint 和更安全的凭据管理。

## 2026-06-21 主机指纹安全增强

已完成：

- 使用 SSH 服务端公钥的 SHA-256 指纹作为 profile 固定值。
- 首次连接未知主机时先阻断，并要求用户与服务器管理员独立核对指纹。
- 用户确认后才保存 `hostFingerprint` 并重新发起连接。
- 后续连接严格匹配固定指纹；服务端密钥变化时阻断并显示新指纹。
- connect、connection test、metrics 采集使用同一校验逻辑。
- profile 编辑器可查看固定指纹；手动清除操作带风险说明。

仍需人工验收真实 SSH 主机及密钥轮换场景。后续可以在此基础上增加 OpenSSH `known_hosts` 导入/导出，但不再允许默认自动接受主机密钥。
