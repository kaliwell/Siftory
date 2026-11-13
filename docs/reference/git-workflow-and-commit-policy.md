# Git 工作流与提交规则

> 状态：当前

提交前运行 `npm run verify:fast`；按修改范围运行 `npm run verify:changed`。完整命令说明和计时位置见 [开发验证流程](development-verification.md)。

Commit 标题使用 `fix: 描述`、`feat: 描述` 或 `fix(scope): 描述` 等 conventional 格式，scope 可省略；标题最多 100 个字符。正文按需要说明原因和验证结果，不再强制附加 Executor-System、Executor-Model、Task、Validation 元数据。

pre-commit 保留暂存区敏感信息与运行产物扫描；pre-push 不强制执行全量测试。CI 和发布验证显式执行。日常开发优先使用独立工作分支；不要覆盖其他工作区的未提交修改。

旧提交元数据保留历史原样，不改写 Git 历史。安装包、模型、用户数据和私密采样不进入普通源码提交。
