# Embedding job epoch / owner / heartbeat

## Problem

`embedding_jobs.jsonl` previously received `pending` rows when work was seeded, but the embedding
runtime never persisted `running`, `completed`, `failed`, or `skipped` transitions. Retention
correctly preserves active rows, so every historical `pending` row was preserved indefinitely even
after its vector had been committed.

## Runtime protocol

- Every accepted persistent build creates a monotonically increasing `epoch` and a random build
  `owner`.
- A job is claimed only when it is dispatched to a child. The claim records `running`, `epoch`,
  `owner`, `startedAt`, and `heartbeatAt`.
- A 10-second heartbeat refreshes claimed jobs. A lease expires after 45 seconds.
- Completion and failure require the exact `(epoch, owner)` token. A late result from an older build
  cannot close a job reclaimed by a newer build.
- Stop and fatal worker shutdown release owned jobs back to `pending`. Normal completion records
  terminal state and applies the existing bounded retention policy before the final snapshot.
- At the beginning of a build, authoritative embeddings reconcile legacy or crash-left
  `pending/running/failed` rows to `completed`. This covers the crash window where the vector commit
  succeeded after the last heartbeat snapshot.

The runtime persists one atomic JSONL state snapshot at recovery/reconciliation, periodically at
heartbeat boundaries, and once at shutdown. It does not rewrite the complete jobs file for every
image result.

## Compatibility and migration safety

- `epoch`, `owner`, `heartbeatAt`, and `updatedAt` are optional in the shared type so legacy rows
  remain readable.
- The read-only classifier and stale migration use recent heartbeat/update/start/create activity.
  Fresh epoch work is not classified or archived as stale.
- Migration still keeps malformed rows and aborts before writing if authoritative shard evidence is
  unavailable.

## Synthetic verification

No real user vector database was read or modified. Fixture tests cover:

1. expired lease recovery and live-owner preservation;
2. stale-result fencing across two epochs;
3. crash after a vector commit but before the next job checkpoint;
4. authoritative embedding reconciliation after restart;
5. failed, skipped, and explicit release transitions;
6. migration retention of fresh owned and fresh unowned epoch rows;
7. archival of an expired owned row only when an authoritative embedding exists.
