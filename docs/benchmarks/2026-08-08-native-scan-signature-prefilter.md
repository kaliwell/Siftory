# Native scan image signature prefilter

Date: 2026-08-08
Task: `VAL-013`

## Change

Extension-matched scan candidates now use one file open and a 12-byte header read before any
full-file allocation or read. JPEG, PNG, GIF87a/GIF89a, BMP, and WebP signatures are admitted.
An image with a different supported signature is still admitted after renaming, preserving the
previous content-based decode behavior. Rejected paths enter the existing metadata-keyed failure
cache, so an unchanged spoof is not inspected again during `addNew` scans.

## Benchmark

Command: `node tests/native-scan-signature-benchmark.cjs --count 128 --size-mib 16 --rounds 3`

The fixture contains one valid PNG and 128 hard-linked 16 MiB files named `.jpg` whose first bytes
are not an image signature. Each round represents 2 GiB of avoidable logical full-file reads.

| Build                   | Three samples (ms) | Median (ms) | Result                          |
| ----------------------- | ------------------ | ----------: | ------------------------------- |
| 0.5.25 baseline, run 1  | 2275, 2895, 2936   |        2895 | 1 valid, 128 skipped            |
| 0.5.26 prefilter, run 1 | 124, 122, 124      |         124 | 1 valid, 128 signature-rejected |
| 0.5.25 baseline, run 2  | 2262, 2782, 3049   |        2782 | 1 valid, 128 skipped            |
| 0.5.26 prefilter, run 2 | 123, 124, 124      |         124 | 1 valid, 128 signature-rejected |

The conservative median comparison is `2782 / 124 = 22.4x`. This is a hostile-candidate benchmark,
not a claim that an ordinary photo library becomes 22.4x faster; the real gain scales with the
number and size of extension-spoofed files.

## Correctness and observability

- Targeted Native decode/scan tests: 32/32 passed.
- Full Native suite: 66/66 passed. The existing 512-JPEG benchmark retained the exact dual-hash
  digest (`b278a394...86165a`) and reached 194.29 images/second with the then-selected 5 workers.
- A valid PNG and the same PNG renamed to `.jpg` both retain their exact DiffHash64 and DctHash64.
- A 4 MiB extension-spoofed `.jpg` is rejected before decode and increments
  `signatureRejectedCount`; the unchanged second scan uses the failed-path cache.
- `scan-signature-prefilter` and `scanSignatureBytes=12` are exposed by Native status.
- FastScanner 0.5.26 loads successfully under both Node and Electron runtimes.
