# 批量命名恢复 + 主体精准搜索 — 实现交接

> 状态：部分实施
> 实施状态：全部 Phase（1.5/2/3）+ 实例级识别 + MobileSAM 点击分割 + 打包安装验证已完成；§29 中文语义搜索已实施（打包验证待做）
> 更新日期：2026-07-27  
> 项目：FloatingClock Electron  
> 实施者：Reasonix (Codex/coder)（§1–§7）；Kimi/coder（§8 起）  
> 关联方案：[批量命名恢复方案](../designs/2026-07-24-batch-rename-recovery.md)、[主体精准搜索方案](../designs/2026-07-24-subject-search-implementation.md)、[中文语义搜索方案](../designs/2026-07-27-chinese-semantic-search-plan.md)

## 0. 总览（2026-07-27，Kimi/coder）

| 节 | 内容 | 状态 |
|----|------|------|
| §8 | 批量命名 + Subject Phase 1.5 审计加固（哈希契约/topK/路径/守卫/测试链） | ✅ |
| §9 | Phase 2 人脸精准匹配（yolov8n-face + AdaFace IR-101） | ✅ 真人 0.95 vs −0.04 |
| §10 | Phase 3 行人重识别（OSNet-AIN x1.0，导出无损） | ✅ 真实库 P@50 0.98 |
| §11 | Phase 2/3 真实库实测（scripts/eval-person-search.cjs） | ✅ |
| §12 | 主体实例级识别（候选同类裁剪 DINO 重排 + 身份优先评分） | ✅ P@10 1.0 |
| §13 | 主体颜色纳入身份评分 + 实测崩溃修复（EPERM/小数坐标） | ✅ |
| §14 | 新增功能审计（死代码/子进程泄漏/日志） | ✅ |
| §15 | 多主体选择 UI（YOLO 框点选） | ✅ UI 冒烟通过 |
| §16 | 主体 embedding 缓存（JSONL 持久 + 负缓存） | ✅ |
| §17–19 | Duplicate 集成 A/B/C（完全重复/审核流/近重复 dHash） | ✅ |
| §20 | 聚类 Lineage A/B/C（schema v2 + 三操作 + 重算继承 + UI） | ✅ |
| §21 | Subject 搜索全链路进度（0–70/70–99/100） | ✅ |
| §22 | Clusters 界面选择修复 + 算法过滤 + 缩略图固定盒 | ✅ |
| §23 | MobileSAM 点击分割主体（点哪搜哪 + 面板 UX 迭代） | ✅ 5/5 测试 |
| §24 | 打包安装验证 + lint/format 门禁漂移修复 | ✅ packaged/installer 冒烟全绿 |
| §25 | SubjectPicker 蒙版 mask-mode + EXIF 坐标系修复 | ✅ 实证对齐 |
| §26 | Clusters 点击整行拉伸 + 缩略图队列饥荒/图标缓存修复 | ✅ CDP 实测 |
| §27 | Media Search 抽帧 20张/分钟均匀铺满全片 | ✅ 31/31 测试 |
| §28 | Image Search 搜索 Stop 取消 | ✅ CDP 实测 |
| §29 | 中文语义搜索（多语言文本塔路由 + 双模型切换 + 面板复用） | ✅ 真实库实测 |
| §30 | 应用图标（build/icon.ico + signExecutable 修正 + exe 嵌入验证） | ✅ 新安装包已出 |

未做：Phase 4（Florence-2 + SAM 2，边际收益存疑暂缓）、蒙版去背景查询、阈值真实库校准（Jaccard 0.5 / 近重复 d≤8）、中文语义打包验证与正式标注集门禁、§29.7 词典融合的运行时验证（用户决定止步，现状可用）。

## 1. 功能一览

### 1.1 批量图片命名恢复（已完成）

| 项目 | 内容 |
|------|------|
| **入口** | Settings → **Batch Rename** 开关 |
| **用途** | 图片修改后文件名改变，通过感知哈希匹配恢复原名 |
| **原理** | `hashImageFileAsync` (fast_scanner C++) → JS 汉明距离 → copyFile |
| **新模型** | 0 |

### 1.2 主体精准搜索（Phase 1.5 完成）

| 项目 | 内容 |
|------|------|
| **入口** | Image Search 结果中每条结果的 **Subject** 按钮 |
| **检测** | YOLOv8-nano ONNX (12.9MB, 80类+ NMS) → 梯度显著性 → center crop 三级降级 |
| **搜索** | `searchLayered` (hash + DINOv2 ANN 索引) |
| **topK** | 最大 1000，复用 Image Search Top K 控件 |
| **新模型** | 1 个 (yolov8n.onnx, 已下载到 `models/yolov8n/`) |

## 2. 新增文件清单

### 批量命名恢复

| 文件 | 说明 |
|------|------|
| `electron/batchRenameService.ts` | 核心：哈希匹配 + 文件复制流水线 (~250行) |
| `electron/batchRenameIpc.ts` | IPC 注册 (5 通道) |
| `src/services/batchRenameBridge.ts` | 前端封装 |
| `src/components/BatchRenamePanel.tsx` | UI 面板 |

### 主体精准搜索

| 文件 | 说明 |
|------|------|
| `electron/subjectSearchService.ts` | 核心：YOLO检测 → 裁剪 → searchLayered (~450行) |
| `electron/subjectSearchIpc.ts` | IPC 注册 (3 通道) |
| `src/services/subjectSearchBridge.ts` | 前端封装 |
| `models/yolov8n/model.onnx` | YOLOv8-nano ONNX 模型 (12.9MB) |

### 修改的文件

| 文件 | 变更摘要 |
|------|---------|
| `shared/ipc-contract.ts` | `BatchRename*` + `Subject*` 类型，`batchRename` + `subject` API |
| `electron/preload.ts` | `batchRename` + `subject` 命名空间 |
| `electron/main.ts` | 注册 `registerBatchRenameIpc` + `registerSubjectSearchIpc` |
| `src/stores/useStore.ts` | `showBatchRename` + 位置/大小/toggle/placement/restore |
| `src/config/panelRegistry.ts` | `batchRename` lazy panel (preloadOrder: 35) |
| `src/App.tsx` | BatchRename: selector/snap/visibility/settings；Subject: handler + grid 集成 |
| `src/components/SettingsPanel.tsx` | Batch Rename 开关 |
| `src/components/ImageSearchResultGrid.tsx` | Subject 按钮 (5 列网格) |
| `src/components/ImageSearchPanel.tsx` | handleSubjectSearch：结果写入主 grid，清空 layeredResults 和 searchQuery |
| `src/services/settingsVisibility.ts` | `batchRename` 加入 PersistedPanelKey |
| `package.json` | `models/yolov8n` 加入 extraResources |

## 3. 当前状态

### ✅ 已完成

| 功能 | 阶段 | 核心模型 |
|------|------|---------|
| 批量命名恢复 | 全部 | fast_scanner (复用) |
| 主体检测 | Phase 1.5 | YOLOv8-nano ONNX |
| 主体搜索 | Phase 1.5 | DINOv2 + fast_scanner (复用) |

### ⏳ 待实施

| 阶段 | 内容 | 模型 | 预计 |
|------|------|------|------|
| ~~Phase 2~~ | ~~人脸精准匹配~~（已完成 2026-07-26，见 §9） | yolov8n-face (11.7MB) + AdaFace IR-101 (260MB) | 已完成 |
| ~~Phase 3~~ | ~~全身行人重识别~~（已完成 2026-07-26，见 §10） | OSNet-AIN x1.0 (8.7MB) | 已完成 |
| Phase 4 | 开放词汇检测 + SAM 分割 | Florence-2 (300MB) + SAM 2 (40MB) | ~4天 |

## 4. 已知行为 & 注意事项

### 4.1 搜索精度与 topK 的关系

| topK | 结果数 | 精度 | 原因 |
|------|--------|------|------|
| 高 (1000) | 少 (≈19) | **高** | DINOv2 向量候选有限，hash 噪声被精排过滤 |
| 低 (50) | 多 (≈48) | **混入噪声** | hash 层灌入背景相似但主体不同的图 |

> `searchLayered` 的 `rerankTopK` 控制最终输出数。hash + vector 合并后精排，hash 候选多但质量低，vector 候选少但质量高。当前评分权重：hash 0.5 + vector 0.5。如需更高精度，可调为 hash 0.3 + vector 0.7。

### 4.2 YOLO 模型路径

```
开发环境: models/yolov8n/model.onnx
打包环境: process.resourcesPath + '/models/yolov8n/model.onnx'
```

代码已自动按优先级查找三个候选路径。首次加载会创建 ONNX session（~2秒），之后缓存复用。

### 4.3 YOLO 三级降级

```
YOLOv8-nano (80类检测 + NMS)
  ↓ 模型不存在/推理失败
Sobel 梯度显著性 (边缘密度定位)
  ↓ 图像无显著梯度
center crop (取中心 70%)
```

### 4.4 代理下载

模型通过 v2rayN 代理 (127.0.0.1:<port>) 下载。后续下载新模型需配置代理：

```bash
# 在 Node 脚本中
import { HttpsProxyAgent } from 'https-proxy-agent'
const agent = new HttpsProxyAgent('http://127.0.0.1:<port>')
```

### 4.5 searchBySubject 流水线

```
查询图片
  → detectSubjects() → [YOLO→saliency→center] → 返回 bbox[]
  → sharp 按 bbox[0] 裁剪 → 临时 jpg
  → searchLayered({ imagePath: crop, hashTopK: max(500,topK*4), vectorTopK: topK, rerankTopK: topK })
  → 过滤掉查询图片自身
  → 返回 SubjectSearchResult[]
```

## 5. 技术决策记录

| 决策 | 原因 |
|------|------|
| YOLO 内联而非子进程 | 单图检测 ~200ms，子进程 overhead 更大 |
| 复用 searchLayered | 避免读取 5.3GB embedding shard 文件 |
| 清空 layeredResults | sortedResults 优先取 layeredResults，会导致 Subject 结果被忽略 |
| 清空 searchQuery | grid 按 searchQuery 过滤 path，设成文件名会误杀结果 |
| 不设独立 Subject 面板 | 降低复杂度，直接复用 Image Search grid |
| 梯度显著性作为 fallback | YOLO 模型可能丢失或失败，确保功能可用 |

## 6. 测试清单

- [ ] Batch Rename：选原始/改名/输出文件夹 → 开始 → 验证匹配结果
- [ ] Subject 基础：Image Search 有结果 → 点击 Subject → grid 刷新
- [ ] Subject topK：改 Top K 到 10/50/100/1000 → 验证结果数
- [ ] Subject 不同场景：人物图 / 物品图 / 纯色背景图
- [ ] YOLO 降级：删除 `models/yolov8n/model.onnx` → 验证回退到梯度显著性
- [ ] 打包后 YOLO 路径：`npm run build` → 安装 → 验证模型加载

## 7. 下一步

1. **Phase 2**：下载 RetinaFace + AdaFace ONNX，接人脸匹配
2. **精度调优**：根据实际使用反馈调整 `searchLayered` 评分权重
3. **性能**：YOLO 推理 ~200ms，如需更快可考虑 WebNN/GPU 后端

## 8. 审计与加固（2026-07-25，Kimi/coder）

> 执行身份：Kimi；代理系统：Kimi 运行时。只读接手后按[确认规范](../reference/model-runtime-and-document-confirmation.md)完成审计，以下为本轮修复。

### 8.1 修复的问题

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 1 | `batchRenameService` 按 `number` 校验/比较哈希，但 `ImageHashResult` 的 `diffHash64`/`dctHash64` 是 **16 位十六进制字符串** | **功能整体不可用**：origin 哈希全部被判无效 → "No origin images could be hashed"；typecheck 直接报错 | 新增 `electron/perceptualHashMatch.ts`，哈希统一按 hex 字符串 → BigInt 计算汉明距离；服务改用字符串契约 |
| 2 | `subject:search` IPC 把 topK 钳到 ≤50（超出静默回退 20），与文档"最大 1000，复用 Top K 控件"矛盾 | 用户选 Top K 100/1000 时结果数被静默改写 | 钳位改为 1–1000，非法回退 20 |
| 3 | YOLO 模型路径候选缺 `process.resourcesPath/models/yolov8n`（`package.json` extraResources 的实际打包位置） | 打包后模型找不到，静默降级到梯度显著性 | 候选列表补齐 dev/packaged/legacy 四个路径，dev 的 `__dirname/../models` 优先 |
| 4 | `batchRename:start` 三个目录参数无 path guard | 不符合 PIO-P2-06 约定 | IPC 层统一 `normalizeUserPath` |
| 5 | 批量命名无并发运行守卫，模块级单例状态会被第二次 start 冲掉 | 并发任务互相覆盖进度/结果 | 运行中（非 done/stopped/error）拒绝新任务 |
| 6 | `subjectSearchService.ts` 重复 `import { searchLayered }` 两次 | 潜在编译错误 | 删除中部重复导入 |
| 7 | 两个功能零测试，未挂测试链 | 回归无保障 | 新增 `tests/batch-rename.test.cjs`（哈希匹配 7 项）+ `tests/subject-detection.test.cjs`（IoU/NMS 5 项），挂入 `test:batch-rename` 并加入 `npm test` 链 |
| 8 | `ipc-capability-matrix.md` 未登记 8 条新通道 | 权限边界失控 | 已登记 BatchRename/SubjectSearch 全部通道 |

### 8.2 纯函数拆分

- `electron/perceptualHashMatch.ts`：popcount64 / combinedScore（hex string → BigInt）/ isImageFile，electron-free 可测。
- `electron/subjectBoxes.ts`：SubjectBBox / iou / nms，从 subjectSearchService 拆出，避免测试加载 sharp + onnxruntime 全图。

### 8.3 验证记录（2026-07-25）

| 命令 | 结果 |
|------|------|
| `npm run typecheck` | 通过（修复前报 1 个 TS2345） |
| `npm run test:batch-rename` | 12/12 通过 |
| `npm run test:ipc-registration` / `test:preload-contract` / `test:ipc-validation` / `test:guards` | 4/4、1/1、4/4、9/9 通过 |
| ESLint（8 个相关文件） | 0 error 0 warning（顺带清除 subjectSearchIpc 2 个既存警告） |
| Prettier（6 个相关文件） | 已格式化并通过 check |
| `npm test` 全链 | 通过（含 `test:batch-rename` 12 项、native 35/35；链式执行全绿） |

### 8.4 仍未验证（保持 §6 手工清单）

- 真实图片的端到端 Batch Rename 匹配效果（哈希修复后需首次实测）
- Subject 搜索真实场景精度与 YOLO 降级路径
- 打包安装后 YOLO 模型加载（路径候选已修，未实测）

## 9. Phase 2 人脸精准匹配（2026-07-26，Kimi/coder 实施）

> 实施状态：已实现并通过模型级集成验证；UI 端到端与打包验证待做。

### 9.1 模型选型结果（与方案有偏差，已验证）

| 环节 | 方案 | 实际落地 | 偏差原因 |
|------|------|----------|----------|
| 人脸检测 | RetinaFace（3MB） | **yolov8n-face-lindevs**（11.7MB，MIT，SHA-256 校验通过） | 现成 RetinaFace ONNX 只有 R50（109MB）且解码格式风险高；yolov8-face 复用 YOLO 解码路径 |
| 关键点对齐 | 5 点关键点仿射 | **bbox 伪关键点**（标准面部比例 → 同一 estimateSimilarity 仿射路径） | 调研发现 yolov8n-face 与 lindevs 发布权重均无 kpt 分支（state_dict 验证）；旋转矫正缺失，居中/缩放保留 |
| 人脸特征 | AdaFace（5MB） | **AdaFace IR-101 WebFace12M**（260MB，Apache-2.0） | 小模型无可信 ONNX；IR-101 精度更高，体积可接受（小于已有 CLIP+DINO 315MB） |

### 9.2 实现

- `electron/faceMatchService.ts`：检测（conf≥0.3，NMS 复用 subjectBoxes）→ 伪关键点/真关键点自适应 → ArcFace 模板对齐 → AdaFace 512d（L2 归一化）；每级失败均降级 ok:false。
- `electron/faceAlign.ts`（纯函数）：Umeyama 相似变换、仿射求逆、余弦、L2 归一化。
- 对齐实现说明：sharp 不暴露 libvips affine 的 `oarea`，输出尺寸不可控（首版 bug 导致对齐图未裁剪、相似度失真）；改为逆映射外接矩形 `extract + resize`，旋转分量为零时与仿射重采样等价。
- `electron/subjectSearchService.ts`：subject label 为 `person` 时启用 `rerankByFace`——查询 crop 提取人脸 embedding，对前 100 条候选并发 4 路重算，`score = max(faceSim, dinoScore×0.85)`，重排；无脸/模型缺失候选保留 dino×0.85。命中人脸的结果 `modelName='adaface+dinov2'`。
- 打包：`package.json` extraResources 增加 `models/yolov8n-face`、`models/adaface`；模型路径解析与 yolov8n 同一候选顺序（dev `__dirname/../models` → packaged `resourcesPath/models`）。

### 9.3 验证（2026-07-26）

| 验证 | 结果 |
|------|------|
| 真人端到端（公有领域白宫肖像 fixture） | sim(同人 缩放+重压缩)=**0.9493**，sim(不同人)=**−0.0447**，区分度达标 |
| `tests/face-align.test.cjs` | 7/7（相似变换/求逆/余弦/L2） |
| `tests/face-match.test.cjs` | 5/5（检测、512d 单位向量、同人>0.6 异人<0.3、缺文件降级）；模型缺失时自动 skip |
| typecheck / ESLint / Prettier | 通过 |
| 测试链 | `test:face-match` 已加入 `npm test` |

### 9.4 已知边界

1. 无关键点旋转矫正：大角度侧脸/歪头对齐精度下降（等关键点检测器就绪后升级同一仿射路径）。
2. 人脸重排限前 100 条候选（每条一次检测+一次 embedding，控制耗时）。
3. 未做 UI 端到端实测与打包安装验证（§6 清单同样适用 Phase 2）。
4. YOLOv8n（COCO）为 AGPL-3.0，商用再分发需评审（已记入 THIRD_PARTY_NOTICES）。

### 9.5 下一步（Phase 3/4 不变）

- Phase 3：OSNet-AIN 全身行人重识别（人脸不可见时兜底，设计上 ×0.85 的 DINO 路径即是现状）
- 可选增强：换用带关键点的人脸检测器（RetinaFace mobile0.25 ONNX 或 SCRFD，注意 SCRFD 的 InsightFace 权重授权限制）

## 10. Phase 3 全身行人重识别（2026-07-26，Kimi/coder 实施）

> 实施状态：已实现并通过模型级集成验证；准确率边界见 §10.4。

### 10.1 模型选型结果

| 环节 | 方案 | 实际落地 | 偏差原因 |
|------|------|----------|----------|
| 行人特征 | OSNet-AIN（8MB） | **OSNet-AIN x1.0**（ONNX 8.7MB，MIT，SHA-256 校验通过） | 与方案一致；来源 LibreYOLO/LibreReID-osnet（torchreid 移植，权重 MSMT17+DukeMTMC+CUHK03 训练） |
| 备选评估 | — | anriha/osnet_x0_25_msmt17（0.9MB 现成 ONNX） | 实测 Portrait 分离度弱且输入固定 batch=16，弃用 |

导出：libreyolo `OSNetEmbedder` 构建模型 + 加载 state dict → `torch.onnx.export`（opset 17，动态 batch）；**torch vs ONNX 输出余弦 = 1.0**，导出无损。预处理确认为 RGB + ImageNet mean/std（实测四变体中分离度最好）。

### 10.2 实现

- `electron/personReidService.ts`：person crop（可选 bbox）→ 256×128 → OSNet 512d（L2 归一化）；动态 batch，每次最多 16 张；单张坏图不影响整批。
- `electron/subjectSearchService.ts`：`rerankByFace` 升级为 `rerankPerson` 两阶段重排——
  1. 并发 4 路对前 100 候选尝试人脸 embedding；无脸候选跑 YOLOv8n 找 person bbox；
  2. 无脸且有 person bbox 的候选批量过 OSNet。
  - 查询侧：crop 有人脸用 AdaFace，无人脸用 OSNet；评分 `max(faceSim, osnetSim, dino×0.85)`，命中来源标记 `modelName='adaface+dinov2' | 'osnet+dinov2'`。
- 打包：extraResources 增加 `models/osnet`。

### 10.3 验证（2026-07-26）

| 验证 | 结果 |
|------|------|
| 权重完整性 | SHA-256 与发布页一致；torch/ONNX 输出余弦 1.0 |
| `tests/person-reid.test.cjs` | 5/5（512d 单位向量、坏图降级、bbox crop、同图变体相似度 >0.5）；模型缺失自动 skip |
| typecheck / ESLint / Prettier | 通过 |
| 测试链 | `test:person-reid` 已加入 `npm test` |

### 10.4 已知边界（重要）

1. **正装半身肖像场景 OSNet 区分度弱**：实测 Obama 2012 vs 2009 = 0.75（x0.25）/ 0.77（x1.0），而 Obama vs Trump = 0.69 / 0.83——深色西装等着装相似性主导 reid 特征，不同人可能高于同人。OSNet 的设计场景是**同人同着装**的连拍/监控关联（该场景相似度极高且稳定），且它只作为无人脸时的兜底信号、与 DINO×0.85 取 max，不会压低 DINO 原有排序。
2. 未做 UI 端到端与打包安装验证。
3. reid 训练数据集带研究用途条款，生产级行人再识别部署前需评审（已记入 THIRD_PARTY_NOTICES）。

### 10.5 下一步

- Phase 4：Florence-2 + SAM 2（开放词汇检测与精细分割，预计 ~4 天，大模型 ONNX 兼容性风险高）
- 建议先在真实素材库实测 Phase 2/3 的 person 搜索效果，再决定 Phase 4 投入

## 11. Phase 2/3 真实素材库实测（2026-07-26，Kimi/coder）

> 工具：`scripts/eval-person-search.cjs`（只读真实库，可复跑）
> 数据集：分类 test01（id=12，AI 生成同一身份人像系列）116 张 confirmed 正样本 + 60 张随机干扰；查询为第 1 张正样本。

### 11.1 结果

| 信号 | 检出/覆盖 | avg 正样本 sim | avg 干扰 sim | 分离度 | P@10 | P@20 | P@50 |
|------|-----------|---------------|-------------|--------|------|------|------|
| AdaFace（Phase 2） | 42/116 正样本检出人脸 | 0.1481 | 0.0730 | 0.075 | **1.000** | 0.950 | 0.820 |
| OSNet（Phase 3） | 175/175 全覆盖 | 0.5477 | 0.2801 | **0.268** | **1.000** | **1.000** | **0.980** |
| max(face, osnet) | 175/175 | 0.5477 | 0.2801 | 0.268 | 1.000 | 1.000 | 0.980 |

### 11.2 结论

1. **OSNet 是该真实库的主力信号**：P@20=1.0、P@50=0.98、分离度 0.268，实测有效。§10.4 记录的正装肖像弱点在此材质上不成立（同身份不同着装/姿态/构图）。
2. **人脸检出率 36% 是材质决定的，不是检测器失败**：人工抽查确认未检出图均为腿部/下半身特写视频帧（该分类不含脸）。这正验证了 Phase 3 兜底路径的必要性。
3. **AdaFace 在 AI 生成脸上分离度偏低**（0.075）：真人脸实测 0.95 vs −0.04（§9.3），生成脸同人仅 ~0.15。对生成/动漫风格人脸，AdaFace 不宜作为唯一高分来源——当前融合策略（max + DINO×0.85 地板）刚好规避了这个问题。
4. 实测发现并修复：`detectFaces` 对无法解码的图片（webp 变体等）抛异常中断批量重排，已改为降级 `ok:false`（回归测试已入 `tests/face-match.test.cjs`）。
5. person-crop 内二次人脸检测对检出率无提升（实验 20/40 → 20/40），未采纳。

### 11.3 对 Phase 4 决策的影响

Phase 2/3 在真实库上已达到 P@50 0.98（该数据集）。**Phase 4（Florence-2 + SAM 2，340MB）的边际收益存疑**，建议把优先级让给：
- 其余分类的准确率回归（当前实测仅 test01 单分类，代表性有限）
- 真实 UI 端到端验证与打包安装验证（§6 清单）
- 若需提升生成人脸匹配：换带关键点的检测器改善对齐，或评估对生成脸更鲁棒的特征

## 12. 主体实例级识别改造（2026-07-26，Kimi/coder）

> 需求来源：用户明确"主体相似识别 = 同一实例（这个人/这个物品），不是同风格/同场景"。

### 12.1 问题定位

1. **物体主体无身份信号**：查询是主体裁剪 embedding，候选是整图 embedding——场景/风格必然混入。实证：整图 DINO 对 Obama vs Trump 官方肖像相似度 0.742（完全不同人，同风格场景）。
2. **person 评分中风格可压过身份**：旧 `max(identity, dino×0.85)` 让整图高分的风格匹配可超越真身份匹配。

### 12.2 实现

- `electron/subjectCropEmbedder.ts`：持久 DINOv2 embedding 子进程（复用 dinoEmbeddingChild 批量协议，16/批），重排 100 个候选只付一次模型加载；子进程路径补 `__dirname/../dist-electron` dev 回退（对齐 assetTaskWorkerHost 先例）。
- `electron/subjectSearchService.ts`：
  - **物体主体**：`rerankBySubjectCrop`——候选 YOLO 检测同类别主体 → 裁剪 → DINO embedding → 与查询 crop 余弦。
  - **身份优先评分**（person/object 一致）：有身份信号（face/osnet/crop sim）时分数 = 身份相似度，风格分不再参与；无身份信号的候选保留 dino×0.85 地板。
  - 结果标记 `modelName='dinov2-crop'`（物体）、`'adaface+dinov2' | 'osnet+dinov2'`（人物）。

### 12.3 实测（真实数据，`scripts/eval-object-search.cjs`）

视频片段 0027161b 的 29 帧（同一车辆实例，视角/遮挡变化）为正样本 + 60 随机干扰：

| 方法 | avg 正样本 | avg 干扰 | 分离度 | P@10 | P@20 | P@30 |
|------|-----------|---------|--------|------|------|------|
| 整图 DINO（旧基线） | 0.3506 | 0.1051 | 0.246 | 0.800 | 0.900 | 0.862 |
| 同类裁剪 DINO（新） | 0.4438 | 0.3930 | 0.051 | **1.000** | 0.900 | **0.966** |

解读：
1. 新路径 P@10 满分、P@30 显著优于基线（0.966 vs 0.862）——**实例级精度目标达成**。
2. 分离度数值上基线更高（0.246 vs 0.051），但这是假象：基线的高分离来自"场景像不像"，含车干扰项少；新路径的干扰项全部是**真车**（同类硬负例），轿车 crop 之间本来就像，0.05 差距属于正常水平，且排序指标全胜。
3. 无同类主体的候选沉底（score=-1 地板语义），符合"找不到该主体就不是这个实例"的身份逻辑。

### 12.4 验证

| 验证 | 结果 |
|------|------|
| `tests/subject-crop-embedder.test.cjs` | 3/3（持久子进程多图 embedding、768d 单位向量、坏图降级子进程不死；模型缺失自动 skip），已入 `test:subject-crop` 和 `npm test` 链 |
| typecheck / ESLint / Prettier | 通过 |
| 既有套件 | face-match 13/13、person-reid 5/5、batch-rename 12/12 无回归 |

### 12.5 已知边界

1. 物体身份完全依赖 YOLO 检测出同类别主体；检测不到 → 候选吃 dino 地板（设计如此）。
2. 每次 Subject 搜索对前 100 候选现场检测+embedding（~10–30s 量级），未做跨搜索缓存；高频使用后可加 crop embedding 缓存。
3. person 分支的 crop DINO 未启用（face/osnet 已构成身份信号，避免三重成本）。

## 13. 主体颜色纳入身份评分（2026-07-26，Kimi/coder）

> 需求来源：用户反馈"不同颜色的物品也混入搜索结果"。

### 13.1 实现

- `colorFeatureService.ts` 新增两个导出（不改既有 Layer 3 语义）：
  - `computeImageColorHist(imagePath, region?)`：纯函数式 HSV 直方图（不写库），支持主体 bbox 区域。
  - `colorIdentitySimilarity(a, b)`：身份导向颜色相似度。既有 `colorSimilarity` 是 H/S/V 三个边缘直方图等权，红 vs 蓝仍有 0.67（饱和/亮度相同）；身份场景改为 **hue 0.6 / sat 0.2 / val 0.2**。
- 融合权重：`identity = 特征相似度 × 0.75 + 颜色身份相似度 × 0.25`，作用于：
  - 物体主体：crop DINO 分数（直方图取自主体裁剪图）。
  - 人物无脸路径：OSNet 分数（直方图取自 person bbox 区域，即服装颜色）。
  - 人脸路径不加（人脸 crop 的颜色无身份意义）。

### 13.2 验证

| 验证 | 结果 |
|------|------|
| `tests/color-identity.test.cjs` | 4/4（同图=1、身份相似度分红/蓝 <0.45 且优于 flat、区域直方图正确、坏图降级 null），已入 `test:subject-crop`（7/7） |
| 真实数据复测（车辆片段） | P@10/20/30 保持 1.000，avg 正样本分 0.444→0.479（得分区分度提升，颜色一致的正样本得分更高） |
| 回归 | typecheck / ESLint / Prettier / face-match 13/13 / person-reid 5/5 / batch-rename 12/12 / vector-pipeline 23/23 全绿 |

### 13.3 边界

1. 颜色权重 0.25 是经验值；同色异实例（白T恤 vs 白衬衫）仍主要靠 DINO/OSNet 特征区分。
2. 光照导致的色相偏移会轻微影响颜色项（实测同车不同帧 avg 0.479 < flat 版的 0.504，属预期代价——换得更强的错色压制）。

### 13.4 临时目录 EPERM 修复（2026-07-26 实测反馈）

用户实测遇到 `EPERM, Permission denied: %TEMP%\fc-crops-XXXX`：crop 重排的临时目录清理（`fs.rmSync`）未捕获，Windows 索引/杀软短暂占用导致清理失败时**整个搜索失败**。修复：
1. 清理失败不再传播——后台 5s 重试一次，仍失败则留给 OS 临时目录清理。
2. `mkdtempSync` 失败时跳过重排保留基础结果，不再中断搜索。
3. 已清理存量残留目录；typecheck / ESLint / Prettier / subject-crop 7/7 验证通过。

### 13.5 小数坐标导致 sharp extract 失败（2026-07-26 实测反馈）

用户实测遇到 `Expected integer for top but received 543.5`：YOLO 无检测结果时走梯度显著性降级路径，`cx - cw / 2` 在 cw 为奇数时产生 .5 小数 bbox，`sharp.extract` 拒绝小数坐标。修复：显著性路径的 sx/sy 增加 `Math.round`（YOLO 与 center-crop 路径此前已取整）。奇数尺寸合成图端到端验证：bbox 全整数、extract 成功。

### 13.6 主主体误选小物件（卡通猫圆形眼睛，2026-07-26 实测反馈）

现象：搜索卡通猫（圆形眼睛）时首次 Subject 结果是"圆形 icon"，二次 Subject 才正常。根因：`searchBySubject` 固定取 `subjects[0]`（NMS 置信度最高者）——小而高置信度的圆形区域（眼睛被误判为 sports ball 等）压过真正的大主体（猫）。修复：

1. `subjectBoxes.ts` 新增 `pickPrimarySubject`：YOLO 检测中**按面积取最大**（主主体意图），仅在无 YOLO 检测时使用显著性/center 伪主体。
2. `searchBySubject` 响应新增 `subjectLabel`，UI 成功时 toast 回显 `Subject: cat · N results`——主体选错时用户能立刻看到搜的是什么。
3. 边界（未覆盖）：若 YOLO 完全没检出猫（卡通形象超出 COCO 分布）而只检出眼睛，最大面积规则仍选中眼睛——这类 case 需要多主体选择 UI（设计文档 Phase 1 的主体叠加层）或开放词汇检测（Phase 4）才能根治，暂记录。

验证：`tests/subject-detection.test.cjs` 新增 3 项（小高置信 vs 大低置信、伪主体兜底、空输入），batch-rename 套件 15/15；typecheck / ESLint / Prettier / preload-contract 全绿。

## 14. 新增功能审计（2026-07-26，Kimi/coder）

对 Phase 2/3 及身份重排新增模块的系统审计，结论与修复：

### 14.1 已修复

| # | 问题 | 修复 |
|---|------|------|
| 1 | `embedSubjectCrop` + `spawnEmbedding` 死代码（无 IPC/调用方，功能已被 SubjectCropEmbedder 取代，~180 行） | 删除，连带清理 `getChildPath`/`buildChildEnv`/未用 import |
| 2 | `SubjectCropEmbedder.create()` 失败路径泄漏子进程（ready 超时/启动失败时 child 不 kill，模型加载中的进程残留） | 失败时先 `child.kill()` 再返回 null |
| 3 | `searchBySubject` 残留调试 `console.log`（每次搜索打两行日志） | 删除 |

### 14.2 审计确认无问题项

- IPC 边界：`subject:detect/search` 均走 `normalizeUserPath`，topK 钳 1–1000；Phase 2/3 无新增通道（内部服务），能力矩阵无需变更。
- 并发：`InferenceSession.run` 并发安全（ORT 设计）；rerank worker 游标在 JS 单线程内安全。
- 降级链：检测失败→伪主体、人脸失败→OSNet、OSNet/embedding 失败→dino 地板、模型缺失→跳过 rerank、临时目录失败→不中断搜索，均有测试或实测覆盖。
- 临时文件：query crop（fc-subject-）与候选 crop（fc-crops-）均有 finally 清理 + EPERM 重试兜底。

### 14.3 记录的已知折中（不修复）

1. **AdaFace ONNX session 常驻 ~260MB**：首次人脸搜索后常驻主进程内存（懒加载、无卸载），与其他模型 session 策略一致；低内存场景可后续加闲置卸载。
2. 每次 Subject 搜索现场重排前 100 候选（YOLO+embedding，10–30s 量级），无跨搜索缓存。
3. eval 脚本环境差异：`eval-object-search.cjs` 需要 electron stub（已加），`eval-person-search.cjs` 不依赖 modelService 无需 stub。

### 14.4 验证

typecheck / ESLint / Prettier 全绿；subject-crop 7/7、face-match 13/13、person-reid 5/5、batch-rename 15/15、ipc-registration 4/4、preload-contract 1/1；`eval-object-search.cjs` 复跑确认身份管线行为不变。

## 15. 多主体选择 UI（2026-07-26，Kimi/coder）

> 对应文档待办"多主体选择 UI"，也是 §13.6 卡通猫误选边界的根治方案。

### 15.1 实现

- 流程：点 Subject → `subject:detect` → 1 个主体直接搜（带 bbox，不再二次检测）；>1 个弹出 `SubjectPickerModal`——查询图上叠加可点击的主体框（label + 置信度），点哪个搜哪个；`Auto (largest)` 保持原默认。
- `subject:search` IPC 增加可选 `subject` 参数：类型/范围校验（x,y≥0，4≤w,h≤100000），服务端再按真实图片尺寸钳位；不带 bbox 时行为与之前完全一致。
- 新组件 `src/components/SubjectPickerModal.tsx`（bbox 以图片百分比定位，stage 用 `aspectRatio` 对齐防止 letterbox 错位）；样式入 `src/styles/global.css`。
- 顺带清理 preload 5 个未用类型 import 警告（属本功能范围）。

### 15.2 验证

| 验证 | 结果 |
|------|------|
| typecheck / ESLint / Prettier | 通过 |
| preload-contract / ipc-registration / ipc-validation | 1/1、4/4、4/4 |
| Electron UI 冒烟（`smoke:ui`） | 通过（runtimeCheck 全 true，备份 6 项全 true） |

### 15.3 边界

1. 选择器依赖 YOLO 检测出主体；YOLO 完全认不出（卡通形象出分布）时仍只有显著性兜底单主体——选择器不弹出（只有 1 个候选）。
2. detect 与后续搜索之间有竞态窗口（用户点选期间图片被移动/删除），服务端钳位 + 错误降级覆盖。

## 16. 主体 embedding 缓存（2026-07-26，Kimi/coder）

> 对应文档待办"crop embedding 缓存 / subjectEmbeddingStore"，消除每次搜索对前 100 候选的现场重算。

### 16.1 实现

- `electron/subjectEmbeddingStore.ts`：`<userData>/subject-embeddings/embeddings.jsonl` 追加式持久缓存，键为 `kind|path|mtime`（kind: `face` / `osnet` / `crop:<label>`）；内存 Map + 5000 条上限，超限压缩丢弃最旧 25%；写操作串行队列防交错；损坏行静默跳过（缓存永不成致命点）。
- 接线（`subjectSearchService.ts`，三条重排路径全覆盖）：
  - 人脸：`cachedFaceEmbedding`，含**负缓存**——"no face detected"写空数组标记，已知无脸图不再重复检测；瞬时失败不缓存。
  - OSNet：`cachedEmbedPersonCrops` 先查缓存、只对缺失项批量重算。
  - 物体 crop DINO：`rerankBySubjectCrop` Phase 2 同样先查后算。
- key 含 mtime——图片被修改后自动失效重算。

### 16.2 验证

| 验证 | 结果 |
|------|------|
| `tests/subject-embedding-store.test.cjs` | 4/4（key 格式、mtime、正负标记往返、JSONL 持久化），已入 `test:subject-crop`（11/11） |
| 回归 | typecheck / ESLint / Prettier / face-match 13/13 / person-reid 5/5 / batch-rename 15/15 |

### 16.3 边界

1. **端到端提速未基准化**：二次搜索理论上只剩 YOLO 检测（~200ms×100 并发 4 ≈ 5s）省去全部 embedding 重算；未跑 before/after 基准（rerank 函数未导出，需应用内实测确认）。
2. OSNet/crop 的 key 不含 bbox——同一图片同模型检测 bbox 确定性成立；换检测模型后旧缓存可能指向不同裁剪（影响小，向量仍属该图主体）。
3. 缓存目录随 userData 备份策略之外，上限 5000 条（约 20–30MB JSONL）。

## 17. Duplicate Finder 集成阶段 A（2026-07-26，Kimi/coder）

> 对应[集成方案](../designs/2026-07-18-neko-search-duplicate-integration.md)阶段 A：完全重复组构建 + 组落库 + 列表浏览。

### 17.1 实现

- `assetLibraryService.buildLibraryDuplicateGroups()`：权威路径清单（`activePathIndexEntries`）→ `findExactDuplicateGroups`（大小预分组 + SHA-256，并发 16，可取消，进度事件）→ 组落 `cluster_groups`/`cluster_members`（`algorithm='duplicate_exact'`），同算法组**原子替换**（幂等），其他算法组保留；代表图 = 最早入库（最小 asset id）；sqlite/jsonl 双写路径齐备。
- 类型：`AssetClusterGroup.algorithm` 增加 `'duplicate_exact' | 'duplicate_near'`；`AssetLibraryTaskType` 增加 `'duplicate_scan'`。
- IPC/UI：`assetLibrary:buildDuplicateGroups`（无参数，已登记能力矩阵）；Clusters 工作区新增 **Build duplicates** 按钮；组列表显示 `Duplicate` 徽标；重复组禁用"Convert to category"（设计上不参与分类）。列表浏览直接复用现有 Clusters 视图（`listClusters` 已覆盖新算法）。

### 17.2 验证

| 验证 | 结果 |
|------|------|
| `tests/library-duplicate-build.test.cjs` | 3/3（分组+落库+代表图语义、重建幂等、缺失文件跳过），已入 `test:duplicate-finder`（15/15） |
| 回归 | asset-library 95/95、ipc-registration 4/4、preload-contract 1/1、typecheck/ESLint/Prettier |

### 17.3 未做（阶段 B/C，保持方案排期）

- 阶段 B：处置建议（`suggestions.source='duplicate'`）+ Accept→软归档审核流。
- 阶段 C：近重复（native dHash 并查集分组），阈值需真实库抽检校准。
- 真实 18.7 万库的全量构建未跑（SHA-256 全量哈希为长任务，由用户在 UI 触发）。

## 18. Duplicate 集成阶段 B 处置审核流（2026-07-26，Kimi/coder）

> 与方案的偏差：**未使用 `suggestions.source='duplicate'`**——`suggestions` 表有 `CHECK ((category_id IS NULL) <> (tag_id IS NULL))` 约束，恰好一个目标非空，"每组一条处置建议"（无分类/标签目标）无法落表，改 CHECK 需要重建表。处置状态改由 `cluster_groups.status`（suggested/confirmed/ignored，既有字段）承载，语义等价且复用现有组审核 UI。

### 18.1 实现

- `assetLibraryService.applyDuplicateGroup(clusterId)`：校验组存在/为 duplicate 算法/未 confirmed → 软归档代表图以外的活跃成员（`archiveAssetLibraryAssets`，可经 Removed 视图 `restoreAssetLibraryAssets` 完整恢复）→ 组标记 `confirmed`。幂等：重复 apply 拒绝；无活跃成员拒绝。
- Reject/Ignore：复用既有 `updateCluster(status='ignored')`（UI 已有 Ignore 按钮）。
- IPC：`assetLibrary:applyDuplicateGroup`（正整数 guard + mutation 串行，已登记能力矩阵）。
- UI：重复组卡片显示 `Archive N copies` 按钮，**两次确认 armed 模式**（首次点击 5 秒 armed 变红 `Confirm archive N`，二次执行）；confirmed 后显示 `Archived`；非重复组按钮行为不变。

### 18.2 验证

| 验证 | 结果 |
|------|------|
| `tests/library-duplicate-build.test.cjs` | 4/4（新增：apply 归档非代表成员+组 confirmed+拒绝重复 apply+完整恢复），`test:duplicate-finder` 16/16 |
| 回归 | asset-library 95/95、ipc-registration 4/4、preload-contract 1/1、typecheck/ESLint/Prettier |

### 18.3 边界

1. 撤销路径：归档经 Removed 视图恢复（设计认可），无独立"撤销处置"按钮。
2. 阶段 C（近重复）仍未做；真实库全量构建+处置未实测。

## 19. Duplicate 集成阶段 C 近重复（2026-07-26，Kimi/coder）

### 19.1 实现

- `electron/libraryNearDuplicates.ts`（纯逻辑，electron-free）：直接消费素材记录自带的 dHash（Image Search 扫描时已写入，**零重解码**）。16 段 × 4bit banding（鸽笼保证 T≤8 的近重复对至少 8 段一致）+ 同桶精确汉明比较 + 并查集；超大桶确定性截断（id 升序前 200）；输出确定性（排序+重跑一致）。
- `buildLibraryNearDuplicateGroups(threshold?)`：threshold 默认 8、限 1–16；无有效哈希时清晰报错（提示先跑 Image Search 扫描）。
- 落库重构：抽取 `persistDuplicateGroups(algorithm, inputs)` 供 exact/near 共用（原子替换同算法组、其他组保留、代表图=最早入库）；near 组 similarity = 1 − maxDist/64，labels 含 `d≤N`。
- 处置流零改动复用 `applyDuplicateGroup`（已支持 duplicate_near）。
- IPC/UI：`assetLibrary:buildNearDuplicateGroups`（能力矩阵已登记）；Clusters 工作区新增 **Build near duplicates** 按钮。

### 19.2 验证

| 验证 | 结果 |
|------|------|
| `tests/library-near-duplicates.test.cjs` | 8/8（汉明计算、阈值边界含等号、链式并查、跨段散布差异的 banding 完备性、乱序确定性、大桶截断、取消） |
| `tests/library-duplicate-build.test.cjs` | 6/6（新增 near 构建+落库+幂等+near 组处置流+无哈希清晰报错） |
| 回归 | duplicate-finder 26/26、asset-library 95/95、ipc-registration 4/4、preload-contract 1/1、typecheck/ESLint/Prettier |

### 19.3 边界（重要）

1. **阈值 8 未经真实库抽检校准**（方案要求与准确率门禁同流程：先记录再定默认）——首次真实库构建后应人工抽检若干组的误组率，>5% 则下调阈值重建。
2. 链式并查的间接关联可能使组内最大距离超过阈值（labels 的 `d≤N` 如实显示）。
3. dHash 对旋转/大幅编辑不敏感；误组主要是纯色/极简构图图（哈希天然接近）。
4. 重建会原子替换同算法组——旧组 id 失效（测试已覆盖该语义）；阶段 B 已 confirmed 的组在重建后回到 suggested，需重新处置（与方案"重跑幂等"一致）。

## 20. 聚类人工干预与稳定 Lineage（2026-07-26，Kimi/coder）

> 对应[聚类 Lineage 方案](../designs/2026-07-18-neko-search-cluster-lineage-plan.md)，阶段 A/B/C 全部完成。

### 20.1 阶段 A：三操作 + lineage 事件

- **Schema v2**：`cluster_groups` 增加 `origin`（auto/manual_merge/manual_split/manual_edit）与 `lineage_key` 列；新表 `cluster_lineage`（事件日志）。v1→v2 自动迁移（ALTER ADD COLUMN，首次启动执行，真实库建议先确认最新备份）。
- `mergeAssetClusters`（成员并集去重取最高 similarity、代表图取最大组、状态不降级）、`splitAssetCluster`（选中成员成新组、原组重算统计）、`moveAssetClusterMembers`（组间移动或移出聚类）；全部写 `cluster_lineage` 事件；sqlite/jsonl 双路径；`listClusterLineage` 支持按组过滤。
- origin 默认 'auto' 时不出现在读取结果中（保持旧 JSONL 形状，deepEqual 回归不变）。

### 20.2 阶段 B：重算继承

- 人工干预组（origin ≠ auto）重算时**不删除**，其成员不参与自动重算（worker 输入排除）。
- 旧自动组→新组按成员 **Jaccard ≥ 0.5** 一对一继承 `lineageKey`、status（confirmed/ignored）、组名（人工命名以 confirmed/ignored 参与度近似，文档已注明）；继承映射写 `recalc_map` 事件。
- 纯函数 `computeClusterInheritance` 独立可测。

### 20.3 阶段 C：UI

- 组卡片多选 checkbox → 头部 **Merge (n)**；卡片右上角 origin 徽标 `Manual`（tooltip 含 lineageKey）。
- 预览成员点击多选 → 卡片内 **Split / Move out / Move to…**（目标组下拉）。
- IPC：merge/split/move（ID 数组上限 64/10000）+ listClusterLineage，全部登记能力矩阵。

### 20.4 验证

| 验证 | 结果 |
|------|------|
| `tests/cluster-manual-ops.test.cjs` | 4/4（合并成员并集/状态不降级/事件内容、拆分统计重算、移动与移出、输入校验） |
| `tests/cluster-inheritance.test.cjs` | 6/6（Jaccard 边界、一对一消耗、命名继承规则、空输入） |
| Schema v2 | sqlite 套件更新并通过 18/18（新表/新列/迁移记录断言）；asset-library 95/95 无回归 |
| 门禁 | typecheck/ESLint/Prettier、ipc-registration 4/4、preload-contract 1/1、`smoke:ui` 通过 |

### 20.5 边界

1. 成员选择 UI 基于卡片 8 张预览图（无组详情全成员视图）；大组成员纠错需翻预览，属 v1 限制。
2. "人工命名"无独立标记，以 confirmed/ignored 参与度近似（auto 组名不继承，confirmed/ignored 组名继承）。
3. Jaccard 阈值 0.5 为初始值，真实库重算后应抽检继承正确率再校准。
4. 阶段 B 仅在 sqlite 与 jsonl 持久层验证；真实 18.7 万库全量重算未跑。

## 21. Subject 搜索全链路进度（2026-07-26 实测反馈，Kimi/coder）

> 现象：Subject 进度条卡在 95% 像死机。根因：`searchBySubject` 调 `searchLayered` 时**没有传 onProgress**，整个搜索零进度事件，95% 是上一次 layered 搜索的残留值；身份重排阶段（前 100 候选检测+embedding，10–30s）完全静默。

修复：
- `searchBySubject` 新增 onProgress；`makeSubjectProgress` 统一映射——基础管线进度重映射到 **0–70%**，身份重排 **70–99%**（逐候选事件：`Face matching n/N`、`Detecting candidates n/N`、`Locating subjects n/N`、`Embedding subject crops n/N`），完成 100%。
- IPC 把进度**复用既有 `vector:onLayeredSearchProgress` 通道**推送，Renderer 零改动，进度条连续。
- 缓存命中（②的 embedding 缓存）时重排阶段显著变快，进度事件照常。

验证：typecheck/ESLint/Prettier、subject-crop 11/11、face-match 13/13、ipc-registration 4/4、preload-contract 1/1。dist-electron 曾缺失 worker bundle（subject-crop 测试 skip 暴露），已重建并全绿。

## 22. Clusters 界面选择修复与算法过滤（2026-07-26 实测反馈，Kimi/coder）

> 现象：Clusters 界面选择行为有误。审查发现 4 个问题并全部修复：

1. **跨组误高亮**：成员选中高亮只查了 asset id 没查组 id——A 组选中后，含相同素材 id 的 B 组预览图也被描边。修复：高亮判定补 `memberSelection.groupId === group.id`。
2. **选择状态残留**：Merge/Split/Move/Refresh/重建后，`selectedClusterIds` 可能持有已删除组 id（Merge 按钮显示死计数、下次合并报"组不存在"），`memberSelection` 同理。修复：`loadClusters` 后自动按现存组修剪两个选择状态。
3. **人工操作越界开放**：合并 checkbox 与成员 Split/Move 原本对所有算法组可用——Category/Semantic 组（方案明确不动其语义）和 Duplicate 组（有自己的 Archive 处置流）都会被误操作。修复：人工操作仅限 `compressed_kmeans`（Visual）组；`Move to…` 下拉同样只列 Visual 组。
4. **算法混排无过滤**：Visual/Category/Semantic/Duplicate 组全混在一起。修复：Clusters 头部新增 All / Visual / Duplicates / Other 过滤 chips；空态文案区分"没有组"与"过滤无匹配"。

验证：typecheck/ESLint/Prettier、`smoke:ui` 通过。

### 22.1 追加修复（同日第二轮实测反馈）

1. **选中缩略图导致错位**：成员缩略图的外层 div 没有固定尺寸（只有 outline），缩略图容器可把格子撑高、4 列网格错位。修复：外层改为与 ImageSearch 结果格一致的固定盒（`height: 76 + overflow: hidden + boxSizing: border-box + 统一底色`）。
2. **有的组选不了**：Merge checkbox 绝对定位但没有 z-index/底色，被缩略图盖住点不到。修复：`zIndex: 2` + 半透明底。另说明：成员 Split/Move 与合并 checkbox 仅限 Visual 组（设计边界，见 §22 第 3 条），Duplicate/Category/Semantic 组不出选择框属预期。

## 23. MobileSAM 点击分割主体（2026-07-26，Kimi/coder）

> 需求：用户要在查询图上**点击任意位置**，模型自动分割出该处主体进行搜索（而非只能从 YOLO 矩形框里选）。这是 YOLO 完全认不出主体（卡通形象等）时的根治路径。

### 23.1 模型与验证

- **MobileSAM ONNX**（PulpCut/mobilesam-onnx）：encoder 28MB（TinyViT，1024×1024 HWC，ImageNet 归一化）+ decoder 16.5MB（点提示 → 3 蒙版取 best-IoU）。
- 真人验证：点击脸部 → 精确头部分割（IoU 0.900，bbox/蒙版像素级正确）；多点/缓存复用正常。
- 编码结果按图片 path+mtime 缓存（内存 LRU 4 条）——同图多次点击只编码一次。

### 23.2 实现

- `electron/samSegmentService.ts`：encodeImage（resize 最长边 1024 + 右下补齐 + 归一化 + 缓存）→ segmentAtPoint（decoder 点提示 → 蒙版 → bbox + 灰度 PNG dataUrl）。
- IPC：`sam:status` / `sam:segment`（normalizeUserPath + points 1–8 个坐标校验，已登记能力矩阵）。
- UI：`SubjectPickerModal` 升级——YOLO 框可点之外，**点击图片任意位置即触发分割**（crosshair 光标 + 蒙版叠加显示 + `Search this region (IoU x.xx)`）；流程变更：1 个 YOLO 主体仍直接搜（快路径），多个 → 选择器，**0 个（YOLO 盲区）→ 直接进入点击分割**。
- 蒙版查询走 `searchBySubject` bbox 覆盖路径（label='sam'）：mask bbox 已是精确主体，**跳过候选侧 crop 重排**（候选无点提示可用，无法做同类蒙版匹配），保留基础搜索排序。

### 23.3 验证

| 验证 | 结果 |
|------|------|
| `tests/sam-segment.test.cjs` | 5/5（status、头部区域断言、编码缓存复用、缺图降级；模型缺失自动 skip），已入 `test:subject-crop`（16/16） |
| 门禁 | typecheck/ESLint/Prettier、ipc-registration 4/4、preload-contract 1/1 |
| 打包 | extraResources 含 `models/mobilesam`；完整 `npm run build` 通过（注意：运行中的应用会锁住模型文件导致 EBUSY，打包前需关闭应用） |

### 23.4 边界

1. 蒙版只用于查询侧（bbox 裁剪）；候选侧不做 SAM（无点提示、逐候选编码成本高）。
2. 首次点击每张图较慢（编码 ~1–3s CPU），后续点击复用缓存。
3. 蒙版去背景查询（而非 bbox）可进一步提升身份纯度，留作后续项。

### 23.5 面板 UX 迭代（2026-07-27 实测反馈）

1. **面板总是打开**：原逻辑 YOLO 检出 1 个主体就跳过面板直接搜索（卡通猫检出"1 个圆形眼睛"→ 永远不进面板）。改为点 Subject 一律先检测再开面板；`Auto (largest)` 保留原直接搜索路径。
2. **蒙版对齐与面板适配**：stage 原本只用 aspectRatio + max-height，letterbox 导致蒙版与图片错位。改为按图片比例计算像素尺寸（max 720×640，受 85vw/65vh 约束），图片零 letterbox 填满，蒙版/YOLO 框 1:1 对齐；面板宽度随内容自适应。
3. **蒙版蓝色化**：白色蒙版改 CSS `mask-image` 着蓝色（`rgba(60,140,255,0.5)`），不再用半透明图片覆盖。

## 24. 打包安装验证与门禁漂移修复（2026-07-27，Kimi/coder）

> 对应 §0 原未做项"打包安装验证"。执行身份：Kimi；代理系统：Kimi 运行时，本轮未启动子代理。

### 24.1 接手时发现的门禁漂移（已修复）

07-24 缩略图轮次的验证清单未包含 lint/format，此后积累了两处门禁漂移（无语义变更）：

1. 7 处 `while (true)` 触发 ESLint `no-constant-condition` error（embeddingF16Cache、rerankService、thumbnailCacheWriter、thumbnailIpc×2、vectorAnnIndex、vectorIndexService），统一改为项目惯例 `for (;;)`。
2. `BatchRenamePanel.tsx`、`batchRenameBridge.ts` 未过 Prettier，已格式化。

### 24.2 验证记录（2026-07-27）

| 验证 | 结果 |
|------|------|
| `npm run typecheck` / `lint` / `format:check` | 通过（lint 0 error；3 个既存 warning 未动：BatchRenamePanel 2 个未用变量、native-scan.test 1 个） |
| `npm test` 全链 | 通过（&& 链完整走完，末尾 native 35/35） |
| `npm run build`（`FLOATING_CLOCK_KEEP_UNPACKED=1`） | 通过；首次 electron-builder 复制 `models/adaface/model.onnx` 遇 EBUSY（瞬时占用，手工复制验证文件无锁后重试即成功；与运行中应用锁文件不同，本次无 FloatingClock/electron 进程） |
| `npm run smoke:ui:packaged` | 通过：ok=true，6 面板齐全、无 console error、runtimeCheck 模型 dino/clip true、native `fast_scanner 0.5.1` connected、备份 6 项全 true、stdout native 证据 true |
| win-unpacked resources 检查 | `resources/models/` 下 yolov8n、yolov8n-face、adaface、osnet、mobilesam 全部就位；`fast_scanner.node` 与 7 个 worker/child bundle 就位 |
| `npm run smoke:installer:archive` | 通过：ok=true，归档 187 文件，NSIS 尾部正常 |

正式安装包：

```text
release\FloatingClock Setup 1.0.0.exe
大小：907,439,387 bytes
SHA-256：734224EF0FE9A707197DD4C6D3BBBBA2AE310248CB41192E0D2D10F46363AD41
```

冒烟完成后已执行 `release:clean`，release 目录只保留安装包。

### 24.3 边界

1. packaged smoke 的 runtimeCheck 模型断言只覆盖 dino/clip（既有 11 项）；新模型（yolov8n/adaface/osnet/mobilesam）的验证方式是 resources 文件就位 + dev 环境模型级测试（§9/§10/§23），未在安装包内逐一加载推理。
2. 未执行真实 NSIS 安装到系统——packaged smoke 直接运行 win-unpacked 的 exe；安装包完整性由 installer-archive smoke（7za 解包 + NSIS 尾部校验）间接覆盖。
3. 体积较 07-24 安装包（600,745,805 bytes）增至 907,439,387 bytes，增量主要来自 adaface（260MB）等 Phase 2/3 与 MobileSAM 模型。

## 25. SubjectPicker 蒙版渲染修复（2026-07-27 实测反馈，Kimi/coder）

> 现象：分割面板蒙版无法正确叠加——蓝色盖住整个图片而不是只盖主体；旋转照片（EXIF）蒙版/YOLO 框与画面转置。

### 25.1 根因与实证

1. **mask-mode 错误**：§23.5 把白色蒙版图改为 CSS `mask-image` 着蓝色，但服务输出的蒙版是**无 alpha 通道的灰度 PNG**（`sharp raw channels:1` 产物，metadata 实证 `hasAlpha:false`）。CSS 默认 `mask-mode: match-source` 对位图取 **alpha 通道**——无 alpha 即全不透明，蓝色覆盖整个 stage。
2. Playwright 对照复现（`artifacts/mask-repro/index.html` + 三张截图）：当前 CSS = 整屏蓝；加 `mask-mode: luminance` 后蓝区精确只盖主体形状，与蒙版 1:1 对齐。最终组件只用标准 `mask-mode`（csstype 无 `WebkitMaskMode` 属性），复验行为一致。
3. **EXIF 方向坐标系不一致**：缩略图管线 `.rotate()` 按 EXIF 旋转显示，而 `detectSubjects`、`searchBySubject` 裁剪钳位、`samSegmentService.encodeImage` 全部用 `sharp().metadata()` 原始像素坐标——EXIF 5–8（90°/270°）照片的蒙版、YOLO 框、点击坐标与显示画面转置。

### 25.2 修复

- `SubjectPickerModal.tsx`：蒙版叠加层加 `maskMode: 'luminance'`（含注释说明）。
- `subjectBoxes.ts`：新增纯函数 `orientedDimensions(rawW, rawH, orientation)`——EXIF 5–8 交换宽高。
- `subjectSearchService.ts`：detectSubjects（metadata + YOLO 预处理 + 显著性降级）与 searchBySubject（override 钳位 + 裁剪）全部 `.rotate()` 并按显示方向取尺寸。
- `samSegmentService.ts`：encodeImage 同样 `.rotate()` + 显示方向尺寸，蒙版/bbox 与画面一致。
- 附带收益：EXIF 照片的人脸/OSNet/DINO 裁剪图从此是正向的（此前是侧向，影响识别）。

### 25.3 验证

| 验证 | 结果 |
|------|------|
| sharp 行为实证 | `.rotate().extract()` 确认先旋转后裁剪（EXIF6 合成图 display 空间裁剪像素正确）；旋转后尺寸 100×200 与 `orientedDimensions` 一致 |
| `detectSubjects` EXIF6 端到端 | 返回显示方向 100×200 + 显著性 bbox 位于 display 正确象限 |
| Playwright 蒙版对照 | luminance 后蓝区与主体形状 1:1（截图存档 `artifacts/mask-repro/`） |
| `tests/subject-detection.test.cjs` | 新增 `orientedDimensions` 5 项（非转置 1/3/4 保持、5–8 交换），套件 17/17 |
| 回归 | typecheck / ESLint / Prettier、`test:batch-rename` 17/17、`test:subject-crop` 16/16、`smoke:ui` ok=true 无 console error |
| 构建 | `build:renderer` 通过；dist-electron chunk 含全部 `.rotate()` 调用，renderer bundle 含 maskMode |

### 25.4 边界

1. 面板比例适配逻辑（§23.5）本轮审查确认无误，未改动；若用户仍见面板尺寸问题，需确认运行的是 10:43 之后重建的版本。
2. 候选侧的人脸/reid crop 重排管线（faceMatchService、personReidService）未做 EXIF 统一——它们处理整图与裁剪图自用坐标，不影响本面板对齐，必要时另立项。未接线的 `objectCropService` 占位文件已在 2026-07-28 审计整改中删除。
3. `WebkitMaskMode` 因 csstype 无该属性未保留；Chromium（Electron 42）标准 `mask-mode` 已生效，如未来需兼容更老内核可在服务侧改发 RGBA 蒙版（alpha 通道）替代。

### 25.5 蒙版与图片比例二次修复（2026-07-27 实测反馈，Kimi/coder）

> 现象：25.2 后蒙版颜色正确，但蒙版仍比画面大一圈、位置偏移。

1. **根因**：modal 传给 `ThumbnailImage` 的 `width/height:100%` 只落在外层 div；内部 `<img>` 仅 `maxWidth/maxHeight:100%`。stage 按图片比例最多放到 720×640，而缩略图固有尺寸最长边只有 512——`<img>` 以固有尺寸居中显示（比 stage 小），蒙版却按整个 stage 拉伸，于是蒙版等比放大且偏移。Playwright 复现（`artifacts/mask-repro/scale.html` + `scale-repro.png`）：410×512 缩略图在 468×585 stage 中，蒙版与头部明显错位；img 强制填满后精确对齐。
2. **修复**：`ThumbnailImage` 新增可选 `imgStyle` prop（展开到 `<img>` 样式末尾，其他调用方零影响）；`SubjectPickerModal` 传 `imgStyle={{ width:'100%', height:'100%', display:'block' }}` 使图片填满 stage（stage 与图片同比例，`objectFit:contain` 无 letterbox）。
3. **验证**：typecheck / ESLint / Prettier 通过；`build:renderer` 通过（bundle 含 maskMode）；`smoke:ui` ok=true。

## 26. Clusters 卡片点击拉伸与缩略图修复（2026-07-27 实测反馈，Kimi/coder）

> 现象：NekoSearch Clusters 掉帧；大量卡片缩略图显示为系统小图标；点击缩略图后整行卡片"一起放大、伸出原 box"。

### 26.1 诊断（真实应用 CDP 远程调试，--remote-debugging-port=9222）

1. **整行拉伸**：点击成员缩略图 → `memberSelection` → Split/Move 操作栏**插入**卡片 → 卡片 +33px（实测 194→227）→ CSS grid 行高取整行最大，整行卡片边框一起拉伸。用户感知的"四个缩略图一起放大跑出 box 外"即整行卡片同步撑高。DOM 实测确认缩略图本身始终受控（cell 70×76、img 不溢出），隔离复现页排除了 img 溢出路径。
2. **缩略图变系统图标**：Clusters 网格非虚拟化，199 卡片 × 4 ≈ 800 个缩略图请求同时涌入 `BoundedBatchScheduler`（`THUMB_MAX_QUEUED=48`），超额请求被逐出并 resolve null → 回退系统图标 → **图标被 `cacheSet` 当作缩略图永久缓存**（path@dim 键），之后不再重试。
3. **掉帧**：每次成员选择切换整表重渲染 199 卡片 / 800 个 `ThumbnailImage`（未 memo，且 style 每次新建对象引用）。

### 26.2 修复

- `AssetLibraryPanel.tsx`：操作栏改为**恒占 27px 预留行**（无选择时 `visibility:hidden`，内容不可见不可点），点击/取消卡片高度实测恒定 227px，整行不再拉伸；缩略图 style 提升为模块常量 `CLUSTER_MEMBER_THUMB_STYLE`。
- `ThumbnailImage.tsx`：`React.memo` 包装（配合稳定 style 引用，选择切换时 800 个缩略图不再重渲染）；`THUMB_MAX_QUEUED` 48→512（吸收非虚拟化网格的突发请求）；**图片文件的系统图标回退不再写入缩略图缓存**——瞬时逐出/解码失败不再把图标钉成该文件的"缩略图"。

### 26.3 验证（真实应用 CDP 复验）

| 验证 | 结果 |
|------|------|
| 点击/取消成员缩略图 | 卡片与整行高度恒定 227px，仅 outline 切换（修复前 194→227 整行拉伸） |
| 首屏可见缩略图 | 76 真缩略图 / 20 系统图标（修复前大部分为图标）；剩余图标为真实解码失败/缺失文件，不再被缓存钉死 |
| 门禁 | typecheck / ESLint / Prettier 通过；`test:fm-security` 34/34、preload-contract 1/1、ipc-registration 4/4、`smoke:ui` ok=true |
| 构建 | `build:renderer` 通过 |

### 26.4 边界

1. Clusters 网格仍未虚拟化——199 卡片全量挂载，memo 消除了重渲染风暴，超大组数（>500）滚动掉帧可能仍需窗口化，留待真实需求再立项。
2. 诊断工具：`artifacts/cdp-inspect.cjs`（CDP eval/截图/点击），复现页与截图存于 `artifacts/mask-repro/`。
3. 远程调试实例已关闭；正式使用无需 `--remote-debugging-port`。

### 26.5 卡片内容横向溢出二次修复（2026-07-27 实测反馈，Kimi/coder）

> 现象（用户提供截图）：§26.2 后缩略图大小正常，但卡片内容（缩略图行、统计文字、按钮）整体比卡片宽，溢出并压到相邻卡片。

1. **根因**：grid `min-content` 吹出。外层网格 `minmax(250px, 1fr)` 轨道约 291px，而卡片行内容的最小内容宽度更大——§26.2 恒渲染的成员操作栏自然宽度实测约 335px（按钮 nowrap + 下拉），真实缩略图（队列修复后加载的 128px 图）也加大单元格 min-content。grid item 默认 `min-width: auto` → 卡片被最宽行撑出轨道，相邻卡片互相压盖。
2. **修复**（`AssetLibraryPanel.tsx`）：卡片 `article` 加 `minWidth: 0`；缩略图行 `repeat(4, minmax(0, 1fr))` + 单元格 `minWidth: 0`；操作栏容器 `minWidth: 0 + overflow: hidden`（27px 预留高度保留）；底部按钮行 `minmax(0, 1fr)`。
3. **验证**（真实应用 CDP）：12 张采样卡片缩略图行全部在卡片内（275/291px，零溢出）；点击成员后操作栏显示且右缘不越界、卡片宽高恒定 227×291；截图 `artifacts/mask-repro/clusters-fixed.png`。typecheck / ESLint / Prettier / `smoke:ui` 通过。

### 26.6 掉帧回归修复（2026-07-27 实测反馈，Kimi/coder）

> 现象：§26.5 后 Clusters 掉帧加重。

1. **根因**：§26.2 的恒渲染操作栏让每个 Visual 卡片都挂载一个 `<select>`，其选项为全部分组名（约 199 个 `<option>`）——约 190 张卡 × 199 选项 ≈ **38,000 个额外 DOM 节点**，滚动与重渲染全面变慢。属本轮修复引入的回归。
2. **修复**：无成员选择的卡片改渲染等高占位 `div`（27px，卡片高度语义不变），完整操作栏（含 select）仅在该组有活跃选择时挂载；卡片 `article` 增加 `contentVisibility: 'auto' + containIntrinsicSize: 'auto 227px'`，屏外卡片跳过布局与绘制。
3. **验证**（真实应用 CDP）：空闲时 `article select/option = 0/0`（修复前潜在 ~38k）；整列表 3 秒程序化滚动 **141 FPS、0 长任务**（scrollHeight 15,781px）；点击选中卡片高度恒定 227px、操作栏正常出现（1 个 select）；typecheck / ESLint / Prettier / `smoke:ui` 通过。

## 27. Media Search 抽帧规格：20 张/分钟均匀铺满全片（2026-07-27，Kimi/coder）

> 需求来源：用户确认"采样点均匀铺满全片时长，每 1 分钟 20 张"。

### 27.1 变更前规格（实测代码行为）

固定 2s 一帧、每视频封顶 60 帧、帧宽 384px；60×2s=120s——长视频**只抽前 119 秒**（2 小时电影仅片头 2 分钟有帧）。设计文档的四档策略（fast/balanced/recall/deep）从未落地，调用方无参数、UI 无档位。

### 27.2 新规格（已实现）

`electron/videoFrameService.ts`：

- `DEFAULT_INTERVAL_MS` 2000→**3000**（20 张/分钟），`DEFAULT_MAX_FRAMES_PER_VIDEO` 60→**3600**。
- `planVideoFrameTimestamps` 改为**按片长取满速率帧数（封顶 3600），再均匀铺满 [1s, 片尾-1s]**：
  - 1 小时 → **1200 帧**，间隔 ≈3s，覆盖到最后一分钟；
  - 超 3 小时封顶 3600 帧，间隔自动拉宽（4 小时 ≈4s），仍均匀覆盖全片；
  - 短视频（<间隔）保持 1 帧取中点；调用方可选参数的钳位范围同步放宽（maxFrames ≤10800）。

### 27.3 影响面与注意

1. **重建索引成本**：帧记录按 `videoId:timestampMs` 精确匹配复用——新规格时间点几乎全变，下次 Extract Frames 会对目标视频**全量重抽**（ffmpeg 抽帧 + DINO/CLIP embedding 按帧计费，1 小时视频 1200 帧）。帧文件 384px，库存储约增加一个数量级。
2. 旧的 60 帧/视频记录在新一轮构建后被移出 manifest（文件由既有清理路径处理）。
3. 设计文档四档策略仍未落地；如后续要档位化，在此新 planner 上加 UI 参数即可。

### 27.4 验证

| 验证 | 结果 |
|------|------|
| `tests/media-search-guards.test.cjs` | 更新 planner 断言 + 新增默认策略用例（1h=1200 帧且覆盖片尾、4h=3600 封顶拉宽仍到片尾），`test:media-search` 31/31 通过 |
| 门禁 | typecheck / ESLint / Prettier 通过 |
| 构建 | `build:renderer` 通过，dist-electron 新 bundle 含新 planner |

## 28. Image Search 搜索可停止（2026-07-27，Kimi/coder）

> 需求：Image Search 搜索添加 Stop，可中途停止搜索。

### 28.1 实现

- `rerankService.ts`：新增 `stopLayeredSearch()`——复用既有序列失效机制（`isCancelled = searchSequence !== layeredSearchSequence`），bump 序列使在途搜索于下一个检查点取消；Subject 搜索（同走 searchLayered）一并可停。
- `vectorIpc.ts`：新增 `vector:stopLayeredSearch`（无参数，返回 `{ok:true}`）；取消的在途搜索按既有 catch 路径返回 degraded `"Layered search cancelled"` 响应。
- 契约/preload：`shared/ipc-contract.ts` 通道常量 + vector 命名空间类型，`electron/preload.ts` 接线；能力矩阵已登记（R 级，无文件读写）。
- Renderer：`SearchProgressBar` 图片类搜索进度行新增红色 **Stop** 按钮（semantic 搜索无取消机制，不显示）；`ImageSearchPanel` 对 cancelled 响应静默处理——保留上一次结果、不弹错误提示（layered 与 subject 两条路径一致）。

### 28.2 验证

| 验证 | 结果 |
|------|------|
| 真实应用 CDP 实测 | 标准模式搜索启动 1s 后调 stop：2.5s 时以 `["Layered search cancelled"]` degraded 响应结束（全量扫描被中断） |
| 门禁 | typecheck / ESLint / Prettier、ipc-registration 4/4、preload-contract 1/1、vector-pipeline 23/23、`smoke:ui` ok=true |
| 构建 | `build:renderer` 通过 |

### 28.3 边界

1. 取消在检查点生效：hash 阶段 native 调用不可中断（通常 <1s），DINO embedding 经 cancelPoll 轮询（~百毫秒级），rerank 循环逐项检查。
2. semantic 文本搜索（`vector:searchSemantic`）无取消机制，未纳入本次 Stop 范围。

## 29. 中文语义搜索（多语言文本编码器，面板复用）（2026-07-27，Kimi/coder）

> 需求：添加中文语义搜索，能力统一接入、各面板复用；两个语义模型可切换。
> 方案：[中文语义搜索方案](../designs/2026-07-27-chinese-semantic-search-plan.md)。执行身份：Kimi；代理系统：Kimi 运行时，本轮未启动子代理修改代码。
> 工作区状态提醒：Git 仓库尚无任何提交（未提交现场），本轮全部改动无提交编号可引。

### 29.1 模型与获取

- **sentence-transformers/clip-ViT-B-32-multilingual-v1**（Apache-2.0，135M 参数多语言 DistilBERT，50+ 语言）：多语言知识蒸馏对齐 OpenAI CLIP ViT-B/32 向量空间，输出 512 维——**与现有 clip_vit_base_patch32 图像向量同空间，18.7 万素材与全部视频帧向量零重建**。
- 官方 ONNX 只有 transformer 塔；mean pooling 与 768→512 Dense（`2_Dense/model.safetensors`，无偏置，torch nn.Linear 布局 [512,768]）在 JS 侧实现。
- 选用 `onnx/model_quint8_avx2.onnx`（135,377,779 bytes，SHA-256 `fbc8fbeaa5237d96bd1bf430057c70d34de8334a463e933a5faa305f6caeed9c`），AVX2 量化，兼容性优于 avx512 变体。
- 落盘：`ai-models/clip_vit_b32_multilingual_v1_text/sentence-transformers/clip-ViT-B-32-multilingual-v1/`（含 tokenizer/Dense 等附属文件），`models/manifest.json` 第三条登记；`modelService.downloadTransformersCompanions` 增加该模型的附属文件下载清单（无 preprocessor_config.json）；`package.json` extraResources 的 ai-models filter 同步加入。

### 29.2 实现

- `electron/textEncoderRouting.ts`（纯函数，electron-free）：CJK 判定（中日韩统一表意/假名/谚文）、`resolveTextEncoderChoice`（auto：含 CJK → multilingual）、mean pooling（带 batch 行偏移，兼容 BigInt64 mask）、Dense 投影（两种权重布局自适应）、L2 归一化、最小 safetensors F32 解析器。
- `electron/multilingualTextEncoder.ts`：懒加载单例（tokenizer/AutoModel/Dense 权重），模型根解析与设备回退（dml→cpu）沿用 CLIP 文本塔同一模式；`isMultilingualTextEncoderAvailable()` 供降级判定。
- `electron/semanticSearchService.ts`：新增路由入口 `getQueryTextEmbeddings` / `getQueryTextEmbedding`——按 `vector-settings.json` 的 `textEncoder` 设置（auto/english/multilingual，白名单回退 auto）分流；多语言塔缺失或失败时回退英文塔并记入 `getLastQueryTextEncoderDiagnostic()`；`searchSemanticImages` 响应新增可选 `textEncoderUsed`，degradationReasons 记录编码器选择与回退。
- **5 处调用方统一切换**：`searchClipEmbeddingIndex`（Image Search 语义搜索）、`scanClipPersonSemanticGroups`、`videoFrameSearchService` 默认 `textEmbeddingProvider`（Media Search 文本搜帧/multimodal）、`assetLibraryService` 标签建议（:3321）与聚类语义标签（:3756）。英文 prompt 在 auto 下仍走英文塔，行为零变化；中文标签名从此可用。
- 设置：`shared/vectorTypes.ts` `VectorSettings.textEncoder`（默认 auto）；Settings → Vector 区新增 "Text encoder" 下拉（Auto/Multilingual/English only），复用 `vector:saveVectorSettings`，**无新增 IPC 通道**。
- `THIRD_PARTY_NOTICES.md` 登记（Apache-2.0 + SHA-256）。

### 29.3 验证

| 验证 | 命令 | 结果 |
|------|------|------|
| 路由纯函数单测 | `npm run test:text-encoder` | 9/9 通过，已入 `npm test` 链 |
| 运行时冒烟 | `node scripts/verify-multilingual-text-encoder.cjs` | 通过：transformers.js 实际加载本地 quint8；cos(一只猫,a cat)=0.9936，cos(红色连衣裙,a red dress)=0.9803，同义对排序高于无关对 |
| torch/ONNX 一致性 | `.venv-parity/Scripts/python.exe scripts/verify-multilingual-text-encoder-parity.py` | 通过：10 条中英文句子 fp32 vs quint8 余弦最低 0.999117（量化漂移可忽略；venv 为隔离环境 `.venv-parity`，torch 2.13+cpu / ST 5.6.1 / ORT 1.28） |
| 真实库对比 | `node scripts/eval-chinese-semantic-search.cjs` | 见 §29.4；报告 `docs/benchmark/2026-07-27-chinese-semantic-search-eval.json` |
| 门禁 | `npm run typecheck` / ESLint（9 个相关文件）/ Prettier | 通过 |
| 回归 | settings 5/5、model-download 4/4、vector-pipeline 23/23、preload-contract 1/1、ipc-registration 4/4、media-search 31/31、asset-library 95/95、guards 9/9 | 全绿 |
| UI 冒烟 | `npm run smoke:ui` | ok=true，无 console error，runtimeCheck 正常 |

### 29.4 真实库评测结论（326,980 条 CLIP 向量，只读）

1. **具体物体/场景类中文查询有效**：猫、红色连衣裙、高跟鞋的 zh top1 与英文 CLIP 塔 top1 为同一张图（人工看图确认内容正确）；美食 zh/en-multi Top20 重合 20/20。zh-multi vs en-CLIP Top20 重合度：红裙 14、汽车 11、美食 10、海滩 9、高跟鞋 6、夜城 5。
2. **已知限制（重要）**："动漫女孩"丢失"动漫"风格语义，召回真人女孩照片；英文 "anime girl" 经多语言塔同样丢失（zh-multi vs en-multi 重合 0/20 但两者一致错误）——属多语言蒸馏塔对风格修饰词的固有限制，**非中文特有问题**。对该类查询建议用英文塔（手动切换或英文查询）。
3. 多语言塔 embedding 各向异性明显（无关对余弦 0.86+），排序仍正确；`score=(dot+1)/2` 语义下区分度足够。
4. `textEncoder` 默认保留 `auto`：英文查询路径代码零变化（回归全绿佐证）；正式中文标注集门禁（方案 §9，20–30 条人工标注）未做，列为后续项。

### 29.5 边界与后续

1. 打包安装验证未做（Phase 3）：安装包将增大约 135MB；`smoke:ui:packaged` 与 resources 检查需在下次发布前执行。
2. 多语言塔常驻内存约 150–250MB（懒加载，首个中文查询付 1–3s 模型加载），与 AdaFace 常驻策略一致。
3. 英文塔的 "a photo of X" 双 prompt 技巧不适用于多语言塔（蒸馏空间不同），多语言路径用原始查询；中文 prompt 模板 A/B 留待正式标注集门禁时评估。
4. 正式门禁前若用户实测风格类查询不满意率过高，回退选项：Settings → Text encoder 改 English only 即恢复原行为。
5. `.venv-parity/`（torch 校验环境）与 `.transformers-cache` 不随应用分发；HF 缓存 `~/.cache/huggingface` 中 fp32 参考权重可手动清理（约 1.1GB）。

### 29.6 中文搜索崩溃修复（2026-07-27 实测反馈，Kimi/coder）

> 现象：用户使用中文搜索应用直接崩溃（进程消失，无 JS 错误）。

1. **复现与根因**：CDP 驱动真实应用调 `vector:searchSemantic({text:'一只猫'})` 复现——主进程 native 崩溃（crashpad `not connected`，无 dump）。根因：用户 `vector-settings.json` 的 `backend: 'gpu'`，多语言编码器按既有设备选择逻辑在 win32 走 `dml`，而发布的模型是 **AVX2 CPU 量化**（MatMulInteger 算子），DML 会话创建成功后推理阶段 native 崩溃。最小 electron 复现（无 BrowserWindow/GPU 进程）不崩——因 DML 会话创建失败自动回退 CPU，掩盖了问题。
2. **修复**：`electron/multilingualTextEncoder.ts` 删除设备选择，**该编码器固定 CPU**（AVX2 量化核 DML 本就无法加速），代码内注释记录崩溃场景。
3. **验证**（真实应用 CDP，`backend:'gpu'` 保持不变）：
   - 中文查询 `一只猫`：20 结果、`textEncoderUsed='multilingual'`、不崩溃，top1 与离线评测一致（黑猫图）。
   - 英文查询 `a cat`：`textEncoderUsed='english'`（auto 路由不回归）。
   - 切换链：强制 english + 中文查询 → english；强制 multilingual + 英文查询 → multilingual；恢复 auto + 中文查询 → multilingual。设置已还原为 auto。
   - typecheck / ESLint / Prettier 通过；`test:text-encoder` 9/9。
4. **注意**：验证期间残留 electron 进程已清理（单实例锁会阻止后续启动）；`_repro-multilingual-electron.cjs` 为一次性复现脚本，验证后已删除。
5. **另修**：`.venv-parity/` 加入 `vite.config.mjs` watch 忽略列表（此前其内部 HTML 文件触发 dev 页面刷新）。

### 29.7 中文问题词诊断与词典融合（2026-07-27，Kimi/coder；用户决定止步于此）

> 现象：用户反馈中文模型"有些词不准：游戏、敏感词一些"。
> 实施状态：诊断完成并有 A/B 证据；词典融合**代码已接线、编译通过，但未做运行时验证**（用户决定"目前够用"，剩余验证项不做）。

#### 29.7.1 诊断结论（真实库探针，`scripts/eval-zh-probe.cjs`，可复跑）

根因不是"中文不行"，而是**蒸馏多语言塔把窄意图中文词映射到泛化概念**：

| 查询 | zh-raw（多语言塔）实际检索 | 用户意图 | en-CLIP 表现 |
|------|--------------------------|---------|-------------|
| 游戏 | 扑克牌、骰子（泛化的 game 概念） | 电子游戏 | 正确（CS 皮肤、Steam 库、手柄） |
| 游戏截图 | 混杂（金属纹理等） | 游戏画面 | 正确（green_hell、hogwarts_legacy、GTA） |
| 动漫 | 简笔画条漫（泛化的 comic 概念） | 日式动画 | 正确（anime 风格图） |
| 色图 | 游戏皮肤贴图（完全跑偏） | 成人向动漫图 | 基本正确 |
| 性感 | 有人像但泛 | 性感人像 | 更准 |
| 丝袜 | 基本正确 | — | 相当 |

中文模板 prompt（一张X的照片 / X的照片）A/B 无稳定改善。

#### 29.7.2 融合方案与 A/B 证据

两个塔同处 CLIP ViT-B/32 的 512 维空间，**查询向量可直接平均**：`normalize((multilingual(中文词) + clipEn(英文释义)) / 2)`。探针实测 FUSED 效果：

1. 游戏：top1 变为 PS4 手柄（人工看图确认），进入电子游戏语义。
2. 动漫：top 集合变为 en-CLIP 的 anime 结果（动漫表情包等）。
3. 色图：从游戏皮肤变为与 en-CLIP 一致的结果集（注意：该库顶部结果含 QQ 临时目录的长图切片 tile_files，属数据噪声非模型问题）。
4. 性感/丝袜：与英文塔持平或略优。

#### 29.7.3 实现状态（如实记录）

1. `electron/queryLexicon.ts`（纯函数）：内置约 80 条 中文词→英文释义（游戏/动漫/敏感词/日常四类），`mergeQueryLexicon` 合并用户覆盖文件 `userData/query-lexicon.json`（同格式，用户可自行加词），`lookupQueryGloss` 精确匹配。
2. `electron/semanticSearchService.ts` `getQueryTextEmbeddings`：CJK 路由的文本若命中词典，自动与英文塔的释义向量融合（多语言塔回退英文塔时跳过，避免同向量自融合）；诊断 `QueryTextEncoderDiagnostic.expansions` 记录使用的释义；词典文件按 mtime 热更新。
3. **已验证**：typecheck / ESLint / Prettier 通过。
4. **未验证（用户决定不做）**：词典融合的运行时实测（dist-electron 未重建，下次 `npm run dev` 自动生效）、单元测试、真实库复测、Media Search/NekoSearch 调用方的融合效果、文档门禁。若实测发现问题，回退方式：删除或清空 `userData/query-lexicon.json` 不影响内置词典；彻底回退需还原 `getQueryTextEmbeddings` 的融合分支。
5. 词典外词汇（如长尾俚语、多词短句）仍走多语言塔原路径，质量限制同 §29.4；升级路径（Chinese-CLIP 双塔重建、本地翻译模型）维持方案文档 §11 的评估。

## 30. 应用图标（logo）接入（2026-07-27，Kimi/coder）

> 需求：使用 `logo/JPG` 图标集为软件添加 logo。

### 30.1 实现

1. `scripts/build-icon.cjs`：sharp 将 `logo/JPG/{16,24,32,48,64,128,256}x*.jpg` 转 PNG 并打包为 Vista+ PNG-payload 多尺寸 ICO → `build/icon.ico`（57,709 bytes，7 尺寸）。
2. `package.json`：`win.icon` = `build/icon.ico`；**`signAndEditExecutable: false` 改为 `signExecutable: false`**——前者连 exe 资源编辑一起跳过（icon 不写入，builder 日志明示），后者只跳签名、保留 rcedit 图标/元数据写入。
3. `electron/main.ts`：BrowserWindow 增加 `icon`（`app.getAppPath()/build/icon.ico` 存在才设置；打包版使用 exe 内嵌图标）。

### 30.2 验证

| 验证 | 结果 |
|------|------|
| typecheck / ESLint / Prettier | 通过 |
| `FLOATING_CLOCK_KEEP_UNPACKED=1 npm run build` | 通过（adaface EBUSY 瞬时锁重试 1 次，同 §24.2） |
| exe 内嵌图标提取（PowerShell `ExtractAssociatedIcon` → `artifacts/extracted-exe-icon.png`） | **确认为新 logo**（眼形+图片图标，非 Electron 默认） |
| `npm run release:clean` | release 仅保留安装包 |

正式安装包（含 §29 中文语义搜索全部改动 + 图标）：

```text
release\FloatingClock Setup 1.0.0.exe
大小：998,943,181 bytes
SHA-256：6D9374F3A7E4E43BB687951F1CA4060CFD5455D1A2ADEA13CDC9EAAD29AFB416
```

### 30.3 用户侧注意

1. **桌面快捷方式图标 = 目标 exe 的内嵌图标**：必须用本包重装后才会变；此前安装的版本（`signAndEditExecutable:false` 时代）exe 内嵌的是 Electron 默认图标。
2. 重装前需退出正在运行的 FloatingClock（单实例 + 文件锁）。
3. 若重装后桌面图标仍显示旧图：Windows 图标缓存问题，执行 `ie4uinit.exe -show` 或重启资源管理器。
4. 安装包体积 907MB → 999MB，增量为 §29 多语言文本编码器（quint8 135MB 压缩后）与图标。
