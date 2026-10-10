# NekoSearch 准确率门禁工具链

> 状态：当前  
> 更新日期：2026-07-30
> 范围：NekoSearch 分类检索准确率、聚类质量、回归门禁

本文档描述 NekoSearch 的固定人工标注集与准确率回归门禁：工具组成、指标定义、门禁阈值、使用流程和已知边界。对应审计问题 `NKS-P1-04`（缺少固定人工标注准确率发布门禁）。

> 数据源（2026-07-19 起）：关系数据（categories / asset_categories / suggestions / cluster_groups / cluster_group_assets）以 `asset-library.sqlite` 为权威。标注工具与准确率基准通过 `tests/guard-utils.cjs` 的 `relationJsonlDir()` 读取——未迁移库直接读 JSONL，已迁移库先 `exportJsonl` 到临时目录再读，语义不变。`assets.jsonl` 与向量 JSONL 仍在原位置直读。

## 工具组成

| 工具            | 命令                                             | 用途                                                                     |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 标注数据集构建  | `npm.cmd run annotation:neko:prepare`            | 生成候选池与预填标签；`--category=id\|name` 可只构建单分类               |
| 标注 UI         | `npm.cmd run annotation:neko:serve`              | 本地 Web 标注（127.0.0.1:41741），快捷键 1/2/3/0                         |
| 标注进度        | `npm.cmd run annotation:neko:status`             | 按 Top10/20/50/Pool 分层报告进度，区分 seeded/manual                     |
| ACC-02 验收门禁 | `npm.cmd run annotation:neko:acceptance`         | 五类覆盖、人工审计、集合完整性、原型泄漏和完成度门禁；未满足时退出码为 2 |
| 标注指标        | `npm.cmd run annotation:neko:evaluate`           | 对 prepare 时 CLIP/DINO 排序计算 Precision/Recall/nDCG                   |
| 标注备份/恢复   | `npm.cmd run annotation:neko:backup` / `restore` | 指纹校验，恢复需 `--confirm`                                             |
| 工具自测        | `npm.cmd run annotation:neko:smoke`              | 机器无关 fixture 自测                                                    |
| 准确率基准      | `npm.cmd run benchmark:neko-search:accuracy`     | 4 变体全库评估 + 门禁比对；`--category=id\|name` 可只评估单分类          |
| 聚类回归        | `npm.cmd run test:neko-search-cluster`           | 合成样本确定性/纯度/稳定性测试（已入 `npm test` 链）                     |

数据位置：标注数据在 `artifacts/neko-search-annotation/`（不入库）；基准原始报告在 `artifacts/neko-search-accuracy/latest.json`；正式基线在 `docs/benchmark/neko-search-accuracy-baseline.json`（仅 `--write-baseline` 写入）。

## 标注数据集

`prepare` 对每个分类生成候选池：

1. CLIP Top60：confirmed 正样本多原型（上限 32 个，确定性均匀抽样）全库 max-cosine 排序。
2. DINO Top60：同法，DINO Float16 缓存。
3. confirmed/hard-negative：全部 confirmed 正样本与 rejected/ignored 负样本分别记录，不再混在同一个 `review` 来源中。
4. random：20 个确定性随机样本（sha256 种子）。

审核状态预填为 `origin:'seeded'` 标签（confirmed→relevant，rejected/ignored→not_relevant）；人工标注为 `origin:'manual'`。seeded 标签可被人工复核改写，manual 标签永不被 prepare 覆盖。

ACC-02 数据集还必须通过 `--class-map=<json>` 将素材库分类映射到固定语义类。映射文件只保存在本地，不进入 Git，格式如下：

```json
{
  "version": 1,
  "categories": {
    "素材库分类 ID": "people_characters",
    "另一个分类 ID": "screenshots_text_ui"
  }
}
```

允许的类为 `people_characters`、`screenshots_text_ui`、`products_objects`、`animals`、`scenes_environments`。构建器会记录每类的 CLIP/DINO 原型 ID，并从两份评测排序中排除原型自身，防止 self-match 把准确率虚高。`acceptance` 只把有匹配审计事件的 `origin:'manual'` 判定计入人工占比；每类还必须满足：独立 confirmed 正样本和 hard negatives 非空、人工占比至少 70%、候选池以及 Top20/Top50/随机池全部判定、无原型自匹配。

## 基准评估变体与指标

每分类执行一次 CLIP 全库流式扫描和一次 DINO 全库流式扫描，由两份分数映射派生 4 个变体对候选池的排序：

| 变体              | 定义                                             |
| ----------------- | ------------------------------------------------ |
| `clip`            | CLIP 正样本多原型 max-cosine                     |
| `dino`            | DINO 正样本多原型 max-cosine                     |
| `hybrid`          | 0.25×CLIP + 0.75×DINO（生产权重）                |
| `hybrid_feedback` | hybrid − 0.65×最近负样本余弦（生产 Reject 抑制） |

指标：Precision@20/50、Pooled Recall@50、nDCG@20、Reject intrusion@20（Top20 中 judged not_relevant 占比）、扫描延迟 mean/p50/p95/max、留一法 AUC（仅审核集诊断，不代表全库精度）。聚类质量只读现有 cluster store：成员 similarity 中位 purity、未分组比例。

## 门禁阈值（`--gate` 对基线）

质量阈值只应用于基线声明的 `primaryVariant`（当前为 `hybrid`）。`clip`、`dino` 与
`hybrid_feedback` 保留在报告中用于诊断和趋势对比，不单独阻断发布；其中
`hybrid_feedback` 使用与审核状态重叠的负样本，不能作为独立发布真值。

- nDCG@20 相对降幅 >2% → 失败
- Precision@20 降 >2pt → 失败
- Recall@50 降 >1pt → 失败
- Reject intrusion 绝对值 >5% 或较基线 +1pt → 失败
- 扫描 p95 >基线 1.5× → 失败
- 聚类 purity 中位 <0.80 → 警告（人工 purity 待标注后升级）

无基线时只记录不门禁；provisional（标注未完成）结果拒绝门禁。

## 使用流程

```text
annotation:neko:prepare -- --class-map=<本地映射.json>  # 构建/刷新五类候选池
annotation:neko:serve          # 人工标注，优先覆盖 Top10→Top50
annotation:neko:status         # 确认候选池判定完成
annotation:neko:acceptance     # ACC-02 五类发布就绪门禁
benchmark:neko-search:accuracy --write-baseline   # 首次记录基线
benchmark:neko-search:accuracy --gate             # 之后每次算法变更后门禁
```

## 当前数据现状（2026-07-20）

- 首个正式基线已记录（2026-07-20，`--category=12 --write-baseline`）：test01（57 confirmed 正样本、147 候选、147/147 判定、122 manual）。hybrid 主门禁变体：P@20=1.0、P@50=1.0、R@50=0.641、nDCG@20=1.0、Reject intrusion@20=0、扫描 p95 36,984.9ms；聚类 purity 加权中位 0.8016（≥0.80 达标）。基线文件：`docs/benchmark/neko-search-accuracy-baseline.json`。
- 当前仅 test01 单分类，宏平均代表性有限；新分类积累 confirmed 样本后重新 `prepare` 即可纳入。
- girlsockhighheels 与 dual-validation-test 为历史临时分类，其 717 条标注保留为 stale 记录（prepare 自动忽略）。
- 截图、产品、中文文本等路线图要求的覆盖方向取决于真实库分类建设进度。
- 指标边界：候选池包含充当原型的 confirmed 正样本自身，P@K 接近满分、4 变体一致属预期；基线的主要价值是同数据集回归对照（`--gate`），不代表全库真实精度。

## ACC-02 当前验收审计（2026-07-30）

本轮只读复制现有标注文件到隔离目录后执行新门禁，未改写素材库或正式标注文件。结果为预期的 **未就绪（exit 2）**：

- 当前固定数据集仍只有 `test01` 1 类、147 个候选，五个固定语义类均未映射。
- 当前数据集采用旧来源结构，尚未独立记录 confirmed 正样本和 hard negatives；重新 `prepare -- --class-map=...` 后才会生成新结构。
- 48 条现有 manual 判定有审计事件，但只占当前候选池 32.7%，低于 70%。
- 1 个候选源文件 `Desktop\download.png` 已不存在，完整性门禁正确失败；工具未尝试恢复、删除或改写该记录。
- 素材库现有分类名不足以可靠判定五个目标语义，自动映射会把推测伪装成人工真值，因此必须先由用户建立/确认五类语义映射并完成图片判断。

门禁报告写入 `artifacts/neko-search-annotation/acc-02-acceptance.json`，只含指纹、计数和分类级摘要；图片源文件与人工判断文件继续不进入 Git。

## 当前门禁结果（2026-07-28）

2026-07-28 使用当前真实库执行 `npm.cmd run benchmark:neko-search:accuracy -- --gate`，门禁失败。排序质量指标没有回退，失败项仅为全库扫描延迟：

| 指标                 |   当前结果 |                         基线/阈值 | 判断     |
| -------------------- | ---------: | --------------------------------: | -------- |
| Precision@20         |      1.000 |                相对降幅不超过 2pt | 通过     |
| Precision@50         |      1.000 |                相对降幅不超过 2pt | 通过     |
| Pooled Recall@50     |      0.641 |                相对降幅不超过 1pt | 通过     |
| nDCG@20              |      1.000 |                 相对降幅不超过 2% | 通过     |
| Reject intrusion@20  |          0 |     不超过 5%，且较基线不增加 1pt | 通过     |
| 扫描 p95             | 62,507.1ms | 基线 36,984.9ms；上限 55,477.35ms | **失败** |
| 聚类 purity 加权中位 |     0.8059 |                    低于 0.80 警告 | 通过     |
| 未分组比例           |     0.8397 |                            观察项 | 记录     |

本次 CLIP 扫描 303,228 个向量，用时 62,507.1ms；DINO 扫描 295,339 个向量，用时 40,162ms。候选池仍为 test01 单分类 147 条，其中 99 条 seeded、48 条 manual。聚类快照为 209 组。

因此，当前状态不能表述为“准确率门禁已通过”。质量指标满分仍受原型自包含和单分类样本限制，发布前需要：

1. 对向量分片执行可验证的垃圾回收，评估二进制缓存、内存映射或 ANN，先恢复扫描延迟。
2. 扩充多个真实分类的人工标注，覆盖中文文本、截图、产品和人物等不同视觉分布。
3. 优化后在同机、同数据集重新执行 `--gate`，保留原始报告和机器环境说明。

原始报告写入 `artifacts/neko-search-accuracy/latest.json`，该目录不入 Git；本次审计摘要保存在[2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)。

## 泄漏边界

`hybrid_feedback` 的负样本来自标注/审核状态，与 seeded 标签重叠，其指标偏高属预期，仅作趋势参考；`hybrid`（无反馈）为主门禁变体。留一法 AUC 只说明已审核样本可分，不代表约 18 万未标注全库的 Precision@K。

## 验证（2026-07-18）

| 项目         | 命令                                         | 结果                                   |
| ------------ | -------------------------------------------- | -------------------------------------- |
| 工具自测     | `npm.cmd run annotation:neko:smoke`          | 通过                                   |
| 数据集构建   | `npm.cmd run annotation:neko:prepare`        | 通过；563 候选、537 seeded、只读真实库 |
| 聚类回归     | `npm.cmd run test:neko-search-cluster`       | 5/5 通过                               |
| 基准就绪门禁 | `npm.cmd run benchmark:neko-search:accuracy` | 正确报缺口 26 并 exit 2                |
