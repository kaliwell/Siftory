# PREP-015 Native JPEG WIC 影子解码验证

> 状态：严格 parity 失败，候选拒绝  
> 日期：2026-08-22  
> 数据集：PxHere `pxhere-000000` 固定 256 张 JPEG，495,113,164 bytes  
> 基线：扫描使用 SEH 保护的 stb 全尺寸解码，再计算 DiffHash64/DctHash64

## 结论

WIC 缩放解码候选不能接入 Native 扫描。它保持了宽、高和通道数，但改变了感知哈希语义：

- 只有 `38/256`（14.84%）记录逐字段完全一致。
- `218/256`（85.16%）至少一个哈希不一致。
- DiffHash64 不一致 `171/256`（66.80%），DctHash64 不一致 `148/256`（57.81%）；其中 101 张两种哈希同时变化。
- 宽度、高度、通道和解码成功分类均为 `256/256` 一致，说明差异来自 WIC 与 stb 的灰度转换/缩放插值，而不是元数据采集错误。

严格门禁要求两个 64 位哈希逐图完全相同，不接受近似阈值。因此候选在性能接入前已经被拒绝，没有修改扫描默认路径，也没有运行无资格候选的 1000 图性能决赛。

## 方法

1. 使用当前生产 scan=3 路径扫描固定语料，生成 SEH/stb 全尺寸解码的权威记录。
2. 仅在 `REASONIX_NATIVE_PARITY_FIELDS=1` 时让线性快照额外导出通道和双哈希；默认快照结构及生产开销不变。
3. 对相同文件调用既有 WIC 缩放单图路径，逐图比较宽、高、通道、DiffHash64、DctHash64 和解码成功状态。
4. 差异样本只记录不可逆 16 位 ID 和差异字段，不记录路径、文件名或哈希正文。
5. 源文件运行前后做元数据快照，资源由独立 PowerShell 采样器记录。

## 结果

| 指标              |              stb 扫描基线 |                 WIC 影子 | 判定                       |
| ----------------- | ------------------------: | -----------------------: | -------------------------- |
| 输入/成功         |                   256/256 |                  256/256 | 一致                       |
| 宽高不一致        |                         0 |                        0 | 通过                       |
| 通道不一致        |                         0 |                        0 | 通过                       |
| DiffHash64 不一致 |                         0 |                      171 | 失败                       |
| DctHash64 不一致  |                         0 |                      148 | 失败                       |
| 任一字段不一致    |                         0 |                      218 | 失败                       |
| 完全一致          |                       256 |                       38 | 失败                       |
| 墙钟              | 29.619 s（3 worker 扫描） | 68.357 s（逐图同步影子） | 执行模型不同，不作速度 A/B |

WIC 影子阶段 256 次均明确报告 `jpeg_wic`。影子墙钟包含逐文件同步调用和每次 WIC 初始化，不能与三 worker 扫描直接比较；由于 parity 已失败，本任务没有为候选增加集成扫描开关来制造一个无资格的性能数字。

## 边界与安全验证

| 门禁          | 结果                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| 资源采样      | 652 个样本、错误 0、process-race skip 0                                                           |
| 内存          | 主进程 RSS 峰值 673.29 MiB；系统最低空闲 2605.89 MiB                                              |
| 源只读        | 256 图快照 SHA-256 `686a2439f6353bba24c6e625c6994e65866dfac9757afe2e79171ae5c3c8eae0`，运行后未变 |
| 格式/错误边界 | Native PNG、JPEG、GIF、非图片、缺失文件、>64 MiB、超维度、超像素和解码内存预算回归通过            |
| 扫描生命周期  | 多根目录、Unicode、签名伪装、并发/暂停/停止、commit feed、缩略图和索引生命周期回归通过            |
| 专项回归      | `native-decode`、`native-hash`、`native-scan` 合计 53/53 通过                                     |

非 JPEG 格式没有切换到 WIC 候选，继续走原有受限 stb 路径。损坏和解码炸弹边界也没有为了评测而放宽。

## 决策与后续

1. 生产扫描继续使用现有 SEH/stb 全尺寸双哈希路径。
2. 不把 WIC 哈希写入索引，不改变近重复搜索排序，也不新增迁移。
3. 若未来引入 libjpeg-turbo，只能以“解码像素语义与 stb 完全一致”的方式重新执行相同逐图门禁；仅有速度收益不能覆盖 hash parity 失败。
4. `REASONIX_NATIVE_PARITY_FIELDS` 和实际 backend 标签只服务于诊断，默认关闭。

## 复现与产物

```powershell
npm.cmd run benchmark:image-search:jpeg-shadow -- "D:\PxHereDataset\images\pxhere-000000" --sample=256 --scan-workers=3 --timeout-ms=600000 --out-dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep015"
node --test tests/native-decode.test.cjs tests/native-hash.test.cjs tests/native-scan.test.cjs
```

- 影子验证 JSON（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep015/shadow-report.json`）
- 逐阶段 NDJSON（本机产物：`artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep015/shadow.timeline.ndjson`）
- [PREP-011 阶段归因](2026-08-22-image-preparation-stage-attribution-prep011.md)
- [当前速度优化方案](../current/2026-08-22-image-preparation-speed-optimization-plan.md)


2026-09-24 归档说明：以上 `artifacts/` 路径为未随源码分发的本机历史证据位置。源码副本不包含这些原始产物；历史摘要保留，不代表在当前副本重新运行或验证。
