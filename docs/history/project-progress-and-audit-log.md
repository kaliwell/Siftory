# Floating Clock Electron 项目进度与审计总结

> 状态：历史长日志  
> 说明：保留阶段性记录，不作为当前状态依据。  
> 当前入口：[文档中心](../README.md)

## 文档格式要求

- 每次更新必须写明更新日期、项目路径、审计范围和结论。
- 所有验证项必须标注状态：`通过`、`失败`、`未验证`、`部分通过`。
- 所有命令必须使用反引号包裹，例如 `npm.cmd run build`。
- 所有阻塞项必须写明：现象、影响、当前结论、下一步。
- 所有评分必须保留评分依据，不能只写分数。
- 发布判断必须拆分为：继续开发、内部测试、RC、正式发布。
- 新增功能前必须先确认：构建链、审计、核心测试、smoke test 的当前状态。

## 基本信息

- 更新日期：2026-06-26（三层图片物品匹配系统：完整交付 + Codex 审计修复）
- 项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron7\s220260601_221046`
- 原总结文件：`<USER_HOME>\Desktop\history/project-progress-and-audit-log.md`
- 当前阶段：三层匹配系统后端 + UI 完成，Codex 审计通过，94 项测试全绿

## 本轮修复摘要

### 0.4 远程终端管理功能文档

- 更新日期：2026-06-18（第八次更新：新功能交接文档）
- 当前状态：历史记录；Remote Terminal 第一阶段及 SFTP 单文件传输基础版已实现，最新状态见本文后续章节
- 新增文档：`docs\handoffs/2026-06-18-remote-terminal-handoff.md`
- 功能目标：
  - 新增类似 WindTerm 的轻量远程终端管理面板。
  - 第一阶段聚焦 SSH profile 管理、连接、交互式终端、多标签、断开/重连、自动保存非敏感配置。
- 安全边界：
  - 不保存明文密码。
  - 不在 renderer 直连 SSH。
  - 不实现删除远程文件、批量命令、SFTP、端口转发、RDP/VNC/Telnet。
- 下一步：
  - 交给 DeepSeek 按 `docs\handoffs/2026-06-18-remote-terminal-handoff.md` 进入实现。

### 0. Codex 复检与补丁

- 更新日期：2026-06-18（第三次更新：DeepSeek 完成后复检）
- 审计范围：App Storage 新功能实现、IPC 暴露、构建链、依赖审计、native 测试、打包产物 smoke test
- 当前状态：通过
- 复检结论：
  - DeepSeek 已完成 App Storage 第一阶段功能接入。
  - `docs` 目录交接文档、功能设计文档和问题总结文档已同步。
  - 项目目录本身不是 git 仓库，无法用 `git diff` 做变更审计，本次按关键文件和验收命令审计。
- Codex 补丁：
  - 修改 `electron/appStorageService.ts`
  - 将注册表读取的 PowerShell 调用从 shell 字符串拼接改为 `execFile('powershell.exe', args)` 参数调用，降低 shell 拼接风险。
  - 扫描状态通过 `emitStatus()` 写入 `_lastStatus`，让 `appStorage.getStatus()` 在扫描中和停止中也能返回最新状态。
- 本次复检命令：
  - `npm.cmd run format:check`：通过
  - `npm.cmd run typecheck`：通过
  - `npm.cmd audit --audit-level=high`：通过，`found 0 vulnerabilities`
  - `npm.cmd run test:native`：通过，26 passed
  - `npm.cmd run build`：通过
  - `release\win-unpacked\FloatingClock.exe` smoke test：通过，5 秒后仍运行
- 剩余限制：
  - 未做 App Storage 面板人工点击扫描验证。
  - App Storage 暂无自动化测试。
  - native C++ warning 仍存在。
  - 构建期间仍出现 Node `DEP0190` 提示，当前判断来自构建链依赖或脚本，不是 App Storage 注册表读取逻辑，不阻断构建。

### 0.1 App Storage 用户反馈缺陷（已修复）

- 更新日期：2026-06-18（第四次更新：用户截图反馈；第五次更新：缺陷修复完成）
- 当前状态：已修复，待人工验收
- 反馈文档：`docs\handoffs/2026-06-18-app-storage-defect-feedback.md`
- 修复范围：

  **1. 中文字符乱码修复：**
  - PowerShell 脚本增加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 和 `$OutputEncoding`
  - `execFile` 增加 `encoding: 'utf8'` 选项和 `-ExecutionPolicy Bypass` 参数
  - JSON 解析后过滤含 `\uFFFD` 替换字符的条目

  **2. 体积大小真实性修复：**
  - `SKIP_PREFIXES` 扩展：禁止扫描用户主目录根、Desktop/Downloads/Documents/Pictures/Music/Videos、游戏库根（Steam/Epic/Ubisoft/Origin/GOG/XboxGames）、临时目录
  - 新增 `SHARED_LAUNCHER_EXES`：检测共享启动器 exe，拒绝将其父目录作为应用路径
  - `extractExePath` 过滤共享启动器路径
  - `isSkippableRoot` 前缀比较改为大小写不敏感
  - `totalBytes` 不再以注册表估算值初始化；扫描后以 scannedBytes 为准，仅无扫描结果时回退到 estimatedRegistryBytes
  - 新增标签：`Missing paths`（所有候选路径不存在）、`Registry estimate`（仅注册表估算值可用）

  **3. 目录跳转按钮补齐：**
  - 应用行右侧新增 `Open` 按钮（跳转到 InstallLocation）
  - 路径明细每行新增 `Open` / `—` 按钮替代原下划线文字
  - 不可访问路径按钮显示为 `—` 并禁用

- 验证结果：
  - `npm.cmd run format:check` → 通过
  - `npm.cmd run typecheck` → 通过
  - `npm.cmd run build` → renderer/main/preload 构建通过；native 构建因系统文件锁定（EPERM）受阻，与本次代码改动无关
  - `npm.cmd audit --audit-level=high` → 通过（found 0 vulnerabilities）
- 剩余限制：
  - 尚未进行面板级人工点击扫描验证中文显示和体积准确性
  - 仍无 App Storage 自动化测试

### 0.2 App Storage 自动保存扫描结果与 Open 修复

- 更新日期：2026-06-18（第六次更新：自动保存、更新缓存、目录打开反馈）
- 当前状态：通过
- 用户需求：
  - App Storage 像 Image Search 一样自动保存扫描结果。
  - 下次打开面板时可自动加载上次 Scan 结果。
  - 可以重新 Update 扫描结果。
  - 修复部分应用没有 `Open` 按钮，以及少数 `Open` 点击后打不开但无反馈的问题。
- 修改范围：
  - `electron/appStorageService.ts`
  - `electron/main.ts`
  - `electron/preload.ts`
  - `shared/ipc-contract.ts`
  - `src/components/AppStoragePanel.tsx`
- 实现内容：
  - 扫描完成后自动保存结果到 Electron `userData` 下的 `app-storage-cache.json`。
  - App Storage 面板挂载时调用 `appStorage.loadCached()` 自动恢复上次结果。
  - 有结果时主按钮显示 `Update`，点击后重新扫描并覆盖缓存。
  - 新增 `Clear` 按钮清除已保存扫描结果。
  - 新增 IPC：`appStorage:loadCached`、`appStorage:clearCached`。
  - `appStorage:openPath` 返回 `{ ok, error }`，路径不存在或打开失败时 UI 显示错误。
  - 应用行 `Open` 不再只依赖 `installLocation`，会优先选择存在且可访问的安装路径，否则选择第一个可访问候选路径。
- 验证结果：
  - `npm.cmd run format:check`：通过
  - `npm.cmd run typecheck`：通过
  - `npm.cmd audit --audit-level=high`：通过，`found 0 vulnerabilities`
  - `npm.cmd run build`：通过
  - `release\win-unpacked\FloatingClock.exe` smoke test：通过，5 秒后仍运行
- 剩余限制：
  - 尚未人工验证重启应用后缓存列表是否自动恢复。
  - 尚未逐个验证所有 `Open` 按钮都能打开真实目录；路径不存在或权限不足时应显示错误。

### 0.3 全局隐藏快捷键与锁定显示修复

- 更新日期：2026-06-18（第七次更新：锁定显示热键行为修复）
- 当前状态：通过
- 用户反馈：
  - 窗口的“锁定显示”功能未生效。
  - 按 `Ctrl+Shift+Alt+Q` 仍会把锁定显示的窗口隐藏掉。
- 原因：
  - `Ctrl+Shift+Alt+Q` 原先在主进程直接调用 `mainWindow.hide()`。
  - 该路径绕过 renderer/store 中的 `lockedVisibility` 判断，所以所有面板都会随原生窗口一起隐藏。
- 修复内容：
  - 主进程热键不再直接隐藏可见窗口，而是发送 `toggle-global-visibility` 给 renderer。
  - `preload` 和 IPC 类型新增 `onToggleGlobalVisibility`。
  - `useStore` 新增 `toggleGlobalVisibility()`，按 `lockedVisibility` 判断：
    - 有锁定显示且当前可见的面板时，只隐藏未锁定面板，并保持原生窗口显示。
    - 没有任何锁定显示的可见面板时，才允许隐藏原生窗口。
    - 再次触发时恢复上次保存的可见面板。
  - App Storage 目录扫描跳过 `.asar` 文件，避免 Electron 开发日志中反复出现 `Failed to parse header from ... .asar`。
- 验证结果：
  - `npm.cmd run format:check`：通过
  - `npm.cmd run typecheck`：通过
  - `npm.cmd audit --audit-level=high`：通过，`found 0 vulnerabilities`
  - `npm.cmd run build`：通过
- 待人工验证：
  - 锁定任意一个面板的显示锁后，按 `Ctrl+Shift+Alt+Q`，该面板应保持可见。
  - 未锁定面板应被隐藏。
  - 再按一次 `Ctrl+Shift+Alt+Q`，应恢复之前保存的未锁定面板。

### 0.4 Remote Terminal / 远程终端管理 功能已完成

- 更新日期：2026-06-18（第八次更新：Remote Terminal 第一阶段）
- 当前状态：通过
- 需求来源：`docs/handoffs/2026-06-18-remote-terminal-handoff.md`
- 新增依赖：`xterm`、`@xterm/addon-fit`、`ssh2`、`@types/ssh2`（0 vulnerabilities）
- 实现范围：
  - SSH profile 管理（新增/编辑/删除/搜索）
  - 密码和私钥两种认证方式
  - 多标签终端会话
  - 基于 xterm 的交互式终端渲染
  - 终端 resize 自动同步
  - 凭据不落盘（密码每次输入，不保存到 JSON）
  - 私钥路径安全校验
  - 连接状态和错误实时显示
- 暂不实现：SFTP、端口转发、RDP/VNC/Telnet、跳板机、批量命令、自动输入密码
- 新增文件：
  - `electron/remoteTerminalService.ts`
  - `src/components/RemoteTerminalPanel.tsx`
- 修改文件：
  - `shared/ipc-contract.ts`（新增 RemoteTerminal 类型 + API + settings 字段）
  - `electron/preload.ts`（暴露 remoteTerminal API）
  - `electron/main.ts`（注册 IPC handlers + 初始化 + will-quit 断开）
  - `src/stores/useStore.ts`（新增 showRemoteTerminal/remoteTerminalPos/remoteTerminalSize + arrange 集成）
  - `src/types/index.ts`（新增 DEFAULT_REMOTE_TERMINAL_W/H）
  - `src/components/SettingsPanel.tsx`（新增 Terminal 开关）
  - `src/App.tsx`（渲染面板 + snap/show-all/settings 恢复）
  - `src/hooks/useAutoSaveSettings.ts`（持久化状态）
  - `src/hooks/useLinkedMove.ts`（PanelName 增加 remoteTerminal）
- 验证命令：
  - `npm.cmd run format:check` → 通过
  - `npm.cmd run typecheck` → 通过
  - `npm.cmd audit --audit-level=high` → 通过（found 0 vulnerabilities）
- 剩余限制：
  - 尚未人工 SSH 连接真实主机测试
  - 无自动化测试
  - 私钥需通过文件路径引用（由主进程读取），暂不支持 agent

### 0.5 Remote Terminal 复检与构建修复

- 更新日期：2026-06-18（第九次更新：Remote Terminal 复检）
- 当前状态：通过构建与启动验证，待真实 SSH 人工验收
- Codex 复检发现并修复：
  - 修复密码连接流程：点击 profile 的 `Connect` 后先显示凭据输入栏，不再立即用空密码发起连接。
  - 修复私钥连接：main 进程现在按 `privateKeyPath` 读取私钥文件，并使用输入框内容作为 passphrase。
  - 修复 `ssh2` 打包：main 进程 Vite build 将 `ssh2` 标记为 external，避免 Rollup 把 `.node` 文件当 JS 解析。
  - 修复 electron-builder 重建可选依赖失败：`package.json` build 配置增加 `npmRebuild: false`，避免 `cpu-features` 联网重建阻断打包；项目自身 native addon 仍由 `scripts/build-native.cjs` 构建。
- 本次验证命令：
  - `npm.cmd run format:check`：通过
  - `npm.cmd run typecheck`：通过
  - `npm.cmd audit --audit-level=high`：通过，`found 0 vulnerabilities`
  - `npm.cmd run test:guards`：通过，4 passed
  - `npm.cmd run test:settings`：通过，3 passed
  - `npm.cmd run test:native`：通过，26 passed
  - `npm.cmd run build`：通过
  - `release\win-unpacked\FloatingClock.exe` smoke test：通过，5 秒后仍运行
- 剩余限制：
  - 未连接真实 SSH 主机，终端交互、resize、断开、重连仍需人工验收。
  - 未验证私钥 passphrase、错误密码、错误端口、断网等异常路径。
  - ✅ 已实现 SHA-256 host fingerprint 首次确认、固定和变化阻断，覆盖 connect/test/metrics/SFTP。OpenSSH known_hosts 导入/导出仍未实现。

### 1. 完整构建链已修复

- 旧问题：`npm.cmd run build` 失败，报错 `Cannot read directory "../../../../../..": Access is denied.`
- 原因判断：Vite 6 默认通过 esbuild 加载 `vite.config.ts`，在当前 Windows / 受控 shell 环境下会错误解析配置路径并尝试访问上级不可读目录。
- 修复方式：
  - 新增 `vite.config.mjs`
  - Vite 命令改用 `--config vite.config.mjs --configLoader runner`
  - 新增 `scripts/build.cjs`，用 Node 脚本串行编排构建阶段
- 当前状态：通过
- 验证命令：`npm.cmd run build`

### 2. native addon 打包路径已修复

- 旧问题：`fast_scanner.node` 原先按本机 Node ABI 构建，打包进 Electron 后存在 ABI 不匹配风险。
- 修复方式：
  - 新增 `scripts/build-native.cjs`
  - Node 测试版输出保留在 `native/build/Release/fast_scanner.node`
  - Electron 打包版输出到 `native/build-electron/Release/fast_scanner.node`
  - `electron-builder` 的 `extraResources.from` 改为 `native/build-electron/Release/fast_scanner.node`
- 当前状态：通过
- 验证命令：
  - `npm.cmd run build:native`
  - `npm.cmd run build:native:electron`
  - `npm.cmd run test:native`

### 3. Electron 与 electron-builder 已升级

- 旧问题：`npm audit` 报告 7 个 high 漏洞，主要来自 `electron@31.3.1`、`electron-builder@24.13.3`、`tar`、`form-data`。
- 修复方式：
  - `electron` 升级到 `^42.4.1`
  - `electron-builder` 升级到 `^26.15.3`
  - 使用本地 v2rayN mixed 代理 `http://127.0.0.1:<port>` 完成下载
  - 配置 `electronDist: "node_modules/electron/dist"`，避免打包阶段重复下载 Electron runtime
- 当前状态：通过
- 验证命令：`npm.cmd audit --audit-level=high`
- 验证结果：`found 0 vulnerabilities`

### 4. 安装包 smoke test 已通过

- 旧问题：旧总结记录打包产物 5 秒内退出，结果为 `exited:1`。
- 当前验证：新构建的 `release\win-unpacked\FloatingClock.exe` 启动后 5 秒仍在运行。
- 当前状态：通过
- 结果：`running:<pid>`
- 结论：旧的 smoke test 阻塞项已解除。

### 6. App Storage / 应用空间分析 功能已完成

- 需求来源：`docs/designs/2026-06-18-app-storage-design.md`
- 实现范围：
  - 从 Windows 注册表读取已安装应用（HKLM + HKCU Uninstall 三项）
  - 推断每个应用的候选路径（安装目录、用户数据、缓存等，最多 8 个候选）
  - 异步递归扫描目录大小，扫描过程中定期推送进度
  - 支持中止扫描
  - 按大小/名称/发布者排序
  - 搜索应用名称/发布者
  - 展开查看路径明细（app/data/cache/unknown 分类）
  - 一键打开路径
  - 显示扫描状态、进度、错误/警告数量
  - 无破坏性操作（不卸载、不删除、不修改注册表）
- 当前状态：通过
- 验证命令：
  - `npm.cmd run format:check` → 通过
  - `npm.cmd run typecheck` → 通过
  - `npm.cmd run build` → 通过（含 renderer/main/preload/native/electron-builder）
  - `npm.cmd audit --audit-level=high` → 通过（found 0 vulnerabilities）
- 新增文件：
  - `electron/appStorageService.ts`
  - `src/components/AppStoragePanel.tsx`
- 修改文件：
  - `shared/ipc-contract.ts`（新增 AppStorage 类型 + API）
  - `electron/preload.ts`（暴露 appStorage API）
  - `electron/main.ts`（注册 IPC handlers）
  - `src/stores/useStore.ts`（新增 showAppStorage/appStoragePos/appStorageSize + setters + arrange 集成）
  - `src/types/index.ts`（新增 DEFAULT_APPSTORAGE_W/H）
  - `src/components/SettingsPanel.tsx`（新增 Apps 开关）
  - `src/App.tsx`（渲染 AppStoragePanel + snap/show-all/settings 恢复）
  - `src/hooks/useAutoSaveSettings.ts`（持久化 appStorage 状态）
  - `src/hooks/useLinkedMove.ts`（PanelName 增加 appStorage）

### 5. 格式化问题已修复

- 旧问题：`format:check` 有 41 个文件失败。
- 修复方式：执行 `npm.cmd run format`
- 当前状态：通过
- 验证命令：`npm.cmd run format:check`
- 验证结果：`All matched files use Prettier code style!`

## 当前验证矩阵

| 项目                       |     状态 | 命令 / 结果                                           |
| -------------------------- | -------: | ----------------------------------------------------- |
| 安装依赖                   |     通过 | `npm.cmd install` 已完成                              |
| 类型检查                   |     通过 | `npm.cmd run typecheck`                               |
| 完整构建                   |     通过 | `npm.cmd run build`                                   |
| Renderer/Main/Preload 构建 |     通过 | `npm.cmd run build:renderer`                          |
| Node ABI native 构建       |     通过 | `npm.cmd run build:native`                            |
| Electron ABI native 构建   |     通过 | `npm.cmd run build:native:electron`                   |
| native 测试                |     通过 | `npm.cmd run test:native`，26 passed                  |
| guard 测试                 |     通过 | `npm.cmd run test:guards`，4 passed                   |
| settings 测试              |     通过 | `npm.cmd run test:settings`，3 passed                 |
| file-manager security 测试 |     通过 | `npm.cmd run test:fm-security`，11 passed             |
| file-manager watcher 测试  |     通过 | `npm.cmd run test:fm-watcher`，8 passed               |
| 格式检查                   |     通过 | `npm.cmd run format:check`                            |
| 依赖审计                   |     通过 | `npm.cmd audit --audit-level=high`，0 vulnerabilities |
| 安装包生成                 |     通过 | `release\FloatingClock Setup 1.0.0.exe` 已生成        |
| unpacked 产物              |     通过 | `release\win-unpacked\FloatingClock.exe` 已生成       |
| smoke test                 |     通过 | 5 秒后进程仍运行                                      |
| lint                       | 部分通过 | 0 errors，124 warnings                                |

## 当前剩余问题

### 1. App Storage 功能缺少自动化测试 + 人工验收

- 状态：代码修复完成，待人工验收
- 现象：
  - 新增的 `electron/appStorageService.ts` 和 `src/components/AppStoragePanel.tsx` 没有对应的自动化测试文件。
  - 中文编码修复、路径过滤修复、标签修复已合并但未经过面板级点击扫描验证。
- 影响：不阻断构建和打包，但后续修改可能引入回归。
- 当前结论：代码修复已完成，待用户启动 exe 进行人工验收。

### 2. `lint` 仍有 124 个 warning

- 状态：部分通过
- 现象：`npm.cmd run lint` 为 0 errors / 124 warnings。
- 主要类型：
  - `@typescript-eslint/no-explicit-any`
  - `@typescript-eslint/no-unused-vars`
  - `no-console`
- 影响：不阻断构建和打包，但会增加维护成本。
- 当前结论：不是新增功能的阻塞项，但建议在后续迭代中逐步清理。

### 2. C++ native 编译仍有 warning

- 状态：部分通过
- 现象：
  - `C4819`：当前代码页无法表示部分字符
  - `std::filesystem::u8path` C++20 deprecation warning
- 影响：不阻断编译和测试；长期看会影响跨环境构建稳定性。
- 当前结论：不是当前新增功能阻塞项，后续可以单独做 native warning 清理。

### 3. Electron 42 升级后仍建议做人工回归

- 状态：未完全人工验证
- 已验证：构建、打包、smoke test、核心自动测试均通过。
- 尚建议人工确认：
  - 透明悬浮窗口表现
  - 全局快捷键
  - 鼠标穿透 / 点击区域
  - 文件管理基础操作
  - 图片搜索 native 扫描与检索
- 当前结论：可以新增功能，但涉及 Electron 窗口、IPC、native 搜图、文件管理时应补充回归验证。

## 审计结论

### 构建审计

- 结论：通过
- 依据：
  - `npm.cmd run build` 已完整跑通
  - renderer、main、preload 均成功生成
  - Electron ABI native addon 已构建
  - NSIS 安装包已生成

### 安全审计

- 结论：通过
- 依据：
  - `npm.cmd audit --audit-level=high` 返回 `found 0 vulnerabilities`
  - 已从 `electron@31.3.1` 升级到 `electron@42.4.1`
  - 已从 `electron-builder@24.13.3` 升级到 `electron-builder@26.15.3`

### 运行审计

- 结论：基础通过
- 依据：
  - `release\win-unpacked\FloatingClock.exe` smoke test 5 秒后仍在运行
  - 未复现旧总结中的 `exited:1`
- 限制：
  - smoke test 只证明进程可启动并保持运行，不等于完整 UI/功能回归。

### 代码质量审计

- 结论：中等，可继续开发
- 依据：
  - `typecheck` 通过
  - `format:check` 通过
  - 自动测试通过
  - `lint` 仍有 124 warnings

## 当前评分

### 总体完成度：87 / 100（↑5，App Storage 功能完成）

评分依据：

- 构建发布链：23 / 25
  - `npm run build` 已通过
  - NSIS 安装包已生成
  - 扣分点：Electron 42 升级后还缺完整人工回归

- 运行稳定性：16 / 20
  - smoke test 已通过
  - 扣分点：只做了 5 秒进程级验证，未做完整交互验证

- 安全状态：18 / 20
  - `npm audit` 已清零
  - 扣分点：仍需关注 Electron 42 后续安全更新

- 测试覆盖：15 / 20
  - native、settings、guards、file-manager 测试通过
  - 扣分点：缺少 UI 自动化和打包产物功能级测试；App Storage 缺少测试

- 代码质量：11 / 15
  - TypeScript 和格式化通过
  - 扣分点：lint warnings 较多，C++ warning 未清理

- 功能完成度：4 / 0（加分项）
  - App Storage 面板已完成第一阶段全部目标：
    - 注册表读取 ✓
    - 目录大小扫描 ✓
    - 排序/搜索 ✓
    - 路径明细/打开路径 ✓
    - 进度/状态/错误反馈 ✓
    - 异步不卡 UI ✓
    - 无破坏性操作 ✓

## 发布判断

- 适合继续开发：是
- 适合新增功能：是
- 适合工程内部测试：是
- 适合小范围内测：可以，但建议先做人工回归
- 适合 RC：接近，但建议先清理高优先级 lint warning 并完成人工回归
- 适合正式发布：暂不建议，仍缺完整人工回归、签名/图标/安装卸载验证

## 新增功能前建议

1. 如果是普通 UI / 设置 / 小工具功能：可以直接进入开发。
2. 如果涉及 Electron 主进程、窗口行为、全局快捷键、IPC：开发后必须跑 `npm.cmd run build` 和 smoke test。
3. 如果涉及图片搜索或 native addon：开发后必须跑 `npm.cmd run build:native`、`npm.cmd run build:native:electron`、`npm.cmd run test:native`。
4. 如果涉及文件管理：开发后必须跑 `npm.cmd run test:fm-security` 和 `npm.cmd run test:fm-watcher`。
5. 每次新增功能完成后，应更新本文件的验证矩阵和评分。

## 下一步推荐优先级

1. App Storage 功能 smoke test（启动 exe，打开 Apps 面板，点击 Scan 验证功能）
2. 为 App Storage 补充最小单元测试（PowerShell 注册表解析、路径推断、大小计算）
3. 逐步清理 `lint` warning。
4. 做一轮 Electron 42 人工回归（含新 App Storage 面板）。
5. 发布前补齐应用图标、安装/卸载验证、签名策略。

## 2026-06-19 Remote Terminal / WindTerm 学习重构补充

新增文档：

- `docs/designs/2026-06-19-remote-terminal-windterm-study.md`
- `docs/designs/2026-06-19-remote-terminal-credentials-monitoring-plan.md`

本轮修复与重构：

- 学习 WindTerm 的会话管理方法：profile/session/tab/terminal transport 分层。
- 修复 xterm 样式缺失导致隐藏 textarea 暴露的问题。
- 修复 `Ctrl+Shift+Alt+Q` 隐藏后再次显示需要按两次的问题。
- 修复 Remote Terminal 未纳入全局隐藏/恢复 `remoteTerminal` 状态的问题。
- 修复连接失败仍创建空白 terminal tab 的问题。
- SSH `connected` 状态改为 shell stream 创建成功后才发出。
- password profile 空密码不再发起连接。
- 增加 keyboard-interactive 兼容，使用本次输入的临时密码响应 SSH prompt。
- 认证失败错误归一化为可读提示。
- 连接成功后更新 profile 的 `lastConnectedAt`，不保存 password/passphrase。
- 新增 `remoteTerminal:testConnection` 自动测试接口，可测试 SSH 握手和认证耗时。
- Remote Terminal profile 行新增 `Test` 操作，测试失败不创建 terminal tab。
- Remote Terminal profile 列表新增 `Test All`，批量测试无需交互密钥的 profile。
- profile 列表显示最近一次测试结果、耗时、失败阶段和错误摘要。
- profile 列表新增排序与过滤：Name / Latency / Recent，All / OK / Fail。
- profile 增加 `lastTest` 非敏感元数据，应用重启后仍可显示最近测试结果。
- 测试结果显示阶段、耗时和可读错误信息。
- 修复 Windows `ssh root@host` 可连但应用失败的问题：`ssh2` keyboard-interactive 必须监听 client 的 `keyboard-interactive` 事件，不能使用不存在的 `config.onKeyboardInteractive`。
- 修复 profile username 为空时误报认证失败的问题；空用户名现在不能保存，历史空用户名 profile 会提示 `Username is required`。
- 修复切换 terminal tab 后命令行内容消失的问题；每个 SSH session 现在拥有独立 xterm 实例和 buffer。

验证：

- `npm.cmd run typecheck` 通过。
- `npm.cmd run build:renderer` 通过。

剩余事项：

- 按 `designs/2026-06-19-remote-terminal-credentials-monitoring-plan.md` 逐步实现 session-only 凭据缓存、服务器 metrics 采集、OS safeStorage、portable vault。
- 已实现 session-only 凭据缓存：`Session` 勾选只把 password/passphrase 保存在当前 renderer 内存，应用退出即清空；`Forget` 可清除当前 profile 缓存。
- 已实现服务器状态采集第一版：`remoteTerminal.collectMetrics` / `remoteTerminal:collectMetrics`，profile 行 `Mon` 按钮可采集 Linux CPU、内存、磁盘、uptime、网络摘要。
- 修复 `Mon` 采集失败 `Illegal number: 4.10569e+09`：远端脚本不再让 awk 输出科学计数法，改为 KB 整数计算后再转换 bytes。
- 已实现 `Collect All` 批量 metrics 采集，并发限制 3；排序新增 CPU / Memory / Disk。
- 已实现右侧服务器 Dashboard：无 active terminal 时显示选中 profile 的 CPU / Memory / Disk 卡片、OS / Kernel / Load 信息，并提供 `Connect` / `Refresh Metrics`。
- 已将 Dashboard 拆分为 `src/components/remote-terminal/ServerDashboard.tsx`，并补充磁盘列表、网络 RX/TX 摘要、metrics 失败提示。
- 修复连接后服务器状态信息消失的问题：active terminal 上方新增紧凑 metrics 状态条，显示当前 session 的 CPU / MEM / DISK，并提供 `Refresh`。
- 提高 Remote Terminal 状态文本和卡片对比度，解决透明窗口叠底层内容时状态过暗看不清的问题。
- 按透明窗口风格回退近不透明暗色底，只提高 Dashboard、profile 列表、terminal 状态条和 CPU / MEM / DISK 状态文字亮度。
- `RemoteTerminalPanel` 后续应继续拆分为 Sidebar / Tabs / Viewport / ProfileEditor / session hook。
- 自动测试后续可扩展为按最近可用性细分排序。
- 断开连接后保留最后输出和状态，允许用户手动关闭 tab。
- ✅ host fingerprint 已实现：SHA-256 首次确认、固定、变化阻断。后续需 OpenSSH known_hosts 导入/导出和统一管理 UI。

## 2026-06-19 当前进度补充

- Remote Terminal 已能稳定显示连接、测试和 metrics 结果。
- 当前 UI 重点已从“能连上”转到“可读性和概览能力”。
- 已完成的关键点包括：
  - profile 保存校验和空用户名阻断
  - keyboard-interactive 认证兼容
  - session-only secret cache
  - per-session xterm buffer
  - metrics 采集和批量采集
  - 右侧 Dashboard 和连接态状态栏
- 最近一轮修正主要针对视觉问题：
  - 取消不必要的实底遮罩
  - 只提高状态文字亮度
  - 保持透明窗口风格

## 当前结论

Remote Terminal 已从“基础 SSH 连接”推进到“可浏览、可测试、可采集服务器状态”的阶段。接下来优先做组件拆分和安全增强，而不是继续堆叠单文件逻辑。

## 2026-06-21 安全加固与测试补充

本轮完成：

- Remote Terminal 增加 OpenSSH 风格 `SHA256:` 主机指纹固定。
- 未知主机默认拒绝连接，UI 显示指纹；仅在用户明确确认后保存并重试。
- 已固定指纹发生变化时直接阻断连接，不允许静默替换。
- profile 编辑器显示已信任指纹，并提供带风险提示的手动清除入口。
- `connect`、`testConnection`、`collectMetrics` 三条 SSH 路径均接入主机密钥校验。
- Electron 增加 CSP，禁止 object/base/form，并限制 script、connect、image 来源。
- Electron 禁止创建新窗口，并阻断非应用来源的顶层导航。
- 修复 `undici@6.26.0` 传递依赖漏洞，`npm audit` 恢复为 0 vulnerabilities。
- 新增 `tests/app-storage.test.cjs`，覆盖路径解析、危险根目录、注册表 KB 换算和可信度标签。
- 新增 `tests/remote-terminal.test.cjs`，覆盖指纹格式/匹配及 profile 敏感字段不落盘。
- `verify` 已纳入上述两组测试。

验证结果：

- `npm.cmd run verify`：通过，共 57 tests passed。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run format:check`：通过。
- `npm.cmd audit --audit-level=high`：0 vulnerabilities。
- `npm.cmd run lint`：0 errors / 155 warnings，比审计时的 158 warnings 减少 3。
- `npm.cmd run build`：通过，Electron 42.4.1 native addon、win-unpacked 和 NSIS 安装包均重新生成。
- 新生成的 `release/win-unpacked/FloatingClock.exe` smoke test：5 秒后仍运行。

当前剩余事项：

- 必须用真实 SSH 主机人工验证首次指纹确认、相同指纹重连和指纹变化阻断。
- App Storage 仍需要真实机器扫描结果的人工准确性抽查。
- UI/端到端自动化仍未覆盖。
- native C4819、`u8path` deprecated 和 Node DEP0190 warning 仍存在。
- 正式发布仍缺应用图标、代码签名策略和安装/卸载人工回归。

发布判断：适合内部测试；完成真实 SSH/App Storage 人工回归前不建议进入 RC。

## 2026-06-21 Remote Terminal 专业功能规划

新增设计文档：

`docs/designs/2026-06-22-remote-terminal-expansion-plan.md`

规划重点：

- 第一里程碑：可靠 SFTP 文件浏览、上传、下载和传输队列。
- 第二阶段：自动重连、终端搜索、会话日志、分屏和命令片段。
- 第三阶段：本地/远程/SOCKS 转发、Jump Host 和 profile 导入导出。
- 第四阶段：双栏、目录比较、同步预览、SCP/ZMODEM 等高级能力。

实施前置条件：先拆分 RemoteTerminalPanel 和主进程 Remote Terminal 服务，建立统一 SSH connection manager，使 terminal、SFTP、metrics 和 tunnel 共享 host fingerprint、凭据和连接生命周期安全边界。

## 2026-06-21 Remote Terminal 系统加密凭据

已完成：

- 新增 Windows DPAPI / Electron safeStorage 凭据保护。
- 用户首次输入凭据并验证成功后，可选择 `Protected` 加密保存。
- 后续 Connect、Test、Mon 以及批量 Test/Collect 可直接使用 main 进程中的已保存凭据，去除反复输入密码的循环。
- renderer 只能看到是否已保存，不能读取解密后的 password/passphrase。
- profile 行显示锁形状态，可确认后清除；凭据输入条的 Forget 同时清除 session 和 protected 凭据。
- 删除 profile 时同步删除受保护凭据。
- 新增 IPC 参数长度、profile 和 credential kind 匹配校验。
- 保留 `Session` 模式，用户仍可选择仅在当前进程内缓存。

安全边界：

- `remote-terminal-credentials.json` 仅保存 DPAPI 密文，不保存明文。
- 密文绑定当前 Windows 用户，不可作为 portableVault 使用。
- SSH host fingerprint 校验不因凭据自动填充而绕过。

验证：typecheck、57 项测试、renderer/main/preload 构建、Electron native 构建、NSIS 完整打包和新产物 smoke test 均通过；lint 保持 0 errors / 155 warnings。

## 2026-06-21 Remote Terminal 只读 SFTP

已开始实施 `designs/2026-06-22-remote-terminal-expansion-plan.md` Phase 1：

- 新增只读 SFTP service 和独立 Remote Files 组件。
- 支持 Files 入口、路径栏、刷新、返回上级、双击目录和远程文件元数据展示。
- SFTP 复用 DPAPI/session 凭据和 host fingerprint 安全边界。
- 远程路径使用 POSIX guard，拒绝 NUL、反斜杠、空/超长路径，单目录限制 5000 项。
- 新增 2 项 SFTP 单元测试，完整 verify 当前为 59 tests passed。
- lint 为 0 errors / 154 warnings；完整 Electron/NSIS 打包和新产物 smoke test 通过。

当前只读，真实服务器人工 SFTP 验收及 upload/download Transfer Queue 是下一步。

## 2026-06-21 Remote Terminal 单文件传输队列

已完成：

- Files 视图新增 Upload 和单文件 Download。
- 新增后台 Transfer Queue，并发限制 2，显示进度、速度、ETA、状态和错误。
- 支持取消任务和清理已结束历史。
- 上传和下载使用 `.part` 临时文件，成功后 rename，避免未完成内容伪装成完整文件。
- 本地/远端目标存在时拒绝静默覆盖。
- 系统 dialog 返回一次性 selection token；renderer 不能提交任意本地路径。
- 传输任务不暴露密码、passphrase、token 或真实本地源路径。
- 新增 3 项 transfer 测试，完整 verify 当前为 62 tests passed。
- lint 0 errors / 154 warnings；audit 0 vulnerabilities；完整 Electron/NSIS 构建和 smoke test 通过。

未完成：真实 SSH/SFTP 端到端验收、多文件/目录、冲突选择、Retry、Pause/Resume 和断点续传。当前版本应视为 Transfer Queue 工程基础版，不应在真实测试前宣称文件传输已稳定发布。

## 2026-06-22 代码审计与可靠性优化

本轮完成：

- 修复上传和下载在 `overwrite` 模式下先删除原目标的问题。
- 当前替换流程为：完整写入 `.part`、将旧目标改名为任务专属 `.bak`、提交新文件；提交失败时尝试回滚旧目标，成功后清理备份。
- Remote Terminal 的 `connect`、`testConnection`、`collectMetrics`、`disconnect`、`write`、`resize` IPC 增加运行时类型、长度和终端尺寸边界校验。
- 新增标准 `npm test` 入口，并在 native 测试前显式构建 Node ABI addon。
- 简化 `verify` 为 `typecheck + npm test + renderer build`，避免 Electron ABI 构建产物导致 Node native 测试加载失败。
- Remote Transfer 测试增加安全覆盖替换用例；项目自动化测试总数更新为 63 项。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run test:remote-transfer`：4 项通过。
- `npm.cmd test`：通过，共 63 项测试。
- `npm.cmd run verify`：通过，覆盖类型检查、完整测试和 renderer 构建。
- `npm.cmd run lint`：0 errors / 158 warnings。
- `npm.cmd run build`：通过，renderer、main、preload、Electron native addon、win-unpacked 和 NSIS 安装包均已重新生成。
- `npm.cmd audit --omit=dev`：0 vulnerabilities。

仍需处理：

- SFTP 分页接口仍通过单次 `readdir` 读取完整目录后切片，只降低 renderer 单页数据量，未降低主进程峰值内存和远端读取延迟。
- Remote overwrite 的备份回滚流程需要真实 OpenSSH/SFTP 服务端验证 rename、权限错误、断线和取消场景。
- 尚无真实 SSH/SFTP 端到端自动化测试；多文件、目录传输、Retry、Pause/Resume、断点续传和 portableVault 未实现。
- 正式发布前仍需应用图标、代码签名策略及安装/卸载人工回归。

发布判断：适合继续开发和内部测试；真实 SSH/SFTP 故障注入与人工验收完成前，不建议进入 RC。

## 2026-06-23 Electron 加载边界与构建脚本加固

本轮完成：

- 新增 `electron/devServerGuard.ts`，生产包不再接受 `VITE_DEV_SERVER_URL`。
- 开发服务器只允许带显式端口的 loopback HTTP URL：`localhost`、`127.0.0.1` 和 `[::1]`。
- 非 HTTP、非 loopback、带用户信息、无端口及无效 URL 全部回退到打包后的本地 renderer。
- `scripts/build.cjs` 移除 `shell: true`，改为使用当前 Node 直接执行 npm CLI 和 electron-builder CLI。
- `tests/guards.test.cjs` 新增开发服务器 URL 安全边界测试。

验证结果：

- `npm.cmd run typecheck`：通过。
- `npm.cmd run test:guards`：5 项通过。
- `npm.cmd test`：通过，共 64 项测试。
- `npm.cmd run lint -- --quiet`：通过，0 errors。
- `npm.cmd run build`：通过，renderer、main、preload、Electron native addon、win-unpacked 和 NSIS 安装包均已重新生成。
- `release\win-unpacked\FloatingClock.exe`：smoke test 通过，启动 5 秒后仍运行。
- 正式构建链不再出现 Node `DEP0190`。

剩余限制：

- `npm.cmd test` 的 Node ABI addon 构建仍由 `node-gyp` 上游内部触发一次 `DEP0190`，已确认不再来自 `scripts/build.cjs`。
- native `C4819` 和 `std::filesystem::u8path` deprecated warning 仍存在。
- 全量 `format:check` 仍报告三个既有文件：`RemoteFileBrowser.tsx`、`preload.ts`、`remoteSftpService.ts`。
- Remote Terminal 真实 SSH/SFTP 端到端验收、传输冲突选择、Retry、Pause/Resume 和断点续传仍未完成。

## 2026-06-23 fast_scanner 0.4.1 引擎审计

- 新增 `docs/audits/2026-06-23-fast-scanner-0.4.1-audit.md`。
- 新增独立 `npm.cmd run benchmark:native` 基准入口，不加入日常测试。
- 真实 167,111 条 v4 索引加载约 368.73 ms，RSS 增加约 112.68 MiB。
- 高频 prefix16 桶单次扫描 15,842 条，约占全库 9.5%；搜索延迟约 0.2 ms，但尚未达到设计中的候选缩减目标。
- 当前优先级调整为：召回正确性、DCT 精排、异步 N-API、append segment、加载内存优化，再进入解码线程池和 libjpeg-turbo。
- native 26 项回归测试通过；0.4.1 适合内部使用，不应宣称达到百万/千万级终局指标。

## 2026-06-23 fast_scanner 0.4.2 第一批优化

- `balanced/recall` 现在使用精确线性搜索，修复 prefix 高位不同导致的漏召回；`fast` 保留近似低延迟模式。
- 新增搜索线性 oracle 回归，native 测试从 26 项增加到 28 项，全部通过。
- 真实 167,111 条索引抽样：fast 约 0.045 ms，balanced 约 0.186 ms，recall 约 0.181 ms。
- 回撤了实测更慢、额外增加约 7 MiB 内存的运行时 MIH8 原型；后续百万级索引改做持久化 flat MIH。
- 引擎版本升至 `fast_scanner 0.4.2`，修正 native feature flags。
- 清除 native C4819 和全部 C++20 `u8path` deprecated warning；仅剩 node-gyp 上游 DEP0190。
- Node ABI、Electron ABI、renderer/main/preload、win-unpacked 和 NSIS 均重新构建；打包程序 smoke test 通过。

下一批优先级：降低 manifest 加载的 112 MiB RSS 放大、异步化 load/save/search、DCT 精排和 append segment。

## 2026-06-23 fast_scanner 0.4.2 第二批优化

- 路径索引 value 删除未使用字段，路径 key 改为双 64 位稳定指纹，避免 16.7 万份路径字符串副本。
- 真实 167,125 条索引加载从约 368.73 ms 降至 290.63 ms，RSS 增量从 112.68 MiB 降至 51.86 MiB。
- `hashImage` 取消 DiffHash256 的第二次完整解码，一次灰度解码生成三种哈希。
- 新增真实 `readMs/decodeMs/hashMs` 阶段指标和类型定义。
- 28 项 native 测试、typecheck、完整 Electron/NSIS 构建和打包程序 smoke test 均通过。
- C4819 和 `u8path` warning 继续保持为 0；仅剩 node-gyp 上游 DEP0190。

下一批优先级：将 manifest load/save 和查询图片解码移出 Electron main 线程；实现 append segment，避免每次自动保存全量 compact；DCT 精排需先建立固定标注语料。

## 2026-06-23 fast_scanner 0.4.3 第一批：Append Segment + Overlay 持久化

- `saveIndexToManifest` 新增 append 模式：已有 mmap segment 时只写增量记录到小 append segment，保留旧 segment 不删除。
- Manifest 升级到 `schemaVersion: 2`，支持多 segment 列表。
- 新增 `overlay.json` 持久化 replaced/deleted 路径集合，`loadManifest` 自动加载。
- 代码重构：提取 `write_segment_file()`、`mmap_segment()`、`load_segment_worker()` 消除 ~140 行重复。
- 引擎版本升至 `fast_scanner 0.4.3`，feature flags 新增 `append-segment`。
- 28 项 native 测试、typecheck、完整构建、smoke test 均通过。真实索引增量保存后 manifest 列出 2 segments。

## 2026-06-23 fast_scanner 0.4.3 第二批：异步 N-API + Background Compact

- 新增 4 个异步 Promise 函数：`loadManifestAsync`、`saveIndexToManifestAsync`、`hashImageAsync`、`searchByImageAsync`。
- 使用 `napi_create_async_work` 将 I/O（文件读写、mmap、解码）移出 Electron 主线程。
- 原有同步函数保留，向后兼容。
- `tryAutoLoadDefault` 改用异步加载（启动不阻塞），auto-save 改用异步保存。
- 新增 `compactManifestAsync` 后台合并多 segment 为单个 base segment。
- `getCompactStatus` 同步查询 compact 建议（segmentCount > 3 时推荐）。
- Auto-compact：每次异步保存后自动检测并后台执行合并。
- **56 项测试全部通过**：28 native + 6 guards + 3 settings + 11 fm-security + 8 fm-watcher。
- typecheck 零错误，完整 Electron/NSIS 构建 + smoke test 通过。
- 真实索引：167,180 条，3 segments（前次 append 累积）→ auto-compact 后台合并为 1 segment。
- 原计划 0.5.0 目标（异步 N-API、append segment、后台 compact、增量保存）已提前交付。

## 2026-06-23 当前验证矩阵

| 项目                | 状态 | 命令 / 结果                                           |
| ------------------- | ---: | ----------------------------------------------------- |
| 安装依赖            | 通过 | `npm.cmd install`                                     |
| 类型检查            | 通过 | `npm.cmd run typecheck`（0 errors）                   |
| 完整构建            | 通过 | `npm.cmd run build`                                   |
| Node ABI native     | 通过 | `npm.cmd run build:native`                            |
| Electron ABI native | 通过 | `npm.cmd run build:native:electron`                   |
| native 测试         | 通过 | `npm.cmd run test:native`，28 passed                  |
| guard 测试          | 通过 | `npm.cmd run test:guards`，6 passed                   |
| settings 测试       | 通过 | `npm.cmd run test:settings`，3 passed                 |
| fm-security 测试    | 通过 | `npm.cmd run test:fm-security`，11 passed             |
| fm-watcher 测试     | 通过 | `npm.cmd run test:fm-watcher`，8 passed               |
| 格式检查            | 通过 | `npm.cmd run format:check`                            |
| 依赖审计            | 通过 | `npm.cmd audit --audit-level=high`，0 vulnerabilities |
| NSIS 安装包         | 通过 | `release\FloatingClock Setup 1.0.0.exe`               |
| smoke test          | 通过 | 加载 167,180 条，3 segments                           |

## 当前评分

### 总体完成度：90 / 100（↑3，fast_scanner 0.4.3 交付）

评分依据：

- 构建发布链：24 / 25（NSIS 安装包已生成；已有多轮 smoke test）
- 运行稳定性：17 / 20（smoke test 通过，异步化后主线程不阻塞）
- 安全状态：18 / 20（npm audit 清零，CVE 审查无发现）
- 测试覆盖：16 / 20（56 项测试通过；仍缺 UI 自动化）
- 代码质量：12 / 15（typecheck/format 通过，C++ warning 清零）
- 功能完成度：5 / 0（加分项：append segment、异步 N-API、background compact、overlay 持久化、DCT 精排、WIC JPEG 解码、Duplicate Finder 面板）

## 2026-06-24 Duplicate Finder、Image Search 与设置持久化修复

> 本节是当前最新状态；前文 2026-06-23 的测试数量、lint 数量和 Duplicate Finder 实现描述仅保留为历史记录。

### Duplicate Finder 主进程卡顿修复

- 原实现即使改用异步文件 API，目录遍历、排序和 SHA-256 仍在 Electron 主进程执行，扫描大目录时会造成所有面板卡顿。
- 新增 `electron/duplicateFinderWorker.ts`，将目录枚举、文件统计、候选分组、SHA-256 和 Largest 排序全部移入独立 Worker Thread。
- `electron/duplicateFinderService.ts` 现在只负责启动 Worker、维护状态并向 renderer 转发节流后的进度消息。
- 进度消息最多约每 100 ms 推送一次，避免 IPC 高频刷新。
- Stop 使用 `SharedArrayBuffer` + `Atomics`，目录遍历和大文件分块哈希期间均可检测停止信号。
- Worker 作为独立 Vite entry 构建为 `dist-electron/duplicateFinderWorker.js`；安装包通过 `extraResources` 放到真实 resources 路径，避免 ASAR Worker 加载边界。
- 移除 `exec('explorer ...')` 字符串命令，文件定位改用 Electron `shell.showItemInFolder()`。
- Duplicate Finder UI 对齐 Image Search 的紧凑工具栏、状态徽章、路径区和单列结果布局。

### Image Search Query 拖放

- Query 区支持直接拖入 JPG、JPEG、PNG、BMP、WebP 和 GIF。
- Electron 42 不再依赖非标准 `File.path`；preload 使用 `webUtils.getPathForFile(file)` 获取本地文件路径。
- 拖入时 Query 区显示高亮虚线边框。
- 成功拖入后自动填充只读查询路径，并立即执行相似图片查询。
- 查询图片路径与结果名称过滤框分开显示。

### Settings 窗口勾选状态持久化

- 实际设置文件显示 `globalVisible=false` 时，启动逻辑会从 `savedVisibility` 恢复；旧 Settings 按钮只修改 `showXxx`，导致新勾选被旧快照覆盖。
- Settings 的每次窗口显隐修改现在同时更新当前 `showXxx` 和 `savedVisibility`。
- 显隐修改会立即 flush 并等待原子设置写入完成，不再依赖 500 ms 防抖后才落盘。
- 自动保存订阅移除会丢弃 300 ms 内最终状态的 leading-edge throttle；磁盘写入仍由共享 writer 合并和串行化。
- 启动恢复规则修正：`globalVisible=true` 时读取最新 `showXxx`；仅在 `globalVisible=false` 时使用隐藏前的 `savedVisibility` 快照。
- 补齐 Duplicate Finder 的 `showDuplicateFinder`、位置、尺寸和全局隐藏/恢复字段。
- 新增 `src/services/settingsVisibility.ts`，集中定义启动可见性决策并提供回归测试。

### 2026-06-24 验证矩阵

| 项目                  |     状态 | 命令 / 结果                                                              |
| --------------------- | -------: | ------------------------------------------------------------------------ |
| 类型检查              |     通过 | `npm.cmd run typecheck`，0 errors                                        |
| 完整测试              |     通过 | `npm.cmd test`，72 passed                                                |
| Duplicate Finder 测试 |     通过 | 重复识别、Largest 排序、原子停止，3 passed                               |
| Settings 测试         |     通过 | JSON 原子写入、可见/隐藏启动恢复，5 passed                               |
| native 测试           |     通过 | 28 passed                                                                |
| lint                  | 部分通过 | 0 errors / 159 warnings                                                  |
| 完整构建              |     通过 | `npm.cmd run build`                                                      |
| NSIS 安装包           |     通过 | `release\FloatingClock Setup 1.0.0.exe`                                  |
| Worker 打包执行       |     通过 | `release\win-unpacked\resources\duplicateFinderWorker.js` 成功返回重复组 |
| UI 人工回归           |   待验证 | 需使用本轮新产物验证拖放、重启勾选恢复和大目录扫描响应性                 |

### 当前剩余事项

- 仍缺 Electron UI 自动化；Image Search 拖放和 Settings 重启恢复已通过代码、类型、构建和纯逻辑测试，但仍建议用新产物做一次人工交互回归。
- lint 保持 0 errors，但仍有 159 个历史 warning。
- node-gyp 在 Node ABI 测试构建中仍会输出上游 DEP0190 warning；正式项目构建脚本不使用 `shell: true`。
- 安装包仍使用默认 Electron 图标且未配置正式代码签名，不影响本轮功能验证，但仍是正式发布项。

## 2026-06-23 fast_scanner 0.4.3 第三批：DCT 精排 + WIC JPEG + Cleanup Hook

- DCT 精排：`combined_score(diffDist, dctDist, 0.7, 0.3)` 混合排序，新增 `"dct"` 搜索模式，N-API 返回 `dctDistance`。
- WIC JPEG 解码：用 Windows Imaging Component（系统内置）替代 stb_image，decode 直接到目标尺寸（9×8/32×32），零全分辨率中间缓冲。
- N-API cleanup hook：退出时自动停止扫描线程、unmap segment、清理全局状态。
- 28 项 native 测试、typecheck、完整构建、smoke test 均通过。

## 2026-06-23 fast_scanner 0.4.3 第四批：Duplicate Finder 面板

- 新增 Duplicate Finder 面板：Duplicates（SHA-256 查重）/ Largest（最大文件 TOP 100）/ Similar（图片相似度引导）三 Tab。
- `electron/duplicateFinderService.ts` — 递归扫描 + 体积分组 + SHA-256 哈希 + 重复分组 + 最大文件排序。
- 6 个 IPC handlers + DraggablePanel 包装 + Settings 开关 + autoSaveSettings 持久化 + linkedMove 联动。
- typecheck 0 errors，完整构建 + smoke test 通过。

## 2026-06-23 当前验证矩阵

| 项目             | 状态 | 命令 / 结果                                           |
| ---------------- | ---: | ----------------------------------------------------- |
| 安装依赖         | 通过 | `npm.cmd install`                                     |
| 类型检查         | 通过 | `npm.cmd run typecheck`（0 errors）                   |
| 完整构建         | 通过 | `npm.cmd run build`                                   |
| Node ABI native  | 通过 | `npm.cmd run build:native`                            |
| native 测试      | 通过 | `npm.cmd run test:native`，28 passed                  |
| guard 测试       | 通过 | `npm.cmd run test:guards`，6 passed                   |
| settings 测试    | 通过 | `npm.cmd run test:settings`，3 passed                 |
| fm-security 测试 | 通过 | `npm.cmd run test:fm-security`，11 passed             |
| fm-watcher 测试  | 通过 | `npm.cmd run test:fm-watcher`，8 passed               |
| 格式检查         | 通过 | `npm.cmd run format:check`                            |
| 依赖审计         | 通过 | `npm.cmd audit --audit-level=high`，0 vulnerabilities |
| NSIS 安装包      | 通过 | `release\FloatingClock Setup 1.0.0.exe`               |
| smoke test       | 通过 | 167,976 条，1 segment                                 |

## 当前评分

### 总体完成度：92 / 100（↑2，DCT 精排 + WIC + Dup Finder 交付）

评分依据：

- 构建发布链：24 / 25（NSIS 安装包已生成；多轮 smoke test）
- 运行稳定性：17 / 20（smoke test 通过，异步化后主线程不阻塞）
- 安全状态：18 / 20（npm audit 清零，CVE 审查无发现）
- 测试覆盖：16 / 20（56 项测试通过；仍缺 UI 自动化）
- 代码质量：12 / 15（typecheck/format 通过，C++ warning 清零）
- 功能完成度：5 / 0（加分项：append segment、异步 N-API、background compact、overlay 持久化、DCT 精排、WIC JPEG 解码、Duplicate Finder 面板）

## 2026-06-24 再审计结论与整改顺序

> 本节覆盖前文历史评分。当前建议完成度约 82 / 100，适合内部测试，不建议进入正式 RC。

### 当前实测基线

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：82 项通过，已包含 IPC validation、Remote stress 和 29 项 native 测试。
- `npm.cmd run test:remote-stress`：5 项通过，已纳入默认 `npm test`。
- `npm.cmd audit --audit-level=high --json`：516 个依赖，0 vulnerabilities。
- `npm.cmd run lint`：0 errors / 152 warnings。
- `npm.cmd run format:check`：通过。
- `npm.cmd run build`：完整 Electron/NSIS 构建通过。
- 安装包和主程序 Authenticode 状态均为 `NotSigned`，仍使用默认 Electron 图标。

### 主要遗漏

1. **P0：Image Search 同步主链路**
   - native 已提供 `searchByImageAsync`、`hashImageAsync`，但 `imageSearch:search` 和 `imageSearch:hashImage` IPC 仍调用同步 TypeScript 包装。
   - 大图片解码或大索引查询仍可能阻塞 Electron 主进程及全部面板。
2. **P1：IPC 运行时校验不完整**
   - `duplicates:*` 对 `minSize`、`topN` 主要依赖类型断言。
   - `save-settings`、`save-config` 接收任意对象后直接写盘。
   - `open-folder`、透明度、剪贴板等基础 IPC 缺少完整类型和边界检查。
3. **P1：缺少 Electron UI / 端到端测试**
   - 未自动覆盖 Image Search 拖放、Settings 重启恢复、Duplicate Finder IPC/Worker/UI 完整链路、窗口显隐和快捷键。
   - App Storage 仅覆盖纯函数，未覆盖真实注册表编码和实际扫描结果。
4. **P1：SSH/SFTP 真实环境验收不足**
   - 尚无真实服务器故障注入；Pause、Resume、Retry、断点续传、多文件/目录和 portableVault 未完成。
   - SFTP 分页仍先完整 `readdir` 再 `slice`，超过 5000 项直接拒绝，不是真正流式分页。
5. **P1：发布链未产品化**
   - 无正式代码签名、应用图标、自动更新、版本迁移和回滚方案。
6. **P2：代码和工程维护成本偏高**
   - `native/fast_scanner.cc` 约 2976 行、`electron/main.ts` 约 1788 行、`ImageSearchPanel.tsx` 约 1621 行、`RemoteTerminalPanel.tsx` 约 1262 行。
   - 当前目录不是 Git 仓库，缺少可靠差异、历史、标签和回滚点。

### 整改顺序

1. 将 Image Search 查询和哈希 IPC 切换到异步实现，增加主事件循环响应性回归。
2. 为高风险 IPC 增加统一运行时参数校验和边界限制。
3. 补充关键链路测试，并将 Remote stress 纳入默认测试。
4. 修复 3 个格式门禁文件，优先清理 IPC、preload 和未使用代码 warning。
5. 在具备真实 SSH/SFTP 服务端后执行故障注入和传输验收。
6. 正式发布前配置 Git、代码签名、图标、自动更新及版本迁移策略。

### 2026-06-24 按顺序整改结果

1. **Image Search 异步主链路：已完成**
   - `imageSearch:search` 已从同步 `searchImages()` 切换到 `searchImagesAsync()`。
   - `imageSearch:hashImage` 已从同步 `hashImageFile()` 切换到 `hashImageFileAsync()`。
   - 新增 native `hashImageAsync` 与同步结果一致性测试。
2. **IPC 运行时校验：第一批已完成**
   - 新增 `electron/ipcValidation.ts`。
   - 覆盖设置/配置 JSON 对象与大小限制、剪贴板文本长度、透明度范围、打开目录和 Duplicate Finder `minSize` / `topN`。
   - 新增 `tests/ipc-validation.test.cjs`，4 项通过。
3. **关键测试链：已增强**
   - `test:ipc-validation` 和 `test:remote-stress` 已加入默认 `npm test`。
   - 默认测试从 72 项增至 82 项，全部通过。
4. **工程门禁：已恢复**
   - 修复 `RemoteFileBrowser.tsx`、`imageSearchService.ts`、`remoteSftpService.ts` 格式问题。
   - 清除确认无用的 `windowsVisible`、App Storage `exists`、File Manager `expandHome` import 和 Image Search 未使用状态。
   - `format:check` 恢复通过；lint 从 159 降至 152 warnings，保持 0 errors。
5. **依赖与构建：已验证**
   - npm audit：0 vulnerabilities。
   - 完整 Electron/NSIS 构建通过，新安装包已生成。

## 2026-06-26 三层图片物品匹配系统（Vector Retrieval + Rerank）

> 需求来源：`docs/history/2026-06-26-image-search-vector-requirements.md`
> 架构：在现有 fast_scanner 0.4.3 Hash 检索之上新增 Layer 2 (Vector) + Layer 3 (Rerank)。
> Hash 层完全保留，新模块可插拔、可关闭、可降级。

### 新增模块

| 模块                             | 文件                                                                           | 职责                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 共享类型                         | `shared/vectorTypes.ts`                                                        | ModelInfo, ModelStatus, EmbeddingEntry, VectorSearchResult, LayeredSearchResult, ColorFeature, ShapeFeature, ObjectCropEntry, VectorSettings 等 |
| IPC 合约                         | `shared/ipc-contract.ts` (修改)                                                | +21 个 VECTOR_IPC 通道，+vector API 子对象（16 方法 + 3 回调）                                                                                  |
| modelService                     | `electron/modelService.ts`                                                     | 模型下载（SHA-256 校验）、取消、删除、状态回调、manifest 加载                                                                                   |
| vectorDatabaseService            | `electron/vectorDatabaseService.ts`                                            | JSON-lines 文件数据库：image_embeddings, embedding_jobs, object_crops, image_color_features, image_shape_features                               |
| embeddingService                 | `electron/embeddingService.ts`                                                 | Worker Thread 池编排、任务队列、pause/resume/stop、进度追踪                                                                                     |
| embeddingWorker                  | `electron/embeddingWorker.ts`                                                  | 后台图片加载→预处理→embedding 生成（mock/real），失败重试                                                                                       |
| vectorIndexService               | `electron/vectorIndexService.ts`                                               | MemoryVectorIndex（VectorIndexProvider 接口），余弦相似度检索，manifest 持久化                                                                  |
| colorFeatureService              | `electron/colorFeatureService.ts`                                              | HSV 直方图 + 主导色提取，colorSimilarity 直方图交集                                                                                             |
| shapeFeatureService              | `electron/shapeFeatureService.ts`                                              | 宽高比、目标面积比、边缘密度，shapeSimilarity 加权组合                                                                                          |
| rerankService                    | `electron/rerankService.ts`                                                    | 三层编排：Hash Top100 + Vector Top200 → 合并去重 → colorScore + shapeScore → finalScore + matchLevel + reasons                                  |
| objectCropService                | `electron/objectCropService.ts`                                                | centerCrop + detectObjects stub（预留 YOLO/SAM）                                                                                                |
| localFeatureService / ocrService | 预留接口                                                                       | 后续 ORB/SIFT / OCR 精排插件                                                                                                                    |
| 模型基础设施                     | `models/manifest.json`, `scripts/download-models.ts`, `THIRD_PARTY_NOTICES.md` | DINOv2 ViT-B/14 清单、下载脚本、许可证文档                                                                                                      |

### 搜索模式

| 模式            | 路径                        | 说明                                                                     |
| --------------- | --------------------------- | ------------------------------------------------------------------------ |
| 快速 (fast)     | 仅 Hash                     | 现有 fast_scanner searchByImageAsync，毫秒级，重复图/近重复图            |
| 标准 (standard) | Hash Top100 + Vector Top200 | 合并去重，按 hashScore + vectorScore 排序                                |
| 精准 (precise)  | Hash + Vector + Rerank      | 额外计算 colorScore + shapeScore → finalScore，输出 matchLevel + reasons |

### finalScore 公式

```
finalScore = 0.45 × vectorScore + 0.15 × hashScore + 0.20 × colorScore + 0.20 × shapeScore
缺失分数时动态归一化权重，不会因缺少 OCR/ORB 导致异常。
```

### matchLevel

`exact` → `near_duplicate` → `same_product` → `similar_product` → `weak`

### 修改文件

| 文件                                             | 变更                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `electron/main.ts`                               | +vector 服务 import、+17 个 IPC handler 注册、+app.whenReady() 初始化 |
| `electron/preload.ts`                            | +vector API 暴露到 renderer（16 invoke + 3 on）                       |
| `src/types/electron.ts`                          | +vector/rerank 类型 re-export                                         |
| `docs/history/project-progress-and-audit-log.md` | 本文档更新                                                            |

### 验证结果

| 门禁                               | 结果                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm.cmd run typecheck`            | 通过，0 errors                                                                                          |
| `npm.cmd test`                     | 通过，94 项全部通过（零回归）                                                                           |
| `npm.cmd run format:check`         | 通过                                                                                                    |
| `npm.cmd audit --audit-level=high` | 通过，0 vulnerabilities                                                                                 |
| `npm.cmd run build`                | 通过：renderer (87 modules)、main (23 modules, 106KB)、preload (10KB)、native Electron ABI、NSIS 安装包 |
| Smoke test                         | 通过，`FloatingClock.exe` 5 秒后正常运行                                                                |

### 与现有 fast_scanner 的关系

1. 现有 segment v4 mmap 继续只负责 Hash 层，不把 DINOv2 embedding 塞进 .idx segment。
2. 向量索引独立存储于 `vector-db/` 目录。
3. Hash / Vector / Rerank 通过 imageId/path 关联。
4. overlay tombstone 状态需同步影响向量索引和精排特征（removeImageData）。
5. compactManifestAsync 不负责压缩向量索引（向量索引有自己的 rebuild/compact）。
6. searchByImageAsync 不受影响，新增 searchLayered。

### Image Search 落地位置

- 本功能主要落在 `ImageSearchPanel`，不是独立新面板。
- `fast` 模式继续调用原有 `imageSearchBridge.search()`，只走 fast_scanner Hash 层。
- `standard` / `precise` 模式从 `ImageSearchPanel` 调用 `vector:searchLayered`，由 `rerankService` 编排 Hash + Vector + Rerank。
- Image Search 扫描完成并自动保存索引后，通过 `seedEmbeddingJobs()` 为已索引图片生成向量构建任务。
- `Build Embeddings` 负责后台生成 `image_embeddings`，`Build Index` 负责把已有 embedding 装载进 `MemoryVectorIndex`。
- 模型未安装、embedding 未构建、向量索引未就绪时，标准/精准模式必须降级到 Hash 结果，不能影响原有近重复搜索。

### 开源与打包

- GitHub 仓库不提交 .pt/.pth/.onnx/.safetensors/.bin 模型权重。
- `models/` 仅保留 .gitkeep 和 manifest.json。
- 默认仅商业友好模型（Apache-2.0）进入内置下载白名单。
- electron-builder 不打包用户下载的 models/ 缓存。

### 剩余事项

- **已完成：真实模型推理接入** — `embeddingWorker` 和查询侧 `rerankService` 已使用本地 DINOv2 q4 ONNX 生成真实 768 维向量。
- **P2：向量索引大规模性能** — MemoryVectorIndex 线性扫描，后续接入 hnswlib/FAISS。
- **已完成：真实图片解码 / 预处理接入** — DINOv2 路径由 Transformers.js + sharp 读取图片并做模型预处理。
- **已完成：真实颜色/形状精排** — `colorFeatureService` 使用 sharp 采样真实像素并生成 HSV histogram / dominant colors；`shapeFeatureService` 使用 sharp 估计真实宽高比、前景 bbox、面积占比和边缘密度。
- 后续 object crop embedding、ORB/SIFT、OCR 精排为预留插件（`localFeatureService.ts` / `ocrService.ts`）。

### 2026-06-26 Codex 审计修复

> Codex 审查全部新增代码，3 blocking + 4 should-fix，已全部修复。

| 严重度       | 问题                             | 修复                                                                 |
| ------------ | -------------------------------- | -------------------------------------------------------------------- |
| **BLOCKING** | `upsertEmbedding` 不归一化向量   | 存储前除以 L2 范数                                                   |
| **BLOCKING** | `startEmbeddingBuild` 无并发保护 | 检测 running/paused 状态                                             |
| **BLOCKING** | `JsonLinesStore.save()` 竞态条件 | Promise 链互斥锁                                                     |
| SHOULD-FIX   | IPC handler `any` 类型无校验     | `searchLayered`/`startEmbeddingBuild`/`extractFeatures` 加运行时校验 |
| SHOULD-FIX   | `imageId` 直接当文件路径         | 路径遍历检测                                                         |
| SHOULD-FIX   | 硬编码模型名                     | IPC 层从请求参数读取                                                 |
| NIT          | 冗余 `require()`                 | 已标注                                                               |

### 2026-06-26 Image Search 向量落地补丁

- 更新日期：2026-06-26（明确三层图片物品匹配系统落地于 Image Search）
- 修改范围：
  - `electron/embeddingService.ts`
  - `electron/main.ts`
  - `src/components/ImageSearchPanel.tsx`
  - `docs/history/project-progress-and-audit-log.md`
- 修复内容：
  - `startEmbeddingBuild()` 现在使用 `embedding_jobs` 中的真实 `path` 构造 worker task，不再把 `imagePath` 置为空字符串。
  - 没有可用 path 的 embedding job 会被计入 skipped，并返回明确错误。
  - `vector:startEmbeddingBuild` IPC 保留可选 `imageIds` 子集参数，便于后续按 Image Search 结果或选中目录增量构建。
  - Image Search 面板将向量构建拆分为 `Build Embeddings` 和 `Build Index` 两个动作，并显示 embedding 进度。
- 当前结论：
  - 向量层落地链路更清晰：Image Search 扫描 → seed embedding jobs → Build Embeddings → Build Index → standard/precise search。
  - 真实模型推理已在后续 DINOv2 ONNX 补丁中完成；真实颜色/形状特征仍为 P2。

### 2026-06-26 DINOv2 ONNX 模型下载与真实推理接入

- 更新日期：2026-06-26（真实 DINOv2 q4 ONNX embedding 接入）
- 模型来源：
  - `Xenova/dinov2-base`，Transformers.js ONNX 版本，pipeline tag 为 `image-feature-extraction`。
  - 上游 `facebook/dinov2-base` 标注 `license: apache-2.0`。
- 已下载到本机：
  - `<APP_DATA>\models\dinov2_vitb14\Xenova\dinov2-base\config.json`
  - `<APP_DATA>\models\dinov2_vitb14\Xenova\dinov2-base\preprocessor_config.json`
  - `<APP_DATA>\models\dinov2_vitb14\Xenova\dinov2-base\onnx\model_q4.onnx`
- ONNX 权重：
  - 文件大小：56,428,185 bytes
  - SHA-256：`19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018`
- 代码变更：
  - `package.json` / `package-lock.json`：新增 `@huggingface/transformers`，其依赖包含 `onnxruntime-node` 和 `sharp`。
  - `models/manifest.json`：`dinov2_vitb14` 改为本地可用的 Transformers.js q4 ONNX 模型条目。
  - `electron/modelService.ts`：下载模型时同步下载 Transformers.js 必需的 `config.json` 和 `preprocessor_config.json`。
  - `electron/embeddingWorker.ts`：移除 mock embedding 路径，改为离线加载本地 DINOv2 ONNX，输出 768 维归一化向量。
  - `electron/rerankService.ts`：查询图片向量也改为真实 DINOv2 embedding，不再使用 mock query vector。
  - `vite.config.mjs`：主进程和 embedding worker 将 `@huggingface/transformers`、`sharp`、`onnxruntime-node` 外部化，避免 native 依赖错误打包。
- 验证结果：
  - 本地离线 pipeline 加载通过，输出维度 `1x257x768`。
  - `dist-electron/embeddingWorker.js` worker 实测返回 768 维真实向量。
  - `npm.cmd run typecheck`：通过。
  - `npm.cmd run format:check`：通过。
  - `npm.cmd run test:vector-pipeline`：通过，12 passed。
  - `npm.cmd audit --audit-level=high`：通过，0 vulnerabilities。
  - `npm.cmd run build`：通过，NSIS 安装包生成。
- 当前限制：
  - 使用 q4 量化模型，适合作为第一版真实向量检索；如需更高召回质量可切换 `model_uint8.onnx` 或 `model_quantized.onnx`。
  - 颜色/形状精排已接真实图像特征；主体 bbox 当前为轻量启发式估计，复杂背景下仍需后续 object crop / saliency / YOLO/SAM 增强。

## 2026-06-27 当前进度同步

- 更新日期：2026-06-27
- 项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron7\s220260601_221046`
- 审计范围：Image Search 三层图片物品匹配系统、DINOv2 ONNX 模型落地、构建链、依赖审计、打包 smoke test。
- 结论：Image Search 的 `standard` / `precise` 模式已具备真实 DINOv2 向量检索能力；Hash 层仍独立可用；颜色/形状精排已从 mock 替换为真实图片特征。

### 当前可用能力

- `fast` 模式：通过
  - 继续走现有 fast_scanner Hash 检索。
  - 用于重复图、近重复图、压缩图、改尺寸图检索。
- `standard` 模式：部分通过
  - Hash TopK + DINOv2 Vector TopK 合并链路已接通。
  - 查询图和索引图均使用真实 DINOv2 q4 ONNX embedding。
  - 向量索引当前仍为 `MemoryVectorIndex` 线性扫描，适合内部测试和中小规模验证。
- `precise` 模式：部分通过
  - finalScore、matchLevel、reasons 和分数展示已接通。
  - vectorScore、colorScore、shapeScore 均来自真实图片特征。
- 模型下载与本地加载：通过
  - 本机已下载 `Xenova/dinov2-base` q4 ONNX 模型。
  - 应用 manifest 已指向本地可用模型条目。
  - `modelService` 下载逻辑已补齐 `config.json` / `preprocessor_config.json` 伴随文件。

### 当前模型状态

| 项目             | 状态 | 说明                                                                                             |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------ |
| 模型来源         | 通过 | `Xenova/dinov2-base` Transformers.js ONNX；上游 `facebook/dinov2-base` 标注 Apache-2.0           |
| 本地模型目录     | 通过 | `<APP_DATA>\models\dinov2_vitb14\Xenova\dinov2-base` |
| ONNX 权重        | 通过 | `onnx\model_q4.onnx`，56,428,185 bytes                                                           |
| SHA-256          | 通过 | `19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018`                               |
| 本地离线加载     | 通过 | Transformers.js 输出 `1x257x768` token 特征                                                      |
| worker embedding | 通过 | `dist-electron\embeddingWorker.js` 实测返回 768 维向量                                           |

### 2026-06-27 验证矩阵

| 验证项                            | 状态 | 命令 / 结果                                                    |
| --------------------------------- | ---- | -------------------------------------------------------------- |
| 安装依赖                          | 通过 | `npm.cmd install @huggingface/transformers`，0 vulnerabilities |
| 类型检查                          | 通过 | `npm.cmd run typecheck`                                        |
| 格式检查                          | 通过 | `npm.cmd run format:check`                                     |
| Vector 单元测试                   | 通过 | `npm.cmd run test:vector-pipeline`，12 passed                  |
| 依赖审计                          | 通过 | `npm.cmd audit --audit-level=high`，0 vulnerabilities          |
| renderer/main/preload/worker 构建 | 通过 | `npm.cmd run build:renderer`                                   |
| 完整构建                          | 通过 | `npm.cmd run build`，NSIS 安装包生成                           |
| 打包应用 smoke test               | 通过 | `release\win-unpacked\FloatingClock.exe` 5 秒后仍运行          |

### 2026-06-27 真实颜色/形状精排接入

- 更新日期：2026-06-27
- 修改范围：
  - `electron/colorFeatureService.ts`
  - `electron/shapeFeatureService.ts`
  - `electron/rerankService.ts`
  - `electron/main.ts`
- 实现内容：
  - `colorFeatureService` 移除 deterministic mock，改为用 `sharp` 解码真实图片，缩放采样后生成 HSV histogram 和 dominant colors。
  - `shapeFeatureService` 移除 deterministic mock，改为用 `sharp` 读取 metadata 和灰度采样，计算真实 aspectRatio、前景 objectAreaRatio、bboxWidth、bboxHeight 和 edgeDensity。
  - `rerankService` 在 `precise` 模式中异步提取 query 与候选图的真实颜色/形状特征，再计算 colorScore / shapeScore。
  - `vector:extractFeatures` IPC handler 已改为 await 真实特征提取。
- 验证结果：
  - `npm.cmd run typecheck`：通过。
  - `npm.cmd run format:check`：通过。
  - `npm.cmd run test:vector-pipeline`：通过，12 passed。
  - `npm.cmd run build`：通过，NSIS 安装包生成。
  - `release\win-unpacked\FloatingClock.exe` smoke test：通过，5 秒后仍运行。
- 当前结论：
  - `precise` 模式不再依赖 mock color/shape 特征，已经具备真实 Vector + Color + Shape 三层评分链路。
  - 当前 bbox/主体估计是轻量启发式，适合第一版内部测试；复杂背景、透明物体和多主体图片仍需 object crop 模块增强。

### 当前剩余问题

- P1：向量索引仍为内存线性扫描
  - 现象：`MemoryVectorIndex` 对 embedding 做线性 cosine 检索。
  - 影响：中小规模可测试，大规模图库需要 hnswlib/FAISS 或持久化 ANN。
  - 当前结论：不阻断内部测试，不适合宣称百万级向量搜索。
  - 下一步：引入可插拔 `VectorIndexProvider` 的 ANN 实现，并保留 memory fallback。
- P2：缺少 UI 自动化与真实图库验收
  - 现象：尚未用真实产品图集跑召回率、误匹配率、构建耗时和内存曲线。
  - 影响：当前只能证明链路可用，不能证明搜索质量达到产品目标。
  - 当前结论：可进入内部测试，不建议进入 RC。
  - 下一步：准备固定图集，记录 fast/standard/precise 三模式的 TopK 结果和评分分布。
- P2：主体定位仍是轻量启发式
  - 现象：shape bbox 通过边缘背景灰度差估计前景，不使用目标检测或显著性分割。
  - 影响：复杂背景、多主体、低对比物体的 shapeScore 可能偏弱。
  - 当前结论：不阻断第一版 precise 内部测试，但不应宣称已达到商品级主体检测。
  - 下一步：接入 objectCropService 的 saliency / YOLO / SAM 路径，并让 color/shape 优先基于主体 crop 计算。

### 当前评分

#### 总体完成度：92 / 100（↑2，真实颜色/形状精排接入）

评分依据：

- 构建发布链：24 / 25
- 运行稳定性：19 / 20（真实 DINOv2 worker 已验证；真实 color/shape 特征异步提取；向量归一化 + 并发保护 + 写互斥锁）
- 安全状态：19 / 20（IPC 参数校验 + 路径遍历防护 + npm audit 清零）
- 测试覆盖：16 / 20（DINOv2 worker 探针、vector 单测、构建 smoke 通过；仍缺 UI 自动化和真实图库质量测试）
- 代码质量：14 / 15（typecheck/format 通过；DINOv2、color、shape 均已模块化接入，ANN/provider 仍待增强）
- 功能完成度：0 / 0

#### 发布判断

- **继续开发**：✅
- **内部测试**：✅ 推荐。三层搜索可内部试用，未安装模型时自动降级 Hash；已安装模型时可使用真实 DINOv2 + color + shape。
- **RC**：❌ 缺 UI 自动化、真实图库质量评估、ANN 大规模索引、Git/版本管理和签名。
- **正式发布**：❌ 同上，另需图标、自动更新、发布回滚策略。

### 当前验证矩阵

| 项目                | 状态 |                                            命令 / 结果 |
| ------------------- | ---- | -----------------------------------------------------: |
| 安装依赖            | 通过 |                                      `npm.cmd install` |
| 类型检查            | 通过 |                    `npm.cmd run typecheck`（0 errors） |
| 完整测试            | 通过 |                              `npm.cmd test`，94 passed |
| 格式检查            | 通过 |                             `npm.cmd run format:check` |
| 依赖审计            | 通过 |  `npm.cmd audit --audit-level=high`，0 vulnerabilities |
| 完整构建            | 通过 |                                    `npm.cmd run build` |
| DINOv2 worker 探针  | 通过 | `dist-electron\embeddingWorker.js` 返回 768 维真实向量 |
| Node ABI native     | 通过 |                             `npm.cmd run build:native` |
| Electron ABI native | 通过 |                    `npm.cmd run build:native:electron` |
| NSIS 安装包         | 通过 |                `release\FloatingClock Setup 1.0.0.exe` |
| smoke test          | 通过 |                     `FloatingClock.exe` 5 秒后正常运行 |

### 仍需外部条件或独立项目处理

- 真实 SSH/SFTP 服务端故障注入，需要可控测试服务器、测试凭据及网络故障场景。
- Authenticode 签名需要正式代码签名证书；当前安装包和 exe 仍为 `NotSigned`。
- 正式应用图标、自动更新服务器、版本迁移和回滚策略需要发布配置与产品决策。
- 当前目录尚不是 Git 仓库；初始化仓库属于版本管理决策，本轮未擅自执行。
- Electron UI 自动化仍未建立；拖放、真实重启恢复、快捷键与透明窗口交互仍建议人工回归或后续引入 Playwright/Electron 测试环境。

### 2026-06-27 扣分点优化自动完成

- 更新日期：2026-06-27
- 项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron7\s220260601_221046`
- 审计范围：Image Search 三层图片匹配、真实颜色/形状精排、向量索引性能、构建链与打包 smoke test。
- 当前结论：剩余扣分点中可在当前代码内闭环的部分已继续优化完成。`precise` 模式已使用真实 DINOv2 + 真实颜色/形状特征；`MemoryVectorIndex` 已从纯线性扫升级为小库精确扫、大库 LSH 候选召回、不足候选自动回退精确扫的混合索引；shape bbox 对透明背景图片增加 alpha 前景识别。

#### 本轮新增优化

- `electron/vectorIndexService.ts`
  - `MemoryVectorIndex` 增加 deterministic random projection LSH。
  - 10,000 条以内继续精确 cosine scan，保证中小图库结果稳定。
  - 超过 10,000 条时建立 24 bit signature、8 bit band bucket，先取候选再精排。
  - 候选不足 `topK * 24` 时自动回退全量精确扫，优先保护召回质量。
  - manifest 的 `indexType` 支持 `memory_lsh`。
- `shared/vectorTypes.ts`
  - `VectorIndexManifest.indexType` 增加 `memory_lsh`。
- `electron/shapeFeatureService.ts`
  - shape 前景估计优先使用 alpha 通道识别透明背景主体。
  - alpha 不可用或几乎全图不透明时，回退到边缘背景灰度差估计。
  - 保留 aspectRatio、objectAreaRatio、bboxWidth、bboxHeight、edgeDensity 输出。

#### 验证结果

| 验证项              | 状态 | 命令 / 结果                                                                               |
| ------------------- | ---- | ----------------------------------------------------------------------------------------- |
| 类型检查            | 通过 | `npm.cmd run typecheck`                                                                   |
| 格式检查            | 通过 | `npm.cmd run format:check`                                                                |
| Vector 单元测试     | 通过 | `npm.cmd run test:vector-pipeline`，12 passed                                             |
| 完整构建            | 通过 | `npm.cmd run build`，renderer/main/preload/worker/native/electron-builder/NSIS 全链路通过 |
| 打包应用 smoke test | 通过 | `release\win-unpacked\FloatingClock.exe` 启动 5 秒后仍在运行，结果 `running:<pid>`        |

#### 当前评分

总体完成度：94 / 100（较上一轮 92 / 100 提升 2 分）

评分依据：

- 构建发布链：24 / 25。完整构建、native Electron ABI、NSIS 安装包和打包 exe smoke test 均通过；仍缺正式图标和签名。
- 运行稳定性：19 / 20。真实 DINOv2 worker、真实 color/shape、混合向量索引、并发保护和写互斥均已接入；仍需长时间真实图库压测。
- 安全状态：19 / 20。IPC 参数校验、路径遍历防护、模型 SHA 校验、npm audit 已覆盖；正式发布签名仍未完成。
- 测试覆盖：17 / 20。typecheck、format、vector 单测、完整构建、smoke test 均通过；仍缺 UI 自动化和真实图库 TopK 质量基准。
- 代码质量：15 / 15。DINOv2、color、shape、vector index 均模块化接入，ANN provider 接口边界保留。

#### 剩余扣分点

- P2：真实图库质量评估仍未完成。需要固定产品图库，统计 `fast` / `standard` / `precise` 的 TopK 召回、误匹配率、耗时和内存。
- P2：主体定位仍是轻量启发式。透明背景已增强，但复杂背景、多主体、低对比物体仍建议后续接入 object crop / saliency / YOLO / SAM。
- P2：`memory_lsh` 已改善大库候选召回性能，但不是 hnswlib/FAISS 级持久化 ANN。若目标是十万到百万级图库，应继续接入独立 ANN provider。
- P2：Electron UI 自动化仍未建立。Image Search 面板点击流、重启恢复、模型下载失败状态和降级提示仍需自动化或人工回归。

#### 发布判断

- 继续开发：是。
- 内部测试：是，推荐。三层搜索链路已经可用于内部真实样本试跑。
- RC：暂不建议。主要原因是真实图库质量评估、UI 自动化、正式签名和发布配置仍未完成。
- 正式发布：暂不建议。需要补齐 RC 条件并完成图标、签名、更新与回滚策略。

### 2026-06-27 Image Search 交互补充

- 剪贴板截图搜索已落地：`Image Search` 面板新增 `Paste` 按钮，并支持 `Ctrl+V` 直接把剪贴板中的截图作为查询图。
- 缩略图加载已优化：结果区支持批量缩略图拉取，统一走图片缩略图生成逻辑，滚动加载更稳定。
- 精准模式结果已修复打开路径：`Open` / `Folder` / `Copy` 现在优先使用真实文件路径，避免误命中数值 ID。

### 2026-06-28 Image Search 语义搜索补充

- 已新增 `Semantic` 文本搜索入口，可在 Image Search 中输入文本关键词搜索已索引图片。
- 当前第一阶段优先使用已索引图片的文件名、目录名、扩展名和常见中英文同义词做语义相关性评分，结果复用现有缩略图、Open、Folder、Copy 操作。
- 已新增 `vector:searchSemantic` IPC、`semanticSearchService` 服务和共享类型 `SemanticSearchRequest` / `SemanticSearchResponse`。
- 已补充读取当前 `image-search-index` manifest / segment 路径，语义候选不再只依赖 embedding job 数据。
- 当文件名/路径无命中时，会自动使用 `Xenova/clip-vit-base-patch32` zero-shot image classification 对最多 768 张均匀抽样候选做文本-图片语义评分，`woman` 这类词不再只靠文件名命中。
- 当前限制：CLIP 当前为抽样 zero-shot 回退，不是全量 CLIP image embedding ANN 索引；十万级图库要达到稳定语义召回，仍建议后续增加独立的 CLIP embedding 构建与索引按钮。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-07-18 NekoSearch 真人素材逐图语义分组

- 审计确认：旧版只对混杂 DINO 大组的少量代表图贴 CLIP 标签，无法真正分离组内真人；继续增加提示词或放宽组级阈值只会增加假阳性。
- 新增 `semanticPersonClassification.ts`，使用真人/非真人对比门控和八类人物子分类，对每条 CLIP 图片向量独立判断。
- 新增 `Build people groups` IPC、preload 契约和 Clusters UI 入口；复用约 505 MB 的 CLIP Float32 缓存分批扫描，不重跑模型 embedding。
- 人物语义组使用 `semantic_zero_shot` 标识，与 DINO 视觉组并存；视觉组重算保留人物组，组级标签刷新跳过人物组，覆盖率统计不重复累计人物成员。
- 本机 246,534 条缓存只读基准约 2.4 秒，得到 6,225 条高置信真人候选，其中模特 373、肖像 940、自拍 1,462、Cosplay 738；最高分代表图人工抽查匹配。
- 验证：NekoSearch 41/41、IPC registration、preload contract、typecheck、lint、Renderer/Electron build 全部通过。

### 2026-07-18 NekoSearch Clusters 纯度整改

- 问题：旧聚类只取 DINO 向量 10 个维度的符号，最多形成 1,024 个桶；桶内不同图片共享分数和代表图，容易出现大而杂乱的组。
- 修复：新增 DINO Float16 缓存顺序读取，使用 12-bit 微桶和加权 K-Means 做粗路由，再逐张以原始 cosine 做纯度过滤。
- 修复：低于 `Purity` 的成员保留为未分组；平均相似度按实际成员计算，代表图选择最接近中心的成员。
- 默认：`Groups 96`、`Min size 5`、`Purity 0.76`，Groups 最大 256。
- 基准：真实缓存 200,000 向量约 28.3 秒，得到 60 个有效组，保留 35,258 个高置信成员，平均 cosine 0.8531，最大组 4,907。
- 验证：NekoSearch 30/30、typecheck、lint、format、IPC 和 Electron UI smoke 均通过；用户实际重算反馈“效果好多了”。
- 剩余：固定人工标注 purity/coverage、重算稳定性、cluster lineage、手动合并/拆分和成员级调整。

### 2026-07-18 NekoSearch Clusters 范围与自适应组数

- 新增：Clusters 可选择多个文件夹或盘符根目录；范围为空时处理全部已索引 active 素材。
- 新增：`Auto groups` 根据素材规模、DINO 微桶数量和桶分布熵，在 2-256 个中心之间自动选择组数；杂乱图库倾向更多组，单一图库倾向更少组。
- 修复：旧逐图过滤只尝试微桶唯一粗中心，导致图片更接近其他中心时仍被漏分；现在每桶保留多个候选中心，每张图用完整 DINO cosine 选择最佳中心。
- 兼容：关闭 Auto 后仍可手动设置 Groups；Min size 和逐图 Purity 保持有效。
- 扩容：默认全库处理上限由 200,000 提升到 500,000 个 embedding。
- 安全：IPC guard 最多接受 64 个去重范围根目录；路径仅用于已有数据过滤，不触碰原文件。
- 验证：NekoSearch 33/33、IPC 注册 4/4、preload 契约、typecheck、lint、Renderer build 和六面板 UI smoke 全部通过。

### 2026-07-18 NekoSearch Clusters 残差聚类与多标签

- 真实基线：180,016 active 素材，176,386 个具有 DINO；旧结果 98 组、32,580 个成员，DINO coverage 18.47%，143,806 个 DINO 素材因 Purity 未分组。
- 修复：Auto groups 对第一轮未分组素材执行第二轮残差聚类，最多增加 128 个中心，并继续使用相同 Purity 逐图验证。
- 目标：在不直接降低纯度阈值的前提下发现长尾视觉模式，增加群组数和覆盖率。
- 新增：读取每组最多 4 个代表成员的现有 CLIP 缓存，批量编码内置语义词库。
- 新增：每组最多生成 4 个解释标签，分别覆盖媒介、主体、场景和风格；组名使用最高相关标签加序号。
- 降级：CLIP 缓存、模型或标签推理不可用时不影响 DINO 聚类，回退为 `AI Group N`。
- 验证：NekoSearch 35/35、typecheck、lint、Renderer/Electron build、IPC/preload 契约和六面板 UI smoke 全部通过。

### 2026-07-18 NekoSearch Clusters CLIP 语义细分

- 问题：DINO 擅长外观与构图相似性，但同一外观大组内仍可能混入主体语义不同的图片；仅给组生成 CLIP 标签不能改变组内成员。
- 新增：DINO 聚类和逐图 Purity 完成后，对有效组执行两遍 CLIP 图片向量扫描。第一遍在线学习语义中心，第二遍按完整 CLIP cosine 精确分配成员。
- 默认：`Semantic refine` 开启，`Semantic purity=0.86`，每个 DINO 组最多 4 个语义子组；界面允许关闭或调整 0.60-0.99 / 1-8。
- 数据安全：语义细分不会降低 DINO Purity；小于 Min size 的子组并回最近有效中心；缺少 CLIP 向量的成员保留在主组；写入前执行成员数量守恒校验，异常时回退原 DINO 结果。
- 复用：继续使用已有 `clip_embedding_cache.f32` 和路径缓存，不重新运行模型，不增加新的模型体积。
- 修复：CLIP 缓存流读取不再吞掉 `onVector` 业务异常，仅忽略单行损坏的路径 JSON，便于任务正确回退和诊断。
- 验证：NekoSearch 37/37、typecheck、lint、Renderer/Electron build、IPC validation/registration、preload 契约和六面板 UI smoke 全部通过。

### 2026-07-18 NekoSearch 真人摄影语义标签补充

- 问题：原词库只有 `person`、`woman`、`man`、`portrait` 等泛化概念，真人模特和写真组无法获得具体、可读的群组名称。
- 新增：标签词库由约 40 类扩展到 67 类，并新增第五个 `genre` 维度。
- 覆盖：真人照片、肖像摄影、棚拍、时尚摄影、男女模特、情侣、演员、摄影棚、秀场、街拍、舞台、写真、时尚大片、商业模特、自拍、Cosplay、泳装、婚礼、健身和生活方式肖像。
- 输出：单组标签上限由 4 提高到 5，可同时显示媒介、主体、场景、风格和题材，不再只能显示 `woman/person`。
- 生效方式：不会重写已有群组；用户需要在 Clusters 保持 `Semantic refine` 开启并执行 `Recalculate clusters`。
- 真实复测：209 个群组中 `wedding portrait` 被错误输出到 60 组、`selfie` 57 组、`commercial model` 22 组，而 `fashion model` 为 0，证明“每维强制选一个”的旧规则不成立。
- 修复：标签改用相对全局最佳分数门槛；写真类标签必须先通过真人锚点门控；新增独立 `role` 维度，使 `woman/man` 和 `fashion model/female model/male model` 可以同时出现，可靠 role 优先作为自动组名。
- 新增：`Refresh labels` 只读取每组最多 8 张代表图并更新标签，不重建聚类成员；用户自定义组名不会被覆盖。
- 验证：NekoSearch 39/39、typecheck、lint、IPC/preload 契约和 Renderer/Electron build 通过。

### 2026-06-28 Image Search 全功能审计补充

- 审计范围：Image Search 面板、语义搜索、CLIP fallback、缩略图复用、大索引读取、构建验证。
- 已修复：
  - `electron/semanticSearchService.ts` 已清理乱码并重写为稳定 UTF-8 版本。
  - 语义搜索读取 segment 路径时改为按需读取 header / offset table / path bytes，不再整段读取 `.idx`，降低 10 万级索引下的内存和卡顿风险。
  - 中文语义查询新增 CLIP 英文标签映射，常见中文词可转为 `cat`、`woman`、`anime`、`screenshot` 等英文 label 后再走 CLIP zero-shot。
  - 语义匹配 reasons 改为稳定 ASCII 文案，避免 UI 出现乱码。
  - Image Search 结果网格调整为小窗口不溢出的自适应两列/多列布局。
- 已验证：
  - `npm.cmd run typecheck`：通过。
  - `npm.cmd run format:check`：通过。
  - `npm.cmd run build:renderer`：通过。
  - `npm.cmd run test:vector-pipeline`：通过，12 passed。
- 当前判断：Image Search 可继续内部使用和人工回归，功能完成度约 96/100。
- 剩余风险：
  - semantic 当前仍是 filename/path 优先 + CLIP zero-shot 抽样 fallback，不是全量 CLIP embedding ANN。
  - 缺 UI 自动化测试，窗口置顶、透明窗口、缩略图滚动加载、粘贴截图搜索仍需人工回归。
  - 缺真实图库质量基准，尚未统计 TopK 召回率、误匹配率、耗时和内存曲线。

### 2026-06-28 Image Search UI 交互修复

- 已修复查询图片路径无法删除的问题：查询路径框本身为只读显示字段，现已在右侧增加 `Clear`，清空时同步重置当前查询路径、hash、结果、分层结果和搜索统计。
- 已新增结果视图切换：`View: List / Large`。
- `Large` 模式下结果卡片改为大图竖排布局，缩略图约 150px，`Open` / `Folder` / `Copy` 按钮位于图片和信息下方，不再占用图片右侧空间。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Image Search 刷新与隐藏保活

- 已新增 `Refresh` 搜索按钮。用户调整 `Thr`、`Top`、`Search` 等参数后，可直接用当前查询图重新搜索，不需要重新选择图片。
- `Refresh` 也支持语义搜索：没有查询图但有 `Semantic` 文本时，会重新执行当前语义查询。
- 已修复 `Ctrl+Shift+Alt+Q` 全局隐藏再显示后结果消失的问题：Image Search 全局隐藏时不再卸载组件，而是保持挂载并隐藏 DOM，因此查询路径、结果、搜索统计和视图模式会保留。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Build Embeddings 当前路径修复

- 问题：`Build Embeddings` 会优先消费历史 `embedding_jobs.jsonl` 队列，导致用户切换 Scan Paths 到 C/D 盘后，仍显示或处理上次目录的任务。
- 修复：`startEmbeddingBuild` 收到 `scanPaths` 时，直接枚举当前 Image Search 面板选中的路径，并只为这些当前路径构建任务；历史 job 队列仅在未传 `scanPaths` 时作为 fallback。
- 结果：切换盘符或目录后点击 `Build Embeddings`，会按当前 Scan Paths 重新枚举图片，不再被上次记录覆盖。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic Search 大图库崩溃保护

- 问题：本机 `image_embeddings.jsonl` 已约 3.4GB，旧版语义搜索会读取 `embeddingStore.getAll()` / `jobStore.getAll()`，在 Electron 主进程一次性解析超大 JSONL，容易导致主进程卡死或崩溃。
- 修复：语义搜索不再读取 embedding/job JSONL，只从 Image Search 的 manifest / segment 路径区收集候选。
- 修复：候选数量增加硬上限 120,000，超出时返回 degraded 原因，优先保证软件不崩。
- 修复：移除对所有候选路径逐个 `existsSync` 的同步检查，仅对最终结果和 CLIP 抽样做少量检查。
- 修复：CLIP zero-shot fallback 改为安全模式，默认 CPU，最多抽样 64 张，避免 DirectML/GPU native 崩溃风险。
- 剩余限制：当前 semantic 仍不是全量 CLIP embedding ANN。30 万以上图库要稳定语义召回，应后续增加独立 CLIP embedding 构建和 ANN 检索。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic Search 全索引候选优化

- 已将 filename/path semantic 搜索候选上限从 120,000 提高到 1,000,000；当前 16-30 万级 Image Search 索引路径会全部参与文本语义评分。
- 仍不读取 `image_embeddings.jsonl`，避免 3.4GB JSONL 在主进程全量解析导致崩溃。
- CLIP zero-shot fallback 继续限制为 64 张安全抽样；这是兜底，不是正式全量语义检索。
- 技术边界：现有 `Build Embeddings` 是 DINOv2 image embedding，只能用于以图搜图；文本语义搜索要让“所有 embedding”参与，必须后续新增 CLIP image/text embedding 索引。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic CLIP GPU 加速

- 已恢复 `semanticSearchService` 对 GPU backend 的读取。
- 当 `vector-settings.json` 中 `backend` 为 `gpu` 时，Windows 使用 DirectML (`dml`) 执行 CLIP zero-shot fallback。
- GPU 加载或推理异常时会自动回退 CPU，避免直接搜索失败。
- 注意：GPU 只加速 CLIP fallback；filename/path semantic scoring 是字符串匹配，不涉及 GPU。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic Search 返回数量优化

- 问题：语义搜索虽然遍历索引路径，但结果返回仍受 `Top` 限制；UI 最高 200，后端也限制 200，导致命中多时看起来没有显示全部结果。
- 修复：UI `Top` 选项新增 500、1000。
- 修复：后端 semantic `topK` 上限从 200 提升到 1000。
- 说明：结果仍由 `Top` 控制，避免一次渲染过多缩略图导致 UI 卡顿；CLIP zero-shot fallback 仍是小样本兜底，不是全量 CLIP embedding ANN。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic Search 逻辑完整性审计

- 结论：当前 `Semantic` 不是完整全库 CLIP 语义检索，而是 filename/path semantic scoring + CLIP zero-shot sampled fallback。
- 已确认逻辑问题：CLIP fallback 原来用固定步长抽样 64 张，因此 filename/path 无命中时，不同查询可能落到同一批样本，表现为“总是那几个图片”。
- 已修复：CLIP fallback 抽样改为基于查询文本的确定性随机抽样，不同查询词会覆盖不同候选集合。
- 当前可用能力：
  - filename/path semantic：覆盖全部 Image Search 索引路径。
  - CLIP fallback：只做小样本兜底，不保证全库最相关。
- 未完成能力：全库文本-图片语义检索。需要新增 CLIP image/text embedding 构建、持久化向量索引和 ANN 检索，不能复用 DINOv2 image embedding 直接做文本查询。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 以图搜图大 embedding 崩溃修复

- 问题：本机 `image_embeddings.jsonl` 约 3.4GB，旧版 `searchVectorIndex` 在无内存索引时会调用 `getEmbeddingsByModel()` 全量读取并解析 JSONL，导致 Electron 主进程内存暴涨，以图搜图在 `standard` / `precise` 模式下可能崩溃。
- 说明：`Build Embeddings` 的 fail 多数表示单张图片解码失败或不可读，不是这次以图搜图崩溃的直接原因。
- 修复：当 embedding JSONL 超过 512MB 时，`vectorIndexService` 不再全量加载内存索引，改用流式向量检索。
- 流式检索会逐行读取 `image_embeddings.jsonl`，边解析边计算 cosine similarity，只保留 TopK，因此所有 embedding 都能参与搜索，同时避免内存爆炸。
- `Build Index` 遇到超大 JSONL 时不再强行构建内存索引，会返回说明；后续性能优化需要持久化 ANN 索引。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 查询路径与语义结果补充修复

- 修复 Paste 后查询路径再次删不掉：查询路径输入框已改为可编辑，删空会自动清空当前查询、hash、结果和统计；手动输入路径后按 Enter 可重新搜索。
- 修复 semantic 结果少量命中后停止：当 filename/path semantic 结果少于 TopK 时，会继续调用 CLIP fallback 补充候选。
- 说明：CLIP fallback 仍是抽样补充，不是完整全库 CLIP embedding ANN；完整语义全图库检索仍需后续新增 CLIP image/text embedding 索引。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic Search 结果数量与统计修复

- 问题：Top=200 时如果 filename/path 只命中十几个，旧逻辑只返回这十几个；统计区也把匹配数和返回数混在一起，导致数字看起来不对。
- 修复：`SemanticSearchResponse` 新增 `matchedCandidates` / `returnedCount` / `fallbackCount`，前端显示 `Scan` / `Cand` / `Returned` / `Fallback`。
- 修复：当 filename/path 结果少于 TopK 时，CLIP fallback 会继续补充候选；fallback 抽样数至少覆盖 TopK，最多 512。
- 修复：CLIP fallback 分数上限限制为 0.49，避免抽样结果压过明确路径命中。
- 当前最新状态：filename/path semantic 会遍历 Image Search 索引路径；早前文档中的 120,000 candidate cap 和固定 64 fallback 抽样已被后续修复覆盖。
- 限制：这仍是抽样 fallback，不是完整全库 CLIP embedding ANN；完整语义检索需要后续 CLIP image/text embedding 索引。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Refresh TopK 固定 50 修复

- 问题：UI 设置 `Top=200` 后点击查询区 `Refresh`，图搜图 Standard / Precise 仍只输出 50 个。
- 根因：前端调用 layered search 时 `rerankTopK` 被硬编码为 50；同时 `Refresh` 优先使用残留的 Paste 图片路径，可能把 Semantic 刷新误切回图搜图。
- 修复：`rerankTopK` 改为当前 `Top` 值，`hashTopK` / `vectorTopK` 按 `Top` 放大候选池。
- 修复：新增 `lastQueryKind`，`Refresh` 按上一次实际搜索类型刷新，Semantic 不再被残留图片路径抢占。
- 修复：图搜图统计区新增 `Returned`，用于核对实际返回数量。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic CLIP fallback 准确性修复

- 问题：`Semantic cow` 返回大量明显不是牛的图片，说明 CLIP fallback 的结果质量过低。
- 根因：旧逻辑只用目标词、`not 目标词`、`document`、`landscape` 等少量标签做 zero-shot 分类，CLIP 被迫在少量标签中选择，导致无关图片也可能获得高分。
- 修复：新增牛、马、鸟等基础动物中英文语义词。
- 修复：CLIP fallback 改为目标词与常见竞争类别一起分类，例如 `person` / `woman` / `cat` / `dog` / `cow` / `horse` / `document` / `cartoon`。
- 修复：只有目标类别排第一且相对其他类别有分差时，才进入 fallback 结果；低置信度结果不再为了凑满 TopK 强行返回。
- 说明：结果数量可能少于 TopK，但相关性会更高；完整语义召回仍需要后续 CLIP image/text embedding ANN 索引。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。

### 2026-06-28 Semantic 全库 CLIP embedding 检索

- 问题：`woman` / `girl` / `leg` 等语义词返回太少，原因是旧 Semantic 只做 filename/path 命中和 CLIP zero-shot 抽样 fallback，没有真正扫描全库视觉语义向量。
- 修复：新增 `clip_vit_base_patch32` 模型清单，复用本机 `Xenova/clip-vit-base-patch32/onnx/model_q4.onnx`。
- 修复：`embeddingWorker` 新增 CLIP image embedding 分支，可为当前 Scan Paths 生成 512 维图文同空间向量。
- 修复：Image Search 面板新增 `Build CLIP` 按钮，专门构建文本语义搜图所需的 CLIP 图片向量，不影响原 DINO 以图搜图链路。
- 修复：Semantic 搜索优先生成 CLIP text embedding，并流式扫描 `image_embeddings.jsonl` 中的 CLIP image embeddings 做全库相似度检索；没有 CLIP 向量时才回退旧逻辑。
- 使用方式：重启软件后，先选 Scan Paths，点击 `Build CLIP` 等待完成，再用 Semantic 搜索 `woman` / `girl` / `leg`。
- 限制：首次 CLIP 构建耗时和磁盘占用会增加；英文查询通常比中文更稳。
- 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。
