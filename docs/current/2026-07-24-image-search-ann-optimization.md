# Image Search Similar ANN 检索优化

> 状态：当前  
> 更新日期：2026-07-24  
> 范围：Image Search Standard / Precise 的 DINO 相似图片召回  
> 前置记录：`2026-07-23-image-search-similar-performance.md`  
> Git 边界：仓库已初始化，但当前仍无首个提交；本轮属于未提交现场

## 执行身份与事实来源

- 执行身份：Codex。
- 模型信息：GPT-5 系列；运行时未提供可可靠确认的精确小版本。
- 本轮没有启动 Codex 子代理，也没有读取或代替用户此前说明的 Kimi agents。
- 事实优先级：当前源码和测试结果 > 本文档 > 旧方案。

## 已完成

在上一阶段 Float16 精确检索的基础上，增加了内置、版本化的稀疏 SimHash
多探针 ANN 召回，并用 Float16 向量对候选做精确重排：

1. 48 位确定性稀疏投影签名，分为 4 个 12 位 band。
2. 查询采用 Hamming 半径 4 的多探针召回，ANN Top-K 默认按请求 Top-K 的
   4 倍过采样，最低增加 100 条，最高 5000 条。
3. 候选仍使用原始 Float16 DINO 向量计算精确余弦分数，不把哈希距离直接作为最终排名。
4. ANN 查询在独立常驻 Worker 中执行，不占用 Electron 主进程事件循环。
5. Worker 复用约 427 MiB 的向量 Buffer 和路径表；空闲 5 分钟自动释放，应用退出时立即释放。
6. 新查询会通过 `SharedArrayBuffer + Atomics` 取消旧查询，避免重复检索叠加。
7. ANN 结果继续经过当前 Image Search 活跃路径过滤；过采样后不足请求数量时，自动进入精确
   Float16 兜底。
8. ANN 关闭、构建失败、文件损坏、版本过期或查询异常时，自动回退上一阶段的精确检索。
9. 可用环境变量 `FLOATING_CLOCK_DISABLE_VECTOR_ANN=1` 强制关闭 ANN，用于诊断和结果对照。

这不是 HNSW 或 FAISS。当前实现没有引入新的原生依赖，便于随 Electron 安装包稳定发布；
代价是候选比例仍较高，性能上限低于成熟 HNSW。

## 派生索引与一致性

ANN 文件位于现有 DINO Float16 缓存旁：

```text
dinov2_vitb14__global.ann-simhash-v1.json
dinov2_vitb14__global.ann-simhash-v1.bin
```

真实库 291,680 行的签名文件约 2.23 MiB。元数据记录版本、模型、embedding 类型、维度、
记录数和 Float16 源指纹。签名文件先替换，元数据最后作为提交标记；缺失、长度不符、源指纹
变化或 JSON 损坏都会触发重建。ANN 是可再生派生数据，不覆盖原始图片、Image Search
manifest 或 DINO 原始向量。

首次查询会生成索引；之后直接复用。当前真实库首次构建约 1.8 秒，已有索引时首次加载向量和
路径约 0.36–0.57 秒。

## 真实库准确率与速度

数据源：

```text
<DATASET>
```

对 291,680 条、768 维 Float16 缓存执行 12 张确定性分层样本对照。每张图片先做精确
Top-50，再检查这些结果是否进入 ANN Top-200：

| 指标                          |            结果 |
| ----------------------------- | --------------: |
| 样本数                        |              12 |
| 平均 Recall@50 in ANN Top-200 |          99.67% |
| 最低 Recall@50 in ANN Top-200 |             96% |
| 查询图保持第一名              |           12/12 |
| 典型热 ANN 查询               | 约 0.80–1.14 秒 |
| 精确 Float16 对照             |   约 2.0–4.0 秒 |
| 12 样本总耗时加速             |         2.49 倍 |

存在一次 6.19 秒 ANN 尾延迟；同批其他查询以及 6 样本复测没有复现，6 样本总耗时加速为
3.15 倍。该异常不能据此认定已经消除，后续应以应用内 P50/P95/P99 长时间采样继续判断。

当前半径 4 会召回约 19 万至 26.6 万候选，占 291,680 行的约 65%–91%。半径 2 和 3
虽然更快，但真实样本最低召回分别出现约 58% 和 88%，因此没有放行。当前参数优先保证结果
质量，而不是追求最低延迟。

## 自动化验证

```text
npm.cmd run typecheck
node --test tests/vector-ann-index.test.cjs tests/vector-ann-worker.test.cjs \
  tests/embedding-f16-cache.test.cjs tests/vector-pipeline.test.cjs \
  tests/preload-contract.test.cjs tests/ipc-registration.test.cjs
npm.cmd run build:renderer
node tests/vector-ann-real-benchmark.cjs 12
```

结果：

- TypeScript 类型检查通过。
- 26/26 项核心与 ANN 回归测试通过。
- Worker 集成测试会创建临时向量库，首次生成索引，然后把签名文件破坏为 3 字节；再次查询
  确认自动重建、文件尺寸恢复且第一名正确。
- Renderer、主进程、preload 和包括 `vectorAnnWorker.js` 在内的 Worker 构建通过。
- 真实库 12 样本准确率门槛通过。

## 仍有的提升空间

1. 当前最终候选仍多，主要成本是 CPU 解码 Float16 和点积；这段不是模型推理，提高 GPU
   占用率不会自然提高检索速度。
2. 下一阶段可评估 HNSW/FAISS 或更高质量的多表 LSH，在 Recall 门槛不下降的前提下把候选
   降到全库的 5%–20%。
3. 路径 JSONL 可换成紧凑 row-to-path 二进制表，活跃路径可预计算为 row 位图，减少加载、
   JS 字符串内存和 ANN 后过滤。
4. 可把 Float16 解码点积改成原生 SIMD 批处理；这是当前内置方案最直接的进一步加速点。
5. 应增加应用内阶段指标和 P50/P95/P99 持久采样，区分 query embedding、ANN 召回、
   精确重排、活跃路径过滤和缩略图展示。

## 发布边界

`vectorAnnWorker.js` 已加入 Vite 构建和 Electron `extraResources`。完整 `npm.cmd run build`
已通过，构建日志确认 Worker 构建、TypeScript、Electron 原生模块、打包、NSIS 和 blockmap
阶段均完成；项目清理脚本随后按规则仅保留 installer。

最终产物：

```text
release/FloatingClock Setup 1.0.0.exe
大小：600,744,008 bytes
SHA-256：D28D5F7453098B8889C47C19BBA2DD974E3A681A7E88AC2B703A443DA8FB9E1F
```

本轮没有自动安装或覆盖当前运行版本。
