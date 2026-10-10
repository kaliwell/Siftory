# 通用 / 固定监控最终覆盖人工复核

> 日期：2026-08-15  
> 对应任务：`VAL-212` / `VID-016`  
> 用户导出：`video-profile-final-coverage-summary.json`  
> 导出 SHA-256：`9552196b2967c48d9e0c9ffb7442a7fa93294c17301356bf68914f6a026ebb53`

## 核验结果

- 导出记录 24、私有状态判断 24、固定候选 24，匿名 ID 集合逐条一致。
- 完成 24/24、接受 24、跳过 0、未复核 0，`readyForBenchmark=true`。
- 本批人工标签为通用 11、固定监控 13；其中一条原“通用”建议被人工改判为固定监控，说明建议分类没有被直接当作真值。
- 导出与私有状态的 24 个 profile 判断完全一致，无未知 ID、遗漏 ID、重复 ID或标签冲突。
- 导出记录仅含匿名 ID、profile、时长/方向分桶、音轨/转写布尔值和复核时间；隐私声明明确路径、名称和自由文本均未导出。

## 合并门禁

合并原始 profile 状态、会议/体育批次与本批状态后：

- 通用真值从 4 增至 15。
- 固定监控真值从 3 增至 16。
- 八类 profile 均达到至少 10 条，`profileTruthReady=true`。
- 当前最终门禁仍为 `semanticCoverageReady=false`、`formalRecallAvailable=false`、`finalReady=false`；原因是最终 80 条语义计划仍需补跑和人工深度复核 36 条。

## 下一步

最终计划必须保留冻结 V1 的 44 条结果，并只新增通用 6、会议 10、游戏 3、固定监控 7、体育 10，共 36 条。新结果写入独立 `qwen3-vl-2b-profile-final` 目录，不能覆盖原 V1/V7/V8.1 结果。
