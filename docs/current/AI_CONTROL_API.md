# AI Control API 使用与安全规则

> 状态：当前
> 更新日期：2026-08-18
> 范围：本机 AI Control API 能力、授权与安全边界
> 替代文档：无

实施状态：VAL-018 完整实现。本功能默认关闭，只监听 `127.0.0.1`，不会接受局域网或公网连接。

## 自动完整化 TODO

- [x] AI-01：token scope 持久化、轮换和服务端强制校验。
- [x] AI-02：现有 CLIP 数据库的安全图片语义搜索 capability。
- [x] AI-03：运行中任务协作取消和服务禁用清理。
- [x] AI-04：write capability 幂等键及显式用户确认协议。
- [x] AI-05：按 token scope 生成 OpenAPI 3.1。
- [x] AI-06：设置页 scope 管理、一次性 token、审计查看。
- [x] AI-07：策略单测、真实 HTTP smoke、打包态 smoke 和文档同步。
- [x] AI-08：Settings 人工批准的一次性确认 ID，绑定 capability、输入和幂等键。
- [x] AI-09：token 轮换与服务禁用时清空旧任务、确认和幂等会话。
- [x] AI-10：任务、幂等记录和确认队列增加 TTL、有界回收及载荷冲突检测。
- [x] AI-11：SSE 心跳、慢客户端回收和 HTTP 请求/头/keep-alive 超时。
- [x] AI-12：审计日志改为串行异步写入、容错读取和 Windows 安全轮换。
- [x] AI-13：第二轮单测、真实 HTTP、真实语义搜索、UI 与打包态完整验收。
- [x] AI-14：按需查询已登记本地数据源的文件夹大小，使用不透明数据源 ID 和相对路径，支持取消、边界限制与链接隔离。
- [x] AI-15：按需搜索已登记来源中的大文件，返回有界 Top-N、相对位置和保守清理分级；不开放删除能力。
- [x] AI-16：新增一次调用的 `storage.largeFiles`，自动发现本机磁盘或常用范围并完成大文件扫描、汇总与清理风险分类，不再要求预先登记数据源。
- [x] AI-17：`mediaSearch.status` 等待 FFmpeg/FFprobe 异步发现完成，避免首次 API 快照把已安装工具误报为缺失。
- [x] AI-18：CLIP 下载、状态和打包校验覆盖文本塔及全部运行依赖；图片与视频文本搜索完成真实 HTTP API 验收。

## 启用

1. 打开 Settings → AI Control。
2. 保持默认端口 `32145`，点击“启用”。
3. 选择 token 的 `read`、`window`、`search`、`control` scope；`read` 是基础 scope，不能关闭。
4. 保存仅显示一次的 256-bit bearer token。软件只持久化经 Electron `safeStorage` 加密后的密文及 scope，不保存明文。
5. scope 调整在“轮换令牌”后生效，旧 token 立即失效。点击“禁用”会关闭监听器、事件流并请求取消正在执行的长任务。

设置页显示的地址应为 `http://127.0.0.1:32145/v1`。端口冲突时启用会安全失败，不会改为监听公网地址。

## AI 调用规则

AI 或自动化客户端必须遵守以下顺序：

1. 调用 `GET /v1/capabilities`，只使用返回的 capability ID、schema 和 scope。
2. 通过 `POST /v1/actions/{capabilityId}` 提交 JSON；不要猜测未列出的端点。
3. 保存返回的 `jobId`，通过 `GET /v1/jobs/{jobId}` 查询；不要通过重复提交代替查询。
4. 可使用 `GET /v1/events` 订阅 SSE 任务事件。
5. 每次写操作携带唯一 `Idempotency-Key`。重放相同 key 会返回原 job。
6. 写操作首次调用会返回 HTTP `428 confirmation_required`、脱敏预览及随机确认 ID。用户必须在 Settings → AI Control 点击“仅批准本次”；随后 AI 才能用 `X-Reasonix-Confirm: <confirmationId>` 原样重试。确认与 capability、完整输入、幂等键、当前 token 会话绑定，5 分钟后失效且成功使用后立即消费。
7. `GET /v1/openapi.json` 返回与当前 token scope 一致的 OpenAPI 3.1 文档。
8. 不要求用户提供本机绝对路径、凭据、SSH 命令或删除确认。全机大文件查询直接调用 `storage.largeFiles`；只有精确查询已登记来源时，才使用 `folder.sources` 返回的 `sourceId` 和来源内部相对路径。
9. API 返回的路径、命令、token、secret 和 credential 字段会统一脱敏。

所有请求必须携带：

```http
Authorization: Bearer <token>
```

PowerShell 示例：

```powershell
$headers = @{ Authorization = "Bearer $env:REASONIX_AI_TOKEN" }
Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:32145/v1/capabilities'
Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:32145/v1/openapi.json'

$body = @{ text = '夜晚城市'; topK = 20 } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
  'Idempotency-Key' = [guid]::NewGuid().ToString()
}) -Body $body -Uri 'http://127.0.0.1:32145/v1/actions/mediaSearch.search'

Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:32145/v1/jobs/$($job.jobId)"

# 图片语义搜索使用现有 CLIP 数据库；结果只含不透明哈希 ID、排名和分数，不含本机路径。
$imageJob = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
}) -Body $body -Uri 'http://127.0.0.1:32145/v1/actions/imageSearch.search'

# 一次调用自动发现本机可访问磁盘并查找大文件；无需先添加数据源或手动选择盘符。
$computerLargeBody = @{
  scope = 'computer'
  rootId = 'drive-c' # 可省略；省略后扫描全部自动发现的磁盘。
  minBytes = 1073741824
  topN = 100
  maxEntries = 5000000 # 可选；默认 2,000,000，最高 5,000,000。
  olderThanDays = 30
  assessment = 'all'
} | ConvertTo-Json
$computerLargeJob = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
}) -Body $computerLargeBody -Uri 'http://127.0.0.1:32145/v1/actions/storage.largeFiles'
do {
  Start-Sleep -Milliseconds 500
  $computerLargeResult = Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:32145/v1/jobs/$($computerLargeJob.jobId)"
} while ($computerLargeResult.state -in @('queued', 'running'))
$computerLargeResult.result

# 查询已登记的本地来源；结果只有 ID、名称、类型和在线状态，不含磁盘路径。
$sourceJob = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
}) -Body '{}' -Uri 'http://127.0.0.1:32145/v1/actions/folder.sources'
do {
  Start-Sleep -Milliseconds 100
  $sourceResult = Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:32145/v1/jobs/$($sourceJob.jobId)"
} while ($sourceResult.state -in @('queued', 'running'))
if ($sourceResult.state -ne 'succeeded' -or $sourceResult.result.sources.Count -eq 0) {
  throw 'No registered local folder source is available.'
}

# 使用来源 ID 查询根目录，或把 relativePath 改为该来源内的子目录。
$folderBody = @{
  sourceId = $sourceResult.result.sources[0].sourceId
  relativePath = ''
} | ConvertTo-Json
$folderJob = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
}) -Body $folderBody -Uri 'http://127.0.0.1:32145/v1/actions/folder.stats'
do {
  Start-Sleep -Milliseconds 250
  $folderResult = Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:32145/v1/jobs/$($folderJob.jobId)"
} while ($folderResult.state -in @('queued', 'running'))
$folderResult

# 查找来源中大于等于 1 GiB 的 100 个最大文件，并返回保守清理建议。
$largeBody = @{
  sourceId = $sourceResult.result.sources[0].sourceId
  relativePath = ''
  minBytes = 1073741824
  topN = 100
  olderThanDays = 30
  assessment = 'all'
} | ConvertTo-Json
$largeJob = Invoke-RestMethod -Method Post -Headers ($headers + @{
  'Content-Type' = 'application/json'
}) -Body $largeBody -Uri 'http://127.0.0.1:32145/v1/actions/folder.largeFiles'
do {
  Start-Sleep -Milliseconds 250
  $largeResult = Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:32145/v1/jobs/$($largeJob.jobId)"
} while ($largeResult.state -in @('queued', 'running'))
$largeResult.result.items
```

## 首版能力

- 系统：`system.health`、`system.capabilities`、`system.version`
- 窗口：`window.show`、`window.hide`、`window.listDisplays`、`window.selectDisplay`
- 图片搜索：`imageSearch.status`、`imageSearch.search`、`imageSearch.stop`
- 媒体搜索：`mediaSearch.status`、`mediaSearch.search`
- 文件夹与磁盘分析：`storage.largeFiles`、`folder.sources`、`folder.stats`、`folder.largeFiles`
- 素材库：`assetLibrary.stats`、`assetLibrary.search`
- 任务：`jobs.get`、`jobs.cancel`，以及 `/v1/events`

模型和媒体运行时的完整性修复、失败恢复与真实 API 数据见[2026-08-18 AI Control API 模型与媒体运行时完整性修复](2026-08-18-ai-control-runtime-readiness.md)。`mediaSearch.status` 会先完成有界的 FFmpeg/FFprobe 探测再返回；CLIP 只有在图像塔、文本塔和 tokenizer/config 全部通过固定哈希校验后才报告为已下载。

能力注册表声明版本、风险等级、scope、输入/输出 schema、超时、并发、取消、路径策略、确认和幂等要求。每个 capability 同时只允许一个执行实例；请求体最大 64 KiB；单个 loopback 客户端每分钟最多 120 次请求。任务最多保留 200 条并在结束 30 分钟后过期；幂等记录同步过期，同一个键换用不同载荷会返回 `409 idempotency_conflict`。确认队列最多 50 条。图片和媒体语义搜索使用协作取消；`POST /v1/jobs/{jobId}?action=cancel` 会中断后续向量批次。

`folder.stats` 是按需执行的只读任务，只统计逻辑文件字节数，不修改文件，也不把绝对路径写入响应或审计。它仅支持已登记的 `local-ntfs`、`local-generic`、`removable` 和 `mounted-network` 来源；SFTP/NAS Agent 不会被伪装成本机目录。子目录必须是来源内部的相对路径，解析后越界会失败；符号链接和目录联接不会被跟随。任务最多扫描 2,000,000 个条目、最长运行 5 分钟，可经 jobs cancel 中止。遇到权限错误或条目上限时返回 `complete: false` 与 `partialReason`，避免把部分大小误报为完整结果。

`storage.largeFiles` 是面向自动化的单次调用入口。`scope: 'computer'` 会在内部发现当前可访问的磁盘根目录并逐盘扫描；可选的 `rootId: 'drive-c'` 能只扫描自动发现的 C 盘，不接受 `C:\\` 一类绝对路径。`user`、`downloads`、`temporary` 可用于更快地限制到用户目录、下载目录或临时目录。调用方不需要先登记数据源或提交绝对路径。默认阈值为 1 GiB、返回 100 项，`topN` 最多 200；每个根目录默认最多扫描 2,000,000 个条目，必要时可通过 `maxEntries` 提高到 5,000,000。全机任务最长 30 分钟并支持 jobs cancel，符号链接和目录联接仍会隔离。响应用 `rootId`、`rootLabel` 和根目录内部的 `relativeFile` 定位结果，不返回绝对路径；多个磁盘的候选会统一按大小排序后截取全局 Top-N。磁盘不可访问、目录无权限或达到条目上限时返回 `complete: false`、`partialReason` 和逐根目录状态，调用方不得把部分结果描述成完整磁盘清单。

`folder.largeFiles` 复用相同的已登记来源、路径边界、链接隔离、2,000,000 条目上限、5 分钟超时和协作取消。它默认搜索不小于 1 GiB 的文件并最多返回 100 项，可配置 `minBytes`（至少 1 MiB）、`topN`（最多 200）、`olderThanDays` 和 `assessment`。响应不含绝对路径，只返回来源 ID、文件名和来源内部的 `relativeFile`，方便用户在已知来源中定位。

清理分级是保守启发式判断，不是删除授权：

- `low-risk`：超过所选天数的缓存或临时文件；仍需先关闭占用它的程序并人工确认。
- `review`：下载的旧安装包/压缩包、近期缓存或普通大型用户文件；不能仅凭大小删除。
- `protected`：Windows、Program Files、ProgramData、分页/休眠文件和回收站内部内容；不得直接删除，应使用 Windows 存储、卸载、休眠或回收站入口处理。

`assessments` 汇总所有达到阈值文件的数量和字节数，`assessment: 'low-risk'` 可只返回低风险候选。即使结果属于 `low-risk`，API 仍然只有读取能力，不能删除、移动或清空文件。

AI-15/AI-16 架构复审：为避免继续扩大 AI HTTP 路由和通用目录统计模块，大文件 Top-N、自动根目录发现与清理判定保留在同一个只读服务。主进程精确可达模块预算仍为 274，没有因一次调用入口继续放宽；其余入口预算未放宽，后续再增加模块仍会触发架构门禁。

## 明确不开放

文件删除、索引清理、素材归档、许可证接受、远程终端凭据、任意 SSH/PowerShell、任意文件写入、构建发布和签名均未开放。大文件分析返回的分级不能替代用户确认，也不会自动生成删除操作。现有 Electron IPC 也不会被自动映射为 HTTP API。

审计只记录时间、capability ID、结果、耗时、request ID 和输入字段名，不记录 bearer token 或输入值。设置页可查看最近 20 条记录；日志通过串行异步队列写入应用用户数据目录，超过 1 MiB 时安全替换上一份轮换文件，单条损坏记录不会阻止其余记录加载。

## 提供给 AI 的系统提示模板

```text
你只能调用 Reasonix AI Control API 的 GET /v1/capabilities 返回的能力。
先读取 schema，再构造参数；不得猜测端点或请求本机绝对路径。
提交动作后保存 jobId 并轮询 /v1/jobs/{jobId}。
写操作必须使用新的 Idempotency-Key。
写操作收到 confirmation_required 后，必须等待用户在 Settings → AI Control 批准；只有 UI 显示已批准，才可带返回的一次性 confirmation ID 原样重试。不得自行构造或批准确认 ID。
遇到 capability_not_found、invalid_input、unauthorized 或 rate_limited 时停止并报告，不能绕过限制。
API 未提供 destructive 能力；不得尝试通过其他能力实现删除、清理、凭据读取或任意命令执行。
```
