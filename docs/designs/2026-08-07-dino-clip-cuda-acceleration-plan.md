# DINO / CLIP NVIDIA CUDA 加速方案

> 状态：P0–P3 已实施，P4–P5 待发布授权与验收<br>
> 更新日期：2026-08-07<br>
> 范围：Windows x64 的 DINOv2 / CLIP embedding 推理、可选 CUDA runtime 与安全回退<br>
> 当前完成：架构决策、三模型 CUDA PoC、native worker、每模型路由、DirectML/CPU 回退<br>
> 未完成：可选 runtime 打包、许可证审查、发布级长稳与真实许可语料验收

## 1. 结论

采用“**可选 NVIDIA CUDA worker + 现有 DirectML/CPU 保底**”路线，不直接修改
Transformers.js 的 Windows `device` 字符串，也不替换当前稳定链路。

生产目标架构是一个只负责 ONNX 推理的独立 C++ worker：Node 子进程继续负责图片解码、
Transformers.js 预处理、DINO 池化和向量归一化；CUDA worker 通过有界二进制协议接收张量，
使用 ONNX Runtime CUDA Execution Provider 推理。这样可以隔离 CUDA/cuDNN DLL、Electron ABI、
显存 OOM 和 native 崩溃，同时复用当前已经验证过的预处理语义。

Python `onnxruntime-gpu` 只用于第一阶段模型兼容 PoC，不作为默认生产依赖。TensorRT 不进入首版。

CUDA 自动启用必须同时通过四道门禁：

1. NVIDIA 驱动和私有 runtime 能力探测通过；
2. 固定 q4 模型的 CUDA 算子覆盖和输出一致性通过；
3. 同一批输入相对 DirectML 的稳定吞吐至少提高 1.5 倍；
4. runtime 文件、哈希、许可证和回退路径通过发布校验。

任一门禁失败都继续使用 DirectML；DirectML 不可用时再回退 CPU。界面和诊断必须显示真实
provider，不能把 DirectML、WebGPU 或 CPU 统称为 CUDA。

## 2. 当前事实与约束

### 2.1 代码和依赖

- `electron/dinoEmbeddingChild.ts` 与 `electron/clipEmbeddingChild.ts` 的外部后端仍是
  `cpu | gpu`；Windows 的 `gpu` 映射为 `dml`。
- 当前依赖是 `@huggingface/transformers` 4.2.0 和传递依赖 `onnxruntime-node` 1.24.3。
- 当前 Transformers.js 包在 Node/Windows 的设备白名单中只有 `dml`、`webgpu`、`cpu`；
  `cuda` 只对 Linux x64 开放。
- ONNX Runtime 官方的预编译 Node binding 矩阵也不提供 Windows CUDA；不支持的平台需要自定义
  Node binding。参考 [ONNX Runtime Node.js binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)。
- 官方构建系统支持 `--build_nodejs`，Windows host 也支持 GPU build；这说明自编 Node binding
  技术上可行，但会把 Electron/Node ABI、Transformers.js 平台补丁和 CUDA 依赖全部耦合到主应用。
  参考 [Build for inferencing](https://onnxruntime.ai/docs/build/inferencing.html)。

因此，“把 `dml` 改成 `cuda`”不是可行实现：当前包会先拒绝设备，现有 Windows native binding
也没有 CUDA provider。

### 2.2 模型和本机证据

`resources/runtime-manifest.json` 已固定以下模型：

| 模型                | 生产文件                            | SHA-256                                                            | 维度 | CUDA 状态 |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------ | ---: | --------- |
| DINOv2 ViT-B/14     | `model_q4.onnx`，56,428,185 B       | `19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018` |  768 | 未验证    |
| CLIP ViT-B/32 image | `model_q4.onnx`，189,403,477 B      | `1f518bedb1851294737a141e06149883cb289160760224f2da5498886e49d5cb` |  512 | 未验证    |
| CLIP ViT-B/32 text  | `text_model_q4.onnx`，125,742,108 B | `e4ccd15d806b8af841a036884b42034535d58e04c52df00f56e73f72d3c166d5` |  512 | 未验证    |

2026-08-07 本机只读探测结果：

- NVIDIA GeForce RTX 3050 Laptop GPU，4 GiB 显存；
- 驱动 577.00，`nvidia-smi` 报告 CUDA 12.9 驱动能力；
- `nvcc` 不在 PATH；这不影响已打包 runtime 的运行，但表示本机没有可直接使用的 CUDA Toolkit
  构建入口；
- DINO 和 CLIP image q4 文件存在；
- 当前 Windows ORT 包含 DirectML DLL，不包含 CUDA provider。

`nvidia-smi` 的 CUDA 版本只代表驱动兼容上限，不等于 CUDA Toolkit、cuDNN 或应用 runtime
已经安装。当前不能声称“CUDA 已可用”。

### 2.3 已有性能基线

`docs/current/2026-07-31-embedding-gpu-throughput-incident.md` 记录的 DirectML batch=4
真实结果是：DINO 1,983 ms、CLIP 1,978 ms；修复灰度 Alpha 输入后，另一组 DINO 输入为
1,023 ms。由于输入不同，CUDA PoC 必须重新用同一固定语料同时跑 DirectML 和 CUDA，不能直接
拿这些数字宣布加速比例。

## 3. 方案选择

| 路线                                                  | 优点                                      | 主要问题                                            | 决策           |
| ----------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- | -------------- |
| 修改 Transformers.js + 自编 Windows CUDA Node binding | 业务改动看似最少                          | Electron ABI、上游平台补丁、CUDA DLL 与主进程强耦合 | 不作为首选     |
| Python `onnxruntime-gpu` sidecar                      | PoC 快，官方 Windows GPU wheel 可用       | Python 环境、启动和分发体积不适合作为默认产品依赖   | 只用于 PoC     |
| C++ ONNX Runtime CUDA worker                          | ABI 稳定、依赖隔离、可做私有 DLL 搜索路径 | 需实现张量协议与独立打包                            | **生产首选**   |
| 继续仅使用 DirectML                                   | 已稳定、覆盖所有 Windows GPU              | 无法利用 CUDA 专用优化                              | 保留为默认回退 |
| TensorRT                                              | 后续可能更快                              | 引擎缓存、模型兼容、版本矩阵和打包复杂度更高        | 首版非目标     |

CUDA EP 会按算子能力把子图分配给 provider；“session 创建成功”不代表整个 q4 图都在 GPU。
参考 [ONNX Runtime Execution Providers](https://onnxruntime.ai/docs/execution-providers/) 和
[CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)。
PoC 必须检查 profiling 中的 provider 分配，避免大量 CPU fallback 造成“看似 CUDA、实际更慢”。

## 4. 目标架构与数据流

```text
embeddingService
  -> DINO/CLIP Node child（现有任务、重试、图片读取）
       -> Sharp / Transformers.js processor（保持现有预处理）
       -> provider router
            -> CUDA worker（NVIDIA + 门禁通过）
            -> DirectML（现有 Windows GPU 路径）
            -> CPU（最终回退）
       -> DINO pooling / CLIP normalization（保持现有语义）
  -> 现有 vector-db 写入和进度统计
```

### 4.1 Provider 路由

对外第一阶段仍兼容 `auto | cpu | gpu`，内部引入：

```ts
type EmbeddingProvider = 'cuda' | 'directml' | 'cpu'

interface EmbeddingProviderStatus {
  requested: 'auto' | 'gpu' | 'cpu'
  active: EmbeddingProvider
  deviceId?: number
  deviceName?: string
  runtimeVersion?: string
  cudaVersion?: string
  cudnnVersion?: string
  reasonCode?: string
  fallbackFrom?: EmbeddingProvider
  checkedAt: number
}
```

自动选择顺序：

1. `cuda` capability probe 和模型门禁均通过时选择 CUDA；
2. 否则选择现有 DirectML；
3. DirectML 初始化失败时选择 CPU。

CUDA 失败原因使用稳定 reason code，例如 `runtime-missing`、`provider-init-failed`、
`model-coverage-failed`、`parity-gate-failed`、`benchmark-gate-failed`、`oom`。UI 显示简明原因，
诊断日志保留完整版本和 provider 信息。

### 4.2 Worker 生命周期

- 初版每块 GPU 只允许一个 CUDA 推理任务并发，模型按需加载；不要照搬 DirectML 的 2 worker
  上限。
- RTX 3050 4 GiB 上不常驻多个 DINO/CLIP 模型副本；空闲模型可按内存压力卸载。
- batch 依次实测 1、2、4、8、16，再选择每模型默认值；OOM 时批量减半重试一次，仍失败则
  本次任务回退 DirectML。
- worker 崩溃最多重启一次；连续失败后熔断 CUDA，避免长任务反复崩溃。
- 暂停、取消和退出复用现有 embedding service 的 drain/kill 语义。

## 5. 张量与 IPC 契约

CUDA worker 不接收任意文件路径，只接收已验证、已预处理的张量和允许列表中的模型 ID。

启动握手至少返回：

```json
{
  "protocolVersion": 1,
  "provider": "cuda",
  "deviceId": 0,
  "deviceName": "NVIDIA ...",
  "ortVersion": "pinned",
  "cudaVersion": "pinned",
  "cudnnVersion": "pinned",
  "supportedModels": ["dinov2_vitb14", "clip_vit_base_patch32"]
}
```

推理消息使用长度前缀二进制 frame，header 包含 magic、协议版本、request id、model id、dtype、
rank、dimensions 和 payload bytes。禁止把大张量序列化成 JSON number 数组。所有长度、维度、
batch 和 payload 都必须在分配内存前校验；未知 model id、输出维度或协议版本直接拒绝。

DINO 的 CLS 排除与 batch offset 池化继续调用 `electron/dinoEmbeddingMath.ts`；CLIP 向量继续由
Node 侧归一化。这样 provider 变化不会悄悄改变现有 embedding 定义，也不需要重建历史向量。

## 6. 模型兼容 PoC

PoC 使用隔离目录和固定依赖，不接产品 UI，不写真实用户向量：

1. 固定 ONNX Runtime 1.24.x、CUDA 12.8、cuDNN 9.x 组合；官方兼容矩阵说明同一 CUDA major
   内有 minor compatibility，但 cuDNN major 必须匹配。
2. 校验三个模型文件的 manifest 哈希后再创建 session。
3. provider 顺序使用 `CUDAExecutionProvider, CPUExecutionProvider`，开启 ORT profiling 和详细
   provider 日志。
4. 分别记录 session 初始化、每个节点的 provider、首次 warmup、稳态推理和显存。
5. q4 模型若存在关键算子 CPU fallback 或吞吐无收益，再用相同上游 revision 导出的 FP16 图
   对照；不能未经召回验证直接替换生产模型。
6. DINO、CLIP image、CLIP text 分别出报告；一项通过不能代表另外两项通过。

CUDA EP 支持 `device_id`、`gpu_mem_limit`、stream、TF32 和 cuDNN workspace 等选项。第一轮
一致性测试关闭 TF32，性能轮再单独开启并重跑质量门禁；不在首版启用 CUDA Graph。

## 7. 确定性一致性与召回门禁

本阶段新增：

```powershell
npm.cmd run verify:embedding-provider-parity -- `
  --reference artifacts/directml-dino.json `
  --candidate artifacts/cuda-dino.json
```

快照 schema：

```json
{
  "schemaVersion": 1,
  "model": "dinov2_vitb14",
  "provider": "cuda",
  "dimension": 768,
  "samples": [{ "id": "fixture-001", "vector": [0.0] }]
}
```

校验器拒绝样本集、维度、非有限值和归一化异常，并计算逐向量 cosine、最大绝对误差与固定
Top-K 邻居重叠率。默认门禁是：

- 每个向量 cosine 最低 `0.999`；
- 全体分量最大绝对误差 `0.01`；
- 候选向量最大单位范数误差 `0.01`；
- 平均 Top-10 重叠率至少 `0.99`。

PoC 固定夹具至少包含 64 张非用户图片，覆盖 RGB、灰度、Alpha、EXIF 旋转、JPEG、PNG、WebP、
不同长宽比和同类近邻。预处理张量应保存哈希，确保比较的是 provider 差异而非解码差异。
最终还要在独立标注集跑现有 Recall@K 门禁；以上数值门禁不能替代业务召回。

## 8. 性能验收

对每个模型、每种 provider、每个 batch 做 5 次 warmup 和至少 30 个稳态批次，记录：

- 模型加载时间；
- images/s、单批 P50/P95；
- GPU 专用/共享显存峰值、进程 RSS；
- CPU 使用率和 CPU fallback 节点；
- 首次调用和稳定调用分开统计；
- 崩溃、OOM、重试和回退次数。

CUDA 自动启用的最低条件：

1. 同夹具稳态吞吐相对 DirectML 至少 `1.5x`；
2. P95 不劣于 DirectML；
3. 4 GiB 设备峰值专用显存不超过约 3.2 GiB，并能与桌面合成共存；
4. 所有性能关键 CPU fallback 节点均为 0；非关键 fallback 必须在报告中逐项解释；
5. 三轮冷启动和 30 分钟持续运行无崩溃、无持续显存增长。

若只有 DINO 或 CLIP 中某一个模型达标，按模型启用 CUDA，不要求“一刀切”。

## 9. 打包、安全与许可证

- CUDA worker、ORT CUDA provider、CUDA/cuDNN runtime 必须进入独立可选组件；默认 offline 包不
  因此膨胀。
- online profile 只在探测到 NVIDIA GPU 后提示下载；下载仍使用现有 runtime manifest 的
  source URL、size、SHA-256、原子安装和损坏回滚机制。
- DLL 从应用私有绝对目录加载，不依赖当前目录或任意系统 PATH，降低 DLL 劫持风险。
- worker 禁网、只接受允许列表 model id 和有界张量，不接受用户提供的可执行路径。
- ONNX Runtime 与 NVIDIA runtime 的许可证、NOTICE、再分发条款必须经现有 license gate 和人工
  审查后才能进入发布包；方案文档不替用户作许可证决定。
- runtime 版本与 app 版本解耦但必须被 manifest 固定；更新 CUDA/cuDNN 时重新跑完整模型、质量、
  性能和安装器验收。

## 10. 实施阶段

| 阶段             | 交付物                                                   | 状态   | 退出条件                                              |
| ---------------- | -------------------------------------------------------- | ------ | ----------------------------------------------------- |
| P0 方案与门禁    | 本文、provider parity 校验器与测试                       | 已实施 | 专项测试和文档审查通过                                |
| P1 模型 PoC      | 隔离 CUDA runner、三模型 provider profile、DML/CUDA 报告 | 已实施 | 三模型兼容、确定性和 1.5× 性能门禁通过                |
| P2 Native worker | C++ worker、二进制 IPC、能力探测、崩溃/OOM 回退          | 已实施 | 双模型原生输出复现与失败回退通过；发布级 soak 留待 P5 |
| P3 产品接线      | provider router、每模型路由、状态/诊断                   | 已实施 | 固定哈希/gate 选择，CUDA→DirectML→CPU 回退通过        |
| P4 可选打包      | runtime manifest、在线下载、哈希、许可证、安装器         | 技术完成；发布阻塞 | online/offline 两 profile 已验收；等待 NVIDIA 再分发批准 |
| P5 灰度启用      | opt-in -> auto，保留熔断与回退                           | 未实施 | 真实非用户夹具与维护窗口验证                          |

P1–P3 由 `VAL-010` 自动继续。P4 的技术实现由 `VAL-011` 完成，但 NVIDIA runtime
仍保持 `defaultBundled=false`，显式接受许可证后才允许下载；未经项目/法律审批不得进入发布包。

## 11. 非目标和禁止捷径

- 不把 ANN 搜索或向量点积迁移到 CUDA；当前瓶颈目标是 DINO/CLIP 模型推理。
- 不删除 DirectML 或 CPU 回退。
- 不因 CUDA provider 能创建 session 就宣布成功。
- 不默认要求用户安装 Python、CUDA Toolkit 或全局 cuDNN。
- 不在一致性门禁前重建或覆盖现有用户 embedding。
- 不在首版引入 TensorRT、CUDA Graph 或多 GPU 调度。

## 12. 验证

| 项目                         | 命令                                                                    | 当前结果                     |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| Provider 一致性校验器        | `node --test tests/embedding-provider-parity.test.cjs`                  | 4/4 通过                     |
| 向量管线                     | `npm.cmd run test:vector-pipeline`                                      | 107/107 通过                 |
| TODO 与专项测试              | `npm.cmd run todo:value-check`、`npm.cmd run test:optimization-todo`    | 11 项有效，8/8 通过          |
| 静态检查                     | `npm.cmd run lint`、`npm.cmd run typecheck`、`npm.cmd run format:check` | 通过                         |
| DINO CUDA q4 实推            | `npm.cmd run benchmark:embedding-provider-poc`                          | 1.896×，parity 通过          |
| CLIP image/text CUDA q4 实推 | `npm.cmd run benchmark:embedding-provider-poc`                          | 2.264× / 2.273×，parity 通过 |
| Native worker 双模型协议     | 条件化 `tests/cuda-embedding-worker.test.cjs`                           | DINO/CLIP 输出误差 ≤ 1e-6    |
| 应用图像预处理链路           | 编译后 DINO/CLIP child smoke                                            | 768/512 维单位向量通过       |
| CUDA 打包与许可证            | `npm.cmd run test:runtime-manifest`、真实 offline 安装/双模型 smoke       | 技术验收通过；再分发审批阻塞 |

## 13. 资料

- [ONNX Runtime Node.js binding 支持矩阵](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [ONNX Runtime inference build 与 Node binding](https://onnxruntime.ai/docs/build/inferencing.html)
- [ONNX Runtime CUDA Execution Provider 与版本兼容](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
- [ONNX Runtime Execution Provider 分图机制](https://onnxruntime.ai/docs/execution-providers/)
- [ONNX Runtime 安装与语言绑定](https://onnxruntime.ai/docs/install/)
