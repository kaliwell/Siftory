# Siftory · 寻藏

**Alpha 测试版 · v1.0.1-alpha.1 · Windows x64**

本地优先的图片、视频检索与素材管理桌面软件。收到同事或客户发来的参考图片后，把图片拖入寻藏，在自己已经建立索引的素材库中查找相似候选，再打开原文件或所在文件夹。

## 当前状态

本项目处于 Alpha 测试阶段，主要用于功能体验、问题反馈与开发协作。功能、界面、索引格式和兼容性仍可能调整。测试时建议使用素材副本，并先备份索引与应用数据。

首次运行或升级前，请阅读 [Alpha 数据备份与恢复规则](BACKUP_SAFETY.md)：退出应用后备份整个实际数据目录，原图片、视频及工程文件另行备份；Alpha 与旧版默认共享用户数据目录。

`1.0.1-alpha.1` 是当前维护版本；软件著作权登记提交的 V1.0.0 材料是历史记录，不随维护版本改写。当前版本号高于已有的 1.0.0，后续 Alpha 版本依次使用 `1.0.1-alpha.2`、`1.0.1-alpha.3`。

## 主要功能

- **以图搜图**：使用参考图片寻找本地图库中的相似图片。
- **文字检索**：通过自然语言、文件名等条件查找素材。
- **视频检索**：建立视频帧索引，检索候选帧并跳转到相关位置。
- **素材管理**：来源配置、分类、标签、预览、文件位置定位及结果导出。
- **索引维护**：增量扫描、来源状态检查、备份恢复和派生数据清理。

AI 模型由用户自行下载、安装或配置；源码仓库不包含模型权重、用户图库、运行数据库或安装包。模型与第三方组件各自适用其原有许可证。部分功能需要相应模型或工具准备完成后才能使用。

## 开发运行

需要 Windows x64、Git、项目锁定的 Node.js **24.16.0** / npm **11.13.0**，以及原生模块编译所需的 Python 和 Visual Studio C++ 构建工具。

```powershell
git clone https://github.com/kaliwell/Siftory.git
cd Siftory
npm ci
npm run build:native
npm run build:native:electron
npm run dev
```

先使用基础界面，再按功能配置模型、FFmpeg 等外部资源。资源清单见 [运行资源清单](resources/runtime-manifest.json)，操作说明见 [用户说明书](docs/reference/user-manual.md)。完整安装器的构建还需要对应资源与发行验收，不等同于上述开发运行命令。

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build:renderer:checked
```

这些命令针对桌面工程。完整 `npm run verify` 的视频测试还需要清单指定版本的 FFmpeg / FFprobe，手动准备至 `tools/ffmpeg/bin/`，并先执行下面的哈希验证；二进制不进入源码仓库。提交快照的完整验证会复制并再次核验这两个工具。完整许可证与资源测试还需要另行准备 `legal/covered-source/canvas-rust-sources.zip`，其哈希须匹配同目录清单；该第三方源码交付附件不进入普通源码提交，后续二进制分发仍须履行对应源码交付要求。

```powershell
npm run resources:fetch -- --verify-only --component=gyan-ffmpeg-full-8-1-2
```

GitHub 的 Windows CI 定义在 [.github/workflows/ci.yml](.github/workflows/ci.yml)，运行 `ci:verify:source` 检查类型、代码、文档、基础契约、构建和依赖安全；包含视频与原生模块的完整 `ci:verify` 保留给已准备运行资源的环境，不自动下载模型或 FFmpeg。Gitee 上可以使用同样的本地验证命令。

## 使用与源码授权

项目采用**公开源码、个人非商业使用免费、商业使用付费授权**的方向。公开源码不等于授予不受限制的商业使用或再分发权，也不代表项目采用 MIT、Apache-2.0 等通用开源许可证。

具体授权文本、商业授权取得方式和发行者信息仍待确定；当前 `package.json` 保持 `UNLICENSED`，未发布最终授权合同。详细状态见 [源码与授权说明](SOURCE_AVAILABILITY.md)。第三方组件的许可不受本项目授权方向替代，见 [第三方组件](THIRD_PARTY_COMPONENTS.md)、[Node 依赖清单](NODE_THIRD_PARTY_COMPONENTS.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。

## 问题反馈

在 GitHub 或 Gitee 的 Issues 中提供：版本号、Windows 版本、复现步骤、预期行为、实际行为，以及脱敏截图或日志。请先删除姓名、联系方式、账户、访问令牌和真实素材路径。模型相关问题请注明模型名称和 CPU/GPU 后端。

目前尚未提供正式稳定版保证；完整原生第三方清单、最终条款、签名和干净设备安装验收仍在准备中。

## 仓库上传

上传前先阅读 [GitHub / Gitee 仓库准备说明](docs/reference/repository-publishing.md)。现有本地 Git 历史和暂存区也需要检查，`.gitignore` 无法移除已经进入历史的文件。

开发文档入口：[docs/README.md](docs/README.md)。
