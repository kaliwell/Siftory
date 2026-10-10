# 2026-09-24 生产依赖安全修复与许可补充

本补充对应许可矩阵完成后的依赖变更。原研究中的 sharp 0.35.0、libvips 8.18.3 及旧锁文件哈希保留为历史证据，不代表以下新工件；不改动原许可研究，也不将任何 pending 变为 approved。

## 已确认的版本变更

2026-09-24 再次只读核对 integration/package.json、package-lock.json：

| 组件 | 原锁定 | 当前候选锁定 | 主许可或发行包声明 |
| --- | --- | --- | --- |
| adm-zip | 0.6.0 | **0.6.1** | MIT |
| sharp | 0.35.0 | **0.35.4** | Apache-2.0 |
| @img/sharp-win32-x64 | 0.35.0 | **0.35.4** | Apache-2.0 AND LGPL-3.0-or-later |
| @huggingface/transformers | 4.2.0 | **4.2.0，未升级** | Apache-2.0 |
| onnxruntime-node | 1.24.3 | **1.24.3，未升级** | MIT |

根 overrides 已精确设置为 `adm-zip: 0.6.1`、`sharp: 0.35.4`。它们覆盖间接依赖；此次 audit 对 Transformers／ORT 的报告来自下游传导，不需要因此直接升级推理框架。[npm 11 overrides 说明](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)

本次只读元数据查询使用固定 npm 11.13.0（Program Files 中配套 CLI，命令级 prefix）；未安装依赖或写入共享 node_modules。根代理在独立依赖副本中负责安装与验证，本补充不冒认其执行结果。

## 漏洞及官方修复证据

**adm-zip：0.6.1 是本次已核实的最小修复目标。** 作者 2026-09-11 安全公告及后续审阅将声明解压大小造成内存拒绝服务的问题标为 0.6.1 已修复。官方同日 release 还记录解压大小限制、重复条目拒绝及目标目录符号链接写入防护。[作者 DoS 公告](https://github.com/cthackers/adm-zip/security/advisories/GHSA-7q85-xj36-vmfc)、[v0.6.1 发布说明](https://github.com/cthackers/adm-zip/releases/tag/v0.6.1)

符号链接漏洞的 [GHSA-vwc7-r8mq-g2x9 数据库页](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)仍显示旧的 Patched=None，受影响范围止于 0.6.0，页面最后更新 2026-09-08，早于 v0.6.1 发布。此处修复判断另外采用更晚的作者 release 和[固定 tag util/utils.js 的 assertPathSafe 防护](https://raw.githubusercontent.com/cthackers/adm-zip/v0.6.1/util/utils.js)，没有只因 audit 不再匹配就推断所有解压场景安全。当前确认的项目链路为 ORT 安装资源解压，未据此豁免安装阶段风险。

**sharp：0.35.4 是本次已核实的最小修复目标。** 作者 2026-08-27 公告列出受影响范围 <0.35.4；0.35.4 预编译工件提供 libheif 1.23.2。使用系统自装 libheif 的环境还需自行核实其版本。[sharp 作者安全公告 GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)、[v0.35.4 发布页](https://github.com/lovell/sharp/releases/tag/v0.35.4)

公告描述的特定远程代码执行条件涉及 glibc Linux，不能直接等同于已证明 Windows 有同样利用条件；修复不可信媒体处理依赖和通过生产依赖安全门槛仍有必要。没有运行攻击样本。

## 许可义务没有因安全升级消失

- adm-zip 0.6.1 的[精确 tag LICENSE](https://raw.githubusercontent.com/cthackers/adm-zip/v0.6.1/LICENSE)仍为 MIT；分发保留版权和许可。
- sharp 0.35.4 的[精确 tag LICENSE](https://raw.githubusercontent.com/lovell/sharp/v0.35.4/LICENSE)仍为 Apache-2.0；主许可没有改变。
- npm 发布元数据及新锁文件中的 `@img/sharp-win32-x64@0.35.4` 仍声明 Apache-2.0 AND LGPL-3.0-or-later。**libvips 等二进制的 LGPL 义务继续适用**，不能因为 sharp 主包为 Apache 就删除对应库的许可证、版权和源码／替换或重链接安排。[npm 发行元数据](https://registry.npmjs.org/@img%2fsharp-win32-x64/0.35.4)、[GNU LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.en.html)

元数据说明 sharp 0.35.4 要求 Node >=20.9.0、libvips >=8.18.6；平台包跟随 0.35.4，分离的 `@img/sharp-libvips-*` 依赖为 1.3.3。安装后的具体 DLL／编解码组件和 NOTICE 应以实际工件核查，不能仅凭主包 SPDX 认定所有内嵌依赖均已审完。

已查询的 npm integrity：

| 发行包 | integrity |
| --- | --- |
| adm-zip 0.6.1 | `sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==` |
| sharp 0.35.4 | `sha512-n++8XWcj+jCOr2IOl7h8LbKnGBDY4aPbmprMONBNFdn0ImXqpGVv5zliDs0V9HbmbCQLpbuo2ej9rAoOQTvMDA==` |
| @img/sharp-win32-x64 0.35.4 | `sha512-XtmnYhBcrORsJ4XJngyzr/EWP0hRZLAZRFaApdKuviyqF78+ylxh2y06ZmtULAMOnObJ3ucpN0AcwSWnMowTRg==` |

## 交付状态

**已核实**：最小版本、官方修复依据、许可类别、当前候选锁文件及未升级的推理框架版本。

**仍由实施者绑定结果**：独立依赖安装、实际二进制版本、更新后的生产 audit、图像预处理／嵌入相关回归、Node 第三方清单及最终构建摘要。确认修复及安全检查通过后才关闭对应工程漏洞项；安全修复本身不是登记完成、个人全部权利确认或第三方商业发布批准。

本文件是新增版本补充，不能用旧 PDF 或旧 sources.json 的哈希冒充升级工件证据；如最终许可 PDF 加入此补充或新版备注，应重新计算其摘要。
