# 全局隐藏、恢复闪烁与鼠标穿透完整修复 TODO

> 状态：当前  
> 实施状态：核心修复与历史 500 轮自动化已验证；运行时诊断、真实快捷键占用恢复已验证；双窗口输入夹具重复验证不稳定，DWM 逐帧与其余实机矩阵继续跟踪  
> 更新日期：2026-09-24  
> 范围：Electron 全局快捷键、原生窗口可见性、Renderer 面板状态、窗口 Shape、鼠标穿透、拖动与缩放交互、UI 冒烟测试  
> 执行身份：Codex / GPT-6 系列；精确版本未公开（2026-09-24 增量）  
> 执行系统：Codex  
> 所有者：Codex/window_diagnostics（本次窗口专项）  
> 外部代理：外部运行时状态未知；本次仅修改独立 worktree  
> 文档入口：[项目文档索引](../README.md)  
> 相关历史：[2026-07-11 全局 Toggle 排查记录](2026-07-11-project-optimization-audit.md)  
> 替代文档：无

## 1. 修复前根因

问题不是单一的 Windows 显示异常，而是快捷键、原生窗口、Renderer、Shape 和鼠标穿透五套状态缺少统一事务边界：

1. 修复前代码和构建产物把 `Ctrl+Shift+Alt+Q` 注册为隐藏/恢复，把用户要求的 `Ctrl+Shift+Alt+R` 注册为面板吸附。
2. 恢复时先执行 `showInactive()`，再通知 Renderer 恢复面板和异步重建 Shape，原生窗口会先暴露空帧或旧帧。
3. `show` 事件和 `revealGlobalWindow()` 都执行置顶恢复，可能产生两次 `setAlwaysOnTop()` / `moveTop()` 和两次合成。
4. 隐藏路径没有无条件执行 `setIgnoreMouseEvents(true)`；隐藏前若处于面板交互状态，透明窗口可能继续拦截桌面点击。
5. 鼠标穿透依赖 50 ms 节流的 `mousemove`；快速移出面板后立即点击可能发生状态切换延迟。
6. 鼠标穿透 IPC 在成功前更新本地缓存并静默吞掉错误，单次失败后可能不再重试相同目标状态。
7. 普通面板拖动和缩放缺少 `blur`、`pointercancel`、`lostpointercapture` 清理；隐藏发生在交互中时可能留下永久的 active 状态。
8. 快捷键状态只检查一个组合键，部分注册失败可能被误报为整体可用；启动早期的一次性警告也可能在 Renderer 监听器安装前丢失。
9. 350 ms 时间去抖不能完整表达“按下一次只切换一次”；长按或系统重复键可能在去抖窗口后再次切换。

### 1.1 2026-08-29 实施结果

1. 全局隐藏不再改写或卸载 React 面板树，只执行原生安全隐藏；这消除了恢复时旧帧重挂和资源线性增长。
2. Renderer 隐藏后 `requestAnimationFrame` 会被 Chromium 节流，初版握手连续三轮均在约 917 ms 后进入超时回退。最终实现改用同步保留的面板树、两个可取消的 `MessageChannel` 布局任务轮次和强制布局读取，不再依赖隐藏页 rAF。
3. 主进程状态机为每次隐藏/显示分配 generation，旧 Shape 和鼠标 IPC 会被拒绝；隐藏事务固定为强制穿透、空 Shape、取消交互、原生隐藏。
4. `Ctrl+Shift+Alt+R` 已成为主隐藏键，`Q` 保留兼容，面板吸附迁移到 `P`；设置页展示逐项冲突。
5. 首轮 500 轮真实 Electron soak 全部完成：generation 从 2 单调增长到 1000，P95 显示 37 ms、P99 106 ms、最大 166 ms，显示时 14 个面板全部就绪。
6. 同一轮 soak 在强制 GC 后的 Renderer 资源差值为：documents `0`、listeners `0`、DOM nodes `0`、used heap `-286,596 B`；隐藏中断导航拖动也能自动清理。
7. 证据保存在 `artifacts/ui-smoke/zh-CN/report.json`。测试未关闭 360，也未添加安全软件排除项。
8. 用户实机继续观察到与按键次数有关的间歇闪帧，确认根因还包括 Windows/DWM 对透明顶层窗口表面的回收与重新挂载。正常快捷键路径现已完全取消原生 `hide/show`：隐藏时保持同一 HWND，透明度设为 0、Shape 置空并强制鼠标穿透；恢复时以 1% 透明度预热两个可见绘制帧，再一次性恢复用户目标透明度。
9. 常驻 HWND 初版在恢复后重新启用了 `backgroundThrottling`，Chromium 仍可能沿用透明遮挡状态，造成界面帧率偏低。现改为隐藏态启用节流、可见态明确禁用节流，并在真实 Electron 测试中加入可见 `requestAnimationFrame` 门禁。最终 500 轮结果：P95 21 ms、P99 31 ms、最大 59 ms；可见帧率约 145.8 FPS；资源差值无增长。

## 2. 目标与非目标

### 2.1 目标

1. 将 `Ctrl+Shift+Alt+R` 确立为隐藏/恢复的主快捷键，并为现有 `Q` 用户提供明确的兼容期。
2. 隐藏、恢复、第二实例唤起和 AI 控制窗口显示全部进入一个原生状态机。
3. 窗口只在 Renderer 面板布局和 Shape 准备完成后显示，消除两次闪烁和旧帧暴露。
4. 任何隐藏、准备显示、崩溃恢复和交互取消状态都必须允许桌面点击穿透。
5. 中断拖动、缩放、系统失焦、显示器变化、睡眠恢复和 Renderer 重载后均能自动恢复一致状态。
6. 提供有界、脱敏、可关联的诊断日志，能够区分快捷键冲突、状态超时、Shape 失败和穿透失败。
7. 不改变面板内容、位置、搜索任务、模型任务、索引状态和用户保存的可见面板集合。
8. 不降低现有启动、显示、拖动和面板操作性能。

### 2.2 非目标

- 不重写现有面板 UI，不改变搜索、建库、文件管理或模型功能。
- 不通过关闭透明窗口、关闭硬件加速、取消 always-on-top 或扩大整屏命中区域掩盖问题。
- 不依赖固定延时后盲目显示，不把 `setTimeout` 当作 Renderer 已完成布局的证明。
- 不关闭 360、不添加杀毒排除项，也不把快捷键冲突直接归因于 360。
- 不删除用户设置，不重置面板位置、锁定状态或显示器范围。

## 3. 固定交互契约

### 3.1 快捷键

| 快捷键             | 目标功能           | 兼容策略                                     |
| ------------------ | ------------------ | -------------------------------------------- |
| `Ctrl+Shift+Alt+R` | 隐藏/恢复全部界面  | 主快捷键，满足当前硬性需求                   |
| `Ctrl+Shift+Alt+Q` | 隐藏/恢复全部界面  | 保留一个正式版本作为兼容别名，设置页明确标记 |
| `Ctrl+Shift+Alt+P` | 将面板吸附回工作区 | 接替原来的 `R`，`P` 表示 Panels              |
| `Ctrl+Shift+Alt+S` | 显示全部面板       | 保持不变                                     |

每一个快捷键必须独立记录 `registered/conflicted/disabled`，不能再用单个 `Q` 的状态代表全部快捷键。

### 3.2 原生状态机

唯一允许的原生状态为：

```text
visible
  -> preparing-hide
  -> hidden
  -> preparing-show
  -> visible
```

状态机规则：

1. 每次转换分配单调递增的 `generation`；旧 generation 的迟到 ACK、Shape 和鼠标状态必须丢弃。
2. `hide`、`show` 和 `toggle` 均为幂等操作，不允许直接依据 `BrowserWindow.isVisible()` 推断业务状态。
3. `preparing-hide`、`hidden`、`preparing-show` 必须强制 `setIgnoreMouseEvents(true, { forward: true })`。
4. `hidden` 必须保持空 Shape；非当前 generation 的 Renderer IPC 不得恢复全屏或旧 Shape。
5. `preparing-show` 期间原生窗口保持隐藏；Renderer 保留原面板树，通过两个可取消的 `MessageChannel` 任务轮次和强制布局读取完成 Shape 测量后提交 ACK。
6. 主进程校验 ACK 和 Shape 后只调用一次 `showInactive()`；置顶恢复只保留一个调用入口。
7. 显示提交后再启用可见态鼠标命中策略，不允许先拦截桌面再等待 Renderer 修正。

### 3.3 Renderer 握手

建议新增或替换为有版本的契约：

```text
workspace-visibility:prepare-hide { generation, reason }
workspace-visibility:hidden-ready { generation }
workspace-visibility:prepare-show { generation, reason }
workspace-visibility:show-ready { generation, rects, visibilitySnapshotHash }
workspace-visibility:committed { generation, state }
```

`reason` 只允许枚举值，例如 `hotkey`、`second-instance`、`ai-control`、`settings`、`recovery`；不得包含用户文件路径。

## 4. 实施架构

### 4.1 主进程单一所有者

在 `electron/appCoreIpc.ts` 或拆出的 `electron/windowVisibilityController.ts` 中建立唯一控制器，持有：

- 当前状态和 generation；
- 最近一次有效非空 Shape；
- 当前鼠标穿透状态；
- 快捷键逐项注册状态；
- Renderer ACK 超时和故障恢复状态；
- 最近一次切换来源和耗时。

`revealGlobalWindow()`、`hide-window`、`show-window`、全局快捷键、第二实例和 AI Control 必须调用该控制器，不得分别维护布尔值。

### 4.2 显示顺序

1. 主进程进入 `preparing-show`，保持窗口隐藏并强制鼠标穿透。
2. 主进程发送带 generation 的 `prepare-show`。
3. Renderer 一次性恢复 `globalVisible` 和保存的面板可见状态。
4. Renderer 使用两个可取消的 `MessageChannel` 任务轮次确认 React 提交，再强制布局并测量 `.panel` 和 `[data-portal]`；隐藏页 rAF 仅能作为非阻塞快速路径，不能作为 ACK 前置条件。
5. Renderer 提交 `show-ready`；主进程拒绝越界、非有限、过多或旧 generation 的矩形。
6. 主进程应用 Shape，调用一次 `showInactive()`；`show` 事件不得再次重复执行相同置顶操作。
7. 主进程发送 `committed`，Renderer 启动正常鼠标命中检测。

不得使用先 `showInactive()` 再恢复 React 的旧顺序。

### 4.3 隐藏顺序

1. 主进程进入 `preparing-hide` 并立即强制鼠标穿透。
2. 向 Renderer 发送全局交互取消事件，清除拖动、缩放和 portal 捕获。
3. Renderer 保存一次面板可见性快照并确认 `hidden-ready`；超时不能阻止原生安全隐藏。
4. 主进程清空 Shape、隐藏窗口并进入 `hidden`。
5. 隐藏完成后任何旧 Shape、拖动帧和鼠标 IPC都因 generation 不匹配而被拒绝。

### 4.4 鼠标穿透

1. 将穿透状态抽成可测试的控制器，目标状态必须在 IPC 成功后才更新缓存。
2. IPC 失败必须记录有界错误、恢复为未知状态，并按指数退避进行有限重试。
3. 去掉固定 50 ms 盲区；使用每帧最多一次的检测，并在进入/离开面板、portal 和交互开始/结束时立即提交。
4. 在 `prepare-hide`、`visibilitychange`、窗口失焦、Renderer 卸载和错误边界恢复时强制穿透。
5. Shape 外部仍由原生窗口区域穿透；Shape 内透明 padding 必须由鼠标控制器及时释放，不能依赖 CSS `pointer-events: none` 让点击穿过其他原生窗口。

### 4.5 拖动与缩放

1. 用唯一 interaction token 代替可漂移的全局整数计数；重复释放必须幂等。
2. 优先统一为 Pointer Events 和 pointer capture。
3. 所有交互同时处理 `pointerup`、`pointercancel`、`lostpointercapture`、`window.blur`、全局隐藏和组件卸载。
4. 取消时清理 RAF、临时 transform、`will-change`、监听器和 pending position/size。
5. 保留最终位置提交语义；取消不得写入半帧位置或改变面板尺寸。

### 4.6 故障恢复

- Renderer ACK 超时：保持穿透，使用最近一次通过校验的非空 Shape进行一次受控恢复，并立即请求重新同步；不得恢复整屏 Shape。
- Renderer 崩溃或 reload：状态回到 `hidden` 或安全准备态，清除所有 interaction token。
- Shape IPC 失败：不显示不可交互整屏窗口；保留诊断状态并允许快捷键再次恢复。
- 快捷键冲突：其他成功注册的快捷键继续工作，设置页逐项显示冲突并提供重新注册。
- 睡眠/唤醒和显示器变化：废弃旧 generation，重新计算工作区和 Shape后再显示。

## 5. 完整任务队列

状态只能使用 `待做`、`进行中`、`已验证` 或 `阻塞`；没有对应测试证据时不得写成 `已验证`。

| 顺序 | 任务 ID | 任务                                                                 | 执行系统 | 所有者 | 依赖                            | 状态   | 完成证据                                                             |
| ---: | ------- | -------------------------------------------------------------------- | -------- | ------ | ------------------------------- | ------ | -------------------------------------------------------------------- |
|    1 | WVC-001 | 固化快捷键契约：`R` 为主隐藏键、`Q` 为兼容别名、`P` 为面板吸附       | Codex    | Codex  | -                               | 已验证 | 源码、设置页、用户手册和专项测试一致                                 |
|    2 | WVC-002 | 建立逐快捷键注册结果、冲突原因、持久诊断快照和重新注册入口           | Codex    | Codex  | WVC-001                         | 已验证 | 2026-09-24：持久逐键状态、冲突/异常固定事件码、真实占用释放恢复 4/4 |
|    3 | WVC-003 | 抽取纯函数窗口状态机和 generation 规则                               | Codex    | Codex  | -                               | 已验证 | `window-visibility-state.test.cjs` 覆盖迁移、幂等与 stale generation |
|    4 | WVC-004 | 扩展共享 IPC 契约、preload 白名单和参数边界校验                      | Codex    | Codex  | WVC-003                         | 已验证 | 类型、preload 合约、generation 与 Shape 边界测试通过                 |
|    5 | WVC-010 | 建立主进程 `WindowVisibilityController`，统一所有显示/隐藏入口       | Codex    | Codex  | WVC-003,WVC-004                 | 已验证 | 快捷键、设置、第二实例和 AI Control 进入同一状态机                   |
|    6 | WVC-011 | 实现 Renderer `prepare-show/show-ready/committed` 握手               | Codex    | Codex  | WVC-004,WVC-010                 | 已验证 | 常驻 HWND；Shape ACK 后以 1% 透明度预热，两个绘制帧后一次性显现      |
|    7 | WVC-012 | 为 Shape 提交增加 generation、串行化、最后有效快照和超时恢复         | Codex    | Codex  | WVC-010,WVC-011                 | 已验证 | 旧 generation 被拒绝；500 轮 Shape 与显示 generation 单调一致        |
|    8 | WVC-013 | 删除重复置顶与重复显示调用，确定唯一 `showInactive()` 提交点         | Codex    | Codex  | WVC-010,WVC-011                 | 已验证 | 删除 `show` 事件重复置顶；提交函数幂等                               |
|    9 | WVC-014 | 实现安全隐藏事务：先穿透、取消交互、空 Shape，再隐藏                 | Codex    | Codex  | WVC-010,WVC-012                 | 已验证 | 正常路径不调用原生 hide；透明度 0、空 Shape 与交互取消已验证         |
|   10 | WVC-020 | 重构鼠标穿透控制器，成功后提交状态、失败可重试、移除 50 ms 固定盲区  | Codex    | Codex  | WVC-010                         | 已验证 | 每帧检查、成功后提交、指数退避与隐藏强制穿透已覆盖                   |
|   11 | WVC-021 | 补齐面板拖动/缩放的失焦、隐藏与卸载取消路径                          | Codex    | Codex  | WVC-020                         | 已验证 | 500 轮专项含隐藏中断导航拖动，最终 interaction 清零                  |
|   12 | WVC-022 | 为快捷键长按/重复触发建立一次按压语义或等价状态保护                  | Codex    | Codex  | WVC-001,WVC-010                 | 已验证 | 滑动重复抑制每次重复均更新时间戳，状态机同时保证幂等                 |
|   13 | WVC-023 | 增加有界脱敏事件日志与状态诊断快照                                   | Codex    | Codex  | WVC-002,WVC-010,WVC-020         | 已验证 | 2026-09-24：128 条固定字段环形事件、异步原子快照、写失败恢复与退出 drain |
|   14 | WVC-030 | 增加状态机、快捷键冲突、stale ACK、超时和重复事件单元测试            | Codex    | Codex  | WVC-003,WVC-022                 | 已验证 | 2026-09-24：18 项状态/行为/持久测试；双 Electron 进程真实占用 R/Q/P/S 各一次 |
|   15 | WVC-031 | 增加 Renderer 面板恢复、Shape 测量、穿透重试和交互取消测试           | Codex    | Codex  | WVC-011,WVC-012,WVC-020,WVC-021 | 已验证 | 专项 8/8 与真实 Electron 交互取消通过                                |
|   16 | WVC-032 | 建立真实 Electron 双窗口点击穿透与逐帧显示冒烟测试                   | Codex    | Codex  | WVC-013,WVC-014,WVC-031         | 进行中 | 2026-09-24：夹具首轮 12 点击/12 源像素通过，重跑输入未稳定到达 DOM；1000 次/DWM 逐帧未验 |
|   17 | WVC-033 | 覆盖多显示器、DPI、睡眠恢复、第二实例、always-on-top 和 360 在场环境 | Codex    | Codex  | WVC-023,WVC-032                 | 进行中 | 本机多屏 4480×1392、DPI 1、360 未改配置通过；其余矩阵待补            |
|   18 | WVC-034 | 执行 500 轮显示/隐藏与隐藏中断交互 soak，验证资源和状态稳定性        | Codex    | Codex  | WVC-030,WVC-031,WVC-032,WVC-033 | 已验证 | 500/500；P95 21 ms、P99 31 ms；可见约 145.8 FPS；资源增长均为 0      |
|   19 | WVC-035 | 完成类型、Lint、专项、UI、完整 verify、文档和打包前门禁              | Codex    | Codex  | WVC-034                         | 已验证 | 完整 `npm.cmd run verify` 退出码 0；文档与构建预算门禁通过           |

## 6. 预计修改文件

| 文件                                                   | 修改范围                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `electron/appCoreIpc.ts`                               | 移除分散的隐藏状态和重复 show/置顶逻辑，接入统一控制器                 |
| `electron/windowVisibilityController.ts`               | 新增原生状态机、generation、超时恢复、逐项快捷键状态和诊断             |
| `electron/main.ts`                                     | 统一窗口生命周期、显示器变化、第二实例、睡眠恢复和唯一置顶入口         |
| `electron/preload.ts`                                  | 暴露受限的可见性握手与诊断 API                                         |
| `shared/ipc/app-core.ts`、`shared/ipc/electron-api.ts` | 增加状态、reason、generation、Shape 和快捷键状态类型                   |
| `src/App.tsx`                                          | Renderer prepare/ACK、保留面板树、布局任务轮次和 generation Shape 同步 |
| `src/hooks/useMouseTransparency.ts`                    | 成功后提交、失败重试、立即转换和可见性清理                             |
| `src/components/DraggablePanel.tsx`                    | token 化 Pointer Events、失焦/取消/隐藏清理                            |
| `src/components/WorkspaceNavigator.tsx`                | 复用统一交互 token 和取消逻辑                                          |
| `src/components/SettingsPanel.tsx`                     | 新快捷键说明、逐项状态和冲突提示                                       |
| `tests/*window-visibility*`                            | 状态机、Renderer、真实 Electron、穿透和逐帧冒烟测试                    |
| `docs/reference/user-manual.md`                        | 更新快捷键、恢复方式和冲突诊断说明                                     |

## 7. 验收矩阵

### 7.1 功能与交互

| 场景                       |        轮数 | 通过条件                                           |
| -------------------------- | ----------: | -------------------------------------------------- |
| 正常隐藏/恢复              |         100 | 每次一按一切换；面板集合、位置、大小和任务状态不变 |
| 长按主快捷键               |          20 | 每次物理按压最多切换一次，不发生隐藏后自动恢复     |
| 快速连续独立按键           |          50 | 状态按独立按压有序切换，无丢失或双触发             |
| 隐藏发生在拖动/缩放中      |        各50 | 无卡住 interaction、无面板跳位、背景可点击         |
| 面板外快速移动后立即点击   |        1000 | 背景哨兵窗口接收100%预期点击                       |
| Renderer reload/崩溃恢复   |          20 | 安全穿透，无整屏透明拦截，能够再次显示             |
| 快捷键部分冲突             | 每个组合1组 | 设置页逐项准确显示，未冲突快捷键继续可用           |
| 第二实例和 AI Control 显示 |        各20 | 与主快捷键使用同一状态机，不闪烁、不重复置顶       |

### 7.2 显示质量

- 每个 generation 的原生 `show` 计数必须等于 1。
- `show` 前必须存在同 generation 的有效 `show-ready`，超时恢复必须明确标记。
- 逐帧采样不得出现空透明工作区、旧面板帧、全屏 Shape 帧或第二次置顶跳变。
- 显示请求到稳定可见 P95 不高于 120 ms，P99 不高于 200 ms；如果当前真实基线更低，则不得回退超过5%。

### 7.3 稳定性和性能

- 500轮后状态必须为预期值，interaction token、未决 ACK、Shape 请求和重试定时器均为0。
- Renderer listener、主进程句柄和定时器不得线性增长。
- 隐藏态 CPU 不增加常驻轮询；可见态命中检测每动画帧最多一次。
- 恢复后的可见 `requestAnimationFrame` 实测不得低于 30 FPS。
- 面板拖动、缩放和显示延迟不得比同机修复前 P95 回退超过5%。
- 真实测试保留360运行，不改变其实时防护设置。

## 8. 验证命令

当前自动化结果：

| 命令                                  | 结果                                         |
| ------------------------------------- | -------------------------------------------- |
| `npm.cmd run typecheck`               | 通过                                         |
| `npm.cmd run lint`                    | 0 错误；3 条与本专项无关的既有未使用变量警告 |
| `npm.cmd run test:window-visibility`  | 8/8 通过                                     |
| `npm.cmd run test:preload-contract`   | 2/2 通过                                     |
| `npm.cmd run test:settings`           | 66/66 通过                                   |
| `npm.cmd run test:ui-smoke-contract`  | 31/31 通过                                   |
| `npm.cmd run build:renderer:checked`  | 通过，构建预算无错误                         |
| `npm.cmd run smoke:window-visibility` | 500/500 通过；P95 21 ms、P99 31 ms、约 145.8 FPS，资源差值无增长 |
| `npm.cmd run verify`                  | 通过；含 Native 重编译、75 项 Native 测试和生产构建门禁 |

已执行门禁：

```powershell
npm.cmd run typecheck
npm.cmd run lint
node --test tests/window-visibility-state.test.cjs
npm.cmd run test:ui-smoke-contract
npm.cmd run verify
npm.cmd run docs:check
```

已新增统一入口：

```powershell
npm.cmd run test:window-visibility
npm.cmd run smoke:window-visibility
```

## 9. 实施顺序与停止条件

1. 先完成 `WVC-001` 至 `WVC-004`，冻结契约和状态机测试，再修改真实窗口行为。
2. `WVC-010` 至 `WVC-014` 必须作为一个原生事务批次完成，避免产生只有一半状态机的中间版本。
3. `WVC-020` 和 `WVC-021` 同批验证；只改穿透而不清理交互状态不能关闭问题。
4. 专项测试通过后再执行真实 Electron 冒烟；冒烟不得使用真实用户数据目录。
5. 任何整屏透明点击拦截、面板状态丢失、位置变化或显示性能回退超过5%，立即停止并回退当前候选。
6. 只有 `WVC-035` 完成后才能把本文件状态改为`当前`或将任务标记为全部完成。

## 10. 完成定义

本专项只有同时满足以下条件才算完成：

- `Ctrl+Shift+Alt+R` 在源码、设置页、用户手册和构建产物中均为主隐藏/恢复快捷键。
- 正常、快速、长按、拖动中断、缩放中断、失焦、睡眠恢复、第二实例和 AI Control 全部使用同一状态机。
- 显示阶段不存在先显示原生窗口、后恢复面板和 Shape 的顺序。
- 隐藏及异常状态始终允许桌面点击穿透。
- 每个显示 generation 只有一次 show 和一次置顶恢复。
- 逐项快捷键冲突能够被持久、准确、可恢复地展示。
- 500轮 soak、1000次背景点击和逐帧闪烁检查通过。
- 类型、Lint、专项测试、UI、完整 verify 和文档检查全部通过。
- 没有修改搜索、模型、索引、文件管理和用户素材行为，也没有降低现有性能门禁。

## 11. 2026-09-24 增量验证

本次执行系统为 Codex，GPT-6 系列，精确版本未公开；所有者为 `Codex/window_diagnostics`。只在独立窗口专项 worktree 修改，不变更原工程现场、Git 暂存区或真实用户数据。前文 2026-08-29 的 500 轮、完整 `verify` 和性能数字为历史证据，本轮没有重跑这些长程验收。

### 11.1 运行时诊断与恢复

- `electron/windowVisibilityDiagnostics.ts` 持有最多 128 条事件，记录固定事件码、generation、状态、枚举来源、快捷键 ID、Shape 数量与穿透布尔值；未知字段和任意文本一律不进入快照。逐键最终状态单独保留，不因环形事件淘汰而丢失。
- 快照写到用户数据目录的 `diagnostics/window-visibility.json`，每个活动写入周期最多一次合并写，先临时文件再原子替换；只保留当前快照。写入失败不抛回窗口流程、不输出系统错误路径，后续事件或显式 flush 可重试；无活动时不建立循环重试。
- 已有 `will-quit` 异步收尾加入诊断 drain；快照序列化与磁盘写入串行，退出时排空最后一版。强制结束进程不保证最后一秒事件已持久化。
- 逐键注册返回失败与抛异常分别记录 `hotkey-conflicted`/`hotkey-failed`，其余快捷键继续注册。成功注册、禁用、重复抑制、迁移、超时、迟到 ACK、Shape 和鼠标失败均有固定事件码。
- 修正此前设计对空 Shape 的描述：[Electron 的 `setShape([])` 会恢复矩形窗口](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental)，不代表零像素区域。无有效历史 Shape 的超时恢复现保持透明度 0 和穿透，等待合法 Shape/迟到 ACK；有有效 Shape 才能回退显现。超时回调中的原生错误也不会逃逸成未捕获异常。

### 11.2 自动化证据

| 命令 | 本轮结果与边界 |
| --- | --- |
| `node --test tests/window-visibility-state.test.cjs tests/window-visibility-integration.test.cjs tests/window-visibility-diagnostics.test.cjs tests/window-visibility-runtime.test.cjs tests/preload-contract.test.cjs tests/ui-smoke-contract.test.cjs` | 31/31 通过，其中窗口专项 18 项；包括真实文件系统失败/恢复、并发 flush、异常注册、迟到 ACK 与原生超时异常 |
| `node tests/window-visibility-electron-smoke.cjs` | Electron 42.8.0，两独立进程依次抢占 R/Q/P/S，生产注册函数 4/4 识别冲突、释放后恢复，其他键维持基线；退出快照 73 条事件 |
| `node tests/window-visibility-desktop-smoke.cjs` | Windows、DPI 1；首轮 4 轮/12 次点击与 12 次源像素匹配，最终重跑失败：自有 HWND 命中且 `SendInput` 成功，但 DOM 无 down/up/click，原因未定；仅保留为显式运行的诊断夹具，不接入自动 verify |
| `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --tsBuildInfoFile artifacts/window-typecheck.tsbuildinfo` | 通过；增量缓存留在独立工作树，不写共享依赖目录 |
| 改动 TypeScript/CJS 文件的 ESLint、Prettier 检查 | 通过 |

真实快捷键报告为 `artifacts/window-visibility/shortcut-conflicts.json`，桌面报告为 `artifacts/window-visibility/desktop-smoke.json`。桌面输入助手在每次点击前通过窗口句柄、进程 ID 与 `WindowFromPoint` 校验目标只能是两个夹具窗口；出现第三方窗口立即拒绝输入。只采样自建页面内容，不截取桌面或用户素材。两个临时用户目录均在测试后删除；没有修改系统执行策略、杀毒配置或现有用户配置。

`WVC-032` 继续为“进行中”：一次 12/12 点击通过不能替代重复稳定性；最新报告保留输入未到达 DOM 的失败，不自动重发点击或转为通过。夹具只打开自有窗口并限制输入接收进程，无外部窗口输入；仍需确定 Windows 输入注入/激活链路的失败原因。本次未覆盖 1000 次快速移出立即点击、完整 React 交互或显示器组合；`capturePage` 源像素不包含 DWM 合成帧，成功报告明确记录 `compositorFrames: not-captured`，不作为全帧无闪烁证据。`WVC-033` 的睡眠恢复、其余 DPI 和第二实例等矩阵继续待真实环境验收。
