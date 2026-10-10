# Adaptive Native thumbnail fill

Date: 2026-08-08
Task: `VAL-016`

## Change

Native scan thumbnails now use an index-priority worker policy. The scan phase selects one or two
thumbnail workers from logical CPU and available-memory limits; once hash indexing finishes, the
same sidecar expands to as many as eight fill workers. On this 20-logical-processor machine,
validation selected 2 scan workers and dynamically selected 4–6 fill workers as available memory
changed.

When the live queue is full, the scan never waits for thumbnails. It records a lightweight fill
job instead, bounded by both 65,536 entries and 32 MiB of path data. Compressed JPEG input remains
eligible for the shared 128 MiB retention budget, so queued and deferred jobs still avoid a source
re-read whenever memory permits. The stop path clears queued/deferred jobs and releases retained
input before returning.

## Queue-pressure benchmark

Command, run once for each isolated addon:

```text
node tests/native-thumbnails-adaptive-fill-benchmark.cjs --addon <addon> --count 512 --rounds 3
```

The fixture uses 512 hard links to a deterministic 800x600 JPEG of 175,355 bytes. The 0.5.29 run
forces one scan worker, eight fill workers, and a queue capacity of four to create sustained queue
pressure; 0.5.28 ignores these new policy overrides and uses its fixed eight workers and capacity
of 128.

| Build | Median hash-index ready | Median all thumbnails settled | Minimum cache completion | Maximum permanent drops |
| --- | ---: | ---: | ---: | ---: |
| 0.5.28 fixed workers | 979.75 ms | 994.88 ms | 176/512 | 336 |
| 0.5.29 adaptive fill | 646.38 ms | 975.80 ms | 512/512 | 0 |

Hash-index readiness improved by 34.0% while median end-to-end time improved by 1.9%. The new build
deferred 364–386 jobs per round under the deliberately tiny queue and then filled every one. All
512 compressed inputs stayed below the 128 MiB budget, so every round reported 512 input reuses,
zero thumbnail source reads, zero retained bytes at completion, and zero permanent drops.

## Validation

- Queue-pressure fixture verifies scan/fill worker overrides, deferred counts, 100% cache output,
  zero permanent drops, and drained memory/path counters.
- Shutdown fixture stops with a live deferred backlog and verifies zero pending jobs, deferred path
  bytes, and retained JPEG bytes after `stopScanAsync`.
- Native suite: 69/69 passed; thumbnail pipeline contracts: 10/10 passed.
- TypeScript and visible-i18n checks passed.
- FastScanner 0.5.29 and `adaptive-thumbnail-fill` load under Node and Electron runtimes.
- Electron artifact: 1,124,352 bytes,
  SHA-256 `9d2f4a63fef320c75d0c11750aeb774bf0d36ae30c82637f02089e3beba97cf0`.
