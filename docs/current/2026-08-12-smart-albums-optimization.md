# 智能相册优化实施记录

> 日期：2026-08-12
> 状态：当前
> 实施状态：代码实施完成

## 目标

将 Asset Library 已有的名称/路径、分类、标签、未分类、移除状态和排序条件保存为可复用的智能相册，形成“筛选 -> 保存 -> 一键恢复 -> 更新/删除”的最小闭环。

## 已实现

- 新增智能相册数据模型和受控 IPC：列表、创建、更新、删除。
- 规则直接复用 Asset Library 的分页查询条件，不复制资产记录，不建立第二套索引。
- 智能相册以 `smart-albums.jsonl` 持久化；名称去重，规则经过主进程边界归一化。
- Asset Library 资产视图新增智能相册栏，可保存当前条件、应用已保存条件、覆盖更新和删除。
- 中文/英文界面文本均进入现有 i18n 门禁。
- `smart-albums.jsonl` 纳入资产库元数据备份和恢复目标。

## 当前规则范围

- 文件名或路径查询
- 分类
- 标签
- 未分类资产
- 已移除资产
- 最近、名称、大小排序

后续扩展日期、来源、文件类型、评分、收藏时，应扩展统一 `AssetSmartAlbumRules`，继续复用 Asset Library 查询链路。

## 验收证据

- `npm.cmd run typecheck`
- `npm.cmd run format:check`
- `npm.cmd run test:i18n-static`
- `npm.cmd run test:asset-library`：132/132 通过
- `npm.cmd run test:ipc-registration`：7/7 通过
- `node --test tests/asset-smart-album.test.cjs tests/asset-library-list-request.test.cjs tests/preload-contract.test.cjs`：7/7 通过
- `npm.cmd run build:renderer`
- `npm.cmd run smoke:ui -- --panel=neko-search`：`smartAlbumCrud: true`，7 个核心面板、0 崩溃、0 console error

## 第二阶段进度

- 已完成来源（图片索引/手动导入）、媒体类型（图片/视频帧）和修改日期范围筛选。
- 新规则贯通 Asset Library JSONL 回退与 SQLite Catalog 快速查询，并可由智能相册保存、恢复和更新。
- 评分与收藏已补充权威元数据、事务、批量操作及智能相册规则，自动 TODO `VAL-102` 已完成。
