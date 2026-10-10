# 产品剩余项自动推进 TODO

> 日期：2026-08-12
> 状态：当前
> 实施状态：自动推进中
> 选择命令：`npm.cmd run todo:product-next`
> 结构校验：`npm.cmd run todo:product-check`

## 自动执行规则

1. `auto` 项按“恢复半成品优先、价值降序、依赖就绪”自动领取，实现、验证、文档和提交后才标为 `verified`。
2. 每轮只完成一个可独立验收的切片；失败时保留 `in_progress`，下一轮继续恢复，不跳过问题。
3. 不读取、移动或删除真实用户素材；不伪造真实召回率、真实 NAS/SFTP、许可证、签名、发布信任或跨时间维护周期。
4. `approval`、`observation` 和带 External blockers 的项目只记录等待条件，不进入代码自动队列。
5. 新发现的相邻问题应插入本表，保持价值降序、依赖无环并通过结构校验。

## 机器可读任务表

| Rank | ID | Value | Mode | Dependencies | External blockers | Branch | Status | Validation | Task |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | VAL-101 | 100 | auto | - | - | `feat/smart-album-source-media-date` | verified | asset-list + smart-album + i18n + Electron smoke | 智能相册支持来源、媒体类型和修改日期范围，并复用统一资产查询链路 |
| 2 | VAL-102 | 98 | auto | VAL-101 | - | `feat/asset-rating-favorite` | verified | metadata transaction + backup + filters + UI | 增加评分与收藏权威元数据、批量操作和智能相册规则 |
| 3 | VAL-103 | 95 | auto | - | - | `feat/collection-management` | verified | collection CRUD + persistence + UI smoke | 素材收集篮重命名、排序、批量加入和拖放加入 |
| 4 | VAL-104 | 93 | auto | VAL-103 | - | `feat/collection-entry-points` | verified | Asset Library + Media Search UI contracts | 在 Asset Library 与 Media Search 独立结果视图增加统一收集入口 |
| 5 | VAL-105 | 91 | auto | - | - | `feat/unified-search-page` | verified | workspace navigation + unified-search + Electron smoke | 建立独立一级统一搜索页面并补齐打开、定位、收集和远端下载动作 |
| 6 | VAL-106 | 89 | auto | VAL-105 | - | `feat/unified-subject-mask` | verified | subject mask contract + search recall fixtures | 将 SAM 精细主体蒙版安全接入统一搜索，不向 Renderer 暴露缓存路径 |
| 7 | VAL-107 | 87 | auto | VAL-105 | - | `feat/derived-index-rebuild-action` | verified | identity repair + task scheduler + failure fixtures | 移动修复失败后提供受控的一键重建派生索引动作 |
| 8 | VAL-108 | 84 | auto | - | - | `feat/controlled-video-seek` | verified | media action guards + player smoke | 增加受控的精确视频 seek 播放适配，不暴露任意命令行参数 |
| 9 | VAL-109 | 81 | auto | VAL-108 | - | `feat/sftp-video-retrieval` | verified | transfer grants + bandwidth/cache fixtures | SFTP 视频按需取回、抽帧和有界缓存策略 |
| 10 | VAL-110 | 78 | auto | VAL-101; VAL-105 | - | `build/packaged-bilingual-validation` | verified | online/offline resources + packaged locale smoke | 生成当前导航与功能的 Online/Offline 安装包资源和 packaged 双语验收证据 |
| 11 | VAL-111 | 75 | approval | - | 可控 NAS/SFTP 地址与测试凭据 | `ops/nas-sftp-real-validation` | blocked | disconnect + reconnect + permission + throughput report | 真实 NAS/SFTP 连接、断线、重连、权限、吞吐和移动身份验收 |
| 12 | VAL-112 | 73 | approval | VAL-105; VAL-106 | 人工标注的真实素材查询与相关性真值 | `ops/unified-recall-evaluation` | blocked | Chinese semantic + subject + duplicate Recall@K | 真实素材库中文语义、主体和重复召回率评估 |
| 13 | VAL-113 | 71 | approval | VAL-108 | 人工标注的真实视频画面与字幕时间真值 | `ops/video-recall-evaluation` | blocked | recall + timestamp error + time/space benchmark | 真实视频集画面/字幕召回、时间误差、索引时间和空间基准 |
| 14 | VAL-114 | 68 | approval | - | 更新源、版本通道、产品身份与签名证书决策 | `feat/signed-auto-update` | blocked | signed update + rollback + channel fixtures | 自动更新实现与签名更新通道验收 |
| 15 | VAL-115 | 65 | approval | - | EULA、CUDA/cuDNN 再分发与正式签名授权 | `release/current-signed-distribution` | blocked | license gate + SBOM + signed installers | CUDA 可选运行时和正式签名发布闭环 |
| 16 | VAL-116 | 60 | observation | - | 三个相隔至少 24 小时的稳定维护周期 | `docs/vector-jsonl-retirement` | blocked | recall completeness + cleanup preview | 在稳定周期证据满足后评估 JSONL shard 退役 |

## 当前领取

无。所有无需外部条件的 `auto` 项均已完成；剩余项目保持显式阻塞。

## 完成记录

- `VAL-101`（2026-08-12）：来源、媒体类型和修改日期范围已贯通请求守卫、JSONL 回退、SQLite Catalog、智能相册和双语 UI；Asset Library 136/136，i18n 7/7，Electron `smartAlbumCrud: true`、0 崩溃、0 console error。
- `VAL-102`（2026-08-12）：评分与收藏已作为权威资产元数据进入原子快照和备份链路，SQLite Catalog schema v4 支持筛选；资产视图提供批量评分/收藏，智能相册可保存并恢复规则。定向测试 66/66、preload 2/2、IPC 7/7、i18n 7/7、typecheck/lint/format/full build 全绿；Electron `smartAlbumCrud: true`、7 面板、0 崩溃、0 console error。
- `VAL-103`（2026-08-12）：收集篮支持唯一名称重命名、稳定手动排序、1–500 项有界原子批量加入及统一搜索结果拖放；旧数据按稳定 ID 顺序兼容。集合/UI 定向测试 12/12、IPC 7/7、preload 2/2、i18n 7/7、typecheck/lint/format/renderer build 全绿；Electron `collectionCrud: true`、7 面板、0 崩溃、0 console error。
- `VAL-104`（2026-08-12）：Asset Library 提供所选素材批量收集，Media Search 的视频与帧结果提供独立收集按钮；两者先走权威身份解析再写入同一收集篮，并通过共享 hook 响应跨页面新建、重命名、排序和删除。集合/UI 定向测试 14/14、i18n 7/7、typecheck/lint/format/renderer build 全绿；Electron 7 面板、入口可见、0 崩溃、0 console error。
- `VAL-105`（2026-08-12）：新增可持久化的一级统一搜索面板，支持文本/参考图/来源筛选；结果提供受控打开、文件定位、单项/批量收集和基于短期授权的 SFTP 下载。UI/集合/i18n 定向测试 27/27、typecheck/lint/format/renderer build 全绿；Electron 8 面板、导航可聚焦、0 崩溃、0 console error。
- `VAL-106`（2026-08-12）：统一搜索复用主体检测与 MobileSAM 交互选择器，Renderer 仅提交有界主体框和 opaque 会话 ID；主进程按 WebContents、源文件指纹和 TTL 解析权威蒙版。过期能力明确降级 subject lane，不静默回退。主体蒙版/统一搜索定向测试 25/25、typecheck/lint/format/build 全绿；Electron 8 面板、0 崩溃、0 console error。
- `VAL-107`（2026-08-12）：缺失资产可定位移动后的原文件；当权威 AssetId 已修复但原生/向量路径修复失败时，签发按 WebContents 隔离、5 分钟过期且仅可使用一次的重建授权。确认影响范围后由统一调度器依次重建原生索引、缩略图、DINO、CLIP 与向量索引；清理前复查任务冲突和模型状态。身份/失败夹具 13/13、统一搜索 49/49、typecheck/lint/build/Electron smoke 全绿。
- `VAL-108`（2026-08-12）：视频命中动作改为只接受清单中的 `videoId` 和整数毫秒时间，按权威时长与 7 天硬上限拒绝越界输入；主进程在独立沙盒 BrowserWindow 中加载构建产物播放器和清单原文件，不拼接或执行外部播放器命令行。Media Search 40/40、preload 契约 2/2、typecheck/lint/build 全绿；真实 3 秒 WebM 在隐藏播放器精确跳转到 1250ms（观测 1.253s），Electron 主界面 8 面板、0 崩溃、0 console error。
- `VAL-109`（2026-08-12）：统一搜索中的 SFTP 视频可凭发送方绑定、一次性短期授权按需流式取回；单文件上限 8 GiB、缓存上限 20 GiB、单并发与 8 项等待队列，写入先落随机 `.part` 并校验目录权威字节数后原子改名，按访问时间 LRU 回收。取回后自动建立视频元数据并经统一 GPU lane 排队抽帧；主进程投影把本地缓存召回重新绑定到原始 SFTP `fileEntryId`，Renderer 不提交主机、凭据、远端路径或本地缓存路径。Catalog/SFTP 43/43、统一搜索 49/49、preload 2/2、IPC 7/7、typecheck/lint/format/full build/Electron smoke 全绿；缓存、带宽、并发合并、部分文件清理与身份映射 fixture 全通过。
- `VAL-110`（2026-08-12）：新增 `validate:packaged:matrix`，按 offline/online × zh-CN/en 独立保存资源与 UI 报告，支持失败后按 profile 安全续验和只读收集证据。实际生成 Offline 安装包 709,113,966 字节（SHA-256 `90d19062f3f380e5147ffd0a561b36ad7e10a6d4c8f6ee7f25544065588b595f`）与 Online 安装包 169,106,914 字节（SHA-256 `663e4e6a5149fef60d0725aa484079b47f8a5741833e038d89f45a7562eff47f`）；资源分别 27/27、22/22，通过两种语言各 8 面板、0 console error、native addon packaged provenance。详见 `docs/benchmarks/2026-08-12-packaged-bilingual-matrix.md`。
