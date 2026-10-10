# Windows 首版范围与源码归档方案

> 状态：当前  
> 更新日期：2026-09-11  
> 范围：VAL-901、VAL-902；首版候选能力、源码变更盘点、提交边界  
> 执行系统：Codex  
> 所有者：Codex/root  
> 工作区：`feat/phase3-staged-index-unified-search`，未提交现场  
> 参考 HEAD：`4be3326240edeaec667730a963bddb7ea6a3e1e2`  
> 替代文档：无

## 1. 首版候选范围

本轮采用现有功能作为 Windows 首版候选，不删除功能、不迁移用户配置，不新增 NAS Agent 或跨平台交付承诺。这里的“纳入”表示需要验收，不表示已经可发布。正式销售范围、品牌权利与组件分发仍以原发布专项的真实决策为准。

| 能力 | 首版定位 | 实现入口 | 验收与限制 |
| --- | --- | --- | --- |
| 统一搜索与来源目录 | 默认主流程 | `electron/unifiedSearchService.ts`、`electron/unifiedSearchRuntime.ts`、`src/components/UnifiedSearchPanel.tsx` | 添加来源、建目录、查询、打开/定位形成闭环；模型缺失时明确降级为元数据搜索 |
| 本地目录与移动盘 | 核心来源 | `electron/sourceCatalogService.ts` | 普通目录、NTFS 和移动盘；掉盘不能误删目录记录，恢复后可重新检查 |
| 图片语义与以图搜图 | 核心 AI 能力 | `electron/imageSearchService.ts`、`src/components/ImageSearchPanel.tsx` | 依赖对应 DINO/CLIP 权重、运行时和索引；准确率用冻结查询集单独验收 |
| 视频画面搜索 | 首版候选 | `src/components/MediaSearchPanel.tsx`、`electron/mediaSearchIpc.ts` | FFmpeg/FFprobe、抽帧与向量索引准备完整；命中可跳转到正确素材和时间 |
| 深层视频语义与对白 | 可选高级能力 | `src/components/VideoSemanticStatusCard.tsx`、`src/components/AudioSemanticStatusCard.tsx` | Qwen3-VL、SenseVoice 及运行时另有准备条件；不可承诺无依赖开箱即用 |
| 主体、去重与素材管理 | 保留高级入口 | `src/components/SubjectPickerModal.tsx`、`src/components/DuplicateFinderPanel.tsx`、`src/components/AssetLibraryPanel.tsx` | 主体模型、分割模型逐项报告可用性；收藏、集合、分类及人工元数据不随索引清理丢失 |
| 播放器与结果导出 | 搜索后续工作流 | `electron/unifiedSearchExport.ts`、`electron/unifiedSearchEdlExport.ts`、`electron/unifiedSearchFcpxmlExport.ts` | CSV/JSON、片段与剪辑导出按既有实现验收；未实测的剪辑软件版本不作兼容承诺 |
| 挂载网络与 SFTP | 有条件候选 | `electron/sourceAdapter.ts`、`electron/sftpSourceAdapter.ts`、`electron/sftpVideoRetrievalService.ts` | 已有实现；仍需真实权限、断线、重连和按需取回验收 |
| 首次引导、模型/任务/健康中心 | 核心体验 | `src/components/FirstRunGuide.tsx`、`src/components/ProductReadinessCenter.tsx` | 中英文状态一致、失败可解释、取消可恢复；可选模型未就绪不能伪装成已准备 |
| 文件管理、批量重命名、存储、远程终端、时钟等 | 保留现有工具 | `src/App.tsx`、`src/config/panelRegistry.ts` | 不删除已有入口；文件操作保持原有保护与确认语义 |
| 数据保护与备份 | 首版基础能力 | `electron/assetLibraryBackup.ts`及数据安全专项 | 密码导出、错误密码拒绝、导入完整性、隔离恢复；不宣称原始媒体或热向量库已加密 |

默认用户路径：启动 → 添加一个本地来源 → 明确模型与工具状态 → 准备素材库 → 提交查询 → 查看命中依据 → 打开、定位或导出。元数据搜索与模型缺失分支同样必须可用。

明确不纳入当前交付承诺：NAS Agent（不在已实现来源类型集合中）、macOS/Linux 安装包、未批准的一键外置模型分发、未完成的性能候选默认启用、尚无正式真值的“统一准确率”宣传。开源或商业许可路线也不由本次范围盘点代为决定。

## 2. 源码现场盘点

本轮修改前使用 `git status --porcelain=v1 -z --untracked-files=all` 记录 781 个变更路径：暂存 144、未暂存 278、未跟踪 360。暂存与未暂存可指向同一路径，不能直接相加。与上一轮 780 相差一个路径是新增收尾 TODO；后续执行按实时清单统计。

| 分组 | 路径数 | 建议审查/提交边界 |
| --- | ---: | --- |
| 桌面源码 | 285 | 按来源同步、数据保护、模型/解码、窗口生命周期等功能切片；每片带相关测试 |
| QA 与构建 | 297 | 测试跟随功能切片；独立工具链和构建入口单列，不一次提交全部脚本 |
| 文档与政策 | 143 | 当前实现证据与工程改动对应；政策模板与真实批准状态分开审查 |
| 官网 | 21 | 独立审查与验证，桌面版本整理不隐式发布官网 |
| 根目录及其他 | 35 | 逐项检查配置、清单、字体/许可和临时文件，不凭目录名自动纳入 |

明细与 SHA-256 保存在本机 `artifacts/release-completion-20260911/source-inventory-before.json`，包含 Git 状态、相对路径、大小、修改时间、可读取普通文件的摘要与分组。历史改动所有者统一标为 `unconfirmed-existing`，不凭文件时间或作者风格推测归属；这份清单不含文件正文，也不提交到 Git。

本轮受控修改范围：两个根目录构建 BAT、`electron/embeddingDecodeBudget.ts`、`electron/dinoImageDecode.ts`、`vite.config.mjs`、构建清理/解码预算/备份导入三个测试文件、收尾 TODO、文档索引与本轮新文档。修改前副本保存到同一 artifact 目录的 `before/`。这只保护上述目标文件，不冒充完整工作区备份。

## 3. 后续归档操作顺序

1. 依据清单确定每组改动的责任人和纳入版本；现有暂存区保持原状。对本轮文件使用保存的前态做差异审查，避免把原有改动误算成本轮工作。
2. 正式重组前，为全部需保留的未提交文件建立独立备份清单、哈希和恢复抽查；Git bundle 单独保护已提交历史。模型、素材和真实库按各自备份策略处理，不打进源码归档。
3. 建立项目规范允许的任务分支或隔离 checkout，按功能与测试成组审查。新 checkout 不能只取 HEAD 而漏掉未归档的必需实现；复制范围必须来自已审查清单。
4. 先执行暂存快照、隐私和相关回归检查，再做可追溯提交。不得全量 `git add .`、强制清空或回退历史协作改动。
5. 过滤 `node_modules`、模型、运行缓存、构建输出、日志、真实用户数据、私钥/证书/令牌、个人路径及无归属临时文件。沿用 `scripts/git-preflight.cjs` 的目录、扩展名、敏感文件和大文件规则；扫描通过不等于完整敏感信息审计。
6. 最终候选在干净 checkout 上重跑回归，绑定唯一 SHA。未经归属确认的工作保留在原现场；本轮不建立标签或提交整批历史改动。

## 4. 验证与结论

VAL-901 完成范围盘点，VAL-902 完成归档方案与机器明细。两项是规划产物验收，不代表 VAL-911 干净源码候选已完成。全量工程结果、UI 实测与最终修改清单见[自动优化执行记录](2026-09-11-auto-optimization-execution.md)。

依据：[收尾 TODO](2026-09-11-release-completion-todo.md)、[产品化 TODO](2026-08-17-productization-auto-todo.md)、[数据保护说明](2026-09-01-data-security-hardening.md)、[Git 工作流](../reference/git-workflow-and-commit-policy.md)。
