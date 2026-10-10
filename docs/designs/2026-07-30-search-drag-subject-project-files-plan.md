# 搜索拖出、Subject 精细分割与工程文件搜索方案

> 日期：2026-07-30
> 状态：实施中（DRAG-01、SUBJ-01、SUBJ-02、PROJ-01、PROJ-02、PROJ-03、PROJ-04 已完成）
> 范围：Image Search 搜索结果、Subject Picker、工程文件预览与索引

## 一、目标

1. 从搜索结果拖到 Photoshop、聊天软件或资源管理器时，系统传递原文件，而不是
   `<img>` 当前显示的 WebP/data URL 缩略图。
2. Subject 分割始终以原始文件解码后的完整图像为输入；支持框选、加选、减选、
   撤销和重置，并让最终蒙版真正参与查询特征计算，而不是只使用蒙版外接矩形。
3. 为 PSD 等工程文件生成安全、可缓存的预览代理，使其可以参与图片/语义搜索；
   结果卡片仍然代表原工程文件，并显示稳定的文件类型与工程属性关键词。

## 二、现状与缺口

### 2.1 搜索结果拖出

- `ImageSearchResultGrid` 当前没有 `draggable`/`onDragStart`。
- `ThumbnailImage` 显示的是缓存 data URL；浏览器默认拖动 `<img>` 时，外部应用得到
  的可能是缩略图或 URL，不是源文件。
- File Manager 的现有拖动只写入 `text/plain`，也不是 Windows 原生文件拖出。

### 2.2 Subject

- `samSegmentService.encodeImage()` 已直接读取原文件、处理 EXIF 方向并将长边缩放到
  MobileSAM 的 1024 输入；模型输入并非 512 像素 UI 缩略图。
- Picker 当前只支持一次前景点。IPC 最多接收 8 点，并把标签限制为前景/背景。
- 服务端已经接受多点，但 UI 每次只发送一个点。
- SAM 返回完整原图尺寸蒙版；`ImageSearchPanel` 随后只把 `bbox` 交给
  `searchBySubject()`，后者生成矩形 JPEG crop。蒙版形状、孔洞和减选结果全部丢失。
- `label='sam'` 时还会跳过候选侧主体重排。

### 2.3 工程文件

- `thumbnailIpc` 已能流式读取 PSD 的 1033/1036 嵌入 JPEG 预览，但只用于文件管理器
  缩略图，且通用 50 MiB 上限会挡住很多真实 PSD。
- 原生 Image Search 扫描器只接收 JPG/JPEG/PNG/BMP/WebP/GIF，不会索引 PSD/PSB
  等工程文件。
- `ImageSearchResult` 没有源类型、预览代理、工程关键词或预览提供器字段。

## 三、总体结构

```text
原文件
  ├─ 普通图片 ──────────────┐
  └─ 工程文件 → 预览提供器 → 预览代理 ─┤
                                      ├→ hash / CLIP / DINO → 统一搜索结果
原文件路径 ← sourceId/sourcePath 映射 ─┘
        ├→ 打开原文件
        ├→ 原生拖出原文件
        └→ 显示类型/工程关键词
```

预览代理只作为解码和特征输入，不替代原文件身份。索引、搜索结果、打开、定位和拖出
均以原文件为权威对象。

## 四、功能 1：从结果中原生拖出原文件

### 4.1 实现

1. 新增 `fileDrag` preload API 和主进程 IPC：
   `startNativeFileDrag({ resultToken })`。
2. 搜索返回结果时，主进程为当前结果集签发短期 `resultToken`，绑定规范化源路径、
   文件大小、mtime 和调用窗口；Renderer 不直接授权任意路径。
3. `ImageSearchResultGrid` 的卡片和预览图设置 `draggable`。`dragstart` 中
   `preventDefault()`，同步发送 token；主进程复核文件仍存在且签名未过期后调用
   `event.sender.startDrag({ file, icon })`。
4. `file` 必须是原文件绝对路径；`icon` 可以使用现有缩略图缓存，仅作为鼠标旁的
   拖动视觉，不是拖动载荷。
5. 第一版支持单文件；后续复用 Electron 的 `files` 字段支持结果多选拖出。
6. 卡片增加“拖出原文件”提示。对已删除、移动或 token 过期的结果显示明确错误，
   不退回为缩略图拖动。

### 4.2 验收

- JPG/PNG/WebP 从结果拖入 Photoshop 后打开的是源文件；源文件和拖入文件
  SHA-256 一致。
- 拖入微信/QQ/企业聊天软件时，普通图片按原图发送；PSD 等不受支持的图片格式按
  原工程附件发送，不转换为缩略图。
- 拖入资源管理器/桌面时复制的是原文件，文件名、扩展名和字节数一致。
- 路径越界、目录、已删除文件、伪造 token、其他窗口复用 token 均被拒绝。

## 五、功能 2：Subject 原图精细分割

### 5.1 交互

Picker 提供以下工具：

- `框选`：拖出矩形，作为 SAM box prompt。
- `加选`：左键添加前景点；拖动可生成受限数量的前景采样点。
- `减选`：右键或 Alt+左键添加背景点；拖动可生成背景采样点。
- `撤销/重做`、`清除修正`、`重新自动分割`。
- 显示原图坐标、缩放比例、蒙版覆盖层和紧边界框；放大查看只改变显示，不改变
  原图坐标。
- 每次修正复用同一原图 embedding，不重复运行 encoder，只重跑轻量 decoder。

### 5.2 IPC 与模型

1. 将 `SamPoint` 扩展为判别联合类型：
   `foreground-point`、`background-point`、`box`。
2. Box 按 SAM 约定编码成两个角点；IPC 对数量、坐标、图像边界和提示类型做验证。
3. 提示上限从 8 调整为受控的 32；画笔轨迹在 Renderer 先降采样，避免无限点输入。
4. 主进程建立短期 `segmentationSessionId`，保存：
   原文件指纹、原图尺寸、提示历史、mask、bbox 和模型版本。
5. 返回用于 UI 的压缩蒙版预览，同时将权威 mask 保留在主进程；Renderer 不把
   任意 data URL 重新提交为可信蒙版。
6. 若 decoder 支持迭代 mask input，后续修正使用前一 mask；不支持时用完整提示历史
   重新解码，结果仍然确定且可撤销。

### 5.3 蒙版真正参与搜索

1. `subject.search` 接收 `segmentationSessionId`，不再把 SAM 结果降级成 bbox。
2. 服务端从原图按 tight bbox 读取像素，并用 mask 将背景合成为中性灰和透明 PNG；
   同时保留一份矩形 crop。
3. 查询特征采用“蒙版主体特征 + 矩形上下文特征”双路融合，先记录基线再确定权重；
   hash 只作宽召回，CLIP/DINO 以蒙版主体为主要查询。
4. 人物仍走 AdaFace/OSNet；普通 YOLO 类别继续做同类候选 crop 重排；未知 SAM
   主体不再直接跳过重排，而是至少进行 DINO 蒙版查询与候选显著主体 crop 重排。
5. 缓存键包含源文件指纹、模型版本和 mask 哈希；同一修正结果可复用，原图变化后
   自动失效。

### 5.4 精度门禁

- 建立至少 50 张、覆盖人物/动物/商品/透明物体/遮挡/复杂背景的人工蒙版集。
- 报告自动单点、框选、框选+加减点三种模式的 Dice/IoU 和操作次数。
- 检索报告 P@10、P@20、nDCG、错误主体侵入率，并与当前 bbox crop 基线比较。
- 发布门槛：人工修正不得降低任何核心分类；总体 P@20 和错误主体侵入率必须有
  可重复改善。真实基线生成后锁定具体数值，禁止先猜阈值再调测试。

## 六、功能 3：PSD 等工程文件缩略图与搜索

### 6.1 支持范围

分三层推进：

1. MVP：PSD、PSB、KRA、SVG、PDF，以及带 PDF 兼容数据的 AI。
2. 扩展：EPS、TIFF 工程稿、常见 RAW。
3. 可选提供器：CLIP、CDR、INDD 等依赖已安装软件或 Windows Shell 扩展的格式。

不把“有文件图标”误报为“有内容预览”。无内容预览时显示工程文件图标和原因，
但不进入视觉相似度索引。

### 6.2 预览提供器链

按成本和可信度依次尝试：

1. 文件内嵌预览：
   - PSD/PSB：流式读取嵌入 JPEG，不整文件加载；
   - KRA：读取 ZIP 内的 `mergedimage.png`/`preview.png`；
   - SVG：安全栅格化；
   - PDF/兼容 AI：渲染第一页。
2. Windows Shell 缩略图提供器：复用系统或已安装 Adobe/设计软件注册的解码器。
3. 显式配置的外部提供器：只作为可选增强，记录版本和来源，不作为基础安装必需项。

`ag-psd` 可用于受限的 PSD 元数据/图层关键词读取，但不作为 PSB 或所有色彩模式的
唯一渲染器；读取前必须检查画布、层数、压缩尺寸和内存预算。

### 6.3 缓存与索引

1. 新增 `project-preview` 服务和独立 worker，缓存到
   `userData/project-previews/v1/`。
2. manifest 每条记录包含：
   `sourcePath`、`sourceId`、`sourceExt`、`size`、`mtime`、`provider`、
   `providerVersion`、`previewPath`、`previewHash`、`width`、`height`、
   `keywords`、`status`、`errorCode`。
3. 缓存键包含规范化路径、size、mtime 和 provider 版本；原文件改变或提供器升级
   时增量重建。
4. hash/CLIP/DINO 读取 `previewPath`，向量和搜索结果主键使用 `sourceId`；
   禁止把缓存路径写成用户可见结果。
5. 工程预览加入统一磁盘清单、安全清理、任务互斥和取消机制；只删除可重建代理，
   永不修改源工程文件。
6. 索引删除、Vector GC、迁移和备份都必须理解 `sourcePath ↔ previewPath` 映射，
   避免把代理当成 active 用户素材或把源文件误判为 stale。

### 6.4 关键词与结果卡片

内部保存稳定关键词 ID，UI 再翻译。例如：

- 通用：`project-file`、`layered`、`editable`、`vector`、`multipage`。
- PSD/PSB：`photoshop`、`psd`/`psb`、`layered`；安全解析成功后可加
  `artboard`、`smart-object`、`text-layer`。
- AI/EPS/SVG：`illustrator`、`vector`、`pdf-compatible`。
- KRA：`krita`、`layered`。

结果卡片显示紧凑 badge，如 `PSD`、`Photoshop 工程`、`分层`，并增加
`sourceKind='project'`、`sourceExt`、`keywords` 和 `previewProvider` 字段。
文件名筛选和语义文本搜索都可使用这些关键词；视觉分数仍只来自内容预览。

### 6.5 验收

- 测试夹具覆盖有/无嵌入预览、超大 PSD、PSB、损坏文件、KRA、PDF、兼容/不兼容 AI。
- 预览任务有明确的完成、不可用和错误状态；损坏文件不会拖垮扫描任务。
- 增量扫描不重建未变化工程文件；改变 mtime/size 后只重建对应代理。
- 搜索结果预览工程内容，打开/定位/拖出均作用于原工程文件。
- 结果 badge 与真实格式一致，代理缓存路径不会出现在 UI、剪贴板或拖出载荷中。
- 大文件解析受字节、像素、层数、时间和并发预算约束；峰值内存有专项测试。

## 七、实施顺序与 TODO

| 顺序 | ID      | 内容                                   | 依赖               |
| ---: | ------- | -------------------------------------- | ------------------ |
|    1 | DRAG-01 | 搜索结果单文件原生拖出与安全 token     | 无（已完成）       |
|    2 | SUBJ-01 | 原图 Picker、框选、正负点、撤销/重做   | 无（已完成）       |
|    3 | SUBJ-02 | 主进程 mask session 与蒙版查询特征     | SUBJ-01（已完成）  |
|    4 | SUBJ-03 | Subject 人工蒙版与检索精度门禁         | SUBJ-02、ACC-02    |
|    5 | PROJ-01 | 工程文件 manifest 与预览提供器框架     | 无（已完成）       |
|    6 | PROJ-02 | PSD/PSB/KRA/PDF/SVG/兼容 AI MVP        | PROJ-01（已完成）  |
|    7 | PROJ-03 | 代理视觉索引、源文件映射、关键词 badge | PROJ-02、DSK-05/06（已完成） |
|    8 | PROJ-04 | Shell/可选外部提供器与扩展格式         | PROJ-03（已完成）  |

建议先完成 `DRAG-01`，它改动小、价值直接；然后并行推进 `SUBJ-01` 与 `PROJ-01`。
`SUBJ-03` 必须等待真实人工标注工作具备足够分类，不能用单一示例宣布精度完成。

### DRAG-01 实施记录（2026-07-30）

- Hash、分层/语义和 Subject 搜索结果均由主进程签发短期拖拽 token。
- token 绑定 WebContents、源文件规范路径、size 和 mtime；主 frame 发起拖拽时再次
  验证，失效、伪造、跨窗口复用以及源文件变化都会被拒绝。
- 结果卡片使用 Electron 原生 `startDrag` 传递源文件，当前缩略图/data URL 不进入
  拖拽载荷；Renderer 只接收 token，不获得任意路径拖出能力。
- `test:file-drag` 5/5、preload/IPC 契约、完整 `npm.cmd run verify` 均通过；中文
  UI smoke 为 7/7 面板且控制台错误为 0。隔离 worktree 的 DINO/CLIP 开发态资源
  探针仍不可用，不影响本功能与完整模型测试。
- Photoshop、资源管理器及聊天软件的真实外部投放需要在合并后的用户桌面会话中
  完成最终人工互操作验收。

### SUBJ-01 实施记录（2026-07-30）

- Subject Picker 新增检测框、框选、加选主体和减选背景四种模式，以及撤销、重做和
  重置；框选保留已有正负修正点，新的修正超过上限时保留最近操作。
- UI 中缩放后的指针位置统一换算回 EXIF 校正后的原图像素；MobileSAM encoder 继续
  读取原文件，后续修正只重跑 decoder 并复用同一原图 embedding。
- SAM IPC 支持标准 box corner 标签 2/3，提示上限从 8 提高到受控的 32；Renderer
  轨迹和主进程输入均有数量/坐标边界。
- 新增原图坐标、box prompt、正负修正、容量和 UI/IPC 契约测试；真实 MobileSAM
  box prompt 已在原图夹具上通过。`test:subject-crop` 18 通过、1 个既有条件跳过，
  完整 `npm.cmd run verify` 通过。
- 当前“搜索此区域”仍使用 tight bbox，未伪装为蒙版检索；完整 mask session 与
  蒙版主体特征由下一项 `SUBJ-02` 实现。

### SUBJ-02 实施记录（2026-07-30）

- MobileSAM 分割成功后由主进程签发短期 `segmentationSessionId`；会话绑定
  WebContents、规范化原图路径、size、mtime、原图尺寸、tight bbox 和权威 PNG
  蒙版。Renderer 只能提交 opaque session ID，不能把可篡改的 data URL 当成查询蒙版。
- 搜索使用会话中的完整原图蒙版，在 tight bbox 内逐像素移除原背景，并以中性灰合成
  背景后生成无损 PNG 查询图；分层 hash/CLIP/DINO 查询读取该蒙版主体图，不再退化成
  普通矩形 JPEG crop。矩形上下文 crop 同时保留在临时工作目录，供后续双路权重评测。
- 会话默认十分钟过期，跨窗口、伪造 token、源文件路径/size/mtime 变化、蒙版尺寸与
  EXIF 校正后的原图不一致、超大蒙版查询均拒绝；主进程会话有容量和内存上限。
- 新增会话授权/过期/淘汰、buffer 隔离、背景像素真实移除、主体像素保留、尺寸错配
  和 Renderer/IPC 契约测试。完成构建后 `test:subject-crop` 26 项全部通过。
- 当前尚未宣称完成精度门禁：人工蒙版集、bbox/蒙版双路权重基线以及候选侧无类别
  SAM 主体 rerank 属于 `SUBJ-03`。

### Subject 框选覆盖层事件记录（2026-07-30）

- 现象：框选时黄色矩形与鼠标位置不一致，视觉上始终挤在图片左上角，容易继续提交
  错误区域并出现 `mask is empty`。
- 根因：覆盖层计算值是 0–100 的百分比，但以 number 传给 React 的
  `left/top/width/height`；React 将 number 解释为 CSS px。
- 修复：活动框和已提交框统一生成带 `%` 单位的样式，并增加缩放、反向拖动和无效图像
  尺寸测试。SAM 原图 prompt 坐标未改变。

### Subject 蒙版坐标事件记录（2026-07-30）

- 现象：黄色框修复后能跟随鼠标，但高分辨率图片的蓝色 SAM 蒙版仍与框选主体错位。
- 根因：encoder 将原图按长边缩放到 1024 输入，decoder prompt 却仍直接使用原图像素；
  原图越大、长宽比越偏离正方形，点和 box corner 的偏差越明显。
- 修复：缓存 encoder 实际舍入后的输入宽高，将全部正点、负点和 box corner 分轴缩放到
  encoder 坐标；`orig_im_size` 继续负责把输出蒙版还原到原图尺寸。
- 门禁：新增竖图缩放、无需缩放、非法尺寸单元测试；真实 MobileSAM 测试要求前景点击
  像素必须位于最终蒙版内，并检查 box 与输出 bbox 相交。

### Subject 原图显示事件记录（2026-07-30）

- 现象：框和蒙版坐标正确后，Picker 底图仍明显模糊。
- 根因：Picker 复用了文件管理器 `ThumbnailImage`，其缓存桶最高约 256px，随后被放大
  到约 700px 编辑区域；模型读取原图不受影响，但精细修正的视觉依据不足。
- 修复：新增主进程授权的 `sam:preview`，直接从原文件解码并按编辑区域 ×
  `devicePixelRatio` 输出最高 2048px、质量 95 的 WebP；不放大小原图。加载失败时才
  回退现有缩略图。
- 门禁：验证大图输出超过 256px、小图不放大、IPC 尺寸上限和主 frame 授权，以及
  Renderer 高 DPI 请求与安全降级契约。

### PROJ-01 实施记录（2026-07-30）

- 新增工程文件稳定分类与关键词：PSD/PSB/KRA/SVG/PDF/AI/EPS 均获得
  `project-file`、软件类型、分层/矢量/可编辑等内部关键词。
- 新增 `project-previews/v1` 原子 manifest；条目记录 source ID/path/ext、size、mtime、
  provider/version、preview path/hash/尺寸、keywords、状态和错误码。缓存键绑定源文件
  指纹和 provider 版本，损坏 manifest 自动隔离备份。
- 建立 provider 注册框架并落地首批流式 provider：PSD/PSB 只读取受限 image resources
  中的 1033/1036 JPEG；KRA 只读取受限 ZIP central directory 和
  `mergedimage.png`/`preview.png`，不整体解压工程文件。
- 预览统一安全解码为最长边 2048 的 JPEG 并原子落盘；并发同源请求合并，未变文件复用
  manifest，源 size/mtime 或 provider 版本变化时增量重建。
- 文件管理器缩略图链已接入 PSD/PSB/KRA manifest；大 PSD 不再被通用 50 MiB 门槛在
  读取嵌入预览前直接拒绝。视觉搜索索引与结果 badge 仍由 PROJ-03 接入。

### PROJ-02 实施记录（2026-07-30）

- SVG 通过独立 provider 读取并交由受限 Sharp 链路栅格化；拒绝 DTD/entity、脚本、
  `foreignObject`、事件处理器以及网络、文件和 data URL 外部资源引用，源文件上限
  16 MiB。
- PDF.js 配合随应用打包的 N-API Skia canvas 渲染 PDF 第一页，不依赖 Acrobat、
  Windows Shell 或用户安装的缩略图扩展；PDF/AI 源文件上限 256 MiB，画布最长边
  2048px、最多 1600 万像素，并关闭字体注入、Wasm 和容错继续解析。
- `.ai` 仅在文件包含 PDF 兼容数据且首屏实际渲染成功时生成预览，并在 manifest
  追加 `pdf-compatible`；传统 PostScript AI 保持 `unavailable`，不会误报内容预览。
- 文件管理器及缩略图重建链已接入 SVG/PDF/兼容 AI。工程 provider 返回不可用或
  解码错误后立即回退工程文件图标，不再绕过安全 provider 直接读取原始 SVG/工程文件。
- 发布资源清单新增 `@napi-rs/canvas` Windows x64 binding 与 ICU 数据门禁；EPS、
  Shell/外部软件 provider 仍属于 PROJ-04，视觉索引和结果 badge 由 PROJ-03 接入。

### PROJ-03 实施记录（2026-07-30）

- 原生哈希索引新增工程预览代理扫描阶段；PSD/PSB/KRA/SVG/PDF/兼容 AI
  使用缓存 JPEG 参与哈希检索，并保留源工程文件的尺寸、修改时间和稳定身份。
- DINOv2/CLIP 构建任务使用“源文件路径作为 imageId、预览代理作为模型输入”，避免
  代理路径泄漏到搜索结果；语义候选、零样本 CLIP 和精确模式颜色/形状特征同样统一解析代理。
- 哈希、分层和语义结果在主进程授权拖拽前恢复为源工程文件；打开、定位、复制路径和拖出
  均作用于原文件，未知或孤立代理采用 fail-closed 过滤。
- 结果卡片新增工程格式、显示类型和分层/可编辑/矢量/多页等关键词 badge，并支持按这些
  元数据过滤；工程结果可继续作为相似搜索输入，暂不开放 Subject 分割按钮。
- 工程源文件更新或消失时同步撤销旧代理索引和源身份向量数据；数据编辑器查询、删除、
  更新、修复及“是否已索引”检查均理解源文件与代理的映射。
- 新增工程代理索引、源身份恢复、过期清理和主进程边界契约回归；完整门禁结果随提交记录。

### PROJ-03 原生代理解码事件（2026-07-31）

- 真实目录 `<DATASET>` 复现：PSD manifest 为 `ready` 且缩略图可见，但
  原生索引中没有代理记录。直接调用 `hashImageAsync` 对旧 `.webp` 代理返回
  `unknown image type`。
- 根因是 native 将 WebP 路由到 `stb_image`，而当前编译的解码器不包含 WebP 支持；
  原专项测试使用模拟 hash adapter，只验证了映射和持久化参数，没有执行真实 native 解码。
- 工程代理统一迁移为白底 JPEG，缓存 providerVersion 增加 JPEG 编码版本，使旧
  WebP manifest 自动失效并增量重建；源工程文件身份和拖拽路径不变。
- 新增真实 native 契约测试：由 `ProjectPreviewService` 生成代理后立即交给
  `fast_scanner.node` 计算双哈希，锁定扩展名、编码版本和可解码性。
- 真实索引迁移继续发现分段 manifest 模式下 `upsertIndexRecord` 只接受已有路径，
  新生成的工程代理会返回 `Indexed path not found`；现已允许将新路径写入内存 overlay
  并追加持久化 segment。重复扫描时只展示最新 replacement segment，旧副本保持隐藏；
  native 回归覆盖“加载 manifest 后新增”和“更新后最新记录仍可搜索”。
- 真实 AI Logo 事件（2026-07-31）：`Desktop/logo/2/7.ai` 能渲染并入索引，但竖版
  `1449×2048` 画板令同一方形 Logo 的 64 位差异哈希距离达到 25。AI/SVG/EPS 代理现会
  排除大面积背景平面与细画板边线，聚焦主要矢量连通内容并补成方形；缓存版本升级为
  `jpeg-v2-vector-focus`。工程 manifest 同时持久化双哈希，查询时为工程代理保留独立
  候选通道和 2 位栅格化容差，避免大量普通图片候选挤掉真实源工程。

### PROJ-04 实施记录（2026-07-31）

- 提供器从单项选择升级为有序链：原格式内嵌/安全渲染优先，TIFF 受限直读其次，
  Windows Shell 缩略图再次，用户显式配置的外部转换器最后；任一提供器不可用或输出
  无法解码时继续尝试下一项。
- Windows Shell 使用 Electron 主进程异步缩略图 API，限制源文件大小和 15 秒调用时间；
  同时取得系统文件图标并统一缩放比较，近似相同的结果按普通图标拒绝，不进入视觉索引。
- 扩展工程类型新增 EPS、TIF/TIFF、CR2/CR3/NEF/ARW/DNG/RAF/ORF/RW2/PEF/SRW、
  CLIP、CDR 和 INDD；RAW、设计软件来源、位图/矢量/分层/多页属性写入稳定关键词和结果
  badge。没有真实内容预览的文件保持 `unavailable`。
- 外部提供器仅从主进程用户数据目录的 `project-preview-providers.json` 加载；配置要求
  绝对 `.exe` 路径、受支持扩展名、`{input}`/`{output}` 参数和受限超时，使用
  `spawn(..., shell:false)` 隐藏执行。版本缓存同时绑定可执行文件大小、修改时间和参数。
- 示例见 `docs/examples/project-preview-providers.example.json`。将其复制为
  `%APPDATA%/floating-clock-electron/project-preview-providers.json`，替换为可信转换器
  后重启应用即可；转换器必须把 PNG/JPEG/WebP 内容写到 `{output}`。
- 失败链缓存 5 分钟，避免扫描持续触发损坏 Shell 扩展或外部进程；源文件、配置、转换器
  指纹改变时立即重试。代理索引仍只暴露源工程文件身份。

## 八、测试与发布边界

- 所有新 IPC 纳入 sender 授权、参数校验、preload 契约和 capability matrix。
- 拖出到 Photoshop、资源管理器、微信/QQ 属 Windows 真实应用互操作验收，自动测试
  只负责锁定 token、源路径和 `startDrag` 参数。
- Subject 新增坐标变换、EXIF、框提示、正负点、mask 哈希、缓存失效和搜索融合测试。
- 工程文件新增解析炸弹、损坏输入、超时、取消、缓存原子写入和代理/源身份测试。
- 每个 TODO 独立提交并执行完整 `npm.cmd run verify`；涉及模型或打包资源的任务再跑
  双语 packaged smoke 和安装包资源清单。

## 九、参考

- Electron Native File Drag & Drop：
  <https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop/>
- Electron `webContents.startDrag`：
  <https://www.electronjs.org/docs/latest/api/web-contents/#contentsstartdragitem>
- `ag-psd` 能力与生产安全限制：
  <https://github.com/Agamnentzar/ag-psd/blob/master/README.md>
