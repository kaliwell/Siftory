# 会议/体育缺口匿名验收页

> 日期：2026-08-15  
> 对应任务：`VAL-206` / `VID-016`  
> 状态：当前
> 实施状态：第二批 24 条人工归类通过，`VAL-206` 已完成

## 当前素材

- 来源目录：`D:\vdo\2`
- 本轮候选：7条，其中会议/访谈/播客候选4条、体育候选3条
- 未纳入：`01_chinese_dialogue`中的长对话视频；它适合音频/对话测试，但不作为会议或体育profile真值
- 人工结果：7条全部跳过，接受0条，因此没有形成会议或体育真值
- 第二批：Wikimedia Commons开放许可候选24条，其中会议/访谈12条、体育12条
- 人工结果：总计31/31完成；首轮跳过7，第二批接受24
- 最终真值：会议/访谈接受12条、体育接受12条，两类均达到各10条目标

## 启动

本机验收：

```powershell
npm.cmd run review:profiles:gap
```

同一局域网手机验收：

```powershell
npm.cmd run review:profiles:gap:lan
```

使用启动日志给出的带令牌URL；手机和电脑需在同一局域网。页面只提供`会议/访谈/播客`、`体育`、`跳过`三种人工结论，并自动保存到独立状态文件。

第二批素材可用以下命令重新核验；本机网络使用显式代理版本，不修改系统代理：

```powershell
npm.cmd run corpus:profiles:gap:proxy
```

## 数据边界

- 浏览器API不返回原路径、文件名或私有备注。
- 视频请求只接受服务器生成的匿名候选ID，并校验文件仍位于`D:\vdo\2`内。
- 导出只包含匿名ID、人工profile结论和汇总，不包含真实身份字段。
- 私有进度保存于Media Search应用数据目录的`semantic\reviews\video-profile-gap-corpus-review.json`，不修改原视频，也不覆盖既有profile复核状态。

## 已验证

- 7/7候选存在且可通过HTTP Range返回`206`。
- 会议4条、体育3条，页面只激活这两个profile。
- UTF-8 BOM清单可读取；目录外路径会被拒绝。
- 专项测试、`test:media-search`、类型检查、定向Lint、格式和架构检查通过。
- 第二批24/24下载和ffprobe校验成功，24/24通过HTTP Range返回`206`；外部清单入口限制为Commons来源页、`upload.wikimedia.org`文件URL、允许的开放许可、清单内路径与精确文件体积。

网页和机器检查只解决安全播放、保存与统计，不能代替用户观看和归类。因此在两类各达到10条人工真值前，`VAL-206`与`VID-016`不能标记完成。

## 首轮人工结果

`<DATASET>\video-profile-gap-corpus-summary.json`与当前固定候选和私有状态逐条一致：完成7、跳过7、接受0、未复核0。导出只保留匿名汇总，私有备注、路径、名称和自由文本均未导出；`readyForBenchmark`为`false`。详见[人工复核报告](../benchmarks/2026-08-15-video-profile-gap-corpus-human-review.md)。

## 第二批素材

第二批共24条、438.6 MiB、约82.1分钟，单条时长约49.6秒至11.7分钟，包含CC BY、CC BY-SA和Public Domain。完整来源与归属保存在`D:\vdo\2\wikimedia-commons-attribution.md`，不会随应用打包。用户已接受全部24条，逐ID审计通过；详见[第二批记录](2026-08-15-video-profile-gap-corpus-round2.md)和[人工复核报告](../benchmarks/2026-08-15-video-profile-gap-corpus-round2-human-review.md)。
