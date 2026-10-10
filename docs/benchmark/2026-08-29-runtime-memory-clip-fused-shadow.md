# RMO-032 CLIP 融合预处理影子验证

日期：2026-08-29  
状态：第一阶段通过，尚未允许默认启用

## 结论

在固定只读 PxHere 语料的首批 16 张图片上，候选 `Sharp 解码 + 旋转 + 缩放` 路径与现有 `RawImage.read + processor` 路径生成的 CLIP 输入张量完全一致：16/16 张通过，2,408,448 个张量值零差异，最大绝对误差为 0。源文件大小和时间戳均未变化。

重新生成脱敏报告后，本轮候选总耗时为 3,095.860 ms，基线为 3,349.662 ms，下降 7.577%。该数据只证明当前小样本的张量语义和方向性收益，不代表完整建库收益。

## 可复现命令

```powershell
npm.cmd run benchmark:image-search:clip-fused-shadow -- D:\PxHereDataset\images\pxhere-000000 --sample=16 --json-out=artifacts\benchmark\runtime-memory\clip-fused-shadow-2026-08-29.json
```

机器可读证据位于 `artifacts/benchmark/runtime-memory/clip-fused-shadow-2026-08-29.json`。报告只保存数据集短名、文件短名和样本 identity，不保存绝对用户路径。

## 仍需完成的门禁

- 覆盖 EXIF 旋转、Alpha、灰度、截断与超大图片；不适用输入必须走已验证回退。
- 对 DINO 路径进行独立影子验证，不将 CLIP 结论外推到另一模型。
- 连续三轮完成向量、Top-K、Library Ready P95、整树 Private Bytes、GPU/VRAM 与源只读门禁。
- 完整 Ready P95 退化超过 5%、张量或搜索结果发生变化、或内存控制线不通过时，候选保持关闭。
