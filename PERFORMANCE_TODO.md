# Performance TODO — execution status

Reference: GitHub main cb8d4d5, Alpha23; local branch fast-forwarded before measurements. Existing benchmark, process sampler, nonce isolation, native catalog fixture writer and browser tests reused. Four earlier production variables passed combined package/two-hour acceptance. A fifth variable, renderer cached-preview initialization, passed real-gallery A/B; its targeted validation/package is tracked separately.

- [x] Phase 0: architecture and existing test capability audit; process roles; fresh-profile startup/FCP/interactive measurement; 60-second memory; five-minute CPU; multiple pages and 100-switch scenarios.
- [x] Phase 0: deterministic 1,000/5,000/10,000-image fixture; native first/repeat thumbnail and actual Electron gallery measurements; source hashes verified.
- [x] Phase 1: all/search-only/demand preload comparison and alternating confirmation. No stable benefit; original strategy retained.
- [x] Phase 2: remove hidden image/video model polling, retain task/event behavior, verify restoring/unmount cleanup.
- [x] Phase 2: pause invisible/collapsed automatic-maintenance UI polling; preserve local scopes and background completion; dedicated lifecycle browser passed.
- [ ] Phase 2: audit every page's retained subscriptions/objects; durable state restoration and safe idle unmount research remain incomplete. No automatic unloading shipped.
- [x] Phase 3: startup dependency diagram and three-run service-call timing profile completed; FFmpeg synchronous prelude identified.
- [x] Phase 3: FFmpeg yield-only ABBA screening and guarded candidate confirmation; startup improved modestly, cancellation and readiness behavior verified.
- [ ] Phase 3: static import evaluation attribution per module remains incomplete.
- [x] Phase 4: scoped React Profiler confirms hidden polling commits removed.
- [ ] Phase 4: broad Store selector/component rendering audit remains incomplete; no blind memoization.
- [x] Phase 5: production queue single-variable A/B and reverse test; initial coalescing, bounds, priority, cancellation and quality retained; native scrolling tested at all three catalog sizes.
- [x] Phase 5: fixed 10000-image real-library sample (1.78GiB), native 1k/5k/10k catalog A/B, actual cache hit counters, per-image IPC/browser decode profiling, and full source/output hash verification.
- [x] Phase 5: cached previews remain visible during scrolling, no extra IPC; dedicated lifecycle browser and 23 thumbnail unit checks passed.
- [x] Phase 5: the eight sampled BMP decode failures are fixed by the OS-thumbnail fallback; see [BMP 预览解码降级路径](docs/current/2026-11-10-bmp-preview-decode-fallback.md). Occasional pre-card cold-open delay and finer libvips CPU/thread attribution remain open.
- [ ] Phase 5: investigate the occasional pre-card cold-open delay and finer libvips CPU/thread attribution separately.
- [x] Phase 6: eliminate measured redundant model-status invokes; scheduler dedup/cancel tests passed.
- [ ] Phase 6: app-wide IPC frequency/large payload/Worker lifecycle profiling remains incomplete.
- [x] Phase 7: matched three-run startup/memory/100-switch regression, focused workspace and browser, typecheck, scheduler, lifecycle, real read-only DINO checks.
- [x] Phase 7: current Windows candidate generated; covered-source/runtime-package checks and packaged native startup verification passed. PowerShell wrapper stderr issue documented.
- [x] Phase 7: actual 30-minute and two-hour packaged generated-catalog continuous-use acceptance passed; see appended report and acceptance.json. Real-user/model workloads remain uncovered.
- [ ] Text relevance/accuracy benchmark: user currently has no fixed judgment corpus; explicitly uncovered.

Reports: PERFORMANCE_BASELINE.md, PERFORMANCE_ANALYSIS.md, PERFORMANCE_REPORT.md, PERFORMANCE_REGRESSION.md and baseline.json. Unchecked items are not claimed complete.

User latest instruction: DO NOT shut down. Previous conditional shutdown request revoked. No shutdown command or scheduled shutdown is used.


Two-hour retry: sampler budget mismatch repaired and seven regression checks plus packaged coverage smoke passed. The replacement full run completed at 15:09 Asia/Shanghai on 2026-11-07 and passed coverage/exit/source verification. Evidence directory: artifacts/benchmark/runtime-memory/packaged-soak-8EB3Zq/.

- [x] Combined four-variable package: its own 30-minute/two-hour packaged coverage and exit verification passed; see latest acceptance.json and artifact hash.

Combined candidate longevity completed and passed: packaged-soak-s5SEki, 15:42?17:43 Asia/Shanghai on 2026-11-07. It completed 480 operations with 14,301 valid samples and normal exit. Package validation, 41 targeted regressions and focused/browser/lint/build checks passed.

- [x] Real-gallery cached-preview candidate: full validation pipeline, rebuilt local installer and actual packaged 10000-entry native gallery smoke passed; output hashes match the original control. Artifact identity: artifacts/performance-real-gallery-delivery.json. No additional two-hour test was run for this renderer-only change.
