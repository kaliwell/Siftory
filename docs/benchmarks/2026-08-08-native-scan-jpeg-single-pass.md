# Native scan JPEG input reuse

Date: 2026-08-08
Task: `VAL-015`

## Change

The scan pipeline now transfers its already-read compressed JPEG buffer to the Native thumbnail
sidecar. WIC decodes the thumbnail from an in-memory stream, so thumbnail generation no longer
opens and reads the same source file again. Existing WIC scaling, EXIF orientation, JPEG quality,
cache keys, and scan hash behavior are unchanged.

Retained compressed inputs are bounded to 128 MiB. When the budget is full, the job falls back to
the existing path-based decoder instead of delaying indexing or growing memory without limit.
Progress exposes reuse count/bytes, fallback count, source reads, and current/maximum retained
bytes.

## Benchmark

Command, run once per addon so the 0.5.27 and 0.5.28 binaries stay isolated:

```text
node tests/native-scan-jpeg-single-pass-benchmark.cjs --addon <addon> --count 64 --rounds 3
```

The fixture uses 64 hard links to a deterministic 1600x1200 JPEG of 1,582,467 bytes. Every round
rebuilds all thumbnails and verifies the complete dual-hash digest and thumbnail count.

| Build | Median | Images/s | Reused input | Thumbnail source reads |
| --- | ---: | ---: | ---: | ---: |
| 0.5.27 path input | 527.13 ms | 121.41 | unavailable | 64 by implementation |
| 0.5.28 memory input | 519.19 ms | 123.27 | 64 / 101,277,888 bytes | 0 |

The median throughput improvement is 1.5% on warm cache. The deterministic gain is removal of 64
additional source opens and about 96.6 MiB of logical JPEG input reads. Both versions produced the
same dual-hash digest: `dcc4b1ae1d7ed40ce45b321212d28cd7f9dedc3596421cfa5618589aca99a4f0`.

## Validation

- JPEG scan fixture verifies exact dual-hash parity with the sidecar enabled and disabled.
- Binary thumbnail checks verify JPEG framing, EXIF orientation, and 240x120 output dimensions.
- Reuse diagnostics verify one reused input, zero source reads/fallbacks, and zero retained bytes
  after completion.
- Native test suite: 67/67 passed.
- FastScanner 0.5.28 and `scan-thumbnail-input-reuse` load under Node and Electron runtimes.
- Electron artifact: 1,119,744 bytes,
  SHA-256 `8bb4c5711d96b79b356697c2207a1cfa126b1fa5348cde9974459e502eea7a80`.
