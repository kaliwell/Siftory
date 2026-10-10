# FloatingClock 最新安装包验证报告

> 状态：当前  
> 更新日期：2026-07-14  
> 范围：最新源码、`win-unpacked`、NSIS 安装包和 `release/` 交付目录  
> 替代文档：[2026-07-12 安装包验证报告](2026-07-12-release-installer-verification.md)

## 当前结论

包含以下最新功能的 NSIS 安装包已经生成并通过自动验证：

1. Image Search 和 Media Search 默认 Simple、可切换 Advanced。
2. 两个搜索面板的一键 `Prepare Library` 流程。
3. Image Search 固定 Large 结果布局，List 选项已移除。
4. 搜索结果虚拟化和此前完成的 P1 数据安全、模型下载与包体裁剪。

源码质量门禁、打包态 Electron UI 和安装包归档均通过。安装包仍未签名，也尚未在干净 Windows VM 执行安装、升级和卸载，因此发布就绪度仍受这两项约束。

## 构建与验证

| 项目             | 命令                                                       | 结果                                                       |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 完整源码门禁     | `npm.cmd run verify`                                       | 通过：143/143 tests                                        |
| NSIS 与 unpacked | `$env:FLOATING_CLOCK_KEEP_UNPACKED='1'; npm.cmd run build` | 产物生成完成；命令输出等待被用户中断，后续产物验证全部通过 |
| 打包态 UI        | `npm.cmd run smoke:ui:packaged`                            | 通过：5/5 面板、0 console error、8,972 ms                  |
| 归档完整性       | `npm.cmd run smoke:installer:archive`                      | 通过：176 个归档文件、`Everything is Ok`、5,816 ms         |
| 发布清理         | `npm.cmd run release:clean`                                | 通过：只保留安装包                                         |
| Authenticode     | `Get-AuthenticodeSignature`                                | `NotSigned`                                                |

打包命令耗时主要来自约 576 MiB 的模型、ONNX Runtime 和 FFmpeg NSIS 压缩。用户中断等待后，进程检查确认没有残留 `node`、`7za` 或 `makensis`；安装包、blockmap 和 `win-unpacked` 均已完整生成。随后 packaged smoke 和 7-Zip 归档校验直接验证了产物可加载且归档完整。

## 安装包信息

```text
File:          FloatingClock Setup 1.0.0.exe
Bytes:         603,920,601
Size:          575.94 MiB
SHA-256:       1D8A74FC2ADA9802D2670B13AD1C573DC95C5A764007188691D786CEFFAEA9DE
Archive files: 176
Signature:     NotSigned
```

与 2026-07-12 的 575.73 MiB 基线相比增加约 0.21 MiB，主要是最新 Renderer 和主进程代码变化；模型和跨平台运行库裁剪策略没有回退。

## 打包态 UI 证据

```text
Panels:                  5/5
Console errors:          0
Crashed panels:          0
Screenshot:              2560 x 1392
Non-transparent samples: 155,520
Image Search:            default Simple / Advanced visible / List absent / Simple restored
Media Search:            default Simple / Advanced visible / Simple restored
```

报告和截图位于忽略版本控制的 `artifacts/ui-smoke-packaged/`。

## 最终发布目录

执行 `npm.cmd run release:clean` 后：

```text
release/
└── FloatingClock Setup 1.0.0.exe
```

已删除 `win-unpacked`、blockmap 和 builder debug 元数据，满足“发布目录只保留一个安装包”的约束。

## 剩余发布风险

1. 在干净 Windows 11 VM 验证首次安装、覆盖升级、卸载和用户数据保留。
2. 配置正式产品图标。
3. 使用可信代码签名证书签署安装包和主可执行文件。
4. 记录 SmartScreen、杀毒软件和无管理员权限场景结果。

这些项目不影响当前开发版和归档完整性结论，但影响正式对外发布信任度。
