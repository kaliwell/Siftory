# 通用 / 固定监控最终覆盖素材

> 日期：2026-08-15  
> 对应任务：`VAL-212` / `VID-016`  
> 状态：当前
> 实施状态：24 条已下载、验证并完成人工 profile 归类

## 范围

- 通用候选：12 条，覆盖烹饪、步行、动物和列车等不同普通场景。
- 固定监控候选：12 条，来自安全摄像机、CCTV 或自动固定相机影像。
- 来源为 [Wikimedia Commons 视频总类](https://commons.wikimedia.org/wiki/Category:Videos)、[Security camera footage](https://commons.wikimedia.org/wiki/Category:Security_camera_footage)、[Videos of cooking](https://commons.wikimedia.org/wiki/Category:Videos_of_cooking)、[Videos of people walking](https://commons.wikimedia.org/wiki/Category:Videos_of_people_walking) 与各文件说明页。
- 目录与 Commons 分类只用于提出候选，不直接作为人工真值；页面仍要求逐条观看、接受、改判或跳过。
- 监控组可能包含事故或爆炸画面，页面已经显示内容提醒，不适时可直接跳过。

素材只用于本地验证，不进入应用安装包。每条许可、来源页、作者归属、下载 URL、SHA-256 和 ffprobe 结果保存在 `D:\vdo\2\local-curated-manifest.json` 与 `D:\vdo\2\wikimedia-commons-attribution.md`；重新分发时必须分别遵守原始许可。

## 下载与恢复

普通网络：

```powershell
npm.cmd run corpus:profiles:final-gap
```

当前本机显式代理：

```powershell
npm.cmd run corpus:profiles:final-gap:proxy
```

下载器使用 `--set=final-coverage` 将本批次与会议/体育批次隔离；已有文件只有在精确体积和 SHA-256 都匹配时才复用。对 Wikimedia HTTP 429 按 `Retry-After` 等待，单文件限制 160 MiB。为覆盖真实低清监控素材，允许 144p 至 480p 的 WebM 转码；低于 144p、非 WebM、越界域名或非开放许可仍会被拒绝。

## 机器验证

- 请求 24、下载或本地复核 24、失败 0。
- 总体积 90.6 MiB，总时长约 23.9 分钟；单条约 9.6 秒至 201.8 秒。
- 23 条 VP9、1 条 VP8；20 条含音轨、4 条无音轨。
- 24/24 本地文件体积与 SHA-256 复算一致。
- 24/24 通过 ffprobe 媒体信息检查。
- 24/24 通过验收服务的 1024 字节 HTTP Range 检查，均返回 `206`。
- 状态 API 只返回匿名候选 ID、技术特征和建议 profile，不暴露本地路径、文件名、Commons 标题、来源页、URL 或 SHA-256；无令牌访问返回 `403`。
- 专项测试 21/21 通过，覆盖批次隔离、独立私有状态、匿名响应和受控播放。

## 人工验收

局域网服务使用端口 `4183`：

```powershell
npm.cmd run review:profiles:final-gap:lan
```

结果独立保存到：

```text
%APPDATA%\floating-clock-electron\media-search\semantic\reviews\video-profile-final-coverage-review.json
```

导出文件名为 `video-profile-final-coverage-summary.json`。人工结果已完成24/24：通用接受11、固定监控接受13，两类均超过10条；导出、私有状态和固定候选ID逐条一致。合并后通用真值15、固定监控真值16，八类profile真值门禁已经通过。详见[最终覆盖人工复核](../benchmarks/2026-08-15-video-profile-final-coverage-human-review.md)。新增36条Qwen结果全部严格解析并完成深度人审，最终80/80门禁通过；机器报告见[最终8×10覆盖基准](../benchmarks/2026-08-15-qwen3-vl-2b-profile-final-coverage.md)，最终结论见[VID-016最终验收报告](../benchmarks/2026-08-15-video-profile-final-report.md)。
