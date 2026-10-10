# Vector chunk integrity anchors

## Goal

Close the early same-size rewrite blind spot left by the existing 64 KiB tail hash without turning every vector append or ANN search into a full-file hash.

## Design

- Hash up to four deterministic 64 KiB windows at the head, one-third, two-thirds, and tail of the anchored prefix.
- Retain the existing tail hash for backward compatibility and cheap current-end validation.
- Store optional chunk anchors in authoritative import manifests and embedding increment commits, so legacy metadata remains readable.
- Require newly written authoritative manifests to anchor the complete imported file.
- Reuse the increment's original stable-prefix anchor after appends while refreshing the tail hash, bounding append-time hashing instead of rehashing up to 256 KiB per row.
- Include base and delta anchors in ANN metadata and hot-snapshot validation. Legacy ANN metadata rebuilds once and is then upgraded.

The maximum data read for one chunk anchor is 256 KiB. The scheme is bounded sampling rather than a full-file cryptographic proof; it specifically strengthens detection of head, early, middle, and anchored-tail rewrites while preserving hot-path cost limits.

## Verification

Synthetic corruption fixtures cover deterministic window geometry, early same-size rewrites that leave the legacy tail hash unchanged, append-safe prefix anchors, authoritative-store rejection, increment invalidation, and ANN hot-snapshot rebuild. No real user vector data is read or modified.
