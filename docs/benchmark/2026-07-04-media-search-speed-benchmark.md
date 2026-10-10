# MediaSearch Speed Benchmark - 2026-07-04

Test target: `<DATASET>`

## Full Run

- Videos: 28
- Total time: 68,371.13 ms, about 68.37 s
- Failures: enumerate 0, metadata 0, thumbnails 0

## Time Breakdown

| Phase | Time | Percent |
| --- | ---: | ---: |
| Path enumeration | 2,047.35 ms | 2.99% |
| ffprobe metadata | 30,596.76 ms | 44.75% |
| ffmpeg thumbnails | 35,708.92 ms | 52.23% |

Average per video:

- Metadata: 1,092.74 ms/video
- Thumbnail: 1,275.32 ms/video

## Performance Sampling

| Metric | Average | Peak |
| --- | ---: | ---: |
| CPU total | 3.93% | 6.61% |
| GPU total | 3.42% | 4.02% |
| Memory committed | 50.58% | 50.74% |
| Node working set | - | 51.89 MB |

## Conclusion

The slow part is not path scanning. Path enumeration is only 2.99% of total time.

Most time is spent in external media tools:

- `ffprobe` metadata reading: 44.75%
- `ffmpeg` thumbnail generation: 52.23%

GPU utilization is low because the current scan path uses ordinary `ffprobe` and `ffmpeg` thumbnail commands without hardware decode/accelerated scaling. CLIP/DINO embedding can use GPU, but normal metadata scan does not benefit much from GPU.

## Output Files

- Full JSON: `docs\benchmark\media-search-benchmark-20260704-120439.json`
- Performance samples: `docs\benchmark\media-search-perf-samples-20260704-120439.jsonl`
- Summary JSON: `docs\benchmark\media-search-benchmark-20260704-120439.summary.json`

## Suggested Optimizations

1. Keep current functionality, but run metadata and thumbnail work in a bounded worker queue instead of one-by-one.
2. Add GPU/hardware decode flags for thumbnail generation when supported.
3. Cache metadata and thumbnails aggressively by `path + size + mtime`.
4. Keep UI progress lightweight during scan and refresh lists only after task completion.
5. Add a setting for scan concurrency, e.g. 1/2/4 workers, because HDD/SSD and CPU behavior differ by machine.

## Optimization Applied - IPC Scan Path

Implemented on 2026-07-04:

- `videoScanService` now runs video metadata and cover thumbnail work through a bounded async queue.
- Default scan concurrency is now 6 workers. It can be overridden with `FLOATING_CLOCK_MEDIA_SCAN_CONCURRENCY`.
- `ffmpegService` now exposes async `ffprobe` and thumbnail helpers.
- Thumbnail generation tries `ffmpeg -hwaccel auto` first, then falls back to CPU generation if the driver/codec rejects hardware decode.
- Added repeatable real IPC benchmark scripts:
  - `tests\media-search-ipc-scan-benchmark.cjs`
  - `tests\media-search-ipc-scan-benchmark-wrapper.ps1`

## Optimized Real IPC Benchmark

Test target: `<DATASET>`

This benchmark loads the built Electron main process through mocked IPC and uses a temporary `userData` directory, so it measures the real scan service without modifying the current MediaSearch cache.

| Case | Videos | Entries | Time | Result |
| --- | ---: | ---: | ---: | --- |
| Previous sequential benchmark | 28 | 14,040 | 68.37 s | ok |
| Optimized IPC, concurrency 4 | 28 | 14,040 | 6.35 s | ok |
| Optimized IPC, concurrency 6 | 28 | 14,040 | 5.27 s | ok |
| Optimized IPC, default build | 28 | 14,040 | 5.13 s | ok |

Latest sampled resource usage, concurrency 6:

| Metric | Average | Peak |
| --- | ---: | ---: |
| CPU total | 1.95% | 3.94% |
| GPU total | 3.59% | 10.56% |
| Memory committed | 51.39% | 52.78% |
| Node working set | - | 65.07 MB |

Latest output files:

- Full IPC JSON: `docs\benchmark\media-search-ipc-scan-20260704-122235.json`
- IPC performance samples: `docs\benchmark\media-search-ipc-scan-perf-20260704-122235.jsonl`
- IPC summary JSON: `docs\benchmark\media-search-ipc-scan-20260704-122235.summary.json`

Current conclusion:

- The original bottleneck was sequential `ffprobe` + `ffmpeg` work, not directory traversal.
- Bounded concurrency gives the main speedup: 68.37 s -> about 5.13 s on the tested `Downloads` folder.
- GPU usage remains moderate because this path only extracts a single thumbnail per video; metadata probing cannot meaningfully use GPU.
