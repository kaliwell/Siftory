# 浏览器视频模糊：合成链排查记录

## 现象

- 仅锁定显示一个面板。
- 按 `Ctrl+Shift+Alt+Q` 隐藏其他面板后，浏览器视频变模糊。
- 在浏览器视频区域按住鼠标时画面立即清晰，松开后再次模糊。
- 完全隐藏原生 Electron 窗口时不保留锁定面板，因此不是相同路径。

## 环境事实

- Windows 11 10.0.22631。
- Intel Iris Xe Graphics，驱动 31.0.101.3962，日期 2022-12-12。
- NVIDIA GeForce RTX 3050 Laptop GPU，驱动 32.0.15.7700，日期 2025-07-14。
- OrayIddDriver 虚拟显示驱动 17.50.19.949。
- Chrome 149 使用独立 GPU process；renderer 启用 GPU memory buffer。
- Electron 窗口为透明、无边框、桌面工作区大小、always-on-top，并通过 `setShape` 限制可见区域。

## 已排除项

| 编号 | 变量 | 修改 | 结果 |
| --- | --- | --- | --- |
| E1 | CSS 背景模糊 | 移除全部 `backdrop-filter` | 用户复测仍模糊 |
| E2 | shape 同步延迟 | 可见性切换后下一帧强制同步 shape | 用户复测仍模糊 |
| E3 | 重复 show/topmost | 保留锁定面板时不再调用 `showWindow()` | 用户复测仍模糊 |
| E4 | 极端 topmost 层级 | `screen-saver` 降为 `floating` | 用户复测仍模糊 |
| E5 | 桌面大小透明 surface | `compact` 将原生 bounds 物理缩到单个锁定面板 | 用户复测仍模糊 |
| E6 | `disable-direct-composition` | `direct` 恢复 Electron 默认 DirectComposition | 仍模糊；拖动时出现黑底和旧帧残影 |

因此 renderer CSS、快捷键重复显示、`setShape` 和原生窗口物理尺寸不是根因。剩余共同条件是：透明 Electron 原生窗口仍可见并置顶，且参与 Windows DWM/MPO 合成。

鼠标按住期间临时恢复清晰，说明视频解码源没有降低清晰度；变化发生在 DWM/Chrome 最终合成路径。`useMouseTransparency` 只监听 `mousemove`，没有 mouse down/up 分支，因此该现象不是应用主动在 mouseup 时修改穿透状态。

## 当前假设

1. **H1：透明 always-on-top 窗口导致 Chrome 视频 MPO 降级。** 混合显卡和虚拟显示驱动会提高概率。
2. **H2：`disable-direct-composition` 与当前 Chromium/驱动组合不兼容。** 该开关从 2026-06-15 开始存在，早期版本没有。
3. **H3：Windows `setShape` 的 shaped transparent surface 导致 DWM 重建视频合成链。**
4. **H4：Electron 自身 GPU surface 与 Chrome GPU surface 在混合显卡上发生冲突。**
5. **H5：Intel 2022 年驱动或 Oray 虚拟显示驱动存在 MPO 兼容问题。** 仅在应用侧变量全部排除后测试。

## 诊断模式

关闭所有 FloatingClock/Electron 实例后，在项目目录分别运行：

```powershell
npm.cmd run diagnose:video:baseline
npm.cmd run diagnose:video:compact
npm.cmd run diagnose:video:no-topmost
npm.cmd run diagnose:video:direct
npm.cmd run diagnose:video:no-shape
npm.cmd run diagnose:video:software
```

每个命令都会重新构建 renderer/main/preload，并以单一诊断变量启动应用。

## 严格测试步骤

1. 使用同一个 Chrome 视频、相同清晰度、相同窗口尺寸和相同显示器。
2. 完全退出上一轮 Electron 进程，再启动下一轮；不能同时运行两个模式。
3. 只显示并锁定同一个面板。
4. 播放视频 10 秒，记录初始清晰度。
5. 按一次 `Ctrl+Shift+Alt+Q`，等待 5 秒，记录是否模糊。
6. 再按一次恢复，观察清晰度是否恢复。
7. 每个模式重复 3 次，记录“3/3 模糊”“偶发”或“0/3 模糊”。

## 判定表

| 模式 | 单一变化 | 如果不再模糊 |
| --- | --- | --- |
| baseline | 当前正式配置 | 用于确认稳定复现 |
| compact | 原生窗口 bounds 物理缩到可见面板 union | 若通过，证明桌面大小透明 surface 是根因 |
| no-topmost | 禁用 always-on-top | H1 成立；需要改为物理小窗口或其他置顶策略 |
| direct | 不添加 `disable-direct-composition` | H2 成立；删除旧 workaround |
| no-shape | 不调用 `BrowserWindow.setShape` | H3 成立；改用物理窗口 bounds/多窗口方案 |
| software | Electron 禁用硬件加速 | H4 成立；评估仅 Electron 软件渲染的性能代价 |

## 推荐顺序

1. baseline。
2. compact：已测试，仍模糊。
3. direct：已测试，仍模糊且透明渲染恶化；正式模式必须保留 `disable-direct-composition`。
4. no-topmost：下一轮，直接验证透明 topmost/MPO 假设。
5. no-shape：验证 shaped window。
6. software：验证 Electron GPU surface。

## 应用侧后续方案

- 如果 `no-topmost` 唯一通过：不能继续使用桌面大小透明 topmost 窗口。优先改为按锁定面板物理 bounds 创建小窗口，或为锁定面板使用独立 BrowserWindow。
- 如果 `direct` 通过：移除 `disable-direct-composition`，恢复 Electron 默认合成路径。
- 如果 `no-shape` 通过：停止使用 `setShape`，将原生窗口物理裁剪到面板 union bounds。
- 如果 `software` 通过：可提供“视频兼容模式”，只禁用 FloatingClock GPU，不修改浏览器设置。
- 如果全部失败：进入系统层排查，依次测试更新 Intel 驱动、停用 Oray 虚拟显示驱动、Chrome 关闭硬件加速和 Windows MPO 对照；一次只改一项。

## 注意

- `no-topmost` 模式中，点击 Chrome 后锁定面板可能被压到浏览器后方，这是预期诊断副作用。
- `no-shape` 模式可能让透明工作区继续参与整屏合成，仅用于判断 `setShape` 是否是触发器。
- 不建议在尚未完成上述 A/B 测试前修改 Windows MPO 注册表或同时更新多个驱动，否则无法定位根因。

## 移动窗口专项修复

- 已确认拖动开始时旧逻辑会临时把 overlay shape 扩大到整个工作区。即使面板本身很小，桌面大小的透明 Electron surface 仍会覆盖浏览器并触发视频合成异常。
- 拖动和缩放期间现改为按动画帧同步实际面板几何，仅保留 24 px 操作余量；交互结束后恢复 2 px 精确边界。
- 已移除面板外部大范围黑色阴影，避免透明窗口边缘表现为黑框。面板内部边线与小型菜单阴影保留。
- `direct-composition` 诊断模式在本机已确认会产生黑底和旧帧残影，不能作为正式运行模式。正式验证必须使用 `baseline`。

## 进度更新（2026-06-22）

- 最近一次修复已经把“拖动时临时扩展到整块工作区”的错误路径去掉，但用户复测后仍然会在移动窗口时看到浏览器视频模糊，黑色边框也仍然存在。
- 这意味着问题不再只由“拖动时扩大 shape”单点触发，至少还剩下一个更底层的合成条件没有排除。
- 当前下一步优先级是：在完全退出上一轮 Electron 实例后，先跑 `baseline` 复现，再单独切到 `no-topmost` 验证透明置顶窗口是否仍然是触发源。
- 如果 `no-topmost` 仍然失败，再继续按 `no-shape`、`software` 的顺序收敛，保持一次只改一个变量。
