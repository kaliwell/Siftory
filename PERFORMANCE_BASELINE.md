# Performance baseline — 2026-11-07

The local branch was fast-forwarded to GitHub main cb8d4d5 (Alpha23) before measurement. Measurement originally started with a clean worktree. No business changes were made during Phase 0.

## Matched reference used for final comparison

Fresh isolated standard-window development build; three runs; OS caches uncontrolled; empty library and no downloaded AI workload. First paint uses renderer performance.timeOrigin plus FCP.startTime relative to launch epoch. Interactive timing includes navigation automation/frame waits.

| Metric | Original median |
|---|---:|
| Launch to observed window | 974.18 ms |
| Launch to first contentful paint | 1140.00 ms |
| Search navigation interactive | 1239.10 ms |
| Working set at 60 seconds | 432.09 MiB |
| Peak 500ms OS sample, including page churn | 738.97 MiB |
| After 100 switches and 10-second settling | 488.14 MiB |
| Page switch P95, median of three runs | 88.54 ms |

All three runs passed 100 mounted-page switches; no page errors. Working set is summed process-tree RSS, includes development launch wrapper and may double-count shared pages. Peak derives from raw 500ms processes-N.jsonl, not five-second idle summaries. Evidence: artifacts/benchmark/runtime-memory/final-comparison-20261107/before/.

Separate five-minute baseline: both search pages mounted/hidden behind Settings; 60 samples; mean 0.191% of one CPU core. This uses the actual main Electron process tree. Evidence: idle-cpu-comparison-20261107/before/. It must not be mixed with earlier app.getAppMetrics diagnostics.

## Thumbnail baseline

Deterministic 1200×800 JPEGs, quality 90, 64 patterns over 10,000 paths. Generated corpus is not representative real photography. Native/preload first-profile vs repeat pass:

| Images | First-profile pass | Repeat pass | Peak working set |
|---|---:|---:|---:|
| 1,000 | 19.103 s | 2.765 s | 783.29 MiB |
| 5,000 | 95.820 s | 13.046 s | 849.29 MiB |
| 10,000 | 203.925 s | 26.248 s | 862.23 MiB |

This baseline uses two six-item batch callers, not the production queue. Do not compare it directly with the separate production scheduler A/B in PERFORMANCE_REPORT.md. Repeat timing is not an explicit cache-hit counter. Native output counts correct, zero failures; all 10,000 source hashes unchanged.

Evidence: thumbnail-standard-20261107/report.json (1k), thumbnail-standard-v2-20261107/report.json (5k/10k), manifest in artifacts/benchmark/image-fixture-20261107/.

## Earlier observations and failures retained

Existing benchmark plan --scenario=cold-start,ui-churn --runs=3 --cycles=100 passed readiness. Its cold-start entry called the full overlay smoke, which did not produce the ready report within 30 seconds. This was not treated as a startup-performance result; owned processes were stopped and logs retained. A standard-window entry was added using existing nonce safety and OS sampler rather than reimplementing process sampling.

Early standard-window runs reported interactive median 1318 ms and 60-second RSS 431.18 MiB. Their page timing waited for navigation state rather than complete mounted content; they are historical observations, not substituted into the matched final comparison. Earlier app.getAppMetrics polling produced a garbage-collected promise and instrumentation-heavy 0.82% CPU diagnostic. Neither is the matched CPU baseline.

Evidence: performance-plan-20261107.log, performance-baseline-run-20261107.log, standard-window-v3-20261107/run-1.json and standard-window-v4-20261107/run-{2,3}.json. Paths are relative to artifacts/ or artifacts/benchmark/runtime-memory/ as applicable. Raw failures are retained and not counted as passed runs.

True cold-disk startup, representative real-user media and judged text relevance remain uncovered. See PERFORMANCE_TODO.md.


## Real-library baseline and targeted follow-up

See PERFORMANCE_REAL_GALLERY.md for the fixed read-only real dataset (10000 paths, 1.78GiB), three independent baselines at each 1k/5k/10k catalog size, cache/native/browser decode diagnostics and limitations. The measured issue was delayed use of an already populated Renderer cache: warm fast-scroll preview-element readiness was 1.8%, cached-position return 131–138ms. These are not cache hit rates. Full source and encoded-cache hashes were verified across the comparison. Original generated-fixture results above remain separate and are not substituted for real-data measurements.
