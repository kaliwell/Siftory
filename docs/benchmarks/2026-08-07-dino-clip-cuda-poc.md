# DINO / CLIP CUDA provider PoC

> 日期：2026-08-07<br>
> 范围：隔离技术验证，不包含 CUDA runtime 再分发、安装器或真实用户向量写入<br>
> 结论：DINO、CLIP image、CLIP text 的 q4 图均通过当前兼容性、确定性和最低性能门禁

## 环境

- Windows x64，NVIDIA GeForce RTX 3050 Laptop GPU，4 GiB 专用显存
- 驱动 577.00；`nvidia-smi` 报告驱动侧 CUDA 12.9 能力
- ONNX Runtime GPU 1.24.3，CUDA 12.8，cuDNN 9，TF32 关闭
- DirectML 与 CUDA 使用同一模型、同一批预处理张量，batch=4，5 次稳态测量
- Python CUDA 环境、输入张量、原始输出和 profile 均位于隔离临时目录，不进入产品依赖或发布包

## 结果

| 模型                  | DirectML P50 |  CUDA P50 | 加速比 |    最低 cosine | 最大绝对误差 | CUDA/CPU 节点 | 关键 CPU fallback |
| --------------------- | -----------: | --------: | -----: | -------------: | -----------: | ------------: | ----------------- |
| DINOv2 ViT-B/14 image |   140.906 ms | 74.313 ms | 1.896× | 0.999999999998 |      2.37e-7 |       356 / 7 | 0                 |
| CLIP ViT-B/32 image   |    97.705 ms | 43.155 ms | 2.264× | 0.999999999999 |      3.55e-7 |     917 / 202 | 0                 |
| CLIP ViT-B/32 text    |    38.389 ms | 16.890 ms | 2.273× | 1.000000000000 |      1.28e-7 |     482 / 193 | 0                 |

三项的 Top-3 邻居重叠率均为 1.0。CPU 节点限于形状、索引、切片和条件选择类操作；
Conv、MatMul/MatMulNBits、FusedMatMul、LayerNormalization、Softmax 等性能关键操作均未回退 CPU。

## 产品链路验证

- C++ worker 使用 ONNX Runtime C++ API 与 CUDA EP，通过版本化、有界二进制协议接收 float32/int64 张量。
- DINO 和 CLIP 原生 worker 均复现 Python CUDA 原始输出，最大绝对误差不超过 `1e-6`。
- 应用实际 Sharp/Transformers.js 图像预处理 → CUDA worker → DINO 池化/CLIP 归一化链路已运行；
  结果分别为 768/512 维，单位范数为 1.0。
- 每模型路由仅在固定模型 SHA-256、ORT 版本、provider gate、性能和一致性全部通过时选择 CUDA；
  否则继续使用 DirectML，DirectML 初始化失败再使用 CPU。
- CUDA 模式限制为单 worker，worker 或单次推理失败后在当前子进程中熔断 CUDA，防止反复崩溃或重复占用显存。

## 可重复命令

```powershell
npm.cmd run benchmark:embedding-provider-poc -- --help
npm.cmd run build:cuda-worker -- --ort-root <ORT_NUGET_ROOT> --build-dir <TEMP_BUILD_DIR> --output-dir <PRIVATE_RUNTIME_DIR>
npm.cmd run generate:cuda-provider-gates -- --ort-version 1.24.3 --output <PRIVATE_RUNTIME_DIR>/provider-gates.json --report <DINO_REPORT> --report <CLIP_IMAGE_REPORT>
npm.cmd run test:vector-pipeline
```

PoC runner 要求调用者显式提供模型、隔离 Python、输出目录与 provider 参数；它会先校验固定模型哈希，
再生成确定性输入、运行 DirectML/CUDA、分析 ORT profile，并调用 provider parity 门禁。

## 尚未覆盖

- 本轮 5 次稳态测量用于技术选型，不替代发布前 30 次 P50/P95、30 分钟 soak、显存峰值与三轮冷启动验收。
- 确定性张量证明 provider 差异；尚未使用 64 张许可明确的非用户图片语料跑完整 Recall@K。
- CUDA/cuDNN/ORT DLL 尚未进入产品包。再分发条款、NOTICE、下载 manifest、online/offline 安装器和卸载回退
  属于需要人工许可审查的 `VAL-011`，本项没有越权打包。
