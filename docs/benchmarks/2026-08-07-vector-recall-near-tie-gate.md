# 向量召回门禁近重复口径修正

日期：2026-08-07
范围：`VAL-001` 真实数据只读预检；未写入、删除或迁移用户数据

## 结论

现有 F16 复合快照与 JSONL F32 对照源完全对齐。原门禁失败来自近重复密集区域的 top-K 路径身份翻转，而不是向量错配。门禁现以“F16 返回项在 F32 中是否落入 top-K 边界分数容差”判断召回质量，原始路径 overlap 继续作为诊断项输出。

| 指标 | CLIP 512d | DINO 768d | 结论 |
| --- | ---: | ---: | --- |
| 复合快照条数 | 317,268 | 321,002 | — |
| 缺失 / malformed | 0 / 0 | 0 / 0 | 对齐 |
| 严格路径 recall@50 均值 | 0.9747 | 0.9830 | 近重复敏感诊断 |
| 分数等价 recall@50 均值 | 1.0000 | 0.9999 | ≥ 0.99，通过 |
| 分数等价 recall@50 最小 | 1.00 | 0.98 | 报告项 |
| 原始 self-in-top-50 | 0.965 | 0.955 | 近重复敏感诊断 |
| self top-1 分数等价率 | 1.000 | 1.000 | ≥ 0.995，通过 |
| top-1 gap p99 | 1.04e-10 | 7.45e-5 | ≤ 1e-3，通过 |
| score error p99 | 3.94e-4 | 6.08e-4 | ≤ 5e-3，通过 |

## 安全性与回归

- 重复路径改为按出现次序与 JSONL 行配对，避免后续 occurrence 误绑到第一条向量。
- 分数等价 recall 使用每个 F16 返回候选在 JSONL F32 中的精确分数；候选低于精确 top-K 边界超过既有 `maxTop1Gap` 才算召回损失。
- 乱序 generation 合成夹具仍触发非零门禁，不能用近重复容差掩盖路径/向量错配。
- 近重复边界夹具证明严格路径 recall 可低于 0.99，而所有候选均处于允许分数差时门禁通过。

## 验证

- `node --test tests/vector-generation-recall.test.cjs`：6/6 通过。
- `npm.cmd run test:vector-pipeline`：126/126 通过，2 项外部 CUDA 夹具条件跳过。
- `npm.cmd run verify:vector-generation-recall -- <userData>`：真实只读门禁 2/2 模型通过，耗时 397.3 秒。
- `npm.cmd run typecheck`、`npm.cmd run lint`：通过。

本批没有执行真实 embedding 追加、维护统计写操作或崩溃注入；这些步骤仍受 `VAL-001` 的维护窗口与小批量写入授权约束。
