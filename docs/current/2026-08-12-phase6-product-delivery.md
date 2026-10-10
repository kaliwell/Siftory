# Phase 6 产品界面与交付工程实施记录

> 状态：部分实施
> 实施状态：进行中
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md` 第 11、13、14 节
> 分支：`feat/phase3-staged-index-unified-search`

## 本轮切片：六域工作台导航

- 主界面新增常驻工作台导航，仅呈现“搜索、来源、素材库、整理、任务、设置”六个用户域，不再要求新用户从 Image Search、Media Search、NekoSearch 等内部模块名选择入口。
- 搜索域提供图片/文件搜索与视频搜索入口；来源域会打开统一搜索面板、展开并定位 Sources 区；素材库与设置域一键打开对应面板；整理域归拢批量重命名、重复文件和文件管理；任务域读取统一调度器 local/GPU lane 的运行与排队数量，并提供图片/视频建库入口。
- 现有面板的稳定 `data-panel` ID、设置键与数据路径保持不变，只替换用户可见标题，因此现有配置、自动化、数据迁移和内部调用不会因信息架构调整失效。
- Remote Terminal 不再作为普通工具入口展示：它只位于“来源 → 远程来源高级工具”，设置页也移入独立的“来源高级工具”分组；底层 SFTP profile、Transfer Queue 和安全 IPC 不变。
- Electron smoke 新增真实点击验收：六域存在、顶层无旧模块名、来源定位并展开、远程高级工具置顶、任务摘要可见。

## 交付链路现状审计

以下能力在进入 Phase 6 前已存在，本阶段复用而不重复实现：

- `build:online` / `build:offline` 与 profile-aware `package-profile.cjs`；在线包排除模型和 FFmpeg，离线包依据 manifest 携带声明资源。
- 模型按需下载、SHA-256/许可证检查、Model Platform 用户模型槽位，以及 CUDA 可选 runtime 的显式审批边界。
- packaged resources 清单、双语 packaged UI smoke、安装器归档检查、SBOM、哈希、release record 和串行 release gate。
- 素材库元数据备份、校验、恢复前快照、导入和派生数据安全清理入口。

## 验收证据

- `npm run test:ui-smoke-contract`：7/7，包含六域导航与远程工具归位契约。
- `npm run smoke:ui -- --locale=zh-CN`：7 个核心面板、0 崩溃、0 console error；`workspaceNavigationCheck` 五项全 true。
- `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run test:i18n-static` 通过。
- `npm run test:model-download`：77/77，覆盖 Online/Offline profile、资源清单、按需下载、release gate、许可证 fail-closed 和用户模型隔离。
- 设置、素材库备份导入导出、SQLite/JSONL、embedding/vector 迁移与安全清理定向组合：43/43。
- NSIS 现显式设置 `deleteAppDataOnUninstall=false`，两个 profile 由契约测试锁定为卸载保留用户数据。
- 用户数据生命周期说明：`docs/reference/2026-08-12-upgrade-rollback-data-lifecycle.md`。

## Phase 6 剩余

1. 自动更新尚无实现。接入前必须确定更新源、版本通道、签名证书和产品身份；这些会影响外部网络与发布信任，不能由本地自动化擅自选择。技术实现完成前 Phase 6 不标 `implementation_complete`。
2. 为本轮导航生成新的 Online/Offline 安装包资源检查与 packaged 双语 smoke 证据；许可证审批和正式签名仍按 Phase 7 阻断，不伪造成已完成。
