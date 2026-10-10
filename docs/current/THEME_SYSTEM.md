# 主题系统

> 状态：当前
> 更新日期：2026-08-17
> 范围：主题预设、模式迁移、语义 token 与可访问性
> 替代文档：无

主题设置已从不稳定的数字索引升级为稳定的 `themeId`，并保留旧 `theme: 0..5` 的自动迁移。主题切换只写入设置文件，不修改图片索引、向量、素材库或搜索数据。

Settings → Appearance 提供四组预设：

- 经典：Matrix、Midnight、Amber、Frost、Mono。
- 柔和：Rose Night、Pearl Rose、Lilac Mist、Violet Night。
- 硬朗：Steel、Graphite、Deep Ocean、Forest Night。
- 中性：Paper、Slate、System Auto、High Contrast。

任何用户都可以选择任意预设；软件不会根据性别自动推断主题。模式可独立设为浅色、深色或跟随系统。选择预设会采用该预设的推荐模式，之后仍可手动覆盖。

界面统一使用 canvas、surface、text、border、accent、focus、success、warning、danger、selection 等语义 token。所有预设的正文和次要正文颜色均通过 WCAG AA 4.5:1 自动测试；High Contrast 还提供明显的键盘焦点轮廓。系统启用减少动态效果时，面板和按钮动画会关闭。

现有六套主题保持原名称和顺序，因此旧设置升级后外观不会突然变化。新增设置字段为：

```json
{
  "theme": 0,
  "themeId": "matrix-dark",
  "themeMode": "dark"
}
```

`theme` 仅用于旧版本兼容，新代码以 `themeId` 和 `themeMode` 为准。
