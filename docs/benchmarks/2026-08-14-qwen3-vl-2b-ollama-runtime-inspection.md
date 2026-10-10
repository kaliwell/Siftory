# Qwen3-VL 2B / Ollama 本机运行时身份检查

> 日期：2026-08-14  
> 范围：VID-011，仅安装、供应链身份和项目适配器检查  
> 设备：RTX 3050 Laptop 4 GiB、16 GiB 内存、i7-12700H  
> 结论：运行时身份验收通过；未执行视频推理或质量基准

## 1. 安装边界

- 用户明确批准安装Ollama及下载约1.9 GB的Qwen3-VL 2B Q4。
- 通过官方winget包 `Ollama.Ollama` 安装Ollama 0.32.9。
- 只拉取 `qwen3-vl:2b`，未拉取4B或其他模型。
- 应用代码没有安装、pull、create或update入口；模型仍是外部测试依赖，不进入Online/Offline安装包。
- 本轮未读取任何真实视频、图片、字幕或音频，未调用 `/api/chat`。

## 2. Ollama运行时身份

| 字段              | 观测值                                                             |
| ----------------- | ------------------------------------------------------------------ |
| 版本              | `0.32.9`                                                           |
| 安装来源          | winget `Ollama.Ollama`                                             |
| 可执行文件模板    | `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`                        |
| 可执行文件大小    | `36,342,664` bytes                                                 |
| 可执行文件SHA-256 | `0482be1251251da2f8479ace70c4dd7d9f2892d11dde201ee2408a18806b924b` |
| API origin        | `http://127.0.0.1:11434`                                           |
| 实际监听          | `127.0.0.1:11434`                                                  |
| LAN监听           | 未观察到                                                           |

Ollama开源仓库标记为MIT；但本项目不重新分发本次安装的Windows应用二进制，运行时清单继续将该发行物标为 `NOASSERTION / legal-review-required`，不能据此解除打包许可证门禁。

## 3. 模型身份

| 字段                | 观测值                                                             |
| ------------------- | ------------------------------------------------------------------ |
| Ollama标签          | `qwen3-vl:2b`                                                      |
| 标签digest          | `0635d9d857d497aeadba3d7d27485746c50554446f9f6ec01ef39788221adbe8` |
| 标签体积            | `1,889,519,687` bytes                                              |
| family / 参数量     | `qwen3vl` / `2.1B`                                                 |
| 格式 / 量化         | `gguf` / `Q4_K_M`                                                  |
| 主模型blob大小      | `1,889,496,384` bytes                                              |
| 主模型blob SHA-256  | `ebabfa59b71a5b96e0281ec2994977e785284e0939807a99fc340dec3c6f10de` |
| context / embedding | `262,144` / `2,048`                                                |
| 能力声明            | `vision`、`completion`、`tools`、`thinking`                        |
| 模型许可证          | `Apache-2.0`                                                       |

主模型blob的本地SHA-256与Ollama manifest层digest完全一致。完整机器收据位于 `resources/runtime-receipts/`，运行时清单只捆绑小型收据，不复制1.9 GB外部模型。

## 4. 项目适配器检查

使用项目锁定常量创建 `OllamaVideoSemanticRuntime` 并只调用 `/api/tags`：

```json
{
  "adapterId": "ollama-loopback",
  "state": "ready",
  "model": {
    "modelId": "qwen3-vl:2b",
    "modelRevision": "0635d9d857d497aeadba3d7d27485746c50554446f9f6ec01ef39788221adbe8",
    "quantization": "Q4_K_M"
  }
}
```

主进程状态服务已接入这一只读检查。证据帧规划器尚未接入，因此运行时可以显示 `ready`，但建库按钮保持禁用，避免把“模型已就绪”误报成“完整建库链路已就绪”。

## 5. 验证与未完成项

- `test:media-search`：95/95通过。
- `test:runtime-manifest`：19/19通过，16个组件、55个artifact元数据有效。
- 新增两个外部组件的定向 `resources:verify`：2/2通过。
- 全量 `resources:verify` 仍受已有可选CUDA文件缺失及本机native addon尺寸不一致影响；与本次两个收据无关，不能把全量资源树写成通过。
- `VID-012` 仍需用户明确选择20个脱敏视频片段后，才可运行JSON有效率、准确率、延迟、显存和内存基准。

## 6. 上游依据

- Ollama 0.32.9发布页：<https://github.com/ollama/ollama/releases/tag/v0.32.9>
- Ollama仓库许可证：<https://github.com/ollama/ollama/blob/main/LICENSE>
- Ollama `qwen3-vl:2b` 页面：<https://ollama.com/library/qwen3-vl:2b>
- Qwen上游模型卡：<https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct>
