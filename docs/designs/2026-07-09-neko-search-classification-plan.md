# NekoSearch 智能素材分类新增功能方案 - 项目适配

> 状态：部分实施  
> 更新日期：2026-07-16  
> 当前实现：[NekoSearch 智能素材分类实施基线](../current/2026-07-14-neko-search-implementation.md)  
> 专项审计：[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)  
> 项目：FloatingClock Electron / NekoSearch  
> 日期：2026-07-09  
> 类型：新增功能落地方案 / 架构适配文档  
> 适配范围：Image Search、Vector/Embedding、Duplicate Finder、File Manager、Media Search 视频关键帧后续接入  
> 当前定位：在现有本地以图搜图能力上增加“素材库、分类、标签、AI 建议、聚类分组、重复整理”的素材管理能力。

## 1. 功能定位

NekoSearch 智能素材分类不是单独重写一套搜索系统，而是在当前项目已有能力上扩展一层“素材管理与分类决策层”。

当前已有能力：

- Image Search：本地图片扫描、fast_scanner hash 索引、以图搜图、拖拽/剪贴板搜索、结果展示。
- Vector / Embedding：DINO、CLIP embedding 构建、分片存储、向量搜索、模型状态、GPU/CPU 后端。
- Duplicate Finder：文件级重复扫描能力。
- File Manager：缩略图、路径浏览、文件打开、文件夹打开、分类视图的部分 UI 经验。
- Media Search：视频扫描、抽帧、DINO/CLIP frame embedding、以图搜视频、语义搜视频。

新增目标：

- 把“图片能搜到”升级为“图片能被整理、分组、确认、筛选、维护”。
- 让几万张素材可以按分类、标签、相似组、重复组进行管理。
- 所有 AI 结果默认是建议，不直接覆盖用户手动分类。
- 支持后续把视频关键帧接入同一套分类体系。

## 2. 设计原则

1. 不破坏现有 Image Search 主链路。
2. 不把分类逻辑继续塞进 `ImageSearchPanel.tsx`。
3. Renderer 只负责 UI，不直接访问任意文件和模型。
4. 所有新增本地文件操作必须走 preload + IPC + main 进程校验。
5. P0 优先落地手动分类和标签，不强行一次性引入完整 SQLite。
6. AI 分类建议必须保存来源、置信度和状态。
7. 用户手动确认优先级最高，AI 建议不得覆盖 manual / confirmed 结果。
8. 大规模向量、聚类、重复检测必须后台任务化，并提供进度、速度、ETA、取消。
9. 新功能复用当前 vector embedding、thumbnail、safe path、task progress 体系。

## 3. 与现有项目的复用关系

| 新功能能力            | 复用现有模块                                  | 新增模块                                   |
| --------------------- | --------------------------------------------- | ------------------------------------------ |
| 图片素材入库          | `imageSearchService`、fast_scanner manifest   | `assetLibraryService`                      |
| 缩略图                | File Manager / Image Search 缩略图经验        | `assetThumbnailService`，后续统一 provider |
| DINO / CLIP embedding | `embeddingService`、`vectorDatabaseService`   | 分类任务调度层                             |
| 文本标签 embedding    | `semanticSearchService` / CLIP text embedding | `assetTagSuggestionService`                |
| 参考图分类            | 向量搜索、cosine similarity                   | `categoryReferenceService`                 |
| 相似素材分组          | 向量分片、streaming search                    | `assetClusteringService`                   |
| 重复 / 近重复         | fast_scanner hash、Duplicate Finder           | `assetDuplicateService`                    |
| 文件打开 / 文件夹打开 | `safeShellPath`、`shell.openPath`             | 统一素材操作 IPC                           |
| 视频关键帧            | `MediaSearch` frame manifest / embedding      | `video_frame` 来源接入                     |

## 4. 新增模块边界

### 4.1 Renderer

建议新增：

```txt
src/components/AssetLibraryPanel.tsx
src/components/asset-library/AssetLibraryControls.tsx
src/components/asset-library/AssetCategoryTree.tsx
src/components/asset-library/AssetGrid.tsx
src/components/asset-library/AssetSuggestionList.tsx
src/components/asset-library/AssetClusterGroups.tsx
src/components/asset-library/AssetDuplicateGroups.tsx
src/components/asset-library/AssetTagManager.tsx
src/components/asset-library/AssetDetailDrawer.tsx
src/components/asset-library/AssetBatchToolbar.tsx
```

`AssetLibraryPanel` 只做状态编排，不直接写复杂 UI。分类树、建议列表、聚类页、重复组页、素材网格必须拆成独立组件。

### 4.2 Main Process

建议新增：

```txt
electron/assetLibraryIpc.ts
electron/assetLibraryService.ts
electron/assetMetadataStore.ts
electron/categoryService.ts
electron/tagService.ts
electron/categoryReferenceService.ts
electron/assetSuggestionService.ts
electron/assetClusteringService.ts
electron/assetDuplicateService.ts
electron/assetTaskQueue.ts
```

必须避免继续把大量 IPC 写入 `electron/main.ts`。新增 IPC 统一通过：

```ts
registerAssetLibraryIpc(() => mainWindow)
```

接入。

### 4.3 Shared Types

建议新增到 `shared/ipc-contract.ts` 或拆分后由其导出：

```txt
AssetRecord
AssetCategory
AssetTag
AssetCategoryAssignment
AssetTagAssignment
AssetCategoryReference
AssetClusterGroup
AssetClusterGroupAsset
AssetDuplicateGroup
AssetSuggestion
AssetLibraryTaskProgress
```

## 5. 数据层方案

### 5.1 P0 可落地方案：JSONL + manifest

考虑当前项目已经大量使用 JSONL / manifest，P0 可以先使用轻量文件存储，降低风险。

建议目录：

```txt
userData/
  asset-library/
    assets.jsonl
    categories.json
    asset_categories.jsonl
    tags.json
    asset_tags.jsonl
    category_references.jsonl
    cluster_groups.jsonl
    cluster_group_assets.jsonl
    duplicate_groups.jsonl
    suggestions.jsonl
    tasks.jsonl
    thumbnails/
```

优点：

- 和现有工程风格一致。
- 不需要立即引入 SQLite 依赖。
- 便于先打通 UI 和业务流。

限制：

- 大数据量筛选、排序、统计会越来越慢。
- 建议结果反复改状态时 JSONL compaction 必须做。
- 聚类组、标签筛选、分类统计最终更适合 SQLite。

### 5.2 推荐终态：SQLite + 向量文件/索引

V1.6 之后建议迁移到 SQLite：

```txt
userData/
  asset-library/
    asset_library.sqlite
    vectors/
      dino_global.f32
      clip_global.f32
      clip_text.f32
    thumbnails/
```

SQLite 负责元数据、分类、标签、状态、建议、聚类关系；大向量继续放二进制文件或现有 vector shards，SQLite 仅保存 embedding 引用。

## 6. 数据模型

### 6.1 assets

保存素材基础信息。

字段：

- id
- path
- kind：`image` / `video_frame`
- source：`image_search` / `media_search` / `manual_import`
- width
- height
- file_size
- modified_time
- diff_hash64
- dct_hash64
- embedding_dino_id
- embedding_clip_id
- thumbnail_path
- missing
- created_at
- updated_at

P0 可从 Image Search manifest 生成 assets，不重复扫描图片。

### 6.2 categories

字段：

- id
- name
- description
- parent_id
- color
- icon
- sort_order
- threshold
- created_at
- updated_at

用于保存用户创建的素材分类。支持多级分类。

### 6.3 asset_categories

字段：

- id
- asset_id
- category_id
- confidence
- source：`manual` / `reference_image` / `text_label` / `cluster` / `duplicate` / `filename` / `ocr` / `video_frame`
- status：`suggested` / `confirmed` / `rejected` / `low_confidence` / `manual_override` / `ignored`
- confirmed_by_user
- override_of
- created_at
- updated_at

核心规则：

- `manual` + `confirmed` 优先级最高。
- AI 建议只写 `suggested` 或 `low_confidence`。
- 用户拒绝的建议写 `rejected`，后续不重复弹出同一建议。
- 用户手动改分类写 `manual_override` 并记录被覆盖来源。

### 6.4 tags

字段：

- id
- name
- color
- created_at
- updated_at

### 6.5 asset_tags

字段：

- id
- asset_id
- tag_id
- confidence
- source
- status
- created_at
- updated_at

### 6.6 category_references

字段：

- id
- category_id
- asset_id
- embedding_id
- model_name
- weight
- created_at

一个分类可以绑定多张参考图，每张参考图可以设置权重。

### 6.7 cluster_groups

字段：

- id
- name
- algorithm
- status：`suggested` / `confirmed` / `ignored` / `deleted`
- asset_count
- avg_similarity
- representative_asset_id
- created_at
- updated_at

### 6.8 cluster_group_assets

字段：

- id
- cluster_group_id
- asset_id
- similarity
- created_at

### 6.9 duplicate_groups

字段：

- id
- type：`exact` / `near_duplicate` / `similar_composition` / `similar_product` / `similar_scene` / `similar_style`
- status：`suggested` / `confirmed` / `ignored`
- representative_asset_id
- asset_count
- max_similarity
- created_at
- updated_at

## 7. 分类来源与状态规则

### 7.1 来源

| source          | 说明               |
| --------------- | ------------------ |
| manual          | 用户手动分类       |
| reference_image | 参考图分类         |
| text_label      | 文本标签分类       |
| cluster         | 聚类自动分组       |
| duplicate       | 重复图检测         |
| filename        | 文件名规则         |
| ocr             | OCR 文本识别，后续 |
| video_frame     | 视频关键帧，后续   |

### 7.2 状态

| status          | 说明         |
| --------------- | ------------ |
| suggested       | AI 建议      |
| confirmed       | 用户确认     |
| rejected        | 用户拒绝     |
| low_confidence  | 低置信度     |
| manual_override | 用户手动覆盖 |
| ignored         | 用户忽略     |

### 7.3 优先级

```txt
manual confirmed
> manual_override
> confirmed AI suggestion
> suggested
> low_confidence
> ignored / rejected
```

同一 asset + category：

- 已有 `manual` 或 `manual_override` 时，不允许 AI 自动覆盖。
- 已有 `rejected` 时，不重复生成同一来源同一分类建议，除非用户手动重新计算。
- 低置信度建议进入待确认区，不进入正式分类统计。

## 8. 核心流程

### 8.1 新素材入库

```txt
用户添加路径
-> Image Search 扫描图片
-> fast_scanner 生成 hash / segment manifest
-> Asset Library 从 Image Search manifest 同步 asset records
-> 构建 DINO / CLIP embedding
-> 写入 vector store
-> 执行参考图分类
-> 执行文本标签匹配
-> 执行重复/近重复检测
-> 生成 suggestions
-> 用户确认
-> 写入 asset_categories / asset_tags
```

P0 不重复做扫描，优先复用 Image Search 已有扫描结果。

### 8.2 手动分类

```txt
新建分类
-> 选择或拖入素材
-> 写入 asset_categories(source=manual,status=confirmed)
-> 如已有 AI 建议，保留历史但不再影响正式分类
```

### 8.3 参考图分类

```txt
分类添加 3-10 张参考图
-> 读取参考图 DINO 或 CLIP embedding
-> 读取候选素材 embedding
-> 计算加权相似度
-> 按分类 threshold 判断
-> 生成 suggested / low_confidence
-> 用户确认后写入 confirmed
```

默认算法：

- 每个分类取参考图相似度 Top3 加权平均。
- 参考图权重默认 1.0，可调整。
- 分类阈值默认 0.72，允许每个分类单独调整。

### 8.4 文本标签分类

```txt
用户创建标签
-> 生成 CLIP text embedding
-> 图片 CLIP image embedding 参与匹配
-> 返回 TopN 标签建议
-> 用户确认后写入 asset_tags
```

注意：

- 当前英文 CLIP 中文能力有限。
- 中文标签 P0 可以只作为用户手动标签。
- 自动文本标签推荐优先支持英文或中英混合标签；中文多语义模型作为 P4/P5。

### 8.5 聚类自动分组

```txt
选择素材范围
-> 读取 embedding
-> 执行聚类
-> 生成 cluster_groups
-> 选择代表图
-> 展示分组
-> 用户转为正式分类 / 合并 / 拆分 / 忽略
```

P0/P1 不建议直接引入复杂 HDBSCAN。建议先做两级方案：

1. 近重复/高相似阈值分组：快速、稳定、可解释。
2. 后续再做 K-Means / DBSCAN / HDBSCAN。

### 8.6 重复 / 近重复素材分类

```txt
diffHash / dctHash -> 近重复候选
文件 hash -> 完全重复
embedding -> 语义相似候选
尺寸/文件大小/mtime -> 辅助判断
生成 duplicate_groups
用户确认删除/移动/忽略
```

删除文件必须二次确认，默认只建议“移动到重复素材文件夹”或“导出列表”。

## 9. 阈值建议

| 等级     |      相似度 | 行为                   |
| -------- | ----------: | ---------------------- |
| 高置信度 |     >= 0.82 | 建议区靠前，可批量确认 |
| 中置信度 | 0.70 - 0.82 | 需要用户确认           |
| 低置信度 | 0.60 - 0.70 | 进入低置信度区         |
| 不建议   |      < 0.60 | 不生成建议             |

不同模型建议：

- DINO：更适合以图搜图、相似视觉/构图/产品外观。
- CLIP：更适合文本标签、语义类别、截图/海报/人物/场景。
- phash/dct：更适合重复和近重复。

## 10. UI 设计

### 10.1 入口

建议新增独立面板：

```txt
Asset Library / NekoSearch
```

原因：

- 这是素材管理，不只是 Image Search 的一个搜索模式。
- 包含分类树、建议区、标签、聚类、重复整理，放入 Image Search 会让主面板再次膨胀。
- 可以复用 Image Search 的结果网格和路径操作，但 UI 需要独立。

### 10.2 首页

显示：

- 全部素材数量
- 已分类素材数量
- 未分类素材数量
- AI 建议数量
- 低置信度数量
- 重复素材数量
- 最近分类记录
- 分类树

### 10.3 分类树

能力：

- 新建分类
- 删除分类
- 重命名分类
- 分类颜色
- 分类图标
- 多级分类
- 拖拽素材到分类
- 批量移动到分类

### 10.4 AI 建议页

每条建议显示：

- 素材缩略图
- 文件名
- 建议分类
- 置信度
- 来源
- 相似参考图
- 操作按钮：确认、拒绝、改到其他分类、忽略、查看相似素材

### 10.5 聚类分组页

每组显示：

- 代表图
- 分组名称
- 素材数量
- 平均相似度
- 主要文件夹来源
- 建议分类名称

操作：

- 转为分类
- 重命名
- 合并分组
- 拆分分组
- 删除分组
- 忽略分组

### 10.6 未分类素材页

支持：

- 时间排序
- 路径筛选
- 文件类型筛选
- 相似度自动分组
- 批量选择
- 批量分类
- 批量打标签

### 10.7 分类详情页

显示：

- 当前分类下素材
- 分类参考图
- 分类规则
- 分类阈值
- 分类来源统计
- 子分类
- 标签分布

操作：

- 添加参考图
- 移除参考图
- 调整阈值
- 重新计算分类
- 批量移出素材
- 批量导出素材
- 批量打标签

## 11. IPC 设计

建议新增命名空间：

```txt
assetLibrary:getStatus
assetLibrary:syncFromImageSearch
assetLibrary:listAssets
assetLibrary:listCategories
assetLibrary:createCategory
assetLibrary:updateCategory
assetLibrary:deleteCategory
assetLibrary:assignCategory
assetLibrary:unassignCategory
assetLibrary:listTags
assetLibrary:createTag
assetLibrary:assignTag
assetLibrary:addCategoryReference
assetLibrary:removeCategoryReference
assetLibrary:buildSuggestions
assetLibrary:listSuggestions
assetLibrary:confirmSuggestion
assetLibrary:rejectSuggestion
assetLibrary:ignoreSuggestion
assetLibrary:buildDuplicateGroups
assetLibrary:listDuplicateGroups
assetLibrary:buildClusterGroups
assetLibrary:listClusterGroups
assetLibrary:convertClusterToCategory
assetLibrary:getTaskProgress
assetLibrary:stopTask
```

所有 IPC 入参使用 `unknown`，在 main 进程 guard 后再进入 service。

## 12. 文件与路径安全

1. 分类库只保存文件路径和派生 metadata，不复制原文件，除非用户执行“导出/移动”。
2. 打开文件、打开文件夹、移动重复文件必须复用 `safeShellPath` 和路径存在性校验。
3. 删除文件默认不做 P0；优先做“移动到重复素材文件夹”和“导出重复列表”。
4. 分类库数据目录必须限制在 `app.getPath('userData')/asset-library`。
5. 模型路径只能通过模型 ID 选择，不允许 renderer 传任意模型路径。
6. OCR、视频关键帧、未来 LLM API 都必须作为后续可选功能，不进入 P0。

## 13. 性能设计

### 13.1 大数据量原则

- 列表分页，默认最多返回 200 条。
- 缩略图懒加载。
- 建议生成后台任务化。
- 聚类任务可取消。
- 大 JSONL 读取 streaming。
- 状态统计缓存，避免打开面板时全量扫描。

### 13.2 任务进度

所有耗时任务统一返回：

- taskId
- type
- state
- total
- completed
- failed
- percentage
- itemsPerSecond
- etaMs
- currentPath
- message

优先复用 Media Search / Vector 进度条体验。

### 13.3 聚类策略

P0/P1：

- 先做近重复/相似阈值分组。
- 不做全量 O(n²)。
- 使用向量索引或分批 TopK 邻居方式生成候选边。

P2/P3：

- 引入 DBSCAN / HDBSCAN 或 K-Means。
- 对 10 万级素材必须做抽样、分片、增量聚类。

## 14. 开发优先级

### P0：分类基础版

目标：先让用户能管理素材，不依赖 AI 完全准确。

- 新增 Asset Library 面板。
- 从 Image Search manifest 同步素材。
- 分类树。
- 标签管理。
- 素材加入分类。
- 批量分类。
- 分类筛选。
- 未分类素材列表。
- 基础统计。

建议文件：

```txt
electron/assetLibraryService.ts
electron/categoryService.ts
electron/tagService.ts
electron/assetLibraryIpc.ts
src/components/AssetLibraryPanel.tsx
src/components/asset-library/*
```

### P1：参考图分类

- 分类参考图。
- 参考图 embedding 读取。
- 分类相似度计算。
- AI 分类建议。
- 用户确认 / 拒绝 / 忽略。
- 分类置信度和来源保存。

### P2：重复 / 相似素材分类

- hash 重复检测。
- phash / dct 近重复检测。
- embedding 相似检测。
- 重复组展示。
- 批量移动 / 导出重复列表。

### P3：聚类自动分组

- 向量聚类。
- 自动生成分组。
- 分组代表图。
- 分组转分类。
- 分组合并 / 拆分。

### P4：文本标签分类

- CLIP text embedding。
- 图片与标签匹配。
- 自动标签推荐。
- 标签置信度。
- 标签确认 / 拒绝。

### P5：视频关键帧与 OCR

- Media Search frame asset 接入。
- video_frame 来源分类。
- OCR 来源建议。
- 多模态统一筛选。

## 15. 版本规划

### V1.5：分类基础版

- 手动分类。
- 分类树。
- 标签管理。
- 批量分类。
- 未分类素材。
- 基础重复组。

### V1.6：参考图分类版

- 分类参考图。
- 参考图自动分类。
- AI 建议分类。
- 置信度显示。
- 用户确认分类。

### V1.7：聚类整理版

- 聚类自动分组。
- 分组转分类。
- 分组合并。
- 分组拆分。
- 未分类素材整理。

### V1.8：自动标签版

- 文本标签匹配。
- 自动标签推荐。
- 标签筛选。
- 标签批量确认。

### V1.9：视频关键帧分类版

- Media Search 关键帧资产接入。
- 视频帧加入分类。
- 视频片段按分类筛选。

## 16. 测试计划

### 16.1 单元测试

新增：

```txt
tests/asset-library-guards.test.cjs
tests/asset-library-store.test.cjs
tests/asset-category-service.test.cjs
tests/asset-tag-service.test.cjs
tests/asset-suggestion-service.test.cjs
tests/asset-duplicate-service.test.cjs
```

### 16.2 固定样本

新增：

```txt
tests/fixtures/assets/
  white-background-products/
  people-holding-products/
  screenshots/
  posters/
  near-duplicates/
  ecommerce-detail-pages/
```

### 16.3 回归验证

必须覆盖：

- 创建分类。
- 重命名分类。
- 删除分类。
- 批量加入分类。
- 添加参考图。
- 生成建议。
- 确认建议。
- 拒绝建议后不重复出现。
- manual 分类不被 AI 覆盖。
- 重复组不执行危险删除。
- 大列表分页不阻塞 UI。

## 17. 关键风险

| 风险                  | 说明                                           | 规避                                       |
| --------------------- | ---------------------------------------------- | ------------------------------------------ |
| 继续膨胀 Image Search | 分类功能很大，塞入 Image Search 会导致维护困难 | 新建 Asset Library 面板                    |
| JSONL 后期变慢        | 分类/标签/建议是高频读写                       | P0 JSONL，P1/P2 准备 SQLite                |
| CLIP 中文不准         | 当前 CLIP 对中文标签弱                         | 中文自动标签后置，先支持手动标签和英文标签 |
| 聚类耗时大            | 全量聚类可能卡死                               | 后台任务、TopK 邻居、分片、可取消          |
| AI 误分类             | 自动写入会污染素材库                           | AI 只写 suggested，用户确认后生效          |
| 重复删除危险          | 误删不可逆                                     | P0 不直接删除，先移动/导出                 |
| 数据污染              | 整盘扫描包含系统图片/缓存                      | 引导用户选择素材目录，支持路径过滤和忽略   |

## 18. 推荐落地顺序

第一阶段：数据与 UI 骨架

1. 新建 `asset-library` 数据目录。
2. 从 Image Search manifest 同步 assets。
3. 新建 Asset Library 面板。
4. 实现分类树和素材网格。
5. 实现手动分类、批量分类、标签管理。

第二阶段：AI 建议

1. 分类参考图。
2. 读取 DINO embedding。
3. 生成参考图分类建议。
4. 建议确认 / 拒绝 / 忽略。
5. 分类详情页显示参考图和来源统计。

第三阶段：重复和相似整理

1. hash / dct 重复组。
2. embedding 相似组。
3. 重复组 UI。
4. 批量移动和导出列表。

第四阶段：聚类和标签

1. 聚类分组。
2. 分组转分类。
3. CLIP text 标签推荐。
4. 标签批量确认。

第五阶段：数据层升级

1. 引入 SQLite。
2. 迁移 JSONL metadata。
3. 增加索引和统计缓存。
4. 引入更稳定的向量 ANN 索引。

## 19. 当前项目适配结论

该功能适合加入当前项目，但必须按“新增 Asset Library 分类管理层”的方式落地，而不是继续扩展 Image Search 面板。

推荐判断：

- 可复用能力充足：Image Search、Vector、Duplicate、Media Search 已经覆盖扫描、hash、embedding、搜索、缩略图、进度等基础能力。
- 主要新增工作在数据模型、分类 UI、建议状态机、后台任务编排。
- P0 不需要新增模型，也不需要立即下载新模型。
- P1/P4 依赖现有 DINO/CLIP embedding 覆盖率。
- 长期必须从 JSONL 迁移到 SQLite 或等价数据库，否则分类/标签/建议会成为新的性能瓶颈。

建议先实现 V1.5 分类基础版，再逐步接入 AI 分类建议。

## 20. 2026-07-14 实施状态

已落地：

1. 独立 NekoSearch 面板、设置入口、布局持久化和 UI smoke 覆盖。
2. Image Search native segment 到素材库的增量同步和稳定素材 ID。
3. 手动分类、多级分类、标签、批量关系、筛选和未分类视图。
4. DINO 参考图分类建议及确认、拒绝、忽略状态流。
5. CLIP 文本标签建议及置信度状态流。
6. DINO Float16 两阶段聚类、逐图纯度过滤、重命名、忽略和转分类。
7. `assetLibrary:*` IPC 契约、main process guards、任务进度和停止能力。
8. 分页、虚拟网格和懒缩略图渲染。

尚未落地：P2 重复素材工作流、聚类合并/拆分、视频帧接入、SQLite 迁移和中文多语义模型。实现事实与验证结果以[当前实施基线](../current/2026-07-14-neko-search-implementation.md)为准。

2026-07-15 审计校准：当前纵向闭环约 78%，完整方案约 55%，综合健康度 68/100。同步取消回滚、跨 store 事务、180K catalog 查询、数 GB 向量主进程扫描、参考图多 prototype、聚类稳定性和准确率固定样本门禁均为正式发布前置项。详细证据和分阶段验收标准见[专项审计](../audits/2026-07-15-neko-search-multidimensional-audit.md)。

2026-07-16 第一批整改完成同步取消回滚、普通写/长任务互斥、审核 suggestionId 绑定、反馈显式开关、索引内存预算、列表去抖和有界分页排序。健康度估算提升到 74/100；SQLite、向量 worker/ANN、多 prototype、正式聚类和固定准确率基准仍是下一阶段。

2026-07-16 第二、三批整改完成 embedding latest-wins 逆序流、多 prototype 参考分类、外部参考图失效、分类专属阈值持久化和核心 JSONL 多 store 恢复事务。健康度估算提升到 80/100；SQLite catalog、向量 worker/ANN、正式聚类 lineage 和真实标注 A/B 仍未完成。

2026-07-18 Clusters 方案适配更新：聚类不再把 10-bit 符号桶直接作为最终成员单位。当前实现复用 DINO Float16 缓存，以 12-bit 微桶做粗路由，再逐图计算原始 cosine 并按 `Purity` 过滤；平均相似度和代表图均来自实际保留成员。默认 `Groups 96`、`Min size 5`、`Purity 0.76`。200,000 向量只读基准约 28.3 秒，保留 35,258 个高置信成员，平均 cosine 0.8531；用户实际重算确认效果明显改善。后续设计重点改为 cluster lineage、重算稳定性、手动合并/拆分和固定标注集，而不是继续调整旧符号桶。
