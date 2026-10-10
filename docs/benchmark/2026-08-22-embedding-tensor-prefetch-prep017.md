# PREP-017 CLIP 低内存 Tensor 预取验证

> 状态：已完成筛选；端到端收益不足，默认关闭并标记 `deferred`  
> 日期：2026-08-22  
> 数据集：`D:\PxHereDataset\images\pxhere-000000`，1000 个源文件，2,627,418,359 bytes  
> 适用范围：CLIP、GPU/DirectML、batch 大于 1；DINO、CPU、CUDA 和权威向量格式不变

## 结论

PREP-017 的低内存实现通过正确性、单模型吞吐、长样本、资源、暂停/停止边界和源只读门禁，但没有通过完整“一键准备”ready P50 至少改善 5% 的最终门禁。因此生产默认保持关闭，仅设置 `REASONIX_EMBEDDING_TENSOR_PREFETCH=1` 时启用诊断候选。

单独 CLIP 的固定 256 图三轮交错 A/B 从 `35.462 s` 降至 `33.659 s`，改善 `5.084%`；1000 图从 `125.756 s` 降至 `111.743 s`，改善 `11.143%`。但包含 Native、DINO、CLIP、持久化和索引的 256 图三轮 ready P50 仅从 `79.822 s` 降至 `79.413 s`，改善 `0.513%`。向量摘要一致且内存明显下降仍不能替代端到端收益门槛，机器结论为 `reject-and-defer`。

## 实现边界

1. 主进程只允许每个 CLIP 子进程领取一个下一 batch；深度固定为 `1`，batch 上限 `16`，processor tensor 上限 `16 MiB`。
2. 候选默认关闭，只在显式设置 `REASONIX_EMBEDDING_TENSOR_PREFETCH=1` 的 GPU/DirectML 诊断路径启用。CPU/CUDA、DINO、显式 batch、模型、输入尺寸、归一化、向量维度和持久化格式均未改变。
3. 下一 batch 只有在系统空闲内存至少 `1 GiB`、任务未暂停/停止且当前 lookahead 未满时才能领取。暂停和恢复向子进程发送控制帧；停止仍终止所属 worker。
4. 三通道图片在 Sharp 的同一解码图中完成 CLIP 固定的最短边 `224` bicubic affine resize，只把缩小后的 RawImage 交给原 processor 做中心裁剪和归一化，因此推理期间不再保留下一批全尺寸 RGB 像素。
5. 非三通道、超限或不能证明输出尺寸/通道契约的输入自动使用原 `RawImage.read` 路径。该回退保持原错误分类和结果语义，不用近似像素换速度。
6. 每批详细记录 decode/normalize、preprocess、inference、postprocess、fallback、tensor bytes、prepare/wait/overlap 和资源时间线；默认业务日志不保存源路径或向量正文。

## 被拒绝的迭代

### 完整 RawImage 预取

首个候选虽然在 16 图烟测中产生相同向量摘要，但会在 DirectML 阻塞 JavaScript 时保留下一批全尺寸 RawImage。子进程聚合峰值约从 `1939 MiB` 增至 `2339 MiB`，增加约 `400 MiB`，因此未扩大到 256 图，也未进入默认路径。

### Alpha 融合缩放

第一版低内存候选把所有 `1/3/4` 通道图片都放入融合缩放。1000 图首次决赛的源快照和成功数一致，但向量摘要不同。逐图影子比较定位到两张“扩展名为 `.jpg`、实际为 RGBA PNG”的输入：其中一张有 `64,088/150,528` 个预处理值不一致，最大绝对差 `0.030015588`。原因是带 Alpha 的融合插值不等价于 Transformers 先丢弃 Alpha、再从原始 RGB 做 affine。

该候选被自动拦截。修复后仅三通道输入走融合路径，两张 RGBA 边界样本均恢复 `150,528/150,528` 逐值一致；失败的首次 1000 图产物保留为负面证据，不计入最终收益。

## 预处理与向量正确性

| 检查                     | 结果                                                    |
| ------------------------ | ------------------------------------------------------- |
| 16 图预处理逐值比较      | `2,408,448/2,408,448` 完全一致，最大绝对差 `0`          |
| EXIF orientation `3/6/8` | 原解码 + resize 与融合解码逐值一致                      |
| RGBA/非三通道            | 自动回退原路径；两张真实边界样本逐值一致                |
| 256 图三轮向量摘要       | 六轮均为 `48fe2e90…e91466`                              |
| 1000 图最终向量摘要      | 基线与修复候选均为 `e42b5e86…2f59`                      |
| 完成/失败                | 256 图六轮与 1000 图最终轮均无漏项、无失败、无 fallback |
| Top-K                    | 向量逐项摘要完全一致，因此排序输入未变化                |
| 源数据                   | 每轮运行前后大小、时间戳与源快照一致；未写真实素材库    |

## 256 图三轮筛选

固定 `jobs=2,batch=4,backend=gpu`，按基线/候选交错运行。P95 使用三轮 nearest-rank，因此等于最大轮。

| 指标                       |        基线 |        候选 | 判断                          |
| -------------------------- | ----------: | ----------: | ----------------------------- |
| 耗时 P50                   |    35.462 s |    33.659 s | 改善 5.084%，通过 5% 门槛     |
| 耗时 P95 / 最大轮          |    38.180 s |    33.670 s | 候选快 11.81%，无回退         |
| 吞吐 P50                   |   7.22 图/s |   7.61 图/s | 提升约 5.40%                  |
| 子进程聚合 RSS P50         | 2878.62 MiB | 1845.04 MiB | 降低 35.91%                   |
| 子进程聚合 RSS 最大        | 3251.10 MiB | 1891.88 MiB | 降低 41.81%                   |
| 系统最低空闲内存（最差轮） |  300.57 MiB | 1622.12 MiB | 增加 1321.55 MiB              |
| GPU 峰值（最大轮）         |    2976 MiB |    2936 MiB | 未增加                        |
| 实际预取 batch             |           0 |         186 | 两个 worker 首批后各 31 个/轮 |
| fallback / 采样错误        |       0 / 0 |       0 / 0 | 通过                          |

机器判定为 `run-1000-final`，失败项为空。

## 1000 图单模型长轮

三轮 256 图已提供单模型统计门禁；1000 图各运行一轮，用于验证完整语料、长时间资源曲线和此前 256 图未覆盖的格式边界。该结果必须继续接受完整 ready 门禁，不能单独决定生产默认值。

| 指标                |        基线 |    修复候选 |                   变化 |
| ------------------- | ----------: | ----------: | ---------------------: |
| 墙钟时间            |   125.756 s |   111.743 s |               -11.143% |
| 吞吐                |   7.95 图/s |   8.95 图/s |                +12.58% |
| 子进程聚合峰值 RSS  | 3097.85 MiB | 2067.19 MiB | -1030.66 MiB / -33.27% |
| 系统最低空闲内存    |  538.34 MiB | 3004.73 MiB |           +2466.39 MiB |
| GPU 峰值            |    2988 MiB |    2894 MiB |                -94 MiB |
| 实际预取 batch      |           0 |         248 |           深度始终为 1 |
| fallback / 采样错误 |       0 / 0 |       0 / 0 |                   一致 |
| 向量与源快照        |        一致 |        一致 |                   通过 |

单模型机器判定为 `standalone-pass-await-e2e`，失败项为空；它只代表候选获得端到端评估资格，不代表生产启用。

## 完整“一键准备”端到端门禁

端到端 runner 使用 `pipeline=overlap,scan=3,jobs=2,batch=4`，覆盖 Native 扫描、DINO、CLIP、向量持久化、active-set revision 和索引 ready。16 图烟测从 `14.443 s` 降至 `12.957 s`，但固定小样本不足以决定默认策略。

| 指标                         |        基线 |        候选 | 判断                        |
| ---------------------------- | ----------: | ----------: | --------------------------- |
| ready P50                    |    79.822 s |    79.413 s | 仅改善 0.513%，未过 5% 门槛 |
| ready P95 / 最大轮           |    84.131 s |    79.703 s | 改善 5.264%，无尾延迟回退   |
| 吞吐 P50                     |  3.207 图/s |  3.224 图/s | 与 ready 结论一致           |
| 子进程聚合 RSS P50           | 2952.14 MiB | 2495.06 MiB | 降低 15.48%                 |
| 子进程聚合 RSS 最大          | 3014.58 MiB | 2559.13 MiB | 降低 15.11%                 |
| 系统最低空闲内存（最差轮）   |  441.48 MiB |  546.25 MiB | 增加 104.77 MiB             |
| GPU 峰值（最大轮）           |    3034 MiB |    2991 MiB | 未增加                      |
| Native/DINO/CLIP/索引摘要    |    六轮一致 |    六轮一致 | 通过                        |
| fallback / 采样错误 / 源变化 |   0 / 0 / 0 |   0 / 0 / 0 | 通过                        |

机器门禁唯一失败项为 `p50-improvement-below-5-percent`，最终决定为 `reject-and-defer`。内存收益可作为未来“低内存模式”的证据，但本任务不新增 UI 模式，也不把资源收益改写成速度收益。

## 复现入口与产物

```powershell
npm.cmd run benchmark:image-search-simple-embeddings -- "D:\PxHereDataset\images\pxhere-000000" --sample=256 --models=clip --jobs-list=2 --batch-sizes=4 --backend=gpu --stage-metrics --tensor-prefetch=0
npm.cmd run benchmark:image-search-simple-embeddings -- "D:\PxHereDataset\images\pxhere-000000" --sample=256 --models=clip --jobs-list=2 --batch-sizes=4 --backend=gpu --stage-metrics --tensor-prefetch=1
npm.cmd run benchmark:image-search:embedding-prefetch:analyze -- --dir="artifacts\benchmark\image-preparation-pipeline\2026-08-22-prep017-ab-256"
node --test tests/clip-image-decode.test.cjs tests/embedding-tensor-prefetch.test.cjs tests/embedding-tensor-prefetch-analysis.test.cjs
```

主要原始产物：

- `artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep017-smoke/`
- `artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep017-ab-256/analysis.json`
- `artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep017-final-1000/analysis-fixed.json`
- `artifacts/benchmark/image-preparation-pipeline/2026-08-22-prep017-e2e-256/analysis.json`
- 同目录逐轮 `*.json` 和 `*.timeline.ndjson`

## 回滚

无需回滚：生产默认仍使用原 CLIP batch 路径。设置 `REASONIX_EMBEDDING_TENSOR_PREFETCH=1` 可显式复现实验；删除该变量或设置为 `0` 即恢复默认，不需要迁移或重建向量库。
