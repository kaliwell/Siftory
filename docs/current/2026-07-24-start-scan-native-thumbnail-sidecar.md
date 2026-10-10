# Start Scan 原生缩略图旁路

> 状态：当前
> 更新日期：2026-08-17
> 范围：Image Search 扫描与 Native 缩略图旁路
> 替代文档：无

日期：2026-07-24

## 目标

让 Image Search 的 Start Scan 在建立哈希索引时记录新建或已更新的JPEG路径，由独立WIC
worker同时生成缩略图，避免扫描线程同步缩放和后续再次完整枚举目录。

## 实现

原生模块最初从`0.4.3`升级到`0.4.4`并新增旁路；缓存递归和同步缩放修复后的版本为
`fast_scanner 0.5.1`。

```text
Start Scan C++ worker
  ├─ 读取压缩文件
  ├─ STB 解码彩色像素
  ├─ 原有灰度转换与 diffHash/dctHash（未改变）
  └─ 索引提交后只把源路径 try_enqueue，不等待解码或编码
          │
          ▼
  bounded queue：128
          │
          └─ 8个 WIC JPEG worker
                  │
                  ▼
  原子写入 thumbcache/<v6-key>.jpg
```

队列满时索引线程不会等待，而是增加 `thumbnailDropped`。这些图片仍可通过数据管理器的
重建缩略图功能补建。

## 格式和缓存

- 第一阶段仅覆盖 JPEG/JPG。
- JPEG质量为0.78，最大边256px，不放大小图。
- WIC读取EXIF Orientation，在编码前完成旋转/镜像。
- 缓存v6把mtime标准化为整秒，确保Node与Windows `_stat64`生成相同键。
- v6优先读取二进制`.jpg/.png/.webp`，然后读取文本`.thumb`。
- 旧v4文本`.thumb`继续可读，不强制丢弃用户刚生成的旧缓存。
- 临时文件编码完成、COM流关闭后，使用原子替换发布最终JPEG。

## 界面

Advanced Start Scan区域新增`Native thumbs`开关，默认开启并保存到localStorage。

状态栏显示：

```text
Native thumbs: completed/queued · pending N · deferred N · failed N
```

简单模式的Prepare Library未显式传参时也默认启用。

## 安全边界

- 原有图片字节数、尺寸、溢出和SEH解码保护保持不变。
- 原有哈希输入与算法未改；缩略图在灰度哈希路径之外。
- 缩略图队列只保存最大256px的BGR数据，16项约3MiB。
- Stop Scan会停止接收、清空待处理队列并等待正在编码的任务退出。
- 原生环境清理钩子会停止并join缩略图线程。
- PNG/WebP/AVIF/TIFF/PSD继续由现有独立重建流水线处理。

## 验证

专项测试：

- v6原生二进制缓存键与Node计算一致；
- JPEG SOI/EOI完整；
- EXIF Orientation 6的`120×240`源输出为`240×120`；
- 启用/关闭旁路时diffHash和dctHash完全一致；
- 关闭旁路时不生成任务；
- 原生扫描、解码、哈希与TypeScript专项测试全部通过。

PxHere固定64张、每张不超过1MiB的JPEG：

| 模式               | 扫描耗时 | 缩略图结果  |
| ------------------ | -------: | ----------- |
| Native thumbs关闭  |  45.61秒 | 0           |
| Native thumbs开启  |  46.32秒 | 256/256     |
| 扫描阶段额外工作量 |   约1.5% | 0失败/0丢弃 |

该数字衡量的是Start Scan自身，不包含关闭旁路后再执行一次独立缩略图重建所需的第二次
枚举、读取、解码和缓存写入，因此不能当作完整“扫描+缩略图”工作流的回退。

基准使用临时硬链接目录；验证结束后已删除，未修改PxHere源文件。

## 最终构建验证

- `npm test`：全量测试通过，0失败；其中最终原生套件32/32通过。
- `npm run format:check`：通过。
- `npm run build`：通过；C++原生模块以Electron 42.4.1 ABI重新编译，4343个函数完成编译。
- `node tests/electron-ui-smoke.cjs`：通过；6个必需面板全部加载，控制台0错误，运行时连接到`fast_scanner 0.4.4`。
- 正式安装包：`release/FloatingClock Setup 1.0.0.exe`
- 安装包大小：600,755,242字节。
- SHA-256：`43B6D236BEDE53BDF858E35CE8D2EE4A9D0119D73CD004F1051C4B8F3243D939`

## 当前边界和下一步

1. 已存在且被Add New跳过的索引记录不会重新解码，因此不会在本次Start Scan补缓存。
2. 第一阶段只复用JPEG；其他格式仍走独立重建。
3. 下一阶段可增加`Fill Missing`原生模式，但必须保持索引优先并继续使用有界队列。
4. 缩略图解码和缩放已迁到8个WIC后台worker，扫描线程不再同步缩放。
5. CUDA仍应作为可选JPEG后端，不能替代CPU格式回退。
