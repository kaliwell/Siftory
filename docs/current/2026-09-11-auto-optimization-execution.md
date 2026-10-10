# 首版收尾自动优化执行记录

> 状态：当前  
> 更新日期：2026-09-11  
> 范围：VAL-901～910 的自动工程与验收准备工作  
> 执行系统：Codex  
> 所有者：Codex/root；本轮未使用代理  
> 工作区：`feat/phase3-staged-index-unified-search`，未提交现场  
> 参考 HEAD：`4be3326240edeaec667730a963bddb7ea6a3e1e2`  
> 替代文档：无

## 1. 当前结果

用户已于 2026-09-11 授权开始自动优化。VAL-901～910 已验证：完成首版能力盘点、归档方案与真实验收材料，修复 BAT 绕过受检构建的问题，统一解码依赖导入与单文件子进程构建，补齐备份异常输入覆盖；全量工程、关键覆盖率、中英文桌面与播放器均通过。后续真实环境与发布任务未完成。

## 2. 实际改动

- `build.bat`、`build-installer.bat`：改用 `call npm.cmd run build -- %*`，保留参数和退出码。由既有 `scripts/build.cjs` 统一执行受检构建、类型检查、Electron Native 构建、资源校验和 profile 打包；不直接拿旧 dist 运行打包器。
- `electron/embeddingDecodeBudget.ts`、`electron/dinoImageDecode.ts`：与 CLIP 一致使用动态 Sharp 导入，保留快速头探测、元数据回退、像素/字节预算、EXIF 方向和损坏图拒绝语义。
- `vite.config.mjs`：CLIP/DINO 子进程设置 `inlineDynamicImports`，把依赖封装进单独复制到 resources 的入口文件，避免缺失兄弟 chunk；最终构建不再出现 Sharp 混合导入警告。发行构建的内联模块可能提前初始化，因此不宣称启动时间或内存改善比例。
- 构建回归在独立临时项目用 npm 替身验证 BAT 的工作目录、offline 参数转发与失败码 17，不执行真实安装打包。
- 图像回归增加 TIFF 元数据回退，并沿用 CLIP 像素一致性、EXIF、损坏输入与解码预算用例。
- `tests/asset-library-backup-portable.test.cjs`：增加非法 KDF 参数、重复清单项、路径越界、字节汇总篡改、backupId 认证绑定与失败后无明文残留测试，并验证恢复原清单后仍能正常导入。
- [范围与源码方案](2026-09-11-v1-scope-and-source-inventory.md)及[真实验收材料包](2026-09-11-release-acceptance-packet.md)提供本轮规划任务的可审查产物。

## 3. 验证记录

原始日志与前态文件保存在 `artifacts/release-completion-20260911/`，属于本机产物。普通 npm notice 被 PowerShell 重定向成 `NativeCommandError` 文本时，以子命令真实退出码、测试失败项和完整日志判断，不把 notice 当作失败。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 构建/解码针对性测试 | 通过，18/18，无跳过 | `focused-tests.log` |
| 解码与备份新增回归 | 通过，22/22，无跳过 | `backup-dino-tests.log` |
| 全量 verify | 通过，退出码 0；累计测试执行 2113，2108 通过、5 跳过、0 失败 | `verify-final.log`、`verify-final.exit` |
| 首轮关键覆盖率 | 失败：备份分支 69.81% < 70%；保留原阈值后补行为测试 | `coverage.log` |
| 最终关键覆盖率 | 通过，126/126；行 86.59%、分支 76.83%、函数 85.50%；备份分支 73.72% | `coverage-final.log`、`coverage-final.exit`、`artifacts/coverage/critical-summary.json` |
| 构建配置最终复核 | 全量 verify 后只增加子进程内联构建配置；架构通过，构建相关回归 16/16，受检构建通过、无 Sharp 导入警告 | `build-contracts.log`、`build-final.log`、`build-final.exit` |
| 独立子进程启动 | 两个入口单独复制到临时目录均退出码 0，收到 ready 帧，无兄弟 JS 导入 | `standalone-children.json`；使用已安装依赖，非安装包推理验收 |
| 中文 UI | 通过，14/14 面板、0 console error、3 次隐藏恢复 | `ui-zh-CN.log`、`ui/ui-smoke-t4J7WN/report.json`及截图 |
| 英文 UI | 通过，14/14 面板、0 console error、3 次隐藏恢复 | `ui-en.log`、`ui/ui-smoke-QCCK9a/report.json`及截图 |
| 播放器 | 通过；合成视频、定位、循环、逐帧与导出入口 | `media-player.log`、`media-player.exit` |
| 性能编排计划 | 通过，只读 plan；未执行正式高负载 | `performance-plan.log` |
| TODO 与文档校验 | 通过，20 项依赖与状态合法，文档结构及相对链接通过 | `node scripts/next-value-optimization-task.cjs docs/current/2026-09-11-release-completion-todo.md --check`、`npm.cmd run docs:check` |

全量计数是各命令报告的累计执行量，含重复执行的用例，不代表独立测试数量。5 项跳过分别为 Windows 链接权限相关 2 项、仅适用于 POSIX 的权限检查 1 项、缺少 CUDA parity fixture 配置 2 项。未将这些跳过视为覆盖证明。

验证顺序：运行时与测试最终修改完成后执行 `verify-final` 和 `coverage-final`；其后仅增加构建配置的内联选项，重新执行架构、16 项构建/协议测试、受检构建及单文件子进程启动。UI 验证覆盖本轮运行时与 Renderer，最终配置变更仅影响子进程封装，独立启动检查补足该变化的验证边界。

## 4. 提交边界与剩余项

现有历史改动尚未完成归属确认，本轮未暂存、提交或覆盖暂存区。修改前保存本轮目标文件副本，源码变更清单记录路径与摘要。后续独立归档时须对本轮增量与先前改动分开审查。

正式准确率、三轮与长时间性能、真实设备故障、代码归档、最终政策与签名、干净机器安装和正式发布仍由收尾 TODO 对应任务约束。工程自动测试通过不替代这些结果。
