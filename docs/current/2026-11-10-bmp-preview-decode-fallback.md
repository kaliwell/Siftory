# BMP 预览解码降级路径

> 状态：当前  
> 更新日期：2026-11-10  
> 范围：`electron/thumbnailIpc.ts`、`electron/osThumbnailFallback.ts`、`shared/thumbnailPolicy.ts`  
> 替代文档：无（补充 [Alpha 24 发布记录](2026-11-07-alpha24-release.md) 中未解决的 BMP 限制）

## 结论

Alpha 24 真实图库抽样里的 8 张 BMP 返回 `Cannot decode`，根因不是文件损坏，而是预览链路里没有可用的 BMP 解码器：`sharp` 所属的 libvips 构建没有 BMP 加载器，Electron `nativeImage` 只解 PNG/JPEG。修复方式是在 CPU 预览链路末尾追加一次系统缩略图解码（Windows WIC / macOS），仅对 `.bmp`、`.ico` 生效；成功结果沿用原有缩放、编码和缓存流程。损坏文件仍返回原错误，不会显示通用文件图标。

## 问题与证据

只读扫描本机活动素材目录（不复制、不改写源文件），得到 995 个实际存在的 BMP：

| 变体 | 数量 | `sharp` | `nativeImage` | 系统缩略图 |
| --- | --- | --- | --- | --- |
| 24 位 BI_RGB | 383 | 失败 | 空图 | 成功 |
| 8 位调色板 | 565 | 失败 | 空图 | 成功 |
| 1 位 | 21 | 失败 | 空图 | 成功 |
| 32 位 BI_RGB | 18 | 失败 | 空图 | 成功 |
| 4 位调色板 | 6 | 失败 | 空图 | 成功 |
| BITMAPINFOHEADER 124 + BI_BITFIELDS | 4 | 失败 | 空图 | 成功 |
| OS/2 BITMAPCOREHEADER（12 字节头） | 1 | 失败 | 空图 | 成功 |
| 扩展名为 `.bmp`，内容实为 PNG | 1 | 成功 | 成功 | 未触发 |

- `sharp`：994/995 报 `Input file contains unsupported image format`；唯一成功的是那张实为 PNG 的文件。libvips 版本 8.18.7。
- `nativeImage.createFromBuffer` / `createFromPath`：994 张真实 BMP 全部为空图。
- 普通图库预览调用 `generateImageThumbnail(..., 'cpu')`，不带 GPU 池，因此上述两条失败后直接落到 `Cannot decode`；GPU 路径本来就能解 BMP，但不是默认预览路径。

## 修复

1. `electron/osThumbnailFallback.ts` 新增 `createOsThumbnail()`：调用 `nativeImage.createThumbnailFromPath` 取系统缩略图，异常、空图或平台不支持时返回 `null`，不抛错、不中断缩略图批次。
2. `shared/thumbnailPolicy.ts` 新增 `shouldUseOsThumbnailFallback()`，只放行 `.bmp`、`.ico`；其他格式不额外触发 shell 查询，保持原链路和性能特征。
3. `electron/thumbnailIpc.ts` 在 `createFromPath` 失败之后、返回 `Cannot decode` 之前插入一次降级；成功结果进入既有缩放、`toDataURL` 与缓存写入。
4. 构建图 `main` 预算由 323 调至 324，并在 `scripts/check-build-graph.cjs` 注释中说明该节点只隔离平台解码边界，不引入依赖或渲染进程/Worker 边。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npm.cmd run typecheck` | 通过 |
| Lint | `npm.cmd run lint` | 通过 |
| 专项单测 | `node --test tests/thumbnail-policy.test.cjs tests/os-thumbnail-fallback.test.cjs tests/thumbnail-rebuild-pipeline.test.cjs` | 23/23 通过 |
| 构建图 | `node scripts/check-build-graph.cjs` | 通过（main 324/324） |
| 真实解码冒烟 | `npm.cmd run smoke:thumbnails:bmp` | 通过（7 种 BMP 变体 + 四象限内容校验 + 无效文件拒绝） |
| 真实图库只读抽样 | 一次性本地探针（不入库） | 994/994 经系统缩略图返回非空图像 |

冒烟在 Electron 42.11.18 / Windows 11 上生成固定 BMP：24 位上下翻转、24 位自上而下、32 位、8 位调色板、4 位调色板、1 位、OS/2 core 头。全部满足：`createImageBitmap`/`createFromPath` 的原链路前提被记录、系统缩略图非空、尺寸不超过请求上限、宽高比与源图一致、可编码为 PNG。四象限样例解码后四个象限颜色与源文件完全一致，证明取到的是像素内容而不是通用文件图标；无效 `.bmp` 返回拒绝。

## 边界与未验证

- 只在 Windows 验证；macOS 依赖同一 Electron API 但未实测，Linux 会抛错并按原逻辑返回 `Cannot decode`。
- 系统缩略图可能把小图放大到请求尺寸（例如 16×16 返回 256×256），清晰度不会优于原图，缓存条目体积略增；沿用相同分辨率桶与既有缓存淘汰策略，未新增预算。
- 首次降级调用实测 13–139ms，之后命中缩略图缓存；网络共享路径的耗时未测量。
- GPU 缩略图路径、原生旁路、缓存格式和扩展名白名单均未改动。
- 未验证：覆盖安装后的真实用户缓存命中、Linux/macOS 行为，以及“合法但系统也无法解析”的 BMP 是否可能返回图标（本轮无效文件被拒绝）。

## 下一步

发布候选在真实图库复核 BMP 预览；若放大缓存成为实际占用问题，再对系统缩略图结果增加源尺寸上限。
