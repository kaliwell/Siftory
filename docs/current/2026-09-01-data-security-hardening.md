# Data security hardening — 2026-09-01

> 状态：当前  
> 更新日期：2026-09-01  
> 范围：应用数据目录权限、备份加密、恢复 journal、Product Health、诊断脱敏

## Scope

This change protects application-owned metadata, credentials and portable asset-library backups. It does not encrypt or modify original image/video files, and it does not add encryption to the hot vector-search store because that would change indexing and query performance.

## Implemented controls

- Packaged builds protect the application data root from inherited cross-account Windows ACL entries. The root grants full control only to the current Windows user, `SYSTEM` and the built-in Administrators group. Development and smoke-test roots are intentionally left unchanged.
- Linux and macOS packaged data roots use mode `0700`; credential and AI-control files use mode `0600`.
- Backup manifests store the stable label `asset-library` instead of an absolute source directory. Valid legacy manifests are migrated with an atomic replacement; backup payloads are not rewritten.
- Portable exports require a 12–256 character password. A scrypt-derived key encrypts every file independently with AES-256-GCM and a random nonce. Import authenticates every file before accepting the normal backup integrity manifest.
- Legacy plaintext exports remain import-compatible. New UI exports always use the encrypted format.
- Backup passwords exist only in renderer/main-process memory for the active operation and are cleared when the backup view closes or an operation succeeds.
- Diagnostic logging removes absolute paths, URIs, email addresses, IP addresses and common secret fields. Backup, settings, media-cache, Native-addon and remote-key errors no longer emit private paths.

## Compatibility and performance

- ACL hardening changes one root DACL and does not recursively enumerate the multi-gigabyte vector store.
- Encryption and decryption are streamed; backup files are not buffered in full.
- Existing local backup directories remain restorable. Only their manifest source label is migrated.
- Original media files and the active vector database are untouched.

## Verification

- The Windows ACL hardening and the read-only probe were executed against isolated temporary directories with the real `whoami.exe` and `powershell.exe` (`Get-Acl`/`Set-Acl`). This surfaced and fixed a real defect: `powershell.exe -Command` appends trailing argv tokens as extra command text instead of populating `$args`, so the original `$args[0]`/`$args[1]` parameter passing never delivered values and hardening always failed on Windows PowerShell 5.1. Paths and SIDs are now inlined as escaped single-quoted literals. (An earlier revision of this document attributed the verification to `icacls`; the implementation has always used PowerShell.)
- Recovery-journal keyed authentication: the asset repair recovery journal is now version 3 with a per-install 32-byte HMAC key (`asset-repair-journal.key.json`, `0600`, protected by Electron safeStorage/DPAPI in production), a whole-file `authTag` verified with `timingSafeEqual`, a monotonically increasing `generation`, and a separately authenticated anti-rollback anchor (`asset-repair-journal.anchor.json`). Fully validated legacy v2 journals are migrated once and fail closed on corruption. Tamper, wrong-key, rollback, anchor-tamper, key-loss, migration, and corruption cases have automated coverage in `tests/asset-identity.test.cjs` (31/31) alongside the existing atomicity, reparse, and fault-injection cases.
- Data-protection state in Product Health is now a live probe (`probeDataDirectorySecurity`, read-only) instead of the startup cache, and a failed state offers a confirmation-gated `repair-data-protection` action that re-runs hardening and re-probes. Coverage in `tests/product-health-repair.test.cjs` (8/8) and `tests/data-directory-security.test.cjs` (11/11 pass, 1 POSIX-only skip on Windows).
- Encrypted round-trip, wrong-password rejection, ciphertext bit-flip rejection, path non-disclosure and legacy backup import have automated coverage.
- IPC registration, payload validation, preload contract, Electron security guards, transaction fault injection, remote credential handling, privacy scanning, type checking, linting and production renderer builds pass.

## Remaining defense-in-depth work

- An attacker who consistently rolls back the journal file, its anchor, and any other userData state together can still restore an older authenticated state; a true anti-rollback anchor requires OS-level storage and is out of scope for now. The anchor does detect partial rollbacks and stale single-file copies.
- Require a clean-source allowlist build before public/open-source release.
