# 本地模型安装修复与运行验证

> 状态：当前  
> 更新日期：2026-08-23  
> 范围：本地评估模型、用户模型平台、全局模型检测  
> 替代文档：无

## 当前结论

本机全局模型清单现为 13/13 就绪：三个受管图片搜索模型、应用实际使用的 Ollama Qwen3-VL、SenseVoice/FSMN VAD/CAMPPlus 和六个用户模型槽位。六个用户槽位已通过正式导入链安装并完成隔离运行时深度加载；主体检测、人脸检测、人脸向量、行人 ReID、MobileSAM 分割、SenseVoice 音频任务与 Qwen3-VL 图片推理均已真实执行。

这次修复不改变发布包行为：六个 ONNX 候选仍属于 `user-supplied-unreviewed`，Qwen3-VL/llama.cpp 仍限本机评估，所有未获分发批准的组件继续保持 `defaultBundled:false`。

## 安装映射

| 用户模型槽位       | 本地候选                         | 兼容配置                    |
| ------------------ | -------------------------------- | --------------------------- |
| `subject-detector` | `models/yolov8n/model.onnx`      | `subject-yolov8-640`        |
| `face-detector`    | `models/yolov8n-face/model.onnx` | `face-yolov8-640`           |
| `face-embedder`    | `models/adaface/model.onnx`      | `face-arcface-112`          |
| `person-reid`      | `models/osnet/model.onnx`        | `reid-osnet-256x128`        |
| `segment-encoder`  | `models/mobilesam/encoder.onnx`  | `sam-encoder-hwc-1024`      |
| `segment-decoder`  | `models/mobilesam/decoder.onnx`  | `sam-decoder-original-size` |

安装目标位于 `%APPDATA%\floating-clock-electron\models`，不写入安装目录或发布资源目录。

## 修复入口与安全边界

```powershell
npm.cmd run models:local:install -- --accept-local-user-models
npm.cmd run models:local:verify
npm.cmd run models:video:install -- --accept-external-model
npm.cmd run models:video:verify
```

安装入口执行以下固定顺序：

1. 对照 `resources/runtime-manifest.json` 检查组件仍未默认捆绑。
2. 校验六个源文件的精确字节数与 SHA-256。
3. 在隔离子进程加载 ONNX 图并检查所选兼容配置。
4. 使用同 Settings 导入功能一致的原子目录事务提交模型与 `installation.json`。
5. 逐个深度加载六个槽位，只有全部为 `ready` 才返回成功。

脚本默认不覆盖不同的用户模型；只有人工明确决定替换时才可额外传入 `--replace-existing`。路径根、符号链接、未知参数、摘要不符、结构不兼容和运行时加载失败均会关闭式拒绝。

应用已在运行时，安装完成后在导航栏的模型检测区点击“检测”，或重启应用，使界面立即取得深度运行时状态。

开发态应用实际使用 Ollama 的 `qwen3-vl:2b`。视频模型安装入口只在命令行获得明确确认后调用 Ollama，不会安装或更新 Ollama 本体；完成后必须匹配固定 digest `0635d9d857d4…` 和量化 `Q4_K_M`。旁路 llama.cpp/GGUF 运行时仍只用于本机评估脚本，不能用它的文件存在状态替代应用实际后端检查。

Qwen3-VL 运行预算已经完成一次真实故障驱动修复：生产提示词实测需要 4797 个输入 tokens，旧 4096 档会在生成前返回 HTTP 400。应用首次档位现为 8192，并在提示词预检或 Ollama 明确返回上下文溢出时，按 8192、12288、16384 有界升级。无 OCR/字幕/转写证据时，严格解析器还会清除 `visualText`，并中和摘要、场景、对象和检索标签中的未验证画面文字。完整任务与验收见[本地模型运行时自动修复 TODO](./2026-08-23-model-runtime-auto-repair-todo.md)。

## 验证

| 项目                    | 命令                                                                         | 结果                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 六模型安装              | `npm.cmd run models:local:install -- --accept-local-user-models`             | 通过：安装 6/6，深度就绪 6/6                                                          |
| 独立复检                | `npm.cmd run models:local:verify`                                            | 通过：用户模型 SHA-256/深度就绪 6/6，受管图片模型 3/3 就绪                            |
| 安装器边界              | `node --test tests/local-user-model-installer.test.cjs`                      | 通过                                                                                  |
| 主体检测                | `npm.cmd run test:batch-rename`                                              | 通过：19/19                                                                           |
| 人脸任务                | `npm.cmd run test:face-match`                                                | 通过：13/13，真实检测和 512 维向量                                                    |
| 行人 ReID               | `npm.cmd run test:person-reid`                                               | 通过：5/5，真实 512 维向量                                                            |
| 主体裁剪与分割          | `npm.cmd run test:subject-crop`                                              | 通过：40/40，MobileSAM 点选与框选均执行                                               |
| 音频任务                | `npm.cmd run smoke:audio-child`                                              | 通过：1 个视频、1 个分段、0 失败                                                      |
| Qwen3-VL 安装完整性     | `npm.cmd run video-semantic:llama-install -- --verify-only --variant=vulkan` | 通过                                                                                  |
| Qwen3-VL 健康           | `npm.cmd run video-semantic:llama-health`                                    | 通过：smoke、8 轮 soak、3/3 缓存均健康                                                |
| 应用视频模型            | `npm.cmd run models:video:verify`                                            | 通过：Ollama digest 与 `Q4_K_M` 均匹配                                                |
| Qwen3-VL 运行时自动修复 | `npm.cmd run todo:model-runtime-auto`                                        | 通过：TODO 5/5、专项回归 33/33                                                        |
| 视频/音频语义总回归     | `npm.cmd run test:media-search`                                              | 通过：216/216                                                                         |
| 当前应用图片实测        | 384 像素受控内存图片、Ollama loopback、严格解析                              | 通过：8192 上下文、生成 19.495 秒、输出 481 bytes、`visualText` 为 0、无 OCR 中和生效 |
| 应用视频多模态推理      | Ollama loopback `/api/chat`，内存图片、结构化输出、`keep_alive:0`            | 通过：兼容 `thinking` 终端 JSON，约 15.7 秒                                           |

## 剩余发布边界

- `subject-detector` 的固定候选为 AGPL-3.0-only，仍需正式法律与分发决定；本次仅安装到本机用户数据目录。
- Qwen3-VL/llama.cpp 的真实推理可用不等于允许随安装包分发；当前预检仍为 `activationReady:false`、`releaseReady:false`。
- Ollama 模型安装入口是用户/开发者明确运行的本机命令，不代表应用获得自动拉取、更新 Ollama 或更新模型标签的权限。
- 全资源校验另有可选 CUDA 运行时缺失和 Electron 原生扫描模块大小不匹配，因此 `npm.cmd run resources:verify` 当前为失败。它不影响本次 13 项模型检测中的 CPU/本机任务可执行结论，但仍是发布资源门禁问题。
- 当前结论属于未提交工作区与本机运行证据，不能替代干净提交、安装包矩阵或签名发布验证。
