# ImageSearch 全盘级以图搜图重构方案（终版）

> 基于 Floating Clock Electron 项目。  
> 目标：全盘索引、低资源占用、边扫边搜、USN 增量、不依赖 .NET。  
> 技术路线：Electron + C++ Node Addon + mmap 列式索引 + 感知哈希 + SIMD 精排。

---

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 容器 | Electron | 复用现有 Floating Clock |
| UI | React + Zustand + DraggablePanel | 复用现有面板模式 |
| 引擎 | C++ Node Addon (N-API) | 单文件 .node ~300KB |
| 图像解码 | libjpeg-turbo (JPEG) + stb_image (兜底) | JPEG 降采样解码，覆盖 85%+ |
| 图像缩放 | stb_image_resize | 单头文件 |
| 文件枚举 | FSCTL_ENUM_USN_DATA → Raw MFT → Everything → FindFirst | 四级 fallback |
| 增量更新 | USN Journal | <1ms |
| 索引存储 | Segment mmap 列式二进制 | 零拷贝读取 |
| 搜索召回 | Multi-Index LSH + Global Directory | 候选集缩减到 0.01%×N |
| 精确比对 | AVX2 SIMD + popcount | 汉明距离 |
| 并发模型 | 单写多读 + Manifest 原子发布 + RCU 快照 | 边扫边搜 |

---

## 2. 总体架构

```
Electron Renderer (React)
  └─ ImageSearchPanel.tsx (DraggablePanel 模式)
       ↓ contextBridge IPC
Electron Main Process
  ├─ scanner-service.ts   (扫描生命周期)
  ├─ index-service.ts     (索引管理)
  └─ search-service.ts    (搜索编排)
       ↓ N-API direct call
C++ Node Addon (fast_scanner.node)
  ├─ Scanner Engine       (文件枚举)
  ├─ Hash Compute Engine  (图像哈希)
  ├─ Segment Index Engine (mmap 索引)
  ├─ Searcher Engine      (搜索匹配)
  ├─ USN Journal Engine   (增量更新)
  └─ Compact Engine       (碎片合并)
```

---

## 3. 模块设计

### 3.1 文件枚举（Scanner Engine）

四级 fallback：

| 优先级 | 方案 | 触发 | 耗时 (HDD) | 耗时 (NVMe) | 依赖 |
|--------|------|------|-----------|------------|------|
| L0 | 已有 manifest + segment | 启动 | <0.1s | <0.1s | 无 |
| L1 | FSCTL_ENUM_USN_DATA | L0 不足 + NTFS | ~60s | ~3s | 管理员权限 |
| L2 | Everything IPC | L1 失败 | 1-3s | 1-3s | Everything 运行中 |
| L3 | Raw MFT 直读 | 实验性开启 | ~70s | ~3s | 管理员权限 |
| L4 | FindFirst/FindNext | 兜底 | 30-60 分 | — | 无 |

核心机制：

- **FRN Map 分批** — 枚举一批 → 路径重建 → 推入 FileTaskQueue → 释放 FRN Map → 下一批。内存峰值可控。
- **排除目录预处理** — 扫描前递归拿到排除目录的 FRN 集合，枚举时 O(1) 判父链
- **多盘并发** — 不同物理磁盘可并行，同磁盘串行
- **默认排除** — `C:\Windows`, `Program Files`, `node_modules`, `.git` 等

### 3.2 增量更新（USN Journal）

```
首次扫描 → 记录 last_usn + usn_journal_id
  ↓
每 30 秒读 USN Journal 增量
  ├─ USN_REASON_FILE_CREATE      → 推入 Hash Queue
  ├─ USN_REASON_DATA_OVERWRITE   → 旧记录 tombstone + 重新哈希
  ├─ USN_REASON_DATA_EXTEND      → 同上
  ├─ USN_REASON_DATA_TRUNCATION  → 同上
  ├─ USN_REASON_FILE_DELETE      → tombstone
  └─ USN_REASON_RENAME_*         → tombstone 旧名 + 新名入 Hash Queue
```

Journal 被重置 → `needs_full_scan = true` → 自动回退全量。

### 3.3 图像哈希（Hash Compute Engine）

#### 解码内存优化（关键）

```
格式分派:
  JPEG (85%+) → libjpeg-turbo 降采样解码
    scale 1/8:  8000×6000 全量 48MB → 降采样 1000×750 = 750KB
    16 线程峰值: 48MB vs 768MB (差 16 倍)

  WebP → libwebp 缩放解码 (V2)
  PNG  → WIC 逐行解码 / stb_image 兜底
  其他 → stb_image (仅限 <4MB 文件, 否则跳过)
```

#### 多尺度哈希

| 尺度 | 用途 | 来源 |
|------|------|------|
| 80px | 小图、缩略图、快速召回 | scale 1/8 后缩放 |
| 160px | 默认主尺度 | scale 1/8 后缩放 |
| 320px | 大图、低误报 | scale 1/8 后缩放 |

#### 算法矩阵

| 阶段 | 算法 | 说明 |
|------|------|------|
| V1 | DiffHash64 + DctHash64 (160px) | 单尺度双算法 |
| V2 | DiffHash64 + DctHash64 (80/160/320) | 三尺度 |
| V3 | DiffHash256 (三尺度) + DctHash64 + DctHash32 | 完整矩阵 |

#### 上采样保护

源图短边 < 目标尺度 → 不强行放大，使用 `min(short_edge, target)`。

#### 旋转/翻转

不存入索引。查询时计算变体（原图/90°/180°/270°/水平/垂直），在查询端比对。

#### GIF 策略

V1 只取首帧，V2 逐帧。

### 3.4 索引存储（Segment mmap）

#### 文件格式 `.idx`

```
┌─────────────────────────┐
│ SegmentHeader    512B   │  magic "IMS1", version, count, state
├─────────────────────────┤
│ SectionTable             │  SectionDesc[section_count]
├─────────────────────────┤
│ PathOffsets Section      │  uint64[record_count+1]
├─────────────────────────┤
│ PathBytes Section        │  连续 UTF-8 字节流
├─────────────────────────┤
│ Metadata Section         │  ImageMetaV1[record_count]
├─────────────────────────┤
│ Hash Sections (列式)     │
│  Diff64_80  [N]         │
│  Diff64_160 [N]         │
│  Diff64_320 [N]         │
│  Dct64_80   [N]         │
│  Dct64_160  [N]         │
│  Dct64_320  [N]         │
│  Dct32_*    [N]  (V3)   │
│  Diff256_*  [N]  (V3)   │
├─────────────────────────┤
│ LocalIndex Section       │  排序桶 + 二分查找 (mmap 友好)
├─────────────────────────┤
│ DeletedBitmap Section    │  bitset[N]
├─────────────────────────┤
│ Footer           256B    │  magic "END!", checksum
└─────────────────────────┘
```

- **字节序**：Little Endian
- **对齐**：64B
- **校验**：xxHash64
- **加载**：mmap 映射，OS 按需换页，0.1s 就绪

#### 体积

| 规模 | 单尺度 | 三尺度 |
|------|--------|--------|
| 10 万 | 6 MB | 18 MB |
| 100 万 | 60 MB | 180 MB |
| 1000 万 | 600 MB | 1.8 GB |

#### Global Directory

独立文件 `global_directory.idx`：subhash_key → segment_id[]。查询时先查 GD 跳过无关 segment，再进 segment local index 查候选。

---

## 4. Segment 原子状态机

### 状态定义

```
None → Building → Sealing → SealedTmp → Committing → Committed → Active
                                                                    ↓
                                                              Compacting
                                                                    ↓
                                                              Replaced
                                                                    
异常: Building/Sealing/SealedTmp → Corrupt → 丢弃
删除: Active → Tombstoned
```

### 提交流程

```
1. Builder 写入 active/building_xxx.tmp (state=Building)
2. 达到阈值 → Seal (state=Sealing)
3. 写 Footer + Checksum → 移动到 staging/ (state=SealedTmp)
4. 校验 → 移动到 segments/xxx.idx
5. 经 CommitGate 写入 manifest.tmp → atomic rename → manifest.json
6. mmap 加载 → 注册到 Searcher (state=Active)
```

### 启动恢复

| 状态 | 处理 |
|------|------|
| building.tmp 未完成 | 丢弃或继续写 |
| staging tmp 完整 | 校验后提交 |
| staging tmp 损坏 | 删除 |
| manifest 登记但 idx 缺失 | 从 manifest 移除 |
| idx 存在但 manifest 未登记 | 校验后 orphan recover |
| checksum 失败 | 标记 Corrupt |

---

## 5. 搜索匹配（Searcher Engine）

### 流程

```
查询图片 → 解码+哈希 (2ms)
  ↓
Global Directory 查 subhash → 命中 segment 列表 (0.01ms)
  ↓
各 segment Local Index 查 4 子键 → 候选集交集 (0.01ms)
  典型候选: 0.01% × N = 1000 个 (1000万库)
  ↓
从 mmap 列式读取候选 hash → SIMD 精确比对 (0.5ms)
  ┌─ DiffHash: AVX2 _mm256_xor_si256 + popcount
  ├─ DctHash64: _popcount64
  └─ DctHash32: _popcount32
  ↓
多尺度综合评分:
  score = diff64_160 × 0.35 + dct64_160 × 0.45 + best_other_scale × 0.20
  ↓
排序去重 → 输出 (0.1ms)
```

### 阈值

| 等级 | 综合分 | DiffHash 最低 | DCT 最低 |
|------|--------|--------------|----------|
| 强相似 | ≥ 0.92 | — | — |
| 普通相似 | ≥ 0.85 | ≥ 0.70 | ≥ 0.85 |
| 弱相似 | ≥ 0.75 | ≥ 0.70 | ≥ 0.85 |

### 查询尺度选择

| 查询图短边 | 首选尺度 |
|-----------|---------|
| < 100px | 80 + 160 |
| 100-250px | 160 + 80 |
| > 250px | 320 + 160 |

---

## 6. 并发模型

### 核心原则：单写多读

```
全局一个 IndexWriter     → 唯一写 segment
全局一个 CompactWorker   → 唯一生成 compact segment
全局一个 CommitGate      → 唯一更新 manifest
Searcher 多线程并发      → 只读 committed segment
Hash Compute 线程池      → 只计算，不写 segment
```

### 可见性隔离

```
Building segment   ──── Searcher 不可见
Sealing segment    ──── Searcher 不可见
SealedTmp segment  ──── Searcher 不可见
Committed segment  ──── 进入 manifest → Searcher 可见 ✓
```

### 边扫边搜保证

```
1. Builder 写入 dirty segment (Building)
2. Searcher 读取 committed segment (Active)
3. 不是一个文件 → 写入隔离 ✓
4. Commit 通过 manifest 原子发布 → 发布隔离 ✓
5. Searcher 用 snapshot 读 → 不读到一半数据 ✓
```

### RCU 快照

```cpp
std::atomic<shared_ptr<ManifestView>> g_manifest;

// Searcher:
auto snap = g_manifest.load();  // 获取快照
search(snap);                    // 搜索期间不切换

// IndexWriter commit:
auto new_view = make_shared<ManifestView>(old, new_seg);
g_manifest.store(new_view);     // 原子发布

// 旧 segment 等所有 Searcher 释放 snap 后删除
```

### 线程拓扑

```
Scanner Thread (单盘 1 个 / 多盘 N 个)
  ↓ FileTaskQueue
Hash Compute Pool (cores × 2, 最多 32)
  ↓ HashResultQueue
IndexWriter Thread (唯一)
  → SegmentBuilder → Seal → CommitGate → Manifest
  ↓
Committed Segments (mmap, 只读)
  ↓
Searcher Threads (按请求并发, 每个请求内可并行)
```

### 暂停/恢复语义

```
暂停:
  1. Scanner 停止推 FileTask
  2. Hash Compute 完成当前批次后暂停
  3. IndexWriter 消费完 HashResultQueue → Seal → Commit
  4. Searcher 不受影响（读 committed）

恢复:
  1. Scanner 从持久化断点继续

停止:
  1. 同暂停 + 持久化所有状态 + 卸载 mmap
```

### 优雅关闭

```
1. 停止 Scanner
2. 排空 FileTaskQueue
3. 等待 Hash Compute 完成
4. 排空 HashResultQueue
5. IndexWriter seal → commit
6. 持久化 USN 断点
7. 卸载所有 mmap
8. 退出
```

---

## 7. 索引构建流程

### SegmentBuilder

| 参数 | 轻量 | 平衡 | 极速 |
|------|------|------|------|
| record_limit | 50,000 | 200,000 | 500,000 |
| size_limit | 64 MB | 256 MB | 512 MB |
| hash_threads | cores/2 | cores | cores×2 |

### Seal 触发

```
record_count ≥ limit
或 estimated_bytes ≥ limit
或 活跃时间 > 10 分钟
或 flush 请求
或 程序退出
```

### Tombstone 规则

| 操作 | 处理 |
|------|------|
| 文件删除 | 写 tombstone overlay，不改旧 segment |
| 文件修改 | 旧记录 tombstone + 新 hash 入 active SegmentBuilder |
| 文件重命名 | 旧记录 tombstone + 新路径入 active SegmentBuilder |

### Compact

```
选择 deletedCount 高的 segment
  → 读取 committed 数据
  → 跳过 tombstone
  → 生成新 compact segment
  → 经 CommitGate 原子替换 manifest
  → 等旧 snapshot 释放 → 删除旧文件
```

---

## 8. 内存预算

### 索引构建（16 线程）

| 阶段 | 每线程 | 总计 | 说明 |
|------|--------|------|------|
| JPEG 降采样解码 | 3 MB | 48 MB | 1/8 scale 灰度 |
| PNG/stb 兜底 | 20 MB | 320 MB | 极端情况，罕见 |
| resize 临时缓冲 | 1 MB | 16 MB | |
| SegmentBuilder 内存列 | — | 256-512 MB | seal 阈值 |
| HashResultQueue | — | 200 MB | 背压控制 |
| **典型峰值** | | **~300 MB** | |
| **极端峰值** | | **~1 GB** | 大量超大 PNG |

### 运行时搜索

| 规模 | mmap 占用 | 驻留内存（OS 换页后） |
|------|----------|---------------------|
| 10 万 | 18 MB | ~10 MB |
| 100 万 | 180 MB | ~80 MB |
| 1000 万 | 1.8 GB | ~400 MB |

### 队列背压

```
FileTaskQueue     > 100,000    → Scanner 暂停
HashResultQueue   > 10,000     → Hash Compute 降速
WriterQueue       > 2 GB est. → Hash Compute 暂停
```

---

## 9. 依赖

| 依赖 | 用途 | 体积 | 必需 |
|------|------|------|------|
| libjpeg-turbo | JPEG 降采样解码 | ~300KB .lib | ✅ |
| stb_image | PNG/BMP/GIF 兜底 | 单头文件 | ✅ |
| stb_image_resize | 图像缩放 | 单头文件 | ✅ |
| Win32 API | MFT/USN/Everything | 系统自带 | ✅ |
| N-API (node-addon-api) | Node 绑定 | npm 包 | ✅ |

**不需要** .NET Runtime / Everything 安装 / 任何第三方运行时。

---

## 10. 发布产物

```
FloatingClock.exe
  ├─ resources/
  │   └─ fast_scanner.node   (~300KB)
  └─ 用户机器上生成:
      ├─ index/
      │   ├─ manifest.json
      │   ├─ global_directory.idx
      │   ├─ segments/*.idx
      │   └─ tombstone/*.map
      └─ scan_state.json      (USN 断点等)
```

---

## 11. 性能终局

| 操作 | 10 万图 | 100 万图 | 1000 万图 |
|------|---------|----------|-----------|
| 首次枚举 (Everything) | <1s | 1s | 2s |
| 首次枚举 (USN HDD) | 1s | 8s | 60s |
| 首次枚举 (USN NVMe) | 0.1s | 0.5s | 3s |
| 增量更新 (USN Journal) | <1ms | <1ms | <1ms |
| 索引构建 (全量) | 2s | 20s | 3 分 |
| 内存峰值 (构建) | 80 MB | 200 MB | 300 MB |
| mmap 加载 | <0.1s | <0.1s | <0.1s |
| 单次搜索 | <1ms | 1ms | 3ms |
| 索引体积 (三尺度) | 18 MB | 180 MB | 1.8 GB |

---

## 12. 落地路线

| 阶段 | 内容 |
|------|------|
| **P0** | libjpeg-turbo 降采样解码 + 单尺度哈希 + 单 segment mmap + 线性搜索 |
| **P1** | Multi-Index LSH + Global Directory + SIMD 精排 |
| **P2** | FSCTL_ENUM_USN_DATA 全盘扫描 + USN Journal 增量 + Tombstone |
| **P3** | 多尺度哈希 + Everything fallback + 边扫边搜 + 暂停恢复 |
| **P4** | Segment 原子状态机 + Recovery + Compact Engine |
| **P5** | Raw MFT Experimental + 旋转/翻转查询 + DiffHash256 |
