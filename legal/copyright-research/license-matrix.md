# Siftory 第三方许可研究与待决矩阵

最新工程跟进：[许可入口、Online 配置与构建证据](2026-09-25-license-access-and-build-evidence.md)。下文各历史阶段数字按其当时范围理解，不能代替新包核验。

**2026-09-25 后续实物核查增量：** 见 [商用核查更新](2026-09-25-commercial-license-review.md)。该增量补齐了多项固定许可与源码证据，并新增 canvas MPL、Electron 内嵌 FFmpeg、实际 Ollama 版本等发现；下文保留此前研究时点的证据缺口，不应忽略新报告仍按旧状态判断。项目发布批准状态未改变。

初次核查日期：2026-09-24；本次工程证据更新：2026-09-25。源项目：`s220260601_221046`。用途：中国大陆个人软件著作权登记准备及后续专有软件发布决策。此文件由仓库外研究整合，并补充后续工程及许可载荷证据；未接受协议、未购买授权、未将任何 pending 改为 approved。

同日二次复核勘误：本版取代首轮报告中 SenseVoice“已明确商用”的结论。官方讨论仍待许可方确认；旧 PDF 与 ZIP 保留为历史快照，授权判断应采用本版及新增证据附录。另已核实并更正 YOLO-face 通知哈希，区分 Ollama 测试件与官方 Instruct GGUF 的身份。

## 1. 结论与证据边界

可就经确认归本人所有的程序与文档准备登记；第三方代码、模型、字体和运行时仍各自适用原许可。登记不替代第三方授权。[《计算机软件保护条例》第 7、23 条](https://www.cac.gov.cn/2013-02/08/c_12648744.htm)

本地 `legal/license-decisions.json` 的项目决策及 21 个组件全部 pending，`permittedProfiles` 为空；`UNLICENSED` 表示当前未给出项目公开许可，不是第三方版权已经清理。运行清单的 `recorded`、模型清单的 `commercialFriendly` 均为工程标记。许可证摘要也不能代替上游完整条款。

初次核对的清单、哈希、版本及 106 个去重生产依赖条目保存在 [sources.json](sources.json)，它是修复前研究快照。同日安全修复将 adm-zip 0.6.0 更新为 0.6.1、sharp 0.35.0 更新为 0.35.4；最终依赖版本以锁文件和 [Node 生产依赖清单](../../NODE_THIRD_PARTY_COMPONENTS.md) 为准，修复依据见 [依赖安全更新](dependency-security-update.md)。生产依赖含其他平台 optional 包，不等于 Windows 安装包恰有 106 个组件；尚未对最终安装包完成逐文件 SBOM 和对应源码交付审计。Electron 虽列为 devDependency，实际应用运行时也必须计入。

现有说明规定：Online 不内置受管模型、FFmpeg、YOLO、CUDA/cuDNN、Ollama、llama.cpp；Offline 内部候选加入三个 embedding 模型目录和固定 FFmpeg。Native addon 和字体仍进入应用。最终 profile 清单和解包产物优先于 runtime manifest 的 defaultBundled 字段。

## 2. 源码与生产运行库

| 对象／本地版本 | 类型和官方依据 | 可用路径与仍需完成的事项 |
| --- | --- | --- |
| 本项目 UI、主进程、原生模块、CUDA worker | 拟自有源码；作者及权属仍待确认 | 主体代码可按个人专有项目整理；合作、委托、职务开发、AI 辅助来源须另行确认。不要将整个 native 目录宣称全部原创。 |
| React / ReactDOM 19.2.8、Zustand、xterm、ssh2、canvas 等；Transformers.js 4.2.0、pdfjs-dist 6.2.108 等 | 锁文件以 MIT、BSD、ISC、Apache 等为主；完整逐项版本见 sources.json | 通常可用于商业专有应用，按各包保留版权、许可和必要 NOTICE；并非都要单独购买商业授权。需从实际发布版本提取完整许可证，核查拷入源码的修改。锁文件声明不替代上游证据。 |
| sharp 0.35.4 / @img/sharp-win32-x64 0.35.4 / libvips 8.18.6 | sharp 主代码 [Apache-2.0](https://raw.githubusercontent.com/lovell/sharp/v0.35.4/LICENSE)；本地 Windows 二进制包明确 Apache-2.0 AND LGPL-3.0-or-later，含 libvips DLL | Online 也存在这项义务。保留 LGPL/GPL 文本、库版权、对应库源码和构建修改证据，评估用户替换兼容共享库及调试修改所需的逆向工程例外；静态或不可替换链接须另行安排重链接材料。不得仅展示 sharp 的 Apache 许可。[LGPL v3 §4](https://www.gnu.org/licenses/lgpl-3.0.en.html) |
| Electron 42.8.0 | [MIT，精确 tag](https://raw.githubusercontent.com/electron/electron/v42.8.0/LICENSE)，另含 Chromium／Node 等依赖 | 随分发保留 Electron LICENSE 与 LICENSES.chromium.html，并核对实际附带编解码和第三方组件。MIT 不覆盖所有嵌入组件的独立义务。 |
| native/stb_image.h 2.30；stb_image_resize2.h 2.18 | 本地头文件提供 MIT 或公有领域路径；[上游许可](https://raw.githubusercontent.com/nothings/stb/master/LICENSE) | 采用 MIT 路径保留原版权和许可较容易留证；申报原创源程序时排除 vendored 头文件，但分发时保留通知。 |
| ONNX Runtime GPU NuGet 1.24.3；Node 1.24.3；Web 1.26.0-dev.20260416-b7804b056c | [1.24.3 主许可 MIT](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/LICENSE) | 可依 MIT 使用，附 LICENSE 与 ThirdPartyNotices；Web 开发版本及各平台二进制仍分别留证。MIT 不代替 CUDA/cuDNN 的 NVIDIA 协议。 |

## 3. 模型权重、导出及工具矩阵

“有可用许可路径”不表示当前工件已被正式批准。以下短版本对应 sources.json 的精确 revision／artifact SHA-256。

| 对象 | 已核实的许可与来源 | 决策建议／未决证据 |
| --- | --- | --- |
| DINOv2 / Xenova dinov2-base q4，d623d125… | [Meta DINOv2 Apache-2.0](https://raw.githubusercontent.com/facebookresearch/dinov2/main/LICENSE)；[Xenova 固定转换卡](https://huggingface.co/Xenova/dinov2-base/raw/d623d125a29e343851bcedff293fdc8b6bda292b/README.md) | 已归档固定树、模型卡、配置及父仓库许可。固定转换卡无 license 字段，树中无独立 LICENSE／NOTICE；父仓库当前许可不等于转换 revision 的独立授权。仍需精确父权重版本、转换声明和修改记录。 |
| CLIP ViT-B/32 / Xenova q4，d15189d7… | [OpenAI CLIP MIT](https://raw.githubusercontent.com/openai/CLIP/main/LICENSE)；[Xenova 固定转换卡](https://huggingface.co/Xenova/clip-vit-base-patch32/raw/d15189d7028b43f1d3e65039190477f6af591c2a/README.md) | 已归档固定版本证据和 OpenAI 父仓库 MIT 全文。固定转换卡无 license 字段，树中无独立 LICENSE／NOTICE；精确父权重及转换许可链仍待确认。父模型卡的部署用途说明也应保留，不能直接改写成 MIT 禁商用条款。 |
| sentence-transformers clip-ViT-B-32-multilingual-v1，58edf8ca… | [固定模型卡明确 Apache-2.0](https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/raw/58edf8cada9e398793dca955574a48cbb7f18be2/README.md) | 固定版本声明已归档并核对文件身份；另存 Apache 官方标准全文。固定树没有独立 LICENSE／NOTICE，不把标准全文冒充模型仓库文件。继续落实署名、修改说明及适用通知，不套用其他 M-CLIP 同名项目许可。 |
| Ultralytics YOLOv8n COCO ONNX，b2bc52f4… | 本地 AGPL-3.0-only；[Ultralytics 官方双许可说明](https://www.ultralytics.com/license) | AGPL 并非禁止商用，但可能要求相关衍生作品源代码和网络交互源码获取。当前专有目标下：保持排除、替换为可核实许可的方案，或取得覆盖具体版本／权重／分发方式的 Enterprise 授权；只有权利人明确选择兼容开源路径时才另评估 AGPL 履行。 |
| Lindevs YOLOv8n-face ONNX，7202335c… | [Lindevs 仓库 MIT](https://github.com/lindevs/yolov8-face)，但 README 同时提到初始 YOLOv8 权重，不能仅凭 MIT 标签消除上游衍生疑问 | 保持排除待澄清；取回精确训练／导出来源和上游授权，必要时购买覆盖授权或更换。不能直接断言全部 face 工件 AGPL，也不能认定 MIT 已完全清理。 |
| CVLface/AdaFace IR101 WebFace12M ONNX，3af39a8c… | 本地转换件记 Apache-2.0；[AdaFace 原作者代码 MIT](https://raw.githubusercontent.com/mk-minchul/AdaFace/master/LICENSE)；[官方模型卡要求遵守训练数据许可](https://huggingface.co/minchul/cvlface_adaface_ir101_webface12m) | 代码、原始权重、第三方 ONNX 转换分开取证。WebFace12M 数据相关条件本次未取得可核实全文，不能认定商业已允许或必然禁止。保持排除；取得原权重和数据相关商业适用确认，或替换。 |
| OSNet AIN x1 / LibreReID，5c7c20e5…＋本地导出 | [转换模型卡 MIT](https://huggingface.co/LibreYOLO/LibreReID-osnet)声明沿用 Torchreid 权重，并说明 MSMT17/DukeMTMC-reID/CUHK03 数据来源；[Torchreid 代码 MIT](https://github.com/KaiyangZhou/deep-person-reid) | 代码 MIT 不解决训练数据和预训练权重的所有条件；核实精确 checkpoint、数据限制对权重使用的影响、导出记录。证据未齐前保持排除，考虑有明确商用权重许可的替代。 |
| PulpCut MobileSAM ONNX，1e774d85… | [MobileSAM 上游 Apache-2.0](https://github.com/ChaoningZhang/MobileSAM)；[PulpCut 模型页](https://huggingface.co/PulpCut/mobilesam-onnx)未取得明确覆盖固定转换件的完整许可证 | 不以仓库 manifest 的 Apache 标签自动批准。补原始 checkpoint→encoder／decoder ONNX 来源及许可；也可自行从授权原件可复现导出，再留证。 |
| FFmpeg / ffprobe 8.1.2 Gyan full | 实机只读 `-version`、`-L` 显示 GPL-3.0-or-later；配置含 `--enable-gpl --enable-version3 --enable-static`，非 LGPL-only 构建。[FFmpeg 官方法律页](https://ffmpeg.org/legal.html) | 分发当前二进制须附 GPL 文本、匹配的完整对应源码及构建/修改材料，并检查交付方式。可改用经验证关闭 GPL/nonfree 的 LGPL 构建并履行 LGPL，但尚未实施。FFmpeg 官方不提供把该 GPL 工件洗成专有的商业许可证。 |
| CUDA 12.8.1 / cudart 12.8.90 / cuBLAS 12.8.4.1 / cuFFT 11.3.3.83 / NVRTC 12.8.93 | [精确 CUDA 12.8.1 EULA](https://docs.nvidia.com/cuda/archive/12.8.1/eula/index.html) | 标准协议允许列明组件的适格再分发，通常不等于必须另购商用许可。需本人有权接受协议，逐 DLL 对照可再分发清单，作为有实质功能应用的一部分提供，保留通知及下游限制并遵守 NVIDIA 硬件、出口／用途条件。未证实接受及打包合规前保持候选。 |
| cuDNN 9.19.1.2 + CUDA12 | [cuDNN 9.19.0 版本族 EULA 与补充条款](https://docs.nvidia.com/deeplearning/cudnn/backend/v9.19.0/reference/eula.html)含运行库再分发规则 | 核对本地 9.19.1.2 归档中实际 LICENSE 哈希与 DLL；本次网页是同版本族而非宣称精确补丁已核完。按 SDK＋cuDNN 补充条款留证；不将其归为 MIT。 |
| llama.cpp b10441 / commit 0177dcc7… | [精确 commit MIT](https://raw.githubusercontent.com/ggml-org/llama.cpp/0177dcc7300bad8914bb838baabce87899812491/LICENSE) | 主代码可商业使用并保留许可；CPU/Vulkan/CUDA 二进制分别审计。CUDA 12.4 附件不能套用本项目另一套 CUDA 12.8.1 条款。现有本地评估选择 Vulkan，不意味着所有打包附件已获准。 |
| Ollama 0.32.9 外部测试运行时 | [精确 tag MIT](https://raw.githubusercontent.com/ollama/ollama/v0.32.9/LICENSE)；本地 manifest 仍 NOASSERTION | 可将官方 MIT 作为待审证据；不要静默改为 approved。若未来分发 Windows 二进制，继续核查嵌入运行库及通知，当前外部测试不等于发行。 |
| Qwen3-VL-2B-Instruct 官方 GGUF，52d6c8ff…；Ollama Q4_K_M digest 0635d9d8… | [官方 Instruct GGUF 卡 Apache-2.0](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF)；Ollama 固定 manifest 的 renderer/parser 为 qwen3-vl-thinking，许可层来源含 2b-thinking-bf16 | 官方 GGUF 的固定完整许可与模型卡已归档。Ollama receipt 的“Instruct”命名不能证明它等同官方 Instruct GGUF；分别保留 digest、配置、许可层与来源证据，身份链尚待厘清。不得将一个型号的许可推及所有 Qwen 产品。 |
| SenseVoiceSmall，HF 3847d57b…，FunASR 1.3.29 外部环境 | [固定模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/raw/3847d57b6bdf2dd8875cb1508d2af43d80a16bf7/README.md)与 [FunASR 模型协议 v1.1](https://raw.githubusercontent.com/modelscope/FunASR/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE)；代码与权重许可不同 | **仍待许可方确认。** [维护者回复的 2026-09-22 更新](https://github.com/QwenAudio/SenseVoice/issues/334#issuecomment-5083546605)明确早期回答不是许可方最终确认；[同日文档修正 PR](https://github.com/QwenAudio/SenseVoice/pull/357)仍为 Open。已保存原文与精确协议；不能继续将当前 README 或早期评论视为商用、私有衍生件和 ONNX 再分发均已获准，也不能反推为绝对禁商用。保持候选状态。 |
| FSMN-VAD v2.0.4 / CAM++ v2.0.2 | 本地 manifest 记 Apache-2.0；与 SenseVoiceSmall 分离 | 本次官方 ModelScope 页面未取得可读的固定 tag 许可，维持待核实。另列 Python 3.12、FunASR、torch/torchaudio 2.5.1+cpu、numpy 1.26.4 等环境依赖；这些不在 npm 106 条清单内，不可漏审。 |
| Source Han Sans CN VF 2.005R WOFF2 | [精确 2.005R OFL-1.1](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/LICENSE.txt)；本地已有全文 | 可随应用商用分发并保留版权/OFL；不得单独出售字体，修改涉及保留字体名时遵守改名或授权条件。OFL 不要求整个应用变成 OFL；核对转换是否改变字体及命名。 |

上表中 AGPL/GPL 的整体作品范围取决于代码组合、链接和交互等事实。独立 CLI、IPC 或用户导入不是自动豁免，也不能仅凭同包就断言整个应用必须 GPL。对实际结构应逐项分析。[GNU 关于聚合与程序组合的解释](https://www.gnu.org/licenses/gpl-faq.en.html)

## 4. 已发现的具体证据缺口

1. **YOLO-face 哈希已更正，许可链未关闭**：实测本地 ONNX 12,265,790 字节，SHA-256 为 `7202335c41e478b4feccdfd7f09d5cec71007d775e02964a8f115b1687f3db87`，与 runtime manifest 一致。通知中的旧哈希已替换；此项只确认文件身份，不批准使用或分发。
2. **已补完整文本，仍有适用链缺口**：新增附录归档本机 70 个生产依赖条目的证据、Electron/Chromium 通知、三种 ONNX 精确版本许可、模型固定卡和上游全文。guid-typescript 固定 gitHead 无法取得全文，两项 Xenova 转换声明仍欠缺；完整 LGPL 对应源码、最终安装包 SBOM 和逐组件义务仍未关闭。
3. **Online 仍有 LGPL**：生产 Windows sharp/libvips 以及 Electron 内嵌第三方库必须处理；不能将“不内置 FFmpeg”写成“完全没有强/弱 copyleft”。
4. **代码、权重、训练数据三层不一致**：AdaFace 转换件 Apache 标签与原代码 MIT 不是自动冲突，但必须分别说明出处；OSNet 数据来源条件、PulpCut 固定工件授权仍欠证据。
5. **外部运行时不等于已发布组件**：receipt 证明本地评估版本，不是再分发许可。若转为内置、自动下载或镜像托管，重新确定谁在分发哪些字节及对应义务。

## 5. 可供本人选择的后续路线

- **基础专有版本**：维持高不确定候选不进入发行，补齐现有 permissive/OFL 通知及 sharp/libvips 的 LGPL 交付材料，核查完整打包产物。
- **保留模型能力**：DINO/CLIP/多语言模型、Qwen 官方工件等核实固定版本许可链；SenseVoice 等待许可方确认，并审阅自定义模型协议。无须为了 MIT/Apache 标签本身普遍购买商业授权。
- **YOLO／人脸／ReID 能力**：取得具体版本、权重及商业分发范围的充分许可证据；证据无法补齐时选择替换或继续排除。Ultralytics 的闭源 Enterprise 路线需真实合同，不得虚构购买或认可。
- **FFmpeg 与 GPU 加速**：选择履行现有 GPL 再分发义务或替换构建；GPU DLL 则依适用 NVIDIA 协议核对再分发清单和接受主体。两者的许可问题不能混为一谈。

待本人确认的权利链与登记材料见 [registration-requirements.md](registration-requirements.md)。此研究不替项目权利人作最终许可接受、开源范围或商业发布批准。

## 6. 同日对应源码与嵌入组件证据补充

新增独立附件 `Siftory-License-Source-Evidence-20260924.zip`，保留前轮证据附件的原始字节。以下进展补充第 2～4 节，项目及组件批准状态均未改变。

- **sharp Windows 版本链已固定**：sharp 0.35.4 的固定提交 `7f1a0a22…` 明确锁定 libvips Windows/dev 构建包 1.3.3；其固定脚本又指向 libvips 8.18.6。已保存 npm 源码和开发包、两个完整构建仓库及 libvips 官方源码，共五份归档；SRI、源码摘要及构建树 Git blob 校验通过。28 项本机版本索引中，7 项仍只有当前 MXE 分支快照；浮动基础镜像、历史 MXE 提交及动态 main 通知尚未锁定。尚未取得全部递归对应源码，也未验证最终安装包的库替换条件，不能因此关闭 LGPL 分发事项。[sharp 固定依赖](https://github.com/lovell/sharp/blob/7f1a0a22cc285fe180766f4935d50b55af6e8432/package.json)、[精确 Windows 配方](https://github.com/libvips/build-win64-mxe/blob/09cfccf20b91b441fbe97fa7a7ed8a597e55e830/build/vips.mk)
- **FFmpeg 主体源码已取得**：官方 8.1.2 源码包通过发布签名验证，10,110 个普通文件与 tag 对应的 Git blob 匹配；主体 commit 与 Gyan 发行说明一致。另取发行 ZIP 中 GPL 文本及构建说明，登记 70 个外部库的发行方版本描述。短 commit 尚未逐项解析为完整修订，`openal-soft latest` 未固定；这些外部库的精确源码、补丁与完整构建材料仍有缺口。本机 EXE 与 ZIP 目录仅完成大小及 CRC32 比较，不冒充远端 EXE 的 SHA-256 验证。完整 FFmpeg 主体源码不等于完整 Windows 静态构建的全部对应源码。[FFmpeg 官方签名说明](https://ffmpeg.org/download.html)、[Gyan 精确发行](https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2)
- **canvas 内嵌图形栈已有单独证据**：canvas 1.0.3 固定提交对应 Skia `7219df0f…`、ICU `d578f2e8…`（78.2）。已归档 Skia BSD-3-Clause、ICU 完整 Unicode-3.0 及附加声明，并建立 15 项组件许可映射。本机 ICU 数据与固定源码 Git blob、官方资产 SHA-256 双重一致。npm MIT 字段不覆盖整个图形栈；Rust/AVIF/AOM 等传递依赖、最终 `.node` 组成和包内通知仍需审计。没有将发布证明的字段一致性冒充 Sigstore 签名认证或可重现构建。[Skia 固定 DEPS](https://raw.githubusercontent.com/google/skia/7219df0fb0ff64f26adad448f94e8c001b964e6a/DEPS)、[ICU 完整许可](https://chromium.googlesource.com/chromium/deps/icu/+/d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738/LICENSE)

上述材料不纳入申请人的原创源程序范围。此次未购买商业授权、未替本人接受协议、未发布安装包；其余模型与个人权利链待办继续保留。

## 7. 2026-09-25 随包许可载荷与可信清单门禁

[许可补充载荷](../third-party/README.md)新增 **40 份许可与通知原文**；加上 README 和 [manifest](../third-party/manifest.json) 共 42 个文件。原文逐份与已归档证据字节相同，清单记录官方来源、revision、适用组件、SHA-256 和未解决事项。8 个 npm 版本绑定与锁文件核对；这些是限定载荷的身份与来源证据，不是法律批准。

- 覆盖 ORT 精确版本的 LICENSE/ThirdPartyNotices、canvas 与已识别 Skia/ICU/FreeType 等原文，以及 sharp Windows 实际收到的通知、GNU LGPLv3/GPLv3、libvips/libnsgif 文本。没有把库的 MIT/Apache 标签推广为全部嵌入组件许可，也没有用通用 ISC 模板伪造 guid-typescript 固定版本证据。
- 源端许可专项 **17/17**；校验原文/README 摘要、版本和路径，拒绝缺件、替换、链接和未列入清单的文件。只核对包内自洽性不足以建立身份，实际资源门禁另由已审源树计算可信 manifest 摘要并传入；同步改写原文及包内清单也会拒绝。
- Online/Offline 资源清单现为 **29 项核心要求**，包括 libvips 两份 DLL 与许可 manifest；许可、profile 和资源组合专项 **46/46**。旧内部 Online 包因缺少这份载荷而被新门禁正确拒绝。新增载荷后已重新构建内部 Online 未签名目录包，资源报告 `ok: true`：**29/29 核心要求、40 份原文、131 个资源文件**，缺件、重复、禁止、敏感及 manifest 问题列表为空；独立只读复核确认 42 个许可目录文件与受审源树逐字节相同，45 个 ASAR 构建文件、Native 和 1,428 文件源码快照也完成绑定；未启动应用、GUI、安装或发布。这只确认列明的静态资源及身份范围，不能外推为安装器或正式分发验收。
- 许可清单校验不能证明实际 ASAR 所有依赖版本、完整递归 SBOM、全部静态依赖对应源码、历史构建输入、修改版 DLL 兼容性或安装器生命周期完成。manifest 保留 `partial-text-evidence` 与 `approvalGranted: false`；源树本身是本次信任边界，不把摘要核对当作防止源树与产物同时被篡改的隔离机制。

guid-typescript 原文、DirectML 等旁置二进制条款、sharp 静态依赖来源与源码供给、canvas 原生构建闭包及各模型授权链继续待补。上游入口 URL 不是已完成对应源码交付或书面要约。内部 Online 资源核查不是正式签名发布、干净设备验收或分发许可批准；没有购买授权、替本人接受协议或变更 pending 决策。
