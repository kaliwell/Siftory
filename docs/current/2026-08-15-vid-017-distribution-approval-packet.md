# VID-017 分发审批材料包

> 状态：当前  
> 更新日期：2026-08-17  
> 范围：llama.cpp 与 Qwen3-VL 候选分发决策材料  
> 替代文档：无

> 本文档由固定清单生成，不构成批准，不修改许可证决策。

## 候选组件

| 组件 | 固定版本 | SPDX | 当前审查状态 | 默认打包 |
| --- | --- | --- | --- | --- |
| llama.cpp Windows x64 | release:b10441+commit:0177dcc7300bad8914bb838baabce87899812491 | MIT | legal-review-required | 否 |
| Qwen/Qwen3-VL-2B-Instruct-GGUF | huggingface-revision:52d6c8ffea26cc873ac5ad116f8631268d7eb503+Q4_K_M+mmproj-Q8_0 | Apache-2.0 | legal-review-required | 否 |

本地验证已覆盖真实推理、严格 JSON、持续推理和 online/offline 排除矩阵；本地安装范围仍为 `local-evaluation-only`。项目许可证当前状态：`pending`，表达式：`UNLICENSED`。

## 分发选项

1. 保持用户本机安装、不随应用分发（当前推荐，零新增安装包体积）。
2. 获批后首次运行在线下载，并提供 MIT、Apache-2.0 许可证及 NOTICE。
3. 获批后离线内置，安装包预计增加约 1.55 GB，并执行真实 packaged matrix。

## 有权审核人必须完成

- [ ] 确认项目 EULA、版权主体与发布权限。
- [ ] 确认 llama.cpp MIT 再分发义务和许可证文件。
- [ ] 确认 Qwen3-VL Apache-2.0/模型材料的再分发范围和 NOTICE。
- [ ] 在 `legal/license-decisions.json` 留下真实审核人、时间、证据和允许的 profile。

在以上条目完成前，`VAL-313` 保持 blocked，runtime 与模型不得进入安装包。
