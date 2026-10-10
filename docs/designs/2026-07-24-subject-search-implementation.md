# 主体精准搜索实施方案

> 状态：部分实施（Phase 1.5/2/3 + 实例级识别 + MobileSAM 点击分割已完成——以[交接文档 §0 总览与 §23](../current/2026-07-24-feature-implementation-handoff.md)为准；Phase 4 暂缓）  
> 更新日期：2026-07-27  
> 项目：FloatingClock Electron  
> 日期：2026-07-24  
> 类型：新增功能落地方案 / 架构适配文档  
> 前置方案：[NekoSearch 准确率模型路线评估](2026-07-18-neko-search-accuracy-model-evaluation.md)、[NekoSearch 审核反馈搜索方案](2026-07-15-neko-search-feedback-search-plan.md)  
> 关联基线：[NekoSearch 当前优化进度](../current/2026-07-18-neko-search-optimization-progress.md)、[NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md)

## 1. 问题陈述

当前 NekoSearch / Image Search 的搜索链路存在一个核心瓶颈：**整图 CLIP/DINO 向量被背景、风格、文字和通用语义主导，用户关心的具体主体（特定人物、特定物品）不是主特征**。

具体表现为：
- 同一主体跨背景/姿态/裁剪时，整图距离可能**大于**同背景的错误主体
- 用户搜"这只包"时，结果返回同色系但不同款的包（因为背景相似）
- 用户搜"这个人"时，结果返回同场景的其他人物（因为环境相似）
- 以上问题在[现有审计](../audits/2026-07-18-neko-search-complete-audit.md)和[修复验证](../benchmark/2026-07-16-neko-search-remediation-verification.md)中被反复确认

**目标**：让搜索行为从"找相似的图"升级为"找同一个主体"，达到人脸识别级别的精准匹配。

## 2. 核心思路

```
整图搜索（现状）                    主体搜索（目标）
┌──────────┐                       ┌──────────┐
│  整图     │                       │  主体检测  │
│  CLIP/DINO│                       │  (YOLO)   │
│  embedding │                       │     ↓     │
└─────┬────┘                       │  去背景    │
      │                            │  crop     │
      ▼                            │     ↓     │
  搜到相似的"图"                    │  专用特征  │
  （含背景/风格/文字）              │  (DINO/    │
                                    │  AdaFace/  │
                                    │  OSNet)    │
                                    └─────┬────┘
                                          ▼
                                    搜到同一个"主体"
                                    （不含背景干扰）
```

**关键转变**：不是替换现有模型，而是在现有流水线前面加一个"主体提取层"，让后续的 embedding 只看到干净的主体。

## 3. 分阶段方案

### 3.1 阶段总览

| 阶段 | 目标 | 新增模型 | 周期 | 前置 |
|------|------|----------|------|------|
| **Phase 1** | ✅ 已实现 | center crop → gradient saliency | 零新模型，sharp Sobel 梯度检测 |
| **Phase 2** | 待实施 | 人脸精准匹配：RetinaFace（3MB）+ AdaFace（5MB）| ~2天 |
| **Phase 3** | 待实施 | 全身行人重识别：OSNet-AIN（8MB）| ~2天 |
| **Phase 4** | 待实施 | 开放词汇检测 + 精细分割：Florence-2（300MB）+ SAM 2（40MB）| ~4天 |

---

### Phase 1 · 通用主体检测 + DINOv2 主体搜索（P0，最先实施）

#### 模型选型

| 环节 | 选型 | 理由 |
|------|------|------|
| 检测 | **YOLOv8-nano ONNX**（6MB） | COCO 80 类含 person/bag/phone/shoe/bottle/chair 等日常物品；CPU ~50ms/图；ONNX 生态成熟可复用现有子进程架构 |
| 分割 | YOLOv8 instance segmentation（内置） | 检测框 + 轮廓蒙版一步到位，无需额外模型 |
| 特征 | **已有 DINOv2 ViT-B/14** | 零新模型，直接对裁剪后的主体区域做 embedding |

#### 数据流

```
用户上传图片
  │
  ▼
YOLOv8-nano 子进程（复用 dinoEmbeddingChild.ts 架构）
  │
  ├── 检测到 person ×2, backpack ×1, phone ×1
  │
  ▼
每个检测结果 → 基于蒙版裁剪主体区域（去背景）
  │
  ▼
每个主体 crop → DINOv2 embedding（已有, 768d）
  │
  ▼
写入 subject_embedding store（新增，独立于全局 embedding）
  │
  ▼
对每个主体在素材库中做余弦搜索
  │
  ▼
结果按主体分组展示
```

#### 与全局 embedding 的关系

```
素材库图片入库时：
  全局 embedding（现状）  →  用于"相似图搜索"（背景/风格/构图）
  + 主体 embedding（新增） →  用于"同款搜索"（只看主体，忽略背景）
  + 每个图片可有 0~N 个主体 embedding

搜索时：
  查询图 → 检测主体 → 主体 embedding → 与素材库的主体 embedding 做余弦搜索
  如查询图检测不到主体 → 自动回退到整图全局 embedding 搜索（不退化体验）
```

#### 新增文件

| 层 | 文件 | 说明 |
|----|------|------|
| Electron | `electron/subjectDetectionChild.ts` | YOLOv8 子进程入口（~80行） |
| Electron | `electron/subjectDetectionService.ts` | 检测任务调度、结果缓存（~150行） |
| Electron | `electron/subjectSearchIpc.ts` | IPC 通道注册（~120行） |
| Electron | `electron/subjectEmbeddingStore.ts` | 主体 embedding 持久化（JSONL, ~100行） |
| Shared | `shared/ipc-contract.ts` | 新增 SubjectDetection / SubjectSearch 类型 |
| Preload | `electron/preload.ts` | 新增 `subject` 命名空间 |
| Renderer | `src/components/SubjectSearchOverlay.tsx` | 主体检测结果叠加层（~200行） |
| Renderer | `src/services/subjectSearchBridge.ts` | 前端封装（~80行） |
| Build | `vite.config.mjs` | 新增 subjectDetectionChild entry |

#### 前端交互

```
┌─ 精准搜索 ───────────────────────────────────────────┐
│  [拖入图片] [粘贴图片] [从素材库选择]                     │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  🛜 查询图 │  │  👤 Person │  │  👜 Bag   │            │
│  │          │  │  主体 1   │  │  主体 2   │            │
│  │  (原图)  │  │  [搜同款]  │  │  [搜同款]  │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│                    ↓              ↓                    │
│                                                        │
│  ── 同款人物 (Person) ───────────────────────────────│
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                         │
│  │92% │ │88% │ │85% │ │82% │  ← 主体相似度           │
│  │    │ │    │ │    │ │    │                         │
│  └────┘ └────┘ └────┘ └────┘                         │
│                                                        │
│  ── 同款包 (Bag) ────────────────────────────────── │
│  ┌────┐ ┌────┐                                        │
│  │95% │ │90% │  ← 同款包的精准匹配                     │
│  │    │ │    │                                        │
│  └────┘ └────┘                                        │
└────────────────────────────────────────────────────────┘
```

---

### Phase 2 · 人脸精准匹配（P1）

#### 模型选型

| 环节 | 选型 | 说明 |
|------|------|------|
| 人脸检测 | **RetinaFace** 或 **YOLOv8-face 分支**（~3MB ONNX） | 5 点关键点，比通用 YOLO 更准 |
| 人脸对齐 | 关键点 → 仿射变换 → 112×112 | 标准化人脸朝向和尺寸 |
| 人脸特征 | **AdaFace**（~5MB ONNX） | 512d 嵌入，Apache 2.0 许可，学术效果与 ArcFace 持平但无商业授权风险 |

#### ⚠️ 授权说明

ArcFace（InsightFace）的预训练权重商业授权不明确，**不推荐**集成。替代方案 AdaFace 在 LFW/CFP-FP/AgeDB 等基准上效果相当，Apache 2.0 许可，可安全商用。

#### 与 Phase 1 的协作

```
Phase 1 YOLOv8 检测到 person
  │
  ├── Phase 2 尝试人脸检测（RetinaFace）
  │     ├── 有人脸且清晰 → 人脸对齐 → AdaFace 512d → 人脸匹配（最准）
  │     └── 无人脸/模糊 → 回退到 Phase 3 全身匹配（兜底）
  │
  └── 最终分数：max(AdaFace相似度, DINO全身相似度 × 0.85)
```

---

### Phase 3 · 全身行人重识别（P1）

#### 模型选型

| 环节 | 选型 | 说明 |
|------|------|------|
| 人体检测 | Phase 1 YOLOv8 | 复用 |
| 行人特征 | **OSNet-AIN** ONNX（~8MB） | 512d，专为遮挡/姿态变化/跨摄像头设计，比 DINOv2 在行人重识别上更准 |

#### 适用场景

- 人脸不可见（背影、侧脸、戴口罩、远景）
- 全身穿搭匹配（同一套衣服/体态）
- 监控/连拍场景的人物关联

---

### Phase 4 · 开放词汇检测 + 精细分割（P2，远期）

#### 模型选型

| 环节 | 选型 | 说明 |
|------|------|------|
| 开放检测 | **Florence-2 base** ONNX（~300MB） | 支持文字提示，如"红色高跟鞋"、"白色T恤" |
| 精细分割 | **SAM 2 tiny** ONNX（~40MB） | 像素级边缘分割，比 YOLO mask 更精确 |

#### 适用场景

- 用户指定"搜穿红色上衣的人"
- 复杂场景中精确分离前景主体
- 产品图精细抠图后做同款搜索

**注意**：Phase 4 不做实时推理，改为**素材库入库时后台预处理**——入库时批量跑检测+分割+crop，存主体索引，搜索时直接查。

## 4. 模型总览

| 阶段 | 模型 | 大小 | 用途 | 新增/复用 |
|------|------|------|------|-----------|
| Phase 1 | **sharp Sobel 梯度** | 0MB | 主体检测（边缘密度定位） | ✅ 已实现 |
| Phase 2 | **RetinaFace** + **AdaFace** | 8MB | 人脸检测 + 人脸特征 | 🆕 |
| Phase 3 | **OSNet-AIN** | 8MB | 全身行人重识别 | 🆕 |
| Phase 4 | **Florence-2 base** + **SAM 2 tiny** | 340MB | 开放词汇检测 + 精细分割 | 🆕 |

**Phase 1-3 新增模型总量 ~22MB**，远小于已有的 CLIP+DINOv2（~315MB）。

## 5. 与现有系统的复用

```
新增                          │  已有（复用）
──────────────────────────────┼──────────────────────────────
subjectDetectionChild.ts      │  dinoEmbeddingChild.ts 架构
subjectDetectionService.ts    │  embeddingService.ts 任务调度
subjectEmbeddingStore.ts      │  vectorDatabaseService.ts
subjectSearchIpc.ts           │  IPC handle/invoke 模式
SubjectSearchOverlay.tsx      │  AssetLibraryPanel 素材库
                              │  fast_scanner 哈希预筛选
                              │  imageSearchBridge 封装模式
```

## 6. IPC 通道新增

```
subject:detect         → 检测图中所有主体
  Request:  { imagePath: string }
  Response: { ok, subjects: SubjectDetection[] }

subject:embed          → 对单个主体提取特征向量
  Request:  { imagePath, bbox: BBox, modelName }
  Response: { ok, vector: number[], dim: number }

subject:search         → 主体精准搜索
  Request:  { imagePath?, subjectIndex?, modelName?, topK? }
  Response: { ok, results: SubjectSearchResult[] }

subject:searchByText   → 文字指定搜某类主体（Phase 4）
  Request:  { textQuery, topK? }
  Response: { ok, results: SubjectSearchResult[] }

subject:onProgress     → 进度推送
  Payload:  SubjectTaskProgress
```

## 7. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [准确率模型路线评估](2026-07-18-neko-search-accuracy-model-evaluation.md) | 本文是其中"主体 crop"路线的具体实施拆分 |
| [审核反馈搜索方案](2026-07-15-neko-search-feedback-search-plan.md) §13.3 | 本文延续其"主体检索修正"方向 |
| [NekoSearch 当前实施基线](../current/2026-07-14-neko-search-implementation.md) | 本文是其 P2/P3 阶段预留的主体检索设计的具体化 |
| [NekoSearch 完整多维审计](../audits/2026-07-18-neko-search-complete-audit.md) | 本文直接针对审计中"整图向量不能代表主体身份"这一核心问题 |

## 8. 门禁条件（Phase 1）

Phase 1 上线前必须通过：

1. **主体检测可用性**：YOLOv8-nano 在 CPU 上检测到至少 person/bag/shoe 三类常见主体
2. **无退化**：检测不到主体时自动回退到整图搜索，现有搜索准确率不下降
3. **性能**：单图主体检测+分割 < 200ms（CPU），不阻塞 UI
4. **存储**：主体 embedding 与全局 embedding 隔离，不触发全量重建
5. **前端**：主体检测结果正确叠加在原图上，用户可选择搜索哪个主体

## 9. 实现预估

| 维度 | Phase 1 | Phase 2+3 | Phase 4 |
|------|---------|-----------|---------|
| 新增模型 | 1 个 (6MB) | 3 个 (16MB) | 2 个 (340MB) |
| 新增 TS 代码 | ~1000 行 | ~600 行 | ~800 行 |
| 新增 C++ 代码 | 0 | 0 | 0 |
| 开发周期 | ~3 天 | ~4 天 | ~4 天 |
| 风险 | 低（YOLOv8 ONNX 成熟） | 中（AdaFace 授权确认） | 高（大模型 ONNX 兼容性） |
