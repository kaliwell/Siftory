# Alpha 7 本地 Windows 安装包

> 状态：当前  
> 更新日期：2026-10-27

执行身份：Codex / GPT-6，精确版本未公开，未使用子代理。

用户要求将[完整修复包合并后的源码](2026-10-27-complete-patch-integration.md)生成新安装器。版本从 `1.0.1-alpha.6` 升为 `1.0.1-alpha.7`，同步 package.json 和 lockfile，不修改依赖。

- 文件：`release/Siftory Alpha Online Setup 1.0.1-alpha.7.exe`。
- Windows x64 在线版，176164957 字节，约 168 MiB；不内置 AI 模型权重和外置 FFmpeg CLI。
- SHA256：`0303daad283dd4c8546f3a2a964948bfdefe91250f8c4db6c826dd5dc03cfcaa`；同目录提供 `.exe.sha256`。
- `npm run build:online` 通过，包含前端 checked build、类型检查、Electron 原生模块编译、固定资源验证、覆盖源码及运行资源检查。
- 打包资源检查 35 项必需资源齐全，NSIS 归档检查通过。ASAR 内版本为 Alpha 7，主进程代码含诊断处理器与副本记录事件，前端含独立任务页资源。
- 日志：`artifacts/alpha7-build.log`、`alpha7-resources.log`、`alpha7-archive.log`、`alpha7-package-version.json`。

本轮未执行覆盖安装、升级回退或真实图库推理验收；未启动安装器、修改现有应用数据或发布 GitHub。安装包未签名，仍为 Alpha 测试版。安装前退出旧版、按 [Alpha 数据备份规则](../../BACKUP_SAFETY.md)备份应用数据及原始素材，避免多个版本同时运行。
