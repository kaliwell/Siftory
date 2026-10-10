# 批量图片命名恢复

> 状态：待实施  
> 更新日期：2026-07-24  
> 项目：FloatingClock Electron  
> 日期：2026-07-24  
> 类型：新增功能落地方案  
> 复用范围：Image Search（fast_scanner hash 引擎、以图搜图 IPC）、File Manager（文件复制、缩略图）

## 1. 功能定位

图片经过二次修改（裁剪、滤镜、压缩、格式转换）后文件名通常会改变。数量多时无法手工对应回原始文件。本功能通过"以图搜图"自动匹配修改后的图片与原始图片，将修改后的图片用原名复制到输出文件夹。

核心价值：**零新模型、零新 C++ 代码、完全复用现有 fast_scanner 感知哈希管线。**

## 2. 使用场景

| 输入 | 说明 |
|------|------|
| 文件夹1（原名源） | 包含原始命名的图片，如 `cat.png`、`dog.png`、`bird.png` |
| 文件夹2（改名后） | 二次修改后的图片，如 `img001.jpg`、`img002.jpg`、`img003.jpg` |
| 文件夹3（输出） | 匹配成功后，用原名复制到此处：`cat.png`（来自 img001）、`dog.png`（来自 img002） |

## 3. 处理流程

```
文件夹1 (原名源)                    文件夹2 (改名后)
┌──────────────┐                   ┌──────────────┐
│ cat.png      │──DiffHash64──┐    │ img001.jpg   │──DiffHash64──┐
│ dog.png      │──DiffHash64──┤    │ img002.jpg   │──DiffHash64──┤
│ bird.png     │──DiffHash64──┘    │ img003.jpg   │──DiffHash64──┘
└──────────────┘                   └──────────────┘
       │                                  │
       ▼                                  ▼
  hashDb_origin                    hashDb_modified
  (内存 Map)                       (逐个查询)
       │                                  │
       │    ┌─────────────────────────────┘
       │    │
       ▼    ▼
  对每张修改后的图 → searchByImage(threshold, topK=1)
       │
       ├── 命中且 score ≥ threshold → 复制到输出文件夹，用原名
       ├── 命中但 score < threshold → 放入 _unmatched/ 子目录
       └── 未命中（无候选） → 跳过或放入 _unmatched/
```

### 3.1 分步说明

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 扫描文件夹1 | `scanDirectory(paths)` — 对所有原始图片计算 hash，存临时内存索引 |
| 2 | 扫描文件夹2 | 同上，枚举改名后的图片列表 |
| 3 | 逐个匹配 | 对文件夹2 每张图调 `searchByImage`，threshold 默认 0.85，topK=1 |
| 4 | 处理结果 | 命中 → `fs.copyFile` 到文件夹3，保持原名 + 源扩展名 |
| 5 | 冲突处理 | 多个改名图命中同一原图 → 保留最高分；原名冲突 → 追加 `_n` 后缀 |
| 6 | 报告 | 返回 JSON 报告：匹配数/未匹配数/冲突数/耗时 |

### 3.2 匹配策略

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `threshold` | 0.85 | 综合分数阈值（DiffHash64 × 0.7 + DctHash64 × 0.3） |
| `topK` | 1 | 每张图只取最优匹配 |
| `searchMode` | `'balanced'` | 前缀桶 + 不足时回退全扫描 |
| `conflictPolicy` | `'keep-best'` | 多对一：保留最高分；一对多：追加后缀 |

## 4. 复用关系

| 能力 | 复用模块 | 改动 |
|------|----------|------|
| 图像哈希 | `fast_scanner` C++ addon | 零改动 |
| 相似搜索 | `imageSearchService.searchImagesAsync()` | 零改动 |
| 目录扫描 | `nativeAddon.scanDirectory()` | 零改动 |
| 文件复制 | File Manager 已有的 `fmCopyFiles` 事务机制 | 零改动 |
| 路径安全 | `pathGuards.ts` — `safeShellPath`、`normalizeUserPath` | 零改动 |
| 进度推送 | 复用 `MediaSearchTaskProgress` 模式 | 参照实现 |

## 5. 新增模块

### 5.1 IPC 通道

```
┌────────────────────────────────────────────────────────────┐
│ batchRename:start     → 启动匹配任务                        │
│   Request:  { originDir, modifiedDir, outputDir,           │
│               threshold?, conflictPolicy? }                │
│   Response: { taskId, originCount, modifiedCount }         │
│                                                            │
│ batchRename:stop      → 停止任务                            │
│   Response: { ok }                                        │
│                                                            │
│ batchRename:getProgress → 轮询进度                          │
│   Response: BatchRenameProgress                           │
│                                                            │
│ batchRename:onProgress → 进度推送 (webContents.send)        │
│   Payload:  BatchRenameProgress                           │
└────────────────────────────────────────────────────────────┘
```

### 5.2 类型定义

```typescript
interface BatchRenameProgress {
  taskId: string
  state: 'scanning-origin' | 'scanning-modified' | 'matching' | 'copying' | 'done' | 'stopped' | 'error'
  originTotal: number
  modifiedTotal: number
  matched: number
  unmatched: number
  conflicts: number
  copied: number
  currentFile?: string
  elapsedMs: number
  etaMs?: number
  error?: string
}

interface BatchRenameResult {
  taskId: string
  matched: Array<{ originalName: string; modifiedPath: string; outputPath: string; score: number }>
  unmatched: string[]       // 改名后未匹配的文件路径
  conflicts: string[]       // 冲突详情
  skippedOriginals: string[] // 源文件中未被任何改名图匹配的
  durationMs: number
}
```

### 5.3 文件清单

| 层 | 文件 | 说明 |
|----|------|------|
| Main | `electron/batchRenameIpc.ts` | IPC 注册 + 任务编排（~100行） |
| Main | `electron/batchRenameService.ts` | 核心匹配逻辑（~150行） |
| Shared | `shared/ipc-contract.ts` | 新增类型 + IPC 通道常量 |
| Preload | `electron/preload.ts` | 新增 `batchRename` 命名空间 |
| Renderer | `src/components/BatchRenamePanel.tsx` | 前端面板（~300行） |
| Renderer | `src/services/batchRenameBridge.ts` | 前端 IPC 调用封装（~60行） |

## 6. 前端交互

```
┌─ Batch Rename Recovery ───────────────────────────────┐
│                                                        │
│  原始命名文件夹  [C:\originals\     ] [选择文件夹]      │
│  改名后文件夹    [C:\modified\     ] [选择文件夹]      │
│  输出文件夹      [C:\output\       ] [选择文件夹]      │
│                                                        │
│  匹配阈值: [══════════╪══════════] 0.85                │
│  搜索模式: ○ fast  ● balanced  ○ recall                │
│  冲突策略: ● 保留最佳  ○ 跳过  ○ 保留两者              │
│                                                        │
│  [开始匹配]  [停止]                                     │
│                                                        │
│  状态: 正在匹配...                                     │
│  进度: ████████████░░░░░░ 67%                          │
│  ✓ 匹配: 120  ✗ 未匹配: 14  ⚠ 冲突: 3                  │
│  当前: img042.jpg  →  cat.png (92%)                    │
│  耗时: 00:00:23  预计剩余: 00:00:11                     │
│                                                        │
│  ── 结果（任务完成后）────────────────────────────── │
│  img001.jpg → dog.png  (95%)  → C:\output\dog.png      │
│  img002.jpg → cat.png  (92%)  → C:\output\cat.png      │
│  img003.jpg → bird.png (88%)  → C:\output\bird.png     │
│  img004.jpg → (无匹配)          → _unmatched\          │
│                                                        │
│  [在文件管理器中打开输出文件夹]  [导出报告]             │
└────────────────────────────────────────────────────────┘
```

## 7. 边界条件

| 场景 | 处理 |
|------|------|
| 原名源文件夹为空 | 返回错误，不启动任务 |
| 改名后文件夹为空 | 同上 |
| 输出文件夹已存在同名文件 | 按 conflictPolicy 处理 |
| 改名图片尺寸/色彩大幅变化 | 降低 threshold 或使用 recall 模式 |
| 多张改名图匹配到同一原图 | 保留最高分，其他标记为冲突 |
| 一张改名图匹配到多个原名 | 取 top-1 |
| 源文件格式与改名后不同 | 输出用原名 + 源扩展名，内容来自改名后的图片 |
| 文件夹路径不可访问 | 返回 `error`，任务进入 error 状态 |
| 磁盘空间不足 | 复制阶段捕获 `ENOSPC`，暂停任务并报告 |

## 8. 实现预估

| 维度 | 估计 |
|------|------|
| 新增 C++ 代码 | 0 行 |
| 新增 TS 代码 | ~700 行 |
| 新模型 | 0 个 |
| 新 npm 依赖 | 0 个 |
| 开发周期 | ~1 天 |
| 风险等级 | 极低（纯复用现有引擎） |
