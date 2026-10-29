# Alpha 14 迁移功能审计

> 状态：历史快照  
> 更新日期：2026-10-29  
> 执行者：Codex / GPT-6，精确小版本未知；无新增代理  
> 基线：GitHub 89a6d01，加当前 Alpha 12–14 本地修改  
> 范围：迁移、进度窗口、冷启动、路径解析、相关维护命令与安装器一致性

后续状态：A01–A05 已在 [Alpha 15 迁移修复](../current/2026-10-29-alpha15-migration-fixes.md) 实现修复并补充回归。以下保留修复前的发现、复现条件和检查结果，不代表当前源码仍未修复。

## 结论

发现 5 项可验证问题：P1 一项，P2 四项。常规测试通过不足以覆盖这些故障条件，不能据此宣布当前迁移流程已经没有异常路径缺口。

本次没有修改业务源码、重打包、覆盖安装或操作真实库。四项故障复现仅使用仓库 artifacts 下本轮创建的独立目录。原始文件在复现中仍保留；本报告不表示用户已经发生数据损失。当前 D 盘真实库先前的验证结果不因这些有条件的复现自动失效。

## A01 · P1 · 最终目标校验后仍有未保护的提交窗口

位置：[storageDirectoryMigration.ts](../../electron/storageDirectoryMigration.ts)，268–292 行。

目标文件完成最终 SHA256 比对后，程序进入 committing 阶段，再完整扫描一次原目录，随后写目标库标记并切换指针。这一段只复查原目录，没有复查目标目录。对于大量文件，此时离某个目标文件上次校验可能已有较长时间。

复现：在 committing 首次进度通知时，把独立测试目标中的 `payload.bin` 从 `ORIGINAL` 改成等长的 `MUTATED!`。迁移仍返回 `{ migrated: true, failed: false }`，活动根切换到新目录，但新旧文件内容不同。原目录文件仍完好。

触发条件是目标文件在最终比对后被其他写入方修改；测试通过进度回调精确安排该时点，不意味着日常迁移每次都会失败。现有“复制后破坏目标”的测试发生在更早阶段，因此未覆盖这个窗口。

建议：最终提交前同时确认原、目标目录的身份和文件指纹，保存并复核目标校验时的元数据，缩短校验到发布的窗口；补充提交阶段目标改写、丢失和目录替换的回归，明确外部写入隔离边界。修复时保留逐文件及最终内容哈希。

## A02 · P2 · 完成进度通知可以回滚已经提交的指针

位置：[storageDirectoryMigration.ts](../../electron/storageDirectoryMigration.ts)，286–304 行；[storageMigrationWindow.ts](../../electron/storageMigrationWindow.ts)，49–64 行。

`service.save()` 提交新根以后，`notify()` 仍处于同一个 try/catch 中。若完成通知同步抛错，就会进入迁移失败处理，重新保存旧根并把状态标成 failed。通知函数没有异常隔离；窗口 adapter 只捕获异步 JavaScript Promise 的拒绝，未隔离其余同步异常。

复现：仅在 completed 通知中模拟同步 UI 更新异常。观察到指针先写新根、再写旧根，最终返回迁移失败；新根已有有效库标记。这是故障注入下的事务语义问题，未证明普通进度更新会稳定触发该异常。

建议：以原子指针提交为明确边界；提交成功后的展示异常不得进入业务回滚分支。将进度通知的异常与迁移结果隔离，保留真实 I/O 错误处理，增加提交后通知失败回归。

## A03 · P2 · 进度窗口初始化失败会保留 pending，阻断后续启动

位置：[storageLocationIpc.ts](../../electron/storageLocationIpc.ts)，53–57 行；[main.ts](../../electron/main.ts)，824–837 行。

创建进度窗口发生在迁移函数及其失败状态清理之外。窗口创建或 loadURL 初始化失败时，外层启动处理显示错误并退出，但 pending 未清除。下次启动继续尝试同一待迁移任务，无法进入普通工作区。

复现：将窗口初始化替换为抛错，连续调用两次启动入口。两次都抛错，迁移函数一次未执行，pending 始终存在。这里是每次重新启动仍失败，并非已证明程序自行无限重启。

建议：在窗口初始化异常时明确记录本次迁移失败、清除待办，显示原目录仍保留的提示；以新进程恢复原库正常启动。测试还应覆盖 renderer 初始化失败和用户在窗口就绪前关闭的情况。

## A04 · P2 · 向量维护命令仍拒绝合法的新数据目录

位置：[repair-vector-coverage.cjs](../../scripts/repair-vector-coverage.cjs)，23–50 行；[rebuild-vector-library.cjs](../../scripts/rebuild-vector-library.cjs)，20–53 行。

两条已注册的维护命令仍默认使用 `%APPDATA%/floating-clock-electron`，并强制传入目录名必须是 `floating-clock-electron`。迁移界面创建的新目录名为 `Siftory-data-xxxxxxxx`，即使显式指定也会被拒绝。

复现：先完成一个独立库的真实迁移，再将其新根传给两条命令的参数校验函数。两者都返回 `The user-data directory must end in floating-clock-electron`，尚未进入预览或执行阶段。本轮没有运行维护写操作。

影响范围是维护 CLI。默认调用还存在指向保留旧副本的风险，不能用旧副本的维护结果判断新库状态；此结论不代表桌面内的全部维护入口都有同样问题。

建议：从迁移 bootstrap 解析活动根，以库标记、libraryId、目录身份和确认令牌校验合法性，替换固定目录名判断；检查维护进程和子进程都使用活动根，不要简单删掉现有安全约束。

## A05 · P2 · 架构检查因新增进度模块超过预算而失败

位置：[storageLocationIpc.ts](../../electron/storageLocationIpc.ts)，9 行；[check-build-graph.cjs](../../scripts/check-build-graph.cjs)，155 行。

`npm run test:architecture` 中分层检查通过，但构建图检查失败：主进程可达模块为 323，当前预算为 321。新增的进度窗口及呈现模块进入主进程依赖图后，未同步处理预算约束。后续 build-graph 单元测试因前一个命令失败没有执行。

建议：按现有治理规则拆分依赖，或为这两个仅服务启动进度的模块记录合理的预算调整说明，再恢复架构检查。不能以安装器已生成替代该检查。

## 本轮验证与证据

- `npm run test:core-behavior`：224 项，222 通过、0 失败、2 跳过。两项跳过均因主机不允许创建文件符号链接，报 EPERM。
- `node tests/storage-migration-progress-electron-smoke.cjs`：通过。覆盖原生窗口、沙箱、内存会话、取消、计时、完成状态、文本注入防护和临时库完整迁移，原始测试载荷保持一致。
- `npm run test:architecture`：失败，唯一输出违规为 main 323 超过 321；分层扫描 519 个模块无跨层导入。
- 独立故障探针：A01–A04 均按上述条件复现。探针只修改自己创建的测试目录，没有接触用户真实目录。
- Alpha 14 安装器重新计算 SHA256，与同目录校验文件一致：`67d8ce244f631f74cbf8503149bbe4b8dce214ee57536248acc36deffda499b5`，176193640 字节。
- 上一轮实际打包程序启动记录仍为 Alpha 14，renderer 错误为 0；本轮未重复覆盖安装，也未用真实媒体跑完整图像、视频或音频模型回归。

证据目录：`artifacts/migration-audit-20261029/`。关键文件为 `fault-probes.cjs`、`fault-results.json`、`core-tests.log`、`architecture.log`、`window-smoke.log` 和 `installer-check.json`。独立测试目录暂时保留供复查。

## 修复顺序

先处理 A01 提交一致性和 A02 提交边界，再处理 A03 启动恢复；随后修复 A04 维护路径和 A05 架构检查。修复完成前，不把当前 Alpha 14 作为上述异常场景已经解决的版本继续发布。
