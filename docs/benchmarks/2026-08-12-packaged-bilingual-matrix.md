# Online/Offline 打包与双语验收矩阵

日期：2026-08-12

任务：`VAL-110`

## 结论

当前导航和功能已进入 Online、Offline 两种 Windows 安装包，并在 `zh-CN`、`en` 两种启动语言下完成真实 packaged Electron 烟测。四个组合均挂载 8 个要求面板、无崩溃、无 console error，且 native addon 来自安装包 resources。

| Profile | 安装包 | 字节数 | SHA-256 | 资源 | zh-CN | en |
| --- | --- | ---: | --- | ---: | --- | --- |
| Offline | `FloatingClock Setup 1.0.0.exe` | 709,113,966 | `90d19062f3f380e5147ffd0a561b36ad7e10a6d4c8f6ee7f25544065588b595f` | 27/27 | 8 面板，0 error | 8 面板，0 error |
| Online | `FloatingClock Online Setup 1.0.0.exe` | 169,106,914 | `663e4e6a5149fef60d0725aa484079b47f8a5741833e038d89f45a7562eff47f` | 22/22 | 8 面板，0 error | 8 面板，0 error |

Offline 的 DINO、CLIP、多语言文本模型、FFmpeg 与 FFprobe 均位于 packaged resources；Online 明确不捆绑这些重量级资源，保留 native addon、运行时清单、worker 和法律材料等 22 项核心资源。两种 profile 都未出现旧版重复资源路径。

## 自动化

完整复验命令：

```powershell
npm.cmd run validate:packaged:matrix
```

该命令按 profile 构建并保留两个不同名称的安装器，校验资源，然后分别运行中英文 packaged smoke。报告按 profile/locale 隔离，最终汇总在 `artifacts/packaged-validation/report.json`。中断后可用 `--profile=<offline|online> --skip-build` 续验已构建 profile；`--collect-only` 只验证并汇总现有证据，不启动构建或应用。

本次另行通过矩阵契约测试、TypeScript、ESLint、Prettier 与 TODO 结构检查。安装包和运行报告位于 git 忽略的 `release/`、`artifacts/`，不会被误提交。

## 发布边界

这些是未签名的技术验收构建，不代表正式发行授权。EULA、第三方再分发批准、正式签名和发布决策仍由 `VAL-115` 显式阻塞；本任务未修改相关批准状态。
