# Alpha 源码安全检查记录

> 状态：部分实施  
> 更新日期：2026-10-10

公开副本中 Sharp 更新至 0.35.5、Electron 更新至 42.11.12，并更新 brace-expansion、http-cache-semantics、source-map-js 的兼容补丁。保留 Transformers 4.2.0 和 ONNX Runtime 1.24.3，避免在源码公开任务中迁移推理运行时。

Sharp 修复依据为 [官方安全公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)。Electron 采用 [42.11.12 稳定版本](https://github.com/electron/electron/releases/tag/v42.11.12)，覆盖 [沙箱预加载缓存安全修复](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq)。第三方许可文本与 Node 依赖清单随版本更新保留，不表示完成了所有二进制发行许可审核。

本日 `npm audit`（含开发依赖）仍报告 10 条中危、0 条高危、0 条严重告警。这些中危记录来自 sprintf-js 底层公告在多个依赖节点的传播；生产依赖筛选的实际结果以重新执行 `npm audit --omit=dev` 为准，不将告警数量表述为十个独立漏洞。

[sprintf-js 公告](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)尚未列出修复版本。依赖链包含代理日志相关包、ONNX Runtime 和打包工具。本轮没有通过强制升级推理库或切换打包工具主版本来隐藏告警，也没有完成调用链可达性证明。后续需跟进上游修复，或单独验证依赖替换方案。

源码 CI 的依赖门禁检查高危及以上告警。该门禁通过不等于零漏洞，也不代表完成签名、安装器、模型和完整原生许可的正式发行验收。本次只准备 Alpha 公开源码，完整使用与商业授权条件仍待定稿。
