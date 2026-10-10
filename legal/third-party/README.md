# 第三方许可补充载荷

本目录保存当前固定版本的原始许可与通知，随 Online/Offline 候选复制到安装目录 `resources/legal/third-party/`。`manifest.json` 记录每份原文的 SHA-256、官方来源、revision、适用组件、取证时间及范围限制。原始完整文本没有翻译或删节；部分源码文件整体保留，是为了保留文件级版权通知。新增 AOM 记录包含 13 份完整原文及 1 份明确标注源文件、逐字节保留版权头的汇编；该汇编在 manifest 中以 sourceMembers 和原始偏移单独记载。

这是一份**部分许可文本证据**，不是完整递归 SBOM、全部对应源码、最终法律批准或项目开源声明。项目与组件 `pending` 决策不变。本文也不构成下载模型、接受协议、签署或提交登记的授权。

- `onnxruntime-*`：分别对应 manifest 中锁定的 node/common、web 和嵌套 common 版本，保存其上游 LICENSE 与 ThirdPartyNotices。ORT 的 MIT 不覆盖所有旁置二进制；下列 Microsoft 文本分别记录其适用范围。
- `microsoft/directml-1.15.4/`：精确 NuGet 包的 `LICENSE.txt`、`ThirdPartyNotices.txt` 和原始 README。运行库适用 Microsoft DirectML 条款；README 对 include/build 代码的 MIT 说明不能代替 DLL 许可。
- `microsoft/dxc-1.8.2502.8/`：ORT 旁置 dxcompiler/dxil 的 `LICENSE-LLVM.txt` 与该 NuGet 原始 ReleaseNotes。此版本 ReleaseNotes 将除 `d3d12shader.h` 外的文件对应到 LLVM/NCSA 文本；未将包内遗留的 `LICENSE-MS.txt` 冒充此版本 DLL 的适用许可。DirectML 和这两份 DLL 与官方包成员仅在排除 PE 校验和、安全目录、证书数据后比对一致，原始 SHA-256 不同；没有声称验证了整份 NuGet 签名。
- `microsoft/dawn-dxc-eb67a9085c/`：Electron 42.8.0 → Chromium 148.0.7778.280 → 固定 Dawn → DXC commit 的完整 `LICENSE.TXT`，保留第三方附录。该链为源依赖证据，未声称自构建结果与实际 DLL 完全相同。
- `microsoft/windows-sdk-10.0.26100.0/`：已安装 SDK 的原始许可 RTF、第三方通知 RTF 和官方 REDIST 页面快照。实际 `d3dcompiler_47.dll` 10.0.26100.7705、根目录 DXC/DXIL 均已与官方 Electron 42.8.0 Windows x64 原包逐字节对应；ORT 的 DirectML/DXC/DXIL 也与官方 npm 原包逐字节对应，整包摘要或 SRI 已核验。本机 SDK 为 8249 不再列作 7705 直接发行来源缺口。NuGet 及 SDK 的签名变体比对仍按前述范围解释，没有变成整份 NuGet 签名已验证。SDK 下游条款保护、实际同意方式和有效版权声明仍须落实；完整 SDK 通知的保留不表示其中全部组件随软件提供。
- `canvas-1.0.3/`：保留 canvas 主 MIT、固定 Skia/ICU revision 及已识别依赖通知。实际 canvas 二进制与官方 npm 1.0.3 原包逐字节一致；17 个 Rust 版本有二进制源码路径证据，另补 cssparser-color 0.5.0、cssparser-macros 0.7.0 的原始 MPL 许可，版本由固定依赖、默认 feature 和发布时间支持。`aom-3.11.0/` 保留 AOM LICENSE/PATENTS/AUTHORS、fastfeat/vector/x86inc/SVT-AV1 声明及保守附送的 libwebm/libyuv 声明。AOM 3.11.0 有实际二进制标识，libaom-sys 0.17.2 wrapper 为推断；dirty Git 提交没有替代 registry 原包。`native-supplement/` 保留 AVIF 与 mimalloc 的原始通知，其历史精确版本和可选链接范围未全部确认，不将候选来源冒充确定组成。该范围仍不是完整原生 SBOM；替代许可文本的保留不表示已选择全部许可分支。
- `sharp-0.35.4/windows-package/`：本机精确 0.35.4 包实际收到的 README、LICENSE 和版本表。构建脚本曾从历史 main 取通知，确切历史提交未确定，因此仅声称保留实际收到的文本，不把该表当成所有依赖的完整授权。
- `sharp-0.35.4/`：保留 GNU 官方 LGPLv3、其引用的 GPLv3，以及已校验 libvips 8.18.6 源码归档的 LICENSE 和 libnsgif COPYING。保留 GPL 文本不代表独立应用采用 GPL。审计已补齐 8 个生成文件，2,340 条带 MD5 记录均有对应源码；1,981 条模块记录已对应，原补丁、接口、构建/安装规则已核对。已把相关材料整合为自足源码附件并通过仅持附件的离线解压核验；已审范围内没有可明确指出的缺失必要源输入。单独目录包和完整附源码分发包的交付范围须以各自清单区分，不把私有审计目录存在等同于向外部接收者发放。

许可证中的网址是上游来源入口，不代表已向最终接收者提供了完整对应源码，也不是项目对未来可用性的书面要约。修改版 DLL 的兼容性、接收者替换/调试条件与最终安装包验收均须单独记录。此目录不声称这些事项已经通过。

`cssparser`、`cssparser-color`、`cssparser-macros` 的 MPL 覆盖源码现已放入相邻 `../covered-source/canvas-rust-sources.zip`，获取说明见 `../covered-source/README.md`。附件含 19 份原始 crate 和 37 个展开 MPL 文件，已从实际目录包取出离线校验。这个已知范围的本地源码获取已经落实；不把整个 Siftory 项目自动改成 MPL，也不把它写成完整原生依赖清单。

本次 Microsoft、Rust 与原生库文本针对当前随软件交付的组件；不把另行下载的模型或可选 GPU 运行时许可混入必带清单。manifest 的 Electron 42.8.0 与 npm 精确版本绑定用于发现版本漂移，不能替代原生二进制来源核查。

`guid-typescript@1.0.9` 的固定版本全文证据尚缺，但当前实际包已剔除它和已审嵌入副本，并由构建前后检查保持这一范围；开发锁文件关系仍在，重新引入须重新核对。没有将“本次不分发”写成“许可证已批准”。其他未在本目录列出的组件仍应结合安装包原有 LICENSE/NOTICE 与其实际版本核对；不能以本目录存在推断全包授权完成。

原始 CI 日志、完整历史编译器环境和逐字节复现可用来补强身份核对；不将它们作为所有许可或软件著作权登记的通用前提。对应源码范围、必要修改与可用构建/安装信息仍按适用许可和实际分发内容判断。

工程校验命令为 `npm run licenses:payload-check`。它检查原文摘要、路径和源端锁定版本，不作法律批准。安装产物可用 `node scripts/check-license-payload.cjs --payload-root=<资源目录/legal/third-party>` 进行纯文件检查；无需启动应用、读取用户数据或安装依赖。
