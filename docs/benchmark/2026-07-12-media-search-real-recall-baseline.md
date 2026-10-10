# MediaSearch 真实素材 Recall@K 基线

> 日期：2026-07-12  
> 数据：本机现有 MediaSearch 帧清单与 Frame Index  
> 查询：100 个视频帧，每个视频优先选取一个查询  
> 结论：真实向量索引完整，DINO/CLIP 图像检索均达到可用基线

## 目标

固定样本测试可以证明算法没有逻辑回归，但不能说明真实素材上的召回水平。本基准直接读取用户已构建的 `video_frames.jsonl` 和 `frame_embedding_index.jsonl`，不重新提取 embedding，也不修改索引。

执行：

```powershell
npm.cmd run benchmark:media-search:recall
```

可通过 `MEDIA_SEARCH_DIR` 指定数据目录，通过 `MEDIA_SEARCH_RECALL_QUERIES` 设置 1–500 个查询。

原始结果写入忽略版本控制的 `artifacts/media-search-recall/latest.json`。

## Ground Truth

自动生成两种无需人工标注的相关性定义：

1. Same Video：查询视频中的任意其他已索引帧。
2. Adjacent：按时间戳排序后，查询帧的上一帧或下一帧。

Same Video 衡量同一素材跨场景召回；Adjacent 更接近“当前画面附近是否能被找回”。查询帧自身从候选中排除。

## 数据质量

- 帧清单：9,423。
- 已索引视频：915。
- 至少包含两个索引帧的视频：801。
- 查询：100。
- Manifest malformed：0。
- Index malformed：0。
- 非法或错误维度向量：0。
- Manifest 加载：约 47 ms。
- 259.5 MB JSONL Frame Index 加载：约 755 ms。

## 结果

### Same Video Recall

| 模型 | R@1 | R@5 | R@10 | R@20 | R@50 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DINOv2 ViT-B/14 | 77% | 90% | 94% | 98% | 99% | 0.8194 |
| CLIP ViT-B/32 | 80% | 95% | 98% | 99% | 99% | 0.8585 |

### Adjacent Recall

| 模型 | R@1 | R@5 | R@10 | R@20 | R@50 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DINOv2 ViT-B/14 | 37% | 69% | 79% | 88% | 94% | 0.5137 |
| CLIP ViT-B/32 | 27% | 70% | 82% | 88% | 94% | 0.4493 |

### 精确评分耗时

| 模型 | Mean | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| DINOv2 ViT-B/14 | 7.02 ms | 6.98 ms | 7.76 ms | 9.12 ms |
| CLIP ViT-B/32 | 4.95 ms | 4.92 ms | 5.53 ms | 5.88 ms |

第二次运行的 Recall 和 MRR 与第一次完全一致，证明查询选择和排序确定性正常。

## 判断

1. DINO Adjacent R@1 高于 CLIP（37% 对 27%），继续作为默认以图搜视频模型合理。
2. CLIP Same Video R@10 达到 98%，适合作为语义和跨场景补充。
3. 两个模型 R@50 均达到 99%/94%，此前“索引只搜索少量帧”问题在当前数据上没有复现。
4. Frame Index 冷加载约 755 ms，低于审计设定的 1 秒二进制索引触发阈值。
5. 精确评分 P95 小于 8 ms，远低于 250 ms 的 worker/native ANN 触发阈值。
6. 当前没有数据支持立即引入二进制 Frame Index 或 ANN；应继续保留精确线性评分。

## 限制

- 本报告验证以图搜视频的真实索引召回，不代表文本语义搜索准确率。
- Same Video 不等于人工语义相关；长视频不同场景仍可能被标为相关。
- Adjacent ground truth 依赖抽帧间隔，画面切换点可能天然不相似。
- 查询耗时只覆盖内存精确评分和 TopK，不包含模型推理、IPC、缩略图加载。
- 文本语义准确率仍需要人工标注的查询词与相关帧集合。
