# DeepSeek 交接说明：远程终端管理功能

## 交接目的

本文件用于让 DeepSeek 接手新的 `Remote Terminal Manager / 远程终端管理` 功能设计与开发。

目标是为 Floating Clock Electron 增加一个类似 WindTerm 的轻量远程终端管理面板，用于集中管理 SSH 连接、快速打开远程终端、保存会话配置和执行基础终端操作。

## 项目路径

`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`

## 必读文档

请按顺序阅读：

1. `docs\history/project-progress-and-audit-log.md`
2. `docs\designs/image-search-rearchitecture.md`
3. `docs\handoffs/2026-06-18-app-storage-handoff.md`
4. `docs\handoffs/2026-06-18-app-storage-defect-feedback.md`

阅读目的：

- 第 1 份文档用于确认当前构建链、审计状态、剩余 warning 和发布判断。
- 第 2 份文档用于理解现有 native/IPC/状态推送/长任务处理思路。
- 第 3、4 份文档用于理解最近新增功能的接入方式、文档规范和验证要求。

## 当前项目事实

以下事实已经验证：

- `npm.cmd run format:check` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd audit --audit-level=high` 通过，`found 0 vulnerabilities`。
- `npm.cmd run test:native` 通过，26 passed。
- `npm.cmd run test:guards` 通过，4 passed。
- `npm.cmd run test:settings` 通过，3 passed。
- `npm.cmd run build` 通过。
- `release\win-unpacked\FloatingClock.exe` smoke test 通过，5 秒后仍运行。

仍存在：

- native C++ 编译 warning：`C4819`、`std::filesystem::u8path` deprecated。
- 构建链仍有 Node `DEP0190` 提示，当前不阻断。
- `lint` 仍有 warning，不能扩大 warning 面。

## 功能目标

实现一个类似 WindTerm 的轻量远程终端管理功能，第一阶段聚焦 SSH。

功能名称建议：

- 英文：`Remote Terminal`
- 中文：`远程终端`
- 面板组件：`RemoteTerminalPanel`

第一阶段目标：

1. 管理 SSH 会话列表。
2. 支持新增、编辑、删除、复制会话配置。
3. 支持按名称、主机、标签搜索会话。
4. 支持连接 SSH 并打开交互式终端。
5. 支持多标签终端会话。
6. 支持断开、重连、关闭终端。
7. 支持基础终端尺寸自适应。
8. 支持保存非敏感配置。
9. 支持安全处理密码、私钥路径、passphrase。
10. 支持连接状态、错误信息、最近连接时间显示。

第一阶段不要实现：

- 不要做 SFTP 文件管理。
- 不要做端口转发。
- 不要做跳板机链路。
- 不要做 RDP/VNC/Telnet。
- 不要做批量命令执行。
- 不要做自动输入密码脚本。
- 不要保存明文密码。
- 不要执行危险系统级命令。

## 推荐技术路线

### Renderer 终端

建议使用：

- `xterm`
- `@xterm/addon-fit`
- 可选：`@xterm/addon-web-links`

用途：

- 在 renderer 中渲染终端。
- 处理用户输入。
- 处理终端 resize。
- 展示 ANSI 输出。

注意：

- 不要自己手写 terminal emulator。
- xterm 实例需要在组件卸载时 dispose。
- FitAddon resize 需要节流，避免频繁 IPC。

### Main 进程 SSH

建议使用：

- `ssh2`

用途：

- 在 Electron main 进程中建立 SSH 连接。
- 创建 shell stream。
- 将 stream 数据通过 IPC 推给 renderer。
- 将 renderer 输入通过 IPC 写入 stream。
- 处理 resize：`stream.setWindow(rows, cols, height, width)`。

注意：

- SSH 连接必须在 main 进程，不要在 renderer 中直连。
- 每个连接必须有唯一 `sessionId`。
- main 进程需要维护 session map。
- 关闭 terminal tab 时必须释放 stream 和 connection。

## 数据模型建议

### 会话配置

建议新增类型：

```ts
export interface RemoteTerminalProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath?: string
  tags: string[]
  group?: string
  lastConnectedAt?: number
  createdAt: number
  updatedAt: number
}
```

不要在该结构中保存：

- password
- passphrase
- privateKey 原文

### 连接请求

```ts
export interface RemoteTerminalConnectRequest {
  profileId: string
  password?: string
  passphrase?: string
  cols: number
  rows: number
}
```

### 连接状态

```ts
export interface RemoteTerminalSessionStatus {
  sessionId: string
  profileId: string
  state: 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'
  message?: string
  connectedAt?: number
  disconnectedAt?: number
}
```

## 配置保存策略

建议文件：

- Electron `userData` 下：`remote-terminal-profiles.json`

保存内容：

- profile 列表
- 标签/分组
- 最近连接时间
- UI 最近选择

禁止保存：

- 明文密码
- passphrase
- 私钥正文

如果必须保存密码，必须另开设计文档，并优先使用系统凭据管理器；第一阶段不做。

## IPC 设计建议

建议在 `shared\ipc-contract.ts` 扩展：

```ts
remoteTerminal: {
  listProfiles: () => Promise<RemoteTerminalProfile[]>
  saveProfile: (profile: RemoteTerminalProfile) => Promise<{ ok: boolean; error?: string }>
  deleteProfile: (id: string) => Promise<{ ok: boolean; error?: string }>
  connect: (req: RemoteTerminalConnectRequest) => Promise<RemoteTerminalSessionStatus>
  disconnect: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  write: (sessionId: string, data: string) => Promise<{ ok: boolean; error?: string }>
  resize: (
    sessionId: string,
    size: { cols: number; rows: number; width?: number; height?: number },
  ) => Promise<{ ok: boolean; error?: string }>
  onData: (cb: (event: { sessionId: string; data: string }) => void) => () => void
  onStatusChanged: (cb: (status: RemoteTerminalSessionStatus) => void) => () => void
}
```

主进程 IPC channel 建议：

- `remoteTerminal:listProfiles`
- `remoteTerminal:saveProfile`
- `remoteTerminal:deleteProfile`
- `remoteTerminal:connect`
- `remoteTerminal:disconnect`
- `remoteTerminal:write`
- `remoteTerminal:resize`
- `remoteTerminal:onData`
- `remoteTerminal:onStatusChanged`

## 推荐文件改动范围

新增：

- `electron\remoteTerminalService.ts`
- `src\components\RemoteTerminalPanel.tsx`
- 可选：`src\services\remoteTerminalBridge.ts`
- 可选：`tests\remote-terminal-profiles.test.cjs`

修改：

- `shared\ipc-contract.ts`
- `electron\preload.ts`
- `electron\main.ts`
- `src\stores\useStore.ts`
- `src\types\index.ts`
- `src\components\SettingsPanel.tsx`
- `src\App.tsx`
- `src\hooks\useAutoSaveSettings.ts`
- `src\hooks\useLinkedMove.ts`

## UI 要求

Remote Terminal 面板应遵循当前 Floating Clock 面板风格：

- 使用 `DraggablePanel`。
- 支持移动、调整大小、锁定、锁定显示。
- 支持全局快捷键隐藏逻辑中的 lockedVisibility。
- 不要做独立窗口，第一阶段做成面板。
- 不要做 landing page。

建议布局：

- 左侧：会话列表、搜索、标签/分组过滤。
- 右侧：终端标签页。
- 顶部工具栏：连接、断开、重连、新建、编辑、删除。
- 底部或状态区：连接状态、host、username、latency/connected time。

空间有限时：

- 会话列表可折叠。
- 终端区域优先保证可用。
- 按钮使用短文本或图标，避免挤压。

## 安全要求

必须遵守：

- 不在 renderer 保存敏感信息。
- 不在配置 JSON 中保存明文密码。
- 不把密码/passphrase 打到 console。
- 不把 SSH 输出写入日志文件。
- 不支持自动执行危险命令。
- 不支持隐藏式后台连接。
- 用户点击连接时必须明确知道连接目标。
- 删除 profile 只删除本地配置，不影响远程服务器。

路径安全：

- 私钥路径必须通过主进程读取。
- 私钥路径要用现有路径 guard 思路做基本校验。
- 不允许 renderer 直接读取私钥文件。

连接安全：

- 第一阶段可以允许首次连接 unknown host，但必须在 UI 显示提示。
- 后续建议实现 known_hosts 管理。
- 不要默认跳过所有 host key 校验而不提示用户。

## 错误处理

必须覆盖：

- DNS/host 不存在。
- 端口拒绝连接。
- 超时。
- 用户名或密码错误。
- 私钥路径不存在。
- 私钥 passphrase 错误。
- SSH 会话被远程断开。
- renderer 关闭 tab 后 main 进程清理 session。

错误应显示在 UI 状态区，不要只写 console。

## 第一阶段验收标准

功能验收：

- 可以新增 SSH profile。
- 可以编辑 SSH profile。
- 可以删除 SSH profile。
- 可以搜索 profile。
- 可以用密码连接一台 SSH 主机。
- 可以用私钥路径连接一台 SSH 主机。
- 终端能交互输入命令并看到输出。
- 终端 resize 后远程 shell 显示正常。
- 可以断开和重连。
- 可以同时打开至少 2 个终端标签。
- 关闭标签后 main 进程 session 被释放。
- 重启应用后 profile 仍存在，密码不保存。

质量验收：

- `npm.cmd run format:check` 通过。
- `npm.cmd run typecheck` 通过。
- `npm.cmd run build` 通过。
- `npm.cmd audit --audit-level=high` 通过。
- 如果新增依赖，必须确认没有 high 漏洞。

人工验收：

- 连接本地或局域网 SSH 测试机。
- 输入 `pwd`、`ls`、`top` 或 Windows 远程 shell 对应命令。
- 测试中文输出。
- 测试断网/错误密码/错误端口。
- 测试关闭面板或标签是否断开连接。

## 推荐实现顺序

1. 安装并确认依赖：`xterm`、`@xterm/addon-fit`、`ssh2`。
2. 定义 `shared\ipc-contract.ts` 类型和 ElectronAPI。
3. 实现 `electron\remoteTerminalService.ts` 的 profile 存储。
4. 实现 SSH connect/disconnect/write/resize/session map。
5. 在 `preload.ts` 暴露 `remoteTerminal` API。
6. 在 `main.ts` 注册 IPC。
7. 新增 `RemoteTerminalPanel`，先实现 profile 列表和单终端连接。
8. 再实现多标签。
9. 接入 `useStore`、`SettingsPanel`、`App.tsx`。
10. 跑完整验证并更新 `docs\history/project-progress-and-audit-log.md`。

## 需要避免的破坏

- 不要修改或回退现有构建链：
  - 保留 `vite.config.mjs`
  - 保留 `scripts/build.cjs`
  - 保留 `scripts/build-native.cjs`
  - 保留 Electron 42 / electron-builder 26 当前配置
- 不要破坏 Image Search。
- 不要破坏 App Storage。
- 不要扩大 native warning。
- 不要把远程终端逻辑写进 renderer 直连网络。
- 不要保存明文凭据。

## 完成后必须更新

完成实现或阶段性实现后，必须更新：

`docs\history/project-progress-and-audit-log.md`

更新内容：

- 新功能完成度。
- 修改文件列表。
- 新增依赖列表。
- 验证命令结果。
- 安全边界说明。
- 剩余问题。
- 当前评分。
- 后续建议。

## DeepSeek 接手提示

请先只实现第一阶段 SSH 远程终端管理，不要扩展到 SFTP、端口转发、RDP、VNC、Telnet 或批量命令。该功能涉及凭据和远程服务器操作，安全边界优先于功能数量。
