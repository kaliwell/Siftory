# 窗口与数据处理隔离、Simple 自动后端

> 状态：当前
> 更新日期：2026-08-17
> 范围：数据处理隔离与 Simple 自动计算后端
> 替代文档：无

日期：2026-07-31
实施状态：已实现并通过专项验证

## 问题

- DINO/CLIP 推理虽已使用独立子进程，但大目录枚举、已有向量读取、工程预览映射和输入校验仍在 Electron 主进程执行。
- 每条新向量通过同步文件写入保存，长时间构建期间会反复阻塞窗口事件循环。
- Image Search 与 Media Search 的 Simple 流程使用了不一致的 CPU/GPU 固定值；无 GPU 机器缺少统一回退策略。
- IPC 曾遗漏 `batchSize`，Simple 界面的批量配置没有完整传到推理服务。

## 实现

1. 新增统一计算后端能力探测。排除 SwiftShader、Microsoft Basic Render Driver 等软件适配器；Simple 自动选择可用硬件 GPU，否则使用 CPU。
2. Image Search 和 Media Search 的 Simple DINO/CLIP 流程统一请求 `auto` 后端，并在准备步骤显示实际选择的设备。
3. 新增 `embeddingPreparationChild` 数据进程。大目录遍历、已有向量快照/尾部读取、工程源文件到预览图映射、图片签名校验全部在该进程执行。
4. 数据进程只分块返回需要推理的有效任务，避免主进程持有整盘候选列表。
5. 向量 JSONL 改为串行异步写入，避免同步磁盘 I/O 阻塞窗口；构建完成会等待持久化队列清空。
6. IPC 现在完整转发 `batchSize`，并由主进程统一解析最终 CPU/GPU 后端。
7. 新数据进程已加入 Vite 构建、安装包 `extraResources` 和发布资源完整性检查。

## 验证

- TypeScript 类型检查通过。
- ESLint 无新增错误或警告。
- Vector Pipeline 53 项通过，包含硬件 GPU 选择、无 GPU CPU 回退测试。
- Project Preview 14 项通过，确认工程文件仍通过预览代理参与向量构建。
- 独立数据进程使用真实 `Desktop\logo` 目录 smoke：发现 57 个候选，验证并返回 43 个栅格输入，正常完成。
- 生产构建生成 `dist-electron/embeddingPreparationChild.js`。

## 边界

本次优先隔离向量建库最重的准备和写入路径。哈希扫描、缩略图、DINO/CLIP 推理原本已分别使用原生异步任务、GPU renderer 或模型子进程。后续若 Media Search 的 FFmpeg 编排或向量索引重建仍出现独立卡顿，应按同一原则继续迁移到专用数据进程。
