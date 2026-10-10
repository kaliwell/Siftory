# 视频语义剩余项自动推进 TODO

> 日期：2026-08-15  
> 状态：当前  
> 实施状态：自动推进中  
> 选择命令：`npm.cmd run todo:video-next`  
> 结构校验：`npm.cmd run todo:video-check`

## 自动执行规则

1. `auto` 项按依赖顺序自动领取，代码、测试、真实只读审计和文档均完成后才标为`verified`。
2. 自动流程可以读取用户已经明确纳入VID-016的44条匿名计划、受控缓存帧和模型结果，但不扩大真实素材范围。
3. `approval`项只提供网页、状态检测和匿名导出，不能自动填写人工结论，也不能伪造会议/体育素材、完整观看或时间点真值。
4. v1、六条回归和44条v7影子结果均为只读基线；任何新分析写入独立状态或复核文件。
5. 自动项失败时保留`in_progress`和可恢复状态，不跳过到后续结论。

## 机器可读任务表

| Rank | ID      | Value | Mode     | Dependencies              | External blockers | Branch                              | Status   | Validation                                                         | Task                                       |
| ---: | ------- | ----: | -------- | ------------------------- | ----------------- | ----------------------------------- | -------- | ------------------------------------------------------------------ | ------------------------------------------ |
|    1 | VAL-201 |   100 | auto     | -                         | -                 | `feat/video-v7-shadow-audit`        | verified | frozen plan + 44/44 strict JSON + privacy + resource report        | 完成44条v7独立影子基准与机器审计           |
|    2 | VAL-202 |    98 | auto     | VAL-201                   | -                 | `feat/video-v1-v7-review-page`      | verified | 44 paired results + mobile player + private atomic save            | 建立全44条v1/v7差异验收网页                |
|    3 | VAL-203 |    96 | auto     | VAL-202                   | -                 | `feat/video-v1-v7-diff-ranking`     | verified | bounded changed-field ranking + anonymous export                   | 自动生成差异优先级并优先呈现原38条“像”样本 |
|    4 | VAL-204 |    94 | approval | VAL-203                   | -                 | `ops/video-v7-human-review`         | verified | 44/44 verdict + output preference + full-watch flags               | 判定v7对原正确样本是否存在明显退化         |
|    5 | VAL-205 |    90 | auto     | VAL-204                   | -                 | `docs/video-v7-adoption-report`     | verified | private-state match + regression summary + adoption gate           | 自动汇总人工导出并形成v7采用结论           |
|    6 | VAL-209 |    89 | auto     | VAL-205                   | -                 | `docs/video-v7-regression-lock`     | verified | six anonymous regressions + profile risk report                    | 锁定6条新退化集并生成profile风险分层       |
|    7 | VAL-210 |    88 | auto     | VAL-209                   | -                 | `feat/video-v8-targeted-mitigation` | verified | independent six-sample canary + strict JSON + resource gate        | 对6条新退化样本执行有界修复和独立复测      |
|    8 | VAL-211 |    87 | approval | VAL-210                   | -                 | `ops/video-v8-human-gate`           | verified | 6/6 paired preference + protect-correct regression gate            | 人工确认定向修复没有再次替换正确描述       |
|    9 | VAL-206 |    86 | approval | VAL-211                   | -                 | `ops/video-profile-gap-corpus`      | verified | meeting 10 + sports 10 + profile truth                             | 补齐会议与体育profile样本                  |
|   10 | VAL-207 |    82 | approval | VAL-211                   | -                 | `ops/video-deep-ground-truth`       | verified | full-watch + hallucination + timestamp truth                       | 建立完整观看、幻觉和时间点人工真值         |
|   11 | VAL-212 |    80 | approval | VAL-207                   | -                 | `ops/video-final-coverage-gap`      | verified | general 10 + surveillance 10 + semantic 8×10 human truth           | 补齐最终8×10真值与缺口语义验收             |
|   12 | VAL-208 |    78 | auto     | VAL-206; VAL-207; VAL-212 | -                 | `docs/video-profile-final-report`   | verified | per-profile semantic acceptance + hallucination + timestamp report | 自动生成完整8×10最终验收报告并关闭VID-016  |

## 当前领取

全部12项已经完成。最终80条模型结果严格解析80/80，八类profile各10条均已完整观看并完成人工一致性、幻觉和时间点判断；聚合审计输出`profileTruthReady=true`、`deepTruthReady=true`、`semanticCoverageReady=true`、`finalReady=true`。`VAL-212`与`VAL-208`已标记`verified`，VID-016工程验收关闭。正式检索Recall@K仍因缺少查询—相关结果排名标注而不可用，本轮只报告人工语义接受率代理指标。

## VAL-212工具准备

- 新增`final-coverage`独立素材集：通用12条、固定监控12条，全部来自Wikimedia Commons开放许可文件页；下载或复核24/24、失败0，总计90.6 MiB、约23.9分钟。
- 下载器新增`--set=final-coverage`，支持独立命令`corpus:profiles:final-gap`与显式代理版本；会议/体育批次的目录、文件名和人工状态不受影响。
- 验收服务新增`--gap-profile-set=final-coverage`和4183端口入口，只显示通用/固定监控，结果保存到`video-profile-final-coverage-review.json`，导出`video-profile-final-coverage-summary.json`。
- 24/24 SHA-256与体积复算、ffprobe和HTTP Range播放通过；未授权API返回403，授权状态未暴露本地路径、文件名或Commons来源身份。专项测试21/21通过。
- 监控候选可能包含事故或爆炸画面，页面提供明确提醒并允许直接跳过。素材分类仍只是候选建议，不能替代人工真值。
- 完整下载、许可和验收说明见[通用/固定监控最终覆盖素材](2026-08-15-video-profile-final-coverage-corpus.md)。
- 人工导出24/24与私有状态、固定候选逐条一致：通用11、固定监控13，合并后两类分别为15和16，`profileTruthReady=true`；详见[最终覆盖人工复核](../benchmarks/2026-08-15-video-profile-final-coverage-human-review.md)。
- 最终80条匿名计划已生成：冻结V1基线44条全部保留，只新增通用6、会议10、游戏3、固定监控7、体育10；36条共准备144张受控缓存帧，模型运行时不读原视频。新结果写入独立`qwen3-vl-2b-profile-final`目录。
- 最终语义结果已完成80/80，严格JSON解析80/80、缺失0；V1只读复用44条，新增36条独立保存。新增结果平均40.631秒、P95 49.777秒，GPU显存峰值2892 MiB。一次由人工重分类触发的素材解析缺口已修复并通过断点续跑，最终job为`failed=0`。
- 聚合审计确认`profileTruthReady=true`，但新增36条尚未完整观看，当前`fullyWatched=44/80`、`deepTruthReady=false`、`formalRecallAvailable=false`。机器阶段报告见[最终8×10覆盖基准](../benchmarks/2026-08-15-qwen3-vl-2b-profile-final-coverage.md)。

## 已完成

- `VAL-201`：v7影子基准44/44严格JSON、0失败，与v1冻结计划44/44一致；平均39.902秒、GPU峰值2737 MiB，未覆盖旧结果且隐私检查通过。
- `VAL-202`：同一带令牌服务新增`/shadow`页面和独立私有状态，读取冻结44条v1/v7结果；复用真实比例播放器、完整片段播放、改善/持平/退化、输出偏好、完整观看、私有备注和匿名导出。真实只读检查为44/44可比较，路径及身份字段泄漏0。
- `VAL-203`：新增`npm.cmd run todo:video-auto`，自动校验影子job和44对严格结果，生成不含语义正文、路径或名称的差异优先级清单；38条原“像”样本以`protect-correct`优先展示，6条已知非严格一致样本标为`known-regression`，变化分数范围4–17。专项测试14/14、TODO结构、定向Lint和格式检查通过。
- `VAL-204`：人工差异复核完成44/44，改善31、持平7、退化6；偏好v7/v1为31/7，两版相当5、均不理想1。原38条“像”中改善25、持平7、退化6，完整观看0，因此全局无退化门禁失败。
- `VAL-205`：自动校验导出与私有状态、冻结计划和profile均44/44一致，生成`vid-016-v7-adoption-gate.json`；结论为`targeted-mitigation-required`，未把总体多数偏好误写成全面通过。
- `VAL-209`：固定6条新退化匿名ID；风险集中在通用2/4、监控2/3，短视频和课程各1条，影视与游戏0条。详见[44条人工差异报告](../benchmarks/2026-08-15-qwen3-vl-2b-profile-v7-shadow-human-review.md)。
- `VAL-210`：V8.1定向缓解集6/6严格JSON、0失败，平均约36秒、GPU峰值2553 MiB；独立目录未覆盖V1/V7。提示词补齐跨地点、前景优先、稳定物体、游戏/仿真和监控用途边界，严格解析器对无转写说话词、敏感人物属性及监控用途误推做可审计中和。自动违规扫描0条；`/mitigation`提供V7/V8.1同片段人工对照。详见[V8.1定向缓解报告](../benchmarks/2026-08-15-qwen3-vl-2b-profile-v8-mitigation.md)。
- `VAL-211`：人工完成V7/V8.1六条对照，改善2、持平3、退化1；偏好V8.1为2、V7为1、相当1、两版都不理想2，完整观看0。首条监控备注确认画面只有1人，而两版均误判多人。无退化保护门禁失败，因此V8.1不升为默认提示词，生产默认恢复V7；不按匿名样本ID建立特判。详见[V8.1人工门禁报告](../benchmarks/2026-08-15-qwen3-vl-2b-profile-v8-mitigation-human-review.md)。

## VAL-206已完成的工具准备

- 已只读接入`D:\vdo\2\local-curated-manifest.json`，只挑选`02_meeting`与`03_sports`，形成7条匿名候选（会议4、体育3）；中文对话目录不被误算入本轮profile缺口。
- 新增`npm.cmd run review:profiles:gap`和`npm.cmd run review:profiles:gap:lan`。页面只显示会议/体育两类，复用真实比例Range播放器、手机布局、键盘操作、自动保存和匿名导出。
- 本轮使用独立私有状态`video-profile-gap-corpus-review.json`，不会覆盖原192条候选归类、44条基准或其他人工复核记录。
- 清单BOM、越界路径、匿名ID、受控Range和导出身份泄漏均有自动测试；真实7条均通过HTTP 206读取检查。工具准备完成不等于profile真值完成，`VAL-206`继续保持`blocked`。
- 用户导出的7/7记录与私有状态和固定候选ID完全一致，结果为跳过7、接受0，匿名导出没有路径、名称、私有备注或自由文本。该轮没有形成任何会议/体育有效真值，缺口恢复为会议10条、体育10条。
- 第二批新增24条Wikimedia Commons开放许可候选，会议/访谈12、体育12，共438.6 MiB、约82.1分钟；每条保存来源页、许可、归属、转码URL、SHA-256和ffprobe媒体信息。验收API继续只暴露匿名ID，24/24 Range播放检查通过。
- `VAL-206`：第二批匿名导出31/31完成，其中首轮跳过7、第二批接受24；会议/访谈接受12、体育接受12，两类均超过目标。24个接受ID与私有状态、Commons清单逐条一致，无重复、profile错配或额外字段，`readyForBenchmark=true`。详见[第二批人工复核报告](../benchmarks/2026-08-15-video-profile-gap-corpus-round2-human-review.md)。
- 操作和验收口径见[会议/体育缺口验收页](2026-08-15-video-profile-gap-corpus-review.md)。
- 人工结果与一致性审计见[会议/体育缺口人工复核](../benchmarks/2026-08-15-video-profile-gap-corpus-human-review.md)。
- 第二批下载、许可和安全审计见[会议/体育第二批开放许可素材](2026-08-15-video-profile-gap-corpus-round2.md)。

## VAL-207验收入口修复

- 原`/benchmark`页默认筛选“待复核”，但44条均已完成快速初筛，导致列表为0而看起来没有内容；服务端数据始终为44/44可用，没有丢失。
- 默认筛选已改为“待深度验收（未完整观看）”，当前显示44条。顶部进度改为区分完整观看与初筛，勾选“已完整观看该验收片段”后自动进入下一条。
- 页面与脚本均使用`Cache-Control: no-store`，专项24/24和TODO结构检查通过。该修复只提供工具，不代替人工完成`VAL-207`。
- 首份深度导出与固定44条计划及私有状态一致：语义接受41/44、严格一致37/44、轻微幻觉3、明显幻觉0；17条时间点适用，其中准确9、大致7、错误1。但`watchedFullSegment`为0/44，因此仅记为部分进度。
- 匿名汇总新增`fullWatch`和`deepTruthReady`；完整观看未达到44/44时页面禁用最终导出并显示剩余数，避免把已填写判断误当成完成。详见[VAL-207部分人工结果](../benchmarks/2026-08-15-video-deep-ground-truth-partial-review.md)。
- `VAL-207`：第二份匿名导出44/44完整观看、ID/profile/私有状态逐条一致，`deepTruthReady=true`；一致34、部分6、不一致4，轻微幻觉3、明显幻觉0。18条时间点适用，其中准确9、大致8、错误1。详见[VAL-207最终人工结果](../benchmarks/2026-08-15-video-deep-ground-truth-final.md)。

## VAL-208最终预检

- 新增`npm.cmd run todo:video-final-audit`，只输出聚合统计，不包含匿名ID、路径、名称、语义正文或备注。
- 真值覆盖为6/8类：影视18、短视频19、会议12、课程21、游戏14、体育12已达标；通用4、监控3，分别缺6和7。
- 深度语义覆盖为44/80且仅3类达到10条：影视10、短视频10、课程10；游戏7、通用4、监控3、会议0、体育0，共缺36条完整语义验收。
- 由于正式召回率需要完整8×10同口径真值，预检明确`formalRecallAvailable=false`、`finalReady=false`，推荐`complete-profile-truth-coverage`。详见[最终预检报告](../benchmarks/2026-08-15-video-profile-final-preflight.md)。

## VAL-212 / VAL-208最终关闭

- 最终人工状态80/80已判定且80/80完整观看：一致65、部分一致9、不一致6；语义接受率代理指标92.5%，严格一致率81.3%。
- 轻微幻觉3/80、明显幻觉0/80；27条时间点适用，其中准确14、大致11、错误2。
- 八类profile真值、语义计划、严格结果和深度人工真值均达到10/10；最终聚合审计`finalReady=true`，关闭`VAL-212`、`VAL-208`和`VID-016`。
- 报告生成器只输出聚合数据，不包含匿名ID、路径、名称、语义正文或自由备注。详见[VID-016最终验收报告](../benchmarks/2026-08-15-video-profile-final-report.md)。
- `formalRecallAvailable=false`继续保留：本报告没有检索查询、相关结果集合和排名标注，因此不把语义接受率冒充Recall@K。
