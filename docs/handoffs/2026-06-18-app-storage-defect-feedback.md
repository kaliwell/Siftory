# DeepSeek 反馈：App Storage 缺陷修复

## 反馈来源

- 反馈日期：2026-06-18
- 项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`
- 相关功能：`App Storage / 应用空间分析`
- 反馈依据：用户截图与实际使用反馈

## 当前结论

App Storage 第一阶段已经接入并可运行，但当前结果存在明显可信度问题。请优先修复数据准确性和中文显示问题，再继续做视觉或增强功能。

## 必须修复的问题

### 1. 中文字符乱码

现象：

- App Storage 列表中出现 `���...` 一类乱码应用名。
- 截图中可见多个应用名称无法正确显示中文或特殊字符。

影响：

- 用户无法判断具体应用。
- 搜索、排序和人工核对都会失真。

优先排查：

- `electron/appStorageService.ts` 中读取 Windows 注册表的 PowerShell 输出编码。
- `ConvertTo-Json` 输出经过 Node `execFile` 接收时的编码。
- Windows PowerShell 5.1 默认控制台编码与 Node UTF-8 解码不一致的问题。

建议方案：

- PowerShell 脚本开头显式设置输出编码：
  - `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
  - `$OutputEncoding = [System.Text.Encoding]::UTF8`
- `execFile` 参数中可以考虑使用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ...`
- 如果仍乱码，改用 `-EncodedCommand`，将脚本按 UTF-16LE Base64 传入 PowerShell，避免命令行转义和编码损坏。
- 对 JSON 解析失败或名称含替换字符 `�` 的条目进行标记，不要静默当成正常应用。

验收标准：

- 中文应用名正常显示。
- 应用名中不应出现 `���` 或 `�` 替换字符。
- 搜索中文应用名可命中。

### 2. 体积大小不真实

现象：

- 多个完全不同的应用显示接近 `45 GB` 到 `49 GB`。
- 用户反馈有的应用已经删除，但仍显示大体积。
- 截图中大量应用被标记为 `Huge` 和 `Partial`，疑似扫描到了共享目录、父目录或错误目录。

影响：

- App Storage 的核心价值是判断应用占用空间，当前结果会误导用户。

优先排查：

- `inferCandidatePaths()` 是否从 `UninstallString`、`DisplayIcon` 推断到过大的父目录。
- 是否扫描到了游戏库根目录、Steam 库根目录、Program Files 根目录、用户目录、下载目录等共享目录。
- 是否将注册表 `EstimatedSize` 和实际扫描值混用导致夸大。
- 已卸载应用是否仍有注册表残留，导致被列出。

必须调整：

- 对候选路径增加更严格的安全边界：
  - 禁止扫描盘符根目录。
  - 禁止扫描 `C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData` 这类公共根目录。
  - 禁止扫描 Steam/Epic/Ubisoft 等库根目录本身，只允许扫描能明确匹配应用名的子目录。
  - 禁止扫描用户主目录、桌面、下载、文档等宽泛目录。
- 对 `UninstallString` / `DisplayIcon` 推断出的目录做置信度判断：
  - 路径最后一级或上级目录应与应用名、发布者、注册表 key 有相似度。
  - 如果只能定位到共享启动器或公共库目录，应标记为低置信度，不参与总大小。
- 对已删除应用或残留注册表项：
  - 如果所有候选路径均不存在，显示为 `Registry only` 或 `Missing paths`。
  - 不应显示虚假的大体积。
  - 总大小可使用注册表 `EstimatedSize`，但必须标记 `Registry estimate`，不要伪装成扫描结果。
- 总大小计算建议拆分：
  - `scannedBytes`：实际扫描到的路径大小。
  - `estimatedRegistryBytes`：注册表估算值。
  - `totalBytes`：用于排序的展示值，但必须有来源标记。
  - UI 中明确显示 `Scanned` / `Registry estimate` / `Partial`。

验收标准：

- 删除后的应用如果目录不存在，不再显示几十 GB 的虚假体积。
- 不同游戏不应因为同一个库目录被重复算成相近大体积。
- `Huge` 数量明显下降，只对真实大体积应用出现。
- 展开路径后，用户能看到每个大小来自哪个具体目录。

### 3. 增加直接跳转目录按钮

用户需求：

- 每个应用或每个路径明细旁边，需要有可以直接跳转到该目录的按钮。

当前已有能力：

- IPC 已有 `appStorage.openPath(folderPath)`。
- 主进程已有 `appStorage:openPath` handler。

需要补齐：

- 在应用行右侧增加一个小按钮，例如 `Open` 或文件夹图标。
- 展开路径明细时，每条存在的路径旁边都要有打开按钮。
- 如果路径不存在或不可访问，按钮禁用。
- 点击后调用 `window.electronAPI.appStorage.openPath(path)`。
- 打开失败时在 UI 上给出轻量错误状态，不要静默失败。

验收标准：

- 用户能从应用列表直接打开主要目录。
- 用户能从展开明细打开具体目录。
- 不存在路径不会触发打开。
- 不增加删除、卸载、清理等破坏性操作。

## 推荐实现顺序

1. 先修复 PowerShell/注册表读取编码，解决乱码。
2. 再修正路径推断和体积计算，避免重复扫描共享目录。
3. 增加路径置信度、来源标记和 `Missing paths` / `Registry estimate` 标签。
4. 最后补充打开目录按钮和错误反馈。
5. 更新 `docs\history/project-progress-and-audit-log.md`，写明修复范围、验证命令和剩余问题。

## 必须验证

完成后运行：

- `npm.cmd run format:check`
- `npm.cmd run typecheck`
- `npm.cmd run build`
- `npm.cmd audit --audit-level=high`

建议增加手工验证：

- 打开 App Storage 面板。
- 点击 `Scan`。
- 检查中文应用名是否正常。
- 检查已删除应用是否仍显示虚假大体积。
- 展开 3 到 5 个大体积应用，确认大小来源目录真实。
- 点击目录跳转按钮，确认能打开对应目录。

## 注意事项

- 不要加入删除、清理、卸载功能。
- 不要扫描过宽目录来追求“看起来完整”，准确性优先。
- 不要把启动器目录、游戏库根目录重复算给每一个游戏。
- 不要破坏现有构建链和 Electron 42 配置。
