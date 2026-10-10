# VID-017 llama.cpp / GGUF 内置运行时推进记录

> 状态：部分实施  
> 更新日期：2026-08-17  
> 范围：受管 llama.cpp sidecar、本机评估与分发阻塞  
> 替代文档：无

> 日期：2026-08-15  
> 当前结论：工程基础已完成，资源激活与发布仍为审批阻塞  
> 预检：`npm.cmd run video-semantic:llama-preflight`

## 本轮目标

为视频语义建库增加受管 `llama-server` sidecar，使产品最终不依赖用户预先安装 Ollama；同时不在未经批准时下载、启用或打包新运行时和模型。

## 固定候选

| 组件             | 固定版本                                              | 候选                               | 当前分发状态                             |
| ---------------- | ----------------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| llama.cpp        | `b10441` / `0177dcc7300bad8914bb838baabce87899812491` | Windows x64 CPU、Vulkan、CUDA 12.4 | `manual-review`，Online/Offline 均不捆绑 |
| Qwen3-VL GGUF    | `52d6c8ffea26cc873ac5ad116f8631268d7eb503`            | `Q4_K_M` 主模型                    | 本机评估已安装；`manual-review`，不打包  |
| 多模态 projector | 同上                                                  | `mmproj-Q8_0` 首选，F16 备选       | 本机评估已安装；`manual-review`，不打包  |

上游依据：

- llama.cpp [b10441 release](https://github.com/ggml-org/llama.cpp/releases/tag/b10441)
- llama.cpp [multimodal 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/mtmd/README.md)
- llama.cpp [OpenAI-compatible server 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- Qwen [官方 Qwen3-VL-2B-Instruct-GGUF 仓库](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/tree/52d6c8ffea26cc873ac5ad116f8631268d7eb503)

## 已完成

- 新增 `LlamaCppVideoSemanticRuntime`：启动前检查 server、主 GGUF 和 projector 的绝对路径与 SHA-256。
- sidecar 只绑定 `127.0.0.1`，使用随机 API key；以参数数组、`shell:false`、隐藏窗口启动。
- 明确启用离线环境，禁用 UI 和自动 projector；没有 `-hf`、URL 模型或自动下载入口。
- 图片只允许有界内存 Base64，并转换为本地 `data:` URL；拒绝文件路径、远程 URL、非法 Base64 和超限数据。
- 通过 `/v1/models` 核对固定 alias，通过 `/v1/chat/completions` 使用 JSON Schema 约束输出；响应体、上下文、输出 token、启动和请求时限均有界。
- runtime registry 替换或应用退出时可回收子进程；启动失败、资源缺失和摘要不匹配均 fail closed。
- 主进程已接入包内批准 descriptor 工厂：开发态或 descriptor 缺失时保持现有 Ollama；descriptor 存在但版本、路径、摘要或审批字段不合法时 fail closed；只有打包态的精确批准配置才能选择 llama.cpp。
- 新增两个不可变收据，记录官方 release/revision、候选包体积和 SHA-256。
- Online 与 Offline profile 均验证候选保持 `defaultBundled:false`、`manual-review`。
- 新增脱敏预检，不输出本机路径、API key 或 Authorization 值。

## 依赖复核

`VID-012` 原 20 段 v6 基准保留 19/20 严格 JSON 和一段稳定失败的历史事实。后续 `VID-016` 在同一 RTX 3050 4 GiB、同一 Qwen3-VL 2B Q4 路线上完成最终 80/80 严格模型结果、80/80 完整观看人工真值、八类各 10 条，并形成延迟、显存、幻觉和时间点报告。因此 `VID-012` 的工程/质量依赖由更大且更严格的后续证据关闭；这不改写旧样本失败，也不声明正式 Recall@K。

## 机器可读 TODO

| ID       | Mode     | 状态     | 验收                                                                         |
| -------- | -------- | -------- | ---------------------------------------------------------------------------- |
| VID017-A | auto     | verified | 受管 sidecar 适配器与安全生命周期测试                                        |
| VID017-B | auto     | verified | runtime/model/projector 固定收据与本地摘要校验                               |
| VID017-C | auto     | verified | Online/Offline 未批准资源排除门禁                                            |
| VID017-D | auto     | verified | VID-012 后续证据复核与 VID-016 依赖关闭                                      |
| VID017-E | approval | verified | 用户批准 Vulkan 本机测试；固定包下载、校验、安全解压及可执行文件摘要记录完成 |
| VID017-F | approval | verified | 用户批准 Q4_K_M + Q8_0 本机测试；真实 sidecar 身份与单样本严格 JSON 推理通过 |
| VID017-G | approval | blocked  | 项目 EULA、MIT/Apache-2.0 notice 与再分发决定                                |
| VID017-H | auto     | blocked  | 本机 soak 与未授权资源排除矩阵已完成；正式 Online/Offline 安装包矩阵仍依赖 G |

## 当前预检结论

- `foundation.ready=true`
- `VID_012=verified`，`VID_016=verified`
- `activationReady=false`
- `releaseReady=false`
- 本机评估资源已安装并验证；当前 Ollama 路线和 V7 生产提示词保持不变，候选没有进入安装包。

## 本机 Vulkan 验收

- 用户明确批准仅本机测试，选择 `llama.cpp b10441` Vulkan x64、官方 `Qwen3VL-2B-Instruct-Q4_K_M.gguf` 与 `mmproj-Q8_0.gguf`；该批准不等于再分发或打包批准。
- 三份下载均按固定体积和 SHA-256 校验。运行时安全解压出 52 个文件；`llama-server.exe` 为 9,216 字节，SHA-256 为 `4a118c0892482e738b19ebcd201d3fc9d687ab0dd2f841d2b0d7272ab909655a`，版本输出为 build 10441 / commit `0177dcc73`。
- 用户级安装收据固定标记 `local-evaluation-only`、`redistributionApproved=false`、`packagedByDefault=false`。主模型与 projector 通过 NTFS 硬链接从内容寻址缓存发布，避免重复占用约 1.55 GB。
- 真实 Vulkan smoke 使用 4 张既有受控缓存帧，sidecar 状态为 `ready`，1024 输出 token 下 21,185 ms 返回严格可解析 JSON：3 个事件、1 个 `persons` 项、4 个搜索标签。
- 512 输出 token 的前两轮可稳定生成内容但在末尾截断，已确认是验收参数不足；smoke 改为产品既定上限 1024。兼容解析器同时改为字符串感知的平衡括号扫描，并加入超过 64 个嵌套对象的回归测试。
- 质量观察：该样本把绿苍蝇误放入 `persons`。这不影响运行时与结构化协议 smoke 通过，但说明人物/对象语义仍需依靠现有提示词守卫和后续回归，不把单样本 smoke 当作模型质量验收。
- 完成八类 profile 各一组、每组 4 张受控缓存帧的真实 soak：严格 JSON 8/8、失败 0，平均 11,456 ms、P95 16,643 ms、最高观测显存 2,219 MiB；结束后 sidecar 和监听端口均已回收。
- JSON Schema 现在限制场景、事件、人物、动作、物体、标签、OCR、音频事件和警告的最大条目数，避免复杂画面在 1024 token 上限内无限枚举；llama.cpp 返回 `finish_reason=length/max_tokens` 时明确判为截断。
- 本机安装器在 Windows 使用受限 HTTPS 域名的前台 BITS 下载，临时文件只有在精确体积与 SHA-256 通过后才原子发布；缓存管理器只清理已知无效 blob 与 partial，未知文件保持不动。
- 健康报告显示 `healthy=true`，内容寻址缓存 3/3 verified、0 invalid、0 partial、0 unknown；性能报告只保留聚合指标。
- Online/Offline 未授权资源排除矩阵通过：两个 profile 的候选均为 `defaultBundled:false`、`manual-review`，构建资源没有 runtime/model/projector 引用，仓库没有批准 descriptor 或真实 payload。该矩阵证明当前包不会误带资源，不等于正式的内置运行时安装包矩阵。

## 本轮验证

- llama.cpp 适配器、安装器、重试、实体守卫、缓存、恢复和自动化专项：通过。
- 八类真实 soak、健康报告、性能报告与 online/offline 排除矩阵：通过。
- TypeScript、ESLint、Prettier、分层/构建图和完整 Media Search 回归以最终自动门禁结果为准。
- VID-017 当时主进程构建图只增加适配器与审批工厂两个模块，精确预算为 262；后续 VAL-415/417 的资源治理与隐私健康中心已把当前精确预算更新为 273，其余入口预算未放宽。

VID017-E/F 的本机测试授权与证据已经关闭，本机 soak 和未授权资源排除矩阵也已完成。只有 VID017-G 获得项目 EULA、MIT/Apache-2.0 notice 和再分发批准后，才能把 descriptor 与资源接入默认打包运行时，并执行真实 Online/Offline 内置资源安装包矩阵。
