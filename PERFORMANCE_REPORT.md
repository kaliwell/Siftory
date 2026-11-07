# Siftory performance comparison — 2026-11-07

Reference: cb8d4d5 (Alpha23). Current candidate changes eight production files across five measured variables: search model visibility polling, thumbnail queue draining, FFmpeg warmup yielding/cancellation, automatic-maintenance visibility polling, and cached thumbnail initialization during scrolling. Search algorithms, image quality, security checks, retained pages and the technology stack are preserved.

The first comparison table below covers the earlier queue/model-polling candidate. Later startup and maintenance measurements have their own scopes and are reported separately; do not combine them into a single unmeasured end-to-end claim.

Fresh isolated development profiles; three runs per variant; 60 seconds idle; 100 actual mounted-page switches, then 10 seconds settling. Medians below. OS cache and external load uncontrolled: fresh-profile startup is not guaranteed cold-disk startup. Interactive timing includes automation. Development process-tree working sets include the launch wrapper and can double-count shared memory.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Launch to observable window | 974.18 ms | 968.95 ms | −5.23 ms; no established gain |
| Launch to first contentful paint | 1140.00 ms | 1131.50 ms | −8.50 ms; no established gain |
| Search navigation interactive | 1239.10 ms | 1223.39 ms | −15.71 ms; no established gain |
| Idle working set at 60 seconds | 432.09 MiB | 431.86 MiB | −0.23 MiB; essentially unchanged |
| Sampled peak working set | 738.97 MiB | 743.63 MiB | +4.65 MiB; no improvement established |
| After 100 switches and settling | 488.14 MiB | 494.70 MiB | +6.56 MiB; GC/background variability |
| Page switch P95, median of three runs | 88.54 ms | 79.17 ms | −9.37 ms; ranges overlap |
| Five-minute hidden-search idle CPU, single pair | 0.191% | 0.088% | −0.103 percentage points |
| Native 10,000-item catalog scrolling, frame P95 | 8.5 ms | 8.3 ms | no established frame-rate improvement |

CPU is a separate workload: actual Electron main process tree, 60 OS samples per side, image/video search pages mounted but hidden behind Settings, one-core normalization. A single low-CPU pair is suggestive, not statistical proof. Evidence: artifacts/benchmark/runtime-memory/performance-comparison-summary.json, final-comparison-20261107/, idle-cpu-comparison-20261107/.

## Accepted changes

Real production scheduler and native thumbnail IPC; same 1,000 generated JPEGs; 256px output; six-item batches; initial 24ms debounce; 100-item bursts; three fresh profiles per variant:

| Workload | Before median | After median | Change |
|---|---:|---:|---:|
| First profile pass | 13.817 s | 9.065 s | −34.4% |
| Repeat profile pass | 5.666 s | 1.299 s | −77.1% |

All passes returned 1,000 thumbnails, zero failures and identical total encoded output length. Reverse testing with original queue returned to approximately 13.4–13.6 s / 5.47–5.50 s. Removed repeated delays between queued batches; initial coalescing, concurrency, priority, cancellation and limits retained. Evidence: scheduler-{before,after,reverse-before}-20261107/report.json.

Hidden search pages made eight model-status calls in 31 seconds before, zero after. Scoped React Profiler fixture: 10→6 commits; 9.5→4.3 ms total render duration. Hidden events and explicit task refresh retained; reopening refreshes immediately. These are scoped observations, not global React/IPC claims.

## Rejected strategies and limits

Full, search-only and demand-only preloading were screened; alternating full/demand confirmation did not reproduce apparent memory gains after settling. Original preloading retained. Page unmounting was not implemented because local search results/task state are not fully externalized. Main-service deferral awaits finer dependency/timing evidence.

Generated 1,000/5,000/10,000-path catalogs use the normal 100-item library page; native scroll tests mounted at most 15 cards. They do not replace real-user media or human search judgments. Thumbnail quality and search precision unchanged.

Windows packaging and two-hour acceptance remain tracked in PERFORMANCE_REGRESSION.md. User currently has no fixed text-search judgment corpus: text accuracy remains uncovered. No shutdown will be performed.



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

## FFmpeg startup optimization

Service-call profiling identified an asynchronous API with a synchronous prelude: warmFfmpegStatusCache spent 78–165ms invoking probes before yielding. A one-variable ABBA experiment ran four blocks of three isolated starts (six original / six yielding). Existing two optimizations remained constant.

| Metric | Original, six-run median | Yielding, six-run median | Change |
|---|---:|---:|---:|
| Observable window | 981.27 ms | 944.58 ms | -36.69 ms |
| Launch to FCP | 1135.90 ms | 1099.80 ms | -36.10 ms |
| Search navigation interactive | 1233.37 ms | 1199.43 ms | -33.94 ms (-2.8%) |

Each candidate block improved its median compared with both original blocks; individual results overlap, so the observed improvement is modest and environment-specific. Final guarded candidate confirmation: three successful fresh-profile runs, interactive median 1189.50ms, FCP median 1107.00ms, plus 300 page switches. Evidence: ffmpeg-warmup-yn4Tj2/comparison.json and summary.json; ffmpeg-final-20261107/baseline.json beneath artifacts/benchmark/runtime-memory/.

Warmup still starts after persisted tool configuration, deduplicates concurrent readiness requests, and is awaited by callers that need status. Cancellation generation guards prevent deferred probes or fallback candidates spawning after cancellation and prevent cancelled results poisoning the cache. Existing security/recovery/agreement/IPC ordering remains intact. Unit coverage includes concurrent deduplication, cancellation before and during probing, and configuration-generation races.

## Automatic maintenance visibility polling

An opened automatic-maintenance section made six status invokes while hidden behind Settings over 31 seconds. The candidate made zero. Real React/synthetic bridge evidence: artifacts/performance-hidden-maintenance-{before,after}.json. Root Profiler commits stayed six; no general render-time or CPU-percentage improvement is claimed from this fixture.

The UI's interval is active only while the maintenance page and section are visible. Backend maintenance is unchanged. Dedicated browser checks passed: no hidden/collapsed polling, immediate restore refresh, one foreground interval, unsaved scope selections retained, and task completion retained after navigating away.

The completed two-hour acceptance above applies to the earlier queue/model-polling package. The combined four-variable package requires its own final packaged run; it is not automatically covered by the earlier result.


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

## Real-gallery result

A later targeted single-file change in ThumbnailImage.tsx lets cached previews initialize during deferred scrolling. For 1k/5k/10k real catalogs, three runs per variant reproduced cached-position return of 137.6/135.5/131.3ms to 13.7/14.4/14.7ms. Warm-scroll preview-element readiness changed from 1.8% to 100%, with zero extra IPC in either variant. All 10000 source hashes and the 100 generated thumbnail-cache outputs per UI scenario were identical. This metric is not cache hit rate or guaranteed per-pixel presentation.

Frame-rate and memory improvements are not claimed: 5k frame P95 was 9.7 to 13ms and process-tree RSS peaks increased about 10–25MiB. A cold-open ABBA follow-up reproduced slow pre-card samples in both variants (medians 452.5 vs 440.2ms), without establishing a candidate-specific cold-open regression. Read PERFORMANCE_REAL_GALLERY.md for full data and the separate 57-input decoding diagnosis (49 successes, eight existing BMP failures). Latest package validation is recorded independently; the previous four-variable two-hour acceptance is not relabeled as a long-run test of this later change.
