# 跨来源素材收集篮实施记录

> 日期：2026-08-12
> 状态：当前
> 实施状态：代码实施完成

## 目标

参考 LAP Collections 的低摩擦整理方式，让统一搜索中的图片、视频、本地盘、挂载 NAS 和 SFTP 结果可以加入持久化命名集合，同时不复制、不移动原文件。

## 已实现

- Sources 统一搜索区新增素材收集篮，可创建、选择、删除命名集合，并一键收集/移除搜索结果。
- 本地盘和挂载网络来源在统一搜索投影时解析稳定 `AssetId`；相同 AssetId 重复加入会更新元数据快照而不是生成重复项。
- SFTP 不尝试伪造本地文件系统身份，安全回退到 Discovery Catalog 的稳定 `fileEntryId`，打开动作继续通过一次性下载授权和 Transfer Queue。
- 视频条目保存 `videoId` 和命中时间，重新打开时沿用既有 `openMediaAtTime` 受控动作；图片/本地文件通过稳定 AssetId 打开原件。
- 条目保存来源、路径、大小、修改时间和可用性快照，因此来源离线时仍能查看集合内容；实际动作由主进程重新校验。
- `asset-collections.jsonl` 和 `asset-collection-items.jsonl` 纳入资产库备份、验证、导出和恢复范围。
- 主进程对名称、AssetId、Catalog EntryId、来源枚举、文本和数值边界做校验；集合删除会级联清理引用，但不会删除原文件。
- 中英文界面文本、预加载合同、IPC 注册和 Electron smoke 合同均已扩展。

## 身份与动作边界

| 来源 | 持久引用 | 重新执行动作 |
| --- | --- | --- |
| 本地盘 | 稳定 AssetId | 主进程解析原始成员后打开 |
| 挂载 NAS | 稳定 AssetId | 在线时按 AssetId 打开；重挂载后沿用身份修复链路 |
| SFTP | Catalog EntryId | 重新签发短期下载授权后进入 Transfer Queue |
| 视频 | AssetId/EntryId + videoId + 时间点 | 通过 Media Search 受控时间点动作打开 |

## 自动化证据

- `npm.cmd run typecheck`
- `npm.cmd run test:i18n-static`：7/7 通过
- `npm.cmd run test:preload-contract`：2/2 通过
- `npm.cmd run test:ipc-registration`：7/7 通过
- `npm.cmd run test:ipc-validation`：4/4 通过
- `npm.cmd run test:asset-library`：135/135 通过（含收集篮 3 项）
- `npm.cmd run test:unified-search`：47/47 通过
- `npm.cmd run test:ui-smoke-contract`：7/7 通过
- `npm.cmd run format:check`、`npm.cmd run lint`、`npm.cmd run build:renderer`
- `node tests/electron-ui-smoke.cjs --panel=neko-search`：`collectionCrud: true`、`smartAlbumCrud: true`、7 个核心面板、0 崩溃、0 console error

## 后续增强

- 支持集合重命名、排序、批量加入和拖放加入。
- 在 Asset Library 与 Media Search 独立结果视图增加同一收集动作入口。
- SFTP/NAS 真实设备仍需在可控凭据下完成断线、重连和移动身份验收。
