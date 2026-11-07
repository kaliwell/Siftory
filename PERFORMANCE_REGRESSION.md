# Functional and performance regression — 2026-11-07

## Passed

- Typecheck after final formatting.
- Targeted production ESLint.
- Focused workspace: 184 tests.
- Focused workspace browser: migration, persistence, retained query, lazy route, failure/retry, readiness dedup, hidden progress, visibility/clipboard and restore scenarios; no page errors.
- Model/readiness unit suite: seven tests.
- Core unified search unit suite: 80 tests.
- Thumbnail scheduler suite: five tests, including initial 24ms coalescing, serial immediate draining, deduplication and cancellation.
- Strengthened model lifecycle browser: hidden events and explicit refresh preserved, reopening refreshes, only one foreground interval, no polling after unmount, subscription cleanup, no page errors.
- Existing real read-only DINO benchmark: three runs passed, 11 completed units per run. Evidence: artifacts/benchmark/runtime-memory/core-image-after-20261107/runtime-memory-2026-11-07T02-00-15-045Z.json.
- Matched before/after: three fresh-profile runs and 100 real page switches each; separate five-minute CPU pair completed.
- Native thumbnail A/B and reverse tests: 1,000 successful outputs per pass; generated 1k/5k/10k catalogs and native scrolling passed.
- Continuous-use harness short smoke: packaged-soak-JidkOq, normal exit and main-process cleanup, 10,000 source hashes unchanged. Smoke-only, not a two-hour result.

## Harness issue corrected

First short soak attempted to read the sampler immediately after its ready marker and before its first complete sample. Added a bounded 15-second sample wait; rerun passed. Failure evidence retained in packaged-soak-GeBrd6; never counted as acceptance.

## Pending / not covered

Current optimized Windows package build and packaged startup validation are in progress. Thirty-minute and two-hour continuous-use acceptance require actual elapsed runs and are not complete. Existing user-profile installation/upgrade, representative real-media long-running model workload and judged text relevance are not covered by isolated generated fixtures. No search algorithm or image quality was changed.

No shutdown will be performed.


## Windows candidate and continuous run update

Online NSIS package generated at release/Siftory Alpha Online Setup 1.0.1-alpha.23.exe. Packaged launch smoke returned passed=true, version Alpha23, nativeAddonLoaded=true (artifacts/performance-packaged-launch.log). Covered-source and runtime-package verification both reported ok=true; app.asar SHA256 0a27a359312a4de04db379281fd8d63230493f14ec17d0feb8fb483e08173b31. The PowerShell build wrapper returned exit 1 after classifying normal node-gyp stderr as NativeCommandError; subsequent build stages and package validators completed. Do not describe that wrapper itself as a clean exit.

Full 120-minute isolated packaged run started at 2026-11-07T02:33Z. Live pointer: artifacts/performance-soak-active.json; log: artifacts/performance-packaged-soak.log; raw/checkpoints/report: artifacts/benchmark/runtime-memory/packaged-soak-slivUf/. No final completion or memory-stability acceptance is claimed before its report completes. Candidate artifact must remain unchanged during the run. No real-user installation/upgrade acceptance or GitHub release has been performed for these changes.


<!-- soak-result:packaged-soak-slivUf -->
## Actual packaged continuous-use result

{
  "passed": false,
  "status": "failed",
  "evidence": "artifacts/benchmark/runtime-memory/packaged-soak-slivUf/report.json",
  "activeMinutes": 120.00003333333333,
  "actions": 480,
  "memoryTrendReviewRequired": false,
  "mainProcessExited": true,
  "errors": [],
  "shutdownRequested": false
}

Continuous-use acceptance did not pass; inspect the evidence. Do not mark the pending longevity items complete.

## Long-run sampler repair

The previous run completed 480 navigation actions and normal application exit, but its sampler stopped at exactly 12,000 records (last sequence 11,999). It requested a 1,000ms interval; the reused sampler intentionally clamps intervals to 100–500ms. Consequently its fixed 12,000-record budget lasted 100.765 minutes, leaving an unmeasured tail. This was a harness budget error, not an established application failure. Old failure artifacts remain unchanged and are not accepted.

The repaired harness normalizes the interval before deriving a duration-based sample budget (15,001 records for 120 active minutes plus five minutes setup/verification allowance). It rejects stale samples during execution, refreshes the final checkpoint, and validates whole-run coverage and interior gaps before acceptance. The report finalizer now requires valid coverage and a nonempty memory summary. Application code and the frozen package are unchanged by this repair.

Seven policy/sampler regressions passed, including actual Windows PID-safe process sampling, stale/future timestamp rejection, missing-tail rejection and interior-gap rejection. A short packaged smoke and new full-duration run are tracked separately; the previous two-hour run remains failed.

Repair validation: packaged smoke packaged-soak-rXcDJW completed, 36 samples, maximum gap 587ms, whole-run coverage valid, source files unchanged and main process exited normally. Full replacement run packaged-soak-8EB3Zq started 2026-11-07T05:09:25Z (13:09 Asia/Shanghai), with 500ms sampling and a 15,001-record budget. Current state is running, not accepted. Live log: artifacts/performance-packaged-soak-retry.log. A separate finalizer will append the terminal result and only mark longevity acceptance passed when coverage, memory summary, source verification and normal exit all pass. No Windows shutdown is requested or scheduled.


<!-- soak-result:packaged-soak-8EB3Zq -->
## Actual packaged continuous-use result

{
  "passed": true,
  "status": "completed",
  "evidence": "artifacts/benchmark/runtime-memory/packaged-soak-8EB3Zq/report.json",
  "activeMinutes": 120.00008333333334,
  "actions": 480,
  "memory": {
    "samples": 14149,
    "firstWorkingSetMiB": 482.4375,
    "lastWorkingSetMiB": 553.5,
    "peakWorkingSetMiB": 828.296875,
    "minFreePhysicalMiB": 1206.2421875
  },
  "sampleCoverage": {
    "valid": true,
    "samples": 14149,
    "firstAt": "2026-11-07T05:09:32.0421989Z",
    "lastAt": "2026-11-07T07:09:39.5322108Z",
    "maximumGapMs": 3172,
    "allowedGapMs": 15000
  },
  "lateWorkingSetSlopeMiBPerMinute": 0.19585266657018202,
  "memoryTrendReviewRequired": false,
  "mainProcessExited": true,
  "errors": [],
  "shutdownRequested": false
}

Thirty-minute and two-hour generated-catalog navigation/thumbnail acceptance passed. This does not cover real-user media or model accuracy.

## Later targeted regressions

FFmpeg warmup: 36 related checks passed after fixing the newly exposed fallback-after-cancellation path. An earlier intentionally strengthened test failed and its evidence remains in performance-ffmpeg-lifecycle.log; the repaired suite is performance-ffmpeg-repaired-tests.log. Startup ABBA and final three-run confirmation completed without Renderer errors.

Automatic maintenance browser lifecycle passed with hidden/collapsed polling paused, local unsaved scopes preserved, foreground interval retained and hidden task completion delivered. The candidate validation pipeline reruns typecheck, focused workspace/browser, dedicated maintenance browser, targeted unit regression, changed-production ESLint, online packaging and actual packaged startup. Child exit codes are captured directly, avoiding the earlier PowerShell stderr classification issue. Outputs: artifacts/performance-candidate-validation.json and per-step logs.

The previous missing Playwright-managed Chromium executable was an environment setup failure; the browser suite was rerun using the already-installed Chrome via its existing SIFTORY_TEST_CHROMIUM_PATH option. No application workaround was applied.

## Combined candidate package — latest state

All validation steps passed with direct child exit code 0: typecheck, focused workspace (184 tests), focused browser, dedicated maintenance browser, targeted regression (41 tests), changed-production ESLint, online package build and actual packaged/native startup. Validated selected-source fingerprints and package SHA256 are recorded in artifacts/performance-candidate-validation.json. GitHub origin/main was fetched again and remains cb8d4d5, equal to local HEAD; performance edits are local and have not been published.

The new package passed a short native scenario with library/source/maintenance/settings navigation, opening the automatic-maintenance section, valid sample coverage, original source hashes unchanged and normal exit (packaged-soak-gB4tJ8). This short smoke does not satisfy two-hour acceptance.

Its own full 120-minute run started at 2026-11-07T07:42:50Z (15:42 Asia/Shanghai), evidence directory artifacts/benchmark/runtime-memory/packaged-soak-s5SEki/. The run verifies the previously validated artifact/source fingerprints, alternates the maintenance section open/collapsed, retains 10k generated catalog/thumbnail work, and freezes the tested package. Live log: artifacts/performance-combined-package-soak.log. It is still running. Finalizer will append actual terminal results and only check the combined-package TODO after correct artifact identity, full coverage, source hashes, memory review threshold and normal exit pass. No shutdown.


<!-- soak-result:packaged-soak-s5SEki -->
## Actual packaged continuous-use result

{
  "passed": true,
  "status": "completed",
  "evidence": "artifacts/benchmark/runtime-memory/packaged-soak-s5SEki/report.json",
  "activeMinutes": 120.00016666666667,
  "actions": 480,
  "memory": {
    "samples": 14301,
    "firstWorkingSetMiB": 481.90234375,
    "lastWorkingSetMiB": 521.5078125,
    "peakWorkingSetMiB": 803.47265625,
    "minFreePhysicalMiB": 1082.7890625
  },
  "sampleCoverage": {
    "valid": true,
    "samples": 14301,
    "firstAt": "2026-11-07T07:42:56.5313002Z",
    "lastAt": "2026-11-07T09:43:03.9695708Z",
    "maximumGapMs": 2045,
    "allowedGapMs": 15000
  },
  "artifactSha256": "d5faed9ad4b6d697cb71451d459210873e7c9a560821e757dd56ad874cfe775d",
  "candidateLabel": "combined-four-variable-candidate",
  "lateWorkingSetSlopeMiBPerMinute": 0.20540044736300353,
  "memoryTrendReviewRequired": false,
  "mainProcessExited": true,
  "errors": [],
  "shutdownRequested": false
}

Thirty-minute and two-hour generated-catalog navigation/thumbnail acceptance passed. This does not cover real-user media or model accuracy.

## Real-gallery candidate final validation

Real-library cached-preview change passed the full candidate pipeline: typecheck, 184 focused workspace tests, focused browser, maintenance lifecycle browser, new thumbnail lifecycle browser, 41 existing targeted regressions, changed-production ESLint, online package build and actual packaged startup. Separately, 23 thumbnail strategy/queue/cache tests passed.

The newly rebuilt package also passed an isolated 10000-real-entry gallery scenario (real-gallery-packaged-20261107): cached-scroll preview-element readiness 100%, frame interval P95 8.7ms in this single packaged smoke, no page errors, and all 100 cached thumbnail output hashes identical to the original-control output. The checked app.asar hash matches the validation manifest. Exact artifact identity and installer hash: artifacts/performance-real-gallery-delivery.json.

This is a local Alpha23-stamped candidate, not a new published GitHub release or installer-upgrade acceptance. Existing four-variable long-run evidence remains scoped to its recorded artifact. This fifth, renderer-only variable uses targeted short-form A/B/lifecycle/package regression. Original real media remains read only. Eight BMP diagnosis failures and the cold-open outliers are reported in PERFORMANCE_REAL_GALLERY.md rather than hidden as passing image cases. No shutdown.
