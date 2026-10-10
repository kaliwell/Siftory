# Siftory（寻藏）数据目录规范（Windows）

> 状态：当前
> 更新日期：2026-08-17
> 范围：Windows 用户数据、缓存与隔离测试目录
> 替代文档：无

日期：2026-08-01

## 唯一运行时数据根目录

应用所有受管理的可变数据都以 Electron 的 `app.getPath('userData')` 为根目录。Windows 正常
安装和开发运行时，该目录默认是：

```text
%APPDATA%\floating-clock-electron
```

`%APPDATA%` 指 Windows Roaming AppData。设置页的“打开应用数据目录”必须打开这个运行时
解析后的真实目录，不能拼接 `%LOCALAPPDATA%`、源码目录或固定用户名。UI smoke 可以通过
`FLOATING_CLOCK_UI_SMOKE_USER_DATA` 指向隔离临时目录；该变量只用于自动化验证，不是用户
数据迁移入口。

## 根目录内的数据归属

| 路径 | 类型 | 删除影响 |
| --- | --- | --- |
| `floating_clock_settings.json`、`clock_config.json` | 用户设置 | 设置恢复默认值 |
| `asset-library/`、`asset-library-backups/` | 权威素材元数据和备份 | 可能丢失分类、标签、审核结果或恢复点 |
| `remote-terminal-profiles.json`、`remote-terminal-credentials.json` | 远程连接资料 | 需要重新配置；凭据仍由 Electron `safeStorage` 加密 |
| `vector-db/`、`image-search-index/` | 搜索索引和派生向量 | 可重建，但重建耗时 |
| `thumbcache/`、`project-previews/` | 可重建预览缓存 | 首次浏览会重新生成 |
| `media-search/` | 媒体索引、抽帧和搜索派生数据 | 媒体搜索需要重建 |
| `image-search-queries/`、诊断日志 | 查询临时文件和诊断数据 | 不影响源文件，可按维护策略清理 |

应用内“存储占用”和“清理预览”使用同一 `userData` 根目录计算；任何清理都必须先展示精确
目标，并把权威数据、备份与可重建缓存分开。

## Local AppData 与工程目录

`%LOCALAPPDATA%` 下的安装文件、Electron/Chromium 缓存，以及开发工程中的 `node_modules/`、
`dist/`、`dist-electron/`、`release/`、`artifacts/` 都不是 Siftory 的用户数据根目录。
源码工程恰好位于 Local AppData 时，也不能据此把工程路径展示成“应用数据目录”。卸载、清理
构建产物或移动源码时，不应删除 Roaming 下的用户数据；反过来，应用内存储清理也不得扫描或
删除源码工程和安装目录。

本规范不进行 Roaming/Local 自动迁移。若未来要把大体积可重建缓存迁到 Local，必须另立迁移
版本，提供旧目录发现、空间预检、可恢复移动、回滚和跨版本兼容测试；在此之前，代码与文档均
以 `app.getPath('userData')` 的实际值为准。
