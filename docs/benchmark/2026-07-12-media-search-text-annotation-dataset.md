# MediaSearch 人工文本语义标注集

> 状态：候选池与标注工具已完成，人工标签尚未填写  
> 日期：2026-07-12  
> 数据来源：本机 MediaSearch 真实 Frame Index

## 目标

为文本搜视频建立可复现的人工 ground truth，分别评估英文和中文文本查询。该数据集不使用“同一视频”自动标签替代语义相关性判断。

## 当前规模

- 索引帧：9,423。
- 中英配对概念：12。
- 去重候选：1,748。
- 当前人工判断：0；因此现阶段不能报告文本语义准确率。
- 概念：女人、男人、猫、狗、牛、动漫人物、游戏画面、电脑截图、文字文档、产品广告、桌上的食物、自然风景。

每个概念的候选池合并以下来源：

1. 英文 CLIP Top 60。
2. 中文 CLIP Top 60。
3. 文件名和路径词法匹配，最多 40 项。
4. 固定随机种子的负样本 20 项。

英文和中文查询共享同一个概念标签，减少重复人工工作，同时保留两套独立排序用于比较跨语言效果。

## 标注规则

- `relevant`：画面内容直接符合概念。
- `not_relevant`：画面不符合概念。
- `unsure`：画面不完整、含义模糊或无法可靠判断。
- 只判断实际画面，不依据文件名猜测。

标注页面快捷键：`1` 相关、`2` 不相关、`3` 不确定、`0` 清除、`Ctrl+Z` 撤销、左右方向键切换。

页面默认启用“评测优先”：先处理所有概念的中英文 Top10 候选，再处理 Top20、Top50，最后处理路径命中和随机负样本。同一优先级内按概念轮转，避免先耗尽单一概念。保存后自动跳到下一个未明确判断的候选，并预加载下一张图片。

当前分阶段工作量：Top10 联合候选 230 项、Top20 增量 229 项、Top50 增量 674 项、其余候选池 615 项。页面显示整体进度条、当前阶段以及本次会话最近明确判断的速度；完成至少 2 项后根据实际速度动态计算 ETA。

分类选择器显示每组明确判断数和不确定数；当前概念显示 Top10、Top20、Top50 联合候选覆盖。总进度只统计 `relevant` 与 `not_relevant`。`unsure` 会在其他候选处理完后重新出现，避免不确定项被误认为已完成。关闭“评测优先”后可按当前分类顺序处理。

## 使用流程

```powershell
npm.cmd run annotation:text:prepare
npm.cmd run annotation:text:serve
```

浏览器打开 `http://127.0.0.1:41739` 完成人工标注。标注可中断和继续，结果会实时原子写入。完成后运行：

```powershell
npm.cmd run annotation:text:evaluate
```

随时检查数据集和标注完整性：

```powershell
npm.cmd run annotation:text:status
```

手动建立标签快照：

```powershell
npm.cmd run annotation:text:backup
```

恢复时只接受 `artifacts/media-search-text-annotation/backups` 内的文件，并要求数据集指纹一致和显式确认：

```powershell
npm.cmd run annotation:text:restore -- judgments-2026-07-12T14-45-59-342Z.json --confirm
```

HTTP 路由与图片读取回归：

```powershell
npm.cmd run annotation:text:smoke
```

## 输出

- `artifacts/media-search-text-annotation/dataset.json`：候选池和中英排序。
- `artifacts/media-search-text-annotation/judgments.json`：人工标签。
- `artifacts/media-search-text-annotation/judgment-events.jsonl`：追加式标签修改审计日志。
- `artifacts/media-search-text-annotation/backups/`：最多保留最近 20 个标签快照。
- `artifacts/media-search-text-annotation/evaluation.json`：评测结果。

评测按概念、语言和 `@10/@20/@50` 输出 Precision、Judged Precision、Pooled Recall、nDCG、覆盖率与已判断数。报告顶层输出总覆盖率、完整概念数和 `publishable` 状态；`aggregate` 分别汇总英文、中文的宏平均 Precision、Judged Precision、Pooled Recall 和 nDCG，并记录每个 cutoff 的可用概念数。

未完整标注时：

- 未覆盖完整 TopK 的 Precision 为 `null`，不会把未标注项错误计为不相关。
- Pooled Recall 和 nDCG 在候选池完整判断前为 `null`。
- `publishable` 保持 `false`，报告包含 provisional warning。
- Judged Precision 可用于观察当前已判断子集，但不能作为最终准确率发布。

`Pooled Recall` 只表示在合并候选池内找回的相关项比例，不等同于对全部 9,423 帧穷举人工标注得到的完整语料 Recall。报告准确率前，应确保目标 cutoff 内没有未判断项，并披露每个概念的已判断覆盖率。

## 安全与可靠性

1. 服务只监听 `127.0.0.1`。
2. 图片接口仅允许读取生成候选池中的白名单路径。
3. 请求体限制为 4 KiB，非法 JSON 返回 400。
4. 连续按键期间前端锁定重复提交，服务端串行化原子写入；单次写入失败不会破坏后续保存队列。
5. `prepare` 不覆盖已有 `judgments.json`，重新生成候选池时可保留已完成标注。
6. 状态和评测报告记录候选集 SHA-256 指纹；候选、排序或模型输出变化后可识别数据版本。
7. 完整性校验覆盖重复 ID、排序越界、非法标签、陈旧标签和缺失图片；存在错误时 `publishable` 必须为 `false`。
8. 每次标签修改追加时间、数据集指纹、前值和后值，支持审计与异常恢复。
9. 完整文件检查只在加载、状态检查和评测时执行；单次标注保存采用常数时间状态更新，避免逐图重复扫描候选文件。
10. 已有标签时，每次启动标注服务自动建立快照；相同数据集和标签指纹不会重复备份。
11. 恢复命令拒绝目录外文件、指纹不匹配文件和未通过完整性校验的标签，并在恢复前再次备份当前状态。
12. HTTP 异步处理统一捕获异常；读取期间消失的图片会安全关闭响应，不形成未处理 Promise。
13. 所有响应包含 CSP、`nosniff`、拒绝嵌入和 `no-store`；JSON 空值、非法结构和超过 4 KiB 的请求会被拒绝。
14. 标注事件日志达到 5 MiB 后自动轮转，最多保留 5 个历史日志，避免长期返工产生无界增长。
15. 标注服务启动前执行完整性门禁；缺失图片、非法标签、重复 ID 或排序越界时拒绝进入可写状态。
16. 收到 `SIGINT/SIGTERM` 后停止接收新请求，等待当前标签写入队列完成，再关闭连接。

## 当前验证

- `annotation:text:prepare`：通过，生成 12 个概念、1,748 个候选。
- `annotation:text:evaluate`：通过；零标签状态按预期输出 `null` 指标、0 覆盖率和 `publishable: false`。
- `annotation:text:smoke`：通过；状态 API、真实帧白名单读取和非法请求处理正常。
- 指标 readiness 自测：通过；部分覆盖不生成正式 Precision/Recall，完整覆盖后计算结果正确。
- 聚合指标自测：通过；中英文宏平均只纳入达到相应覆盖门槛的概念。
- 真实数据完整性：通过；指纹 `b5434b8240113b8ccd75081ccdcf57963a411a1c4a70703829b54f3ac61cf752`，缺失文件、陈旧标签和结构错误均为 0。
- 备份与恢复保护：备份生成通过；缺少确认和目录逃逸两类恢复请求均按预期拒绝。
- 阶段统计：通过；四阶段候选数合计 1,748，与完整候选池一致。
- HTTP 加固：非法 JSON/空值返回 400，超限请求返回 413，安全响应头和真实帧读取通过。
- 完整性门禁合成测试：有效数据通过，非法标签和缺失图片按预期拒绝。

下一步只需要人工完成标签，再冻结 `judgments.json` 作为搜索准确率回归基线。模型、查询翻译、排序或索引逻辑变更后必须重新运行 evaluate，并与该基线比较。
