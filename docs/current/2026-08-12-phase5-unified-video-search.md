# Phase 5 统一视频搜索实施记录

> 状态：部分实施
> 实施状态：代码实施完成，真实视频集验收待外部样本
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md` 第 9、11.4、14 节
> 分支：`feat/phase3-staged-index-unified-search`

## 本轮切片：统一原视频结果与时间点

- Media Search 完成视频扫描后，批量为非 missing 原视频建立稳定 `AssetId`；批量接口只原子写入一次 `asset-identities.jsonl`，重复扫描不新增身份。
- 已注册本地或 mounted-network 来源下的视频会投影到 Discovery Catalog，并补记 D2 `metadata-ready:ready`；投影使用来源内最长根路径匹配，重复投影保留原 `fileEntryId`。不在已注册来源中的视频保留在 Media Search manifest，并在任务完成消息中明确计数，不暗自创建来源。
- 统一搜索新增 `video-frame` 与 `subtitle` lane，直接复用现有 CLIP 帧检索、字幕 BM25 与 D5 调度，不重写 Media Search 算法和派生存储。
- 同一视频的多个画面/字幕命中聚合为一个权威 Catalog 结果；卡片显示原视频路径、来源、大小、时长，并保留最多 8 个按分数排序的命中时间点。每个 lane 只用最强分数参与总分，避免一个长视频因抽帧多而堆叠刷高排名。
- 结果中的 `assetId` 来自稳定身份只读查询，`videoId`/时长来自 Media Search manifest；Renderer 通过现有 `openMediaAtTime({ videoId, timestampMs })` 动作打开，不回传展示路径作为授权。
- 前 12 个统一视频结果会按视觉命中的 `frameId` 请求代表帧预览；主进程只接受 40 位 SHA-1 标识，从权威帧 manifest 反查 `done` 记录，再复用缓存根目录、realpath 防链接逃逸和 1 MiB 大小限制读取图片。Renderer 不提交或持有帧缓存路径，预览内存缓存最多保留 100 项。
- 当前系统播放器动作仍只能打开视频文件，`timestampMs` 是已验证并保留的命中信息，尚未承诺外部播放器精确 seek。

## 退化与数据边界

- 视频帧未建立、字幕未提取时分别报告 `index-stale`；模型或 embedding 不可用报告 `model-missing`；任务错误报告 `task-failed`。Catalog 元数据结果仍正常返回。
- SFTP 远程视频目前只有 metadata-only 目录和按需图片预览，不会自动取回原视频做抽帧；因此本轮不会制造远程视频的虚假 AI 命中。远程视频抽帧/缓存/带宽策略仍是下一切片。
- Media manifest 现持久化匹配到的统一 `sourceId/sourceType`。本地视频继续使用 3 秒间隔、最多 3600 帧、384px 的高召回策略；mounted-network 默认降为 15 秒间隔、最多 240 帧、256px，并按单个视频合并为一个 FFmpeg 进程、网络视频单并发且禁用硬件解码重试，以限制读取密度、进程抖动和失败重读。
- SFTP 视频保持 metadata-only，不会被 Media Search 当成本地路径抽帧；统一结果标记 `remote-content-required` / “需先取回远程原视频”，由用户走现有受控下载链路后再对本地副本建库。
- `Clear Cache` 只删除缩略图、OCR 和 temp；`Clear Data` 可删除帧、字幕、manifest 和帧向量，但原视频与 `asset-identities.jsonl` 不在 Media Search 数据目录内，测试确认二者保持不变。

## 验收证据

- `npm run test:unified-search`：47/47，包含原视频聚合、多时间点、lane 计分防膨胀、批量 AssetId、Catalog 投影、`frameId` 受控命中帧预览、UI 安全动作、派生数据删除边界、网络盘策略和 SFTP 显式退化。
- `npm run test:media-search`：36/36。
- `npm run test:asset-identity`：9/9。
- `npm run test:i18n-static`：7/7。
- `npm run typecheck`、`npm run lint`、`npm run format:check` 通过。
- `npm run test:discovery-catalog` 38/38、architecture（364 模块，main reachable 238）、IPC 7/7、preload 2/2 通过。
- `npm run smoke:ui -- --locale=zh-CN`：7 个核心面板、0 崩溃、0 console error；语言、主题、Native、模型、FFmpeg 和备份检查通过。

## 外部验收与后续增强

1. 使用真实视频集记录画面/字幕召回、时间点误差、索引时间和空间占用；在完成前 Phase 5 不标 `verified`。
2. 精确 seek 播放属于后续增强：可增加受控内置播放器或明确支持 seek 参数的播放器适配层，但不能把任意命令行参数暴露给 Renderer。当前时间点已作为稳定结果信息显示和传入受控动作，不影响本阶段本地实现完成。
