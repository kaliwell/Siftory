# Embedding 解码双预算验收（RMO-031）

> 日期：2026-08-29  
> 结论：通过  
> 原始报告：`artifacts/benchmark/runtime-memory/decode-budget/report.json`

## 实现结论

- 每批同时受图片数上限和预计 RGB 字节上限约束，默认 RGB 预算为 256 MiB。
- PNG/GIF/BMP/JPEG/WebP 优先用最多 64 KiB 的有界头解析获得尺寸；JPEG 同时解析 EXIF orientation。未知或复杂格式才回退 Sharp metadata。
- 80 MP、长宽比达到 1:100 或多图 RGB 总量跨预算时，DINO/CLIP 不再先解码多波并累计持有所有 Buffer，而是逐图完成“解码→推理→提交”，上一张 RGB Buffer 可在下一张前释放。
- 普通批次仍走原批量解码和批量推理，不改变顺序、损坏图片隔离、向量语义或 ready 提交规则。

## 普通批性能门禁

使用生产最大 batch 16，生成 16 张 1200×800 RGB JPEG，预热后交替执行 7 轮原并发解码与双预算解码：

| 路径 | P50 | P95 | 成功数/输出字节 |
| --- | ---: | ---: | --- |
| 原并发解码 | 55.04 ms | 73.52 ms | 完全一致 |
| 双预算解码 | 56.42 ms | 76.20 ms | 完全一致 |

P95 变化 `+3.646%`，低于 5% 门禁；所有轮次均为 16/16 成功且输出 RGB 字节完全一致。

## 安全与回归

- 专项测试覆盖 80 MP、1:100 panorama、聚合预算、EXIF 旋转、Alpha、灰度、损坏输入和顺序保持。
- 基准只生成合成图片，工作目录结束后删除，未读取用户素材。
- RMO-032 的预缩放候选仍默认关闭；本项只改变超预算批的调度与生命周期。

复现：

```powershell
npm.cmd run benchmark:memory:decode-budget
```
