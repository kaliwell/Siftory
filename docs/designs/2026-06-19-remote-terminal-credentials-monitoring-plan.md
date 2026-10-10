# Remote Terminal: 便携凭据与服务器监控方案

更新时间：2026-06-19

项目路径：

`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`

## 目标

在现有 SSH Remote Terminal 基础上，逐步扩展为轻量服务器管理面板，方向参考 ServerBox 类产品能力：

- SSH profile 管理
- 可选密码保存
- 批量连通性测试
- 服务器 CPU / 内存 / 磁盘 / uptime 状态检测
- 最近状态和延迟展示
- 便携模式配置
- 安全边界清晰，不默认保存敏感信息

该方案只做 SSH 资源监控和终端能力，不做危险自动化：

- 不做批量危险命令执行
- 不做自动提权
- 不做后门式后台连接
- 不默认保存明文密码
- 不绕过服务器安全策略

## 当前基础能力

已完成：

- SSH profile 新建、编辑、删除
- password / privateKey / agent 类型建模
- xterm 交互终端
- 多 tab SSH session
- 每个 session 独立 xterm buffer
- `remoteTerminal:testConnection`
- `Test All`
- 最近测试结果 `lastTest`
- `lastConnectedAt`
- 排序和过滤

已修复：

- xterm 样式异常
- 全局隐藏后需要按两次才显示
- 空用户名误报认证失败
- `ssh2` keyboard-interactive 认证接入
- 切换 terminal tab 内容消失

## 功能分层

### 1. Profile 层

Profile 是服务器资产的基本单位。

建议扩展字段：

```ts
interface RemoteTerminalProfile {
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
  lastTest?: RemoteTerminalLastTest
  lastMetrics?: RemoteServerMetricsSnapshot
  credentialRef?: string
  credentialMode?: 'none' | 'session' | 'os' | 'portableVault'
  createdAt: number
  updatedAt: number
}
```

注意：

- `credentialRef` 只能是凭据索引，不能是密码。
- `lastMetrics` 只能保存非敏感状态数据。
- `privateKeyPath` 仍只保存路径，不保存私钥内容。

### 2. 凭据层

支持四种模式，默认必须是 `none`。

#### none

不保存密码。

- 每次连接/测试时输入。
- 当前实现等价于该模式。
- 安全性最高。

#### session

只在当前应用进程内缓存。

- 应用关闭后清空。
- 不写入磁盘。
- 可用于连续多次连接/测试。
- 适合当前阶段优先实现。

#### os

使用系统安全存储。

Electron 可考虑：

- `safeStorage`
- Windows DPAPI 绑定当前 Windows 用户

特点：

- 对本机用户体验好。
- 不适合真正便携，因为换电脑后无法解密。
- 不应导出。

#### portableVault

便携加密保险箱。

设计要求：

- 用户设置主密码。
- 使用 PBKDF2 / Argon2id 派生密钥。
- 使用 AES-256-GCM 加密。
- 每条凭据独立 nonce。
- 保存到 portable data 目录。
- 不保存主密码。

建议文件：

`portable-data/remote-terminal-vault.json`

结构示例：

```json
{
  "version": 1,
  "kdf": {
    "name": "pbkdf2-sha256",
    "iterations": 310000,
    "salt": "base64"
  },
  "items": [
    {
      "id": "cred-profile-id-password",
      "profileId": "profile-id",
      "kind": "password",
      "nonce": "base64",
      "ciphertext": "base64",
      "tag": "base64",
      "updatedAt": 0
    }
  ]
}
```

安全边界：

- 便携模式的安全性取决于主密码强度。
- 必须显示风险提示。
- 不允许自动解锁。
- 解锁后仅在内存保留 vault key。

## 便携模式

### 目标

让 Remote Terminal 的 profile、非敏感元数据、可选 portable vault 能随目录迁移。

### 目录方案

默认当前 Electron `userData`：

- `remote-terminal-profiles.json`
- `floating_clock_settings.json`

便携模式新增：

```text
portable-data/
  remote-terminal-profiles.json
  remote-terminal-vault.json
  remote-terminal-metrics-cache.json
```

### 启用方式

建议两种方式：

- 检测应用根目录下是否存在 `portable.flag`
- 设置页提供 `Use portable data directory`

优先级：

1. 显式 portable data 目录
2. `portable.flag`
3. Electron `userData`

### 注意

- OS safeStorage 凭据不应迁移。
- portableVault 可迁移，但需要主密码。
- 迁移 profile 时不要导出 session runtime 状态。

## 服务器状态检测

### 目标

类似 ServerBox 的服务器卡片状态，但通过 SSH 执行只读命令采集。

第一阶段只支持 Linux。

采集项：

- uptime
- load average
- CPU usage
- memory total/used/free
- swap total/used
- disk filesystem usage
- network rx/tx
- OS / kernel / arch
- hostname

### IPC 设计

```ts
interface RemoteServerMetricsRequest {
  profileId: string
  password?: string
  passphrase?: string
}

interface RemoteServerMetricsSnapshot {
  ok: boolean
  profileId: string
  collectedAt: number
  durationMs: number
  host?: {
    hostname?: string
    os?: string
    kernel?: string
    arch?: string
    uptimeSeconds?: number
    loadavg?: [number, number, number]
  }
  cpu?: {
    usagePercent?: number
    cores?: number
  }
  memory?: {
    totalBytes?: number
    usedBytes?: number
    freeBytes?: number
    availableBytes?: number
    swapTotalBytes?: number
    swapUsedBytes?: number
  }
  disks?: Array<{
    filesystem: string
    mount: string
    totalBytes: number
    usedBytes: number
    availableBytes: number
    usedPercent: number
  }>
  network?: Array<{
    iface: string
    rxBytes: number
    txBytes: number
  }>
  error?: string
}
```

Renderer API：

```ts
remoteTerminal.collectMetrics(req): Promise<RemoteServerMetricsSnapshot>
remoteTerminal.onMetricsChanged(cb): () => void
```

Main IPC：

- `remoteTerminal:collectMetrics`
- `remoteTerminal:onMetricsChanged`

### Linux 命令方案

使用一条只读 shell 脚本输出 JSON，避免多次 SSH 往返。

命令来源：

- `/proc/stat`
- `/proc/meminfo`
- `/proc/loadavg`
- `/proc/uptime`
- `/proc/net/dev`
- `df -B1 -P`
- `uname -srmo`
- `hostname`

原则：

- 不使用 sudo。
- 不写文件。
- 不安装 agent。
- 不依赖 Python。
- 不依赖 jq。

### CPU 采样

CPU 使用率需要两次 `/proc/stat` 采样。

建议：

- 第一次采样
- 等待 800ms
- 第二次采样
- 计算 delta

公式：

```text
usage = 1 - idleDelta / totalDelta
```

### 磁盘采样

命令：

```sh
df -B1 -P
```

过滤：

- `tmpfs`
- `devtmpfs`
- `overlay` 可配置显示/隐藏
- 只展示真实挂载点，默认按 usedPercent 降序

### 错误分类

```ts
type MetricsErrorStage =
  | 'profile'
  | 'auth'
  | 'connect'
  | 'exec'
  | 'parse'
  | 'unsupported-os'
```

必须展示：

- 认证失败
- 命令执行失败
- 非 Linux 系统暂不支持
- 输出解析失败
- 超时

## UI 规划

### Profile 列表增强

每个 profile 行展示：

- 连接状态点
- 最近测试延迟
- 最近 CPU / MEM / DISK 摘要
- 最近更新时间

示例：

```text
server-1
root@114.28.145.113:22
OK 120ms | CPU 3% | MEM 42% | Disk 61%
```

### 右侧 Dashboard

无 active terminal 时显示服务器概览：

- 当前选中 profile
- Test
- Connect
- Collect Metrics
- CPU 卡片
- Memory 卡片
- Disk 列表
- Network 简表

当前实现状态：

- 已实现 profile 选中态。
- 无 active terminal 时右侧显示选中服务器 Dashboard。
- Dashboard 显示 CPU / Memory / Disk 卡片、OS、Kernel、Arch、Load、更新时间。
- Dashboard 提供 `Connect` 和 `Refresh Metrics` 操作。
- Dashboard 复用 `lastMetrics`，不会为了展示自动连接服务器。
- Dashboard 已拆分到 `src/components/remote-terminal/ServerDashboard.tsx`，避免继续扩大主面板组件。
- Dashboard 已补充磁盘列表和网络 RX/TX 摘要，便于后续扩展 ServerBox 类状态页。
- 已修复连接后 Dashboard 信息完全消失的问题：active terminal 上方保留紧凑服务器状态条，显示当前 session 的 CPU / MEM / DISK，并可直接刷新 metrics。
- 已提高 Dashboard、profile 列表和 terminal status bar 的对比度，避免透明窗口叠底层内容后状态看不清。
- 已按透明窗口风格回退近不透明暗色底，只提高 Dashboard、profile 列表、terminal 状态条和 CPU / MEM / DISK 状态文字亮度。

### Tab 内状态栏增强

连接状态栏显示：

- connected
- uptime
- CPU
- MEM
- Disk root
- last refresh

## 分阶段实施

### Step 1：凭据模式建模

- profile 增加 `credentialMode` / `credentialRef`
- 默认 `none`
- UI 增加 `Remember password` 但默认关闭
- 暂只实现 `session`

当前实现状态：

- 已实现 renderer 内存级 session-only secret cache。
- 凭据输入条新增 `Session` 勾选。
- 勾选后，成功 Connect/Test 会把本次 password/passphrase 缓存在当前 renderer 进程内。
- 再次 Connect/Test 会自动填入缓存 secret。
- `Test All` 会使用已缓存 secret 自动测试 password/privateKey profile。
- 未缓存 secret 的 password/privateKey profile 仍会跳过。
- 新增 `Forget` 用于清除当前 profile 的 session secret。
- 不写入 profile JSON，不写入 Electron userData，不传给持久化服务。

验收：

- 勾选 session remember 后，本次应用运行期间无需重复输入密码。
- 应用重启后仍要求输入密码。
- 不写入任何密码文件。

### Step 2：Metrics IPC

- 新增 `collectMetrics`
- 使用当前输入密码或 session 缓存密码连接 SSH。
- 执行只读 Linux 采集脚本。
- 返回 `RemoteServerMetricsSnapshot`。

当前实现状态：

- 已新增 `remoteTerminal.collectMetrics(req)`。
- 已新增主进程 IPC：`remoteTerminal:collectMetrics`。
- 已实现 Linux 只读采集脚本。
- 采集项包括 host、uptime、loadavg、CPU 使用率、CPU cores、memory、swap、disk、network。
- UI profile 行新增 `Mon` 按钮。
- `Mon` 会复用 session-only secret；没有 secret 时会要求输入 password/passphrase。
- 采集成功后写入 profile 的 `lastMetrics` 非敏感元数据。
- profile 列表显示 `CPU / MEM / DISK` 摘要。
- 不创建 terminal tab，不使用 sudo，不写远端文件。
- 修复 Debian `/proc/meminfo` 大内存值经 awk 输出科学计数法导致 shell 整数运算失败的问题；当前先保留 KB 整数计算，最后乘 1024 输出 bytes。
- `df` 输出增加数字过滤，避免异常行破坏 JSON。

验收：

- 对 Debian 主机返回 CPU/MEM/DISK。
- 失败时不创建 terminal tab。
- 不影响已有 SSH session。

### Step 3：Profile 行状态展示

- 保存 `lastMetrics`
- profile 行显示 CPU/MEM/DISK 摘要。
- 支持按 CPU/MEM/DISK 排序。

验收：

- 重启后能看到最近一次 metrics。
- 手动刷新能更新状态。

### Step 4：批量状态检测

- `Collect All`
- 并发限制 3。
- password/privateKey 需要 secret 的 profile：
  - 如果 session cache 有 secret，可自动检测。
  - 否则跳过并提示需要交互凭据。

验收：

- 不会同时打爆多个 SSH 连接。
- 支持取消。
- 列表显示 progress。

当前实现状态：

- 已新增 UI：`Collect All`。
- 批量采集并发限制为 3。
- 有 session-only secret 的 password/privateKey profile 可自动采集。
- 无缓存 secret 的交互式 profile 会跳过并显示 skipped。
- 采集过程显示进度。
- 排序新增 CPU / Memory / Disk，可按当前 metrics 结果查看负载最高的服务器。

### Step 5：OS safeStorage

- Windows 当前用户绑定加密。
- UI 明确标注“不便携”。
- 可清除保存的凭据。

当前实现状态（2026-06-21）：

- 已新增 `electron/remoteCredentialService.ts`。
- 使用 Electron `safeStorage`；Windows 下由 DPAPI 绑定当前 Windows 用户加密。
- 第一次输入 password/private-key passphrase 并连接、测试或采集成功后，可勾选 `Protected` 保存。
- 后续 Connect、Test、Mon、Test All 和 Collect All 可由 main 进程直接取用已保存凭据，不再要求 renderer 重复输入。
- renderer 只能查询 `stored` 状态，不能读取解密后的密码。
- profile 行显示锁形状态按钮，可单独清除受保护凭据。
- 删除 profile 时同步删除其受保护凭据。
- 凭据文件为 `remote-terminal-credentials.json`，仅保存 DPAPI 密文和非敏感元数据。
- `Session` 内存缓存仍保留，用户可以选择仅本次运行保存。
- 该模式不便携，复制到其他 Windows 用户或电脑后无法解密。

验收：

- 重启后可免输入。
- 换机器不可解密。
- 清除后必须重新输入。

### Step 6：portableVault

- 主密码创建 vault。
- unlock / lock。
- profile 可保存密码到 vault。
- 导入/导出仅导出加密 vault。

验收：

- 未解锁时无法使用 vault 密码。
- 错误主密码无法解密。
- 明文密码不出现在 profile JSON。

## 文件改动建议

Shared：

- `shared/ipc-contract.ts`

Main：

- `electron/remoteTerminalService.ts`
- 可选新增 `electron/remoteCredentialService.ts`
- 可选新增 `electron/remoteMetricsService.ts`

Renderer：

- `src/components/RemoteTerminalPanel.tsx`
- `src/components/remote-terminal/ServerDashboard.tsx`
- 后续拆分：
  - `src/components/remote-terminal/ProfileList.tsx`
  - `src/components/remote-terminal/CredentialPrompt.tsx`
  - `src/hooks/useRemoteTerminalSessions.ts`
  - `src/hooks/useRemoteMetrics.ts`

Docs：

- `docs/designs/2026-06-19-remote-terminal-windterm-study.md`
- `docs/designs/2026-06-19-remote-terminal-credentials-monitoring-plan.md`
- `docs/history/project-progress-and-audit-log.md`

## 安全结论

可以做密码保存，但必须分级：

1. 默认不保存。
2. 第一优先实现 session-only 缓存。
3. 本机免输入用 OS safeStorage。
4. 真正便携用主密码加密 vault。
5. 永远不在 profile JSON 保存明文 password/passphrase。

服务器状态检测可以做，但必须限制为只读命令、无 sudo、无 agent、无后台常驻。

## 2026-06-19 当前进度

已完成：

- `Collect All` 批量采集，限制并发为 3。
- `Mon` 单机 metrics 采集。
- 右侧服务器 Dashboard，显示 CPU / Memory / Disk、OS / Kernel / Arch、Load、更新时间。
- Dashboard 已拆分为 `src/components/remote-terminal/ServerDashboard.tsx`。
- 连接后保留紧凑状态栏，显示当前 session 的 CPU / MEM / DISK 和 `Refresh`。
- profile 列表已支持 test / metrics 摘要、排序、过滤和最近测试结果。
- session-only secret cache 已落地，`Session` 仅保存在当前 renderer 内存。
- `Ctrl+Shift+Alt+Q` 隐藏后再次显示问题已修复。

最近调整：

- 已回退 Remote Terminal 的近不透明暗底。
- 只提高状态文字亮度，保留透明风格。
- 解决了“连接后 Dashboard 消失”和“状态文字太暗”的两个视觉问题。

验证：

- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

## 2026-06-21 安全与测试进度

- profile 新增可持久化的非敏感 `hostFingerprint` 字段。
- 密码、passphrase、私钥正文仍不写入 profile JSON。
- 未知主机不再自动接受；必须由用户确认 SHA-256 指纹。
- 已固定主机密钥发生变化时，终端、测试和 metrics 均阻断。
- 新增 Remote Terminal 自动测试，验证指纹匹配和敏感字段不落盘。
- `npm.cmd run verify`、完整 Electron 构建、安装包构建和 smoke test 均通过。

凭据路线当前为：默认 none、可选 session-only、可选 Windows DPAPI protected；portableVault 尚未实现。
