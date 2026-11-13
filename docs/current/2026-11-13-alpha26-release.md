# Siftory 1.0.1-alpha.26

> 状态：当前

Windows x64 在线 Alpha，合并开发验证流程精简与 Indexing 界面响应优化。

- 工程预览提取、PDF 渲染和图像计算进入 Worker；Manifest 分批保存、分块传输并在 Worker 内排序和写入。
- 目录流式扫描、异步检查来源，进度通知合并；Renderer 低优先级处理重复进度，终态即时处理。
- 取消后不再迟到写索引；离线目录和权限失败不误清理。
- 普通 push 不跑全量验证，提交不强制 AI 元数据；验证入口统一并记录耗时，历史实验归档。

原始素材和原生索引格式不变。派生 Manifest 每 32 次修改保存一次，正常结束/取消会补齐；异常退出的未保存尾部可能需要重建。

本次为未签名在线 Alpha，不捆绑 AI 模型。检查实际结果见附件 validation-status.json 和 startup-check.json。隔离启动、AI/PDF 预览 Worker 和归档检查不等同于真实大图库建库、Windows 拖动、覆盖升级或 GPU 验收。旧版 UI 矩阵结果单列，不能据此宣称全部业务验证通过。升级前请按 BACKUP_SAFETY.md 备份。
