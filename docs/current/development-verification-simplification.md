# 开发验证流程与工程规则精简

> 状态：当前

本轮仅处理开发验证流程与工程规则，索引性能改动保留在原工作区，未混入本分支。

- 普通 push 只检查新增提交标题，不创建验证工作树、不运行全量测试；新分支不反复验证已经在远端的旧历史。
- pre-commit 仅检查实际暂存内容的敏感信息、禁止提交的运行产物、文件大小和空白；不依赖 node_modules，不跑全量类型、lint、测试。
- Commit 使用 `fix: 描述` 或 `fix(scope): 描述`，不再要求 AI 执行者元数据。
- 模块行数预算以及 IPC 合约 barrel 行数只警告。依赖分层、构建隔离、共享依赖环、缺失引用仍是错误。
- 四个开发入口统一为 `verify:fast`、`verify:changed`、`verify:ci`、`verify:release`。常见模块按范围选测试并去重，未分类或共享层修改明确回退至 CI。
- `verify:changed -- --plan` 只展示计划；每步耗时记录和同一次验证的重复调用可用 `node scripts/verify.cjs timings` 查看。
- CI workspace/core 清单从 40 项调用合并为 38 个不同测试文件，不删除原测试；取消重复 core 步骤及源验证中的重复契约检查。
- 五个无 npm/CI/脚本引用的旧性能实验驱动归档到 `scripts/experiments/2026-11-07/`，保留历史复现材料并修正路径。
- 旧 snapshot 验证器仍被受控发布使用，因此保留；改成按需加载发布依赖，普通验证不再提前加载它们。原发布全量测试、关键覆盖率和审计不删减。

独立分支：`task/verification-flow`。本轮不生成安装包，也不执行完整发布验证。运行方式见[开发验证流程](../reference/development-verification.md)。
