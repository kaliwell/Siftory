# 多类型视频语义建库方案

> 状态：草案  
> 更新日期：2026-08-14  
> 范围：Media Search、Unified Search、模型运行时、统一任务调度  
> 关联 TODO：[视频语义建库自动推进 TODO](../current/2026-08-14-video-semantic-index-todo.md)  
> 替代文档：无

## 1. 当前结论

当前项目已经具备视频扫描、代表帧抽取、DINO/CLIP 帧向量、内嵌字幕、字幕 BM25、统一结果聚合和受控定点播放。下一阶段不替换这些能力，而是在现有 D6 `video-deep` 阶段增加可选的视频语义层：

```text
视频发现与元数据
  -> 现有代表帧 / 镜头候选
  -> 视频类型与策略规划
  -> Qwen3-VL 片段视觉语义
  -> SenseVoice 对话 / 语言 / 情绪 / 声音事件（后续可选）
  -> OCR / 内嵌字幕证据
  -> 带时间范围的统一语义片段
  -> FTS / 统一搜索 video-semantic lane
```

本机基准配置为 RTX 3050 Laptop 4 GiB、16 GiB 内存、i7-12700H。第一阶段测试模型固定为 `Qwen3-VL-2B-Instruct Q4_K_M`，并发固定为 1；`4B Q4_K_M` 只作为同样本质量对照，不作为默认建库模型。2026-08-14 已在用户明确批准后安装外部 Ollama 0.32.9、下载并锁定 `qwen3-vl:2b`，项目适配器检查为 `ready`；这只完成运行时身份验收，不代表真实视频基准、质量验收或 Offline 分发已完成。

## 2. 目标与非目标

### 2.1 目标

1. 支持影视/动漫、短视频、会议访谈、课程录屏、游戏直播、监控、体育和普通素材等多种视频。
2. 将视频转换为可搜索的场景、人物描述、行为、事件、物体、画面文字、语言、对话和声音事件。
3. 每条语义证据必须绑定 `videoId`、`AssetId` 和开始/结束时间，能够回到原视频定点播放。
4. 复用现有帧、字幕、任务调度、模型状态、来源权限和统一搜索，不建立平行孤岛。
5. 支持停止、恢复、重试、模型切换、单视频重建和按来源增量建库。
6. 模型缺失、任务失败或深度索引未完成时，继续返回元数据、CLIP/DINO 和字幕结果，并明确显示退化原因。
7. 默认完全本地处理，不上传视频、帧、字幕、对话或人物特征。

### 2.2 非目标

1. 第一阶段不把整部电影或数小时录像一次性交给视觉语言模型。
2. 第一阶段不承诺识别人物真实姓名；默认只生成 `person-1`、`speaker-1` 等匿名身份。
3. 第一阶段不自动建立人脸库，不根据外貌猜测敏感属性。
4. 第一阶段不替换 DINO/CLIP，也不为全部旧视频强制重建。
5. 未完成许可证、哈希和真实设备验收前，不把新模型放入 Offline 安装包。
6. 不依赖云端 API；外部 Ollama 只作为用户显式启用的本机测试适配器。

## 3. 当前能力复用

| 已有能力                              | 复用方式                              | 不重复实现的边界                       |
| ------------------------------------- | ------------------------------------- | -------------------------------------- |
| `electron/videoScanService.ts`        | 继续作为视频清单和元数据权威来源      | 语义层不重新枚举磁盘                   |
| `electron/videoFrameService.ts`       | 复用已生成的 384px/256px 帧及时间戳   | 不复制第二套 FFmpeg 抽帧缓存           |
| `electron/videoFrameSearchService.ts` | 保留 DINO/CLIP 快速召回               | Qwen 不参与全库逐查询推理              |
| `electron/transcriptService.ts`       | 复用内嵌字幕及时间段                  | ASR 文本必须标记不同证据来源           |
| `electron/unifiedTaskScheduler.ts`    | 深度分析进入 GPU `video-deep` 车道    | 不新增无预算的后台队列                 |
| `electron/unifiedSearchRuntime.ts`    | 增加 `video-semantic` lane            | 不改变既有元数据/帧/字幕退化语义       |
| `electron/controlledMediaSeek.ts`     | 使用权威 `videoId + timestampMs` 打开 | Renderer 不提交任意播放器参数          |
| `resources/runtime-manifest.json`     | 记录模型、运行时、许可证、哈希和体积  | 不接受运行时下载未锁定 revision 的文件 |

## 4. 视频类型与策略

用户可以选择 `自动` 或手工覆盖类型。自动分类只根据元数据、镜头变化密度、语音比例、OCR 密度和时长制定处理策略；它不是内容审查分类，也不能改变文件权限。

| 类型               | 主要证据                  | 默认片段与取帧                | 优先输出                                    |
| ------------------ | ------------------------- | ----------------------------- | ------------------------------------------- |
| 普通素材           | 视觉 + 可用字幕           | 15-30 秒，4-8 帧              | 场景、人物描述、物体、动作、事件            |
| 影视/剧集/动漫     | 镜头边界 + 对话           | 按镜头合并到 15-30 秒，4-8 帧 | 人物关系、地点、行为、对白主题、剧情事件    |
| 短视频/Vlog        | 视觉 + 语音 + OCR         | 8-20 秒，4-8 帧               | 主体、动作、口播主题、屏幕文字、转场        |
| 会议/访谈/播客     | 语音优先，视觉低频        | 30-60 秒，2-4 帧              | 说话人、对话、议题、决定、情绪              |
| 课程/教程/屏幕录制 | OCR + 语音 + 画面变化     | 10-20 秒或幻灯片变化，3-6 帧  | 标题、步骤、软件界面、代码/公式、讲解       |
| 游戏/直播          | HUD OCR + 画面事件 + 语音 | 10-20 秒，4-8 帧              | 游戏场景、角色行为、胜负/击杀等事件、解说   |
| 监控/固定机位      | 运动/目标变化优先         | 静止段跳过；事件前后 5-15 秒  | 人/车出现、进入/离开、异常变化、时间范围    |
| 体育               | 镜头变化 + OCR + 音频峰值 | 5-15 秒，6-10 帧              | 项目、队伍/选手描述、得分/犯规/庆祝、记分牌 |

### 4.1 自动策略判定

建议建立 `VideoSemanticProfilePlanner`，输出可解释的 `profileId` 和规则证据：

```text
duration / resolution / fps / codec
shotChangeRate
speechRatio（SenseVoice 接入后）
ocrCoverage（OCR 接入后）
motionDensity
filename/path hints（只作为弱证据）
userOverride
```

自动判断置信度不足时使用 `general`，不阻塞建库。用户手工覆盖只使对应视频的规划版本失效，不清除现有 DINO/CLIP 数据。

## 5. 模型与运行时

### 5.1 视觉语义模型

| 档位     | 模型                             | 用途                               | 当前状态                           |
| -------- | -------------------------------- | ---------------------------------- | ---------------------------------- |
| 默认测试 | Qwen3-VL-2B-Instruct GGUF Q4_K_M | 4 GiB 显存设备上的结构化片段语义   | 外部测试模型已锁定，待真实样本基准 |
| 质量对照 | Qwen3-VL-4B-Instruct GGUF Q4_K_M | 对同一小样本比较事件和人物描述质量 | 计划中，非默认                     |
| 不支持档 | 8B 及以上                        | 当前 4 GiB/16 GiB 设备成本过高     | 本机禁用自动推荐                   |

默认使用 Instruct 而不是 Thinking；批量建库需要短、稳定、可验证的 JSON，而不是长推理过程。

### 5.2 两层运行时

1. **评估适配器**：本机 Ollama HTTP，仅连接 `127.0.0.1`，由用户手工安装和启动；应用不静默安装、不静默拉取模型、不把它作为发布依赖。
2. **产品适配器**：后续固定版本 `llama.cpp`/GGUF 子进程，由主进程管理生命周期、并发、超时和显存预算；模型经运行时清单锁定 revision、SHA-256、体积和许可证。

两个适配器必须实现相同的内部接口：

```ts
interface VideoSemanticRuntime {
  inspect(): Promise<VideoSemanticRuntimeStatus>
  analyze(request: VideoSemanticAnalyzeRequest): Promise<VideoSemanticAnalyzeResult>
  cancel(taskId: string): Promise<boolean>
  dispose(): Promise<void>
}
```

Renderer 不能传入模型文件路径、服务 URL、命令行参数或任意 prompt；它只能选择已注册的模型 ID、策略 ID 和素材范围。

### 5.3 本机默认预算

```text
模型：Qwen3-VL-2B-Instruct Q4_K_M
并发：1
单片段：15-30 秒
代表帧：首次4张；最终重试降到2张
帧宽：384 px
上下文：首次/第二次4096，最终重试8192
Ollama GPU层：20（其余部分卸载到CPU，Chrome常驻档）
最大输出：1024 tokens（本机实测512会截断完整结构化JSON）
temperature：0
超时：单片段 180 秒
内存软上限：12 GiB
GPU 车道：与 DINO/CLIP embedding 互斥
```

六段全GPU先导实测模型推理新增约2.97-3.04 GiB显存占用。随后Chrome常驻20段基准采用 `num_gpu: 20` 部分卸载，设备级GPU峰值最高2823 MiB；因此4 GiB档检测到可用显存不足2.5 GiB时暂停领取新片段并显示“等待 GPU”。该门槛只与20层部分卸载绑定；全GPU或更大模型不能复用。任何模式都不能在显存不足时无界并发或生成临时帧副本。

### 5.4 音频语义模型

SenseVoiceSmall 作为独立后续组件，用于 ASR、语言、情绪、音频事件和说话人标签。它不能被 Qwen 视觉结果冒充；未安装时视觉语义正常运行，并显示 `audio-model-missing`。

## 6. 分段与推理数据流

### 6.1 分段顺序

1. 从权威视频清单读取 `videoId`、路径、指纹、来源和时长。
2. 复用现有帧 manifest；缺帧时提交受控 D6 前置任务。
3. 优先按镜头变化形成候选段；没有镜头信息时按 profile 固定窗口。
4. 对静态重复帧做 dHash/现有去重，避免向模型重复提交相同画面。
5. 给每张帧附相对时间，不让模型猜测真实时间。
6. 使用固定版本 prompt 请求严格 JSON。
7. 主进程完成 schema 校验、时间范围裁剪、文本长度限制和枚举规范化。
8. 原子写入片段与任务检查点，然后释放模型上下文。

2026-08-14实现基线：正式构建入口只使用视频manifest中状态为 `done` 的既有受控缓存帧，按profile目标窗口形成确定性片段，并在主进程统一限制每段帧数。帧文件必须位于Media Search帧缓存根目录内、大小不超过2 MiB；Renderer不提供路径，构建过程不直接读取原视频。镜头变化和dHash去重仍是后续质量优化，不影响当前固定窗口安全基线。

### 6.2 结构化输出

```ts
interface VideoSemanticSegment {
  segmentId: string
  assetId: string
  videoId: string
  startMs: number
  endMs: number
  profileId: VideoSemanticProfileId
  summary: string
  scenes: string[]
  events: Array<{
    label: string
    description: string
    startMs: number
    endMs: number
    confidence: number
  }>
  persons: Array<{
    localId: string
    description: string
    actions: string[]
    confidence: number
  }>
  objects: string[]
  searchTags: string[]
  visualText: string[]
  transcriptRefs: string[]
  audioEvents: string[]
  language?: string
  warnings: string[]
  evidenceFrameIds: string[]
  modelId: string
  modelRevision: string
  promptVersion: string
  profileRevision: string
  sourceFingerprint: string
  createdAt: number
}
```

模型给出的置信度只作为排序弱证据，不能作为事实概率展示。所有人物和事件结果必须保留证据帧与时间范围。

### 6.3 持久化

新增 `media-search/semantic/video-semantic.sqlite`：

- `semantic_segments`：权威片段与版本信息。
- `semantic_events`：事件及时间范围。
- `semantic_persons`：匿名片段内人物描述。
- `semantic_fts`：summary、events、persons、objects、tags、OCR、对话的 FTS5 投影。
- `semantic_jobs`：按视频保存规划、游标、完成/失败/取消和重试信息。

不把语义主数据放在 `%TEMP%`。临时请求帧只能位于 Media Search 受控缓存目录，任务结束后按 TTL 清理。

## 7. 增量、停止与恢复

每个片段的缓存键至少包含：

```text
assetId
sourceFingerprint
segmentStartMs / segmentEndMs
evidenceFrameDigest
modelId / modelRevision / quantization
promptVersion
profileId / profileRevision
```

只有键变化的片段需要重算。任务规则：

1. 用户停止后不删除已完成片段，当前未提交片段丢弃。
2. 重启后从 `semantic_jobs.cursor` 继续。
3. 单片段最多自动重试 2 次，并降低帧数一次；仍失败则记录原因并继续下一个视频。
4. 模型更换时新版本并存，验证通过后切换 active generation；不覆盖上一代可用索引。
5. 清除语义索引只删除派生数据，不删除原视频、稳定 AssetId、DINO/CLIP、字幕或用户标签。
6. 设置面板关闭再打开时必须从主进程状态恢复进度，不能依赖 React 组件本地状态。
7. 构建和恢复均进入统一 `video-deep` 车道；同一job进程内只能有一个在途任务。
8. 应用启动时先把遗留running恢复为queued，再重新探测GPU/内存并续跑；资源不足时保持可恢复暂停态。

## 8. 搜索与融合

统一搜索增加 `video-semantic` lane：

```text
metadata/file-name
+ CLIP/DINO video-frame
+ embedded subtitle / ASR transcript
+ video-semantic FTS
+ optional person/event filters
```

融合规则：

1. 同一视频只取每条 lane 的最强分参与总分，避免长视频因片段多而刷高排名。
2. 每个视频最多保留 8 个不同时间点；同类命中在 5 秒内合并。
3. 视觉语义命中必须显示“AI 生成”以及模型版本；字幕/ASR/OCR必须显示证据来源。
4. `video-semantic` 未完成时返回现有结果，同时显示 `index-stale`；模型缺失显示 `model-missing`；格式失败显示 `task-failed`。
5. 查询不在运行时调用 Qwen；Qwen 只在离线建库阶段运行，搜索保持 SQLite/FTS/向量级延迟。

2026-08-14证据投影基线：每个视频时间点由主进程携带证据来源，Renderer只负责翻译和展示。缓存帧、内嵌字幕、AI视觉语义、OCR、转写引用和音频事件使用稳定枚举；AI语义同时显示模型与revision。视频语义FTS按实际匹配列投影来源，只有命中 `visual_text` 列才标记OCR。SenseVoice接入后复用 `transcript-reference` / `audio-event`，不需要让Renderer猜测文本来源。

## 9. UI 与设置

### 9.1 设置 → 搜索与模型 → 视频语义模型

显示：

- 设备检测：RTX 3050 Laptop / 4 GiB / 推荐 2B Q4。
- 运行时：未配置、Ollama 测试、内置 GGUF。
- 模型：安装状态、体积、revision、许可证、校验状态。
- 档位：省资源、平衡、精细和自定义。
- 能力开关：视觉事件、人物描述、OCR、语言/对话、音频事件、说话人。
- 隐私提示：完全本地、处理目录和派生数据位置。
- 操作：测试一段、暂停、继续、删除语义索引、打开数据目录。

### 9.2 Media Search

`Prepare Library` 扩展为可解释阶段：

```text
1 扫描视频
2 提取代表帧
3 构建 DINO
4 构建 CLIP
5 提取内嵌字幕
6 构建视频语义（可选）
7 构建音频语义（可选）
```

高级模式提供类型覆盖和单视频重建。简单模式默认不自动下载大型模型；用户首次启用时先显示预计下载、磁盘、速度和隐私边界。

当前实现中，运行时身份为ready且已选择视频时，构建按钮会启动真实后台Pipeline；如果该视频没有已完成缓存帧，会在创建任务前安全失败。关闭面板不会取消任务，停止、恢复和进度状态均由主进程SQLite负责。

### 9.3 进度

总进度同时显示：

- 视频：已完成/总数。
- 片段：已完成/总数。
- 当前视频、类型和时间范围。
- 已跳过、失败、待重试。
- 平均秒/片段、预计剩余时间。
- 当前资源状态：GPU、CPU fallback、等待 GPU。

进度事件来自主进程持久化任务状态；面板隐藏、功能关闭再开启和应用重启后都能恢复。

## 10. 安全与隐私

1. 默认离线；禁止将视频、帧、字幕、ASR和语义结果发往外部地址。
2. Ollama 测试适配器仅允许 loopback，拒绝 Renderer 指定 host/port。
3. 主进程根据 `videoId/frameId` 反查权威路径，Renderer 不提交缓存路径。
4. Prompt 由版本化模板生成，字幕和 OCR 作为不可信数据，不允许覆盖系统输出格式或触发工具。
5. 限制单请求帧数、像素、文本和输出长度；解析失败不能把原始模型输出直接渲染为 HTML。
6. 人脸与说话人只建立匿名本地 ID；用户显式命名属于独立受控元数据。
7. 模型下载必须使用 HTTPS、固定 revision、SHA-256、大小上限和原子落盘；失败文件不能进入 active 状态。
8. 模型、提示和 schema 版本进入 SBOM/运行时清单；正式发布前完成许可证复核。

## 11. 性能策略

1. DINO/CLIP继续承担全库快速召回，Qwen只做一次离线派生。
2. GPU深度任务单并发，并在前台搜索/可见区域 embedding 到来时允许安全让路。
3. 同一视频顺序读取帧，避免多个FFmpeg和模型进程反复抖动磁盘。
4. 监控/课程等长静态视频先去重和事件筛选，不能按固定3秒将全部帧送入Qwen。
5. mounted-network 默认先使用已缓存帧；SFTP必须走现有受控取回流程，不让模型读取远端凭据。
6. 保存每种 profile 的实际片段/小时、耗时/片段、峰值显存、内存和索引字节/小时。

## 12. 实施阶段

| 阶段 | 内容                                   | 可自动实施 | 验收重点                         |
| ---- | -------------------------------------- | ---------- | -------------------------------- |
| V0   | 契约、profile、schema、固定样本夹具    | 是         | 无模型也能完成规划并产生确定结果 |
| V1   | 持久化任务、停止/恢复、语义 SQLite/FTS | 是         | 重启、取消、幂等、损坏恢复       |
| V2   | Ollama loopback 测试适配器和设备基准   | 部分       | 需要用户批准安装/下载模型        |
| V3   | Qwen3-VL 2B 结构化视觉语义             | 部分       | 20段人工样本准确率与幻觉检查     |
| V4   | `video-semantic` 统一搜索 lane 和 UI   | 是         | 退化搜索、时间点聚合、定点播放   |
| V5   | SenseVoice ASR/语言/情绪/音频事件      | 部分       | 模型与许可证批准、中文真实样本   |
| V6   | 匿名人物/说话人跨片段关联              | 部分       | 隐私开关、误合并率、用户纠正     |
| V7   | 内置GGUF运行时、安装包和发布门禁       | 部分       | 固定供应链、资源矩阵、长时稳定性 |

## 13. 验收门禁

### 13.1 自动夹具

1. 八种 profile 规划具有确定性，用户覆盖优先。
2. 模型返回非法 JSON、越界时间、过长文本或未知字段时被拒绝或规范化。
3. 停止、崩溃、重启后不重复已提交片段。
4. 原视频指纹、模型、prompt或profile变化只使相关片段失效。
5. 模型缺失时现有帧/字幕/元数据搜索继续工作。
6. 统一搜索同一视频每lane只计最强分，最多8个时间点。
7. Renderer不能提交模型路径、服务地址、视频路径或任意prompt。
8. 清除语义数据不触碰原视频、AssetId、DINO/CLIP和用户素材元数据。

### 13.2 本机小样本

在用户批准模型下载后，使用20个脱敏片段对2B Q4执行：

- JSON有效率目标不低于98%。
- 片段开始/结束时间全部在权威时长内。
- 人物数量、主要场景和主要事件由人工逐项标记。
- 记录幻觉、漏检、时间顺序错误、平均耗时和峰值资源。
- 4B只对相同20段复跑；质量收益不足以抵消耗时时不升级默认模型。

### 13.3 多类型真实验收

每种类型至少10段，覆盖不同分辨率、横竖屏、语言、字幕有无和长短视频。真实素材只读，报告只记录脱敏ID和聚合指标，不将原始内容写入仓库。

## 14. 决策点

开始模型实测前仍需用户批准：

1. 是否安装Ollama测试运行时。
2. 是否下载约1.9GB的Qwen3-VL 2B Q4模型。
3. 测试素材范围；默认只处理用户明确选择的20个片段。
4. 是否在第二阶段下载SenseVoice。

除这四项外，契约、profile规划、持久化、退化搜索和自动化测试可以按关联TODO自动推进。

## 15. 外部参考

- Qwen3-VL官方代码与能力说明：<https://github.com/QwenLM/Qwen3-VL>
- Qwen3-VL-2B-Instruct GGUF：<https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF>
- Ollama Qwen3-VL测试入口：<https://ollama.com/library/qwen3-vl>
- SenseVoice官方项目：<https://github.com/FunAudioLLM/SenseVoice>
