# FloatingClock 文档结构迁移记录

> 状态：历史记录  
> 日期：2026-07-12  
> 范围：`docs/`

## 目标

解决旧文档目录中的以下问题：

1. 中文、英文、下划线和连字符混用。
2. 日期位于文件名开头、结尾或完全缺失。
3. 当前状态、历史审计、功能方案和交接文件混放在根目录。
4. Media Search 方案文件名为 v1.1.2，但正文已经更新到 v1.1.3。
5. 多份全量审计并存，但没有统一入口说明优先级。

## 新结构

```text
docs/
  README.md
  current/
  audits/
  designs/
  handoffs/
  history/
  product/
  reference/
  benchmark/
```

## 主要迁移映射

| 旧名称 | 新位置 |
| --- | --- |
| `FloatingClock-优化进度交接-2026-07-10.md` | `current/2026-07-12-optimization-handoff.md` |
| `FloatingClock-项目优化方向审计-2026-07-11.md` | `current/2026-07-11-project-optimization-audit.md` |
| `FloatingClock-项目全量审计-2026-07-05.md` | `audits/2026-07-05-project-full-audit.md` |
| `FloatingClock-项目全量多角度审计-2026-07-09.md` | `audits/2026-07-09-project-multidimensional-audit.md` |
| `FloatingClock-项目多角度审计-2026-07-10-当前状态.md` | `audits/2026-07-10-project-current-state-audit.md` |
| `FloatingClock-MediaSearch-新增功能独立方案-v1.1.2-复用审计.md` | `designs/2026-07-02-media-search-plan-v1.1.3.md` |
| `NekoSearch-智能素材分类新增功能方案-项目适配-2026-07-09.md` | `designs/2026-07-09-neko-search-classification-plan.md` |
| `ImageSearch重构方案-终版.md` | `designs/image-search-rearchitecture.md` |
| `20260626新功能.txt` | `history/2026-06-26-image-search-vector-requirements.md` |
| `floating_clock_electron_问题总结.md` | `history/project-progress-and-audit-log.md` |
| `ipc-capability-matrix.md` | `reference/ipc-capability-matrix.md` |
| `native-build-artifacts.md` | `reference/native-build-artifacts.md` |

其余 Image Search、Remote Terminal、App Storage、安全和性能文档按相同规则移入对应目录。仓库内旧路径引用已同步替换。

## 格式变化

1. 新增 `docs/README.md` 作为唯一入口和当前基线索引。
2. 新增 `reference/documentation-standard.md`，统一状态、命名、章节和验证格式。
3. 当前审计与当前交接补充状态、基线日期、最后更新日期和互相链接。
4. Benchmark 人工报告统一日期命名；脚本生成的原始 JSON/JSONL 保持原名。
5. 历史文档保留原文，不通过重写历史来制造当前状态一致性。

## 验证

- 根目录零散文档：`0`，仅保留 `README.md`。
- 分类目录：`8`。
- 迁移文档：`28` 份人工文档，另规范化 1 份 Benchmark 报告名称。
- 更新旧路径引用：`11` 个文件、`29` 组引用。
- 失效相对 Markdown 链接：`0`。
