# 项目规模与完成度审计汇报

- 日期：2026-07-27
- 范围：全项目（electron/ src/ shared/ native/ tests/ scripts/ docs/ 构建产物）
- 性质：只读审计，未改动业务代码

---

## 一、一句话结论

项目已从"浮窗时钟"演化为功能密度很高的**本地 AI 素材工作台**，整体完成度约 **85–90%**，处于"可发布边缘、持续优化"阶段；工程纪律（测试链、文档规范、质量门禁）良好，主要风险集中在三个超大文件的可维护性与准确率验证体系缺口。

## 二、规模

| 模块 | 文件数 | 行数 |
|---|---|---|
| `electron/` 主进程 | 121 | 43,986 |
| `src/` 渲染层（React） | 80 | 25,188 |
| `native/` C++ 扫描器 | 1（+头文件） | 3,244 |
| `shared/` 契约 | 6 | 2,870 |
| `tests/` | 80 | 17,697 |
| `scripts/` | 27 | 2,806 |
| **合计** | **~315** | **~95,800** |

- IPC：16 个主进程模块，实测 **232 个 `ipcMain.handle`**，全部走 invoke 模式 + 集中通道常量 + preload 契约。
- 依赖：运行时 8 个 / 开发 16 个，控制良好。
- AI 模型实物在位约 1GB：YOLOv8n / YOLOv8-face / AdaFace(260MB) / OSNet / MobileSAM / DINOv2 / CLIP 多语言文本塔等。
- 构建产物：`release/FloatingClock Setup 1.0.0.exe` ≈ 999MB（2026-07-27 构建，含中文语义搜索与图标修复）。
- Git：2026-07-27 完成首个提交 `ff5605e`，`models/`、`ai-models/`、产物目录均已 ignore。

## 三、质量门禁现状

- `npm run typecheck`：**通过，0 错误**。
- 测试总链由 **28 个子套件**串联：git-policy、guards、IPC 校验/注册、preload 契约、文件管理安全/事务/监视器、素材库（含 SQLite/备份/去重/聚类）、远程终端/SFTP/传输压测、向量、批量重命名、人脸、行人 ReID、主体裁剪，最后 native 构建+测试。
- skip/todo 仅 3 处，均为环境条件跳过（junction 不可用 ×2、需先构建渲染层 ×1），无被跳过的功能测试。
- TODO/FIXME/HACK：src/shared 为 0，electron 仅 5 处，全部位于 3 个无引用死文件。

## 四、各功能域完成度

| 功能域 | 完成度 | 依据 |
|---|---|---|
| 图片/视频搜索（ANN、rerank、抽帧） | ~90% | 缩略图 CPU/GPU 异步流水线 07-24 完成；抽帧 31/31 测试 |
| 素材库 NekoSearch | ~85% | 07-18 审计 87/100；缺真实标注门禁 |
| 主体精准搜索（face/ReID/SAM） | ~85% | Phase 1.5/2/3 完成（face 0.95、ReID P@50 0.98、实例 P@10 1.0）；Phase 4 暂缓 |
| 文件管理 | ~90% | 安全/事务/监视器测试齐备 |
| SSH/SFTP 远程终端 | ~85% | 4 条测试链含压测；已完成 WindTerm 重构 |
| 设置/存储/备份 | ~90% | 快照/校验/恢复 journal/故障注入完整 |
| OCR / 局部特征检索 | 0% | 3 个死 stub 文件，功能不存在 |

## 五、主要风险与欠债（按优先级）

1. **巨型单体（可维护性最大短板）**：`electron/assetLibraryService.ts` 3614 行、`src/components/AssetLibraryPanel.tsx` 2874 行、`native/fast_scanner.cc` 3244 行。07-18 审计结构维度仅 63/100。
2. **准确率门禁缺口**：固定真实标注集未建；阈值真实库校准（Jaccard 0.5、dHash d≤8）未完成；中文语义搜索打包验证未做。
3. **死代码**：`electron/localFeatureService.ts`（43 行）、`objectCropService.ts`（51 行）、`ocrService.ts`（46 行）无任何引用；`native/stb_image_resize.h` 为 0 字节残留。建议删除或立项实现。
4. **版本纪律**：package.json 恒为 1.0.0，多轮功能进安装包但版本不递增；Git 历史 07-27 才开始（此前无版本控制现场）。
5. **依赖安全**：07-18 审计安全 85/100，依赖项仍有缺口。
6. 小项：根目录空的 `electron-crash-*.log`（6 月残留）可清理。

## 六、后续建议

- 短期：清理死代码与残留文件；递增版本号并建立 release 记录；保持每次功能变更同步 `docs/current/`。
- 中期：拆分 `assetLibraryService.ts` / `AssetLibraryPanel.tsx`（按领域抽 service/子组件）；建立真实标注集准确率门禁。
- 可选方向：`docs/AI_AGENT_API_PROPOSAL.md` 已给出 AI agent 控制接口方案（本地 HTTP/WS 控制面 + MCP 封装），可作为下一个里程碑候选。

## 七、审计依据

- 代码统计：`find + wc -l` 实测；IPC handler 计数 232。
- 文档：`docs/current/2026-07-24-feature-implementation-handoff.md`（§1–§30 全完成）、`docs/audits/2026-07-18-neko-search-complete-audit.md`（87/100）。
- 命令验证：`npm run typecheck` 全绿；`release/` 产物大小与日期实测。
