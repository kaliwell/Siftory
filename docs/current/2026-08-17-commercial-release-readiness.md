# Siftory（寻藏）商业发布准备专项

> 状态：部分实施
> 更新日期：2026-08-24
> 范围：Windows Online/Offline 商业分发的许可证、隐私、签名、质量证据、支持与发布操作
> 只读检查：`npm.cmd run release:readiness -- --profile=offline`
> 结构校验：`npm.cmd run todo:commercial-check`
> 边界：本文是工程发布基线，不构成法律意见、许可证批准、签名授权或商业承诺

## 1. 当前判定

源码工程门禁已经稳定，但当前版本仍是内部候选，不是商业发布版本。2026-08-19 已在全面审计后重新生成并通过归档冒烟的 Online 安装候选，但构建日志明确记录跳过签名，且产物没有绑定干净提交、版本标签和 packaged matrix。发布阻塞仍集中在真实权利主体决策、第三方许可证、最终隐私/EULA、代码签名、干净发布提交、受控 Neko 基线和与当前提交绑定的安装包证据。

已确认发布者类型为**个人开发者/个人版权主体**。这只确定发布方向，不等于身份审核或法律批准；系统用户名不会被当作真实姓名。公开发布者名称、业务联系邮箱、销售地区、签名证书主体以及安全存放的身份审核记录仍待填写。敏感证件、税号、银行信息、私人住址和签名私钥不得提交到仓库。

任何自动化只能检查证据，不能代替真实审批人填写身份、接受第三方条款、签署 EULA、购买证书、创建虚假 Git Tag 或覆盖准确率基线。

2026-08-19 新增了[开源、商业化与基金会路径草案](2026-08-19-open-source-commercialization-foundation-strategy.md)。该草案只比较未来路线，不是许可证批准：`package.json` 仍为 `private + UNLICENSED`，`legal/license-decisions.json` 仍是当前机器可读决策源，本专项的专有商业候选门禁也没有被自动关闭或替换。

## 2. 品牌命名方案

项目已采用以下中英文品牌；工程改名已经执行，但商标可用性与注册结论仍待正式清查：

| 使用范围          | 工程采用名称       | 配套文案                             |
| ----------------- | ------------------ | ------------------------------------ |
| 海外/英文市场     | **Siftory**        | **Private AI Search for Your Media** |
| 中国大陆/中文市场 | **寻藏**           | **本地 AI 媒体搜索与素材管理**       |
| 中英文联合展示    | **Siftory · 寻藏** | 根据界面语言显示对应副标题           |

命名语义：`Siftory` 取自 `Sift`（智能筛选）与 `Story`（内容、故事）的组合；“寻藏”表达在本地图片、视频、音频和其他素材中搜索、发现与管理内容。两者均对应当前产品的真实定位，不再以“时钟”作为产品核心含义。

当前状态与边界：

- `Siftory` 和“寻藏”已经成为项目的用户可见名称，但尚未完成正式商标清查、注册或法律批准，不得标记为注册商标，也不代表商业使用风险已经排除。
- 基础网络检索暂未发现名为 `Siftory` 的直接同类软件；该结果不等同于商标可用性结论。
- 商业发布前，必须使用 [WIPO Global Brand Database](https://www.wipo.int/en/web/global-brand-database/index) 以及目标销售国家/地区的官方商标数据库，按相关类别完成近似名称与权利冲突核验。
- 用户可见名称、窗口标题、安装器、项目包名和当前发布文档已改为新品牌；旧 `appId=com.floating-clock.electron`、`%APPDATA%\floating-clock-electron`、设置文件名和旧环境变量作为兼容标识保留，避免现有设置、索引、模型缓存和远程配置丢失。
- 历史审计、旧安装包哈希记录和既有证据中的 `FloatingClock` 保持原文，不追溯改写；这类残留不属于当前产品展示名称。

品牌方案的发布验收条件：完成目标地区商标清查并保存仓库外审批证据、确认公开使用名称和域名、批准中英文名称与副标题、验证旧版本升级后的设置/索引/模型缓存兼容性。

## 3. 当前分发画像

| Profile | 默认随包组件                                                         | 当前许可证风险                                                                               |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Offline | DINOv2、CLIP、多语言 CLIP、Gyan FFmpeg full build、项目 Native addon | FFmpeg 为 `GPL-3.0-or-later`；项目 Native addon 尚无最终项目许可证；所有实际随包决策仍待批准 |
| Online  | 项目 Native addon；模型和工具不随安装器内置                          | 项目许可证和 Native addon 权属仍待批准；首次下载流程仍须按组件许可与用户告知执行             |

另外，YOLOv8 COCO 组件标记为 `AGPL-3.0-only`，当前不是默认随包资源。若未来让商业版本自动下载、托管或分发该组件，必须先完成专门的开源合规/商业授权判断；不能把它和 MIT/Apache-2.0 组件等同处理。

## 4. 已建立的工程材料

- 项目专有 EULA 草案：[PROPRIETARY-EULA.template.md](../../legal/PROPRIETARY-EULA.template.md)。
- 个人发布者资料清单：[INDIVIDUAL_PUBLISHER_INTAKE.template.md](../../legal/INDIVIDUAL_PUBLISHER_INTAKE.template.md)。
- 隐私政策与真实数据处理清单：[PRIVACY_POLICY.template.md](../../legal/PRIVACY_POLICY.template.md)。
- 安全、更新与支持策略草案：[SECURITY_AND_SUPPORT_POLICY.template.md](../../legal/SECURITY_AND_SUPPORT_POLICY.template.md)。
- 第三方分发清单：[THIRD_PARTY_COMPONENTS.md](../../THIRD_PARTY_COMPONENTS.md)。
- 许可证决策记录：[license-decisions.json](../../legal/license-decisions.json)。
- 商业政策审批记录：[commercial-release-decisions.json](../../legal/commercial-release-decisions.json)。
- 升级、回滚、数据导出和卸载边界：[升级与数据生命周期说明](../reference/2026-08-12-upgrade-rollback-data-lifecycle.md)。
- 最新整改闭环：[2026-08-24 功能完成度审计整改闭环](2026-08-24-functional-completion-remediation.md)；[2026-08-19 全项目多维审计](../audits/2026-08-19-full-project-multidimensional-audit.md)和[2026-08-17 全项目复审](../audits/2026-08-17-full-project-audit.md)作为历史快照保留。
- 开源与商业化评估：[开源、商业化与基金会路径草案](2026-08-19-open-source-commercialization-foundation-strategy.md)。

上述 `template` 文件禁止进入正式安装包；只有替换全部占位符、移除草案标记并经过真实授权审核的最终文件才可进入发布。

## 5. 机器可读任务表

| Rank | ID      | Value | Mode      | Dependencies                                                                    | External blockers                                              | Branch                                   | Status      | Validation                                             | Task                                                   |
| ---: | ------- | ----: | --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ----------- | ------------------------------------------------------ | ------------------------------------------------------ |
|    1 | VAL-301 |   100 | approval  | -                                                                               | 个人公开发布者名称、联系渠道、销售地区、签名身份与真实审核证据 | `release/commercial-identity-eula`       | in_progress | publisher decision + project license gate + final EULA | 个人发布者方向已选；补齐公开身份、最终 EULA 和销售范围 |
|    2 | VAL-302 |    98 | approval  | VAL-301                                                                         | FFmpeg GPL、模型权重、CUDA/cuDNN 与用户模型分发法律判断        | `release/component-license-decisions`    | blocked     | online/offline license gate + notices                  | 逐项批准、替换或排除商业 profile 中的第三方组件        |
|    3 | VAL-303 |    94 | auto      | -                                                                               | -                                                              | `docs/commercial-policy-baseline`        | verified    | documentation + no-template packaging tests            | 建立商业发布专项、隐私数据清单及安全/更新/支持草案     |
|    4 | VAL-304 |    92 | auto      | -                                                                               | -                                                              | `build/commercial-readiness-report`      | verified    | readiness unit tests + truthful current report         | 增加只读商业发布准备检查器，显式报告八条发布线         |
|    5 | VAL-305 |    90 | approval  | VAL-301                                                                         | 最终发布者、隐私联系渠道和适用地区审核                         | `legal/final-privacy-policy`             | blocked     | final-policy detector + bilingual UI notice review     | 生成并批准最终隐私政策，不以工程模板冒充正式文件       |
|    6 | VAL-306 |    88 | approval  | VAL-301                                                                         | 安全邮箱、支持 SLA、更新通道和生命周期决策                     | `ops/security-support-policy`            | blocked     | final-policy detector + support owner evidence         | 批准安全响应、手动/自动更新、回滚和支持生命周期        |
|    7 | VAL-307 |    86 | approval  | VAL-301; VAL-302                                                                | 当前大量历史修改的归属确认与人工代码审查                       | `release/clean-source-tag`               | blocked     | clean worktree + reviewed commits + version tag        | 整理干净可追溯的发布提交并创建与版本一致的 Tag         |
|    8 | VAL-308 |    84 | approval  | VAL-307                                                                         | 可信代码签名证书与受保护的签名执行环境                         | `release/authenticode-signing`           | blocked     | installer Authenticode status Valid                    | 配置生产签名、时间戳和发布者身份验证                   |
|    9 | VAL-309 |    82 | approval  | -                                                                               | 固定的同一批受控图片与人工标注                                 | `ops/neko-controlled-baseline`           | blocked     | comparable active-set fingerprint + quality gate       | 完成 Neko 同素材 before/after 基线，不自动覆盖旧基线   |
|   10 | VAL-310 |    80 | triggered | VAL-302; VAL-307; VAL-308; VAL-309                                              | 已批准许可证、签名和受控素材证据                               | `release/packaged-matrix-current-commit` | blocked     | online/offline × zh-CN/en + commit binding             | 从干净提交生成并验证双 profile 双语安装包证据          |
|   11 | VAL-311 |    76 | approval  | VAL-310                                                                         | 干净 Windows 设备/虚拟机和真实安装操作                         | `ops/clean-machine-acceptance`           | blocked     | install + upgrade + rollback + uninstall report        | 验证无开发环境安装、升级、回滚、卸载和数据保留         |
|   12 | VAL-312 |    72 | triggered | VAL-301; VAL-302; VAL-305; VAL-306; VAL-307; VAL-308; VAL-309; VAL-310; VAL-311 | 所有发布证据齐全                                               | `release/commercial-v1`                  | blocked     | release gate + SBOM + hashes + signed record           | 执行正式 Online/Offline 发布并生成不可伪造的发布记录   |

## 6. 当前可复查结果

执行以下命令只读取现状，不批准任何决策：

```powershell
npm.cmd run todo:commercial-check
npm.cmd run release:readiness -- --profile=offline
npm.cmd run release:readiness -- --profile=online
```

检查器要求八条发布线全部通过：许可证、干净源码、版本 Tag、签名配置、Neko 可比基线、当前提交绑定的 packaged matrix、已记录真实审批证据的最终隐私政策、已记录真实审批证据的最终安全/更新/支持政策。

`release:gate` 已改为在打包后通过 `validate:packaged:matrix -- --profile=<profile> --skip-build` 汇总资源和双语 UI 证据，再在签名、SBOM 与 release record 之前执行上述 8/8 readiness。自动回归确认 readiness 非 0 时不会调用签名器，也不会生成 release record；这只是修复门禁绕过，不代表当前任何发布线已经关闭。

### 6.1 2026-08-24 只读结果

Online 和 Offline 均为 `0/8`，检查器按设计以退出码 1 阻断，并未构建安装包。

| 门禁           | 当前结果                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| `REL-LEGAL`    | 阻断：3 个项目级问题；Online 1 个、Offline 5 个默认随包组件待审批；publisher pending |
| `REL-SOURCE`   | 阻断：工作区存在大量未归档变更路径；数量以只读门禁实时输出为准                       |
| `REL-TAG`      | 阻断：缺少 `v1.0.0`                                                                  |
| `REL-SIGN`     | 阻断：生产签名命令缺失或非法                                                         |
| `REL-NEKO`     | 阻断：活动集 `266001` 与基线 `245171` 不一致                                         |
| `REL-PACKAGED` | 阻断：packaged evidence 缺失、过期或未绑定当前提交                                   |
| `REL-PRIVACY`  | 阻断：最终 `legal/PRIVACY_POLICY.md` 缺失或未批准                                    |
| `REL-SUPPORT`  | 阻断：最终 `legal/SECURITY_AND_SUPPORT_POLICY.md` 缺失或未批准                       |

同一轮 `npm.cmd audit --omit=dev` 退出码为 0，生产 npm 依赖发现 0 个已知漏洞。该结果不批准任何项目或第三方组件许可证。

## 7. 下一步顺序

1. 对 `Siftory` 和“寻藏”执行目标市场商标与近似名称清查，确认域名，并依据清查结果决定继续使用或在商业发布前再次更名。
2. 按个人发布者资料清单补齐 `VAL-301` 的公开字段；敏感身份证明只保存在仓库外的安全位置。
3. 对 Offline profile 优先决定 FFmpeg GPL 路线：履行 GPL 分发义务、改用经确认的兼容构建，或不再内置。
4. 完成 `VAL-302` 的逐组件记录；未批准组件不得因本机已下载就进入安装包。
5. 根据两个模板形成最终隐私和支持政策，交真实负责人审核。
6. 再处理干净提交、版本 Tag 和签名证书；最后才运行 packaged matrix 与 `release:gate`。

如果真实权利主体决定改走开放核心、全量开源或双重许可，必须先形成新的人工批准记录，再重新设计项目许可证、贡献协议、EULA、构建 profile 和发布门禁。仅增加公开仓库或 `LICENSE` 文件不能替代这一决策链。

## 8. 品牌改名后的商业复审

2026-08-17 已完成工程层品牌改名并重新执行发布检查。2026-08-19 全面审计后生成了新的内部 Online 安装候选，但没有生成或宣称正式商业安装包。

| 检查项               | 当前结果                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 包名             | `siftory-desktop`                                                                                                                                                      |
| Windows 产品名       | `Siftory`                                                                                                                                                              |
| 安装器预期名称       | `Siftory Setup 1.0.0.exe`、`Siftory Online Setup 1.0.0.exe`                                                                                                            |
| 窗口/HTML 标题       | `Siftory · 寻藏`                                                                                                                                                       |
| 数据兼容             | 继续使用 `%APPDATA%\floating-clock-electron`；自动化测试确认改名不会切换用户数据根目录                                                                                 |
| 第三方材料           | Runtime manifest、模型 manifest、第三方组件清单和法律模板已更新为新品牌；兼容 ID 不改名                                                                                |
| 用户可见旧名称残留   | 核心代码、安装配置、当前法律材料和当前入口文档扫描为 0；45 个历史/交接/基准文档仍保留当时名称和旧产物记录                                                              |
| `npm.cmd run verify` | 通过；用时 446.3 秒，包含类型、Lint、格式、全部测试、Native 测试和生产构建                                                                                             |
| 2026-08-24 全面复验  | `npm.cmd test`、扩展关键覆盖率 121/121、TypeScript、Lint、格式、文档、架构、双语 14/14 面板 UI 冒烟、媒体播放器冒烟和 Native 73/73 均通过；详见最新整改闭环            |
| 生产依赖审计         | `npm.cmd audit --omit=dev --audit-level=high`：0 个已知漏洞                                                                                                            |
| 内部 Online 候选     | `release/Siftory Online Setup 1.0.0.exe`；169,224,233 bytes；SHA-256 `19878F6DCC38FE72F78D0EB94EDEED550131CFD8B5DFA1435304B56CA0EA3C94`；归档冒烟识别 248 个文件并通过 |
| 候选签名/用途        | 构建明确跳过签名；仅限内部 QA，不是正式 Release，也不得对外描述为已签名商业版本                                                                                        |
| Online readiness     | `0/8`；项目许可/发布者审批与 1 个默认随包组件未批准，其他七条发布线也未关闭                                                                                            |
| Offline readiness    | `0/8`；项目许可/发布者审批与 5 个默认随包组件未批准，其他七条发布线也未关闭                                                                                            |
| 源码发布状态         | 2026-08-24 只读门禁确认工作区存在大量未归档变更路径；实时数量会随整改变化，仍不满足干净、可追溯发布提交要求                                                            |

改名没有降低任何既有发布门禁，也没有把暂定品牌自动提升为已批准商标。当前工程可以继续开发和内部验证，但仍不能公开宣称为正式商业发布版。

## 9. Online-first 发行包合规加固

2026-08-17 已开始执行个人开发者首发的 Online-first 路线，完成以下自动化工程项：

- `npm run build`、未显式指定 profile 的发布门禁默认使用 `online`，`offline` 必须显式选择。
- 基础 `package.json` 不再直接携带 `ai-models` 或整个 `tools` 目录；Offline profile 只能通过固定白名单加入三个嵌入模型目录及 `ffmpeg.exe`、`ffprobe.exe`、`README.md`。
- profile runtime manifest 的 `defaultBundled` 状态由固定组件 ID 白名单重建，不能通过修改源 manifest 把待审批组件带入安装包。
- `models/manifest.json` 也按 profile 独立生成：Online 明确记录三个模型均未随包，Offline 才记录固定嵌入模型；最终包扫描同时核对两份 manifest，防止内容与声明不一致。
- packaged resource 检查新增反向扫描：Online 禁止任何 `ai-models`/`tools`；所有 profile 禁止 CUDA、托管视频运行时、额外模型目录、私钥、PFX/P12 和 `.env`。
- 新增 `NODE_THIRD_PARTY_COMPONENTS.md`，覆盖 lockfile 中非开发 npm 依赖；`licenses:check` 与 `licenses:gate` 都会拒绝过期清单。
- Qwen3-VL、SenseVoice、Ollama、llama.cpp 和说话人模型已补入 pending 决策记录，但未被自动批准，也未进入安装包。

上述改动降低误分发风险，不关闭 `VAL-301`/`VAL-302`。项目 EULA、个人权利主体、Native addon 权属、最终许可证文本及真实审批人仍必须人工确认。

## 10. 软件著作权与版权声明状态

- 建议主登记名称：`Siftory（寻藏）本地智能媒体搜索与素材管理软件 V1.0`。
- 当前状态：尚未提交软件著作权登记；权利人真实姓名、完成日期、发表状态和最终 V1.0 代码基线仍待确认。
- 申请材料仍需从干净发布基线生成原创源程序鉴别材料和用户手册，不得把第三方依赖、模型权重、FFmpeg、用户素材、密钥或生成产物登记为个人原创。
- 正式安装包仍需提供自有版权声明、EULA、`THIRD_PARTY_NOTICES`、模型/运行时声明、隐私政策和数据权利边界。

## 11. 开源评估与当前商业路线的边界

| 项目       | 当前事实                                 | 未来候选                                                       |
| ---------- | ---------------------------------------- | -------------------------------------------------------------- |
| 项目授权   | `UNLICENSED`，项目许可证待批准           | Apache-2.0、MPL-2.0、双重许可或继续专有，均需人工决定          |
| 发布模式   | 按个人发布者的专有 Online-first 候选准备 | 开放核心可保留官方签名发行、Pro/Studio/Enterprise 与支持收入   |
| 商业 EULA  | 只有模板，尚未批准                       | 开源部分适用项目许可证；商业模块、官方服务和第三方资源另行约定 |
| 第三方组件 | 逐组件 pending/排除/候选                 | 不因项目开源而自动获得模型、FFmpeg、CUDA 或素材再分发权        |
| 社区治理   | 尚无公共远程、独立维护者或公开决策流程   | 先建立公开贡献和治理机制，达到多组织触发条件后再评估基金会     |

真正的开源许可证允许商业使用和合规再分发。若项目方希望禁止第三方商业使用，只能评估专有或源码可见条款，不能把这种限制描述为开源。无论最终选择何种模式，Siftory 商标、官方签名、更新渠道和支持责任都需要与代码许可证分开定义。

当前工程任务顺序保持不变：先确认权利主体和组件边界，再决定项目许可证；在决定前不得对外宣称项目已经开源、已经商业发布或已经进入基金会。
