# Siftory 登记与工程状态续记

> 状态：部分实施  
> 更新日期：2026-09-28  
> 执行系统：Codex / GPT-6 系列，精确部署小版本未公开  
> 所有者：Codex/root  
> 协作：Codex/remaining_engineering_audit、Codex/remaining_license_audit 只读审查；其他运行时状态未知  
> 替代文档：接续 2026-09-26 状态入口；保留该页作为历史检查点

## 登记进度与使用材料

用户已报告实名认证通过，随后提供的官方系统截图显示“填报完成”和“申请确认签章页上传”，提示继续上传签章页扫描件以完成提交。当前没有本人签章页上传成功记录、申请号或最终提交回执，因此状态记录为“已填报，待本人签章上传及确认提交”，不能写为已提交或已获登记。

V1.0.0 开发完成日期仍为 2026-09-25。个人独立开发、未发表等事实承接用户此前陈述；没有据本次维护或网站样片推定发表情况发生变化。身份证明、联系方式和签署材料由本人管理，不抄入源码仓库。

既有 60 页源程序 PDF、27 页完整用户说明书 PDF 保持冻结。9 月 28 日的审计报告和按系统字段整理的填报参考位于仓库旁私有目录 `siftory-copyright-20260924/registration-audit-20260928/`。文件摘要和冻结源码范围见[9 月 26 日检查点](2026-09-26-registration-and-release-status.md)。后续维护源码不能再直接描述为与 9 月 25 日冻结源程序逐字节相同。

## 本轮完成的依赖检查

独立条款窗口通过路径加载 `endUserTermsPreload.js` 和 `terms.html`，主窗口的静态导入图无法自动覆盖这两个入口。本轮在 [构建依赖检查器](../../scripts/check-build-graph.cjs) 中显式加入 `electron/endUserTermsPreload.ts` 和 `src/terms.tsx`，分别限制为 2 和 4 个可达模块。

- 两个 preload 各自只允许自身和 `shared/**`，不允许互相引用或通过共享模块绕入服务、界面。
- 两个 renderer 均禁止到达 `electron/**`；主进程与 worker 均禁止引用任何 preload。
- 缺少入口、无法解析的相对导入、超出预算均会失败；补齐 TypeScript `import = require()` 的静态解析。
- [20 项 CLI 夹具回归](../../tests/build-graph.test.cjs) 接入 `npm run test:architecture`，检查合法入口、具体越界诊断、间接引用、两个独立预算及共享依赖循环。

在独立工作树使用当前源码覆盖层执行 `npm.cmd run test:architecture` 通过：500 个模块分层检查通过；主进程 308、普通 preload 23、主 renderer 159、条款 preload 2、条款 renderer 4；20 项测试通过，无失败和跳过。该工具检查相对 TypeScript 导入，不声称覆盖任意计算路径、运行时加载或第三方包内部依赖。

工作树为 `siftory-copyright-20260924/build-graph-terms-20260928/`；前态、摘要和回接验证记录保存在 `siftory-copyright-20260924/goal-audit-20260928/build-graph-terms/`。本轮只涉及工程检查与文档，没有修改桌面功能、冻结 PDF 或重新生成安装器。

## 发行物与剩余事项

现有安装器和对应第三方源码附件已经生成，使用项目内 9 月 26 日安装说明（本地证据未随源码公开：`../../release/20260926-maintenance/安装说明.md`） 及 构建记录（本地证据未随源码公开：`../../release/20260926-maintenance/build-record.json`）。旧审计中的“新 NSIS 待验”不能覆盖这些后续证据；也不能将本轮检查脚本补丁描述为已经打入该安装器。

已识别的第三方对应源码附件与绑定证据保留；原生组件清单 `completeNativeInventory:false` 仍未关闭。当前 Online 包不包含模型，可选模型条目的待审批状态不等于包内已经分发模型，也不等于所有第三方组件无许可证。

仍待完成的事实条件包括：本人签章及提交回执、正式发行条款和发布身份、数字签名与干净 Windows 安装/升级验收，以及真实 NAS/SFTP、多屏/休眠和既定检索质量/长期负载验收。中文默认双屏合成拖动偏差尚未确证根因，不能用中文单屏通过关闭该项。

## 宣传样片

首段微信风格“帮忙找源文件”网页动画已交付：[41 秒样片](https://siftory-depth-preview-20260925.cato09291.chatgpt.site/promo)，保持原站点仅所有者可见的访问范围。分为收到需求、翻找困境、拖入参考图、查询索引、查看图片和工程文件候选五幕。待用户确认风格后再扩展其他板块。

构建、类型、静态检查和生产 Worker 渲染验证已完成；当前 Browser 未发现可用浏览器，尚未执行浏览器视觉及点击验收。源码和部署证据见样片交付记录（本地证据未随源码公开：`../../artifacts/promo-20260928/README.md`）。
