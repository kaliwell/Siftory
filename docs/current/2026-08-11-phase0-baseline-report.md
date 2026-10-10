# Phase 0 基线报告：冻结边界与真实基准（2026-08-11）

> 状态：当前
> 实施状态：基准已复验，见第 7 节
> 更新日期：2026-08-13
> 分支：`feat/phase0-discovery-baseline`
> 原始报告：`benchmarks/phase0-baseline-2026-08-11.json`（10 万档，全指标）、`benchmarks/phase0-baseline-1m-2026-08-11.json`（100 万档，见降级说明）
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md` 第 14 节 Phase 0

## 1. 环境

| 项           | 值                                                                                 |
| ------------ | ---------------------------------------------------------------------------------- |
| CPU          | 12th Gen Intel Core i7-12700H（14 逻辑处理器）                                     |
| 内存         | 32 GB                                                                              |
| 固定磁盘     | NVMe Samsung SSD 980 500GB（SSD，Healthy）；NVMe Micron 2450 512GB（SSD，Healthy） |
| 文件系统     | NTFS（C:、D:）                                                                     |
| Node         | v24.16.0                                                                           |
| Native addon | `native/build/Release/fast_scanner.node`（已存在，未重编）                         |

HDD / 移动盘 / 挂载 NAS：本机**不可用**（无此类设备接入），本次基准仅覆盖 NTFS NVMe SSD，与任务约束一致。

## 2. 语料

- **合成语料（10 万档）**：`scripts/create-synthetic-corpus.cjs` 生成到 `%TEMP%/phase0-corpus-100k`（仓库外，绝不会被 git 跟踪）。100 000 个有效 1x1 PNG（8 个颜色变体），每目录 500 文件、200 目录、两层分组。生成耗时见报告 `corpus.elapsedMs`。
- **合成语料（100 万档）**：`%TEMP%/phase0-corpus-1000k`，同一结构 ×10。
- **脱敏真实素材集**：`tests/fixtures/faces/`（3 张公开人脸 JPEG，仓库内已跟踪的测试夹具）。因缩略图管线仅接受 JPEG 源（`native/thumbnail_sidecar.h` `try_enqueue` → `is_jpeg_path`），缩略图与 embedding 基准使用由该夹具派生的 500 张 JPEG 子集（追加计数器字节去重，生成在 `%TEMP%/phase0-jpeg-subset`）。

## 3. 可复现命令

```bash
# 完整 Phase 0 基线（10 万档，含 embedding；约 3-4 分钟）
npm run benchmark:phase0

# 100 万档（约 8-10 分钟；--skip-embedding 因为 embedding 基准与语料规模无关）
node scripts/run-phase0-baseline.cjs --count=1000000 --fresh --skip-embedding \
  --output=benchmarks/phase0-baseline-1m-<date>.json

# 仅生成语料
node scripts/create-synthetic-corpus.cjs --count=100000 [--root=<dir>] [--clean]
```

runner 默认在成功或失败退出时删除其位于 `%TEMP%` 的标准合成语料，防止百万小文件被正式图搜的
宽范围扫描误收录；仅在需要重复复验时显式传入 `--keep-corpus`。传入自定义 `--corpus-root` 时，
runner 永不自动删除调用者目录。遗留的标准 Phase 0 临时目录可先预览再显式清理：

```powershell
npm.cmd run cleanup:phase0-temp
npm.cmd run cleanup:phase0-temp -- --execute
```

2026-08-13 的百万档临时语料误入正式图搜范围事件、派生数据清理结果和复发边界，见
[Phase 0 临时目录与 Windows NLA 10108 事件记录](2026-08-13-phase0-temp-and-windows-nla-incident.md)。

编排方式：`scripts/run-phase0-baseline.cjs` 直接驱动 native addon（scanDirectory / hashImage / saveIndexToManifest）并复用现有基准 `tests/native-benchmark.cjs`（搜索延迟）与 `tests/image-search-simple-embedding-benchmark.cjs`（embedding），不新造基准轮子。

## 4. 指标结果（真实测量，源自 JSON 报告）

### 4.1 发现（10 万文件，NTFS NVMe SSD）

| 指标                                    | 值                                                                   |
| --------------------------------------- | -------------------------------------------------------------------- |
| 首次路径/大小出现延迟                   | **13.3 ms**                                                          |
| 纯枚举发现（metaOnly，强制 Win32 enum） | **433.9 ms / 100 000 文件 ≈ 230 000 文件/s**                         |
| 全量发现（full = 枚举 + decode + hash） | **12 102.6 ms**（backend=enum，fallbackCode=`volume-access-denied`） |
| 其中 decode 累计                        | 312 ms                                                               |
| 其中 hash 累计                          | 4 555 ms                                                             |

### 4.2 USN/MFT 与 Win32 回退对比

- 本机以非管理员运行，`checkUsnAvailability`：NTFS=true，**canOpenVolume=false，requiresAdmin=true**（`cannot open volume C: (access denied)`）。
- 因此 full 扫描自动回退到 Win32 目录枚举（`fallbackCode=volume-access-denied`），本次**未取得 USN 数据**，对比项记录为：USN 不可用（需管理员提权），Win32 枚举基线如上。
- 注意 full 模式的 `enumMs`（约 12 s）高于 metaOnly 的 434 ms：枚举循环向有界管线提交任务时受下游 decode/hash 背压阻塞，属预期耦合，不代表纯枚举速度。
- 后续如需 USN 对比数据，需以管理员身份重跑 `npm run benchmark:phase0`。

### 4.3 缩略图（500 张真实 JPEG 子集）

| 指标               | 值          |
| ------------------ | ----------- |
| 完成 / 失败 / 丢弃 | 500 / 0 / 0 |
| 含扫描总耗时       | 2 715.9 ms  |
| 平均每张           | **5.43 ms** |

### 4.4 Hash

- 全量扫描内累计 hash 4 555 ms / 100 000 张（1x1 PNG，多 worker 并行）。
- 微基准（`hashImage`，20 轮/张，真实 JPEG）：obama-variant 13.0 ms、obama 16.8 ms、trump 16.4 ms。

### 4.5 Embedding（小样本，磁盘已有模型，未下载新模型）

- `tests/image-search-simple-embedding-benchmark.cjs`，dino、CPU backend、batch=4、jobs=2、16 张：
  **17 428.8 ms，0.92 张/s**，worker 峰值内存约 344 MiB。
- digest `e27984965505d345…`（两次运行一致，结果可复现）。

### 4.6 搜索延迟（10 万索引，`tests/native-benchmark.cjs`，100 轮）

| 指标                                   | 值                                 |
| -------------------------------------- | ---------------------------------- |
| manifest 加载                          | 5.47 ms（RSS 增量 2.2 MiB）        |
| sampled-index fast / balanced / recall | 0.201 / 0.191 / 0.191 ms 每查询    |
| zero-skew fast / balanced / recall     | 0.0075 / 0.0023 / 0.0024 ms 每查询 |

### 4.7 100 万档（原始报告 `benchmarks/phase0-baseline-1m-2026-08-11.json`）

| 指标                                        | 值                                          |
| ------------------------------------------- | ------------------------------------------- |
| 语料生成                                    | 1 000 000 文件 / 550.2 s                    |
| 首次路径出现延迟                            | 30.1 ms                                     |
| 纯枚举发现（metaOnly/enum）                 | 12 919.6 ms ≈ 77 400 文件/s                 |
| 全量发现（full，enum 回退）                 | 197 456 ms（约 3.3 分钟，在 10 分钟限额内） |
| 其中 decode / hash 累计                     | 3 090 ms / 43 620 ms                        |
| 缩略图                                      | 500/500 完成，平均 5.19 ms/张               |
| 搜索（sampled-index，fast/balanced/recall） | 0.179 / 0.168 / 0.180 ms 每查询             |
| manifest 加载                               | 4.2 ms（segment mmap，RSS 增量 2.2 MiB）    |

100 万档以 `--skip-embedding` 运行：embedding 基准为固定 16 张小样本，与语料规模无关，其结果以 10 万档报告为准。

## 5. 降级与限制说明

- **USN/MFT 档降级**：非管理员无法打开卷句柄，本次只记录 Win32 枚举基线 + 回退原因码；USN 对比需提权重跑。
- **HDD/移动盘/NAS 档降级**：本机无相应设备，记录为不可用。
- **embedding 基准规模**：按任务约束只跑 16 张小样本（dino/CPU）；CLIP 与 GPU backend 未纳入本次基线；100 万档以 `--skip-embedding` 复用该小样本结论。
- **缩略图语料**：合成 PNG 不进入缩略图管线（仅 JPEG），故缩略图/embedding 使用脱敏真实 JPEG 子集；这是有意设计而非缺陷。
- 所有报告内路径已脱敏（`C:\Users\<user>`），满足 privacy hook 要求。

## 6. 交付物索引

> 位置说明：任务原建议 `artifacts/benchmarks/`，但仓库 git-preflight 明确禁止跟踪 `artifacts/` 下任何文件，故原始报告入库到 `benchmarks/`（runner 默认输出路径已同步调整）。

- `scripts/create-synthetic-corpus.cjs` — 合成语料生成器（参数化 10 万/100 万档）
- `scripts/run-phase0-baseline.cjs` + `npm run benchmark:phase0` — 基线编排器
- `benchmarks/phase0-baseline-2026-08-11.json` — 10 万档原始报告
- `benchmarks/phase0-baseline-1m-2026-08-11.json` — 100 万档原始报告
- `docs/reference/2026-08-11-storage-authority-boundaries.md` — 权威边界图

## 7. 复验记录（2026-08-11，父代理）

复验方式：复用 `%TEMP%/phase0-corpus-100k` 语料重跑 `node scripts/run-phase0-baseline.cjs`（10 万档全指标，含 embedding），原始报告已就地更新为复跑值。

复跑关键值（对比首轮）：首次路径出现 71.3 ms（首轮 13.3 ms）；纯枚举发现 1 869.8 ms ≈ 53 500 文件/s（首轮 433.9 ms ≈ 230 000 文件/s，差异来自系统负载波动，量级一致）；全量发现 17 556.4 ms（首轮 12 102.6 ms）；缩略图 500/500、平均 5.43 ms/张（与首轮一致）；manifest 加载 5.52 ms（首轮 5.47 ms）；embedding digest 复现一致。

结论：可复现命令真实可用，指标量级稳定，Phase 0 验收通过。首轮与复跑数字均保留在 git 历史中（首轮见 commit `6469b0b` 的 JSON 版本）。
