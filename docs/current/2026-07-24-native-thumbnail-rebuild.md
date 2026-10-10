# 独立缩略图重建 C++/CUDA 后端

> 状态：当前
> 更新日期：2026-08-17
> 范围：Native 缩略图重建后端与 CUDA 回退边界
> 替代文档：无

日期：2026-07-24

## 结论

数据编辑管理器的“重建优化缩略图”新增独立 C++ 后端，不再要求图片经过 Node
Buffer、base64 data URL、Chromium Canvas 和文本`.thumb`写入链。当前 C++ 后端面向
JPEG/JPG，直接使用 WIC 流式解码、缩放并编码为二进制 JPEG 缓存。

RTX 3050 驱动可用，但开发机没有 CUDA Toolkit、`nvcc` 或`nvJPEG`运行库。因此界面提供
`CUDA / nvJPEG preferred`能力检测入口；当前构建会明确显示原因并回退到
`native-cpp`，不会把 WebGL 或 CPU 工作伪报为 CUDA。

## 流水线

```text
C++ recursive_directory_iterator
  -> bounded path queue (48)
  -> 2..20 WIC worker（严格使用用户设置）
  -> JPEG metadata / EXIF Orientation
  -> IWICBitmapSourceTransform 尝试缩小解码
  -> 256px WIC Fant scale
  -> WIC JPEG quality 0.78
  -> 临时文件
  -> MoveFileExW 原子发布 v6 .jpg
```

目录遍历和工作队列均在 C++ 内完成，不先把三十多万路径存入 JavaScript 数组。队列固定为
48，避免继续提高 worker 数时无限增加内存。

## 界面

Acceleration 新增：

- `Native C++ (JPEG fast)`：当前推荐的大型 JPEG 数据集后端。
- `CUDA / nvJPEG preferred`：检测真正的 CUDA/nvJPEG；不可用时原生回退。
- 原有 Auto、GPU preferred、CPU only 保留，处理非 JPEG 或对照测试时仍可使用。

Native/CUDA 模式中的`Workers`严格采用用户选择的2–20偶数值；`Batch`对原生有界队列无意义，
运行时禁用。

## 验证

- C++ Node ABI构建通过，共编译4622个函数。
- TypeScript类型检查与Prettier检查通过。
- 原生专项测试4/4通过。
- 流水线专项测试9/9通过。
- `npm test`全量回归通过，0失败；最终原生套件33/33通过。
- `npm run build`正式构建通过；Electron 42.4.1 ABI重新编译4622个函数。
- `node tests/electron-ui-smoke.cjs`通过；6个面板、0控制台错误，运行时连接
  `fast_scanner 0.5.0`；缓存递归修复后的正式版本为`0.5.1`。
- EXIF Orientation 6输入`120x240`，输出`240x120`。
- CUDA请求会报告`cudaRequested=true`；环境缺少nvJPEG时报告
  `effectiveBackend=native-cpp`和明确的`cudaError`。

PxHere固定256张、不超过2MiB的JPEG，全部0失败：

| Workers | 耗时   | 吞吐量       |
| ------: | -----: | -----------: |
|       4 | 11.99秒 | 21.4 img/s |
|       8 |  8.52秒 | 30.0 img/s |
|      18 |  7.05秒 | 36.3 img/s |

截图中的旧Auto流水线约为26.4 img/s；相同机器上的原生18 worker专项基准约高37.5%。两次数据
样本和系统负载并非完全相同，最终应以完整PxHere运行的状态栏平均值为准。

基准使用同卷临时硬链接，结束后已删除，未修改源图片。

正式安装包：

- 路径：`release/FloatingClock Setup 1.0.0.exe`
- 大小：600,765,620字节
- SHA-256：`FC2460E6FA6FCCC2831220D27A103387708C7730A5AFAB36B91EB441621858B6`

## 限制与CUDA后续

1. 当前原生快路只重建JPEG/JPG；其他格式继续选择原有Auto/GPU/CPU流水线。
2. 真正的CUDA实现需要安装与驱动匹配的CUDA Toolkit和nvJPEG开发/运行库，然后增加
   nvJPEG批量解码与CUDA缩放内核；这是构建依赖，不应静默下载数GB工具链。
3. 256px缩略图的JPEG编码、文件系统读取和原子写入仍是CPU/磁盘工作，CUDA不会让GPU达到
   100%，吞吐量而非GPU占用率才是正确指标。
4. 16GB内存环境建议先使用8 workers；18 workers吞吐更高，但会增加同时解码的峰值内存。
