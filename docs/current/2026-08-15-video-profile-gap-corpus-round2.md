# 会议/体育第二批开放许可素材

> 日期：2026-08-15  
> 对应任务：`VAL-206` / `VID-016`  
> 状态：当前
> 实施状态：24 条已下载、验证并完成人工归类

## 来源与范围

- 来源：[Wikimedia Commons Interview videos](https://commons.wikimedia.org/wiki/Category:Interview_videos)与[Videos of sports](https://commons.wikimedia.org/wiki/Category:Videos_of_sports)
- 会议/访谈候选：12条
- 体育候选：12条
- 总体积：438.6 MiB
- 总时长：约82.1分钟
- 单条时长：约49.6秒至11.7分钟
- 视频格式：18条VP9、6条VP8 WebM；23条含Opus或Vorbis音轨，1条无音轨

素材使用CC BY、CC BY-SA或Public Domain许可。每条实际许可、来源页和作者归属保存在`D:\vdo\2\wikimedia-commons-attribution.md`及`local-curated-manifest.json`，不得脱离各自许可条件重新分发；素材不随应用安装包发布。

## 下载与恢复

普通网络：

```powershell
npm.cmd run corpus:profiles:gap
```

当前本机显式代理：

```powershell
npm.cmd run corpus:profiles:gap:proxy
```

下载器只访问`commons.wikimedia.org`元数据API和`upload.wikimedia.org`媒体文件，优先选择240p/360p WebM转码，单文件硬限制160 MiB。HTTP 429或服务端错误会按`Retry-After`退避；已有文件只有在体积和SHA-256继续匹配时才复用，不保留`.partial`失败文件。

## 验证结果

- 请求24、下载或本地复核24、失败0。
- 24/24通过ffprobe视频流、时长、分辨率与编解码器检查。
- 24/24通过验收服务器的1024字节HTTP Range检查，均返回`206`。
- 专项状态共31条：首轮7条保持已跳过，第二批24条未复核；会议候选16、体育候选15。
- 状态API不包含Commons标题、文件名、来源页、媒体URL、SHA-256或本地路径。

## 门禁

目录类别与Commons分类只用于提出候选，不直接作为人工真值。用户匿名导出已完成31/31：首轮跳过7，第二批接受24；会议/访谈接受12、体育接受12。逐ID审计确认导出、私有状态与Commons清单完全一致，因此`VAL-206`已标记`verified`。最终报告仍等待`VAL-207`的完整观看、幻觉和时间点真值。
