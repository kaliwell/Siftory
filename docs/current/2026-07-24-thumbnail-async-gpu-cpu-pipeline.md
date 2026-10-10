# Image Search 缩略图 CPU/GPU 异步流水线

> 状态：当前  
> 更新日期：2026-07-24  
> 范围：Data Editor Manager → Rebuild Optimized Thumbnails  
> Git 边界：仓库已初始化但仍无首个提交；本轮属于未提交现场

## 执行身份

- 执行身份：Codex。
- 模型信息：GPT-5 系列；运行时未提供可可靠确认的精确小版本。
- 本轮没有启动 Codex 子代理，也没有读取或代替 Kimi agents。

## 用户现场与根因

用户现场设置：

```text
GPU preferred
Jobs 18
Batch 18
```

旧运行状态却显示 `Batch 2`，CPU 100%、内存 96%、GPU 约 15%。根因有四项：

1. `MAX_THUMBNAIL_IN_FLIGHT=40` 被换算为 `maxSafeBatchSize`，18 个 worker 时把用户的
   Batch 18 静默改成 2。
2. 每个 worker 用 `Promise.all(batch)`，必须等待同批最慢图片完成后才能领取下一批。
3. GPU failure 或不支持格式的 CPU fallback 与 GPU 任务共用领取循环，形成队头等待。
4. 当前 WebGL 只负责 resize；文件读取、metadata、ImageBitmap 解码、Canvas WebP 编码和
   缓存写入仍消耗 CPU。

此外，UI 的 Jobs 最大值为 20，但 `ThumbnailGpuPool` 实际最多创建 8 个 renderer，旧界面
没有显示这个区别。

## 已完成

### 双队列异步流水线

新链路：

```text
按 Batch 补充路径
       │
       ▼
有界 GPU 路径队列 ── GPU renderer lanes ── 成功立即落盘
       │
       ├─ GPU 不支持
       └─ GPU 失败
               │
               ▼
        有界 CPU fallback 队列 ── CPU lanes ── 完成立即落盘
```

- GPU 和 CPU 队列独立消费，不等待同一批全部结束。
- GPU 失败只把该图片转入 CPU 队列；其他 GPU 图片继续运行。
- CPU fallback 处理时，GPU renderer 继续领取下一张。
- 两个队列容量均为 40，存放的是路径任务；真正解码中的任务数由 lanes 控制。
- 停止后生产者停止补充，消费者快速排空队列，不会因为生产者卡在满队列而死锁。
- 新增通用 `BoundedAsyncQueue<T>`，其他多阶段任务可复用。

### Batch 与 Jobs 语义

- Batch 18 现在保持显示为 18，不再被改写成 2。
- Batch 表示生产者每次向有界队列补充多少路径，不代表 `Jobs × Batch` 张图片同时解码。
- `gpuJobs` 显示用户请求值。
- `gpuLanes` 显示当前实际 renderer 数量。
- `cpuLanes` 显示 CPU fallback worker 数量。
- UI 新增 `in-flight/peak` 和 GPU/CPU queue depth。

全量数据时当前 GPU renderer 安全上限仍是 8。不能仅为了让 Jobs 18 看起来完全展开而创建
18 个隐藏 BrowserWindow；用户现场系统内存只剩约 779 MiB，这会重新引入内存耗尽风险。

### 倒置修复

`UNPACK_FLIP_Y_WEBGL` 对 ImageBitmap 上传的行为不稳定。新实现不再依赖该状态，而是在
vertex shader 中明确转换 Y 坐标，同时保留 `createImageBitmap(...,
imageOrientation: 'from-image')` 的 EXIF 方向处理。

缩略图缓存版本从 v3 提升到 v4，旧 GPU 倒置缓存不会继续命中。

## 真实 Electron 验证

检测到的 GPU：

```text
NVIDIA GeForce RTX 3050 Laptop GPU
ANGLE / Direct3D 11
```

### 64 张 GPU 测试

包含 EXIF Orientation 6/8 图片：

| 指标                 |          结果 |
| -------------------- | ------------: |
| 总数                 |            64 |
| GPU 完成             |            64 |
| CPU 完成             |             0 |
| fallback / failed    |         0 / 0 |
| Jobs / Batch         |       18 / 18 |
| 实际 GPU / CPU lanes |         4 / 2 |
| 耗时                 |      5,081 ms |
| 吞吐                 | 约 12.6 img/s |

64 张只需要 4 个 Batch，因此实际建立 4 条 GPU lane。

### 64 张混合测试

32 张 GPU 支持扩展名和 32 张强制 CPU fallback：

| 指标              |     结果 |
| ----------------- | -------: |
| effective backend |    mixed |
| GPU / CPU 完成    |  32 / 32 |
| fallback / failed |   32 / 0 |
| GPU / CPU lanes   |    4 / 2 |
| peak in-flight    |        6 |
| Batch             |       18 |
| 耗时              | 2,868 ms |

峰值在途为 `4 GPU + 2 CPU = 6`，证明 CPU 和 GPU 阶段同时推进，而不是等待同一 batch。

### 256 张 PxHere JPEG

| 指标                      |               结果 |
| ------------------------- | -----------------: |
| GPU 完成                  |                256 |
| fallback / failed         |              0 / 0 |
| Jobs / Batch              |            18 / 18 |
| GPU / CPU lanes           |              8 / 2 |
| peak in-flight            |                  8 |
| 耗时                      |   13,428–13,595 ms |
| 吞吐                      | 约 18.8–19.1 img/s |
| GPU utilization 平均/峰值 |        27.2% / 62% |
| GPU memory 峰值           |          1,585 MiB |

用户旧现场截图约为 10.1 img/s。新测量使用同一 PxHere 数据源但不是严格同一文件顺序与系统
负载，因此只能作为现场参考，不能写成严格 A/B 倍数。

### EXIF 方向

验证源：

```text
<DATASET>\pxhere-000072\1585887.jpg
原始像素：2448×3264
EXIF Orientation：6
```

GPU 输出 WebP 为 `256×192`，即 EXIF 旋转后的横向尺寸，方向处理生效。

## 验证命令

```text
npm.cmd run typecheck
node --test tests/thumbnail-rebuild-pipeline.test.cjs \
  tests/thumbnail-policy.test.cjs \
  tests/thumbnail-request-scheduler.test.cjs \
  tests/thumbnail-security.test.cjs \
  tests/preload-contract.test.cjs \
  tests/ipc-registration.test.cjs
npm.cmd run build:renderer
node tests/electron-ui-smoke.cjs
```

结果：

- TypeScript 通过。
- 15/15 项缩略图、IPC 和调度专项测试通过。
- Electron UI/GPU smoke 通过，无 console error、无 panel crash。
- GPU-only、mixed 和 EXIF Orientation 实测通过。
- 新流水线测试已加入 `npm test` 的 `test:fm-security` 链。
- `npm.cmd test` 全量测试通过，所有测试组均为 0 failure。
- `npm.cmd run build` 通过，Electron 原生模块与 NSIS 安装器构建完成。

正式安装包：

```text
release\FloatingClock Setup 1.0.0.exe
大小：600,745,805 bytes
SHA-256：94FE6846FD62DA61F16023D3FA3DDF580AB32929A9C36CC244B67E9850768B1A
```

## 仍有的边界

1. 当前不是纯 GPU：浏览器图片解码和 WebP 编码仍会占用 CPU。
2. GPU 平均利用率仍受 CPU 解码、文件读取和 WebP 编码约束；要进一步提高需要 nvJPEG/CUDA
   解码，或更换缩略图输出格式。
3. 当前实际 GPU renderer 上限是 8。提高上限前必须测量 BrowserWindow 的系统内存成本，
   不能只看显存空余。
4. Batch 越大只会增加路径补充粒度；当队列达到 40 时生产者会背压，不会无限占用内存。

## 2026-07-24 第二轮吞吐优化

针对现场出现的 `GPU queue 40 / CPU queue 0 / in-flight 8/10`，继续完成：

- Auto 模式动态分流：GPU 队列积压时，把 GPU 可处理的任务交给空闲 CPU lanes，
  避免静态 2 MiB 阈值造成阶段性闲置。
- Auto CPU lanes 按可用内存调整：可用内存至少 1.5 GiB 时使用 3 lanes，否则保持
  2 lanes，避免低内存机器再次接近 96% 占用。
- 重建缓存改为 2 lanes、容量 32 的异步 write-behind 队列；生成阶段不再执行同步
  `writeFileSync`，队列满时才背压。
- GPU 路径只读取源文件一次，同一 Buffer 同时用于 Sharp 元数据安全检查和 GPU IPC。
- 缓存淘汰的文件 `stat` 并发限制为 64，避免几十万个 Promise 同时创建。
- 面板新增 Cache queue、Auto→CPU、Writes 和 write failure 指标。

同一组 256 张、每张不超过 2 MiB 的 PxHere JPEG，Jobs/Batch 均为 18：

| 模式                 | 吞吐            | GPU/CPU 完成 | 峰值并发 |
| -------------------- | --------------- | ------------ | -------- |
| GPU preferred        | 19.74 img/s     | 256 / 0      | 8        |
| CPU preferred        | 30.55 img/s     | 0 / 256      | 3        |
| Auto，2 CPU lanes    | 30.71 img/s     | 161 / 95     | 10       |
| Auto，自适应 3 lanes | **32.55 img/s** | 136 / 120    | 11       |

最终 Auto 相比同组纯 GPU 快约 65%。256 个缓存写入全部完成，写入失败为 0。

另以 `<DATASET>\pxhere-000000` 的 1,000 张 JPEG 验证：

- GPU 567、CPU 433，其中动态 Auto→CPU 58；
- peak in-flight 10；
- 1,000 次缓存写入全部完成，0 failure；
- Electron UI smoke 无 console error、无 panel crash。

基准数据使用硬链接创建的临时目录，验证结束后已删除；未修改 PxHere 源文件。

第二轮优化完成后再次执行 `npm.cmd test`，所有测试组仍为 0 failure；随后重新编译
Electron 42.4.1 原生模块并成功生成正式 NSIS 安装器，校验值已更新为上方记录。
