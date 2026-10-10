# Siftory（寻藏）文档中心

> 状态：当前入口  
> 更新日期：2026-10-10
> 适用项目：Siftory（寻藏）桌面应用

本文档是 `docs/` 的唯一入口。阅读项目现状时先看“当前基线”，不要直接从历史审计推断当前代码状态。

## 用户文档

- [Siftory（寻藏）完整用户说明书](reference/user-manual.md)：安装、首次启动、窗口与面板操作、文件夹大小与稳定排序、搜索建库、按盘符/文件夹清理图片与视频派生数据、图片兼容拖拽、播放器命中导航与片段导出、批量重命名安全边界、素材库、远程终端、数据备份和故障排查。

## 开工前强制确认

任何模型、代理或人工开发者接手项目前，必须先阅读[模型、运行时与文档确认规范](reference/model-runtime-and-document-confirmation.md)，并完成以下确认：

1. 确认自身模型和运行时；精确版本不可见时明确写未知，不得猜测。
2. 确认 Todo 中代理的所属系统；`Kimi/coder` 与 `Codex/coder` 是不同代理，不能互相替代。
3. 确认当前文档基线和事实优先级。
4. 确认 Git/工作区状态、并发修改和目标文件所有者。
5. 输出身份、代理归属、文档入口、当前任务后再开始操作。

当前运行时只能查询和管理自己的代理。一个运行时看不到某代理，不代表其他运行时中不存在该代理。

## 当前基线

Alpha 仓库准备：[2026-10-10 Alpha 版本与公开仓库准备](current/2026-10-10-alpha-repository-preparation.md)。当前维护版本为 1.0.1-alpha.1；公开源码、个人非商业免费／商用付费的方向已确定，正式许可与公开上传审查仍待完成。

当前修复：[2026-09-30 全面审计自动修复 TODO](current/2026-09-30-comprehensive-audit-fixes-todo.md)。15 项代码缺陷已修复并验证；默认测试累计 2493 通过、7 跳过、0 失败，双语桌面及关键覆盖率门禁通过，npm 已知漏洞为 0。运行时维护和正式发行门禁仍有单列待办，详见 TODO 与本轮证据。

修复前审计基线：[2026-09-29 全面工程审计](audits/2026-09-29-comprehensive-project-audit.md)。在同日健康度检查基础上新增确认 14 项代码缺陷（4 项 P1、10 项 P2），包含重命名覆盖、SFTP 下载同名竞争、目录链接恢复越界及视频搜帧协议不匹配；加上前轮来源清理统计问题，当时共 15 项待修复代码缺陷，桌面置顶和关键覆盖率门禁未通过。历史复现保留；这些代码与自动验收问题的最新状态以上方 9 月 30 日修复记录为准，正式发行仍需单独通过相应门禁。

前轮基线：[2026-09-29 项目健康度审计](audits/2026-09-29-project-health-audit.md)。本地执行已恢复；类型、Lint、格式、默认回归和受检构建证据保留。用户已明确表示软著申请已提交，不再把提交申请列为待办；受理及登记结果未据此推定。60 页源程序和 27 页登记说明书保持冻结。

上一工程检查点：[2026-09-28 登记与工程续记](current/2026-09-28-registration-and-maintenance-status.md)。其中登记进度和宣传样片状态属于当日记录，后续事实以用户陈述及最新审计为准。独立条款窗口的依赖检查已补齐，现有安装器与对应源码附件沿用 9 月 26 日记录。冻结源码、后续维护源码和发行物分别追溯，详见[9 月 26 日检查点](current/2026-09-26-registration-and-release-status.md)。

桌面工程检查点：[2026-09-25 用户协议流程](current/2026-09-25-end-user-terms-flow.md)。独立窗口、明确同意/拒绝、本地版本记录与设置查看入口已接入；当前仍是无正式协议的内部审查版，发布门禁保持阻断。该检查点之后登记 PDF 已生成，最终发行条款仍待确定。

上一检查点：[2026-09-25 UI 生命周期与发行条款](current/2026-09-25-ui-lifecycle-and-terms.md)。固定临时样本后，中英文各 600 次面板循环和 12 次可见性循环通过；原日志与候选材料保留供追溯。

个人软著准备与工程优化历史：[2026-09-24 执行清单](current/2026-09-24-copyright-readiness.md)。保留窗口、来源同步、候选材料与组件授权的各轮证据；用户后续已确认的名称、版本、日期及独立开发陈述以当前状态入口为准，个人证明和签署仍由本人完成。

首版收尾快速入口：[2026-09-11 首版收尾与发布验收 TODO](current/2026-09-11-release-completion-todo.md)。依据同日实际检查，按首版范围、版本归档、工程回归、真实质量与可靠性、最终发布编排 20 项任务；该次评估为抽样验证，不替代全量回归或现有专项验收。

自动优化进展：[2026-09-11 执行记录](current/2026-09-11-auto-optimization-execution.md)。VAL-901～910 已验证，包含全量工程回归、覆盖率与双语桌面冒烟；[范围与归档方案](current/2026-09-11-v1-scope-and-source-inventory.md)和[真实验收材料包](current/2026-09-11-release-acceptance-packet.md)已准备，真实设备与正式发布仍待对应证据。

固定硬件性能快速入口：[2026-08-26 PxHere 1000 张首次建库三轮正式基线](benchmark/2026-08-26-fixed-hardware-first-build-baseline.md)。该报告绑定当前接受指针、硬件/数据集/环境/实现 identity、三轮 DirectML 实际 Provider、资源控制线和原始日志路径。

按以下顺序阅读：

1. [2026-08-19 全项目多维审计与整改报告](audits/2026-08-19-full-project-multidimensional-audit.md)：14 个主面板、3 类窗口，以及逻辑、结构、复用、安全、生命周期、性能和发布条件的最新未提交现场基线。
2. [2026-08-17 全项目复审与整改报告](audits/2026-08-17-full-project-audit.md)：上一轮源码、测试、原生构建、视频/音频语义、文档、安全和发布条件基线。
3. [商业发布准备专项](current/2026-08-17-commercial-release-readiness.md)：许可证、隐私、签名、质量证据、支持策略、内部安装候选和正式发布操作的独立机器可读清单。
4. [开源、商业化与基金会路径](current/2026-08-19-open-source-commercialization-foundation-strategy.md)：开放核心、商业产品、许可证候选、贡献机制和基金会触发条件的草案；不代表许可证已经变更或获批。
5. [2026-08-02 全项目多维审计](audits/2026-08-02-full-project-multidimensional-audit.md)：上一轮结构、逻辑、性能、安全、真实数据健康和发布判定基线。
6. [Image Search Data Editor 全量数据总览实施](current/2026-08-03-image-search-data-overview-implementation.md)：主要大文件、Native/DINO/CLIP 全库目录、真实数据健康、性能和安全边界。
7. [全项目详细优化方案](current/2026-07-28-project-optimization-plan.md)：32 项发布、数据、安全、构建和维护任务的依赖与验收标准；任务状态仍以表格和 `todo:next` 为准。
8. [价值排序专项优化 TODO](current/2026-08-07-value-ranked-optimization-todo.md)：正式计划之外的机器可读价值队列；`todo:value-next` 只选择无外部授权、无真实数据操作的安全自动任务。
9. [项目审计整改进度](current/2026-07-28-project-audit-remediation.md)：既有整改批次，以及 2026-08-02 新审计发现的验证和数据治理优先级。
10. [2026-07-28 全项目综合审计](audits/2026-07-28-full-project-audit.md)：上一轮历史快照，用于对照依赖、发布、磁盘、国际化和 Git 整改前状态。
11. [DINO / CLIP GPU 构建吞吐异常事件](current/2026-07-31-embedding-gpu-throughput-incident.md)：记录伪图片、全量向量扫描、无效批处理与 DirectML 过度并发造成的慢速问题，以及修复和真实 GPU 验证数据。
12. [NekoSearch 当前优化进度](current/2026-07-18-neko-search-optimization-progress.md)：历史完成项、当前门禁结果、数据边界和下一阶段优先级。
13. [NekoSearch 完整多维审计](audits/2026-07-18-neko-search-complete-audit.md)：功能完整性、结构、数据一致性、大库性能、准确率、安全、复用、扩展性和发布阻断项。
14. [NekoSearch 当前实施基线](current/2026-07-14-neko-search-implementation.md)：分类、标签、参考图建议、聚类、Category 样本搜索和主体检索计划。
15. [NekoSearch 分类数据丢失恢复记录](current/2026-07-18-neko-search-category-data-recovery.md)：分类 store 清空证据、可恢复范围、删除回收记录和撤销验证。
16. [当前优化交接](current/2026-07-12-optimization-handoff.md)：项目级连续优化记录和历史交接。
17. [NekoSearch 审核反馈搜索方案](designs/2026-07-15-neko-search-feedback-search-plan.md)：复用 Accept/Reject 的全库补候选和个性化重排。
18. [搜索简单/高级模式](designs/2026-07-13-search-experience-modes-design.md)：Image/Media Search 一键准备流程、状态、复用和验证边界。
19. [项目白皮书](product/2026-07-10-project-whitepaper.md)：产品定位、能力边界和商业价值假设。
20. [VID-017 自动收尾 TODO](current/2026-08-15-vid-017-auto-todo.md)：llama.cpp/Qwen3-VL 本机运行时的自动项、八类真实 soak、发布审批边界与剩余阻塞。
21. [VID-017 分发审批材料包](current/2026-08-15-vid-017-distribution-approval-packet.md)：MIT/Apache-2.0、项目 EULA 和分发模式的人工决策材料；不构成批准。
22. [软件产品化自动优化 TODO](current/2026-08-17-productization-auto-todo.md)：首次启动、统一任务、数据源健康、多模态搜索证据、播放器、剪辑导出、恢复和 UI 的机器可读自动队列。
23. [运行内存与峰值内存完整优化 TODO](current/2026-08-28-runtime-memory-optimization-todo.md)：针对 ANN 全量 F16 常驻、DINO/CLIP 建库峰值、视频帧索引、用户模型和 Renderer/GPU 生命周期的分阶段方案、量化预算与三轮验收门禁；承接已完成的[内存与资源生命周期整改](current/2026-08-18-memory-lifecycle-auto-todo.md)。
24. [图片搜索与视频建库“准备素材库”性能优化 TODO](current/2026-08-22-search-library-preparation-performance-todo.md)：按当前代码与真实基准排定视频批量抽帧、CPU/GPU 分块流水线、CUDA provider、ANN/native SIMD 和增量目录任务，并锁定功能、质量、安全与资源门禁。
25. [PxHere 1000 张图片准备速度优化方案](current/2026-08-22-image-preparation-speed-optimization-plan.md)：基于 225.924 秒 ready P50 排定阶段归因、DirectML batch/worker、单模型双缓冲和扫描联合调度，并明确 CUDA、USN 与回滚边界。
26. [图片搜索与视频建库“准备素材库”三轮基线](benchmark/2026-08-22-search-library-preparation-baseline.md)：固定只读语料、隔离临时库、分阶段 P50/P95、CPU/RSS/VRAM/读写字节、正确性摘要和安全门禁。
27. [PREP-002 视频抽帧有界单输入优化验证](benchmark/2026-08-22-video-frame-extraction-prep002.md)：本地 71→8 次 FFmpeg 启动和 55.53% P50 收益、网络候选拒绝、CFR/VFR 位级一致、失败回退、取消与原子 Manifest 门禁。
28. [PREP-003 视频准备分块流水线验证](benchmark/2026-08-22-media-preparation-pipeline-prep003.md)：原子帧检查点、常驻 DINO 流、精确 ready 门禁和三轮 15.37% 端到端收益，并记录向量 parity、资源与源变化失效。
29. [PREP-005 图片准备增量流水线验证](benchmark/2026-08-22-image-preparation-pipeline-prep005.md)：Native committed-path feed、真实 batch DINO 流、精确覆盖/revision/index ready 栅栏和三轮 15.55% 端到端收益。
30. [PxHere 1000 张图片准备速度与阶段间隔诊断](benchmark/2026-08-22-pxhere-1000-image-preparation-diagnostic.md)：2.45 GiB 真实语料三轮 A/B、逐秒阶段时间线、间隔归因和修复后资源采样边界。
31. [PREP-011 图片准备阶段归因与完整资源曲线验证](benchmark/2026-08-22-image-preparation-stage-attribution-prep011.md)：Native 反压/解码、DINO/CLIP 前推理占比、256 图遥测开销和 1000 图 1187 个无错误资源样本。
32. [PREP-012 DirectML batch/worker 受资源约束矩阵验证](benchmark/2026-08-22-embedding-policy-matrix-prep012.md)：DINO/CLIP jobs 1/2 与 batch 4/8/16 的三轮筛选、资源预检、向量 parity 和拒绝候选证据；当前 `jobs=2,batch=4` 保持不变。
33. [PREP-014 图片扫描与 Embedding 联合调度矩阵验证](benchmark/2026-08-22-image-joint-scheduling-prep014.md)：256 图 18 轮整链路矩阵、资源限制与 parity 证据；当前 `scan=3,jobs=2,batch=4` 保持不变。
34. [PREP-015 Native JPEG WIC 影子解码验证](benchmark/2026-08-22-native-jpeg-shadow-prep015.md)：256 张 JPEG 的元数据/双哈希逐图比较；`218/256` 哈希不一致，候选拒绝。
35. [PREP-017 CLIP 低内存 Tensor 预取验证](benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)：深度 1 反压、三通道融合缩放与 Alpha 回退虽改善单模型和内存，但完整 ready 仅改善 0.513%，候选默认关闭并 `deferred`。
36. [PREP-007 Image Search Q8 投影 ANN 验证](benchmark/2026-08-22-vector-ann-q8-projection-prep007.md)：44 万条真实向量、20% 候选、平均 Recall@50 99.88%、首位一致率 100% 和热查询 P95 改善 83.04%。
37. [PREP-008 NekoSearch ANN 候选与精确重排验证](benchmark/2026-08-22-neko-search-ann-prep008.md)：4 中心批量 ANN、约 10% 活跃候选、正负反馈精确评分、完整 exact 回退和三轮 P95 改善 69.36%。
38. [PREP-009 Image Search 数据目录增量刷新验证](benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)：固定 chunk 指纹、严格 append-tail、未变化分片零读取、受影响祖先汇总，以及当前真实 11.36 GiB 源的全量/三轮复用门禁。
39. [本地模型安装修复与运行验证](current/2026-08-23-local-model-install-repair.md)：六个用户模型槽位的清单校验、隔离导入、原子安装、任务级推理证据，以及音频/视频运行时和分发边界。
40. [按盘符或文件夹清理图片/视频派生数据](current/2026-08-23-source-derived-data-cleanup.md)：当前为部分实施；真实复检确认 Native、DINO/CLIP、诊断、缩略图和视频层已清理且原文件不变，但仍残留 17 条主体裁剪向量。
41. [按来源派生数据清理自动优化 TODO](current/2026-08-23-source-derived-data-cleanup-auto-todo.md)：记录已通过的 Native/零视频/诊断/缩略图整改，以及待完成的主体向量、历史任务痕迹策略和真实复验门禁。
42. [2026-09-01 数据安全加固](current/2026-09-01-data-security-hardening.md)：数据目录 ACL、备份加密与诊断脱敏；asset repair journal v3 密钥认证与防回滚 anchor、Product Health 实时 ACL 探测与显式修复，以及 Windows PowerShell 参数传递缺陷修复。

发生冲突时，优先级为：当前代码与测试结果 > `current/` > 日期较新的审计 > 历史方案。

## 目录结构

| 目录         | 内容                                     | 使用规则                   |
| ------------ | ---------------------------------------- | -------------------------- |
| `current/`   | 当前状态、当前交接、最新决策             | 开始开发前必读             |
| `audits/`    | 按日期保存的结构、性能、安全和完整度快照 | 仅代表审计日期当时状态     |
| `designs/`   | 已有或待实施的功能与架构方案             | 实施前必须对照当前代码复核 |
| `handoffs/`  | 面向其他开发者或模型的专项交接           | 可能早于当前实现           |
| `history/`   | 长期日志、旧需求和完成记录               | 只用于追溯，不作为当前事实 |
| `product/`   | 产品定位和商业分析                       | 不替代工程验证             |
| `reference/` | 稳定的工程规则、能力矩阵和构建说明       | 变更相关边界时同步更新     |
| `benchmark/` | 可复现性能报告与原始测量产物             | 原始 JSON/JSONL 不手工改写 |

## 功能索引

### Unified Asset Discovery

- [本地与 NAS AI 素材发现统一架构方案](designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md)：以 NTFS/USN 高速发现、分阶段索引、统一素材身份和 NAS/SFTP 数据源为主线；明确从 Lap 借鉴的文件夹优先、组合资产和发布体系，以及不整体迁移 Tauri/Vue 的决策。
- [NAS 技术主链实施跟踪](current/2026-08-11-nas-technical-main-chain-todo.md)：Phase 0-6 权威阶段状态与验收边界。
- [Phase 3 分阶段任务与统一搜索实施](current/2026-08-11-phase3-staged-index-unified-search.md)：D1/CLIP 调度接线、统一结果与退化状态、移动路径修复，以及尚未完成的主体/重复召回和 D3-D6 迁移。

### Application Platform

- [多显示器、AI 控制 API 与主题系统优化方案](designs/2026-08-09-multi-display-ai-api-theme-plan.md)
- [AI Agent 控制接口原始提案](AI_AGENT_API_PROPOSAL.md)
- [AI Control API 使用与安全规则](current/AI_CONTROL_API.md)
- [AI Control API 模型与媒体运行时完整性修复](current/2026-08-18-ai-control-runtime-readiness.md)：记录 CLIP 完整安装、FFmpeg 首次状态、图片/视频文本搜索真实 HTTP 验收与回归证据。
- [主题系统与预设说明](current/THEME_SYSTEM.md)

### File Manager

- [文件夹大小显示、稳定大小排序、卷容量与资源边界](current/2026-08-18-file-manager-folder-size.md)：记录异步递归统计、用户触发的冻结排序快照、可见区域调度、下限标记、盘符容量口径、取消、缓存和安全上限。

### Image Search

- [源文件删除同步自动优化 TODO](current/2026-08-30-source-file-sync-auto-todo.md)：提供在线来源验证、失效图片/视频预览、确认后二次校验、批量索引持久化、素材库联动，以及取消、离线和读取失败时的保守保护。
- [来源文件同步失败恢复与安全边界整改记录](current/2026-08-30-source-file-sync-audit-remediation-todo.md)：跟踪掉线重检、Native 原子提交、向量失效 outbox、视频 missing 过滤、双向维护互斥、阶段验收和残余风险。

- [图片搜索与视频建库“准备素材库”性能优化 TODO](current/2026-08-22-search-library-preparation-performance-todo.md)：图片首建流水线、DINO/CLIP provider、解码复用、ANN 候选与真实性能验收队列。
- [PxHere 1000 张图片准备速度优化方案](current/2026-08-22-image-preparation-speed-optimization-plan.md)：按阶段归因、自动 batch/worker、单模型双缓冲和扫描联合调度推进；不改变 ready、模型、向量或源文件语义。
- [“准备素材库”三轮基线](benchmark/2026-08-22-search-library-preparation-baseline.md)：当前简单模式的 Native、DINO、CLIP、ANN、后台缩略图和工作流 ready 数据。
- [PREP-002 视频抽帧优化验证](benchmark/2026-08-22-video-frame-extraction-prep002.md)：本地有界单输入批次的三轮性能、帧内容一致性和回退边界；图片链路未改。
- [PREP-003 视频准备流水线验证](benchmark/2026-08-22-media-preparation-pipeline-prep003.md)：帧检查点驱动的抽帧/DINO 重叠、最终 DINO+CLIP 覆盖和 ready 提交门禁。
- [PREP-005 图片准备流水线验证](benchmark/2026-08-22-image-preparation-pipeline-prep005.md)：已提交图片分块驱动 DINO、温更新零重复推理、最终双模型覆盖和向量索引提交门禁。
- [PxHere 1000 张阶段诊断](benchmark/2026-08-22-pxhere-1000-image-preparation-diagnostic.md)：重叠 ready P50 225.924 秒、扫描/DINO 关键路径、CLIP 串行尾部与逐秒间隔诊断。
- [PREP-011 阶段归因与资源曲线](benchmark/2026-08-22-image-preparation-stage-attribution-prep011.md)：详细指标默认关闭、三轮 P50 开销 +0.149%，并定位 Native 解码与两个模型前处理瓶颈。
- [PREP-014 联合调度矩阵验证](benchmark/2026-08-22-image-joint-scheduling-prep014.md)：比较 scan 2/3/4 与 Embedding jobs 1/2 的完整 ready、资源和 parity，确认保留当前组合。
- [PREP-015 Native JPEG 影子验证](benchmark/2026-08-22-native-jpeg-shadow-prep015.md)：WIC/stb 元数据和双哈希严格比较，记录候选因哈希语义变化被拒绝。
- [PREP-017 CLIP Tensor 预取验证](benchmark/2026-08-22-embedding-tensor-prefetch-prep017.md)：低内存融合解码、单批 lookahead、非三通道原路径回退、向量 parity 和 1000 图资源/收益门禁。
- [PREP-007 Image Search Q8 投影 ANN 验证](benchmark/2026-08-22-vector-ann-q8-projection-prep007.md)：128 维 Q8 候选、完整 Float16 精确重排、20% 候选上限、Recall 和精确回退门禁。
- [PREP-008 NekoSearch ANN 验证](benchmark/2026-08-22-neko-search-ann-prep008.md)：共享 active scope 的 4 中心批量召回、原始 Float16 正负反馈精确评分与 exact 诊断/回退。
- [PREP-009 数据目录增量刷新验证](benchmark/2026-08-22-image-data-catalog-incremental-prep009.md)：schema v2 源指纹、严格追加复用、非追加变化全量回退、逐行 parity 与真实数据性能结果。
- [缩略图 CPU/GPU 异步流水线](current/2026-07-24-thumbnail-async-gpu-cpu-pipeline.md)
- [Start Scan 原生缩略图旁路](current/2026-07-24-start-scan-native-thumbnail-sidecar.md)
- [独立缩略图重建 C++/CUDA 后端](current/2026-07-24-native-thumbnail-rebuild.md)
- [缩略图缓存递归与 Start Scan 性能修复](current/2026-07-24-thumbnail-cache-recursion-fix.md)
- [Top 1000 Reranking 优化](current/2026-07-24-image-search-rerank-top1000.md)
- [Similar ANN 检索优化](current/2026-07-24-image-search-ann-optimization.md)
- [批量命名恢复 + 主体搜索交接](current/2026-07-24-feature-implementation-handoff.md)
- [Similar 大库检索性能修复](current/2026-07-23-image-search-similar-performance.md)
- [2026-08-10 以图搜图空结果复发事件](history/2026-08-10-image-search-empty-results-recurrence.md)
- [指定文件夹 Native/DINO/CLIP 多层索引编辑](current/2026-08-02-image-search-folder-index-editor.md)
- [Data Editor 全量数据总览实施与数据健康](current/2026-08-03-image-search-data-overview-implementation.md)
- [全量数据目录真实性能基准](benchmark/2026-08-03-image-search-data-catalog-real-benchmark.md)
- [DINO / CLIP NVIDIA CUDA 加速方案](designs/2026-08-07-dino-clip-cuda-acceleration-plan.md)
- [数据编辑管理器与优化缩略图重建](current/2026-07-23-image-search-data-editor.md)
- [Data Editor 全量数据总览方案（P0-P2 已实施）](designs/2026-08-03-image-search-data-overview-design.md)
- [简单/高级模式与一键准备](designs/2026-07-13-search-experience-modes-design.md)
- [中文语义搜索方案（面板复用）](designs/2026-07-27-chinese-semantic-search-plan.md)
- [重构方案](designs/image-search-rearchitecture.md)
- [向量增强原始需求](history/2026-06-26-image-search-vector-requirements.md)
- [完整度审计](audits/2026-06-30-image-search-completeness-audit.md)
- [审计进度](audits/2026-06-29-image-search-progress-audit.md)
- [fast_scanner 0.4.1 审计](audits/2026-06-23-fast-scanner-0.4.1-audit.md)
- [2026-08-05 向量与 FastScanner 专项交接](handoffs/2026-08-05-vector-and-fastscanner-handoff.md)
- [批量图片命名恢复方案](designs/2026-07-24-batch-rename-recovery.md)

### Media Search

- [图片搜索与视频建库“准备素材库”性能优化 TODO](current/2026-08-22-search-library-preparation-performance-todo.md)：视频逐帧 FFmpeg、分块抽帧/Embedding 流水线和深度语义性能的优先级、边界与门禁。
- [“准备素材库”三轮基线](benchmark/2026-08-22-search-library-preparation-baseline.md)：CFR、VFR、截断视频的扫描、抽帧、DINO、CLIP、帧索引和资源基线。
- [PREP-002 视频抽帧有界单输入优化验证](benchmark/2026-08-22-video-frame-extraction-prep002.md)：本地抽帧 P50 改善 55.53%，挂载网络候选因回退 163.08% 未启用，并覆盖取消、损坏与原子提交。
- [PREP-003 视频准备分块流水线验证](benchmark/2026-08-22-media-preparation-pipeline-prep003.md)：三轮工作流 ready P50 改善 15.37%，保持 69 帧双模型精确覆盖、138 条索引、Top-10 和资源门禁。
- [PREP-005 图片准备增量流水线验证](benchmark/2026-08-22-image-preparation-pipeline-prep005.md)：三轮工作流 ready P50 改善 15.55%，保持 16 图双模型/索引精确覆盖、Top-10 与温更新零重复门禁。
- [软件产品化自动优化 TODO](current/2026-08-17-productization-auto-todo.md)：记录统一搜索证据、播放器命中导航、片段选区、JSON/CSV、MP4、EDL 与 FCPXML 导出及当前人工门禁。
- [多类型视频语义建库方案](designs/2026-08-14-multi-profile-video-semantic-index-plan.md)：面向影视、短视频、会议、课程、游戏、监控和体育等类型，规划Qwen3-VL视觉语义、SenseVoice音频语义、时间片段索引、资源预算与安全退化。
- [视频语义建库自动推进 TODO](current/2026-08-14-video-semantic-index-todo.md)：区分可自动实施的契约/索引/UI任务与需要批准的模型下载、真实素材和发布门禁。
- [VID-017 llama.cpp / GGUF 内置运行时推进记录](current/2026-08-15-vid-017-llama-cpp-runtime.md)：受管sidecar、安全边界、固定候选、Online/Offline排除门禁及剩余审批项。
- [视频语义剩余项自动推进 TODO](current/2026-08-15-video-semantic-remaining-auto-todo.md)：记录最终8×10覆盖、人工门禁和最后报告的机器可读状态。
- [Qwen3-VL 2B 最终8×10覆盖基准](benchmarks/2026-08-15-qwen3-vl-2b-profile-final-coverage.md)：80/80机器结果、44条只读复用、36条新增指标和剩余深度人审门禁。
- [VID-016 多类型视频语义最终验收报告](benchmarks/2026-08-15-video-profile-final-report.md)：8×10完整人审、逐profile语义接受率、幻觉、时间点指标和最终门禁结论。
- [音频说话人人工验收网页](current/2026-08-14-audio-semantic-review-webapp.md)：复用本地视频验收服务，以匿名片段、参考声纹、Range播放和原子私有保存完成VID-014人工听审。
- [简单/高级模式与一键准备](designs/2026-07-13-search-experience-modes-design.md)
- [中文语义搜索方案（面板复用）](designs/2026-07-27-chinese-semantic-search-plan.md)
- [多模态视频搜索方案 v1.1.3](designs/2026-07-02-media-search-plan-v1.1.3.md)
- [专项交接](handoffs/2026-07-03-media-search-handoff.md)
- [速度基准报告](benchmark/2026-07-04-media-search-speed-benchmark.md)
- [10K/100K Manifest Cache 基准](benchmark/2026-07-12-media-search-manifest-cache-benchmark.md)
- [真实素材 Recall@K 基线](benchmark/2026-07-12-media-search-real-recall-baseline.md)
- [人工文本语义标注集](benchmark/2026-07-12-media-search-text-annotation-dataset.md)
- [Electron UI 冒烟测试报告](benchmark/2026-07-12-electron-ui-smoke-report.md)
- [最新 NekoSearch 整改与 NSIS 验证报告](benchmark/2026-07-16-neko-search-remediation-verification.md)
- [Benchmark 说明](benchmark/README.md)

### Remote Terminal

- [WindTerm 学习与重构](designs/2026-06-19-remote-terminal-windterm-study.md)
- [便携凭据与监控方案](designs/2026-06-19-remote-terminal-credentials-monitoring-plan.md)
- [专业功能扩展方案](designs/2026-06-22-remote-terminal-expansion-plan.md)
- [压力测试报告](audits/2026-06-22-remote-terminal-stress-test.md)
- [专项交接](handoffs/2026-06-18-remote-terminal-handoff.md)

### App Storage

- [按盘符或文件夹清理图片/视频派生数据](current/2026-08-23-source-derived-data-cleanup.md)：按来源预览并清理主要图片/视频派生层，同时保护原始素材、模型与人工元数据；当前真实验收因 17 条主体向量残留而部分通过。
- [按来源派生数据清理自动优化 TODO](current/2026-08-23-source-derived-data-cleanup-auto-todo.md)：主体向量、历史重建痕迹和最终真实只读复验的剩余任务与门禁。
- [功能设计](designs/2026-06-18-app-storage-design.md)
- [专项交接](handoffs/2026-06-18-app-storage-handoff.md)
- [缺陷修复反馈](handoffs/2026-06-18-app-storage-defect-feedback.md)

### NekoSearch

- [PREP-008 ANN 候选与精确重排验证](benchmark/2026-08-22-neko-search-ann-prep008.md)
- [当前优化进度](current/2026-07-18-neko-search-optimization-progress.md)
- [完整多维审计（当前）](audits/2026-07-18-neko-search-complete-audit.md)
- [多维审计（历史快照）](audits/2026-07-15-neko-search-multidimensional-audit.md)
- [当前实施基线](current/2026-07-14-neko-search-implementation.md)
- [AI 审核反馈驱动个性化搜索方案](designs/2026-07-15-neko-search-feedback-search-plan.md)
- [准确率门禁工具链](benchmark/2026-07-18-neko-search-accuracy-gate.md)
- [准确率模型路线评估（主体 crop/多语言/OCR）](designs/2026-07-18-neko-search-accuracy-model-evaluation.md)
- [Duplicate Finder 集成方案](designs/2026-07-18-neko-search-duplicate-integration.md)
- [聚类人工干预与稳定 Lineage 方案](designs/2026-07-18-neko-search-cluster-lineage-plan.md)
- [分阶段整改与样本搜索验证](benchmark/2026-07-16-neko-search-remediation-verification.md)
- [智能素材分类方案](designs/2026-07-09-neko-search-classification-plan.md)
- [主体精准搜索实施方案](designs/2026-07-24-subject-search-implementation.md)
- [批量图片命名恢复方案](designs/2026-07-24-batch-rename-recovery.md)
- [中文语义搜索方案（面板复用）](designs/2026-07-27-chinese-semantic-search-plan.md)

## 工程审计与参考

- [全局隐藏、恢复闪烁与鼠标穿透完整修复 TODO](current/2026-08-29-window-visibility-click-through-fix-todo.md)：统一 `Ctrl+Shift+Alt+R`、原生可见性状态机、Renderer/Shape 握手、鼠标穿透、交互取消、诊断日志与真实 Electron 回归门禁。
- [运行内存与峰值内存完整优化 TODO](current/2026-08-28-runtime-memory-optimization-todo.md)：分进程证据、ANN 分页精确重排、建库峰值治理、视频/用户模型/Renderer 生命周期、故障回归和固定硬件三轮控制线。
- [Embedding 实时 RAM/VRAM 资源治理验收](benchmark/2026-08-29-runtime-memory-embedding-resource-governance.md)：整树内存与 VRAM 采样、迟滞、Auto batch/worker 降级恢复和不丢队列证据。
- [DINO 融合预处理影子验证](benchmark/2026-08-29-runtime-memory-dino-fused-shadow.md)：默认关闭的候选、张量/完整向量 parity、16 图冒烟和 1000 图正式矩阵边界。
- [运行健康与性能自动化 TODO](current/2026-08-24-runtime-health-performance-auto-todo.md)：统一只读健康报告、模型安全修复计划、固定 PxHere 阶段基准、按来源派生数据审计、夜间调度与外部门禁。
- [2026-08-19 全项目多维审计与整改报告（当前）](audits/2026-08-19-full-project-multidimensional-audit.md)
- [2026-08-17 全项目复审与整改报告（历史快照）](audits/2026-08-17-full-project-audit.md)
- [Phase 0 临时目录与 Windows NLA 10108 事件记录](current/2026-08-13-phase0-temp-and-windows-nla-incident.md)：说明 `%TEMP%\phase0-*` 的来源、误入图搜范围的原因、安全清理边界，以及 Electron 启动时 `WSALookupServiceBegin 10108` 的系统诊断和管理员复验步骤。
- [VAL-003/VAL-011 计划任务安全加固](current/2026-08-12-value-observation-scheduler-hardening.md)
- [2026-08-02 全项目多维审计（历史快照）](audits/2026-08-02-full-project-multidimensional-audit.md)
- [2026-07-28 全项目综合审计（历史快照）](audits/2026-07-28-full-project-audit.md)
- [2026-07-27 项目规模与完成度审计](audits/2026-07-27-project-scale-completeness-audit.md)
- [2026-07-18 NekoSearch 完整多维审计](audits/2026-07-18-neko-search-complete-audit.md)
- [2026-07-18 路径型 IPC 所有权分模块审计](audits/2026-07-18-path-ipc-ownership-audit.md)
- [2026-07-15 NekoSearch 多维审计](audits/2026-07-15-neko-search-multidimensional-audit.md)
- [2026-07-13 项目多维审计](audits/2026-07-13-project-multidimensional-audit.md)
- [2026-07-10 当前状态审计](audits/2026-07-10-project-current-state-audit.md)
- [2026-07-09 多角度审计](audits/2026-07-09-project-multidimensional-audit.md)
- [2026-07-05 全量审计](audits/2026-07-05-project-full-audit.md)
- [CVE 与 Electron 安全审计](audits/2026-06-22-security-cve-audit.md)
- [浏览器视频合成链排查](audits/2026-06-22-browser-video-compositor-investigation.md)
- [IPC 能力矩阵](reference/ipc-capability-matrix.md)
- [Native 构建产物说明](reference/native-build-artifacts.md)
- [文档规范](reference/documentation-standard.md)
- [模型、运行时与文档确认规范](reference/model-runtime-and-document-confirmation.md)
- [Git 工作流与提交机制](reference/git-workflow-and-commit-policy.md)

## 历史记录

- [项目进度与审计长日志](history/project-progress-and-audit-log.md)
- [2026-07-10 优化完成记录](history/2026-07-10-optimization-completion-log.md)
- [2026-07-12 文档结构迁移记录](history/2026-07-12-documentation-reorganization.md)

历史文档保留原始判断以支持追溯。已经完成或被推翻的结论不从历史文档删除，而是在当前文档中记录替代关系。

## 维护要求

1. 新文档遵循[文档规范](reference/documentation-standard.md)。
2. 当前实现变化先更新 `current/`，专项方案变化再更新对应目录。
3. 测试结果必须记录命令、通过数量和未验证项。
4. 不在根目录新增零散文档；根目录只保留本索引。
5. 文件移动或重命名后必须更新仓库内引用并检查失效路径。
