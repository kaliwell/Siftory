# CUDA 可选运行时打包验收（VAL-011）

日期：2026-08-08

## 结论

CUDA 可选运行时的下载、离线缓存、完整性校验、安装和应用回退链路已完成技术验收。
NVIDIA 组件仍为 `defaultBundled=false`，未获得项目/法律责任人的再分发批准前不得进入发布包。

## 固定版本与边界

- Microsoft ONNX Runtime GPU Windows：1.24.3。
- NVIDIA CUDA runtime：12.8.1；仅选择 worker/ORT 与 cuDNN 实际依赖的 DLL。
- NVIDIA cuDNN：9.19.1 for CUDA 12。
- 运行时共 21 个制品，安装后 2,124,750,595 字节（约 1.98 GiB）。
- 默认 offline/online profile 均不捆绑上述可选组件。

`resources/runtime-manifest.json` 同时固定官方 HTTPS 归档的长度与 SHA-256，以及每个允许提取的
ZIP 条目、目标长度与 SHA-256。安装器只提取清单中的精确条目，先写临时文件并完成校验，再原子发布。
应用启动 CUDA worker 前会校验全部执行文件；缺失或篡改时返回
`cuda-runtime-integrity-failed` 并沿现有 CUDA → DirectML → CPU 链路回退。

## 使用

在线安装（命令中的开关表示操作者已阅读并接受 NVIDIA CUDA/cuDNN 许可证）：

```powershell
npm.cmd run cuda-runtime:install -- `
  --target-dir="$env:APPDATA\floating-clock-electron" `
  --cache-dir="$env:LOCALAPPDATA\floating-clock-electron\runtime-cache" `
  --accept-nvidia-license `
  --worker-path="artifacts\cuda-worker\floating_clock_cuda_embedding_worker.exe"
```

离线安装使用同一命令并增加 `--offline`；缓存必须已含清单哈希对应的官方归档。只读复验：

```powershell
npm.cmd run cuda-runtime:verify -- `
  --target-dir="$env:APPDATA\floating-clock-electron"
```

若未传 `--accept-nvidia-license`，NVIDIA 组件下载会 fail closed；安装器不替用户或发布方接受协议。

## 实机验收

- 官方归档预填充离线缓存后：21 个制品全部发布，0 个错误。
- 对完整安装目录执行只读复验：21/21 通过。
- RTX 3050、ORT 1.24.3 CUDA provider：DINO 输出 `[1,257,768]`，CLIP image 输出 `[1,512]`。
- 首次完整目录哈希约 6.0 秒；同一进程后续利用 size/mtime 缓存约 10.8 毫秒。
- 将同尺寸 DLL 内容篡改后，路由器拒绝 CUDA，不启动不可信 worker。

这些 smoke 数字用于证明安装和真实推理闭环，不替代稳定态吞吐、P95、显存与长期 soak 门禁。

## 发布阻塞项

工程实现不构成法律意见。发布负责人必须审阅 CUDA/cuDNN EULA、确认 Attachment A 与当前选择的
制品匹配、保存批准记录，并让现有 license gate 通过。批准前不得把
`nvidia-cuda-12-8-embedding-runtime` 或 `nvidia-cudnn-9-19-1-cuda12-runtime` 改为默认捆绑。

## 官方资料

- [CUDA 12.8.1 EULA](https://docs.nvidia.com/cuda/archive/12.8.1/eula/index.html)
- [cuDNN 9.19 EULA](https://docs.nvidia.com/deeplearning/cudnn/backend/v9.19.0/reference/eula.html)
- [ONNX Runtime CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
- [ONNX Runtime GPU Windows 1.24.3](https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime.Gpu.Windows/1.24.3)
