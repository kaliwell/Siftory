# Remote Terminal 专业终端功能扩展方案

更新时间：2026-06-21

项目路径：

`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`

## 文档目的

当前 Remote Terminal 已具备 SSH profile、多标签终端、连接测试、服务器指标采集、session-only 凭据缓存和主机指纹固定，但仍偏向“SSH 连接面板”，尚未形成 WindTerm、Xshell/Xftp 一类专业终端工具的完整工作流。

本方案定义后续功能边界和落地顺序，优先补齐以下高频能力：

1. SFTP 文件浏览、上传、下载和传输队列。
2. 终端重连、搜索、日志、分屏和命令片段。
3. SSH 端口转发、跳板机和代理链路。
4. 会话导入导出、主机密钥管理和可选安全凭据存储。

> 架构关系更新（2026-08-11）：本文继续作为专业 SSH 终端与传输能力的专项方案；面向 NAS 和局域网设备时，SSH/SFTP 的主要产品角色调整为远程素材源、按需预览和素材取回通道。统一来源身份、远程目录索引、离线语义和 AI 素材搜索接入，以[本地与 NAS AI 素材发现统一架构方案](2026-08-11-local-nas-ai-asset-discovery-architecture.md)为准。Remote Terminal 保留为高级工具，不再作为普通素材用户的默认主入口。

本项目不追求复制竞品界面，而是吸收成熟终端软件的通用工作流，并保持 Floating Clock 的透明悬浮面板、低侵入和明确安全边界。

## 参考方向

主要参考：

- WindTerm：会话管理、多协议终端、SFTP、分屏、命令片段和便携工作流。
- Xshell：SSH 会话管理、多标签、端口转发、会话日志、脚本/命令辅助和主机密钥管理。
- Xftp：双栏文件管理、传输队列、冲突处理、同步浏览和断点续传工作流。

官方入口：

- WindTerm：`https://github.com/kingToolbox/WindTerm`
- Xshell：`https://www.netsarang.com/en/xshell/`
- Xftp：`https://www.netsarang.com/en/xftp/`

说明：参考产品用于确认常见功能类别，不代表本项目必须实现其全部协议或完全复刻行为。具体技术约束以 Electron、`ssh2` 和本项目安全模型为准。

## 当前基础能力

已完成：

- SSH password、private key、agent 认证模型。
- 多 profile、多 terminal tab 和独立 xterm buffer。
- connect、disconnect、resize、connection test。
- session-only password/passphrase 缓存，不写磁盘。
- SHA-256 SSH 主机指纹首次确认、持久化和变化阻断。
- Linux CPU、内存、磁盘、网络和 uptime 指标采集。
- profile 搜索、测试结果过滤、延迟和负载排序。
- Electron sandbox、CSP 和导航限制。

当前主要缺口：

- 无 SFTP/SCP 文件工作流。
- 无传输任务中心、进度、取消、冲突和失败重试。
- 无 terminal 搜索、会话日志、分屏和可靠重连。
- 无端口转发、跳板机和代理配置。
- 无统一 known_hosts 管理界面。
- RemoteTerminalPanel 仍过大，需要先拆分再扩展。
- 缺少真实 SSH/SFTP 集成测试和 UI 自动化。

## 能力路线图

| 能力 | 优先级 | 计划阶段 | 说明 |
| --- | --- | --- | --- |
| SFTP 目录浏览 | P0 | Phase 1 | 专业 SSH 客户端基本能力 |
| 上传、下载、取消、重试 | P0 | Phase 1 | 必须有独立传输队列 |
| 覆盖/跳过/重命名冲突策略 | P0 | Phase 1 | 禁止默认静默覆盖 |
| 断点续传 | P1 | Phase 1.5 | 先支持普通文件，目录任务后补 |
| 新建目录、重命名、删除 | P1 | Phase 1.5 | 删除必须二次确认 |
| 拖放上传、下载到指定目录 | P1 | Phase 1.5 | 仍由主进程控制本地路径 |
| 自动重连和连接保活 | P0 | Phase 2 | 必须区分手动断开与异常断开 |
| 终端搜索、复制模式、日志 | P1 | Phase 2 | 日志默认关闭 |
| 分屏终端 | P1 | Phase 2 | 不复用同一个 shell stream |
| 命令片段/快捷命令 | P1 | Phase 2 | 默认只填入，不自动执行 |
| 本地/远程/SOCKS 转发 | P1 | Phase 3 | 默认仅绑定 localhost |
| Jump Host/ProxyJump | P1 | Phase 3 | 每跳均校验 host fingerprint |
| profile 导入导出 | P2 | Phase 3 | 默认排除凭据和运行状态 |
| OS safeStorage | 已完成 | 当前版本 | Windows DPAPI，绑定当前 Windows 用户 |
| 同步浏览、目录比较、批量同步 | P2 | Phase 4 | 需先有可靠传输引擎 |
| SCP/ZMODEM | P3 | Phase 4 | SFTP 不可用场景的补充，不作为首选 |
| RDP/VNC/Telnet | 不计划 | - | 超出当前 SSH 产品边界 |

## Phase 0：架构拆分

新增功能前必须先拆分当前大组件和主进程服务，避免把文件传输继续写入 `RemoteTerminalPanel.tsx` 和 `remoteTerminalService.ts`。

建议结构：

```text
electron/remote-terminal/
  profileStore.ts
  hostKeyStore.ts
  sshSessionManager.ts
  sftpService.ts
  transferManager.ts
  tunnelManager.ts
  metricsService.ts

src/components/remote-terminal/
  RemoteTerminalSidebar.tsx
  RemoteTerminalTabs.tsx
  TerminalViewport.tsx
  ProfileEditor.tsx
  ServerDashboard.tsx
  RemoteFileBrowser.tsx
  TransferQueue.tsx
  TunnelManager.tsx

src/hooks/
  useRemoteSessions.ts
  useRemoteFiles.ts
  useTransferQueue.ts
```

核心原则：

- SSH connection、shell、SFTP、tunnel 是同一 profile 下不同资源，不应互相假设生命周期完全一致。
- terminal tab 关闭时只释放对应 shell；如果仍有 SFTP 传输，底层 SSH client 不能被提前关闭。
- 使用 profile connection pool 或显式引用计数管理底层 SSH client。
- renderer 只维护可展示状态；真实连接、文件句柄、密钥和本地路径权限在 main 进程。

## Phase 1：SFTP 文件管理与传输

### 用户目标

- 连接服务器后直接浏览远程目录。
- 将本地文件或目录上传到当前远程目录。
- 将远程文件或目录下载到用户选择的本地目录。
- 在传输任务中心查看速度、进度、剩余时间、失败原因。
- 可以取消、重试和清理历史任务。
- 不因切换 terminal tab 或关闭文件浏览区域而中断后台传输。

### UI 布局

Remote Terminal 右侧区域增加视图切换：

```text
Terminal | Files | Monitor | Tunnels
```

Files 视图建议：

- 顶部：远程路径栏、Back、Up、Refresh、New Folder、Upload。
- 中部：文件列表，列出 Name、Size、Modified、Mode、Owner。
- 底部：可折叠 Transfer Queue。
- 列表右键：Download、Rename、Delete、Copy Path、Permissions。
- 支持将本地文件拖到远程文件列表进行上传。
- 下载必须通过主进程目录选择器选择目标目录。

第一阶段不做完整双栏本地文件管理器，避免重复现有 File Manager。后续可将现有 File Manager 作为本地栏，通过受控 transfer API 与 Remote Files 联动。

### SFTP 数据模型

```ts
export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt?: number
  accessedAt?: number
  mode?: number
  uid?: number
  gid?: number
  linkTarget?: string
}

export interface RemoteDirectoryPage {
  profileId: string
  path: string
  entries: RemoteFileEntry[]
  nextCursor?: string
}

export interface TransferTask {
  id: string
  profileId: string
  direction: 'upload' | 'download'
  sourceDisplayName: string
  destinationDisplayPath: string
  totalBytes: number
  transferredBytes: number
  speedBytesPerSecond: number
  etaSeconds?: number
  state: 'queued' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  conflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename'
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}
```

注意：传输任务推送到 renderer 的对象只能包含展示路径，不应暴露可复用的本地文件权限令牌或敏感凭据。

### IPC 设计

```ts
remoteTerminal.sftp = {
  open(profileId, credentialRequest?): Promise<SftpOpenResult>
  close(profileId): Promise<Result>
  list(profileId, remotePath, cursor?): Promise<RemoteDirectoryPage>
  stat(profileId, remotePath): Promise<RemoteFileEntry>
  mkdir(profileId, remotePath): Promise<Result>
  rename(profileId, oldPath, newPath): Promise<Result>
  remove(profileId, remotePaths): Promise<Result>
  chooseUploadSources(): Promise<UploadSelection>
  chooseDownloadDirectory(): Promise<DownloadSelection>
  enqueueUpload(request): Promise<TransferTask>
  enqueueDownload(request): Promise<TransferTask>
  pauseTransfer(taskId): Promise<Result>
  resumeTransfer(taskId): Promise<Result>
  cancelTransfer(taskId): Promise<Result>
  retryTransfer(taskId): Promise<TransferTask>
  listTransfers(): Promise<TransferTask[]>
  clearTransferHistory(): Promise<Result>
  onTransferChanged(callback): Unsubscribe
}
```

安全要求：

- renderer 不提交任意本地源路径或下载目标路径。
- `chooseUploadSources` 和 `chooseDownloadDirectory` 由 main 进程调用系统 dialog，返回短期 selection token。
- enqueue 请求使用 token；token 必须绑定 BrowserWindow、操作类型和过期时间，只能消费一次。
- 所有 IPC 校验 sender，拒绝非主窗口来源。
- SFTP 连接复用已有 profile 认证与 host fingerprint 校验，禁止建立绕过指纹校验的第二条连接。

### 传输实现规则

上传：

1. 在目标目录创建 `.floatingclock-<taskId>.part` 临时文件。
2. 分块写入并推送节流后的进度，建议 100-250ms 更新一次 UI。
3. 完成后关闭 handle，再原子 rename 到最终名称。
4. rename 前再次执行冲突策略，避免任务期间目标被其他进程创建。
5. 取消或失败后保留可恢复的 `.part`，由任务记录管理；超过保留期限再清理。

下载：

1. 在本地目标目录创建 `<filename>.floatingclock.part`。
2. 成功后使用原子 rename 替换最终名称。
3. Windows rename/覆盖失败时返回明确错误，不先删除用户原文件。
4. 取消后保留断点信息，用户可选择继续或删除临时文件。

目录传输：

- 先递归枚举形成 manifest，再进入传输队列。
- 默认不跟随 symlink，避免循环和越界。
- 每个任务限制文件数量、总路径长度和单项名称长度。
- 并发默认 2，可配置 1-4；同一磁盘或低速服务器不追求高并发。
- 单文件内部使用流式传输，不把整个文件读入内存。

### 冲突策略

必须支持：

- Ask：暂停任务并等待用户选择。
- Overwrite：显式覆盖。
- Skip：跳过并记录。
- Rename：生成 `name (1).ext` 一类不冲突名称。

目录任务可以选择“仅本次”或“应用到此任务剩余冲突”。默认始终是 Ask，不记忆为全局静默覆盖。

### 删除和危险操作

- 删除远程文件必须显示目标服务器、完整远程路径和项目数量。
- 删除目录默认只允许空目录；递归删除作为独立高级选项，默认关闭。
- 不提供 `rm -rf` shell 拼接实现，必须使用 SFTP 操作逐项处理。
- symlink 删除只删除链接本身，不跟随目标。
- 根目录、home 根和路径解析异常时拒绝批量删除。

### 断点续传

第一阶段先完成可取消的可靠普通传输；Phase 1.5 再启用 resume：

- 上传 resume 前比较远端 `.part` 大小和本地源文件 size/mtime。
- 下载 resume 前比较本地 `.part` 大小和远端源文件 size/mtime。
- 元数据不一致则禁止自动续传，要求重新开始。
- 不声称支持内容完整性校验，除非双方实际计算 SHA-256。

### Phase 1 验收标准

- 可浏览包含中文、空格和特殊字符的远程目录。
- 可上传/下载单文件、多个文件和目录。
- 1GB 以上文件全程流式传输，内存保持稳定。
- 传输显示进度、速度、ETA 和失败原因。
- 可取消和重试；关闭 Files 视图不终止后台任务。
- 冲突不会静默覆盖。
- 上传/下载失败不会留下伪装成完整文件的目标。
- SSH host fingerprint 不匹配时 SFTP 同样拒绝连接。
- 密码、passphrase、私钥内容和传输文件内容不写日志。

## Phase 2：终端基本能力完善

### 自动重连

- profile 可配置 `reconnectMode: 'off' | 'prompt' | 'auto'`，默认 prompt。
- 仅网络异常或远端异常关闭可触发重连；用户主动 Disconnect 不重连。
- 指数退避：1s、2s、5s、10s、30s，上限 5 次。
- 主机指纹变化、认证失败和凭据缺失禁止自动重连。
- 重连成功创建新的 shell stream，旧 stream 必须完全释放。

### Terminal Search

- 对 xterm scrollback 搜索，不搜索服务器文件。
- 支持大小写、全词、正则开关和上一项/下一项。
- 搜索只在 renderer 内进行，不上传终端内容。

### 会话日志

- 默认关闭，每个 session 明确开启。
- 支持纯文本和带时间戳文本；HTML/富文本后置。
- 启用时显示持续状态，避免用户不知道终端输出正在落盘。
- 日志路径由 main dialog 选择，renderer 不直接写文件。
- 日志可能包含凭据、token 和服务器输出，必须显示安全提示。
- 可选敏感模式：切换后暂停日志，恢复时记录时间段但不记录内容。

### 分屏终端

- 水平/垂直 split，每个 pane 对应独立 shell stream。
- pane 可属于同一 profile 或不同 profile。
- 每个 pane 独立 resize、搜索和连接状态。
- 首期限制最多 4 pane，避免透明窗口性能退化。

### 命令片段

```ts
interface CommandSnippet {
  id: string
  name: string
  command: string
  description?: string
  tags: string[]
  confirmation: 'never' | 'dangerous' | 'always'
}
```

- 默认操作是“插入到终端”，不自动发送 Enter。
- 检测 `rm`、`shutdown`、`reboot`、磁盘写入和权限修改等高风险模式并提示。
- 不保存片段执行结果，不做隐藏后台批量执行。
- 广播输入到多个 session 属于高级能力，默认关闭并要求持续视觉提示。

### 其他基础项

- Keepalive 间隔和连接超时配置。
- terminal scrollback 行数限制。
- 字体、字号、光标样式、bell 和复制粘贴行为。
- UTF-8 默认；其他编码支持需要独立编码转换层，不能只改 UI 标签。
- Copy as plain text、Select All、Clear Scrollback。
- 当前目录标题、远端 title sequence 和危险 OSC sequence 安全过滤。

## Phase 3：端口转发与跳板机

### Tunnel 类型

```ts
interface SshTunnelProfile {
  id: string
  profileId: string
  type: 'local' | 'remote' | 'dynamic'
  bindHost: string
  bindPort: number
  targetHost?: string
  targetPort?: number
  autoStart: boolean
}
```

规则：

- Local forward 默认绑定 `127.0.0.1`，绑定 `0.0.0.0` 必须显示暴露风险。
- Remote forward 必须显示服务将暴露到远端网络的提示。
- Dynamic forward 提供 SOCKS5，只监听用户明确选择的本地地址。
- autoStart 默认关闭，应用启动时不得静默建立隧道。
- tunnel 状态必须显示监听地址、目标地址、连接数和传输字节。
- profile 删除前检查关联 tunnel，不留下孤立配置。

### Jump Host

```ts
interface JumpHostRef {
  profileId: string
}
```

- 支持一到两跳，首期不做无限代理链。
- 每一跳独立校验 host fingerprint。
- 每一跳凭据独立，不继承目标服务器密码。
- 错误信息明确指出失败跳数和 host。
- 检测 profile 引用环。
- SFTP、terminal、metrics 和 tunnel 统一复用跳板链路能力。

## Phase 4：高级文件与团队工作流

可在可靠传输引擎稳定后实现：

- 双栏模式：复用现有 File Manager 作为本地栏，Remote Files 作为远程栏。
- 同步浏览：本地和远程按相对路径联动，不自动同步文件内容。
- 目录比较：按名称、大小、mtime；内容 hash 作为显式慢速选项。
- 单向同步预览：执行前列出 Upload、Download、Delete、Conflict 清单。
- 收藏远程路径和最近目录。
- chmod/chown，需明确展示八进制 mode 和影响范围。
- SCP fallback，仅在服务器不支持 SFTP 时启用。
- ZMODEM 作为终端内兼容能力，必须防止自动下载到未授权目录。
- profile 和 snippets 导入导出；敏感字段默认排除。

首期不实现自动双向同步。双向同步涉及删除传播、时钟差异和冲突合并，应单独设计并提供 dry-run。

## 安全模型

### 主机身份

- 所有 SSH 派生能力必须经过相同 host fingerprint 校验。
- 不允许 SFTP、tunnel 或 metrics 各自创建自动接受主机密钥的连接。
- 后续 known_hosts 页面提供：host、port、算法、fingerprint、首次信任时间、最近验证时间。
- 主机密钥变化只能手动清除并重新确认，不能“一键忽略并继续”。

### 凭据

- 默认不保存密码。
- session-only 凭据只在内存保存，进程退出清空。
- OS safeStorage 已落地，Windows 下使用 DPAPI；密文绑定当前 Windows 用户，不属于便携凭据。
- portableVault 仍需按现有凭据方案单独落地。
- transfer、tunnel、SFTP 不复制或记录 password/passphrase。
- 私钥路径必须由 main 进程读取，并限制文件大小和类型。

### 本地文件权限

- 文件选择和下载目录选择由 main 进程 dialog 完成。
- renderer 使用短期 token，不获得任意本地文件系统读写能力。
- token 绑定 sender、用途和过期时间，并采用一次性消费。
- 下载路径在 main 中执行 normalize、父目录确认和冲突校验。

### 远程路径

- 使用服务器返回的 SFTP 路径语义，不用本地 Windows `path.normalize` 处理远程 POSIX 路径。
- 拒绝 NUL、空路径和超过限制的路径。
- symlink 默认不跟随；如用户选择跟随，必须重新 stat 并检测循环。
- 删除、rename、chmod 前重新校验当前路径和 profileId。

### IPC

- 所有新增 handler 校验 `event.senderFrame` 属于主窗口。
- 所有参数从 `unknown` 开始解析，限制字符串长度、数组数量、并发和页大小。
- renderer 不能提交任意 shell command 作为文件操作实现。
- progress 事件按 window 和 taskId 路由，窗口销毁后停止发送。

## 性能与资源约束

- 单次目录列表默认最多 500 项，超出使用分页或增量加载。
- 传输进度推送最多每秒 4-10 次。
- 默认并发文件任务 2，最大 4。
- 单次目录 manifest 默认最多 100,000 文件，超出要求用户缩小范围。
- 列表使用虚拟滚动，避免大目录阻塞 renderer。
- 文件内容全程使用 stream 和背压，不使用 `readFile` 传输大文件。
- terminal、SFTP、metrics、tunnel 共享连接时必须有引用计数和 idle timeout。
- 应用退出时先停止接收新任务，再取消/完成任务并关闭 handle、SFTP channel、shell 和 SSH client。

## 错误模型

统一错误类型：

```ts
type RemoteErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'CREDENTIAL_REQUIRED'
  | 'HOST_KEY_UNKNOWN'
  | 'HOST_KEY_CHANGED'
  | 'AUTH_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'SFTP_UNAVAILABLE'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_PERMISSION_DENIED'
  | 'LOCAL_PERMISSION_DENIED'
  | 'CONFLICT'
  | 'TRANSFER_CANCELLED'
  | 'CONNECTION_LOST'
  | 'INVALID_PATH'
  | 'LIMIT_EXCEEDED'
```

错误必须包含用户可读消息、稳定 code 和可选 operationId。不要依赖解析英文错误字符串决定 UI 行为。

## 持久化设计

建议文件：

```text
remote-terminal-profiles.json
remote-terminal-host-keys.json
remote-terminal-snippets.json
remote-terminal-tunnels.json
remote-terminal-transfer-history.json
```

规则：

- 文件带 `schemaVersion`。
- 写入使用临时文件 + 原子 rename，损坏时备份。
- transfer history 只保存展示元数据，不保存 selection token、密码和文件内容。
- 默认只保留最近 200 条已结束任务，运行中任务单独恢复。
- profile 导出默认排除 lastMetrics、lastTest、credentialRef 和本机绝对私钥路径。

## 测试计划

### 单元测试

- 远程 POSIX 路径规范化和危险输入。
- host fingerprint 在 terminal/SFTP/tunnel 路径的一致性。
- selection token 过期、重复消费和 sender 绑定。
- 冲突 rename 算法。
- transfer 状态机合法迁移。
- 速度和 ETA 计算。
- profile jump chain 环检测。
- tunnel bind 地址安全规则。

### SFTP 集成测试

建立测试专用 SSH/SFTP 服务，覆盖：

- password 和 private key。
- Unicode、空格、长文件名和 symlink。
- 0 字节、小文件、多文件、1GB 稀疏测试文件。
- 上传/下载中断、取消、续传和重试。
- 权限拒绝、磁盘满、连接断开、目标冲突。
- 主机密钥变化后所有能力统一阻断。

禁止使用生产服务器凭据跑 CI。

### UI 测试

- Files/Terminal/Monitor 切换不丢状态。
- 传输期间切 tab、关闭面板和全局隐藏。
- 冲突对话框键盘操作。
- 取消、重试和任务历史清理。
- 透明背景下进度、错误和危险确认可读。

### 发布验证

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run verify
npm.cmd audit --audit-level=high
npm.cmd run build
```

并对新打包产物执行：

- 启动 smoke test。
- 真实 SSH/SFTP 上传下载测试。
- 安装/升级/卸载测试。
- 大文件传输期间内存和句柄监控。

## 建议实施顺序

1. 拆分 Remote Terminal renderer/main 架构，保持现有功能行为不变。
2. 建立统一 `sshSessionManager`，实现连接引用计数和 host key 公共校验。
3. 实现只读 SFTP：open、list、stat、分页和 Remote Files UI。
4. 实现 selection token 和单文件 upload/download。
5. 实现 Transfer Queue、进度、取消、冲突策略和原子完成。
6. 实现目录 manifest、多文件任务和失败重试。
7. 补 SFTP 集成测试，再实现断点续传。
8. 补 terminal 自动重连、搜索、日志和分屏。
9. 单独实施 tunnel 和 Jump Host，不与首期 SFTP 混合发布。
10. 最后评估同步浏览、SCP、ZMODEM 和安全凭据持久化。

## 第一里程碑定义

第一里程碑只交付“可靠 SFTP 基础版”：

- Remote Files 浏览。
- 上传和下载文件/目录。
- Transfer Queue。
- 进度、取消、重试。
- Ask/Overwrite/Skip/Rename 冲突策略。
- 临时文件 + 原子完成。
- host fingerprint 统一校验。
- 自动化测试和真实服务器人工验收。

明确不混入第一里程碑：

- 端口转发。
- Jump Host。
- 双向同步。
- 自动批量命令。
- OS 凭据持久化和 portableVault。
- SCP/ZMODEM。

这样可以先把最常用、最容易造成数据损失的文件传输能力做可靠，再扩展专业终端的其他功能。

## 2026-06-21 Phase 1 进度：只读 SFTP 基础版

已完成：

- 新增 `electron/remoteSftpService.ts`。
- 新增独立 renderer 组件 `RemoteFileBrowser.tsx`，没有继续扩大文件操作服务组件。
- Remote Terminal 右侧增加 `Files` 入口和覆盖式远程文件浏览视图。
- 支持远程路径输入、刷新、返回上级、目录双击进入。
- 显示 name、type、size、mtime、uid/gid/mode 数据模型。
- 远程路径按 POSIX 规则处理，拒绝 NUL、Windows 反斜杠、空路径和超长路径。
- 单次目录读取限制 5000 项，目录优先排序。
- SFTP 使用与 terminal 相同的 password/private-key/agent 认证逻辑。
- SFTP 自动使用 session-only 或 Windows DPAPI protected 凭据。
- SFTP 使用同一 SHA-256 host fingerprint 校验；未知主机先确认，变化后阻断。
- 新增 `remoteTerminal:listRemoteDirectory` IPC 和参数校验。
- 新增 `tests/remote-sftp.test.cjs`，覆盖路径 guard、Unicode 名称和元数据映射。

验证：

- `npm.cmd run verify`：59 tests passed。
- typecheck、format check、audit、renderer/main/preload、Node/Electron native 构建通过。
- lint：0 errors / 154 warnings，未扩大 warning 数量。
- NSIS 安装包重新生成，新产物 smoke test 通过。

当前限制：

- 尚未用真实 SSH/SFTP 服务器人工验证目录浏览和权限错误。
- 当前只读，不支持上传、下载、新建目录、rename 或 delete。
- 当前每次目录读取建立短连接，后续传输队列实施前需要落地 SSH/SFTP connection manager 和引用计数。
- 大目录分页尚未实现；当前超过 5000 项会拒绝并提示。

下一步：实现主进程受控文件选择 token、单文件 upload/download、临时文件原子完成和 Transfer Queue，不直接开放 renderer 任意本地路径读写权限。

## 2026-06-21 Phase 1 进度：单文件传输队列

已完成：

- 新增 `electron/remoteTransferService.ts`，传输逻辑与 UI 分离。
- 支持单文件 upload 和 download。
- 上传、下载均流式传输，不把整个文件读入内存。
- 默认最大并发为 2，超出任务进入 queued 状态。
- 状态包括 queued、preparing、running、completed、failed、cancelled。
- Transfer Queue 显示方向、文件名、进度、速度、ETA、状态和错误。
- 支持取消运行中/排队中的任务和清理已结束历史。
- 上传先写远程 `.floatingclock-<taskId>.part`，完成后 rename 到最终文件。
- 下载先写本地 `.floatingclock-<taskId>.part`，完成后 rename 到最终文件。
- 本地或远端目标已存在时任务失败，当前不允许静默覆盖。
- 文件和目录选择只能通过 main 进程系统 dialog。
- renderer 只拿到一次性 selection token；token 绑定 webContents、用途和 5 分钟有效期，消费一次后失效。
- 任务事件只向主窗口推送，task 对象不包含 password、passphrase、selection token 或真实本地源路径。
- 传输复用 DPAPI/session 凭据、private key 和 SHA-256 host fingerprint 校验。
- 新增 `tests/remote-transfer.test.cjs`，覆盖任务初始状态、敏感字段不暴露、本地冲突拒绝和未知任务取消。

验证：

- `npm.cmd run verify`：62 tests passed。
- typecheck、format check、audit、Node/Electron native、renderer/main/preload 构建通过。
- lint：0 errors / 154 warnings。
- NSIS 重打包和新产物 smoke test 通过。

当前限制与人工验收要求：

- 尚无测试 SSH/SFTP 主机，因此真实上传、下载、取消中断和权限错误未完成端到端验收。
- 当前只支持单文件，不支持多选和目录 manifest。
- 当前冲突策略只有安全拒绝，Ask/Overwrite/Skip/Rename UI 尚未完成。
- Pause、Resume、Retry 和断点续传尚未实现。

## 2026-06-22 overwrite 可靠性修复

已完成：

- 上传和下载不再于传输开始前删除现有目标。
- 新内容先完整写入任务专属 `.part` 文件。
- overwrite 提交时先将旧目标改名为任务专属 `.bak`，再将 `.part` 提交为最终目标；提交失败时尝试恢复 `.bak`。
- 本地安全替换已增加自动化测试。
- Remote Terminal 核心 IPC 已增加请求对象、凭据长度、session id、写入大小及终端行列范围校验。

限制：远端替换和回滚仍需在真实 SFTP 服务端上进行断线、权限不足和 rename 失败测试。当前分页实现仍会先读取完整目录，尚不是真正的流式分页。
- 任务历史仅保存在当前进程内，应用重启后不恢复。
- 每个任务当前建立独立 SSH/SFTP 连接；connection pool 和引用计数仍待实现。

下一步应先使用真实测试服务器验证 0 字节、Unicode、小文件、大文件、取消和连接中断，然后实现多文件 manifest、冲突选择和失败重试。
