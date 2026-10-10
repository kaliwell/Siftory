# 升级、回滚、数据导出、清理与卸载技术说明

> 适用范围：Phase 6 内部候选包
> 日期：2026-08-12
> 结论：本说明描述当前代码已实现的边界，不代表正式商业发布、签名或许可证审批完成。

## 1. 安装与升级边界

- Windows 安装器使用 NSIS、默认按当前用户安装（`perMachine=false`），允许选择安装目录，不申请提升权限。
- Offline profile 携带 runtime manifest 声明的 DINO/CLIP/多语言文本模型与 FFmpeg 工具；Online profile 排除 `ai-models` 和 `tools`，仅携带安全下载 manifest，运行时按需下载并校验 SHA-256 与许可证状态。
- 两个 profile 使用不同安装器名称，但共享 `appId=com.floating-clock.electron` 和用户数据目录。覆盖安装只替换应用文件，不把用户目录当作安装资源覆盖。
- 自动更新尚未接入。当前升级方式是运行新的内部候选安装器；在更新源、通道、签名主体和回滚包策略确定前，不应宣称后台自动更新可用。

## 2. 启动时数据兼容与迁移

- 设置文件由 `settingsStore.ts` 原子写入；损坏 JSON 会先重命名为带时间戳的 `.corrupted-*` 证据，再使用安全默认值，不原地覆盖损坏证据。
- Asset Library 默认使用 SQLite。旧关系 JSONL 的导入和 `.migrated` 过渡文件仍受兼容与备份覆盖；显式 `jsonl` 模式仍可用于回退测试，未知/退役模式安全回落到 SQLite。
- embedding job 迁移默认 dry-run；只有显式 `--execute` 才原子重写，并保留时间戳备份及归档行。
- 权威向量库迁移默认只生成预览；执行时写入 staging generation，完成完整哈希验证后才原子切换 `CURRENT`。失败不会改动现有 `CURRENT`，旧 generation 之后才作为受控清理候选。
- 上述迁移只操作应用派生数据或元数据，不修改原始图片、视频或远程源文件。

## 3. 回滚与恢复

- 应用二进制回滚：关闭应用后安装上一个已留存的内部候选安装器。由于当前没有自动更新器，应用不会自动下载或切换版本。
- 素材元数据回滚：在“素材库 → 备份”选择已校验备份并二次确认恢复。系统在恢复前强制创建 `pre_restore` 保护备份；SQLite 句柄关闭后，以 staging 文件和恢复 journal 完成一致性替换，然后重新初始化并校验素材库。
- 备份覆盖素材索引、稳定 AssetId 映射、SQLite 关系库、搜索反馈及旧关系过渡文件；派生 catalog/WAL/SHM 会在恢复时清除并重建，避免新旧状态混用。
- 备份导出/导入逐文件验证 SHA-256，拒绝覆盖现有导出目标、路径穿越、无效目录和损坏 manifest。
- 向量迁移失败时继续使用原 `CURRENT`；不要手动改写 `CURRENT` 或 generation manifest。

## 4. 数据导出

- 当前可移植导出面向素材库元数据备份。用户可先“立即备份”，校验后导出到用户选择的空目录；另一台同版本内部候选可导入并再次校验后恢复。
- 删除历史可单独导出报告；原始素材文件不被复制进元数据备份，跨设备恢复前需保证原素材路径可达，或随后使用稳定身份/来源修复流程。
- 整库原始素材归档、远程 SFTP 内容镜像和应用全部设置的一键导出尚不是现有承诺，不能把元数据备份描述成完整文件备份。

## 5. 数据清理

- “清除已处理图片数据”先预览范围，只删除 Image Search 索引、派生缩略图、扫描日志和向量库；模型、Media Search、配置、素材元数据和其他文件保持不变。删除前释放 ANN/语义 worker 与 native 映射，链接/目录联接不得逃逸用户数据根目录。
- `Settings → Data & Reset → Delete generated data by source` 支持选择一个在线盘符根目录或普通文件夹，并按来源路径级联清理图片 Native 索引、DINO/CLIP 向量、缩略图/项目预览、视频清单与帧、转写/OCR/音频 staging、视频语义 SQLite 记录及可重建缓存。专用入口显式允许盘符根目录，既有 Image Search 文件夹编辑器仍拒绝文件系统根目录。
- 按来源清理采用 15 分钟、单次使用的预览 token。执行前再次验证来源目录、索引文件指纹和持久化任务状态；共享图片/视频帧向量分片只进行一次原子重写，失败时回滚已切换文件，成功后清除该事务备份。原始图片、原始视频、模型文件、设置以及人工维护的素材库元数据不属于删除范围。
- 按来源清理只删除能够由规范化来源路径、视频 ID，或“来源路径 + mtime + 缩略图策略版本/尺寸桶”精确复现缓存键的数据。缩略图预览只遍历文件名和时间戳，不读取或修改原素材、不跟随链接，并受文件/目录数量上限保护。离线来源、符号链接范围、正在扫描/抽帧/建向量的数据域和预览后变化的索引会关闭式拒绝；仍无法可靠归属的历史孤立缓存不进行猜测删除。包含命中来源旧副本的共享可重建 generation/cache 会删除并按正常维护流程重建。
- Native 来源记录在持久化逻辑删除后强制物理压实；即使只有一个 segment，只要存在 replaced/deleted overlay 也会重写。旧 mmap 与文件句柄必须先释放，再删除旧段并验证来源计数和 overlay 均为零。若无视频 ID 命中，不得删除视频共享帧向量或统计缓存。
- App Storage 清理使用带过期时间的预览 token、显式选择和执行确认；运行中的数据域会被拒绝，支持取消并报告部分进度。候选只包括已分类的派生缓存、过期恢复快照、旧向量 generation、旧备份和诊断文件。
- Media Search 的 Clear Cache 与 Clear Data 只处理其派生缓存、帧、字幕、manifest 和向量；原视频与稳定素材身份不在删除目录内。
- 任何清理前先完成元数据备份；不应使用资源管理器手动删除 SQLite/WAL、`CURRENT` 或恢复 journal。

## 6. 卸载

- NSIS 显式配置 `deleteAppDataOnUninstall=false`。卸载应用不会删除用户数据、素材元数据备份、索引、模型下载或用户导入的模型槽位。
- 这项保留策略适用于 Online/Offline 两个 profile，并由 `tests/package-profile.test.cjs` 锁定。
- 如用户确需彻底删除数据，应先导出所需元数据，再在应用内清理派生数据；剩余用户目录只能由用户明确选择后手动删除。当前卸载器不会替用户作不可恢复的数据删除决定。

## 7. 自动隔离验收

- `npm.cmd run verify:install-upgrade-recovery` 在系统临时目录创建独立 profile，并依次验证干净安装、旧设置与 JSONL 升级、权威向量 migration 失败回滚、Online/Offline 卸载保留配置和脱敏诊断导出。
- 验收不会读取或修改真实 AppData、素材目录或现有索引；临时根目录在清理前必须同时满足系统临时目录直属子项和 `siftory-install-upgrade-recovery-` 前缀两个边界条件。
- 成功结果写入 `artifacts/install-upgrade-recovery/report.json`，结构版本为 `siftory-install-upgrade-recovery/v1`。报告只记录状态码和布尔保护证据，不包含夹具路径、真实路径、查询或素材内容。
- 该自动矩阵证明代码级数据生命周期约束，不替代真实 Windows 干净机安装、跨版本包升级、真实 NAS/SFTP 断线和人工搜索真值验收。

## 8. 内部候选验收顺序

1. 运行 profile、runtime manifest、按需下载、备份、迁移与清理夹具。
2. 从干净构建生成选定 profile 的 `win-unpacked` 与安装器。
3. 核对 packaged resources 与实际加载 provenance。
4. 对中文和英文分别执行 packaged UI smoke。
5. 执行安装器归档、SBOM、哈希和 release record 门禁。
6. 许可证审批、签名和正式发布记录未完成时，结果只能标记为内部候选。
