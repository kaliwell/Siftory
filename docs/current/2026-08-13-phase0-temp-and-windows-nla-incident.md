# Phase 0 临时目录与 Windows NLA 10108 事件记录

> 状态：当前  
> 更新日期：2026-08-13  
> 范围：Phase 0 基准临时数据、Image Search 扫描边界、Electron 开发启动日志  
> 执行身份：Codex / GPT-5 系列（精确版本未公开）  
> 执行系统与所有者：Codex / Codex/coder  
> 提交状态：未提交现场  
> 替代文档：无

## 1. 当前结论

1. `C:\Users\<user>\AppData\Local\Temp\phase0-corpus-1000k\g9` 是项目 Phase 0 性能基准生成的合成图片语料，不是用户素材，也不是程序运行必需的数据。
2. `g9` 是生成器的分组桶。语料由有效的 1x1 PNG 组成；100 万档会产生大量小文件，因此 Image Search、杀毒软件或 Windows 索引服务可能长时间枚举它们。杀毒软件是否实际扫描该目录在本次没有独立日志证据，不能写成已确认原因。
3. Image Search 的宽范围扫描包含 `C:\` 时，位于 `%TEMP%` 下的 Phase 0 语料也在范围内，会被当作普通图片建立缩略图、索引和向量派生数据。这是本次重复扫描与派生数据膨胀的直接风险。
4. 2026-08-13 已删除受策略管理的遗留 Phase 0 临时目录，并清理误生成的图搜派生数据；最终清理预览为 0 个候选目录、0 字节目标派生数据。用户源文件未被删除。
5. 当前再次读取 `%APPDATA%\floating-clock-electron\floating_clock_settings.json` 时，`imageSearchScanPaths` 仍为 `C:\`。因此本次数据污染已清理，但复发边界尚未关闭；后续正式扫描应改为明确的素材目录或专用盘符，并在应用退出后复核配置是否持久化。
6. `WSALookupServiceBegin failed with: 10108` 来自 Chromium 查询 Windows Network Location Awareness（NLA）命名空间。应用构建和启动均成功，该日志与 Phase 0 临时语料、Image Search 扫描和 Native addon 无关。

## 2. Phase 0 临时目录

### 2.1 来源与结构

`scripts/create-synthetic-corpus.cjs` 默认在系统临时目录创建合成语料：

| 名称                 | 用途                                      | 默认处理              |
| -------------------- | ----------------------------------------- | --------------------- |
| `phase0-corpus-<N>k` | 发现、解码和 Hash 吞吐基准的合成 PNG 语料 | runner 退出时自动清理 |
| `phase0-index-*`     | Native 搜索基准的临时索引                 | 可由专项清理器清理    |
| `phase0-thumbs-*`    | 缩略图基准临时输出                        | 可由专项清理器清理    |
| `phase0-jpeg-subset` | 从仓库测试夹具派生的 JPEG 基准子集        | 可由专项清理器清理    |

生成器用 `g0` 至 `g9` 作为一级分组名，再用 `d00000` 一类目录承载图片。`g9` 只是其中一个分组，不代表第 9 个可执行程序或可疑进程。

### 2.2 为什么会持续扫描

本次确认的路径关系是：

```text
Image Search 扫描根 C:\
└─ Users\<user>\AppData\Local\Temp
   └─ phase0-corpus-1000k
      └─ g9\d*\*.png
```

当扫描根为 `C:\` 时，百万档语料属于其后代目录。正式图搜会发现这些 PNG，并可能生成以下派生数据：

- `%APPDATA%\floating-clock-electron\image-search-index`
- `%APPDATA%\floating-clock-electron\thumbcache`
- `%APPDATA%\floating-clock-electron\vector-db`
- `%APPDATA%\floating-clock-electron\image-search-scan.log*`

本次清理前，上述目标派生数据的预估总量约为 13.61 GiB。此数字只代表可再生缓存和索引，不代表删除了 13.61 GiB 用户源素材。

### 2.3 已实施防护

- `scripts/run-phase0-baseline.cjs` 在成功或失败退出时，默认删除标准 `%TEMP%\phase0-corpus-<N>k` 语料。
- `--keep-corpus` 仅用于明确需要复验时保留标准语料。
- 调用者显式传入 `--corpus-root` 时，runner 永不自动删除该自定义目录。
- `scripts/cleanup-phase0-temp.cjs` 默认只预览；必须显式传入 `--execute` 才删除。
- 清理器只接受系统临时目录的直接子目录和固定名称规则，拒绝目录外目标、符号链接及非目录对象。
- 清理器不枚举或删除普通临时目录，也不使用隐藏窗口、VBS、PowerShell 编码命令或宽泛通配删除。

使用方式：

```powershell
# 只读预览
npm.cmd run cleanup:phase0-temp

# 显式执行
npm.cmd run cleanup:phase0-temp -- --execute
```

不要把整个 `%TEMP%`、用户目录或 `C:\` 作为递归删除目标，也不建议为了避免杀毒软件扫描而给整个临时目录设置白名单。

### 2.4 2026-08-13 处置结果

- 删除 10 个符合策略的遗留 Phase 0 临时目录，包括 100 万档语料。
- 清理误生成的 `image-search-index`、`thumbcache`、`vector-db` 和扫描日志。
- 清理后的 `npm.cmd run cleanup:phase0-temp`：`candidates=0`、`deleted=0`、`refused=0`。
- 派生数据清理最终预览：0 个目标文件、0 字节。
- 设置备份保存在 `%APPDATA%\floating-clock-electron\floating_clock_settings.pre-phase0-cleanup-20260813.json`；SHA-256 为 `9532992FB4104F371B83DE49E19437EF92415DAF7B34D79412B43BA1D7A89FCD`。

## 3. Electron 开发启动日志

### 3.1 正常的多入口构建输出

`npm run dev` 会为 Electron 主进程、preload、GPU preload、多个 Worker 和 Child entry 分别启动 Vite watch build。因此多次出现以下内容是多入口并行构建的正常输出，不是同一个模块无限重启：

```text
watching for file changes...
build started... (xN)
```

本次开发构建最终成功，Native addon `fast_scanner 0.5.29` 也成功加载。

原日志中的 dynamic/static import 混用警告是另一个独立的非致命构建警告。现已统一 `electron/derivedDataResetService.ts` 和 `electron/mediaSearchIpc.ts` 的导入方式，完整 Vite/Electron 多入口构建不再输出这些警告。

### 3.2 `WSALookupServiceBegin 10108`

日志形式：

```text
ERROR:net\base\network_change_notifier_win.cc:200
WSALookupServiceBegin failed with: 10108
```

已确认事实：

- Chromium 的 `network_change_notifier_win.cc` 使用 `WSALookupServiceBegin` 查询 `NS_NLA`；失败时输出上述日志并将连接类型视为未知。
- Microsoft 将 Winsock 错误 10108 定义为 `WSASERVICE_NOT_FOUND`，即指定命名空间中没有已知服务。
- 本机 `Dhcp`、`Dnscache`、`netprofm` 和 `nsi` 正在运行；`NlaSvc` 为 `Manual / Stopped`，`sc.exe queryex NlaSvc` 返回 `WIN32_EXIT_CODE 1077`。
- 非管理员会话尝试启动 `NlaSvc` 时被 Windows 拒绝。本次没有修改服务启动类型、Winsock catalog 或系统网络配置。
- 错误由 Electron 主进程和 Chromium Network Service 输出，与 Phase 0 文件扫描没有调用链关系。

官方依据：

- [Chromium NetworkChangeNotifierWin 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/network_change_notifier_win.cc)
- [Microsoft Windows Sockets 错误码](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2)
- [Microsoft：Querying NLA](https://learn.microsoft.com/en-us/windows/win32/winsock/querying-nla-2)
- [Microsoft：WSALookupServiceBegin](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsalookupservicebegina)

### 3.3 建议处理顺序

用管理员身份打开 PowerShell 或 CMD：

```powershell
sc.exe start NlaSvc
sc.exe query NlaSvc
```

确认状态为 `RUNNING` 后，结束旧的开发进程并重新执行：

```powershell
npm.cmd run dev
```

本步骤尚未在管理员权限下验证，因此当前状态为“诊断完成，系统服务修复待管理员复验”。在复验前不要用以下方式掩盖日志：

- 不要关闭 Electron sandbox 或 Chromium Network Service。
- 不要先执行 `netsh winsock reset` 等全局重置。
- 不要把 NLA 服务改成 Disabled。
- 不要因为该日志重复清理 Image Search 数据；两者无关。

若管理员启动仍失败，再采集 `sc.exe queryex NlaSvc`、Windows 系统事件日志和服务依赖状态，形成新的系统级诊断记录。

## 4. 验证

| 项目                       | 命令                                                                               | 结果                         |
| -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| Phase 0 与派生数据专项测试 | `node --test tests/derived-data-reset.test.cjs tests/phase0-temp-cleanup.test.cjs` | 9/9 通过                     |
| Media Search 联合回归      | 相关 Phase 0、Media Search 与受控播放专项测试                                      | 49/49 通过                   |
| TypeScript                 | `npm.cmd run typecheck`                                                            | 通过                         |
| ESLint                     | 对本次修改文件执行 `eslint`                                                        | 通过                         |
| Prettier                   | 对本次修改文件执行 `prettier --check`                                              | 通过                         |
| Vite/Electron 多入口构建   | `npm.cmd run build:renderer`                                                       | 通过；混合导入警告消失       |
| 临时目录最终预览           | `npm.cmd run cleanup:phase0-temp`                                                  | 通过；0 个候选               |
| NLA 管理员启动             | `sc.exe start NlaSvc`                                                              | 未验证：当前会话无管理员权限 |

## 5. 剩余风险与后续验收

1. 将 `imageSearchScanPaths` 从 `C:\` 收窄到真实素材目录，并在应用正常退出、重新启动后再次读取设置文件，确认没有被驻留进程写回。
2. 以管理员权限启动 `NlaSvc`，重启 Electron 后观察至少 2 分钟，确认不再每秒输出 10108。
3. 后续运行 100 万档 Phase 0 基准时，除非明确需要复验，不使用 `--keep-corpus`。
4. 若临时目录再次出现，先执行只读预览并记录创建时间和父进程，不直接扩大清理范围。

## 6. 变更记录

- 2026-08-13：首次记录临时语料来源、污染链路、安全清理边界、NLA 10108 诊断和待管理员复验项。
