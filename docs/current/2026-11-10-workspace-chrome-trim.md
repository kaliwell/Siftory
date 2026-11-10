# 工作台页头与侧栏品牌精简

> 状态：当前  
> 更新日期：2026-11-10  
> 范围：`src/components/WorkspaceNavigator.tsx`、`src/components/DraggablePanel.tsx`、`src/styles/focused-workspace.css`、`src/styles/workspace-flow.css`、`src/styles/workspace-interface.css`  
> 替代文档：无

## 结论

按维护者要求移除界面上三处纯说明性文字，把空间还给内容：

1. 侧栏顶部品牌块（`Siftory 寻藏` 与 `本地素材工作台`）、随后单独保留的 `S` 图标，以及导航上方的「工作台」小标题；侧栏现在从「收起导航」直接进入「搜索 / 素材库 / 数据源」。
2. 停靠面板的整行页头（页面标题 `搜索`、`工作台` 眉标与页面说明），视觉高度 0；`h1` 与说明保留在 DOM 中并做无障碍隐藏。
3. 页头右侧的「本地运行」徽标。

结果：内容区上移约 54px，侧栏顶部节省约 50px；导航高亮仍是当前页面的主要指示。未改动任何功能、数据或 IPC。

## 改动

- `WorkspaceNavigator.tsx`：删除 `workspace-sidebar__brand`、`BRAND` 常量和导航上方的 `workspace-nav-label`（「工作台」）；侧栏首个子元素改为 `workspace-sidebar-toggle`，「管理」分组标签保留。
- `DraggablePanel.tsx`：停靠面板保留 `<header class="panel-header">`，但只承载无障碍标题；移除 `workspace-local-badge`。
- `focused-workspace.css`：页头改为 1×1 绝对定位的读屏专用块（`clip-path` + `overflow:hidden`，`min-height:0`）；删除品牌文字与 `S` 图标样式；侧栏上内边距 28px → 14px。
- `workspace-flow.css` / `workspace-interface.css`：删除已失效的页头高度、品牌与徽标规则，避免窄窗口媒体查询把隐藏页头重新撑高。
- `i18n/core.ts`：移除不再使用的 `Your local media workspace`、`Local processing` 两条词典项。
- `tests/workspace-theme-browser.cjs`：主题强调色取样从已删除的品牌图标改为 `[data-testid="image-search-query-image"]` 主按钮背景。
- `tests/modern-desktop-browser.cjs`：吸顶工具栏用例的窗口高度由 850 调整为 720。页头移除后，946px 宽度下视频索引页内容刚好不需要滚动，原用例等待的“必须溢出”条件不再成立；降低窗口高度后两条工作区仍真实滚动，断言意图不变。
- 页头移除后的间距整理：页签栏上内边距 4px → 14px、下 10px；停靠面板内容区 22/28 → 18/24/22，窄窗口 12/16 → 14/18/18；侧栏内边距 14/16 → 16/14，并去掉折叠按钮上方的 -12px 负边距。页签与内容左右都对齐到 24px。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npm.cmd run typecheck` | 通过 |
| Lint | `npm.cmd run lint` | 通过 |
| 格式 | `npm.cmd run format:check` | 通过 |
| 单元回归 | `node --test tests/focused-workspace.test.cjs tests/workspace-navigation.test.cjs tests/ui-smoke-contract.test.cjs tests/panel-window-controls.test.cjs tests/product-information-architecture.test.cjs tests/product-first-run-guide.test.cjs` | 53/53 通过 |
| 主题浏览器 | `node tests/workspace-theme-browser.cjs` | 通过（34 组调色板） |
| 桌面浏览器 | `node tests/modern-desktop-browser.cjs` | 通过（3 视口、93 张截图） |
| 素材库浏览器 | `node tests/asset-library-browser.cjs` | 通过 |
| 可见文案门禁 | `node scripts/check-visible-i18n.cjs` | 通过 |

浏览器用例需要本机 Playwright Chromium；本轮使用 `SIFTORY_TEST_CHROMIUM_PATH` 指向已安装的 `chromium-1248`。本地打包版另做界面截图确认：深色主题、侧栏从「收起导航」开始、内容区顶部直接是页签行。

## 边界

- 页标题、眉标与页面说明仍存在于 DOM 并保持读屏可读（1×1 裁切）；若后续需要可见标题，只需恢复页头样式。
- 未改动抽屉式（非停靠）面板的标题栏，也未改动侧栏底部版本号、任务入口与维护入口。
- 未做 100% 缩放以外的高 DPI 新截图；浏览器用例覆盖 1920/1320/946/760 四种宽度。
