# Git 工作流与提交机制

> 状态：当前  
> 版本：1.1  
> 更新日期：2026-07-22  
> 范围：Siftory（寻藏）本地 Git 仓库、所有模型与人工开发者
> 替代文档：无

## 1. 目标与边界

本机制用于提供可比较、可归属、可验证和可恢复的代码历史。身份与代理归属先遵守[模型、运行时与文档确认规范](model-runtime-and-document-confirmation.md)。

Git 只保护已经提交的工程文件，不替代以下机制：

- 用户数据、真实库、模型和构建产物的专用备份。
- 远程仓库的访问控制、分支保护和 CI。
- 凭据轮换；本地敏感信息扫描只是高置信度兜底，不是完整 DLP。
- 未暂存或未提交改动的恢复。

本地 hook 可以被删除或通过 `--no-verify` 绕过，因此它是错误预防门禁，不是安全边界。配置远程后，必须在服务端复现提交格式、测试和 `main` 保护规则。

## 2. 已实施机制

| 机制         | 文件/配置                              | 作用                                               |
| ------------ | -------------------------------------- | -------------------------------------------------- |
| 忽略与属性   | `.gitignore`、`.gitattributes`         | 排除运行产物，固定文本行尾和二进制属性             |
| 提交模板     | `.gitmessage`                          | 提示填写执行系统、模型、任务和验证证据             |
| 暂存区预检   | `scripts/git-preflight.cjs`            | 直接读取 Git index 中的路径、blob 大小和内容       |
| 暂存快照验证 | `scripts/validate-staged-snapshot.cjs` | 在临时 worktree 验证暂存树，不受未暂存改动干扰     |
| 信息校验     | `scripts/validate-commit-message.cjs`  | 校验标题、必填 trailer、重复字段及执行系统         |
| 独立工作树   | `scripts/create-task-worktree.cjs`     | 从 `main` 为一个任务创建仓库外 worktree            |
| 仓库备份     | `scripts/create-git-bundle.cjs`        | 在仓库外创建并验证包含全部引用的 bundle            |
| hooks        | `.githooks/`                           | 提交前、提交信息和推送前门禁                       |
| 回归测试     | `tests/git-policy.test.cjs`            | 覆盖 index、快照、分支、元数据、worktree 和 bundle |

首次克隆或重建 `.git/` 后运行：

```powershell
npm.cmd run git:setup
npm.cmd run git:hooks:check
```

`git:setup` 只写当前仓库的本地配置，并检查 hook 文件。它不会替用户猜测身份。pre-commit 要求仓库本地（不是只靠全局继承）显式设置：

```powershell
git config user.name "<confirmed-name>"
git config user.email "<confirmed-email>"
```

## 3. 分支与工作树

### 3.1 稳定分支

- `main` 只指向已通过所需验证的稳定提交。
- `pre-commit` 始终拒绝直接在 `main` 提交，包括首个提交；修复、回退和维护也必须先建分支。
- 合入使用 `git merge --ff-only`。fast-forward 本身不会触发 `commit-msg`，因此待合入提交必须已通过各自门禁。
- 本地保护不能代替远程分支保护。

任务分支命名：

```text
task/<task-id>-<short-name>
fix/<issue-id>-<short-name>
perf/<short-name>
docs/<short-name>
experiment/<short-name>
```

一个分支只处理一个明确任务，不夹带无关格式化、依赖升级或生成物。`experiment/*` 未验证前不得合入 `main`。

### 3.2 多模型强制隔离

首个稳定提交建立后，每个模型/代理必须使用不同的物理 worktree；仅创建不同分支但继续共享一个目录不算隔离。同一 worktree、分支和文件范围只能有一个明确所有者。

```powershell
npm.cmd run git:worktree:create -- task/nks-p2-02-feedback-worker C:\ReasonixWorktrees\kimi-feedback
npm.cmd run git:worktree:create -- docs/git-policy C:\ReasonixWorktrees\codex-git-policy
```

助手只接受仓库外的绝对路径，并从 `main` 创建新分支。进入新 worktree 后运行 `npm.cmd ci` 和 `npm.cmd run git:setup`。不得让 Codex worktree 与 Kimi worktree 指向同一路径，也不得把一个运行时的 `coder` 当成另一个运行时的代理。

当前仓库尚无首个提交时无法创建 Git worktree。此阶段必须冻结目标文件所有权：Kimi/外部代理仍写入的文件由其独占，其他执行者只读；待其暂停后再执行第 13 节。

## 4. 文件所有权

开工前在 Todo 或交接记录中写明：执行系统、带来源的所有者（如 `Kimi/coder`）、分支、文件范围和状态。

规则：

1. 一个文件同一时刻只有一个写入所有者，审阅者默认只读。
2. 每个模型只提交自己确认过的改动；无法拆分的协作提交使用 `Executor-System: Mixed`，正文逐项说明归属。
3. 所有权不明、外部任务仍写入或工作区出现来源未知的改动时，停止暂存和提交，不进行推测性回退。
4. 不使用 `git reset --hard`、强制 checkout 或清空工作区来处理所有权冲突。

## 5. 提交边界

每个提交必须只有一个可解释、可独立回退的目的。实现、对应测试和必要契约更新可以同提交；大规模文档整理、纯格式化和依赖升级分别提交。

禁止进入普通历史：

- `node_modules`、`dist`、`release`、Native build、缓存、备份、日志和真实用户数据。
- `.exe`、`.dll`、`.node`、`.onnx`、压缩包等二进制/模型产物。
- `.env`、私钥、证书私钥和凭据。
- 单个超过 25 MiB 的 blob。

依赖变更必须记录锁文件变化，并运行相应回归及 `npm audit --omit=dev`。存在未处置的高危项时不得创建发布标签；若暂不能修复，必须记录影响、缓解措施和负责人。

## 6. 提交信息

标题必须是：

```text
<type>(<lowercase-kebab-scope>): <summary>
```

允许的 type：`feat`、`fix`、`perf`、`refactor`、`test`、`docs`、`build`、`ci`、`chore`、`revert`。标题最长 100 字符，不得使用 `WIP`。

以下 trailer 各出现且只出现一次：

```text
Executor-System: Codex
Executor-Model: GPT-5 series
Task: git-policy
Validation: npm.cmd run test:git-policy; 11/11 passed
```

- `Executor-System` 仅允许 `Codex`、`Kimi`、`Claude`、`Gemini`、`Human`、`Mixed`。
- `Executor-Model` 只写可确认粒度；精确版本不可见时写 `unknown`，不得猜测。
- `Task` 写 Todo、Issue ID 或稳定的短任务名。
- `Validation` 写实际命令与结果；未运行写 `not-run: 原因`，但这不等于门禁通过。
- Git 自动生成的 merge/revert 信息不豁免校验，必须编辑成上述格式。

## 7. 暂存与提交

禁止未经审阅直接 `git add .`。推荐流程：

```powershell
git status --short
git add -- <explicit-file-1> <explicit-file-2>
git diff --cached --stat
git diff --cached
npm.cmd run git:preflight
npm.cmd run git:validate-staged
git commit
```

`git:preflight` 读取 index，而不是同名工作区文件，因此不能通过“先暂存大文件、再缩小工作区文件”绕过。它检查任意嵌套层级的生成目录、暂存 blob 大小、高置信度凭据内容及 `git diff --cached --check`。

`git:validate-staged` 用暂存树创建临时提交和 detached worktree，链接当前 `node_modules`，运行 typecheck、lint 和 format check，最后只删除链接和临时 worktree。该设计保证未暂存改动不会替暂存内容通过测试。

## 8. Hook 行为与绕过

### 8.1 Pre-commit

普通分支执行暂存区预检和暂存快照验证。直接在 `main` 提交始终失败。

只有第 13 节的隔离现场快照允许设置 `SNAPSHOT_COMMIT=1`，且分支名必须为 `snapshot/*`。该模式仍执行路径、大小、敏感信息和提交信息检查，只跳过代码质量验证；这种提交不得合入 `main`。

### 8.2 Commit-msg

所有提交（包括 merge、revert 和现场快照）都必须符合第 6 节。没有基于默认消息前缀的豁免。

### 8.3 Pre-push

hook 从 Git 提供的待推送引用中解析更新范围，复查每个新增提交的归属元数据，并在每个非删除分支尖端自己的临时 worktree 中运行完整 `npm run verify`。它不使用当前工作区替代被推送快照。

### 8.4 绕过边界

日常任务禁止 `--no-verify`。本地 hook 无法抵御有意绕过，因此任何未来远程仓库都必须启用服务端保护。测试失败、身份未知或所有权不清不能通过绕过变成“已完成”。

## 9. 验证等级

| 等级 | 范围                         | 最低验证                                 |
| ---- | ---------------------------- | ---------------------------------------- |
| L0   | 仅文档                       | 链接、Markdown、事实来源复核             |
| L1   | 单一纯函数/守卫              | typecheck、lint、format、专项测试        |
| L2   | IPC、存储、worker、搜索      | L1 + 相关测试链 + 构建                   |
| L3   | Native、安装包、真实库、发布 | 完整 verify + smoke/benchmark/真实库对照 |

验证记录写实际数量和未覆盖边界，例如“88/88 通过；未运行 Windows 安装包 smoke”。

## 10. 合入 `main`

1. 更新任务状态、所有权和验证证据。
2. 在任务提交快照上完成所需等级验证；完整门禁必须在移动 `main` 前成功。
3. 确认 `main` worktree 干净，且目标提交没有未知归属文件。
4. 执行：

```powershell
npm.cmd run git:validate-commit -- task/<task-id>-<short-name> --full
git switch main
git merge --ff-only task/<task-id>-<short-name>
```

不能 fast-forward 时先查明分叉来源，不强制覆盖。完整验证失败时，不移动 `main` 和稳定标签。合入后可再次执行 `npm.cmd run verify` 作为复核，但它不能替代移动指针前的提交快照验证。

## 11. 回退与敏感信息响应

- 已提交错误在新 `fix/*` 分支使用 `git revert <commit>`，随后把生成消息改为第 6 节格式。
- 未提交改动只由其所有者处置；不回退其他模型或用户的改动。
- Git 不替代数据库事务和用户数据备份。
- 一旦凭据进入历史，立即停止传播、轮换凭据并评估历史清理；后续提交删除文件不能消除泄漏。

## 12. 标签、签名与仓库备份

标签类型：

```text
snapshot/YYYY-MM-DD
baseline/YYYY-MM-DD
v<major>.<minor>.<patch>
```

- `snapshot/*` 是隔离现场，允许已记录的验证失败，禁止当作稳定基线或发布来源。
- `baseline/*` 只标记完整验证通过的可复核工程基线。
- `v*` 只用于通过 L3 且依赖安全风险已处置的发布版本。
- 稳定/发布标签使用 annotated tag；发布环境应配置签名并验证 `git tag -v`。当前尚未确认签名身份，因此不能声称已启用签名。

每个关键提交或标签后，将已提交对象备份到仓库外：

```powershell
npm.cmd run git:backup -- D:\ReasonixGitBackups
```

脚本执行 `git bundle create --all` 和 `git bundle verify`。bundle 不包含未提交改动、忽略资源或用户数据库；这些内容必须另行备份。配置受控远程后，以远程仓库加离线 bundle 形成至少两份独立副本。

## 13. 首次历史建立方案

当前目录在 `git init` 前已包含既有工程和 Kimi 进行中的 ①b 改动，且尚无提交。不能把未经验证的现场直接命名为 `main` 基线。

按以下顺序执行：

1. 等待 `Kimi/coder` 停止写入，确认文件所有权和 Todo 状态。
2. 配置真实的 `user.name`、`user.email`；列出全部拟暂存文件和排除的大资源。
3. 执行 `git switch -c snapshot/pre-git-2026-07-22` 创建隔离分支，只显式暂存已审阅文件。
4. 运行 `npm.cmd run git:preflight`。任何敏感文件、大 blob 或生成物错误必须先修复。
5. 尝试 `npm.cmd run git:validate-staged`。若通过，正常提交；若既有现场本身不能通过且必须保留原貌，仅在该 snapshot 分支执行受控快照：

```powershell
$env:SNAPSHOT_COMMIT = '1'
git commit
Remove-Item Env:\SNAPSHOT_COMMIT
git tag -a snapshot/2026-07-22 -m "Pre-Git quarantined working snapshot"
```

6. 在新的任务分支修复验证失败，拆分已确认归属的工作，完整运行 `npm.cmd run verify`。
7. 只有验证通过的提交才能成为 `main`。首建时执行 `git branch main <verified-commit>`，再切换 `main` 并创建 `baseline/2026-07-22`（或实际日期）。现场 snapshot 本身不得作为稳定 `main`。
8. 立即运行仓库外 bundle 备份；再为 Kimi、Codex 或人工任务分别创建独立 worktree。

在 ①b 所有权、写入状态、Git 身份和验证结果确认前，不创建首个提交或任何 `baseline/*` 标签。

## 14. 审计结论与剩余风险

本次修复已关闭以下逻辑漏洞：工作区冒充暂存区、暂存后缩小大文件、嵌套生成目录漏检、merge/revert 消息豁免、重复 trailer、提交后在 `main` 直接提交、推送验证错误快照，以及多模型共享物理目录缺少隔离手段。

仍需外部条件才能关闭的风险：

1. 尚无真实 Git 用户身份和签名配置。
2. 尚无 remote/CI/服务端分支保护；本地 hook 可被有意绕过。
3. 尚无首个提交，因此当前未提交现场不能由 Git 恢复，bundle 也无法创建。
4. Kimi ①b 仍可能写入，首次快照必须等待所有权冻结。
5. 敏感信息扫描只覆盖有限的高置信度模式；提交者仍需人工审阅。
6. 2026-07-22 的 `npm audit --omit=dev` 报告 1 个 moderate、2 个 high：`protobufjs` 有可用修复，`sharp` 经 `@huggingface/transformers` 引入且当前无可用修复。未完成兼容性评估和缓解前不得创建发布标签。
7. 暂存/提交快照验证复用当前 worktree 的 `node_modules`，不会证明一次全新依赖安装可复现。依赖或锁文件变更必须在隔离 worktree 先运行 `npm.cmd ci`；配置远程后还必须由干净 CI 环境复验。

## 15. 日常命令速查

```powershell
npm.cmd run git:setup
npm.cmd run git:hooks:check

npm.cmd run git:worktree:create -- task/<id>-<name> C:\ReasonixWorktrees\<owner>-<task>

git add -- <files>
git diff --cached --stat
git diff --cached
npm.cmd run git:preflight
npm.cmd run git:validate-staged
git commit

npm.cmd run git:validate-commit -- <branch-or-commit> --full
npm.cmd run git:backup -- D:\ReasonixGitBackups
git log --show-signature --format=fuller --decorate --stat
```
