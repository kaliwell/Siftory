# Media Search Manifest Cache Benchmark

> 状态：当前性能基线  
> 日期：2026-07-12  
> 平台：Windows x64 / Node.js v24.16.0  
> 命令：`npm.cmd run benchmark:media-search:manifests`

## 目标

验证 `video_files.jsonl` 与 `video_frames.jsonl` 在 10K/100K 规模下的完整加载和 UI Preview 冷/热耗时。热加载目标为 P95 小于 20 ms。

## 数据集

Benchmark 在系统临时目录生成 synthetic JSONL，结束后自动删除：

| 规模 | Video manifest | Frame manifest |
| ---: | ---: | ---: |
| 10,000 | 2,143,344 bytes | 2,263,337 bytes |
| 100,000 | 22,033,345 bytes | 23,233,337 bytes |

UI Preview 分别请求最近 200 条视频和最近 500 条帧。热加载连续执行 25 次并统计 P95。

## 优化前问题

完整 manifest 已有 `size + mtime + absolute path` 签名缓存，但 `loadVideoManifestPreview()` 和 `loadVideoFrameManifestPreview()` 每次仍执行完整 `readFileSync(...).split()`。

100K 基线：

| 路径 | 冷加载 | 热加载 P95 | 判断 |
| --- | ---: | ---: | --- |
| Video 完整加载 | 111.716 ms | 1.634 ms | 通过 |
| Frame 完整加载 | 99.222 ms | 1.596 ms | 通过 |
| Video Preview | 52.264 ms | 82.465 ms | 失败 |
| Frame Preview | 64.450 ms | 70.436 ms | 失败 |

Preview 热加载没有命中缓存，重复 Refresh 会持续读取约 22 MB 文件并创建完整行数组。

## 实施内容

1. Video Preview 新增签名缓存，最多保存 1,000 条最近记录和总数。
2. Frame Preview 新增签名缓存，最多保存 2,000 条最近记录和总数。
3. 完整 manifest 已加载时直接派生 Preview，不重复读盘。
4. manifest 写入时同步更新 Preview cache。
5. 显式 invalidation 同时清理完整、计数、ready catalog 和 Preview cache。
6. 文件大小或 mtime 变化后签名自动失效并重新读取。
7. 新增回归测试，统计两次 Preview 调用的 `readFileSync` 次数，并验证 append 后重新加载。

## 优化后结果

### 10K

| 路径 | 冷加载 | 热加载 P95 |
| --- | ---: | ---: |
| Video 完整加载 | 19.343 ms | 3.283 ms |
| Frame 完整加载 | 15.331 ms | 3.022 ms |
| Video Preview | 9.787 ms | 4.072 ms |
| Frame Preview | 11.392 ms | 3.206 ms |

### 100K

| 路径 | 冷加载 | 热加载 P95 | 相对优化前 |
| --- | ---: | ---: | ---: |
| Video 完整加载 | 166.195 ms | 2.506 ms | 基本持平，仍通过 |
| Frame 完整加载 | 109.010 ms | 2.353 ms | 基本持平，仍通过 |
| Video Preview | 74.034 ms | 2.371 ms | P95 降低约 97.1% |
| Frame Preview | 73.899 ms | 3.389 ms | P95 降低约 95.2% |

## 结论

100K 规模下四条热加载路径均低于 4 ms，满足 P95 小于 20 ms 的目标。Media Search 打开窗口后的重复 Refresh 不再重复读取完整 manifest。

冷加载仍需要读取和扫描完整 JSONL，100K 当前约 74–166 ms。该结果尚未达到引入二进制 manifest 或 worker 的触发阈值；后续应先用真实 170K+ 数据测量 Electron IPC 总耗时，再决定是否迁移异步 reader。

## 验证

| 项目 | 结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run lint` | 通过 |
| `npm.cmd run test:media-search` | 22/22 通过 |
| `npm.cmd run benchmark:media-search:manifests` | 通过 |
| `npm.cmd run build:renderer` | 通过 |
