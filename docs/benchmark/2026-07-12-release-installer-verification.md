# FloatingClock 安装包验证报告

> 状态：历史快照  
> 日期：2026-07-12  
> 最近更新：2026-07-13  
> 安装包：`release/FloatingClock Setup 1.0.0.exe`  
> 结论：构建与归档完整性通过，尚未在干净 VM 执行安装/卸载
> 替代文档：[2026-07-14 最新安装包验证](2026-07-14-release-installer-verification.md)

## 构建链

执行：

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run smoke:ui:packaged
npm.cmd run smoke:installer:archive
```

结果：

- 完整测试：138/138。
- Native 正确性：29/29。
- Electron ABI native rebuild：通过。
- Renderer、main、preload、worker 构建：通过。
- NSIS 构建：通过。
- `win-unpacked` GUI smoke：5/5 面板，0 console error，5,937 ms。
- `verify`：typecheck、lint、format check、完整测试和 Renderer build 全部通过。

## 安装包信息

- 文件：`FloatingClock Setup 1.0.0.exe`
- 大小：603,696,333 bytes（575.73 MiB）
- SHA-256：`9B6BEB48960D0BC1ADFC7D1368619EADFB7305AC86CEB7418CAD278DE0D51C1C`
- Authenticode：`NotSigned`
- 应用图标：electron-builder 默认 Electron 图标

相较 766.93 MiB 审计基线，安装包减少约 191.20 MiB（24.9%）。打包白名单排除了 legacy 重复 CLIP visual 和 Darwin、Linux、Windows ARM64 ONNX Runtime；DINO、CLIP visual/text、FFmpeg、FFprobe 和 Windows x64 native addon 均保留并通过资源检查。

## 归档检查

新增脚本：

```powershell
npm.cmd run smoke:installer:archive
```

脚本使用 electron-builder 缓存中的 7-Zip 对 NSIS 可执行文件执行完整测试，并写入：

- `artifacts/installer-archive-smoke/report.json`
- `artifacts/installer-archive-smoke/7zip-output.txt`

结果：

- 归档文件：174。
- 退出码：0。
- 结果：`Everything is Ok`。
- 耗时：10,287 ms。
- `There are data after the end of archive` 是 NSIS 可执行封装尾部，已作为预期说明保留，不视为损坏。

## 安全边界

未在当前宿主机自动运行生产安装器。静默安装会写入 HKCU 卸载项并创建或覆盖桌面快捷方式，可能影响用户已有安装。安装、升级覆盖和卸载测试应在干净 Windows VM 或 Windows Sandbox 中执行。

归档和打包应用验证完成后，`release/` 已清理为只保留最终安装包；`win-unpacked`、blockmap 和 builder 元数据均已删除。

## 剩余发布项

1. 配置正式应用图标。
2. 确定代码签名证书与签名策略。
3. 在干净 VM 验证安装、首次启动、升级覆盖、卸载及快捷方式清理。

## 发布目录清理

`scripts/clean-release.cjs` 只在当前版本预期安装包存在时清理其他 builder 产物；若安装包缺失则直接失败，不删除已有文件。该行为已有自动测试。当前 `release/` 只保留：

```text
FloatingClock Setup 1.0.0.exe
```
