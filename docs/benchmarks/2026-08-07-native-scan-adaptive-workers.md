# Native 扫描自适应并发基准

日期：2026-08-07
任务：`VAL-012`
范围：临时 JPEG 硬链接夹具；未读取、写入或删除真实用户图片与索引

## 结论

Native 扫描从固定 2 worker/64 路径队列改为扫描开始时选择 2–8 worker，并按每 worker 32 个路径把有界队列扩展到 64–256。当前 i7-12700H（20 逻辑处理器、15.6 GiB 内存）在其他应用占用下选择 4 worker/128 队列，固定 512 张 JPEG 基准提升 1.875 倍，双哈希摘要完全一致。

| 策略     | Worker / 队列 |    中位耗时 |     中位吞吐 | 相对固定 2 worker |
| -------- | ------------: | ----------: | -----------: | ----------------: |
| 固定基线 |        2 / 64 | 5,989.51 ms |  85.48 张/秒 |            1.000× |
| 自适应   |       4 / 128 | 3,194.15 ms | 160.29 张/秒 |            1.875× |

三轮固定基线分别为 84.07、86.55、85.48 张/秒；三轮自适应分别为 160.29、160.77、158.94 张/秒。两组都生成 512 条记录，排序后的 `diffHash64:dctHash64` SHA-256 摘要均为 `b278a3949cf5cb4d039ccf0b5ecc2eb7c75f2875599910adc6dd29a81986165a`。

## 策略与安全边界

- CPU 目标为 `ceil(logicalProcessors / 4)`，限制在 2–8。
- 总内存低于 6/10/14 GiB 时分别限制为 2/3/4 worker。
- 扫描开始时可用内存低于 2/4/6 GiB 时分别限制为 2/3/4 worker。
- 队列容量为 `workerCount × 32`，限制在 64–256，仍保持严格有界和生产者背压。
- `REASONIX_NATIVE_SCAN_WORKERS=2..8` 只用于确定性基准，仍受内存上限约束。
- Stop/Pause、单 writer、环境清理、图片尺寸和 256 MiB 单图解码预算保持不变。
- 状态栏在扫描期间显示 active/total worker 和 pending/capacity 队列，便于识别 CPU 或枚举瓶颈。

## 夹具与验证

基准在系统临时目录生成一张 2048×1365 JPEG，再创建 511 个同卷硬链接；关闭 Native thumbs，按固定 2、自适应交错运行并取三轮中位数。每轮只使用内存索引，结束后清空索引并删除独占临时目录。

- `npm.cmd run benchmark:native-scan-workers`：1.875×，哈希摘要一致。
- `npm.cmd run test:native`：65/65 通过。
- `npm.cmd run test:runtime-manifest`：12/12 通过，清单结构通过。
- `npm.cmd run test:i18n-static`：7/7 通过，0 grandfathered。
- `npm.cmd run typecheck`、`npm.cmd run lint`：通过。
- Node 与 Electron ABI 原生构建均通过；FastScanner 版本更新为 0.5.25。
