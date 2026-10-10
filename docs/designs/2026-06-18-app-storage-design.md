# Floating Clock Electron 应用空间分析功能设计

## 基本信息

- 创建日期：2026-06-18
- 项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`
- 功能名称：应用空间分析 / App Storage Analyzer
- 功能目标：像安卓手机“存储空间”一样，列出本机应用占用空间，并提供智能归类、排序和定位能力。

## 背景

当前项目已有：

- Electron 主进程 IPC 能力
- 文件管理器目录枚举、图标读取、打开目录能力
- ImageSearch/native 扫描相关经验和性能思路
- 可拖拽面板式 UI

新功能应复用这些已有能力，而不是重新做一个独立体系。

## 用户目标

用户希望快速回答以下问题：

1. 哪些应用最占磁盘空间？
2. 某个应用的主体目录、缓存、用户数据分别占多少？
3. 哪些应用可以考虑清理缓存或卸载？
4. 能否直接打开应用目录、缓存目录或卸载入口？

## 功能范围

### 第一阶段必须实现

- 新增独立面板：`App Storage`
- 从 Windows 注册表读取已安装应用基础信息：
  - 应用名称
  - 发布者
  - 版本
  - 安装路径
  - 卸载命令
  - 注册表声明的大小（如存在）
- 对可访问的应用路径进行目录大小扫描：
  - `InstallLocation`
  - `DisplayIcon` 推断目录
  - 常见用户数据目录候选
- 列表展示应用占用空间：
  - 名称
  - 总大小
  - 主体目录大小
  - 用户数据 / 缓存大小
  - 发布者
  - 风险/建议标签
- 支持按大小排序。
- 支持搜索应用名称。
- 支持打开应用目录。
- 支持刷新扫描。
- 扫描过程不能卡住 UI。

### 第一阶段暂不实现

- 自动删除缓存
- 自动卸载应用
- 深度清理系统目录
- 驱动级全盘扫描
- 后台常驻索引服务
- 对 Microsoft Store / UWP 包的完整 AppX 清单分析

这些功能风险更高，后续单独做。

## 数据来源设计

### 注册表来源

优先读取以下位置：

- `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`
- `HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`

字段：

- `DisplayName`
- `DisplayVersion`
- `Publisher`
- `InstallLocation`
- `DisplayIcon`
- `UninstallString`
- `QuietUninstallString`
- `EstimatedSize`

### 文件系统候选路径

对每个应用智能推断：

- 安装目录：
  - `InstallLocation`
  - `DisplayIcon` 所在目录
  - `UninstallString` 中 exe 所在目录
- 用户数据目录：
  - `%APPDATA%\<AppName>`
  - `%LOCALAPPDATA%\<AppName>`
  - `%LOCALAPPDATA%\<Publisher>\<AppName>`
  - `%PROGRAMDATA%\<AppName>`

### 大小计算策略

- 目录递归扫描应限制并发。
- 跳过系统敏感目录和明显无关目录。
- 对不可访问路径记录 `inaccessible`，不作为错误中断。
- 支持扫描进度：
  - 已扫描应用数
  - 当前应用
  - 已发现总大小
  - 跳过/失败路径数量

## 智能分析规则

### 分类

应用结果按空间来源拆分：

- `app`：安装主体
- `data`：用户数据
- `cache`：缓存/临时数据
- `unknown`：无法明确分类

### 建议标签

初版可用启发式标签：

- `Large`：总大小超过 1GB
- `Huge`：总大小超过 5GB
- `Cache heavy`：缓存/用户数据大于安装主体
- `Unknown size`：注册表存在但路径不可扫描
- `Portable-like`：无卸载命令但有可执行路径
- `Registry only`：只有注册表信息，无有效路径

### 风险说明

只做分析和打开目录，不自动删除。所有清理建议必须保守。

## UI 设计

### 面板名称

- 标题：`App Storage`
- 设置面板开关名称：`Apps`

### 面板布局

顶部工具栏：

- 搜索输入框
- `Scan` 按钮
- `Stop` 按钮
- 排序选择：大小 / 名称 / 发布者

摘要区：

- 应用数量
- 已扫描数量
- 总估算空间
- 最大应用
- 不可访问路径数量

列表区：

- 每行一个应用
- 显示名称、大小、发布者、标签
- 展开后显示路径明细
- 每个路径提供 `Open` 操作

状态区：

- 当前扫描状态
- 当前扫描应用
- 错误/警告数量

## IPC 设计

新增 preload API：

- `appStorage.scan(): Promise<AppStorageScanResult>`
- `appStorage.stop(): Promise<{ ok: boolean }>`
- `appStorage.getStatus(): Promise<AppStorageStatus>`
- `appStorage.onStatusChanged(cb): () => void`
- `appStorage.openPath(path): Promise<void>`

新增主进程 IPC：

- `appStorage:scan`
- `appStorage:stop`
- `appStorage:getStatus`
- `appStorage:openPath`
- `appStorage:onStatusChanged`

## 类型设计

核心类型：

```ts
export interface AppStorageEntry {
  id: string
  name: string
  publisher?: string
  version?: string
  installLocation?: string
  uninstallString?: string
  estimatedRegistryBytes?: number
  totalBytes: number
  scannedBytes: number
  dataBytes: number
  cacheBytes: number
  inaccessibleCount: number
  paths: AppStoragePathEntry[]
  tags: string[]
}

export interface AppStoragePathEntry {
  path: string
  kind: 'app' | 'data' | 'cache' | 'unknown'
  bytes: number
  exists: boolean
  accessible: boolean
  source: string
}

export interface AppStorageStatus {
  state: 'idle' | 'scanning' | 'stopping' | 'error'
  appCount: number
  scannedCount: number
  totalBytes: number
  currentApp?: string
  warnings: number
  message?: string
}
```

## 实现方案

### 主进程

新增文件：

- `electron/appStorageService.ts`

职责：

- 读取注册表
- 解析应用元数据
- 推断路径
- 递归计算目录大小
- 聚合结果
- 推送状态

注册方式：

- 在 `electron/main.ts` 中注册 IPC handler。

### Renderer

新增文件：

- `src/components/AppStoragePanel.tsx`

职责：

- 发起扫描
- 展示进度
- 展示应用列表
- 展开路径明细
- 搜索、排序、打开目录

Store 扩展：

- `showAppStorage`
- `appStoragePos`
- `appStorageSize`
- `setAppStoragePos`
- `setAppStorageSize`
- `toggleShowAppStorage`

Settings 扩展：

- 面板开关中增加 `Apps`

App 扩展：

- 渲染 `AppStoragePanel`
- show all / snap / arrange 包含该面板

## 性能约束

- 扫描不能阻塞 renderer。
- 单次目录扫描应可中止。
- 不应默认扫描整个磁盘。
- 每个应用最多扫描有限候选路径。
- 扫描时定期推送状态，避免用户误以为卡死。
- 对大目录保守处理，必要时可以后续增加采样模式。

## 安全约束

- 不执行卸载命令。
- 不删除文件。
- 不自动修改注册表。
- 打开目录前必须使用已有路径安全规范。
- 对异常路径、空路径、根目录必须跳过或限制。

## 验收标准

### 功能验收

- 可以从设置面板打开 `App Storage`。
- 点击 `Scan` 后能列出已安装应用。
- 应用按占用空间降序显示。
- 能看到总空间和每个应用空间。
- 能展开查看路径明细。
- 能打开有效路径。
- 扫描过程 UI 不冻结。

### 工程验收

必须通过：

- `npm.cmd run typecheck`
- `npm.cmd run build:renderer`
- `npm.cmd run build`
- `npm.cmd run format:check`

建议通过：

- `npm.cmd run test:guards`
- `npm.cmd run test:settings`
- `npm.cmd audit --audit-level=high`

### smoke test

- 新构建的 `release\win-unpacked\FloatingClock.exe` 启动 5 秒后仍在运行。

## 风险评估

- 注册表读取命令在不同 Windows 语言/权限环境下输出格式可能不同。
- 目录大小扫描可能慢，需要中止和进度反馈。
- 部分应用没有明确安装目录，只能显示注册表估算值。
- Electron 主进程递归扫描如果实现不谨慎，会造成 CPU/IO 高占用。

## 初版评分预期

- 功能完整度目标：70 / 100
- 稳定性目标：75 / 100
- 性能目标：70 / 100
- 安全目标：90 / 100

初版重点是“可见、可排序、可定位”，不是自动清理。

## 下一步

1. 新增 IPC 类型定义。
2. 实现 `electron/appStorageService.ts`。
3. 在 preload 暴露 `appStorage` API。
4. 新增 `AppStoragePanel`。
5. 扩展 store、settings 和 App 渲染。
6. 跑 typecheck/build/smoke test。
