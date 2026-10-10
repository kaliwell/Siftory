# Native scan fallback policy parity

Date: 2026-08-08
Task: `VAL-014`

## Change

USN enumeration and Win32 directory fallback now call one case-insensitive directory policy. The
policy excludes generated/cache trees plus whole-drive system roots including `Windows`,
`Program Files`, `Program Files (x86)`, and `ProgramData`. USN keeps excluded directory FRNs and
propagates the exclusion to descendants instead of allowing their files to reappear.

Fallback status now contains a stable code, Win32 error, administrator requirement, and an action:

- `volume-access-denied`: restart as administrator for USN or continue safely with enumeration;
- `volume-open-error`: check that the drive is online and permits direct volume access;
- `journal-query-failed`: check NTFS and USN journal availability;
- `not-drive-path`: use the safe enumeration backend for directory paths.

## Benchmark

Command: `node tests/native-scan-fallback-benchmark.cjs --files-per-directory 512`

The fixture places 512 valid PNGs in each of four system-named directories and one PNG in
`Pictures`. It measures the actual volume-access-denied fallback used on this machine.

| Build                      | Enumerated files | Indexed | Skipped dirs | Scan time |
| -------------------------- | ---------------: | ------: | -----------: | --------: |
| 0.5.26 baseline, cold      |            2,049 |   2,049 |            0 |    206 ms |
| 0.5.27 shared policy, cold |                1 |       1 |            4 |      3 ms |
| 0.5.26 baseline, warm      |            2,049 |   2,049 |            0 |     57 ms |
| 0.5.27 shared policy, warm |                1 |       1 |            4 |      3 ms |

The conservative warm-cache comparison is 19x, while the more important result is that 2,048
out-of-scope system files never enter decode, hashing, thumbnails, or the image index.

## Validation

- Directory fallback fixture verifies all four system roots, one retained user image, and the
  structured `not-drive-path` action.
- Static Native contract verifies both backends call the same policy and USN propagates excluded
  parent FRNs.
- Targeted Native decode/scan tests: 33/33 passed.
- FastScanner 0.5.27 loads successfully under Node and Electron runtimes.
