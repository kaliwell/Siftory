# AI Agent 控制接口方案（API Proposal）

> 状态：方案设计（未实施）
> 日期：2026-07-27
> 目标：让外部 AI agent（如 Claude、Kimi CLI、自研 agent 框架）能够通过本地 API 控制本软件的功能。

---

## 1. 现状结论

- 本应用是 Electron 42 + React + TypeScript 的全屏透明置顶浮窗工作台（素材库、图片/视频检索、文件管理、SSH 终端等）。
- 主进程已有约 **230 个 `ipcMain.handle` handler**（`electron/*Ipc.ts`），且 **service 层与 IPC 层已分离**（各 `*Service.ts` 可独立调用）——这是暴露 API 的最大便利。
- **当前没有任何对外控制面**：无 HTTP/WebSocket/net 服务器，无插件机制。唯一外部通道是全局热键和单实例唤起。
- 时钟组件为纯显示，**无计时/提醒功能**；若 agent 需要"N 分钟后提醒我"类能力，需新开发。

因此方案的核心是：**在主进程新增一个本地控制面（control plane），把现有 service 能力按白名单暴露出去**。

---

## 2. 三个候选方案

### 方案 A：本地 HTTP + WebSocket Server（推荐）

在主进程内嵌一个 **仅监听 127.0.0.1** 的 HTTP/WebSocket 服务：

- HTTP：一次性动作（`POST /api/files/search`、`GET /api/settings`）。
- WebSocket 或 SSE：长任务进度推送（扫描/索引/传输进度，对应现有 `on*` 事件通道）。
- 鉴权：首次启动生成随机 token 存于用户数据目录，请求需带 `Authorization: Bearer <token>`；可选关闭。

**优点**：通用性最强，任何语言/框架的 agent 都能调用；调试方便（curl/Postman）；与现有 IPC 结构映射自然。
**缺点**：要自己定义 REST 协议；端口占用需处理。

### 方案 B：MCP Server（stdio，进程外）

单独写一个 **MCP（Model Context Protocol）stdio server 进程**，AI agent 作为 MCP client 启动它；它再通过一个极简本地通道（方案 A 的精简版，或命名管道/Unix socket）转发到主进程。

**优点**：Claude Desktop / Kimi CLI 等主流 agent **零开发直接接入**，工具自动出现在 agent 工具列表；协议自带工具发现（tools/list）。
**缺点**：仍需主进程侧有一个被调用的入口，等于做了两层；调试链路更长。

### 方案 C：MCP Server（主进程内嵌 streamable-http）

Electron 主进程直接以 MCP 的 Streamable HTTP transport 暴露工具，agent 通过 URL 连接（`mcpServers` 配置 `http://127.0.0.1:<port>/mcp`）。

**优点**：只有一层，无额外进程；agent 侧零代码。
**缺点**：依赖支持 HTTP transport 的 agent 客户端；老客户端只支持 stdio。

### 推荐路线

1. **第一阶段做方案 A**（核心控制面 + 鉴权 + 白名单），它本身就是可用的 API。
2. **第二阶段在其上包一层 MCP**（B 或 C），把 REST 端点映射为 MCP tools，获得 agent 生态即插即用。

不建议直接把 230 个 IPC 通道全量映射——应只暴露**白名单子集**。

---

## 3. 建议暴露的功能白名单（第一版）

| 领域 | 端点示例 | 复用的现有代码 |
|---|---|---|
| 窗口控制 | `POST /window/show` `/window/hide` `/window/opacity` `/window/click-through` | `electron/appCoreIpc.ts:169-198`、`main.ts` |
| 设置读写 | `GET/PUT /settings`、`GET/PUT /config` | `appCoreIpc.ts:272-290`、`settingsStore.ts` |
| 剪贴板/系统 | `POST /clipboard`、`POST /open-folder` | `appCoreIpc.ts:148-157` |
| 文件管理 | `GET /files/list` 等 `fm-*` 子集 | `electron/fileManagerIpc.ts` |
| 图片/视频搜索 | `POST /search/image` `/search/media` `/search/semantic` | `imageSearchService.ts`、`mediaSearchIpc.ts`、`vectorIpc.ts` |
| 素材库 | 分类/标签/搜索子集 | `assetLibraryService.ts`（68 通道中选 ~10 个） |
| 任务进度 | `WS /events`（进度/完成推送） | 现有 `on*` 事件通道 |

**明确不暴露（首版）**：远程终端/SFTP（凭据风险）、设置中的破坏性操作、批量重命名/删除类写操作（或要求二次确认参数）。

---

## 4. 需要改动什么（实施清单）

新增：

1. `electron/apiServer.ts` — HTTP/WS server（建议用 Node 原生 `http` + `ws`，避免引入 Express；端口默认如 37210，可配置，冲突自动顺延）。
2. `electron/apiAuth.ts` — token 生成/校验（存 `app.getPath('userData')/api-token`，权限 600）。
3. `electron/apiRoutes/` — 按领域拆分路由，每个路由薄封装，**直接调用现有 `*Service.ts`**，不重写业务逻辑。
4. `electron/apiEvents.ts` — 把现有进度事件转发到 WS 广播。
5. （第二阶段）`mcp-server/` 或主进程内 MCP transport，端点→tools 映射表。

修改：

6. `electron/main.ts:234-273`（`app.whenReady` 初始化序列）— 注册完 IPC 后启动 `apiServer`，`before-quit` 时关闭。
7. `electron/settingsStore.ts` / 设置面板 — 增加 `api.enabled`、`api.port`、`api.requireAuth` 配置项；SettingsPanel 加开关与 token 展示/重置。
8. `tests/` — 新增 `api-server.test.cjs`（路由白名单校验、鉴权、端口冲突）；若改动 IPC/preload 需同步 `tests/ipc-registration.test.cjs`、`preload-contract.test.cjs`（本方案原则上**不动现有 IPC**，这两项应无需改）。
9. `package.json` — 依赖 `ws`（或 `@modelcontextprotocol/sdk`）；新增 `npm run dev:api` 调试脚本。
10. 文档 — 更新 `docs/README.md` 索引，新增 `docs/AI_AGENT_API.md`（端点参考 + agent 接入示例）。

不做：

- 不改动渲染层 React 代码（API 走主进程 service 层）。
- 不监听 0.0.0.0，不支持远程访问（需要时由用户自行 SSH 隧道）。
- 不重写业务逻辑，全部复用现有 service。

---

## 5. 安全要点

- 仅绑定 `127.0.0.1`；启动时校验 `request.socket.remoteAddress`。
- 默认要求 Bearer token；token 文件仅当前用户可读。
- 端点白名单制：未注册的路径一律 404，不做 IPC 通道的动态转发。
- 写操作（删除/重命名/移动文件）首版一律不开放，或要求 `confirm: true` 参数。
- 速率限制：简单计数器防 agent 死循环打爆本地服务。
- 进程退出（`before-quit`）确保关闭 server，避免端口残留。

---

## 6. 工作量估算

- 方案 A 骨架（server + 鉴权 + 窗口/设置/剪贴板 6~8 个端点 + 测试）：约 1~2 天。
- 搜索/素材库端点 + WS 事件：约 1~2 天。
- 方案 B/C MCP 封装：约 0.5~1 天。
