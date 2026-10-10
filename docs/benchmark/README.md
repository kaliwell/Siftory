# Benchmark 输出说明

[2026-08-29：运行内存 UI 生命周期、规模上限与混合长稳入口](2026-08-29-runtime-memory-ui-scale-and-soak.md)。

[2026-08-29：Embedding 实时 RAM/VRAM 资源治理验收](2026-08-29-runtime-memory-embedding-resource-governance.md)。

[2026-08-29：DINO 融合预处理默认关闭影子验证](2026-08-29-runtime-memory-dino-fused-shadow.md)。

本目录用于保存可复现的性能基准结果，避免性能优化只依赖主观体验。

当前固定硬件首次建库基线：[2026-08-26 PxHere 1000 张三轮正式基线](2026-08-26-fixed-hardware-first-build-baseline.md)。

人工整理的当前报告：[Media Search 速度基准](2026-07-04-media-search-speed-benchmark.md)。

Manifest 缓存基线：[10K/100K Manifest Cache Benchmark](2026-07-12-media-search-manifest-cache-benchmark.md)。

Electron 真实渲染验证：[Electron UI 冒烟测试报告](2026-07-12-electron-ui-smoke-report.md)。

正式安装包验证：[2026-07-14 最新 NSIS 安装包验证报告](2026-07-14-release-installer-verification.md)。

真实素材准确率：[MediaSearch Recall@K 基线](2026-07-12-media-search-real-recall-baseline.md)。

文本语义人工标注：[MediaSearch 人工文本语义标注集](2026-07-12-media-search-text-annotation-dataset.md)。

视频准备流水线：[PREP-003 视频准备分块流水线验证](2026-08-22-media-preparation-pipeline-prep003.md)。

图片准备流水线：[PREP-005 图片准备增量流水线验证](2026-08-22-image-preparation-pipeline-prep005.md)。

PxHere 1000 张阶段诊断：[图片准备速度与阶段间隔诊断](2026-08-22-pxhere-1000-image-preparation-diagnostic.md)。

详细阶段与资源曲线：[PREP-011 图片准备阶段归因验证](2026-08-22-image-preparation-stage-attribution-prep011.md)。

Embedding 策略矩阵：[PREP-012 DirectML batch/worker 受资源约束矩阵验证](2026-08-22-embedding-policy-matrix-prep012.md)。

扫描/Embedding 联合调度：[PREP-014 图片扫描与 Embedding 联合调度矩阵验证](2026-08-22-image-joint-scheduling-prep014.md)。

Native JPEG 候选：[PREP-015 Native JPEG WIC 影子解码验证](2026-08-22-native-jpeg-shadow-prep015.md)。

CLIP Tensor 预取：[PREP-017 CLIP 低内存 Tensor 预取验证](2026-08-22-embedding-tensor-prefetch-prep017.md)。

Image Search ANN：[PREP-007 Q8 投影候选与精确重排验证](2026-08-22-vector-ann-q8-projection-prep007.md)。

NekoSearch ANN：[PREP-008 批量候选与精确重排验证](2026-08-22-neko-search-ann-prep008.md)。

Image Search 数据目录：[PREP-009 append-tail 与祖先汇总增量刷新验证](2026-08-22-image-data-catalog-incremental-prep009.md)。

NekoSearch 准确率门禁：[NekoSearch 准确率门禁工具链](2026-07-18-neko-search-accuracy-gate.md)。

## 当前门禁状态（2026-08-26）

- 固定硬件首次建库正式基线已建立：PxHere 1000 张、连续 3 轮、`overlap/gpu/jobs=2/batch=4/scan=2`，DINO/CLIP 三轮实际 Provider 均为 `dml` 且无回退；Ready P50/P95 为 `265833.94/270172.98 ms`，接受报告 SHA-256 为 `29a34b9300b0aa673bec55632735799ac5bab70eb93768b967723b166673bfe2`。详见[固定硬件首次建库三轮性能基线](2026-08-26-fixed-hardware-first-build-baseline.md)。
- PREP-011 已通过：256 图详细指标三轮 P50 开销 `+0.149%`，1000 图最终资源轮 `1187` 个样本、`0` 错误且无需检查点恢复；DINO/CLIP 前推理阶段分别占 `63.14%/78.24%`。详见[PREP-011 验证](2026-08-22-image-preparation-stage-attribution-prep011.md)。
- PREP-012 已完成筛选：DINO/CLIP 当前 `jobs=2,batch=4` 均快于单 worker，batch 8/16 的其余组合未过生产 RAM/VRAM 预检；没有至少快 5% 的候选，1000 图决赛不适用且生产策略不变。详见[PREP-012 验证](2026-08-22-embedding-policy-matrix-prep012.md)。
- PREP-014 已完成筛选：256 图 18 轮联合矩阵中，其余实际可比组合比当前 `scan=3,jobs=2,batch=4` 慢 `22.30%–49.32%`；scan=4 被资源策略限制为有效 scan=3，没有候选进入 1000 图决赛。详见[PREP-014 验证](2026-08-22-image-joint-scheduling-prep014.md)。
- PREP-015 已拒绝：256 张 JPEG 的 WIC/stb 影子比较中 `218/256` 至少一个感知哈希不一致；生产继续使用原 SEH/stb 全尺寸解码和双哈希语义。详见[PREP-015 验证](2026-08-22-native-jpeg-shadow-prep015.md)。
- PREP-017 已完成筛选并 `deferred`：单独 CLIP 的 256 图三轮 P50 改善 `5.084%`、1000 图改善 `11.143%`，但完整准备 ready P50 仅改善 `0.513%`，未过 5% 门槛；向量摘要一致且内存下降，候选默认关闭。详见[PREP-017 验证](2026-08-22-embedding-tensor-prefetch-prep017.md)。
- PREP-008 同一当前活跃集上的 exact/ANN 三轮受控 A/B 已通过：Top-50 100%，人工质量指标无下降，P95 改善 69.36%。详见[PREP-008 验证](2026-08-22-neko-search-ann-prep008.md)。
- PREP-009 当前真实 11.36 GiB 向量源三轮无变化刷新均为零向量读取，P95 12.452 秒；隔离追加比干净全量改善 76.72%，逐行目录结果、汇总和逻辑 SHA 一致。详见[PREP-009 验证](2026-08-22-image-data-catalog-incremental-prep009.md)。
- NekoSearch 完整 exact `--gate` 已成功跑完，当前 `hybrid` 的 P@20/P@50/nDCG@20 均为 1、拒绝侵入为 0；命令仍按设计判为**不可比较**，因为当前 266,001 条活跃集的指纹不同于旧基线的 245,171 条。旧基线未被覆盖。
- REL-01 已将开发态 `smoke:ui` 改为稳定测试标识，并于 2026-07-28 完成 `zh-CN`、`en` 双语验证和运行时语言往返切换；当前安装器 packaged smoke 尚未补做，因此开发态结果仍不能替代发布证据。
- 2026-07-28 安装器归档校验通过，但安装器未签名，且未执行安装后的当前版本 UI smoke。
- 完整审计结论和复现边界见[2026-07-28 全项目综合审计](../audits/2026-07-28-full-project-audit.md)。

`artifacts/` 中的原始 benchmark、标注和 smoke 输出默认不入 Git。需要长期引用的结论必须写入本目录的 Markdown/JSON 基线或对应审计报告，并注明日期、数据集和执行环境。

## 可用脚本

```bash
npm.cmd run benchmark:native
npm.cmd run benchmark:media-search
npm.cmd run benchmark:media-search:preparation:ab
npm.cmd run benchmark:image-search:preparation:ab
npm.cmd run benchmark:image-search:preparation:analyze
npm.cmd run benchmark:image-search:joint-scheduling
npm.cmd run benchmark:image-search:joint-scheduling:analyze
npm.cmd run benchmark:image-search:jpeg-shadow
npm.cmd run benchmark:image-search:embedding-prefetch:analyze
npm.cmd run benchmark:media-search:ipc-scan
npm.cmd run benchmark:media-search:manifests
npm.cmd run benchmark:media-search:recall
npm.cmd run benchmark:vector-ann:prep007
npm.cmd run benchmark:neko-search:prep008
npm.cmd run benchmark:data-catalog:prep009
npm.cmd run annotation:text:prepare
npm.cmd run annotation:text:serve
npm.cmd run annotation:text:evaluate
npm.cmd run annotation:text:status
npm.cmd run annotation:text:backup
npm.cmd run annotation:text:smoke
npm.cmd run annotation:neko:prepare
npm.cmd run annotation:neko:serve
npm.cmd run annotation:neko:evaluate
npm.cmd run annotation:neko:status
npm.cmd run annotation:neko:acceptance
npm.cmd run annotation:neko:backup
npm.cmd run annotation:neko:smoke
npm.cmd run benchmark:neko-search:accuracy
npm.cmd run test:neko-search-cluster
npm.cmd run smoke:ui
npm.cmd run smoke:ui:packaged
npm.cmd run smoke:installer:archive
```

## 输出约定

- `media-search-benchmark-*.json`：MediaSearch 扫描、元数据、缩略图阶段耗时。
- `media-search-benchmark-*.summary.json`：适合对比的摘要指标。
- `media-search-perf-samples-*.jsonl`：逐样本耗时。
- `media-search-ipc-scan-*.json`：IPC 任务链路基准。
- `media-search-ipc-scan-*.summary.json`：IPC 基准摘要。
- `media-search-ipc-scan-perf-*.jsonl`：IPC 逐事件耗时。
- `artifacts/benchmark/media-preparation-pipeline/<timestamp>/`：PREP-003 三轮串行/重叠原始报告、向量 parity、资源与门禁摘要。
- `artifacts/benchmark/image-preparation-pipeline/<timestamp>/`：PREP-005/011/012/014/015/017 三轮串行/重叠、温更新、向量/hash parity、详细阶段归因、资源与策略矩阵门禁摘要，以及逐轮 `*.timeline.ndjson`、`stage-analysis.*`、`matrix-analysis.*`、`analysis*.json` 和 `shadow-report.json` 诊断。
- `artifacts/benchmark/vector-ann-prep007/<timestamp>/`：PREP-007 真实缓存 50 样本的候选比例、Recall@50、首位一致率、P50/P95、资源与源只读门禁。
- `artifacts/benchmark/neko-ann-prep008/<timestamp>/`：PREP-008 当前真实活跃集的 exact/ANN 三轮延迟、Top-K 重合、人工指标、active filter、资源与源只读门禁。
- `artifacts/benchmark/data-catalog-prep009/<timestamp>/`：PREP-009 真实全量/三轮无变化刷新、隔离追加 A/B、读取字节、目录 parity、资源和源只读门禁。
- `benchmark:media-search:manifests`：生成 10K/100K synthetic video/frame manifest，比较完整加载与 UI Preview 的冷/热缓存耗时。

## 使用方式

1. 优化前运行对应 benchmark，保留输出文件。
2. 优化后再次运行同一脚本。
3. 对比 `summary.json` 中的 `totalMs`、阶段耗时、失败数和吞吐指标。
4. 如果总耗时下降但失败数上升，视为回归。
5. 如果某阶段耗时增加超过 20%，需要确认是否由输入样本变化导致。

## 注意

MediaSearch benchmark 依赖本机媒体样本、磁盘状态和 ffmpeg 可用性。结果适合做同机同数据集对比，不适合跨机器直接比较。
