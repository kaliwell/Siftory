# Phase 4 挂载网络盘与 SFTP 实施记录（2026-08-12）

> 状态：部分实施
> 实施状态：代码实施完成，真实设备验收待外部环境
> 上游方案：`docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md` 第 6、8.2、10、14 节
> 分支：`feat/phase3-staged-index-unified-search`

## 本轮交付

### mounted-network 基础链路

- `MountedNetworkSourceAdapter` 使用 Node 目录接口递归枚举已挂载 SMB/NFS/WebDAV 路径，不调用或宣称 NTFS USN 能力。
- 枚举按 256 条提交 Discovery Catalog；文件元数据读取默认并发 4、单操作超时 15 秒，硬上限分别为 8 和 120 秒。
- 跳过符号链接以避免网络目录环；目录项总量设 200 万安全上限，避免异常服务器响应造成无界内存/队列增长。
- 网络扫描使用适配器自身的并发和超时预算，不占用本地磁盘统一调度器车道；同时只允许一个 mounted-network 扫描，但可与一个本地来源扫描并行。
- 来源新增 UI 可选择“本地磁盘”或“已挂载网络盘”。网络来源强制只读，允许在当前离线时先登记绝对挂载路径，随后通过 probe/scan 更新可用性。
- 超时和普通 I/O 断线映射为 `offline`，权限拒绝映射为 `degraded`，取消映射为 `cancelled`；这些终态都不会删除先前已提交的目录记录。

### SFTP 元数据目录链路

- Sources UI 可选择已有 Remote Terminal profile 和远程根；只有已确认主机指纹的 profile 可用于登记。
- Discovery Catalog 只保存版本化 locator，其中包含 profile ID、登记时已确认的主机指纹和规范化远程根，不包含主机名、用户名、密码、passphrase 或私钥内容。Renderer 只显示 `profileId:remoteRoot`。
- `SftpSourceAdapter` 复用 `listRemoteDirectoryPaged`、`resolveStoredCredential` 和 Remote Terminal profile 存储：后台扫描支持 OS 加密凭据或 agent，不新增明文凭据通道。
- 每次扫描开始前比较当前 profile 指纹与登记时固定值；变化时在读取凭据和联网前 fail closed。现有 SSH host verifier 的未知/变化指纹错误继续原样映射为安全退化状态。
- 远程目录分页递归写入 metadata-only Catalog；跳过 symlink/other，批次默认 256、单页调用超时 30 秒、目录项总量上限 200 万。
- SFTP 与 mounted-network 共用“单个远程扫描”预算，但不占本地磁盘调度车道；取消/离线/安全失败均保留此前目录记录。

### 搜索结果安全取回链路

- SFTP 搜索结果新增“下载”：用户选择本地目录后，素材进入现有 Remote Transfer Queue；同名文件默认安全重命名，不静默覆盖。
- Renderer 只提交 catalog `fileEntryId` 兑换五分钟有效、一次性、绑定当前 `webContents` 的 action token，随后与已有本地下载目录 token 组合入队；它不能为此入口提交 profile、远端路径、大小或凭据。
- 主进程从 Discovery Catalog 权威记录解析 source locator 与 entry locator，校验文件仍位于登记的远程根目录；发 token 和真正入队时各校验一次当前 profile 与固定主机指纹。
- 入队前再次读取 Catalog 并逐字段比较 token claim，来源被删除、路径/大小改变、profile 缺失或指纹变化都会 fail closed；凭据仍只来自 agent 或现有 OS 加密存储。
- action token 存储有 1024 条硬上限并惰性清理过期项，避免 renderer 反复请求形成无界主进程内存增长。

### SFTP 可见结果按需预览

- 当前结果列表最多自动请求前 12 个 SFTP 图片预览；远端读取与解码队列并发 2、等待上限 64，不占本地发现/索引调度车道。
- 单个远端源文件读取硬限制 32 MiB、超时 30 秒，Sharp 解码限制 8000 万像素；支持 JPEG/PNG/WebP/GIF/AVIF/TIFF，其他格式保持 metadata-only，不自动下载原文件。
- 预览转换为最长边 64–256 像素的 WebP，原子写入独立 `remote-preview-cache/v1`；缓存按访问时间淘汰到 256 MiB，可在来源离线后继续显示。
- Catalog D3 写入 `preview-ready:ready`，读取或联网失败记为 `retryable`；后续扫描发现大小或修改时间变化时自动降为 `preview-ready:stale`，缓存键也随之失效。
- 搜索结果显式显示“仅元数据 / 预览已就绪 / 部分 AI 索引 / 完整 AI 索引”，避免把已缓存缩略图误称为完成 AI 建库。

### mounted-network 重挂载修复

- mounted-network 来源新增“修复路径”，通过系统目录选择器提交新的绝对根路径；扫描运行期间拒绝修复。
- 修复保持原 source ID 和 fileEntry ID，并在一个 SQLite 事务内根据原 `relativePath` 重写路径键；不会新建重复来源或丢失 Catalog 阶段状态。
- 有既有目录记录时，从最近记录抽样最多 16 个文件，要求新根至少有一个文件的相对路径、大小和秒级修改时间完全一致；零命中会在事务前拒绝，避免误绑另一共享盘。
- 新根必须当前可访问且为目录，也不得与其他已登记来源重复；修复完成后来源回到 `unknown`，由后续 probe/scan 确认在线状态和完整内容。

## 验收证据

- `npm run test:discovery-catalog`：38/38。除 mounted-network/SFTP adapter、安全取回和预览外，新增重挂载身份保持、错误共享盘拒绝和 UI 接线测试。
- `npm run test:remote-transfer`：4/4；catalog 取回复用原队列，既有冲突和事务行为未回退。
- `npm run test:ipc-registration`：7/7；新增 catalog/transfer IPC 注册、能力声明和有界 payload 校验通过。
- `npm run test:preload-contract`：2/2；preload 实现与共享类型契约一致。
- `npm run test:remote-sftp` 2/2、`npm run test:remote-terminal` 4/4；原有远程路径和 profile/指纹安全回归通过。
- `npm run smoke:ui -- --locale=zh-CN`：重挂载修复 UI 接线后复跑仍为 7 个核心面板、0 崩溃、0 console error；语言、主题、Native/模型/FFmpeg 与备份检查通过。
- `npm run typecheck`、`npm run lint`、`npm run format:check` 通过。
- `npm run test:architecture`：364 模块，main reachable 238；分层和构建图通过。

## 外部验收边界

1. 真实 SFTP/NAS 的连接、断线、权限、吞吐和超时基准；当前自动测试使用受控 I/O 替身，没有读取用户远程设备或网络盘。
2. SFTP 真实后台扫描依赖 profile 使用 agent 或已保存的 OS 加密凭据；`credentialMode=none` 时需要用户先在 Remote Terminal 保存凭据，不会从 UI 临时密码旁路进入 Catalog。

因此 Phase 4 的代码与受控自动化实现已完成；在提供可控 NAS/SFTP 测试端、测试凭据和网络故障场景前，不得标记 `verified`，也不得宣称真实吞吐或断线恢复已验收。
