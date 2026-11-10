# 应用数据位置收敛为单一入口

> 状态：当前  
> 更新日期：2026-11-10  
> 范围：`src/components/StorageLocationSettings.tsx`、`src/components/AppStoragePanel.tsx`、`src/components/SettingsPanel.tsx`  
> 替代文档：无

## 结论

「应用数据位置」此前由同一个组件在 `索引与维护` 和 `设置 → 数据与重置` 各渲染一份，两份实例各自持有状态。现在只保留 `设置 → 数据与重置` 一份可编辑实现；维护页只显示当前目录摘要，并提供「在设置中修改」跳转。两个入口仍然都在，但只有一个能发起迁移，避免两份状态不同步和双重维护。

## 改动

- `StorageLocationSettings` 新增 `readOnly` 属性：
  - 只读模式仍显示当前根目录、保留的旧目录、上次迁移失败提示和外部缓存覆盖提示；
  - 不再渲染「选择新数据位置 / 重启并迁移」，改为 `storage-location-open-settings` 按钮，文案「在设置中修改」；
  - 点击后调用 `openWorkspacePanel('settings', 'workspace-open-storage-location')`，由既有的延迟路由机制保证设置面板挂载后再派发事件。
- `AppStoragePanel` 的区块 02 改为 `<StorageLocationSettings readOnly />`，描述改为「显示当前数据目录；迁移操作在设置中。」
- `SettingsPanel` 新增 `workspace-open-storage-location` 监听：切换到「数据与重置」分类、展开并滚动到数据位置控件。
- `i18n/core.ts` 新增「在设置中修改」和新的区块描述两条词典项。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npm.cmd run typecheck` | 通过 |
| Lint | `npm.cmd run lint` | 通过 |
| 格式 | `npm.cmd run format:check` | 通过 |
| 桌面浏览器 | `node tests/modern-desktop-browser.cjs` | 通过（3 视口、93 张截图） |
| 可见文案门禁 | `node scripts/check-visible-i18n.cjs` | 通过 |

`modern-desktop-browser` 新增断言：维护页数据位置区块不包含 `storage-location-choose`，点击 `storage-location-open-settings` 后设置面板的「数据与重置」可见，且可编辑实例包含 `storage-location-choose`。

## 边界

- 设置页的可编辑实例行为未变：迁移、重启、旧目录保留、失败提示均沿用原逻辑。
- 维护页仍会长按需查询一次 `storageLocation.getStatus()` 用于展示摘要；不再存在两个可编辑实例。
- 只读模式的按钮不做迁移前置校验（不阻塞点击），实际校验仍在设置页发起迁移时执行。

## 后续（未实施）

同类重叠仍在：派生数据删除有三个入口（全库清除 / 按来源删除 / 按文件夹删除 Native+DINO+CLIP）。本轮只处理数据位置，删除入口的收敛待单独确认。
