# SenseVoice语言、对话与音频语义阶段

> 日期：2026-08-14  
> 任务：VID-014  
> 状态：部分实施
> 实施状态：SenseVoice、FSMN-VAD 与 CAM++ 官方模型及 CPU 运行时已安装并校验；真实匿名双人样本的机器验收已通过；等待人工听审说话人边界

## 官方能力与边界

- 官方SenseVoiceSmall checkpoint支持中文、粤语、英文、日文和韩文ASR与语种识别，并输出情绪与常见音频事件标签。
- 当前事件范围包括语音、背景音乐、掌声、笑声、哭声、咳嗽和喷嚏等；它不是通用环境声音识别器。
- 说话人分离不是SenseVoiceSmall checkpoint原生输出。当前使用独立FSMN-VAD检测语音段、CAM++生成192维说话人向量，再进行单视频内匿名聚类；UI独立显示这两个模型的实际可用状态。
- 官方权重仓库当前约944 MB，许可证标记为`model-license`。官方维护者说明商业本地桌面使用可行，但必须遵守FunASR模型协议、保留模型名称并署名；第三方转换权重需要单独核对。

官方依据：

- <https://github.com/QwenAudio/SenseVoice/blob/main/README_zh.md>
- <https://huggingface.co/FunAudioLLM/SenseVoiceSmall/tree/main>
- <https://github.com/QwenAudio/SenseVoice/issues/286>
- <https://github.com/modelscope/FunASR/blob/main/runtime/llama.cpp/sensevoice/README.md>
- <https://www.modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch/summary>
- <https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common/summary>
- <https://github.com/modelscope/FunASR/blob/main/docs/tutorial/README.md>

## 已实现

1. 新增独立`audioSemantic`契约，覆盖ASR文本、五种语言加无语音、八种情绪、受控音频事件和可选匿名说话人来源。
2. 每段音频最长30秒；模型身份、revision、运行时、量化、原视频指纹和权威时间范围进入记录。
3. 新增可替换运行时、显式`audio-model-missing`实现、Fake运行时和运行时替换释放规则。
4. 只接受内存中的16 kHz、单声道PCM16；大小不能超过权威时间段，不接受Renderer路径或远程URL。
5. FFmpeg通过参数数组提取受控时间段，不构造shell命令；输出字节数、超时和缓冲区有界。
6. ASR记录与内嵌字幕分开持久化，统一文本搜索返回`transcript-reference`，音频事件额外返回`audio-event`证据来源。
7. 音频语义状态卡已加入Media Search；当前根据Python、runner和五个关键模型文件的实际体积返回`ready`，缺失或损坏时仍明确退化。
8. 匿名`speaker-N`只有在权威独立说话人模型身份存在时才可写入；SenseVoice单模型结果不能冒充说话人分离。
9. 新增隔离FunASR子进程适配器：只通过stdin接收有界PCM，固定CPU、离线环境、180秒超时、64 KiB stdout与256 KiB stderr上限，并支持取消。
10. 富标签被严格映射为语言、情绪与音频事件，控制标签不会混入转写正文；runner随应用打包，但Python环境和模型不进入安装包。
11. Python runner改为常驻、逐行JSON协议，同一批任务只冷加载一次模型；官方样例实测冷启动17.660秒、复用后单段281毫秒，输出一致。
12. 新增独立`audioSemanticBuildChild`，按权威视频清单生成最长30秒的确定性计划；任务、游标、成功/失败数和暂存记录原子持久化，应用重启后可从剩余片段恢复。
13. 构建子进程使用`ELECTRON_RUN_AS_NODE`隔离，主进程只传已经在Media Search清单中、仍存在且带音轨的视频；恢复前重新核对路径、时长和源指纹，Renderer不能传入任意路径。
14. Media Search状态卡新增整库构建、停止、恢复、视频/片段进度、失败数和当前时间段；关闭再打开视频素材库面板后从主进程状态恢复，不依赖组件内存。
15. 每个视频完成时将SenseVoice片段原子写入独立ASR转写文件；搜索结果继续携带精确`matchStartMs / matchEndMs`、模型身份、情绪和音频事件来源。
16. 常驻Python子进程同时加载FSMN-VAD与CAM++，按请求区分`transcribe`和`diarize`；VAD输出被限制为当前30秒权威PCM内的有序时间段，CAM++只接受归一化且有限的192维向量。
17. 新增单视频内匿名说话人聚类：实测校准阈值为0.30，最多32人和100,000次分配；`speaker-N`映射、归一化中心和分配记录原子持久化，重启后同一时间段不会漂移或重复计算。
18. 整库worker先做VAD和说话人向量，再按语音时间段切片交给SenseVoice；说话人标签携带独立`campplus-speaker / modelscope-v2.0.2`权威身份，并随ASR记录进入搜索结果。
19. 状态卡独立检查FSMN-VAD和CAM++关键文件的精确体积，显示模型ID、revision及缺失/损坏原因；任一模型不可用时不会伪造说话人，但原有ASR仍可退化运行。

## 当前运行时决定

- 首选真实验证路径：官方FunASR + 官方SenseVoiceSmall，原因是它支持长音频VAD分段和时间线；只允许本地推理。
- GGUF/llama.cpp作为后续CPU与打包候选。官方当前实现适合16 kHz单声道、CPU和单二进制，但时间戳仍列在路线图中，因此不作为第一版时间线索引的唯一运行时。
- 不自动下载第三方ONNX/GGUF转换权重，不把模型直接塞入安装包。

## 已锁定的模型与运行时

1. 官方仓库：`FunAudioLLM/SenseVoiceSmall`。
2. revision：`3847d57b6bdf2dd8875cb1508d2af43d80a16bf7`。
3. 快照：29个非缓存文件，共943,980,179字节；`model.pt`为936,291,369字节，SHA-256为`833ca2dcfdf8ec91bd4f31cfac36d6124e0c459074d5e909aec9cabe6204a3ea`。
4. 隔离环境：Python 3.12、FunASR 1.3.29、Torch/Torchaudio 2.5.1 CPU、NumPy 1.26.4、Transformers 4.46.3。
5. 保存目录：`%APPDATA%\floating-clock-electron\runtimes\sensevoice`；安装包不包含约944 MB模型。
6. 供应链凭据：`resources/runtime-receipts/sensevoice-small-funasr.json`，运行时清单已登记；发布前仍需完成模型许可证与署名的法律复核。

说话人时间线模型也已锁定并作为外部运行时保存：

1. FSMN-VAD：`iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`，revision `v2.0.4`，8个文件共4,030,689字节；`model.pt` SHA-256为`b3be75be477f0780277f3bae0fe489f48718f585f3a6e45d7dd1fbb1a4255fc5`。
2. CAM++：`iic/speech_campplus_sv_zh-cn_16k-common`，revision `v2.0.2`，11个文件共28,962,447字节；`campplus_cn_common.bin` SHA-256为`3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8`。
3. 两者均由ModelScope官方页面标记为Apache-2.0，保存于SenseVoice外部运行时的`models`目录，不进入安装包。
4. 供应链凭据为`resources/runtime-receipts/fsmn-vad-campplus-funasr.json`；runtime manifest、第三方组件清单和许可证一致性门禁已更新。

下载期间普通HTTP在最后约39 MiB发生一次`IncompleteRead`；保留已下载块、安装官方`hf_xet`后按同一revision续传成功，没有删除或重建整个模型目录。

## 真实验证

- 官方中文样例：本地CPU冷加载与推理成功，返回`zh / NEUTRAL / Speech`，总耗时约20.6秒，模型前向约1.16秒。
- 匿名真实样本`sample-25ed`：只读7.0–22.0秒音轨，提取480,000字节PCM；返回`zh / HAPPY / BGM`和8个转写字符，总耗时19.547秒。
- 同一片段经正式Node适配器端到端复核为`zh / happy / speech+bgm`，耗时18.643秒，证明IPC后端将使用的解析与子进程路径可工作。
- 常驻运行时复核：官方样例冷启动17.660秒，第二次调用281毫秒；说明整库批处理不会为每个30秒片段重复加载约944 MB模型。
- 凭据只记录匿名ID、时间范围、标签、字符数和耗时，不保存完整对话、真实路径或文件名。
- 推理期间设置Hugging Face与Transformers离线模式，`trust_remote_code=false`，未使用GPU，因此不会与Qwen/Chrome争抢4 GiB显存。
- 官方样例经正式Node适配器完成联合验证：FSMN-VAD得到70–14,980毫秒语音段，CAM++返回有限且归一化的192维向量；首次联合调用13.492秒，随后同一常驻进程SenseVoice转写2.405秒。
- CAM++三个官方样例均得到192维有限向量；同说话人余弦相似度0.6936，不同说话人为-0.0842。该结果只证明运行时与基本区分能力可用，不代替真实多人视频验收。
- 经用户批准从既有匿名验收集选择`sample-ebe4`做首个47.8秒单视频正式任务：2/2源片段、0失败、两个语义段均归为`speaker-1`。链路通过，但该音轨没有提供多人声纹证据，因此没有据此宣称多人验收成功。
- 随后只读探测`sample-a569`与`sample-39de`的固定20秒片段，两者均产生2个VAD语音段和2个CAM++聚类；选择更短的`sample-39de`约4分13秒完成全视频任务。
- 首轮真实全视频任务暴露两个此前夹具未覆盖的问题：官方模型ID中的仓库分隔符`/`被通用身份守卫拒绝；AAC解码的尾部采样落在Node容差内但超过Python 30秒硬边界。前者改为只允许一个安全仓库分隔符且拒绝路径逃逸，后者在FFmpeg输出后裁剪至权威PCM字节数。
- 修复后`sample-39de`为9/9源片段、0失败、23个语义时间段且时间线有序；22个带CAM++声纹的时间段在0.45阈值时碎片化为9组。对同一22个真实向量的只读曲线为：0.45→9组、0.40→7组、0.35→5组、0.30→2组（15/7）、0.25→2组（20/2）、0.20→1组，因此固定0.30并新增0.31合并/0.29分离回归门禁。
- 最终重跑仍为9/9、0失败和23个有序时间段，22个声纹稳定为`speaker-1:15 / speaker-2:7`；23段转写与最新generation一致。搜索`speech`返回23个精确起止范围，全部为SenseVoice来源，两个匿名speaker均能返回。记录只使用匿名ID和统计，不写入验收文档中的原文件名、路径或完整对话。
- 人工打开验收网页后确认上述约4分13秒候选主要是哼唱，因此机器的“两种声纹”不能作为对话分离质量证据。改用此前探测过的`sample-a569`：约27分48秒，6个分散20秒探针均有38–114个有效转写字符、1–3个VAD轮次和9.1–20秒语音覆盖。正式全视频任务56/56源片段、0失败，得到147个中文语义轮次、约21.7分钟有效语音、6158个转写字符，speaker候选分布为107/39/1；最新转写与generation一致。该样本成为当前人工听审权威集。

## 自动验证

- 音频语义现有23项专项测试，覆盖权威schema、仓库模型ID、PCM/FFmpeg尾部裁剪、常驻运行时、任务游标、跳过不可读视频、暂存去重、篡改计划拒绝、ASR原子持久化、CAM++持久聚类、0.30决策边界、独立说话人模型溯源、精确搜索时间段和UI/打包契约。
- `npm.cmd run test:media-search` 136/136、TypeScript、定向ESLint、i18n静态门禁、架构检查、许可证门禁和生产Vite构建通过；worker构建图为36个模块。
- 离线安装包已生成；包内包含`audioSemanticBuildChild.js`与`sensevoice_runner.py`，扫描确认`model.pt`和`campplus_cn_common.bin`数量为0，三个模型继续只存在于应用数据目录。
- 官方样例、一个短匿名样本和一个约4分13秒匿名双人候选完成真实ASR/VAD/CAM++；没有自动启动整库。整库读取仍必须由用户在界面确认后触发。

## 剩余边界

1. `VID-014`已于2026-08-15按用户接受的抽样门禁标记`verified`：私有网页记录中21条已判定样本全部为“标签正确”，另1条未确认，用户确认整体基本可用并要求进入下一步。147条没有逐条全审，文档与导出不得把抽样结论表述为全量准确率。
2. 整库批处理工程链已经完成，但尚未由用户点击执行真实素材库验收；高级模式可先选择单个视频，观察语言、对话、情绪、事件和时间点，再决定是否扩展全库。
3. Python/FunASR环境、约944 MB SenseVoice和约33 MB VAD/CAM++模型仍是应用数据目录中的外部运行时，不进入安装包；正式分发前继续保留许可证、署名和SBOM门禁。
