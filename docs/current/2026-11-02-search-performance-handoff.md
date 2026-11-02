# 搜索性能优化与本地验收分工

> 状态：当前  
> 实施范围：云端 CPU 优化已实现，真实数据与硬件验收待执行  
> 更新日期：2026-11-02  
> 基线：Alpha 15 / `71044a2`

## 执行归属

本轮执行者为云端 Codex，GPT-6 系列，精确版本未知。文档入口为 `docs/README.md`；事实优先级为当前源码与本次测试高于历史优化方案。云端使用独立 worktree `task/vector-rerank-performance`，没有启动子代理，也没有启动用户电脑上的 Codex 会话。

| 任务                                        | 执行系统与所有者              | 状态                     |
| ------------------------------------------- | ----------------------------- | ------------------------ |
| CPU 合成基准、实际 ANN 精排优化与分阶段计时 | 云端 Codex / 当前会话         | 已实现，见下方验证命令   |
| 真实图库的标量/优化版对照、向量召回验收     | 本地 Codex / 用户电脑上的会话 | 工具已准备，待执行       |
| GPU 吞吐、显存与批量参数                    | 本地 Codex / 用户电脑上的会话 | 待执行，需要实际 GPU     |
| NAS 连续更新、断线与重连                    | 本地 Codex / 用户电脑上的会话 | 待执行，需要实际共享目录 |
| 原生 AVX2、调整 ANN 候选比例或替换索引算法  | 尚未分配                      | 等待基准证据，本轮未实现 |

## 已实现

实际 ANN Worker 使用 `F16SnapshotReader` 分页精排，而不只是内存中的 `scoreVectorAnnCandidates`。两者现共用一个懒加载的 65,536 项 Float16 查表内核，每个使用该内核的进程或 Worker 增加 256 KiB 表，不展开整库 Float32，也不复制向量文件。

内核保持原有逐维加法顺序，以显式小端字节解码处理奇数 Buffer 偏移及不同 CPU 字节序。原有 topK、同分行为、取消检查、分页预算与源文件变化检查保留；向量、分片和缓存格式不变。设置 `SIFTORY_F16_RERANK_SCALAR=1` 并重启应用可恢复逐维标量解码，便于实机对照。

ANN 搜索返回 `timings.scopeMs/candidateMs/rerankMs/pathMappingMs`，批量查询另返回每个中心的阶段耗时与汇总。`loadMs` 沿用原字段，`searchMs` 沿用包含加载的 Worker 总时间。运行时 trace 的精排事件使用实际精排耗时，总事件不再重复累加加载时间。这里不包含图片解码、查询模型推理或 UI 展示，不能视为完整用户等待时间。

## 云端验证

```bash
node --test tests/f16-dot-product.test.cjs tests/f16-snapshot-reader.test.cjs tests/vector-ann-index.test.cjs
npm run build:renderer
node --test tests/vector-ann-worker.test.cjs tests/vector-ann-integrity-proof.test.cjs tests/vector-ann-projection-sidecar.test.cjs tests/ann-prewarm.test.cjs
npm run benchmark:vector-rerank
npm run benchmark:vector-local -- --fixture --samples=3
```

回归包括全部 65,536 种半精度编码、奇数 Buffer 偏移、非法边界、跨页与 base+delta、同分、取消、索引完整性及实际 Worker 阶段计时。

首次云端合成测量为 20,000 行 × 768 维、4,000 个候选、15 个计时查询：标量精排 P50 约 16.44 ms，查表约 8.89 ms，约 1.85 倍；P95 约 1.57 倍。分数和排名完全一致。这是一次共享云端 CPU 的测量，不是 Windows、GPU、真实素材或 NAS 结论。正式比较使用同机器重复运行后的报告；CI 只要求正确性，不设易受负载影响的速度阈值。

另一次 100,000 行 × 768 维、20,000 个候选的分页精排测量：P50 约 108.94 → 71.34 ms，P95 约 122.97 → 74.74 ms。2,048 行 × 128 维的小型完整 ANN 夹具则没有显示稳定的整体加速，标量/查表 P50 约 1.89/2.02 ms；不能把精排加速比例直接当成整条搜索链路的提升。合成完整链路的普通与 base+delta 夹具均通过分数、排名及召回对照。

报告位于 `artifacts/benchmark/vector-rerank/latest.json`。第一轮读取单列，排除两轮预热后统计 P50/P95；操作系统文件缓存不受控，不能将首次读取称为冷盘时间。报告采样 RSS，基准同时持有两套 reader 与合成 Buffer，不能把它当作应用峰值内存。

## 给本地 Codex 的执行任务

先读取本文件与仓库的执行、Git 规范。拉取 main，使用项目锁定的 Node/npm 和依赖；不修改正在使用的数据目录。此次源码不升级安装包版本，打包另行执行。

### 1. CPU 与真实图库对照

正常退出 Siftory，确认迁移和建库已结束。先构建 Worker，再运行：

```powershell
npm run build:renderer
npm run benchmark:vector-rerank
npm run benchmark:vector-local -- --samples=20
```

真实验收脚本按迁移引导读取活动库，识别 authoritative generation、base+delta 和已有完整缓存；不自动重建缺失的模型向量。若需指定活动目录，使用 `--user-data="E:\SiftoryData\library"`，路径是应用数据根，不是素材目录。目标目录仍受活动库校验，不能把迁移保留的旧副本当作当前库。

脚本把完整向量/路径快照复制到系统临时目录，只在副本旁生成 ANN 派生文件，原文件以只读方式校验；至少预留一份向量与路径文件的磁盘空间。它使用两个独立 Worker 对比标量与查表结果，检查向量 Top-50 是否进入 ANN Top-200，并记录候选量与阶段耗时。报告不包含素材路径、查询向量或命中内容。该过程不运行 GPU，也不测原图读取。

验收要求：标量与优化版分数、顺序完全一致；源文件 SHA256 不变；平均 Recall@50 in Top-200 ≥ 99.5%，最低 ≥ 96%，第一名与精确向量基线一致。召回门槛衡量近似搜索相对精确向量搜索的损失，不是人工相关性评分。真实报告在 `artifacts/benchmark/vector-local/latest.json`；重复运行时归档每份结果，至少三轮，并记录后台任务是否关闭。若召回未达标，保留报告诊断，不通过缩小样本或降低门槛放行。

### 2. GPU 与完整搜索等待时间

使用现有 `benchmark:memory:model-session`、`benchmark:memory:scale` 等工具前先阅读对应脚本参数与固定硬件验收文档。记录实际推理后端（CPU/DirectML/CUDA）、模型、GPU 型号、驱动、批量与并发。使用同批素材对比吞吐、进程内存和显存；不能用 CPU 精排加速代替 GPU 推理结论。

分别记录图片预处理、查询模型推理、ANN、缩略图与 UI 的耗时。已有 batch 4/8/16 策略先测再调；不先提高默认并发、不绕过 CUDA 质量门槛。这里需要本地执行与真实硬件，云端尚未验证。

### 3. NAS 更新与后续决策

在现有共享目录连续执行两次“更新”，记录新增/更新/未变更计数、总耗时、有效素材数和物理历史数；第二次未变更文件不得继续产生版本。补测断线、取消、重连，确认未把临时离线判断为素材已删除。此步骤复用当前共享目录索引修复，属于实机验收，不代表云端本轮修改了扫描算法。

把两个 JSON 报告和 GPU/NAS 的统计结论交回当前会话；不需要上传素材、数据库、路径表或向量文件。若精排仍占主要时间，再实现原生 SIMD；若候选阶段占比更高，在真实召回门槛下调优投影或评估 HNSW；若模型推理占主导，优先处理 GPU 流水线。每次只变一个因素，保持可比较的基线。
