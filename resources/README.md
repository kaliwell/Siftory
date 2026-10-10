# Runtime resource workflow

`runtime-manifest.json` is the only allowlist for model, tool, and native runtime inputs.
The fetcher never scans arbitrary workstation folders.

## Commands

Verify the current resource tree without writing:

```powershell
npm.cmd run resources:verify
```

Seed or refresh an explicit content-addressed cache from exact verified targets, downloading
missing `fetchPolicy=download` artifacts when necessary:

```powershell
npm.cmd run resources:fetch -- --cache-dir=C:\controlled-cache
```

Restore a clean target tree without network access:

```powershell
npm.cmd run resources:fetch -- --cache-dir=C:\controlled-cache --target-dir=C:\clean-worktree --offline
```

Limit an operation with repeatable `--component=<stable-id>` arguments. Network operations accept
`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; `--timeout-ms` and `--retries` are bounded.

Cache entries are stored as `sha256/<digest>.blob`. Every cache hit, downloaded temporary file,
and prepared target is checked against both `sizeBytes` and `sha256`. A mismatch is deleted before
the operation fails. `manual-review` and `local-build` artifacts are never downloaded from a
substitute URL; they require an already verified target or cache entry.

## Reproducible build evidence

Run two detached worktrees from the same commit. The first pass starts with an empty explicit
cache and seeds it only from the verified source tree; the second pass restores only from that
controlled cache:

```powershell
npm.cmd run build:reproducible -- `
  --workspace-root=C:\temp\floating-clock-repro-worktrees `
  --cache-dir=C:\temp\floating-clock-repro-cache `
  --seed-root=C:\source\floating-clock `
  --report-dir=C:\evidence\floating-clock-repro `
  --commit=HEAD `
  --build=package
```

The workspace root must not exist and the cache must contain no files at startup. Each pass runs
`npm ci`, verifies all runtime resources offline, builds, and generates a CycloneDX SBOM. The
report includes the commit, lockfile and runtime-manifest hashes, tool versions, full material
inventory, renderer/Electron output hashes, expanded package contents, and installer hash.

Reproducibility requires identical source-bound inputs and expanded package contents. NSIS
installer bytes are recorded but are not required to match because archive metadata and future
signing timestamps can be nondeterministic.
