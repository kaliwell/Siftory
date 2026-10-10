# Electron UI 冒烟测试报告

> 状态：当前  
> 日期：2026-07-12  
> 更新日期：2026-07-13  
> 范围：开发构建与 `win-unpacked` 打包构建  
> 结论：通过
> 替代文档：无

## 目标

补齐 Electron 真实渲染链路的自动验证，覆盖单元测试和静态检查无法发现的以下问题：

- renderer 懒加载面板未挂载；
- preload 或 IPC 契约在真实 BrowserWindow 中失效；
- 打包后资源路径错误；
- renderer 控制台 error；
- renderer 崩溃或空白透明窗口；
- 关键面板未实际绘制。

## 实现

- `electron/uiSmokeService.ts`：在显式测试环境变量存在时挂接 BrowserWindow 生命周期、收集错误、生成截图和 JSON 报告。
- `tests/electron-ui-smoke.cjs`：使用隔离的临时 `userData` 与 MediaSearch 数据目录启动 Electron，避免读取或修改用户真实配置和索引。
- `npm.cmd run smoke:ui`：构建后验证开发可执行路径。
- `npm.cmd run smoke:ui:packaged`：验证 `release/win-unpacked/FloatingClock.exe`。
- 测试产物写入忽略版本控制的 `artifacts/ui-smoke*`，每次运行覆盖最新报告。

测试强制挂载并检查以下五个高价值懒加载面板：

1. Image Search
2. Media Search
3. Remote Terminal
4. App Storage
5. Duplicate Finder

测试专用样式只存在于隔离的冒烟 renderer 中，用于把五个面板排成 3+2 网格。它不写入 Zustand 状态，不修改用户布局，也不进入正常启动路径。

## 通过条件

- `document.readyState === 'complete'`；
- 五个目标面板全部存在且可见；
- body 有有效文本；
- 未发现包含 crashed 的面板状态；
- renderer console error 数量为 0；
- 截图尺寸有效；
- 非透明像素抽样数大于 100。

## 结果

### 开发构建

命令：

```powershell
npm.cmd run smoke:ui
```

结果：

- 状态：通过；
- 总耗时：3,720 ms；
- 面板：5/5；
- console error：0；
- crashed panel：0；
- 截图：2560 x 1392；
- 非透明像素抽样：155,520。

### 打包构建

命令：

```powershell
npx.cmd electron-builder --win --dir
npm.cmd run smoke:ui:packaged
```

结果：

- 状态：通过；
- 总耗时：8,833 ms；
- 面板：5/5；
- console error：0；
- crashed panel：0；
- 截图：2560 x 1392；
- 非透明像素抽样：155,520。

## 排查记录

1. 最初直接截取隐藏透明窗口时，DOM 检查通过，但截图保留了旧合成帧。原因是 Chromium 不保证未显示透明窗口的 `capturePage()` 完整重绘。测试模式改为截图前短暂调用 `showInactive()`，正式应用行为不变。
2. 直接修改面板内联位置会触发布局持久化观察器，并被 React 状态回写覆盖。测试改为注入带 `!important` 的隔离样式，不再触碰应用状态。
3. 打包态测试不带参数时在本机 Windows 环境下 30 秒未生成报告；日志没有资源加载错误，也没有残留进程。测试进程加入 `--no-sandbox` 后稳定通过。
4. `--no-sandbox` 仅是冒烟脚本启动参数。正式 BrowserWindow 仍保持 `sandbox: true`，安装包默认启动参数和安全边界没有变化。

## 边界

- 本测试验证“能启动、能挂载、能绘制、无明显运行错误”，不替代人工交互测试。
- 不点击会修改文件或远程状态的按钮。
- 不验证真实 SSH、模型推理、扫描任务和搜索准确率。
- NSIS 安装器本轮未重新压缩；验证对象是由当前构建产物重新生成的 `win-unpacked` 正式可执行文件。

## 2026-07-13 搜索双模式回归

Image Search 和 Media Search 增加 Simple/Advanced 后，UI smoke 新增 `searchModeChecks`：

1. 使用隔离的全新 `userData` 打开面板，验证默认处于 `Simple`。
2. 点击 `Advanced`，验证 Image Search 出现 `Start Scan`，Media Search 出现 `Build Frames`。
3. 切回 `Simple`，验证 `Prepare Library` 恢复且高级控件隐藏。
4. 模式检查期间不启动扫描、模型下载或 embedding，不修改用户真实数据。

最新开发态结果：

```text
Status:                 passed
Elapsed:                2,927 ms
Panels:                 5/5
Console errors:         0
Image mode checks:      default Simple / Advanced visible / List absent / Simple restored
Media mode checks:      default Simple / Advanced visible / Simple restored
Screenshot:             2560 x 1392
Non-transparent samples: 155,520
```

本次没有重新生成 `win-unpacked` 或 NSIS，因此 2026-07-12 的打包态结果仍是旧发布基线，不能用于证明当前安装包已经包含搜索双模式。

## 2026-07-14 最新打包态回归

最新 `win-unpacked` 已重新生成，搜索双模式与 Image Large 进入正式打包产物。`npm.cmd run smoke:ui:packaged` 结果为 5/5 面板、0 console error、8,972 ms；Image Search 的 `listViewOptionAbsent` 为 `true`。该结果替代上一节“尚未重新生成”的发布边界。

安装包归档和哈希见[2026-07-14 最新安装包验证报告](2026-07-14-release-installer-verification.md)。
