# 2026-09-25 第三方商用核查增量

最新工程进展见 [许可入口与实际构建证据](2026-09-25-license-access-and-build-evidence.md)：已实现中英文许可入口、Online 默认配置和模块记录，并开展限定的库替换实验；实验中的误启动及用户数据影响边界也单独如实记录。

用户随后确认模型由用户自行下载、不包含在软件内。本次选定发行范围为无模型的 Online 包；模型再分发事项不作为该安装包的统一前置要求，实际随包组件和模型使用/集成边界分别核对。见 [模型发行范围补充](../../../siftory-copyright-20260924/license-commercial-review-20260925/DISTRIBUTION-SCOPE.md)。

后续工程已将36份新增许可原文落实到源项目，补充载荷共76份，并整理sharp/libvips、Electron FFmpeg、canvas Rust三组源码候选附件。新Online目录包经过生产重编译和实物核对；详见 [本轮交付与仍需收尾的事项](../../../siftory-copyright-20260924/license-delivery-20260925/README.md)。源码配方应区分20项固定发行证据与7项当前MXE基础快照，后者历史基线仍未证实。

本轮以实际 Online 内部目录包及固定版本原文核对商业使用许可。详细取证和源码附件保存在同一工作区父目录的独立审查目录，避免覆盖冻结登记材料：

- [商用核查总报告](../../../siftory-copyright-20260924/license-commercial-review-20260925/REPORT.md)
- [按实际分发范围的执行清单](../../../siftory-copyright-20260924/license-commercial-review-20260925/ACTION-PLAN.md)
- [基础库与67个实际npm包](../../../siftory-copyright-20260924/license-commercial-review-20260925/foundation/REPORT.md)
- [13项模型/字体](../../../siftory-copyright-20260924/license-commercial-review-20260925/models/REPORT.md)
- [原生栈、GPL/LGPL及NVIDIA](../../../siftory-copyright-20260924/license-commercial-review-20260925/native/REPORT.md)
- [微软运行库](../../../siftory-copyright-20260924/license-commercial-review-20260925/microsoft/REPORT.md)

多数已识别MIT、Apache、BSD、ISC、OFL许可允许免费商业使用，内部pending不是必须付费的证明。当前仍需补源码交付、通知、版本来源及适用条款，不能把“许可路径明确”标成“所有发布义务完成”。

本轮对既有研究的具体补充：

1. ASAR实际67个包目录已对应锁表，73份独立包内许可证/通知已核对。guid-typescript仍为ISC声明而缺原始完整通知，不凭此宣布必须付款或禁止商用。
2. sharp/libvips的28项已知版本源码已备，递归依赖和接收者源码交付仍待收尾；canvas新增识别cssparser0.37.0的MPL-2.0义务。
3. Online排除的是Gyan GPL命令行工具，Electron自带FFmpeg DLL仍存在，其固定Windows配置采用LGPL2.1+。
4. DirectML、ONNX所带DXC/DXIL的版本和对应许可已补证；SDK/Dawn两条来源分别记录，签名差异不能简写为原文件SHA相等。
5. CUDA/cuDNN精确归档许可、GPU ORT1.24.3许可与通知已取得；不能再将cuDNN补丁原文称为未取得。未代替用户接受协议。
6. FSMN/CAM++固定Apache声明已取得，Qwen Ollama许可层绑定有效。AdaFace转换仓缺支持现有Apache标签的声明；本地Lindevs face不等于两个公开release原件；SenseVoice解释仍待许可方确认。
7. 本机外部Ollama已静态识别为0.34.0，旧0.32.9回执只代表历史对象。llama Vulkan候选包还需补通知及OpenMP来源。

详尽哈希、原始URL和边界见各专项结构化报告。本次仅新增审查说明，产品代码、既有构建与冻结ZIP/PDF未改；未将许可决定改成approved、未对外联系或购买授权。
