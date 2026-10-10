# 多显示器、AI 控制 API 与主题系统优化方案

> 状态：已完成（VAL-017、VAL-018、VAL-019 均已实现并验证）<br>
> 日期：2026-08-09<br>
> 范围：Electron 窗口系统、受控自动化接口、全局视觉主题<br>
> 对应任务：VAL-017、VAL-018、VAL-019

## 1. 目标与执行顺序

按用户提出的顺序推进：

1. `VAL-017`：让透明工作区和面板正确使用多个显示器，不再被主屏幕边界限制。
2. `VAL-018`：建立默认关闭、仅本机、能力白名单化的 AI 控制 API，并提供规则和使用说明。
3. `VAL-019`：扩展现有主题系统，提供柔和、硬朗、中性以及深色、浅色组合。

三项互不依赖，可独立回滚。实施不能影响正在运行的 DINO/CLIP 重建、真实用户数据或发布许可证状态。

## 2. VAL-017：多显示器工作区

### 2.1 当前限制

- `electron/main.ts` 使用 `screen.getPrimaryDisplay()` 创建唯一的透明全屏 `BrowserWindow`。
- 分辨率变化后仍强制回到主显示器的 `workArea`。
- `get-work-area` 只返回主屏幕宽高，没有显示器 ID、全局坐标、缩放比例或旋转信息。
- Renderer 的面板拖动把坐标限制在 `0..workArea.width/height`，因此无法越过当前透明窗口。

这不是单纯放宽拖动数值即可解决的问题：Windows 多屏可能有负坐标、不同 DPI、不同任务栏工作区，单个主屏透明窗口之外也接收不到鼠标事件。

### 2.2 分阶段方案

#### P0：显示器选择与整工作区迁移

- 用 `screen.getAllDisplays()` 建立显示器清单，记录 `display.id`、bounds、workArea、scaleFactor、rotation 和主屏标记。
- Settings 增加“当前显示器 / 上一个 / 下一个 / 跟随鼠标所在显示器”。
- 主窗口迁移到目标显示器的 `workArea`；面板保持显示器内的相对位置。
- 监听 `display-added`、`display-removed`、`display-metrics-changed`，拔掉屏幕后把不可见面板安全迁回最近可用显示器。

#### P1：每显示器透明工作区

- 每个已启用显示器创建一个透明 overlay `BrowserWindow`，而不是创建跨整个虚拟桌面的巨型窗口。
- 主进程维护窗口注册表和共享布局；每个 Renderer 只渲染分配给该显示器的面板。
- 拖动到显示器边缘时签发 panel-transfer token，在目标窗口恢复组件类型、大小、停靠关系和局部坐标。
- 全局唯一的任务、搜索、数据库和模型服务继续留在主进程；多个窗口不能重复启动扫描或写入任务。

#### P2：布局与热插拔

- 用显示器特征（设备 ID/尺寸/缩放/相对位置）保存布局，不能只保存易变化的数组下标。
- 支持“仅主屏”“全部屏幕”“指定屏幕集合”三种策略。
- DPI 改变后按 CSS 像素重算并限制到目标 workArea，保证标题栏始终可恢复。

### 2.3 验收

- 覆盖主屏左侧负坐标、副屏上方、100%/125%/150% 混合 DPI、横竖屏和任务栏不同边缘。
- 面板能跨屏迁移，重启后恢复；拔掉副屏后没有窗口或面板永久丢失。
- 每个窗口的 Shape、点击穿透、置顶、显示/隐藏和退出握手独立正确。
- 同一后台任务在多窗口只运行一次，进度在全部窗口一致。
- 增加多显示器坐标单测及模拟 workArea 的双语 UI E2E；真实双屏至少人工验收一次。

## 3. VAL-018：AI 控制 API

### 3.1 边界

不能把现有约 230 个 IPC 直接映射为外部 API。首版建立独立 capability registry，只允许经过显式审查的稳定 service 方法。API 默认关闭，不监听局域网，不允许任意代码、任意 IPC、任意 shell 或未授权文件路径。

### 3.2 传输与鉴权

- HTTP/JSON + Server-Sent Events 或 WebSocket，仅监听 `127.0.0.1`/`::1`。
- `/v1` 版本前缀；启动时端口冲突安全失败，不自动改为公网地址。
- 首次启用生成至少 256 bit 随机 bearer token；token 使用 Electron `safeStorage` 加密保存，只在创建/轮换时显示明文。
- 设置页提供启用、禁用、端口、token 轮换、撤销全部会话、查看审计记录和复制连接示例。
- 拒绝非 loopback 连接、无效 `Host`/`Origin`、超限请求体、过快请求和未知 content type。

### 3.3 能力规则

每个能力必须登记：

```text
id / version / description
inputSchema / outputSchema
risk: read | write | destructive
requiredScopes
timeout / concurrency / cancellation
pathPolicy / auditRedaction
idempotency support
```

规则如下：

1. `read`：状态、能力清单、只读搜索和任务进度可直接执行，但仍需 token 和 scope。
2. `write`：启动扫描、生成索引、修改设置等要求独立 scope、结构校验、并发锁和 idempotency key。
3. `destructive`：首版默认不暴露。以后必须采用 `preview -> confirm token -> execute` 两阶段协议；token 绑定调用方、参数摘要、过期时间和数据版本。
4. 文件路径：优先使用应用签发的 opaque selection token、assetId、videoId 或已授权根目录；不接受未经约束的任意绝对路径。
5. 长任务：返回 `jobId`，通过 `/v1/jobs/{id}` 查询，通过事件流订阅；取消必须复用现有正式取消语义。
6. 输出：错误码稳定、消息可本地化；不得回传凭据、完整隐私路径、token、模型密钥或未脱敏日志。
7. 审计：记录时间、能力 ID、结果、耗时和脱敏参数摘要；有大小/天数上限，不记录 bearer token。

### 3.4 首版白名单

- `system.health`、`system.capabilities`、`system.version`
- `window.show`、`window.hide`、`window.listDisplays`、`window.selectDisplay`
- `imageSearch.status`、`imageSearch.search`、`imageSearch.stop`
- `mediaSearch.status`、`mediaSearch.search`
- `assetLibrary.stats`、`assetLibrary.search`
- `jobs.get`、`jobs.cancel`、`events.subscribe`

文件删除、数据清理、许可证接受、远程终端凭据、任意 SSH 命令、任意文件写入和发布签名不进入首版。

### 3.5 AI 使用方法

1. 用户在 Settings → AI Control 中显式启用，并创建限定 scope 的 token。
2. AI 先调用 `GET /v1/capabilities`，只能使用返回的能力和 JSON Schema，不能猜测端点。
3. 调用长任务后保存 `jobId`，轮询或订阅事件，不能用重复提交代替查询。
4. 遇到 `confirmation_required` 时向用户展示 API 返回的预览；没有用户确认就停止。
5. token 可以随时撤销；禁用 AI Control 后监听器、活动连接和未提交确认 token 全部失效。

示例协议（端点在实现前不视为有效接口）：

```http
GET /v1/capabilities
Authorization: Bearer <token>

POST /v1/actions/imageSearch.search
Authorization: Bearer <token>
Content-Type: application/json

{"text":"夜晚城市","topK":20}
```

### 3.6 MCP 与验收

- HTTP API 稳定后再提供 MCP adapter；MCP tool 只能机械映射 capability registry，不能形成第二套权限模型。
- 提供 OpenAPI/JSON Schema、curl/PowerShell/Node 示例和 AI system prompt 模板。
- 测试未授权、越权 scope、路径逃逸、重放、超限、并发、取消、端口冲突、token 轮换、禁用清理和日志脱敏。
- packaged smoke 验证默认没有监听端口，启用后也只监听 loopback。

### 3.7 完成记录（2026-08-09）

- scope 已绑定当前 token，并在 capability 调用前强制校验；设置页可选择 `read/window/search/control`，轮换 token 后生效。
- `imageSearch.search` 已接入现有 CLIP 向量库，返回不透明哈希 ID、排名和分数，不返回本机路径。
- 图片/媒体长搜索使用 `AbortController` 和批次检查实现运行中协作取消；禁用服务也会触发取消。
- 所有 write capability 要求 `Idempotency-Key`，并先返回 `428 confirmation_required` 脱敏预览；只有用户在 Settings 中批准绑定请求的一次性确认 ID 后才能重试。
- `GET /v1/openapi.json` 按 token scope 生成 OpenAPI 3.1；Settings 可查看最近审计记录。
- 单元测试覆盖 scope、schema、确认、脱敏、OpenAPI；开发态和打包态 smoke 覆盖默认关闭、鉴权、loopback、OpenAPI 和任务执行。
- 第二轮强化完成 token 会话隔离、任务/幂等/确认 TTL 与有界回收、载荷冲突检测、SSE 心跳/慢客户端保护和 HTTP 超时。
- 审计落盘改为串行异步队列；Windows 轮换会先替换旧备份，损坏 JSONL 行按条隔离而不丢弃全部历史。

## 4. VAL-019：主题和配色系统

### 4.1 当前基础

现有 `themeIdx` 和 `themes.css` 已提供 Matrix、Midnight、Amber、Frost、Rose、Mono 六套主题，但只有少量 `--bg/--fg/--date` token，部分组件仍有硬编码颜色，主题、明暗模式和材质风格耦合在一个数字索引中。

### 4.2 新结构

- 把持久化设置从数字升级为稳定 `themeId`，保留旧 `0..5` 到新 ID 的兼容迁移。
- 拆分 `palette`、`mode`、`material`、`density`；主题切换不改变窗口布局和业务设置。
- 使用语义 token：canvas、surface、surfaceElevated、text、textMuted、border、accent、focus、success、warning、danger、selection、shadow。
- 支持 `system/light/dark` 模式、减少动态效果和高对比度；跟随系统时监听 Electron native theme。

### 4.3 预设方向

任何用户都可自由选择，不根据性别自动推断：

- 柔和（女生向可选）：Pearl Rose Light、Lilac Mist Light、Rose Night、Violet Night。
- 硬朗（男生向可选）：Steel Light、Graphite Dark、Deep Ocean、Forest Night。
- 中性：Paper Light、Slate Dark、System Auto、High Contrast。

“女生向/男生向”只作为可选风格提示，正式主题名使用颜色和材质描述，避免把用户限制在性别标签中。

### 4.4 UI 与验收

- Settings 提供分组预览卡、即时预览、应用、取消、恢复默认和跟随系统。
- 时钟、所有面板、菜单、输入框、表格、图表、终端外壳、空状态、进度和错误状态统一使用 token。
- 正文和关键控件按 WCAG AA 对比度验收；焦点环不能只靠颜色区分。
- 每套主题执行中英文、100%/150% DPI、常用面板 screenshot E2E；禁止用大量逐组件例外覆盖主题。
- 主题变更只写设置文件，不触碰索引、素材库或搜索数据。

## 5. 自动 TODO 边界

- 三项状态初始为 `pending`，由 `todo:value-next` 按价值选择；当前排序为多显示器 → AI API → 主题。
- 自动实现仍必须使用独立分支、测试和提交；不能因为是 `auto` 就绕过 AI API 的安全门禁。
- 正在运行的 VAL-003 观察流程与这三项没有依赖关系，后台观察可以继续。
