# DeepSeek 交接说明：应用空间分析功能

## 交接目的

本文件用于让 DeepSeek 接手 `App Storage / 应用空间分析` 新功能，并通过 `docs` 目录与当前项目状态对齐。

DeepSeek 接手前必须先阅读本目录下的文档，避免根据旧状态误判项目。

## 项目路径

`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron6\s1020260601_221046\s220260601_221046`

## 必读文档

请按顺序阅读：

1. `docs\history/project-progress-and-audit-log.md`
2. `docs\designs/2026-06-18-app-storage-design.md`
3. `docs\designs/image-search-rearchitecture.md`

阅读目的：

- 第 1 份文档用于确认当前工程状态、构建链、审计和评分。
- 第 2 份文档是本次新功能的需求与实现边界。
- 第 3 份文档用于理解 ImageSearch/native 扫描相关设计，不要求直接复刻，但可参考其扫描、索引、状态推送思路。

## 当前项目事实

以下结论已经验证，不要再按旧总结处理：

- `npm.cmd run build` 已通过。
- `npm.cmd audit --audit-level=high` 已为 `found 0 vulnerabilities`。
- `release\win-unpacked\FloatingClock.exe` smoke test 5 秒后仍运行。
- `format:check` 已通过。
- `typecheck` 已通过。
- `test:native` 已通过，26 passed。
- Electron 已升级到 `^42.4.1`。
- electron-builder 已升级到 `^26.15.3`。
- 打包使用本地 `node_modules/electron/dist`，配置项为 `electronDist: "node_modules/electron/dist"`。
- 本地网络代理可用：v2rayN mixed 端口 `http://127.0.0.1:<port>`。

## 当前仍存在的问题

- `npm.cmd run lint` 仍为 0 errors / 124 warnings。
- C++ native 编译有 warning：
  - `C4819`
  - `std::filesystem::u8path` deprecated
- 这些不是新功能开发阻塞项，但新增代码不要继续扩大 warning 数量。

## 新功能目标

实现 `App Storage / 应用空间分析` 面板，像安卓手机存储页一样列出应用占用空间。

第一阶段目标：

- 列出 Windows 已安装应用。
- 估算每个应用占用空间。
- 按大小排序。
- 支持搜索。
- 展示安装目录、用户数据目录、缓存目录等明细。
- 支持打开路径。
- 扫描时有进度状态。
- 不执行删除，不执行卸载，不修改注册表。

详细需求见：

`docs\designs/2026-06-18-app-storage-design.md`

## 推荐实现范围

### 新增主进程服务

建议新增：

`electron\appStorageService.ts`

职责：

- 读取 Windows 注册表中的已安装应用。
- 推断应用相关路径。
- 递归估算目录大小。
- 定期推送扫描状态。
- 支持停止扫描。
- 跳过不可访问路径，不中断整个扫描。

### 新增 Renderer 面板

建议新增：

`src\components\AppStoragePanel.tsx`

职责：

- 显示扫描按钮、停止按钮、搜索框、排序控件。
- 显示摘要：应用数量、已扫描数量、总空间、最大应用、不可访问路径数。
- 显示应用列表。
- 支持展开路径明细。
- 支持打开路径。

### 扩展 IPC 类型

修改：

`shared\ipc-contract.ts`

新增类型建议：

- `AppStorageEntry`
- `AppStoragePathEntry`
- `AppStorageStatus`
- `AppStorageScanResult`

扩展 `ElectronAPI`：

- `appStorage.scan`
- `appStorage.stop`
- `appStorage.getStatus`
- `appStorage.openPath`
- `appStorage.onStatusChanged`

### 扩展 preload

修改：

`electron\preload.ts`

将 `appStorage` API 暴露给 renderer。

### 扩展 main

修改：

`electron\main.ts`

注册 `appStorage` IPC handlers。

### 扩展 Store

修改：

`src\stores\useStore.ts`

新增：

- `showAppStorage`
- `appStoragePos`
- `appStorageSize`
- `setAppStoragePos`
- `setAppStorageSize`
- `toggleShowAppStorage`
- `setShowAppStorage`

并加入 arrange / lock / visibility / show-all 体系。

### 扩展 Settings

修改：

`src\components\SettingsPanel.tsx`

在面板开关列表中加入：

- `Apps`

### 扩展 App

修改：

`src\App.tsx`

渲染 `AppStoragePanel`，并加入：

- snap all
- show all
- saved visibility
- settings load restore

## 关键工程约束

### 不要破坏构建链

不要把 `build` 脚本改回 `tsc && vite build && electron-builder`。

当前稳定构建依赖：

- `scripts\build.cjs`
- `vite.config.mjs`
- `--configLoader runner`
- `scripts\build-native.cjs`

### 不要使用 `vite.config.ts` 作为主构建配置

`vite.config.ts` 仍在项目里，但当前稳定脚本使用 `vite.config.mjs`。

新增功能如需改 Vite 配置，应优先改 `vite.config.mjs`。

### 不要让扫描阻塞 UI

目录大小扫描必须在主进程异步进行，并定期推送状态。

不要在 renderer 中递归扫描文件系统。

### 不要做危险清理

第一阶段只分析，不删除、不卸载、不修改注册表。

### 路径安全

打开路径时应复用已有路径安全思路：

- 空路径跳过
- 根目录谨慎处理
- 不可访问路径标记为 inaccessible
- 不把错误抛到 UI 顶层导致整个扫描失败

## 建议的实现顺序

1. 修改 `shared\ipc-contract.ts`，加入 AppStorage 类型和 API。
2. 新增 `electron\appStorageService.ts`，先实现注册表枚举和大小扫描。
3. 修改 `electron\preload.ts` 和 `electron\main.ts`，接通 IPC。
4. 新增 `src\components\AppStoragePanel.tsx`。
5. 扩展 `src\stores\useStore.ts`。
6. 扩展 `src\components\SettingsPanel.tsx`。
7. 扩展 `src\App.tsx`。
8. 跑验证命令。
9. 更新 `docs\history/project-progress-and-audit-log.md`。

## 注册表读取建议

Windows 可使用 PowerShell 读取注册表：

- `HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*`
- `HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*`
- `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*`

建议在主进程里调用 PowerShell 并解析 JSON 输出。

注意：

- PowerShell 输出要指定 `ConvertTo-Json`。
- 读取失败不能中断整个功能。
- 注册表 `EstimatedSize` 通常单位是 KB，需要转换为 bytes。
- `DisplayIcon` 可能包含 `,0` 或引号，需要解析路径。

## 目录大小扫描建议

第一阶段可使用 Node `fs/promises` 实现递归扫描。

建议限制：

- 每个应用最多扫描 8 个候选路径。
- 跳过明显危险或太大的系统根路径：
  - `C:\`
  - `C:\Windows`
  - `C:\Program Files`
  - `C:\Program Files (x86)`
  - `C:\ProgramData`
- 对每个路径统计：
  - bytes
  - accessible
  - exists
  - kind
  - source

## UI 风格要求

项目是工具型悬浮面板，不要做营销式页面。

UI 应保持：

- 信息密度高
- 可扫描
- 小字号
- 面板内部不套大卡片
- 不使用大面积装饰渐变
- 列表行要稳定，不因内容变化跳动

## 必须通过的验证

完成后至少跑：

```powershell
npm.cmd run typecheck
npm.cmd run build:renderer
npm.cmd run build
npm.cmd run format:check
npm.cmd audit --audit-level=high
```

建议补跑：

```powershell
npm.cmd run test:guards
npm.cmd run test:settings
npm.cmd run test:fm-security
npm.cmd run test:fm-watcher
npm.cmd run test:native
```

最终 smoke test：

启动：

`release\win-unpacked\FloatingClock.exe`

验收：

- 5 秒后进程仍运行。
- 打开 Settings 面板能看到 `Apps` 开关。
- 打开 App Storage 面板能扫描并列出应用。
- 扫描中 UI 不冻结。

## DeepSeek 完成后必须回写

请更新：

`docs\history/project-progress-and-audit-log.md`

至少写入：

- 新增功能完成情况
- 新增/修改文件列表
- 验证命令和结果
- 剩余风险
- 最新评分

如设计发生变化，也更新：

`docs\designs/2026-06-18-app-storage-design.md`

## 当前建议评分

接手前项目状态：

- 总体完成度：82 / 100
- 可新增功能：是
- 可内部测试：是
- RC：接近，但仍建议完整人工回归
- 正式发布：暂不建议

App Storage 功能完成后，如果验证通过，项目完成度预计可提升到 86-88 / 100。
