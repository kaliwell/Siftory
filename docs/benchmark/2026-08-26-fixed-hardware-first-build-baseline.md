# 固定硬件首次建库三轮性能基线

> 状态：当前  
> 更新日期：2026-08-26  
> 范围：PxHere 1000 张图片首次建库、DirectML Provider、内存峰值与安全隔离  
> 原始证据：`artifacts/benchmark/fixed-hardware-first-build/baseline-20260826-final-accepted/`

## 当前结论

2026-08-26 的正式 `establish` 已通过，并成为当前唯一接受基线：

- 接受时间：`2026-08-26T14:06:35.619Z`（北京时间 22:06:35）。
- 固定参数：`sample=1000`、`runs=3`、`pipeline=overlap`、`backend=gpu`、`jobs=2`、`batchSize=4`、`requestedScanWorkers=2`、`tensorPrefetch=false`。
- 三轮 DINO 与 CLIP 实际 Provider 均为 `dml`，每轮各收到 2 份会话报告，`fallbackDetected=false`。
- 首次可搜索 Ready P50/P95 为 `265833.94 / 270172.98 ms`，即约 `265.834 / 270.173 s`；三轮极差为 `2.26%`。
- 三轮素材、Native/DINO/CLIP 摘要一致，真实用户数据前后身份一致，结束时无基准子进程残留。
- 本报告建立第一组控制线；后续正式运行默认与它比较，不覆盖接受指针。

## 接受指针与证据身份

| 项目 | 值 |
| --- | --- |
| 接受指针 | `artifacts/benchmark/fixed-hardware-first-build/latest.json` |
| 指针文件 SHA-256 | `3533af7d8310b710c26e5b170cb2f47ae0bf026111b97588388c305e5ccdf137` |
| 接受报告 | `baseline-20260826-final-accepted/report.json` |
| 报告 SHA-256 | `29a34b9300b0aa673bec55632735799ac5bab70eb93768b967723b166673bfe2` |
| 硬件 identity | `344a2c141de3857cf12c5997fac81b89dfd99714549262da10a6dd3c5c7657d5` |
| 数据集 identity | `fb2ffb119ebf21509d96d30a424a9bd69ebcbfaf8307f07c6f1c290312cb9bae` |
| 环境 identity | `d29e47743441d2ea24c153f00b2b8a90856af664a63ba52762d3d2e4cbecb0df` |
| 实现 identity | `ef1c65248a1c70389595e859e564c24bf36c008d444b30a6b5f0b1a6e52f6fb5` |
| 执行依赖闭包 identity | `0c8500521bdc892fc9dd12adee3a0fec89a9749885f2cb385d6aa6e3b7bc5446` |
| 模型集合 identity | `3303ea846a32e90bdace3c0bac66e6bc391ccff952cf69719e0e65060b495ed4` |
| 固定系统工具 identity | `14b1eede8ef42adc9ae33cca1ac2c5f52e141891a5c14d69d5607abb7f8ded36` |
| 源码快照 digest | `c8d3a9ae1300d1b8455d2a8bc3377edafb9e79df114b89dc3e08214db1f08cdd` |

报告记录的 Git HEAD 为 `e51fd1f462266c3ecf59d92f03494c8f67ab74f1`，同时 `dirty=true`。因此本基线绑定的是当时未提交现场的完整实现 identity 与 907 文件源码摘要，不应把该 HEAD 单独解释为基线提交边界。

## 固定硬件、数据集与运行环境

- 系统：Windows 11 Pro，`10.0.22631`，x64。
- CPU：12th Gen Intel(R) Core(TM) i7-12700H，20 个逻辑处理器。
- 内存：`16,781,979,648` bytes，约 `15.629 GiB`。
- NVIDIA GPU：GeForce RTX 3050 Laptop GPU，驱动 `577.00`，显存 `4096 MiB`，UUID `GPU-2fa52731-4c2e-3d70-39d2-4edd8550ee81`。
- 显示控制器证据同时包含 NVIDIA、Intel Iris Xe 与 OrayIddDriver，不只记录 NVIDIA 设备。
- Node.js：`v24.16.0`，modules `137`，N-API `10`。
- 数据集：`D:\PxHereDataset\images\pxhere-000000`，确定性 BFS 选择 1000 张受支持图片，共 `2,627,418,359` bytes（约 `2.447 GiB`）；建库前后 identity 未变化。
- 模型：固定 DINOv2 `dinov2_vitb14` 与 CLIP `clip_vit_base_patch32` 主文件及伴随文件身份；运行时禁止网络取模。
- 每轮使用独占 OS 临时沙箱和最小允许环境，固定 `SystemRoot`、系统工具绝对路径、`ProgramFiles`/`ProgramW6432`，清除继承的 Node、BLAS、ORT、CUDA、Canvas 与应用性能覆盖变量。

## 三轮原始指标

| 轮次 | Ready ms | 总耗时 ms | 主进程峰值 RSS MiB | 子进程聚合峰值 RSS MiB（近似） | 保守合计峰值 RSS MiB | 系统最低空闲 MiB | GPU 已用增量峰值 MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 270172.98 | 370701.36 | 687.50 | 3049.45 | 3736.95 | 1487.37 | 680 |
| 2 | 265833.94 | 367712.78 | 633.81 | 3317.94 | 3951.75 | 1350.56 | 680 |
| 3 | 264165.53 | 365436.45 | 647.05 | 3099.95 | 3747.00 | 1579.24 | 679 |

## 汇总与后续控制线

| 指标 | P50 | P95 | 最小值 | 最大值 | 接受控制线 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ready ms | 265833.94 | 270172.98 | 264165.53 | 270172.98 | P95 `<= 297190.28` |
| 主进程峰值 RSS MiB | 647.05 | 687.50 | 633.81 | 687.50 | P95 `<= 790.63` |
| 子进程聚合峰值 RSS MiB（近似） | 3099.95 | 3317.94 | 3049.45 | 3317.94 | P95 `<= 3815.63` |
| 保守合计峰值 RSS MiB | 3747.00 | 3951.75 | 3736.95 | 3951.75 | P95 `<= 4544.51` |
| 系统最低空闲 MiB | 1487.37 | 1579.24 | 1350.56 | 1579.24 | 最低值 `>= 1012.92` |

Ready 三轮极差控制线为 `<= 15%`。此外，绝对资源预算为主进程 `2048 MiB`、子进程近似聚合 `4801.36 MiB`、保守合计 `5601.59 MiB`，系统最低空闲不得低于 `256 MiB`。

## Provider、摘要与逐轮日志

三轮的 Native、DINO、CLIP 摘要分别固定为：

- Native：`32c316f1654e2c21b0e0d28b419880064f83bd98821b97e84de894595bcdba76`
- DINO：`996958e15245c5f12466af4d99e89538c222e34f63c17d6f74e41e198f3a7d29`
- CLIP：`694ab1faa33184dedd54a1bfd520fab5d3b3cc177db1822c8a13dfcc6385a7ef`

| 轮次 | DINO / CLIP | Round JSON SHA-256 | Timeline SHA-256 | 时间线事件 |
| ---: | --- | --- | --- | ---: |
| 1 | `dml / dml`，无回退 | `1d2323c0c3386a1bd0b6f0204afb0d6641d2256943ad66906461d23627b8f2f0` | `20e0b4ae3ea1998d54dea8b5f7de00f583c43e7c67fac236ff5c379bc40cb57d` | 658 |
| 2 | `dml / dml`，无回退 | `4f21b8f93b1029a463fcfcd3d329fa0b7f25fba14c85090175f563f698026e98` | `bb3a5f5c7f85953b581593467ba31aeebfface71ad036e83acb9789fb2f2f2e2` | 652 |
| 3 | `dml / dml`，无回退 | `2406c5ef6b4404a9757eb93c96f7e5cd2466dceb5fcb1ce59916cc5e29f251d0` | `14eafed102f33ccbafeee9b1a9af70b6d267c81ce2da0aad97d75be07985669a` | 639 |

三条时间线均未截断，终止事件均为 `benchmark-end`、`stage=complete`、`ok=true`。原始文件位于：

- 汇总：`report.json`、`report.md`。
- 固定环境与实现证据：`evidence-before.json`、`evidence-after.json`。
- 每轮：`round-N.json`、`round-N.stdout.log`、`round-N.stderr.log`、`round-N.timeline.ndjson`。
- 用户数据只读证明：`user-data-before.json`、`user-data-after.json`。

三轮 stderr 均为 0 bytes；stdout 分别为 7026、7035、7036 bytes。用户数据前后 identity 均为 `42c38aecf048ba70842979b80353ef0cde031f303519233c314f914eda2b4a98`，变化根目录数为 0。

## 后续比较入口

先只读检查正式计划：

```powershell
npm.cmd run automation:performance-baseline -- --plan
```

后续正式比较必须使用新的空输出目录；未指定 `--establish` 或 `--diagnostic` 时默认为与不可变接受指针比较：

```powershell
npm.cmd run automation:performance-baseline -- --output-dir=artifacts/benchmark/fixed-hardware-first-build/compare-<timestamp>
```

不要通过删除或手工改写 `latest.json` 来重建控制线。需要接受新的三轮控制线时，先只读检查显式 promotion 计划：

```powershell
npm.cmd run benchmark:first-build-memory:promote -- --plan --dataset=D:\PxHereDataset\images\pxhere-000000
```

去掉 `--plan` 后，runner 会重新执行完整三轮比较，并在每一轮前执行独立的 10 分钟正式环境预检；三份预检快照及其 accepted GPU 基线证明会写入候选报告。只有硬件、数据集、配置、实现证据、Provider、摘要、素材与真实 userData 只读证明全部有效，且候选仍通过旧控制线时才进入 promotion。新的时间/内存上限不得大于旧上限，最低空闲内存下限不得小于旧下限。接受指针会通过同目录临时文件原子替换并写入 `sequence/previous`，候选报告也绑定上一报告的路径、SHA-256 和接受时间；任何竞态、链断裂、预检缺失或人工篡改都会失败关闭，旧报告不删除。

## 安全与解释边界

- 只有 3 次连续观测；当前统计方法下 P95 等于三次中的最大值，不具备大样本分位数的统计强度。
- 子进程 RSS 是直接子进程采样近似值；合计峰值使用主进程峰值与子进程近似聚合峰值保守相加，不代表同一瞬间的精确整树 RSS。
- NVIDIA GPU 指标是设备全局指标，未按本基准进程归因；同机其他 GPU 负载会影响结果。
- Ready 表示后端素材库已经可搜索，不表示 Electron 渲染器首屏绘制完成。
- 每轮隔离用户目录、缓存与临时目录，但三轮连续执行，未在每轮之间重启 Windows，因此不等同于重启后的机器级冷启动。
- 基准使用短 OS 临时沙箱规避 Native/SQLite 路径长度风险；Windows 长产品安装路径仍是残余风险，不能由本基准证明已消除。
- Native 图片模糊测试是确定性、有界语料测试，不是 ASan、UBSan、LibFuzzer 或持续随机 fuzz；它不能替代带 Sanitizer 的长期原生安全测试。
- 首次接受指针仍采用排他创建；后续显式 promotion 使用同目录完整临时文件、`fsync` 和原子重命名。中断发生在重命名前时旧指针保持有效，临时文件不会被解析；重命名后新指针必须同时通过报告摘要和上一报告链校验。
- 原始 `artifacts/` 默认不入 Git。长期结论以本文档为入口，复核数值时必须同时核对接受指针、报告 SHA 与对应原始文件。
