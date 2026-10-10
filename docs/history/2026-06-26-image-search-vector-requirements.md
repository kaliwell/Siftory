# Image Search 向量检索与精排增强原始需求

> 状态：历史需求  
> 日期：2026-06-26  
> 说明：以下内容保留需求提出及落地过程，不代表当前实现状态。  
> 当前入口：[文档中心](../README.md)

请基于当前 Floating Clock Electron 项目的 ImageSearch / fast_scanner 0.4.3 进度，新增“第二层 Vector Retrieval + 第三层 Rerank Verification”图片物品匹配增强功能。注意：当前项目已经实现 C++ N-API fast_scanner.node、DiffHash64、DctHash64、DiffHash256、WIC JPEG 快速解码、segment v4 mmap、append segment、overlay tombstone、async load/save/hash/searchByImage、background compact、auto compact、Duplicate Finder 面板，以及 DCT 精排模式。新功能必须作为现有第一层 Hash Retrieval 的增强模块加入，不能推翻现有架构，不能破坏 fast_scanner 当前 pHash/dHash/DCT 近重复检索能力。

落地位置补充（2026-06-26）：

本功能主要落在 Image Search 上，不新建独立主面板。具体入口为 `src/components/ImageSearchPanel.tsx`：

1. Image Search 的 `fast` 模式继续调用现有 fast_scanner Hash 检索。
2. Image Search 的 `standard` / `precise` 模式调用 `vector:searchLayered`，由 Electron 主进程中的 `rerankService` 编排 Hash + Vector + Rerank。
3. Image Search 扫描完成并自动保存 fast_scanner 索引后，通过 `seedEmbeddingJobs()` 为当前索引图片创建 embedding 构建任务。
4. Image Search 面板中的 `Build Embeddings` 负责后台生成向量，`Build Index` 负责把已生成向量加载到向量索引。
5. 模型未安装、embedding 未构建或向量索引不可用时，标准/精准模式必须降级为 Hash 结果，不能影响原有近重复图片搜索和 Duplicate Finder。

当前落地状态（2026-06-27）：

项目路径：`<USER_HOME>\AppData\Local\Reasonix\floating_clock_electron7\s220260601_221046`

审计范围：Image Search 三层图片物品匹配系统、DINOv2 ONNX 模型下载、真实 embedding worker、查询侧向量生成、构建与 smoke test。

结论：该功能已经从“架构/POC”推进到“真实 DINOv2 向量检索 + 真实颜色/形状精排可内部测试”。Image Search 的 `standard` / `precise` 模式现在使用本地 DINOv2 q4 ONNX 生成 768 维向量；`precise` 模式的 colorScore / shapeScore 已基于真实图片特征；`fast` 模式仍保持原 fast_scanner Hash 检索不变。

已完成：

1. 已下载 `Xenova/dinov2-base` q4 ONNX 模型到用户数据目录：
   `<APP_DATA>\models\dinov2_vitb14\Xenova\dinov2-base`
2. ONNX 权重文件：
   `onnx\model_q4.onnx`
   大小：56,428,185 bytes
   SHA-256：`19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018`
3. `embeddingWorker` 已移除 mock embedding 路径，改为离线加载本地 DINOv2 ONNX，输出 768 维归一化向量。
4. `rerankService` 查询侧已改为真实 DINOv2 query embedding，不再使用 mock query vector。
5. `models/manifest.json` 已改为本地可用的 Transformers.js q4 ONNX 模型条目。
6. `modelService` 下载模型时会同步下载 Transformers.js 必需的 `config.json` 和 `preprocessor_config.json`。
7. `@huggingface/transformers` 已加入依赖；构建时对 `@huggingface/transformers`、`sharp`、`onnxruntime-node` 做外部化处理。
8. `colorFeatureService` 已改为使用 sharp 真实采样图片像素，生成 HSV histogram 和 dominant colors。
9. `shapeFeatureService` 已改为使用 sharp 读取真实尺寸和灰度采样，计算 aspectRatio、objectAreaRatio、bboxWidth、bboxHeight 和 edgeDensity。
10. `rerankService` 在 `precise` 模式中会异步提取 query 与候选图的真实颜色/形状特征后再计算 finalScore。

验证状态：

1. `npm.cmd run typecheck`：通过。
2. `npm.cmd run format:check`：通过。
3. `npm.cmd run test:vector-pipeline`：通过，12 passed。
4. `npm.cmd audit --audit-level=high`：通过，0 vulnerabilities。
5. `npm.cmd run build`：通过，NSIS 安装包生成。
6. `dist-electron\embeddingWorker.js` worker 探针：通过，返回 768 维真实向量。
7. `release\win-unpacked\FloatingClock.exe` smoke test：通过，5 秒后仍运行。

仍需继续：

1. `MemoryVectorIndex` 仍是线性扫描，内部测试可用；大规模图库需要后续接 hnswlib/FAISS 或其他 ANN provider。
2. shape bbox / 主体定位目前是轻量启发式，复杂背景、多主体、低对比物体仍需后续接 object crop、saliency、YOLO 或 SAM。
3. 需要准备真实图库做 TopK 质量评估，验证 `standard` / `precise` 相比 `fast` 的召回和误匹配变化。

整体目标：将当前“近重复图片搜索 / 查重 / 相似图搜索”升级为“三层本地图片物品匹配系统”。第一层继续使用现有 fast_scanner 的 DiffHash / DCT / Hamming Distance / mmap segment 体系，负责重复图、近重复图、压缩图、改尺寸图快速召回。第二层新增 DINOv2 视觉向量检索，负责不同背景、不同构图、不同光影下的相似物品召回。第三层新增颜色、形状、局部特征、OCR 等候选精排能力，负责减少“同类但非同款”的误匹配。

请新增以下模块，但必须保持可插拔、可关闭、可降级：

1. modelService
   负责管理本地视觉模型状态，包括模型是否已下载、模型版本、模型路径、模型许可证信息、模型加载状态、模型卸载、模型更新检查。默认不要把模型权重打包进 GitHub 源码仓库。源码仓库只提供模型下载脚本、manifest、校验逻辑和许可证说明。模型目录默认为用户数据目录下的 models/。模型下载完成后必须校验 sha256。若模型不存在，UI 显示“未安装向量模型”，Hash 搜索仍可正常使用。

2. embeddingService
   负责对图片生成视觉向量。默认预留 DINOv2 ViT-B/14，输出 768 维 global embedding。第一版只实现 global embedding，后续预留 object_crop embedding。输入图片需要统一预处理到 224 或 336 尺寸，保存 modelName、modelVersion、embeddingType、dim、createdAt。embedding 生成必须在 worker 或独立进程中执行，不能阻塞 Electron main 线程。

3. embeddingWorker
   负责后台批量生成 embedding。它从任务队列读取 imageId/path，生成向量后写入向量存储。需要支持 pause/resume/stop、失败重试、跳过损坏图片、模型未安装时跳过、断点续建库。embeddingWorker 不能影响现有 hashWorker / fast_scanner 扫描流程。Hash 索引优先完成，向量索引可以后台慢慢补齐。

4. vectorDatabaseService
   负责保存 embedding 元数据和向量文件索引。请新增 SQLite 表或本地二进制向量文件管理，至少包含 image_id、model_name、model_version、embedding_type、dim、vector_path 或 vector_blob、norm、created_at、updated_at、status。需要支持模型版本升级后重建指定模型的 embedding。

5. vectorIndexService
   负责向量索引加载、增量插入、删除、重建和检索。第一版可以优先选择 hnswlib 或 FAISS；如果当前 Electron 打包不方便，可先实现轻量内存向量索引作为 POC，但接口必须抽象为 VectorIndexProvider。检索使用 cosine similarity，返回 imageId、vectorScore、modelName、embeddingType。向量索引必须和现有 Hash Index 解耦，Hash 搜索可独立运行。

6. objectCropService
   第一版只预留接口，不强制实现复杂目标检测。可以先支持 center crop、透明背景 bounding box、手动 crop 元数据。后续再接 YOLO / Segment Anything / saliency crop。数据库需要预留 object_crops 表，包括 image_id、crop_type、x、y、w、h、confidence、source、created_at。后续 object_crop embedding 用于提升物品级匹配准确率。

7. rerankService
   负责第三层候选精排。输入为 Hash TopK + Vector TopK 合并后的候选 imageId，输出最终 TopK。第三层只能对候选集执行，禁止全库扫描。第一版优先实现 colorScore 和 shapeScore；localFeatureScore 和 ocrScore 作为后续插件预留。

8. colorFeatureService
   负责提取颜色特征。第一版使用 HSV 或 Lab color histogram，可对整图或主体 crop 计算。需要保存 image_color_features 表，包括 image_id、feature_type、color_hist、dominant_colors、created_at、updated_at。颜色分数主要用于区分黑色、白色、粉色等同款不同色产品，适合平板保护壳、电商产品图、包包、支架类图片。

9. shapeFeatureService
   负责提取形状和比例特征。第一版保存 aspectRatio、objectAreaRatio、edgeDensity、bboxWidth、bboxHeight 等字段。shapeScore 用于判断主体比例、产品轮廓、矩形产品相似度，适合平板、手机、保护壳、支架、包装盒类图片。

10. localFeatureService 和 ocrService
    暂时只做接口和任务类型预留，不作为第一版强制交付。localFeatureService 后续可用 ORB/SIFT 对 Top50 候选做局部结构验证；ocrService 后续可对包装文字、品牌、型号做精排。二者禁止默认全库执行，必须按需、低优先级、候选集内运行。

搜索模式需要扩展为三种：

快速模式：
只走现有 fast_scanner Hash Retrieval。使用 DiffHash / DCT / existing searchByImageAsync，适合重复图和近重复图，必须保持毫秒级响应。

标准模式：
Hash Top100 + Vector Top200。查询图片先生成 Hash，调用现有 fast_scanner 召回近重复候选；再生成 DINOv2 global embedding，通过 vectorIndexService 召回视觉相似候选；合并去重后按 hashScore 和 vectorScore 初步排序。

精准模式：
Hash Top100 + Vector Top200 + Rerank TopK。合并候选后进入 rerankService，计算 colorScore、shapeScore，后续可选 localFeatureScore、ocrScore，最终生成 finalScore 和 reasons。

推荐 finalScore 第一版公式：
finalScore =
0.45 * vectorScore

* 0.15 * hashScore
* 0.20 * colorScore
* 0.20 * shapeScore

如果某个分数不存在，需要动态归一化权重，不能因为缺失 OCR/ORB 导致结果异常。

搜索结果结构需要扩展：
{
imageId,
path,
thumbPath,
finalScore,
hashScore,
vectorScore,
colorScore,
shapeScore,
localFeatureScore,
ocrScore,
diffDistance,
dctDistance,
phashDistance,
dhashDistance,
matchLevel,
reasons,
indexSources
}

matchLevel 可包含：
exact、near_duplicate、same_product、similar_product、weak。

reasons 示例：
“Hash 高度相似”
“DINOv2 视觉向量高度相似”
“主体颜色接近”
“主体比例接近”
“DCT 精排一致”
“模型未安装，仅使用 Hash 搜索”

数据库需要新增或扩展：
image_embeddings
embedding_jobs
object_crops
image_color_features
image_shape_features
model_registry
vector_index_manifest

请注意和当前 segment mmap 架构的关系：

1. 现有 fast_scanner segment v4 继续只负责 Hash 层，不要把 DINOv2 embedding 强行塞进现有 .idx segment。
2. 向量索引单独存储，建议在 index/vector/ 目录下维护自己的 manifest。
3. Hash index、Vector index、Rerank features 都通过 imageId/path 关联。
4. deleted / replaced / overlay tombstone 状态必须同步影响向量索引和精排特征，已删除或被替换路径不能出现在最终结果里。
5. compactManifestAsync 不负责压缩向量索引，向量索引需要自己的 rebuild/compact 机制。
6. 现有 searchByImageAsync 不要破坏，新增 searchByImageAdvanced 或 searchByImageLayered。

UI 需要增加：

1. ImageSearch 面板中增加搜索模式：快速 / 标准 / 精准。
2. 增加“向量模型状态”：未安装 / 下载中 / 可用 / 加载中 / 已加载 / 错误。
3. 增加“下载模型”按钮，但不要默认自动下载大模型。
4. 增加“构建向量索引”按钮和进度显示。
5. 结果卡片增加 finalScore、hashScore、vectorScore、colorScore、shapeScore 展示开关。
6. 如果模型未安装，标准/精准模式需要提示降级到快速模式，而不是报错。
7. 设置页增加是否启用 Vector Retrieval、是否启用 Rerank、模型目录、最大并发、GPU/CPU 后端占位设置。

开源和打包要求：

1. GitHub 源码仓库不要提交 .pt、.pth、.onnx、.safetensors、.bin 等模型权重。
2. models/ 目录只保留 .gitkeep。
3. 提供 scripts/download-models.ts 和 models/manifest.json。
4. 提供 THIRD_PARTY_NOTICES.md，说明 DINOv2 主模型、CLIP/OpenCLIP 可选模型及其许可证。
5. 默认只允许商业友好模型进入内置下载白名单。
6. 非商业、研究用途或许可证不明的模型不能默认出现在商业构建下载列表里。
7. electron-builder 打包时不要把用户下载的 models/ 缓存打入安装包。

性能要求：

1. Hash 层仍然优先，不能因为 embedding 队列未完成影响原有近重复搜索。
2. embedding 建库必须后台低优先级运行。
3. 查询时如果 query embedding 生成超过超时阈值，应返回 Hash 结果并提示 Vector timeout。
4. 向量索引加载失败时降级到 Hash 搜索。
5. 所有耗时任务必须使用 worker/job queue，不能阻塞 Electron main 线程。
6. 需要保留现有 async N-API 的主线程不卡顿优势。

验收标准：

1. 原有 0.4.3 fast_scanner 测试全部通过。
2. 原有 Duplicate Finder 面板不受影响。
3. 未安装模型时，快速模式正常搜索。
4. 安装模型后，标准模式可以返回 Hash + Vector 合并结果。
5. 精准模式可以返回 colorScore / shapeScore / finalScore / reasons。
6. 删除文件、修改文件、rename、overlay tombstone 后，向量结果不会返回失效路径。
7. 模型下载失败、校验失败、加载失败都有明确错误状态和 UI 提示。
8. 架构保持模块化，后续可以继续接 object crop embedding、OCR、ORB/SIFT、CLIP、Qdrant，而不需要重构第一层 Hash 引擎。
2026-06-27 扣分点优化进度更新：

本轮继续自动完成可闭环的剩余扣分点，重点落在 Image Search 的向量索引性能和 shape 主体估计稳定性。

已完成：
1. `MemoryVectorIndex` 已从单纯线性扫描升级为混合索引：
   - 10,000 条以内继续使用精确 cosine scan，保证中小图库结果稳定。
   - 超过 10,000 条时使用 deterministic random projection LSH 生成候选。
   - 候选不足时自动回退全量精确扫描，优先保护召回率。
   - `VectorIndexManifest.indexType` 增加 `memory_lsh`。
2. `shapeFeatureService` 增强主体 bbox：
   - 透明背景图片优先使用 alpha 通道识别前景主体。
   - alpha 不适用时回退灰度背景差估计。
   - 继续输出 aspectRatio、objectAreaRatio、bboxWidth、bboxHeight、edgeDensity。
3. 保持此前已经完成的真实链路：
   - DINOv2 q4 ONNX 真实 768 维 embedding。
   - precise 模式真实 colorScore / shapeScore。
   - fast 模式仍保持 fast_scanner Hash 搜索，不受模型和向量索引影响。

验证结果：
1. `npm.cmd run typecheck`：通过。
2. `npm.cmd run format:check`：通过。
3. `npm.cmd run test:vector-pipeline`：通过，12 passed。
4. `npm.cmd run build`：通过，renderer/main/preload/worker/native/electron-builder/NSIS 全链路通过。
5. `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

当前完成度：
94 / 100。

剩余扣分点：
1. 真实图库 TopK 质量评估尚未完成，需要固定样本集统计召回率、误匹配率、耗时和内存。
2. 主体定位仍是轻量启发式，复杂背景、多主体、低对比物体仍建议后续接入 object crop / saliency / YOLO / SAM。
3. `memory_lsh` 已优于纯线性扫描，但仍不是 hnswlib/FAISS 级持久化 ANN；十万到百万级图库建议继续接独立 ANN provider。
4. Electron UI 自动化仍未建立，Image Search 面板点击流、模型下载失败、降级提示仍需自动化或人工回归。

发布判断：
可进入内部测试；暂不建议 RC 或正式发布。

2026-06-27 进度补充：
1. Image Search 已新增剪贴板截图粘贴搜索入口，支持 `Paste` 按钮和 `Ctrl+V`。
2. 结果区缩略图已改为批量加载，并统一走图片缩略图生成逻辑，滚动时更稳定。
3. 精准模式结果的 `Open` / `Folder` / `Copy` 已优先使用真实文件路径，避免部分目标打不开的问题。

2026-06-28 语义搜索进度补充：
1. Image Search 已新增 `Semantic` 文本搜索入口，支持输入关键词搜索已索引图片。
2. 当前实现优先使用文件名/路径/扩展名/常见中英文同义词相关性评分，结果复用现有缩略图和打开文件操作。
3. 语义候选已改为读取当前 `image-search-index` manifest / segment 路径，不再只依赖 embedding job 数据。
4. 文件名/路径无命中时，会自动使用 `Xenova/clip-vit-base-patch32` zero-shot image classification 对最多 768 张均匀抽样候选做文本-图片语义评分。
5. 当前限制：CLIP 当前为抽样 zero-shot 回退，不是全量 CLIP image embedding ANN 索引；十万级图库稳定语义召回仍建议后续增加独立的 CLIP embedding 构建与索引。
6. 验证：`npm.cmd run typecheck`、`npm.cmd run format:check`、`npm.cmd run build:renderer` 均通过。
2026-06-28 Image Search 功能审计与修复补充：

本轮审计范围：
1. Image Search 面板交互、结果布局、缩略图复用链路。
2. Semantic 文本搜图、CLIP zero-shot fallback、GPU/CPU 设备回退。
3. 大索引 manifest / segment 读取性能。
4. 现有构建、类型检查、格式检查和 Vector pipeline 测试。

已完成修复：
1. `electron/semanticSearchService.ts` 已重写为干净 UTF-8 版本，清除语义搜索结果原因中的乱码文案。
2. 语义搜索读取 `.idx` segment 时不再 `readFileSync` 整段加载文件，改为按 header、path offset table、path bytes 分段读取，降低大索引下内存占用和卡顿风险。
3. 中文语义词增加英文 CLIP label 映射，例如：猫/cat、狗/dog、女人/woman、二次元/anime、截图/screenshot、头像/avatar、壁纸/wallpaper 等。中文无文件名命中时，CLIP fallback 不再直接把中文原词丢给英文 CLIP。
4. 路径/文件名语义匹配保留中文同义词扩展，并将返回 reasons 改为稳定 ASCII 文案，避免 UI 显示乱码。
5. Image Search 结果网格从固定 `minmax(360px, 1fr)` 调整为 `minmax(min(360px, 100%), 1fr)`，小窗口下不再因为两列布局产生横向溢出。

验证结果：
1. `npm.cmd run typecheck`：通过。
2. `npm.cmd run format:check`：通过。
3. `npm.cmd run build:renderer`：通过，已更新 `dist` 和 `dist-electron`。
4. `npm.cmd run test:vector-pipeline`：通过，12 项测试通过。

当前完成度评估：
96 / 100。

仍保留的扣分点：
1. CLIP 当前仍是 zero-shot 抽样 fallback，不是全量 CLIP embedding ANN 索引；十万级图库要稳定语义召回，后续仍建议增加独立 CLIP embedding 构建和 ANN 检索。
2. Electron UI 自动化回归尚未建立，窗口层级、透明窗口、拖拽、截图粘贴、缩略图滚动加载仍主要依赖人工回归。
3. 真实图库 TopK 质量基准仍未完成，需要固定样本集统计 fast / standard / precise / semantic 的召回率、误匹配率、耗时和内存。

2026-06-28 Image Search 交互修复补充：

1. 查询图片路径输入框是只读显示字段，用户无法用键盘直接删除；现已新增 `Clear` 按钮，可清空当前查询图片路径、查询 hash、结果列表、分层结果和搜索统计。
2. 结果区新增 `View` 模式切换：
   - `List`：保留原紧凑两列/多列结果。
   - `Large`：使用大图卡片，缩略图放大到 150px，`Open` / `Folder` / `Copy` 按钮放到图片/信息下方，不再占据图片右侧空间。
3. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Build Embeddings 当前路径修复：

1. 修复 `Build Embeddings` 仍使用上次 embedding job 队列的问题。
2. 后端 `startEmbeddingBuild` 现在在收到 `scanPaths` 时，会优先枚举当前 Image Search 面板选中的 Scan Paths，并只为这些当前路径生成 embedding 任务。
3. 旧的 `embedding_jobs.jsonl` 只在没有传入 `scanPaths` 时作为 fallback 使用，不再覆盖当前盘符选择。
4. 如果当前选中路径下图片已经全部存在 embedding，会返回完成状态并显示 skipped，避免继续处理旧目录。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 以图搜图大 embedding 崩溃修复：

1. 审计结论：
   - `Build Embeddings` 中的 fail 主要表示部分图片解码失败或文件不可读，不是以图搜图崩溃的直接原因。
   - 当前本机 `image_embeddings.jsonl` 约 3.4GB，而旧版 `searchVectorIndex` 会在无内存索引时调用 `getEmbeddingsByModel()` 全量读取并解析 JSONL。
   - 这会导致 Electron 主进程内存暴涨，以图搜图在 `standard` / `precise` 模式下崩溃。
2. 已完成修复：
   - `vectorIndexService` 检测到 embedding JSONL 超过 512MB 时，不再尝试全量加载内存索引。
   - 新增流式向量检索：逐行读取 `image_embeddings.jsonl`，边解析边计算 cosine similarity，并只保留 TopK。
   - 所有 embedding 都能参与以图搜图向量检索，但内存占用保持受控。
   - `Build Index` 遇到超大 JSONL 时不再强行构建内存索引，而是返回说明，提示当前使用 streaming vector search，后续需要持久化 ANN。
3. 当前状态：
   - 以图搜图不应再因 3.4GB embedding 文件全量加载而崩溃。
   - 流式检索比内存 ANN 慢，但优先保证全量参与和稳定性。
   - 后续要提升速度，需要实现持久化 ANN 索引，而不是内存 JSONL 索引。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic Search 结果数量与统计修复：

1. 修复 Top=200 但只返回十几个且数字含义不清的问题：
   - 后端新增 `matchedCandidates`、`returnedCount`、`fallbackCount`。
   - 前端统计区改为显示 `Scan`、`Cand`、`Returned`、`Fallback`。
   - `Cand` 表示 filename/path 匹配到的候选数，`Returned` 表示最终返回结果数。
2. 修复 CLIP fallback 抽样过少：
   - fallback 抽样数从固定 64 改为至少覆盖 TopK，最多 512。
   - Top=200 时 CLIP fallback 可抽样 200 张补充，而不是只抽 64 张。
3. 修复分数尺度混用：
   - CLIP fallback 结果分数上限限制为 0.49，避免抽样结果压过 filename/path 明确命中。
4. 限制说明：
   - 这仍不是完整全库 CLIP embedding 语义检索。
   - 若 filename/path 命中很少，fallback 能补充但仍是抽样；完整能力仍需 CLIP image/text embedding ANN。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 查询路径与语义结果补充修复：

1. 修复 Paste 后查询路径再次删不掉的问题：
   - 查询图片路径输入框从只读改为可编辑。
   - 用户把该输入框删空时，会自动清空当前查询路径、hash、结果列表和搜索统计。
   - 手动输入/修改路径后按 Enter 可重新以该路径搜索。
2. 修复语义搜索只返回少量 filename/path 命中后就停止的问题：
   - 旧逻辑只有在 filename/path 结果为 0 时才跑 CLIP fallback。
   - 新逻辑在 filename/path 结果不足 TopK 时，也会使用 CLIP fallback 补充候选。
3. 限制说明：
   - CLIP fallback 仍是抽样补充，不是完整全库 CLIP embedding 检索。
   - 真正完整的“语义所有图片”仍需要新增 CLIP image/text embedding 构建和 ANN 索引。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic Search 逻辑完整性审计：

1. 审计结论：
   - 当前 `Semantic` 并不是完整的全库 CLIP 语义检索。
   - 当前链路为：filename/path semantic scoring 优先；无命中时进入 CLIP zero-shot fallback。
   - CLIP fallback 只抽样少量候选，不会遍历全部图片，因此不能保证返回全库最相关结果。
2. “总是那几个图片”的根因：
   - 旧版 CLIP fallback 使用固定步长抽样 64 张图片。
   - 当 filename/path 没有命中时，不同查询词会进入几乎相同的固定样本集合，因此结果看起来始终是那几张。
3. 已完成可闭环修复：
   - CLIP fallback 抽样改为基于查询词的确定性随机抽样。
   - 不同语义词会抽到不同候选集合，减少固定样本导致的重复结果。
4. 当前功能完整性状态：
   - filename/path semantic：可用，覆盖全部 Image Search 索引路径。
   - CLIP zero-shot fallback：仅兜底，可用但不完整。
   - 全库文本-图片语义检索：未完成，需要新增 CLIP image/text embedding 构建、持久化索引和 ANN 检索。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic Search 大图库崩溃保护：

1. 崩溃原因判断：
   - 当前机器 `image_embeddings.jsonl` 已达到约 3.4GB。
   - 旧版语义搜索会调用 `embeddingStore.getAll()` / `jobStore.getAll()`，可能在 Electron 主进程一次性读取并解析超大 JSONL，导致内存暴涨或主进程崩溃。
   - 文件名/路径无命中时，旧版 CLIP fallback 最多抽样 768 张，并可能走 DirectML，图库很大时也有崩溃风险。
2. 已完成修复：
   - `semanticSearchService` 不再读取 `image_embeddings.jsonl` 和 `embedding_jobs.jsonl`。
   - 语义搜索候选只从 Image Search 的 `image-search-index/manifest.json` 和 segment 路径区读取。
   - 单次语义搜索候选上限为 120,000，超出时返回 degraded 提示，避免主进程卡死。
   - 移除对所有候选路径逐个 `existsSync` 的同步检查，只在最终结果或 CLIP 抽样阶段检查少量路径。
   - CLIP fallback 改为安全模式：默认 CPU，最多抽样 64 张，避免 GPU/DirectML native 崩溃。
3. 当前结论：
   - 大图库语义搜索可以继续使用，但当前仍是“文件名/路径语义优先 + 小样本 CLIP fallback”。
   - 若目标是 30 万以上图片稳定语义召回，后续应实现独立 CLIP embedding ANN 索引，不能依赖 zero-shot 抽样。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic Search 返回数量优化：

1. 现象：用户反馈“似乎没有匹配所有的结果”。
2. 原因：语义搜索结果仍受 `Top` 限制，UI 最高只有 200，后端也把 `topK` 限制为 200；即使更多路径命中，也只返回前 200。
3. 已调整：
   - UI `Top` 选项新增 500、1000。
   - 后端 semantic `topK` 上限从 200 提升到 1000。
4. 范围说明：
   - filename/path semantic scoring 会遍历当前 Image Search 索引路径。
   - 返回数量仍由 `Top` 控制，避免一次渲染过多缩略图导致 UI 卡顿。
   - CLIP zero-shot fallback 仍是小样本兜底，不代表全量 CLIP embedding 检索。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic CLIP GPU 加速补充：

1. `semanticSearchService` 的 CLIP zero-shot fallback 已重新接入 GPU 设置：
   - 当 `vector-settings.json` 中 `backend` 为 `gpu` 时，Windows 使用 DirectML 设备 `dml`。
   - 其他平台使用 `gpu`。
   - GPU 加载或推理失败时自动回退 CPU。
2. 结果 reasons 会显示实际设备，例如 `CLIP DML visual semantic match cat` 或 `CLIP CPU ...`。
3. 当前 GPU 加速只作用于 CLIP fallback 阶段；filename/path semantic scoring 本身是字符串匹配，不需要 GPU。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic Search 全索引候选优化：

1. 用户反馈需要所有索引数据参与语义搜索，不希望出现 120,000 candidate cap。
2. 已调整：
   - 文件名/路径语义搜索候选上限从 120,000 提高到 1,000,000。
   - 当前 16-30 万级 Image Search 索引会全部进入 filename/path semantic scoring。
   - 仍然不读取 3.4GB `image_embeddings.jsonl`，避免 Electron 主进程崩溃。
   - CLIP zero-shot fallback 继续保持安全抽样 64 张，避免无索引的临时视觉文本分类拖垮主进程。
3. 重要说明：
   - 当前 `Build Embeddings` 生成的是 DINOv2 image embedding，适合以图搜图，不是文本-图片同空间 embedding。
   - 要让“所有 embedding”真正参与文本语义搜索，需要后续新增 CLIP image/text embedding 构建和 ANN 索引；不能直接用 DINOv2 image embedding 和文本查询做余弦相似。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Refresh TopK 仍固定 50 修复：

1. 修复设置 Top=200 后点击查询区 Refresh 仍只输出 50 个结果的问题。
2. 根因：
   - 图搜图的 Standard / Precise layered search 前端传参中 `rerankTopK` 被硬编码为 50。
   - 查询区 Refresh 优先判断 `testImagePath`，做过 Paste 后即使当前在跑 Semantic，也可能刷新回图搜图。
3. 已完成修复：
   - `rerankTopK` 改为使用当前 UI 的 `Top` 值。
   - `hashTopK` 和 `vectorTopK` 按当前 `Top` 放大候选池，避免候选不足导致最终结果少于目标数量。
   - 新增 `lastQueryKind`，Refresh 会按上一次实际搜索类型刷新；Semantic 搜索不会被残留的 Paste 图片路径抢走。
   - 普通图搜图和 layered 图搜图统计区新增 `Returned`，方便确认实际返回数量。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic CLIP fallback 准确性修复：

1. 用户反馈：`Semantic cow` 返回大量与牛无关的图片；以图搜图结果相对可用。
2. 根因：
   - 旧版 CLIP fallback 只用目标词、`not 目标词`、`document`、`landscape` 等少量标签分类。
   - CLIP 被迫在很少的标签中选择，导致不相关图片也可能拿到较高分，并被 0.49 封顶后排在前面。
3. 已完成修复：
   - 新增牛、马、鸟等基础动物中英文语义词。
   - CLIP fallback 改为“目标词 + 常见竞争类别”一起分类，例如 person / woman / cat / dog / cow / horse / document / cartoon 等。
   - 目标类别必须是 CLIP 第一名，并且与其他类别有分差，才会进入 fallback 结果。
   - reasons 中显示 CLIP 目标标签、置信度和 margin，方便判断误判来源。
4. 预期变化：
   - 结果会比之前少，但相关性应更高。
   - 如果图库抽样中没有真正相关图片，`Returned` 可能低于 `Top`，这是正常的质量过滤结果。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Semantic 全库 CLIP embedding 检索落地：

1. 用户反馈：
   - `woman` / `girl` / `leg` 等语义词返回太少。
   - 全盘实际有大量相关图片，但当前 Semantic 只返回十几张，且精准度仍不稳定。
2. 根因确认：
   - 旧 Semantic 不是完整文本搜图，而是 filename/path 命中 + CLIP zero-shot 抽样 fallback。
   - zero-shot fallback 只抽样少量图片，无法覆盖全库；DINOv2 embedding 只适合以图搜图，不能直接拿文本查询。
3. 已完成实现：
   - 新增模型 `clip_vit_base_patch32` 到 `models/manifest.json`，复用本机已下载的 `Xenova/clip-vit-base-patch32/onnx/model_q4.onnx`。
   - `embeddingWorker` 新增 CLIP image embedding 分支，生成 512 维图文同空间向量。
   - Image Search 面板新增 `Build CLIP` 按钮，用于给当前 Scan Paths 构建 CLIP 图片向量。
   - Semantic 搜索优先使用 CLIP text embedding 扫描已有 CLIP image embeddings；没有 CLIP 向量时才回退旧逻辑。
   - CLIP semantic 检索使用流式扫描 `image_embeddings.jsonl`，避免一次性加载超大 JSONL。
4. 使用方式：
   - 先选择 Scan Paths。
   - 点击 `Build CLIP`，等待完成。
   - 再使用 `Semantic` 搜索 `woman` / `girl` / `leg` 等文本。
5. 限制：
   - 首次 Build CLIP 会重新为图片生成一套 CLIP 向量，耗时和磁盘占用都会增加。
   - 英文 CLIP 对中文词仍有限制，中文词会依赖映射；英文查询通常更稳。
6. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 CLIP 模型安装路径修复：

1. 用户反馈点击 `Build CLIP` 提示 `Model not ready: not-installed`。
2. 根因：
   - 本机已有 `Xenova/clip-vit-base-patch32` 模型缓存。
   - 新模型清单要求安装路径为 `models/clip_vit_base_patch32/Xenova/clip-vit-base-patch32/...`。
   - 旧缓存位于 `models/Xenova/clip-vit-base-patch32/...`，因此 `modelService` 判定为未安装。
3. 已完成：
   - 将本机已有 CLIP 模型文件复制到标准安装目录。
   - 校验 `onnx/model_q4.onnx` SHA-256 为 `1f518bedb1851294737a141e06149883cb289160760224f2da5498886e49d5cb`，与清单一致。
   - `semanticSearchService` 已兼容标准安装目录和旧缓存目录。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Build CLIP 崩溃保护：

1. 用户反馈点击 `Build CLIP` 后软件崩溃。
2. 风险点：
   - CLIP q4 ONNX 模型明显大于 DINOv2 q4，多个 worker 同时加载会增加内存和 DirectML/native 崩溃概率。
   - worker 异常退出时，旧逻辑没有把当前任务记为失败，可能导致进度状态异常或反复重启 worker。
3. 已完成修复：
   - `clip_vit_base_patch32` 构建强制使用 CPU backend。
   - `clip_vit_base_patch32` 构建强制单 worker 并发，优先保证稳定。
   - worker `error` / `exit` 时会将当前任务记为失败并继续，不再让进度挂死。
4. 说明：
   - Build CLIP 会比 DINO 构建慢，但稳定性优先。
   - 后续如需 GPU 加速，应单独实现批处理、显存检测和 DirectML 崩溃隔离。
5. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。

2026-06-28 Build CLIP native 崩溃隔离：

1. 用户反馈：CPU 单并发后，点击 `Build CLIP` 仍会导致主程序崩溃。
2. 结论：
   - 崩溃不是普通 JS 异常，而是 ONNX / native runtime 在 worker thread 内崩溃。
   - Worker thread 与主进程共享同一进程地址空间，native crash 仍会带崩 Electron 主程序。
3. 已完成修复：
   - 新增 `electron/clipEmbeddingChild.ts`，CLIP 模型加载和图片向量生成改到独立子进程执行。
   - `embeddingService` 中 `clip_vit_base_patch32` 不再走 worker thread，改为串行 child process 构建。
   - 子进程崩溃时，主进程记录当前图片失败；连续崩溃 3 次会停止 Build CLIP，并给出错误状态。
   - `package.json` 和 `vite.config.mjs` 已加入 `clipEmbeddingChild.js` 打包配置。
   - 已将 `clipEmbeddingChild.js` 同步到 `release/win-unpacked/resources`。
4. 已验证：
   - 单独运行 `dist-electron/clipEmbeddingChild.js` 可对测试图片返回 512 维 CLIP 向量。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。
   - `npm.cmd run build`：通过，已更新 `release/win-unpacked` 和安装包。

2026-06-28 Build CLIP 大 JSONL OOM 崩溃修复：

1. 用户反馈：改成 child process 后点击 `Build CLIP` 仍会崩溃。
2. 新根因：
   - 本机 `vector-db/image_embeddings.jsonl` 已达到约 3.47GB。
   - `startEmbeddingBuild` 启动时通过 `embeddingStore.getAll()` 全量读取已有 embedding ID。
   - `upsertEmbedding` 每写入一张 CLIP 向量也会通过 `getEmbedding` / `find` 触发全表加载。
   - 因此即使 CLIP 推理已经隔离到子进程，主进程仍可能因为 3GB+ JSONL 全量解析而 OOM 崩溃。
3. 已完成修复：
   - `clip_vit_base_patch32` 构建启动时改为流式读取 `image_embeddings.jsonl`，只收集当前模型的已存在 `imageId`。
   - `clip_vit_base_patch32` 构建不再调用 `seedEmbeddingJobs`，避免间接触发 `embeddingStore.getAll()`。
   - 新增 `appendEmbeddingNoUpsert`，CLIP 向量写入改为 append-only JSONL，不再每张图片做全表 upsert。
   - DINOv2 原链路保持不变。
4. 已验证：
   - 当前 `image_embeddings.jsonl` 大小约 3.47GB。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。
   - `npm.cmd run build`：通过，已更新 `release/win-unpacked` 和安装包。

2026-06-28 Build CLIP GPU 加速：

1. 新增 `Build CLIP GPU` 按钮。
2. GPU 模式仍在 `clipEmbeddingChild` 独立子进程内执行，Windows 使用 DirectML (`dml`)。
3. 普通 `Build CLIP` 保留原路径；`Build CLIP GPU` 会显式传入 `backend: gpu`。
4. 子进程任务协议新增 `backend` 字段，CLIP 模型按 `cpu` / `gpu` 分别加载 runtime。
5. 已验证：
   - 单独运行 `dist-electron/clipEmbeddingChild.js`，传入 `backend: gpu` 可对测试图片返回 512 维 CLIP 向量。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。
   - `npm.cmd run build`：通过，已更新 `release/win-unpacked` 和安装包。

2026-06-28 Build CLIP GPU 利用率优化：

1. 用户反馈：`Build CLIP GPU` 时 GPU 利用率不高。
2. 原因：
   - 单张图片串行推理会被 CPU 图片解码、预处理和 IPC 等步骤限制。
   - 移动端 RTX 3050 在单任务小 batch 下很难跑满。
3. 已完成：
   - GPU 模式下 `clip_vit_base_patch32` 构建并发从 1 提升到最多 2 个独立 `clipEmbeddingChild` 子进程。
   - CPU 模式仍保持单子进程，避免 CPU 内存压力过大。
   - 每个 GPU 子进程仍独立隔离；任一子进程崩溃不会直接带崩主程序。
4. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。
   - `npm.cmd run build`：通过，已更新 `release/win-unpacked` 和安装包。

2026-06-28 Image Search 刷新与隐藏保活补充：

1. 新增 `Refresh` 搜索按钮：
   - 当前有查询图片时，按最新 `Thr` / `Top` / `Search` 参数重新执行图片搜索。
   - 当前没有查询图片但有 `Semantic` 文本时，重新执行语义搜索。
   - 没有查询条件时按钮禁用，避免误操作。
2. 修复 `Ctrl+Shift+Alt+Q` 全局隐藏后 Image Search 结果丢失：
   - Image Search 现在和 File Manager 等面板一致，全局隐藏时保持组件挂载，仅通过 `display:none` 隐藏。
   - 重新显示后保留当前查询图片、语义文本、结果列表、搜索统计和视图模式。
3. 已验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build:renderer`：通过。
2026-06-28 Build CLIP GPU 并发与 ETA 优化：

1. 用户反馈：
   - `Build CLIP GPU` 时 RTX 3050 Laptop GPU 利用率仍偏低，希望优先提高吞吐，不怕高占用导致临时卡顿。
   - 构建过程缺少预计剩余时间，无法判断还要跑多久。
2. 已完成调整：
   - GPU 模式下 `clip_vit_base_patch32` 构建并发从 2 个独立 `clipEmbeddingChild` 子进程提升到 4 个。
   - CPU 模式仍保持单子进程，避免 CPU/内存压力过大。
   - `EmbeddingProgress` 新增 `startedAt`、`elapsedMs`、`itemsPerSecond`、`etaMs` 字段。
   - 后端统一在 `updateProgress` 内计算实时速度和 ETA，失败、跳过、完成任务都会计入进度。
   - Image Search 面板的 Emb 进度条旁新增 `x.xx/s` 和 `ETA` 显示，鼠标悬停可看到 running、pending、elapsed 等详细信息。
3. 说明：
   - 4 路并发会显著增加 GPU/显存/CPU 图片解码压力，目标是提高利用率。
   - 实际 GPU 利用率仍受图片读取、解码、预处理、DirectML 调度影响，不保证稳定 90%。
   - 如果后续出现明显卡死、显存不足或子进程连续崩溃，可以再把 GPU 并发降回 2 或改成可配置项。
2026-06-28 Build CLIP GPU 并发继续提升：

1. 用户实测：
   - GPU 平均利用率约 75%，运行稳定，希望继续提高占用。
2. 已完成调整：
   - `Build CLIP GPU` 的 CLIP 子进程并发从 4 提升到 6。
   - 继续保留独立子进程隔离，单个 CLIP 子进程崩溃不会直接带崩主进程。
3. 风险说明：
   - 6 路并发会进一步增加显存、内存、CPU 图片解码和磁盘读取压力。
   - 如果出现明显卡顿、温度过高、失败数异常增加或连续子进程崩溃，应回调到 4。
2026-06-28 Image Search CLIP GPU 路数窗口可调：

1. 用户反馈：
   - GPU 平均利用率约 79%，仍希望继续提高。
   - 希望不要每次改代码，直接在窗口上调整 GPU 并发路数。
2. 已完成调整：
   - Image Search 面板新增 `GPU Jobs` 选择框，位于 `Build CLIP GPU` 旁边。
   - 可选路数：2 / 4 / 6 / 8 / 10 / 12。
   - 默认值为 6，并写入 `localStorage`，下次打开仍保留上次选择。
   - 点击 `Build CLIP GPU` 时会把当前 `GPU Jobs` 作为 `maxConcurrentEmbeddings` 传给后端。
   - 后端不再使用固定常量，GPU 模式按请求参数设置并发，最高限制 12。
3. 使用建议：
   - 当前 6 路约 79%，可先试 8。
   - 如果 GPU 温度超过 88-90 摄氏度、失败数增加或软件明显卡顿，再降回 6 或 4。
2026-06-28 Build Embeddings GPU 加速：

1. 用户需求：
   - 普通 `Build Embeddings` 也要像 `Build CLIP GPU` 一样支持 GPU 加速和窗口内路数调整。
2. 已完成调整：
   - Image Search 面板新增 `Build Embeddings GPU` 按钮，用于 DINOv2 embedding 的 GPU/DirectML 构建。
   - `GPU Jobs` 从 CLIP 专用改为通用控制，同时作用于 `Build Embeddings GPU` 和 `Build CLIP GPU`。
   - 后端 DINOv2 GPU 构建会读取 `maxConcurrentEmbeddings`，GPU 模式最高允许 12 路。
   - CPU 普通构建仍保留原行为，避免默认高并发压垮 CPU/内存。
3. 使用建议：
   - DINOv2 GPU 可先使用 6 或 8 路测试。
   - 如果失败数增加、温度过高或 UI 卡顿，降低 `GPU Jobs`。
2026-06-28 模型目录迁移到软件目录：

1. 用户需求：
   - 模型不要继续放在 Roaming 用户数据目录，改为软件目录内专门的模型文件夹。
2. 已完成调整：
   - 新增软件内模型目录 `ai-models`。
   - 开发运行路径：项目根目录 `ai-models`。
   - 打包运行路径：`release/win-unpacked/resources/ai-models`。
   - `modelService` 的下载、校验、删除、installedPath 全部改为使用统一的 `getModelStorageDir()`。
   - `semanticSearchService` 的 CLIP text embedding 和 zero-shot fallback 改为读取同一个 `ai-models`。
   - 保留旧 Roaming `models` 路径作为 CLIP 兼容 fallback，避免迁移过程模型短暂不可用。
   - `package.json` 增加 `models` 与 `ai-models` 到 `extraResources`，打包版会携带 manifest 和本地模型权重。
3. 已迁移现有模型：
   - `dinov2_vitb14`：约 53.82 MB。
   - `clip_vit_base_patch32`：约 184.08 MB。
   - 旧兼容缓存 `Xenova`：约 184.08 MB。
4. 说明：
   - 迁移后新增下载的模型会写入软件目录内 `ai-models`。
   - Roaming 中旧模型暂未删除，确认新版稳定后可再清理重复缓存。
2026-06-29 Semantic CLIP 文本模型修复：

1. 用户反馈：
   - Semantic 搜索 `girl` 顶部报错：`Missing the following inputs: pixel_values`。
   - Top=50 只返回 2 张图，说明完整 CLIP embedding 搜索失败后回退到了 filename/path/fallback。
2. 根因：
   - 文本语义搜索使用了完整 `CLIPModel` 直接执行文本输入。
   - 完整 CLIP 模型需要同时具备图像输入 `pixel_values`，只传文本会报错。
   - 当前 `ai-models` 中只有完整 `model_q4.onnx`，缺少文本侧 `text_model_q4.onnx`。
3. 已完成修复：
   - `semanticSearchService` 改用 `CLIPTextModelWithProjection` 生成文本 embedding。
   - 下载并加入 `text_model_q4.onnx` 到 `ai-models/clip_vit_base_patch32/.../onnx/`。
   - 文本模型大小约 119.92 MB，SHA-256：`e4ccd15d806b8af841a036884b42034535d58e04c52df00f56e73f72d3c166d5`。
   - release 资源目录同步包含该文本模型。
   - zero-shot fallback 的 `allowRemoteModels` 改为 `false`，模型只从本地 `ai-models` 加载。
4. 验证：
   - 本地 CLIP text model 可生成 `[2,512]` 文本向量。
   - 使用 `girl` 扫描前 5000 条 CLIP embedding，可返回 Top=50，而不是只返回 2 条。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过。
2026-06-29 Semantic 搜索进度条：

1. 用户需求：
   - 语义搜索结果现在可用，但搜索期间没有明显进度反馈。
   - 希望像构建 embedding 一样显示百分比进度条，让用户知道是否还在扫描。
2. 已完成调整：
   - 新增 `SemanticSearchProgress` 类型，包含 `requestId`、`phase`、`scanned`、`total`、`percent`、`message`。
   - `searchSemanticImages` 支持进度回调。
   - CLIP embedding 扫描 `image_embeddings.jsonl` 时按文件字节进度估算百分比，并每扫描约 1000 条 CLIP 记录上报一次。
   - 新增 IPC 事件 `vector:onSemanticSearchProgress`。
   - preload 和共享 IPC 类型已暴露 `onSemanticSearchProgress`。
   - Image Search 面板在 Semantic 搜索中显示 `Search` 进度条、百分比和当前扫描消息。
   - 前端使用 `requestId` 过滤进度事件，避免连续搜索时旧进度串到新搜索。
3. 验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过，已更新 release。
2026-06-29 Semantic 搜索二进制缓存加速：

1. 用户需求：
   - 继续优化 Semantic 搜索速度。
2. 根因：
   - 旧实现每次搜索都顺序读取并 JSON.parse `image_embeddings.jsonl`。
   - 当前该文件约数 GB，主要耗时在 JSON 解析和把数组还原成数字向量。
3. 已完成优化：
   - 新增 CLIP embedding 二进制搜索缓存：
     - `vector-db/clip_embedding_cache.f32`：连续 Float32 向量矩阵。
     - `vector-db/clip_embedding_paths.jsonl`：向量行号对应的图片路径。
     - `vector-db/clip_embedding_cache.json`：缓存元信息与源 JSONL 文件大小/mtime。
   - Semantic 搜索会优先使用二进制缓存。
   - 当 `image_embeddings.jsonl` 不存在缓存或发生变化时，会自动重建缓存。
   - 进度条会显示 `Building CLIP search cache` 或 `Scanning CLIP cache`。
4. 实测结果：
   - 当前 CLIP embedding：211,220 条。
   - 首次构建缓存：约 19.7 秒。
   - 后续完整扫描二进制缓存：约 151 ms。
   - 缓存文件大小：约 412.54 MB。
5. 验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
2026-06-29 中文 Semantic 查询映射优化：

1. 用户反馈：
   - 中文查询如 `吹风机` 结果仍不准，容易返回表情包/文字图。
2. 根因：
   - 当前 CLIP ViT-B/32 是英文图文模型，对中文文本理解弱。
   - 之前仅有少量中文类别映射，没有覆盖 `吹风机` 等常见物体。
3. 已完成优化：
   - 新增中文到英文 CLIP 查询映射表 `ZH_TO_CLIP_TEXT`。
   - `吹风机` / `电吹风` 会扩展为 `hair dryer`、`blow dryer`、`a hair dryer appliance`。
   - CLIP 文本 embedding 不再只使用原始查询，而是生成多条英文 prompt：
     - `a photo of a ...`
     - `a close-up photo of a ...`
     - 原英文概念词
   - 扩展常见中文物体词：键盘、鼠标、笔记本、电脑、显示器、耳机、手机、瓶子、杯子、椅子、桌子、鞋、包、手表、眼镜、书、文档等。
4. 说明：
   - 英文 CLIP 对中文仍依赖映射表，未覆盖的新中文名词需要继续补充映射。
   - 如追求更完整中文语义，可后续接入中文 CLIP / multilingual CLIP 模型。
5. 验证：
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过，已更新 release。
2026-06-29 Build 入口与中文 Semantic 映射回退：

1. 用户反馈：
   - “机翻”中文查询仍不稳定，先取消这条路线。
   - 优先优化 `Build Embeddings`、`Build Embeddings GPU`、`Build CLIP`、`Build CLIP GPU` 四个构建入口。
2. 已完成调整：
   - 撤回新增的中文到英文 CLIP prompt 映射表 `ZH_TO_CLIP_TEXT`。
   - CLIP 文本 embedding 恢复为只使用原始查询：`a photo of ...` 和原始文本本身。
   - 移除最近新增的通用中文物体词硬映射，避免“吹风机/键盘/鼠标”等被错误扩展后污染结果。
   - Image Search 面板的构建入口整理为 `Build: DINO CPU / DINO GPU / CLIP CPU / CLIP GPU`。
   - 四个构建按钮共用同一个启动函数，统一传入 `scanPaths`、`backend` 和 `GPU Jobs`，减少后续维护时漏改。
   - `GPU Jobs` 继续同时作用于 `DINO GPU` 和 `CLIP GPU`。
3. 当前策略：
   - 中文语义搜索暂不再做机翻扩展。
   - 英文 CLIP 模型仍更适合英文 prompt；中文精准语义后续应改用中文/多语言 CLIP 模型，而不是继续补硬编码翻译表。
4. 验证：
   - `npx.cmd prettier --write electron\semanticSearchService.ts src\components\ImageSearchPanel.tsx`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过；首次因运行中程序锁定 `fast_scanner.node` 失败，停止本项目进程后重跑成功。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 DINO GPU 禁用与安全降级：

1. 用户反馈：
   - DINO GPU 经过子进程隔离、管道错误防护、2 路并发限制后仍然会崩溃。
2. 结论：
   - 当前环境下 DINOv2 + DirectML / ONNX GPU runtime 不稳定。
   - 崩溃表现不像普通 JS 异常；失败日志中没有 DINO 普通错误记录，说明可能是 native/runtime 级别崩溃。
   - 继续保留可执行的 DINO GPU 按钮会导致用户一点就崩，不适合继续开放。
3. 已完成处理：
   - 前端 `DINO GPU` 按钮改为 `DINO GPU Off`。
   - 点击 `DINO GPU Off` 不再发送 GPU backend，而是提示 “DINO GPU is disabled for stability; using DINO CPU instead.” 并启动 DINO CPU 构建。
   - 后端 `startEmbeddingBuild` 增加兜底：只有 `clip_vit_base_patch32` 允许 `backend: gpu`；DINO 即使通过 IPC 传入 `backend: gpu`，也会强制按 CPU 执行。
   - DINO 构建固定单路 CPU，优先保证不崩溃。
   - CLIP GPU 不受影响，仍继续使用窗口中的 `GPU Jobs`。
4. 当前策略：
   - DINO：负责以图搜图 / 视觉 rerank，暂时只开放 CPU 构建。
   - CLIP：负责文本语义搜索，GPU 构建继续保留。
   - 后续如果要恢复 DINO GPU，应换更稳定的模型/runtime 或单独做隔离进程测试，不再直接在主功能按钮中开放。
5. 已验证：
   - `npx.cmd prettier --write src\components\ImageSearchPanel.tsx electron\embeddingService.ts`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 DINO CPU 崩溃全局排查与修复：

1. 用户反馈：
   - DINO GPU 禁用后，DINO CPU 仍然会崩溃。
   - 要求全局分析因素，逐步排除是否遗漏关键因素。
2. 已排查因素：
   - `embedding_failures.jsonl` 最近没有 DINO 普通错误记录，说明不是普通图片解码异常或 JS catch 可捕获错误。
   - `image_embeddings.jsonl` 当前约 5.84GB，是重大风险点。
   - 旧 DINO 构建路径仍使用 `embeddingWorker` worker thread；worker thread 与主进程共享地址空间，native/ONNX crash 仍可能带崩主程序。
   - 旧 DINO 写库路径使用 `upsertEmbedding()`，每次写入都会触发 `getEmbedding()` / `embeddingStore.find()`，进而全量加载 JSONL；在 5.84GB 文件上有明显 OOM/卡死/崩溃风险。
   - 旧 `collectExistingEmbeddingIds()` 对 DINO 使用 `embeddingStore.getAll()`，启动构建前也会全量加载巨大 JSONL。
   - 搜索侧 `rerankService.generateQueryVector()` 仍在 Electron 主进程里直接加载 DINO pipeline；即使 Build 路径隔离，`standard/precise` 搜索也可能因为主进程 DINO 推理崩溃。
   - `vectorIndexService` 对大 embedding 文件已有 `isLargeEmbeddingFile()` 保护，超过 512MB 会走 streaming search，不是本轮主要崩溃点。
3. 已完成修复：
   - DINO 构建不再走 `embeddingWorker` worker thread，CPU 也统一走 `dinoEmbeddingChild.js` 子进程隔离。
   - DINO 构建启动时收集已有 embedding ID 改为流式扫描 `image_embeddings.jsonl`，不再 `embeddingStore.getAll()`。
   - DINO embedding 写入改为 `appendEmbeddingNoUpsert()` append-only，不再对 5.84GB JSONL 做全量 upsert。
   - 搜索侧 DINO query vector 生成移出主进程，改为一次性调用 `dinoEmbeddingChild.js` 子进程。
   - `rerankService` 不再直接 import/load `@huggingface/transformers` 的 DINO pipeline，避免主进程 native 推理崩溃。
   - DINO 子进程调用增加 30 秒 timeout、stderr 收集、stdin error / process error / exit 处理。
4. 当前 DINO 策略：
   - DINO GPU 继续禁用。
   - DINO CPU 可用，但所有 DINO 推理必须在子进程中执行。
   - DINO 写库使用 append-only；重复记录由搜索/构建侧流式过滤处理，优先保证稳定性。
   - 5GB+ JSONL 已经接近当前文件存储方案上限，后续应迁移到分模型分文件或 SQLite/二进制向量库。
5. 已验证：
   - DINO child CPU 单图测试：通过，返回 768 维向量。
   - `npx.cmd prettier --write electron\embeddingService.ts electron\rerankService.ts`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 Embedding 构建诊断日志：

1. 用户反馈：
   - 点击开始后过一段时间会崩溃。
   - 界面一直显示 `running 0%`，不清楚卡在哪个步骤。
   - 需要功能日志来分析原因。
2. 已完成：
   - 新增 embedding 构建诊断日志：
     `<APP_DATA>\vector-db\embedding_diagnostics.jsonl`
   - 日志为 JSONL，每一行记录一个事件，包含 `time`、`runId`、`event` 和上下文参数。
   - 单个日志超过 20MB 会自动轮转为 `.bak`，避免无限增长。
3. 已覆盖事件：
   - `build:start-request`：用户点击构建入口，记录 model、backend、scanPaths、日志路径。
   - `build:effective-config`：记录实际 backend；当前 DINO 强制 CPU，CLIP GPU 可用。
   - `existing-scan:start/progress/done`：扫描 5.84GB `image_embeddings.jsonl` 时的进度。
   - `enumerate:start/progress/done`：枚举图片目录时的进度。
   - `build:task-queue-built`：任务队列数量、跳过数量、模型路径、并发数。
   - `dino-child:spawn/ready/stderr/exit/failure/replacement`：DINO 子进程生命周期。
   - `task:dispatch-dino`：派发到 DINO 子进程的图片路径。
   - `task:result-ok/result-fail/stored`：推理成功/失败/写入 JSONL。
   - `build:complete`：构建正常完成。
   - `build:stop-request`：用户停止构建。
4. 0% 阶段解释：
   - 在 `existing-scan` 和 `enumerate` 阶段，任务总数尚未生成，所以 UI 可能仍显示 0%。
   - 现在 UI 的 `currentPath` 会显示类似 `Scanning existing embeddings: 43% (...)` 或 `Enumerating images: ...`。
   - 如果再次崩溃，查看 `embedding_diagnostics.jsonl` 最后一行即可判断最后停在：
     - 扫描已有 embedding；
     - 枚举文件；
     - 子进程启动；
     - 某张图片推理；
     - 写入 embedding store。
5. 已验证：
   - `npx.cmd prettier --write electron\embeddingService.ts`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 当前进度同步：

1. 中文 Semantic 查询：
   - 已暂停“中文机翻/硬编码映射”方案。
   - 当前不再把中文强行翻译成英文 CLIP prompt，避免错误翻译污染结果。
   - 后续如果继续提升中文语义，应优先接入中文或多语言 CLIP 模型，而不是继续扩展手写翻译表。
2. Build 入口：
   - Image Search 面板已整理为 `DINO CPU`、`DINO GPU`、`CLIP CPU`、`CLIP GPU` 四个入口。
   - `GPU Jobs` 继续作为统一 GPU 路数控制，同时作用于 `DINO GPU` 和 `CLIP GPU`。
   - 四个入口已共用统一启动逻辑，减少后续改并发、路径、toast、状态禁用时漏改。
3. 当前可用状态：
   - DINO 构建用于以图搜图/视觉 rerank。
   - CLIP 构建用于文本语义搜索。
   - CLIP Semantic 搜索已使用本地文本模型和本地 CLIP embedding cache。
4. 已验证：
   - 类型检查通过。
   - 格式检查通过。
   - 完整 build 通过。
   - 打包后的 `FloatingClock.exe` 启动 smoke test 通过。

2026-06-29 DINO GPU 崩溃隔离修复：

1. 用户反馈：
   - `DINO GPU` 会崩溃。
2. 根因判断：
   - `CLIP GPU` 已经运行在独立 child process 中，native/ONNX/DirectML 崩溃不会直接带崩主进程。
   - `DINO GPU` 仍运行在 `worker_threads` 中，worker thread 与 Electron 主进程共享同一进程地址空间，DirectML/ONNX native crash 仍可能带崩整个软件。
3. 已完成修复：
   - 新增 `electron/dinoEmbeddingChild.ts`，DINOv2 GPU embedding 改为独立子进程执行。
   - `Build: DINO GPU` 现在走 `dinoEmbeddingChild.js` 子进程池。
   - `Build: DINO CPU` 保持原 `embeddingWorker` worker thread 路径，不改变 CPU 构建行为。
   - DINO GPU 子进程支持崩溃重启；连续 3 次子进程崩溃后停止任务并在进度状态中显示错误，避免无限重启。
   - `vite.config.mjs` 已加入 `dinoEmbeddingChild.ts` 构建入口。
   - `package.json` 已把 `dist-electron/dinoEmbeddingChild.js` 加入 `extraResources`，确保 release 包可用。
4. 已验证：
   - `npx.cmd prettier --write electron\embeddingService.ts electron\dinoEmbeddingChild.ts vite.config.mjs package.json`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过，构建产物包含 `dist-electron\dinoEmbeddingChild.js` 和 `release\win-unpacked\resources\dinoEmbeddingChild.js`。
   - 直接运行 `dist-electron\dinoEmbeddingChild.js`，传入本地 DINO 模型和测试图片，GPU 后端返回 768 维向量。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 DINO GPU 二次稳定性修复：

1. 用户反馈：
   - DINO GPU 改为子进程后仍然会崩溃。
2. 二次判断：
   - 子进程隔离只能避免 native crash 直接共享主进程地址空间。
   - 如果子进程崩溃后主进程继续写入 stdin，仍可能触发未处理的管道错误，例如 `EPIPE` / stdin write failure。
   - 另外 DINO DirectML 多进程并发比 CLIP 更不稳定，沿用 8/10/12 路 GPU Jobs 容易把显存、DirectML runtime 或驱动打爆。
3. 已完成修复：
   - `dinoEmbeddingChild` 的 `stdin error`、`process error`、`exit` 全部接入统一失败处理。
   - 新增子进程失败去重，避免同一个子进程同时触发 stdin error 和 exit 时重复计失败、重复拉起替代进程。
   - DINO GPU 写 stdin 前检查 `killed`、`exitCode` 和 `stdin.writable`。
   - DINO GPU stdin 写入改为带 callback 的安全写入，写入失败会记录当前任务失败并重启子进程，不再让异常冒泡。
   - DINO GPU 并发上限强制限制为 2 路；CLIP GPU 仍继续使用窗口中选择的 GPU Jobs。
   - Image Search 前端 toast 和 tooltip 已同步，DINO GPU 显示实际 2 路上限，避免界面误导。
4. 已验证：
   - `npx.cmd prettier --write src\components\ImageSearchPanel.tsx electron\embeddingService.ts`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run build`：通过；首次因运行中程序锁定 `fast_scanner.node` 失败，停止本项目进程后重跑成功。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。

2026-06-29 Embedding 构建日志分析与 0% 崩溃修复：

1. 本次日志结论：
   - 最新 runId：`emb-1782742348719-8ays2lmyx07`。
   - 用户选择的构建路径是 `C:\` 和 `D:\` 两个整盘路径。
   - `existing-scan` 阶段扫描 `image_embeddings.jsonl`，文件大小约 5.84GB，耗时约 21.7 秒，识别到 210,019 条已有 DINO embedding。
   - `enumerate` 阶段扫描 252,230 个目录，发现 237,139 张图片，耗时约 76.3 秒。
   - 最后一条日志停在 `build:scanpaths-enumerated`，没有出现 `build:start-dino`、`dino-child:spawn`、`task:dispatch-dino`。
   - 说明崩溃/卡死并不是 DINO 模型推理，也不是 GPU/CPU backend 内部卡住，而是在“全盘枚举完成后、生成任务队列前后”发生。
2. 关键风险点：
   - 全盘扫描进入了大量系统/程序/开发目录，例如 `Program Files`、`Program Files (x86)`、`Windows Kits`、`node_modules`、`Adobe`、`Autodesk`、`eSupport` 等。
   - 旧逻辑在扫描路径构建 DINO 时会调用 `seedEmbeddingJobs()`，该函数内部会 `embeddingStore.getAll()`，等于再次尝试把 5.84GB JSONL 全量读入内存。
   - 在 237,139 张图片、210,019 条已有 embedding、97MB jobStore 的组合下，任务筛选/写 jobStore 容易造成内存峰值、卡死或进程崩溃。
3. 已完成修复：
   - 扫描路径构建不再调用 `seedEmbeddingJobs()`，改为直接构建本次内存任务队列。
   - `selectedJobs` 从 `filter().map()` 改为单次循环构建，减少临时大数组。
   - task queue 构建也从链式 `filter().map()` 改为单次循环，减少内存峰值。
   - 新增日志事件：
     - `build:select-jobs-start`
     - `build:select-jobs-done`
     - `build:seed-jobs-skip`
     - `build:task-queue-start`
   - `build:scanpaths-enumerated`、`build:select-jobs-*`、`build:task-queue-built` 现在会记录当前进程内存快照：rss、heapUsed、heapTotal、external。
   - UI `currentPath` 会在“Preparing embedding jobs”阶段显示任务准备进度，避免看起来一直 0% 没动。
4. 当前判断：
   - 之前的 `running 0%` 主要是因为任务总数尚未生成，前置阶段仍在扫描 5.84GB embedding 文件和枚举整盘目录。
   - 当前修复后，再次构建如果仍失败，日志最后一条会更精确定位到任务筛选、队列构建、子进程启动或具体图片推理。
   - 建议优先选择真实图片目录，例如 QQ/微信图片目录、Pictures、指定素材盘目录；整盘 `C:\`/`D:\` 会扫描大量无关系统资源，速度慢且结果污染严重。
5. 验证：
   - `npx.cmd prettier --write electron\embeddingService.ts`：通过。
   - `npm.cmd run typecheck`：通过。
   - `npm.cmd run format:check`：通过。
   - `npm.cmd run build`：通过，已更新 release。
   - `release\win-unpacked\FloatingClock.exe` smoke test：通过，启动 5 秒后仍在运行。
