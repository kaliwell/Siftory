# Image Search / Media Search 简单与高级模式

> 状态：当前  
> 更新日期：2026-07-13  
> 范围：`src/components/ImageSearch*`、`src/components/MediaSearch*`、`src/services/searchSetupWorkflow.ts`  
> 替代文档：无

## 快速结论

Image Search 和 Media Search 已从单一高级操作界面调整为两级体验：

- `Simple` 是默认模式，用户选择路径后点击一次 `Prepare Library` 即可完成搜索前的数据准备。
- `Advanced` 保留扫描、模型、CPU/GPU、索引、缓存和维护控件。
- Image Search 的结果展示固定为 `Large` 大图卡片，不再提供不适合图片浏览的 List 模式。
- 两种模式使用同一份 manifest、frame、embedding 和索引，不建立平行数据链。
- 一键流程有步骤状态、总进度、错误反馈和取消能力。

当前源码验证为 143/143 测试通过；开发态 Electron UI smoke 为 5/5 面板、0 console error，两个搜索面板的模式切换回归均通过。

## 1. 目标与非目标

### 1.1 目标

1. 降低首次使用 Image Search 和 Media Search 时的按钮理解成本。
2. 把必须按顺序执行的扫描、模型准备、embedding 和索引操作组合为一键任务。
3. 保留专业用户对扫描方式、模型、GPU 路数、缓存和索引维护的控制。
4. 复用现有任务、数据和 IPC，避免简单模式产生另一套状态或索引。
5. 长任务必须持续反馈进度，并且能够停止。

### 1.2 非目标

1. 不改变搜索评分、TopK、scope 或排序算法。
2. 不改变现有 manifest、embedding shard、Frame Index 或 Vector Index 格式。
3. 不自动删除已有数据、缓存或用户路径。
4. 不隐藏高级模式中的原有能力。
5. 不把模型下载、扫描或推理搬回 Renderer 执行。

## 2. 模式行为

| 能力                        | Simple         | Advanced   |
| --------------------------- | -------------- | ---------- |
| 路径选择与移除              | 显示           | 显示       |
| 图片/文本查询               | 显示           | 显示       |
| 一键准备素材库              | 显示           | 不显示     |
| 扫描模式与独立扫描按钮      | 隐藏           | 显示       |
| 模型和 CPU/GPU 参数         | 自动选择       | 显示       |
| 独立 embedding / frame 构建 | 隐藏           | 显示       |
| 索引和缓存维护              | 隐藏           | 显示       |
| 排序、阈值和分数            | 使用稳定默认值 | 显示       |
| Image Search 结果视图       | 固定 Large     | 固定 Large |
| Media Search 结果视图       | 使用稳定默认值 | 显示       |

模式选择分别写入：

```text
imageSearch.experienceMode
mediaSearch.experienceMode
```

首次使用或没有历史值时默认 `simple`。一键任务运行期间禁用模式切换，防止任务控制组件在执行过程中被卸载。

## 3. 复用架构

```text
SearchExperienceModeBar
        |
        v
ImageSearchPanel / MediaSearchPanel
        |
        v
runSetupWorkflow
        |
        +--> existing scan IPC
        +--> existing model registry/download IPC
        +--> existing embedding IPC
        +--> existing vector/frame index update
        |
        v
existing manifests, frames, embeddings and indexes
```

公共实现：

- `src/components/SearchExperienceModeBar.tsx`：Simple/Advanced 分段选择。
- `src/components/SearchSetupProgress.tsx`：步骤、总进度、完成、失败和取消反馈。
- `src/services/searchSetupWorkflow.ts`：串行步骤编排、子进度映射、失败短路与 AbortSignal。

现有服务继续作为事实来源：

- Image Search 扫描仍由 `imageSearchBridge` 和 Native `fast_scanner.node` 执行。
- Media Search 扫描、抽帧和帧 embedding 仍由 `mediaSearchBridge` 执行。
- 模型状态、下载、embedding 和 Vector Index 仍通过 `window.electronAPI.vector` 执行。
- Media Search Frame Index 继续使用 embedding 完成后的现有异步更新逻辑。

## 4. Image Search 一键流程

`Prepare Library` 按以下顺序执行：

1. 使用 `balanced + update` 扫描所选路径，只更新变化文件。
2. 检查 `dinov2_vitb14`；缺失时调用现有模型下载流程。
3. 为所选路径补齐 DINO global embedding。
4. 检查 `clip_vit_base_patch32`；缺失时调用现有模型下载流程。
5. 使用 GPU 和用户已保存的 `gpuJobs` 补齐 CLIP global embedding。
6. 为 DINO 构建 Vector Index。

选择整个盘符时继续使用原有全盘扫描确认框。简单模式搜索使用稳定的 `standard` 查询策略；高级模式保留用户选择的搜索模式。

## 5. Media Search 一键流程

`Prepare Library` 按以下顺序执行：

1. 使用 metadata 模式扫描所选视频路径。
2. 为所选范围提取视频关键帧。
3. 检查并准备 `dinov2_vitb14`。
4. 使用 CPU 单路构建 DINO frame embedding，优先保证长任务稳定性。
5. 检查并准备 `clip_vit_base_patch32`。
6. 使用 GPU、8 路受控并发构建 CLIP frame embedding。

启动前检查 FFmpeg 和 FFprobe。工具不可用时不执行部分流程，而是提示用户切换到 Advanced，通过 `FFmpeg Dir` 配置工具目录。

## 6. 状态与进度

公共状态为：

```text
idle -> running -> done
                -> error
                -> cancelled
```

`SetupWorkflowSnapshot` 保存：

- 当前状态；
- 当前步骤 ID 和名称；
- 当前步骤序号与总步骤数；
- 总百分比；
- 当前消息；
- 错误文本。

每个步骤上报 0 至 100 的局部进度，workflow 根据步骤位置映射为 0 至 100 的总进度。失败会停止后续步骤，不会把失败任务显示为完成。

## 7. 取消与失败恢复

### 7.1 Image Search

停止简单流程会并行请求：

1. 停止 Image Search 扫描。
2. 停止当前 embedding 构建。
3. 取消当前模型下载。
4. 触发本地 AbortSignal，使轮询和步骤延时立即退出。

### 7.2 Media Search

停止简单流程会并行请求：

1. 停止当前 Media Search task。
2. 停止当前 embedding 构建。
3. 取消当前模型下载。
4. 触发本地 AbortSignal。

`electron/embeddingService.ts` 在已有记录收集、目录枚举、任务创建和队列启动前均检查取消状态，防止用户停止后，旧枚举任务结束时又把状态改回 `running`。

## 8. 性能与安全边界

1. 一键流程串行执行重资源步骤，不同时启动扫描、抽帧和多模型推理。
2. Image CLIP 复用用户 GPU 路数；Media DINO 默认 CPU 单路，Media CLIP 使用受控 GPU 并发。
3. Renderer 只负责编排和显示，文件扫描、模型下载和推理仍在主进程服务、子进程或 Native 层执行。
4. 路径校验、全盘确认、模型注册表和 IPC 参数校验继续使用原有安全边界。
5. 简单模式不提供清缓存、清数据和索引维护按钮，降低首次用户误操作风险；这些操作仍可在 Advanced 中显式执行。

## 9. 关键文件

| 文件                                         | 职责                                          |
| -------------------------------------------- | --------------------------------------------- |
| `src/services/searchSetupWorkflow.ts`        | 公共一键工作流与模型/embedding 等待辅助函数   |
| `src/components/SearchExperienceModeBar.tsx` | 模式选择 UI                                   |
| `src/components/SearchSetupProgress.tsx`     | 总进度和状态 UI                               |
| `src/components/ImageSearchPanel.tsx`        | Image 一键流程、全盘确认和取消                |
| `src/components/ImageSearchControls.tsx`     | Image 简单/高级控件裁剪                       |
| `src/components/MediaSearchPanel.tsx`        | Media 一键流程、工具预检和取消                |
| `src/components/MediaSearchControls.tsx`     | Media 简单/高级控件裁剪                       |
| `electron/embeddingService.ts`               | embedding 枚举阶段取消可靠性                  |
| `tests/search-setup-workflow.test.cjs`       | 工作流顺序、失败、取消、模型和 embedding 测试 |
| `electron/uiSmokeService.ts`                 | 两个搜索面板模式切换回归                      |

## 10. 验证

| 项目          | 命令                            | 结果                                        |
| ------------- | ------------------------------- | ------------------------------------------- |
| TypeScript    | `npm.cmd run typecheck`         | 通过                                        |
| Lint          | `npm.cmd run lint`              | 通过                                        |
| Format        | `npm.cmd run format:check`      | 通过                                        |
| Workflow 专项 | `npm.cmd run test:media-search` | 27/27 通过，其中新工作流 5/5                |
| 完整门禁      | `npm.cmd run verify`            | 143/143 通过                                |
| 开发态 UI     | `npm.cmd run smoke:ui`          | 5/5 面板、0 console error、2,927 ms         |
| 模式断言      | UI smoke `searchModeChecks`     | 两面板模式切换通过；Image List 选项不存在   |
| 当前 NSIS     | `npm.cmd run build`             | 通过：最新双模式和 Image Large 已进入安装包 |

Native rebuild 首次被旧开发版 Electron 占用。通过 `tasklist /m fast_scanner.node` 定位 PID `133444`，关闭该项目旧实例后，Native rebuild 和 29 项 Native 测试通过。执行 Native 构建前必须关闭正在加载该模块的开发实例。

## 11. 剩余边界

1. 自动 smoke 不执行真实全盘扫描、模型下载或数万文件 embedding；大数据任务仍需人工长时间验证。
2. Media DINO 的 CPU 单路是稳定默认值，不是最高吞吐配置；高级模式继续允许用户选择 GPU。
3. 后续调整步骤顺序、默认模型或并发数时，必须同步更新本文件和 workflow 固定测试。
