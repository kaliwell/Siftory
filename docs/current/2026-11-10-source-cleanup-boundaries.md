# 派生数据删除入口的边界与命名

> 状态：当前  
> 更新日期：2026-11-10  
> 范围：`src/components/ImageSearchDataManager.tsx`、`src/components/SourceDerivedDataCleanup.tsx`、`src/components/SettingsPanel.tsx`、`src/components/WorkspaceNavigator.tsx`、`src/components/ImageSearchPanel.tsx`、`src/components/MediaSearchPanel.tsx`  
> 替代文档：无（补充 [图片搜索指定文件夹多层索引编辑](2026-08-02-image-search-folder-index-editor.md) 的入口边界）

## 结论

排查后确认派生数据删除并非三个等价入口，而是三种不同作用域，因此**没有删除任何一套实现**，改为把边界写清并互相跳转：

| 入口 | 作用域 | 是否保留 |
| --- | --- | --- |
| 设置 → 清除图搜处理数据 | 全库重置（Native + 缩略图 + 日志 + DINO/CLIP） | 保留 |
| 设置 → 数据与重置 → 来源索引维护 | 按来源整体清理（图片各层 + 视频层 + 共享缓存） | 保留 |
| 索引与维护 → 图片索引总览 → 高级索引工具 → 文件夹索引编辑器 | 按文件夹、按层删除 Native/DINO/CLIP | 保留 |

原因是第三项支持**只删除某一层**（例如只重建 CLIP），而第二项是整源删除，两者不是严格的子集关系；该能力在 [2026-08-02 记录](2026-08-02-image-search-folder-index-editor.md) 中是刻意保留的高级维护操作，删除会造成能力回退。真正需要消除的是“用户不知道用哪个”的歧义。

同时处理了另一处命名冲突：导航里的「数据源」实际是图片搜索的**扫描目录**，与维护页「数据源与素材集」（Discovery 来源注册 + 素材集）不是同一概念。

## 改动

- 导航与页面标题：`Sources` 条目的显示文案改为「扫描目录」（新增 `Scan folders` 词条），`ImageSearchPanel` / `MediaSearchPanel` 在 sources-only 视图的标题同步改为「扫描目录」。内部 `label`、`data-testid`、路由与 `workspace-sources-focus` 事件保持不变。
- 文件夹索引编辑器新增一句范围说明，并提供「在设置中按来源清理」按钮：`openWorkspacePanel('settings', 'workspace-open-source-cleanup')`。
- 设置页新增 `workspace-open-source-cleanup` 监听：切换到「数据与重置」、展开并滚动到「按来源删除派生数据」区块。
- 「按来源删除派生数据」下方新增提示，指向 索引与维护 → 图片索引总览 → 高级索引工具 的单层删除。
- `i18n/core.ts` 新增 4 条词典项（扫描目录、两条范围说明、跳转按钮）。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npm.cmd run typecheck` | 通过 |
| Lint | `npm.cmd run lint` | 通过 |
| 格式 | `npm.cmd run format:check` | 通过 |
| 可见文案门禁 | `node scripts/check-visible-i18n.cjs` | 通过 |
| 专项测试 | `node --test tests/image-search-data-folders.test.cjs` | 53/53 通过 |
| 桌面浏览器 | `node tests/modern-desktop-browser.cjs` | 通过（3 视口、93 张截图） |
| 素材库浏览器 | `node tests/asset-library-browser.cjs` | 通过 |

新增断言：`image-search-data-folders` 校验编辑器链接到设置清理、设置页监听该事件、清理组件包含回指维护页的说明；桌面与素材库浏览器用例更新为新的「扫描目录」标题。

## 边界与未实施

- 跳转不预填来源路径：设置页仍由用户重新选择盘符/文件夹，避免跨面板传递路径的隐式状态。
- 彻底合并为“一个删除入口 + 作用域选择”未实施：需要给按来源清理增加按层/按类别勾选，属于后端预览计划与 IPC 契约的改造，会改变 `sourceDerivedData:execute` 的语义。若确认放弃单层删除，再单独评审。
- 导航改名只影响显示文案；已有测试 id、路由和自动化脚本不受影响。
