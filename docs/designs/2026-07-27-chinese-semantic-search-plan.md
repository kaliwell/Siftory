# 中文语义搜索方案（多语言文本编码器，面板复用）

> 状态：部分实施  
> 更新日期：2026-07-27  
> 范围：Image Search 语义搜索、Media Search 文本搜帧、NekoSearch 文本向量调用方  
> 替代文档：无  
> 关联文档：[准确率模型路线评估](2026-07-18-neko-search-accuracy-model-evaluation.md)（多语言 CLIP/SigLIP 路线当时因"需全库重建"暂缓，本方案给出免重建路径）、[主体搜索实施交接](../current/2026-07-24-feature-implementation-handoff.md)（§29 记录本轮实施与验证结果）

## 0.1 实施状态（2026-07-27，Kimi/coder）

Phase 0–2 已落地：双文本塔路由、设置切换（`textEncoder: auto|english|multilingual`）、5 处调用方切换、manifest/打包/THIRD_PARTY_NOTICES 登记、模型下载附属文件支持。

验证结论（证据见交接文档 §29 与 `docs/benchmark/2026-07-27-chinese-semantic-search-eval.json`）：

1. torch fp32 vs ONNX quint8 余弦最低 0.999117（10 条中英文句子），量化漂移可忽略。
2. 真实库 326,980 条 CLIP 向量对比：具体物体/场景类中文查询检索正确（人工看图确认猫、红裙、高跟鞋等与英文塔同 top1）；"动漫女孩"等风格修饰词查询丢失风格语义（多语言塔固有限制，英文查询经多语言塔同样丢失，非中文特有问题）。
3. `textEncoder` 默认 `auto` 保留——英文查询行为零变化；对风格类中文查询不满意的用户可手动切换或改英文查询。
4. 剩余：§9 的正式中文标注集门禁（20–30 条人工标注）未做；打包安装验证（Phase 3）未做。
5. 2026-07-27 实测反馈修复：GPU 后端下多语言塔走 DML 导致主进程 native 崩溃，已改为固定 CPU（AVX2 量化模型，DML 无法加速），真实应用 CDP 验证通过（交接文档 §29.6）。

## 0. 执行身份与基线确认

1. 执行者：Kimi（Kimi Code CLI）；精确模型版本未公开，不作猜测；本轮未启动子代理修改代码。
2. 文档入口：`docs/README.md`；已读当前基线 `docs/current/2026-07-18-neko-search-optimization-progress.md`、`docs/current/2026-07-24-feature-implementation-handoff.md`。
3. 现状代码结构由只读探索复核（2026-07-27），关键引用均为当前代码行号。
4. 工作区状态：Git 仓库尚无任何提交（未提交现场），全部文件 untracked；本方案为纯文档新增，不改动代码。
5. 本文档为草案，未获批准前不实施。

## 1. 目标与非目标

### 1.1 目标

1. 用户可用中文自然语言（如"穿红裙子的女孩"、"夜晚的城市街道"）搜索图片和视频帧，精度不低于现有英文语义搜索的同语义查询。
2. 能力作为**统一文本编码服务**落地，现有所有文本→向量调用方（Image Search 语义搜索、Media Search 文本搜帧、NekoSearch 标签建议/聚类标签）自动获得中文能力，不为每个面板单独实现。
3. **不重建任何已有向量**：真实库 18.7 万素材的 CLIP 图像向量、全部视频帧向量、ANN 索引、f32 缓存全部继续有效。
4. 英文查询行为零回归。

### 1.2 非目标

1. 不更换图像编码器（CLIP ViT-B/32 图像塔不动），不引入 Chinese-CLIP / SigLIP 等自带图像塔的双塔模型。
2. 不改 ANN、不改向量比对与重排管线、不改反馈学习模型。
3. 不做 OCR、文件名语义、视频关键帧接入（路线图 30 维持最后）。
4. 聚类语义标签、人物语义分组的英文候选 prompt 中文化（它们是图-文匹配，英文 prompt 对新旧文本塔均可用；中文 UI 展示属另一话题）。
5. zero-shot 降级分类器（`scoreWithClipZeroShot`）多语言化，保持英文。

## 2. 现状（2026-07-27 代码复核）

1. 文本 embedding 统一入口是 `electron/semanticSearchService.ts:1107` `getClipTextEmbedding()` / `:1075` `getClipTextEmbeddings()`：主进程内 `@huggingface/transformers` 加载 `Xenova/clip-vit-base-patch32` 文本塔（`onnx/text_model_q4.onnx`，512 维），每条查询用 `['a photo of X', X]` 双 prompt 取均值（`:1081`），设备读 `vector-settings.json`（`:754`，GPU 时 win32 走 dml）。
2. 全部文本→向量调用方共用该入口：
   - Image Search 语义搜索：`vector:searchSemantic`（`electron/vectorIpc.ts:311`）→ `searchSemanticImages`（`semanticSearchService.ts:1634`），对 f32 缓存全量内积扫描（`:1237`）。
   - Media Search 文本搜帧：`electron/videoFrameSearchService.ts:24` 把 `getClipTextEmbedding` 注入为 `textEmbeddingProvider`（`:276` 调用）。
   - NekoSearch 标签建议：`assetLibraryService.ts:3321`（text_label 模式）；聚类语义标签：`:3756`；人物语义分组：`semanticSearchService.ts:1134`。
3. 图像侧 embedding 由子进程 `electron/clipEmbeddingChild.ts` 产出，与文本塔同属 CLIP ViT-B/32 的 512 维共享空间。
4. 模型管理：`models/manifest.json`（url/sha256/dim，仅 2 条）→ `electron/modelService.ts`；模型存于 `ai-models/`，打包经 `package.json` extraResources（当前 `ai-models` 有过滤器，仅含 `dinov2_vitb14` 与 `clip_vit_base_patch32`）。
5. 英文文本塔对中文查询基本无效（CLIP ViT-B/32 原版词表与训练语料以英文为主），这是本方案要解决的问题。

## 3. 模型选型

| 选项 | 向量空间 | 是否需重建图像向量 | 中文质量 | 体积（估算） | 授权 | 结论 |
| ---- | -------- | ------------------ | -------- | ------------ | ---- | ---- |
| A. `sentence-transformers/clip-ViT-B-32-multilingual-v1` | **与现有 CLIP ViT-B/32 图像向量同一 512 维空间**（多语言知识蒸馏，图像塔不变） | **不需要** | 中等（蒸馏模型，50+ 语言） | fp32 ≈540MB，int8 ≈135MB，q4 ≈70–100MB | Apache-2.0 | **选用** |
| B. Chinese-CLIP（OFA-Sys） | 独立空间（自有图像塔） | 需要：18.7 万素材 + 全部视频帧重算 | 高 | 图+文双塔 ≈800MB+ | Apache-2.0 | 否决（重建成本与风险，与 07-18 评估结论一致） |
| C. 多语言 SigLIP | 独立空间 | 需要 | 高 | 双塔 ≈700MB+ | Apache-2.0 | 否决（同上） |
| D. 本地机翻 zh→en + 现有英文塔 | 不变 | 不需要 | 受翻译损耗，延迟加倍 | 翻译模型 ≈300MB | 视模型而定 | 否决（引入第二模型与延迟，质量无优势） |
| E. multilingual-e5 等文本向量模型 | 文本-文本空间，**不对齐 CLIP 图像空间** | 无法用于图文搜索 | — | — | — | 否决（空间不兼容） |

选用 A 的决定性理由：它是唯一"只换文本编码器、图像向量免重建"的选项。蒸馏自 OpenAI CLIP ViT-B/32 教师模型，输出 512 维、与现有图像向量同空间，比对管线、缓存、ANN、反馈重排零改动。

已知代价（如实记录）：

1. 蒸馏多语言模型的跨模态对齐弱于原生 Chinese-CLIP；中文长尾/专业词汇可能不如人意。验收门禁（§9）不达标时不切换默认，只保留为可选编码器。
2. 体积估算基于 135M 参数（多语言 DistilBERT + pooling + Dense 768→512），实际以下载文件为准。
3. HuggingFace 官方仓库是否带 `onnx/` 子目录**未验证**（当前网络无法访问 HF 文件列表）；实施时按 §8.1 两条获取路径执行。

## 4. 架构与数据流

### 4.1 总体设计：并存双文本塔 + 查询路由

现有英文文本塔保留不动；新增多语言文本编码器作为并列单例。统一入口增加路由层：

```text
查询文本
  → getQueryTextEmbedding(text)                       （新路由层，semanticSearchService）
    → resolveTextEncoder(text, settings.textEncoder)  （auto：含 CJK 字符 → multilingual；否则 → english）
    → multilingual: electron/multilingualTextEncoder.ts（新模块，懒加载单例）
    → english:      现有 getClipTextEmbeddings（不动）
  → 512 维查询向量（两个编码器同一向量空间）
  → 现有比对/重排/返回管线（零改动）
```

1. 路由为纯函数，可测：CJK 判定正则覆盖中日韩统一表意文字与假名/谚文（`[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]`）；`auto` 模式下命中即走多语言塔（中英混合查询也走多语言塔，其英文能力由蒸馏保留）。
2. 所有现有调用方（§2.2 的 5 处）改为调用 `getQueryTextEmbedding`，**签名与返回形状不变**（`(texts: string[]) => Promise<Float32Array[]>` 归一化 512 维），调用点改动为逐行替换，无契约变化。
3. Media Search 的 `textEmbeddingProvider` 注入点（`videoFrameSearchService.ts:24`）默认值改绑 `getQueryTextEmbedding`，测试注入机制不变。

### 4.2 Prompt 模板

现有英文路径的 `['a photo of X', X]` 双 prompt 是英文塔专用技巧。多语言路径 Phase 0 做 A/B：原始查询 vs `['一张X的照片', X]` 双 prompt，按 §9 评测结果定稿，默认从原始查询开始（更朴素、可解释）。

### 4.3 面板复用

本方案的核心收益：一次接入，四处生效。

| 面板/功能 | 入口 | 复用方式 |
| --------- | ---- | -------- |
| Image Search 语义搜索 | `vector:searchSemantic` | 自动获得中文查询能力 |
| Media Search 文本搜帧 | `mediaSearch:searchFramesByText`（及 multimodal 融合） | 同上 |
| NekoSearch 标签建议（text_label） | `assetLibraryService.ts:3321` | 标签名编码走路由层；中文标签名直接可用 |
| NekoSearch 聚类语义标签 / 人物分组 | `assetLibraryService.ts:3756`、`semanticSearchService.ts:1134` | 候选 prompt 编码走路由层（候选词仍为英文，路由 auto 下行为不变） |

## 5. 数据结构与 IPC 契约

1. `shared/vectorTypes.ts` `VectorSettings` 增加可选字段 `textEncoder?: 'auto' | 'english' | 'multilingual'`，默认 `'auto'`；持久化于 `userData/vector-settings.json`，复用现有 `vector:getVectorSettings` / `vector:saveVectorSettings` IPC，**不新增 IPC 通道**。
2. 非法值/缺失安全回退 `'auto'`（与 backend 字段同款白名单策略，参考 `resolveAssetReferenceEmbeddingBackend` 先例）。
3. 多语言编码器加载失败（模型缺失/损坏）时回退英文塔并在结果中标记 degraded，不中断搜索（与现有 YOLO→显著性→center crop 降级链同一哲学）。
4. 搜索响应增加可选诊断字段 `textEncoderUsed?: 'english' | 'multilingual'`（不破坏现有契约，可选字段）。
5. 图像向量缓存 `CLIP_CACHE_VERSION` **不变**（图像侧零改动，无需失效重建）。

## 6. 模型清单与打包

1. `models/manifest.json` 增加第三条：`name: clip_vit_b32_multilingual_v1_text`，dim 512，license Apache-2.0，sha256/sizeBytes 以下载实物为准填写；`framework: onnx`；描述注明"仅文本编码器，与 clip_vit_base_patch32 图像向量同空间"。
2. 模型落盘布局沿用现有惯例：`ai-models/clip_vit_b32_multilingual_v1_text/<org>/<model>/onnx/model_int8.onnx`（量化档位以 Phase 0 精度验证为准，优先 int8）。
3. `package.json` extraResources 的 `ai-models` filter 增加 `clip_vit_b32_multilingual_v1_text/**/*`。
4. `electron/modelService.ts` manifest 消费逻辑无需改动；`getModelStatus` 自动反映新条目。
5. `THIRD_PARTY_NOTICES.md` 登记 sentence-transformers/clip-ViT-B-32-multilingual-v1（Apache-2.0）。

## 7. UI 与状态设计

1. Settings 向量设置区增加"文本编码器"下拉：自动（推荐）/ 中文优先（multilingual）/ 仅英文（english）。默认自动。
2. 语义搜索进行时进度条文案不变；完成后 toast/状态行可显示 `encoder: multilingual`（利用 §5.4 诊断字段），便于用户发现"中文走了新模型"。
3. 模型未下载时 UI 显示下载入口（复用现有 `vector:downloadModel` 链路）；下载前中文查询静默回退英文塔 + degraded 提示。
4. 各搜索面板（Image Search / Media Search / NekoSearch）**无任何 UI 改动**——这是复用设计的目的。

## 8. 性能、安全与失败恢复

### 8.1 模型获取（Phase 0 验证步骤）

按优先级两条路径，均须 SHA-256 记录 + torch vs ONNX 输出余弦 = 1.0 验证（沿用 OSNet 导出验收协议，见交接文档 §10.1）：

1. 官方仓库自带 `onnx/` 权重（若存在，直接下载 + 校验）。
2. 自导出：`SentenceTransformer('clip-ViT-B-32-multilingual-v1')` 整体（transformer + pooling + dense）`torch.onnx.export`（opset 17，动态 batch/seq），再 int8 量化；精度对照 torch 输出。

### 8.2 性能

1. 文本编码在主进程执行（与现有一致：查询是低频操作，单条 <100ms 量级）；懒加载单例，首次中文查询付一次模型加载（int8 ≈135MB，约 1–3s）。
2. 常驻内存增加约 150–250MB（与 AdaFace 260MB 常驻同级，策略一致；低内存场景后续可加闲置卸载，非本期目标）。
3. 比对管线不变，扫描延迟基线不变（stats/检索 p95 不受文本塔影响）。

### 8.3 安全

1. 模型文件仅来自 manifest 固定 URL + SHA-256 校验，禁止远程动态加载（`env.localModelPath` 策略沿用，`semanticSearchService.ts:1035` 先例）。
2. 查询文本长度上限（现有 IPC 校验）不变；无新增攻击面、无新增 IPC 通道，能力矩阵只需在备注中说明 `vector:searchSemantic` 的路由行为。

### 8.4 失败恢复

降级链：多语言塔加载失败 → 英文塔 + degraded 标记；设备初始化失败（dml）→ CPU（现有 `:1060` 回退逻辑复用）；两条塔都失败 → 现有文件名/zero-shot 降级路径不变。

## 9. 质量验收（门禁先行，不达标不切默认）

1. **中文标注集**：复用 `tests/media-search-text-annotation.cjs` 工具链，新增 20–30 条中文概念查询（覆盖人物/物体/场景/动作/颜色，中英文同义对照），人工标注候选池。
2. **基线对比**：同一图片集上，中文查询（多语言塔）vs 同义英文查询（英文塔）的 P@20 / R@50 / nDCG@20。验收线：中文不低于英文同义查询的 −5pt。
3. **A/B 定稿**：原始查询 vs 中文双 prompt 模板（§4.2），按上述指标选优。
4. **英文回归**：现有英文固定样本测试与 NekoSearch 准确率基线（`--gate`，test01）不得回退。
5. 基线 JSON 记录到 `docs/benchmark/`，遵循原始产物不手工改写的规则。

## 10. 实施阶段与验收标准

| 阶段 | 内容 | 验收 |
| ---- | ---- | ---- |
| Phase 0 | 模型获取（§8.1）、量化、torch/ONNX 余弦 1.0 校验；中文标注集构建与首轮离线评测（§9.1–9.3） | 评测报告落 `docs/benchmark/`；达标才进 Phase 2 |
| Phase 1 | `multilingualTextEncoder.ts` 新模块 + 路由层 + VectorSettings 字段 + manifest/打包/THIRD_PARTY_NOTICES；5 处调用方切换到 `getQueryTextEmbedding` | 路由纯函数单测（CJK 判定、设置覆盖、双塔回退）；typecheck/lint/format 全绿 |
| Phase 2 | 全链路接线验证：Image Search 中文查询、Media Search 中文搜帧、NekoSearch 中文标签建议；`smoke:ui` 通过；英文回归（`npm test` 全链） | §9.4 全绿；真实库只读验证中文查询结果合理性（人工抽检 Top20） |
| Phase 3（可选） | 打包安装验证（安装包体积 +约 135MB 记录）；真实 NSIS 安装后中文搜索冒烟 | packaged smoke 全绿，安装包 SHA-256 记录 |

每个阶段完成标准遵循项目惯例：对应测试入链、typecheck/lint/format 全绿、文档同步（本文档转"部分实施"/"当前"，`docs/README.md` 基线更新）。

## 11. 风险与开放问题

1. **中文蒸馏质量风险**（最大风险）：若 §9.2 不达标，方案降级为"可选编码器"而非默认路由；升级路径是 Chinese-CLIP 双塔重建（大工程，另行立项）。
2. **HF 官方 ONNX 存在性未验证**：Phase 0 第一动作；自导出路径已被 OSNet 先例验证可行。
3. **中英混合查询**归多语言塔，其英文纯度略低于原生英文塔——`auto` 策略下可接受，介意者可手动锁 `english`。
4. **量化精度损失**：int8 vs fp32 的余弦偏差需在 Phase 0 实测记录；若偏差影响排序指标则改用 fp16。
5. 开放问题：是否把 `textEncoderUsed` 展示到搜索结果行（UI 噪音 vs 可诊断性），Phase 2 实测后定。

## 12. 参考来源

1. [sentence-transformers/clip-ViT-B-32-multilingual-v1 模型卡（ModelScope 镜像）](https://modelscope.cn/models/sentence-transformers/clip-ViT-B-32-multilingual-v1)：DistilBERT + mean pooling + Dense 768→512 结构。
2. [SBERT 多语言模型文档（Gitee 镜像）](https://fuxi.gitee.com/hf-models/sentence-transformers/clip-ViT-B-32-multilingual-v1)：多语言知识蒸馏，图像编码器不变，50+ 语言。
3. [PromptLayer 模型属性](https://www.promptlayer.com/models/clip-vit-b-32-multilingual-v1-8626)：135M 参数、Apache-2.0。
4. [fastembed #70](https://github.com/qdrant/fastembed/issues/70)：该模型 ONNX 导出方式参考（含 dense 层整体导出）。
