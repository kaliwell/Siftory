# DINO / CLIP GPU 构建吞吐异常事件

> 状态：当前
> 更新日期：2026-08-17
> 范围：Embedding GPU 吞吐异常、修复与真实验证
> 替代文档：无

日期：2026-07-31
实施状态：已修复并完成真实 GPU 批处理验证

## 现象

- DINO GPU、CLIP GPU 构建启动慢，运行后吞吐也明显偏低。
- DINO 构建出现大量 `Input buffer contains unsupported image format`。
- 用户设置了 Batch Size，但主进程每次只向子进程发送一张图片。

## 根因

1. 每次构建都会重新逐行扫描 5–8 GiB 的 embedding JSONL，以收集已有 imageId。
2. 全盘扫描命中了扩展名为 PNG、内容却不是图片的缓存文件；失败样本仍进入模型队列。
3. 主进程采用“一任务一派发”，子进程的 80ms 定时器会立即冲刷单项队列，Batch Size 没有形成真实模型批次。
4. Windows GPU 后端是 DirectML；原设置最多创建 18 个独立模型子进程，在 4 GiB 显存设备上造成模型副本、上下文和调度竞争。
5. 每项任务都写诊断事件，放大了长任务的日志 I/O。
6. DINO 批量张量池化没有按 batch offset 取数。

## 修复

- 使用已有 F16/F32 路径索引读取 imageId，只解析源 JSONL 在缓存快照之后追加的尾部；索引不完整时安全回退旧扫描。
- 在任务入队前读取文件头，过滤 JPEG、PNG、GIF、WebP、BMP、TIFF 以外的伪图片，并持久化带 size/mtime 指纹的负缓存。
- 主进程一次派发完整批次，按消息 id 跟踪同一子进程内的多项任务。
- Windows DirectML 默认并发改为 2，且上限为 2；其他 GPU 上限为 4。
- DINO 批量池化按 batch offset 读取，并排除 CLS token。
- CLIP、DINO 子进程都增加 stdin、进程错误、崩溃重启和连续失败停止保护。
- 成功、失败和派发诊断改为采样/批次记录；构建完成事件只允许写入一次。

## 验证证据

- 真实 DINO 已有 ID 快速读取：442,012 个，779 ms；事故前完整 JSONL 扫描约 30,111 ms。
- 真实 CLIP 已有 ID 快速读取：446,845 个，557 ms。
- Windows DirectML 真实批处理（同一 1024×1024 PNG，batch=4）：
  - DINO：4/4 成功，1,983 ms。
  - CLIP：4/4 成功，1,978 ms。
- 新增 6 项回归测试，覆盖伪图片识别、负缓存失效、DINO/CLIP 路径索引加尾部读取、DINO batch offset 和 DirectML 并发/真实批量派发契约。

## 数据影响

本次修复不删除、不迁移用户图片或向量。负缓存是可重建派生数据；无效伪图片会计入 skipped，不再反复进入 GPU 推理。

## 后续修复：显示速度持续下降

2026-07-31 用户复测发现界面速度由 100+/s 逐渐回落到约 50/s。诊断确认这不是 GPU 吞吐同比下降：

- 同一运行后半段每 800 张的真实队列派发吞吐稳定在 19.18–20.08 张/秒。
- RTX 3050 Laptop GPU 保持 P0；诊断时没有 HW/SW Thermal Slowdown。
- 原速度公式把构建前一次性跳过的 30,870 个无效输入计入 finished，并除以包含全盘枚举、预检在内的总耗时，因此初值虚高且必然持续回落。

修复后速度和 ETA 只统计实际进入子进程的 `completed + failed`，计时从模型阶段开始，并排除扫描、预检和暂停时间；新增第 7 项回归测试锁定该统计口径。另对 DINO 输入使用 Sharp 显式解码、旋转、透明背景合成和 RGB 三通道归一化，绕过 Transformers.js 对灰度加 Alpha PNG 的通道转换缺陷；此前运行中的约 3,500 次通道失败可在后续增量构建中正常重试。真实 DirectML 灰度加 Alpha PNG batch=4 复测为 4/4 成功、1,023 ms。
