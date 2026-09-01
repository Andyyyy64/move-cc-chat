# Codex local thread transfer architecture

This document records the storage contract observed in Codex App 26.825.51511 and Codex CLI 0.147.0 on 2026-09-01, cross-checked against the current `openai/codex` thread-store and rollout source. Local storage is not a stable public API, so the implementation discovers capabilities and refuses unknown required state rather than assuming an older schema.

## Source-of-truth hierarchy

### 1. Durable rollout

The durable chat is an append-only JSONL file:

```text
<codex-home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl
```

Archived rollouts may live under `archived_sessions/`. The filename can contain more than one UUID after a fork or migration; `session_meta.payload.id`, not a filename substring alone, identifies the thread.

Paginated history rows contain `ordinal`, `timestamp`, `type`, and `payload`. Legacy history remains present in current Codex stores and has the same JSONL event families without ordinals. Observed top-level types include:

- `session_meta`: thread/session IDs, cwd, source, thread source, model provider, CLI version, history mode, optional Git and history-base data, and dynamic tools;
- `turn_context`: per-turn cwd, model/effort, permission profile, workspace roots, summary, and turn ID;
- `response_item`: user/assistant messages, encrypted reasoning, and tool calls/outputs;
- `event_msg`: task lifecycle, item completion, token counts, and UI event summaries;
- `world_state` and other versioned records.

The importer requires a complete newline-terminated file, valid JSON beginning with `session_meta`, and a matching UUID. Paginated history requires non-decreasing ordinals on every row; observed duplicate ordinals are preserved and counted in the manifest, while descending ordinals are rejected. Legacy history permits all rows to omit ordinals; mixed legacy rows are rejected. It reads a stable snapshot and rejects a file that changes during the read.

### 2. State database

`state_5.sqlite.threads` registers each rollout in the native thread list. The current table has evolved beyond the original 17 fields and includes:

- durable linkage: `id`, `rollout_path`, timestamps, source, cwd, title;
- execution metadata: provider/model/effort, sandbox, approval, history mode, memory mode;
- Git metadata;
- presentation and organization: preview, explicit `name`, archive, pin, section/position, recency, project ID.

Related tables include projects/project roots, thread sections, dynamic tools, spawn edges, and thread artifacts. Those rows are destination-local or independently derived. A sync import does not wholesale copy them.

For a new thread, the importer inserts only columns present in the destination schema and resolves `project_id` from destination project roots. For an existing thread, it updates only rollout-derived fields and the destination cwd. It preserves destination project, explicit name, pin, section, archive state, positions, and unrelated relations.

### 3. Materialized history

`thread_history_1.sqlite` contains derived `thread_turns`, `thread_items`, `thread_realtime_items`, and `thread_history_projection_state` tables.

The projection state couples a durable JSONL byte offset with the next ordinal. Codex applies projected rows and advances that checkpoint in one SQLite transaction, so the database may lag the rollout but must never lead it.

For a `source-ahead` sync, the existing destination rollout is an exact prefix, so its current projection checkpoint remains valid and Codex can materialize only the new suffix. A missing thread has no projection rows and materializes from byte zero. Diverged replacements are prohibited, so the importer never rewrites derived history behind Codex's back.

### 4. Lightweight index and assets

`session_index.jsonl` currently uses `id`, `thread_name`, and `updated_at`. The importer atomically replaces only the selected thread's index entry.

Known thread-local generated media lives under `generated_images/<thread-id>/` and is restored after path/traversal and hash validation. Shell snapshots are excluded because they contain machine-specific environment and paths and are not safe cross-platform state.

### 5. Writer coordination

An existing `thread-writer-locks/<thread-id>.lock` indicates a local writer may own that thread. Mutating a same-ID rollout while Codex holds an open writer can split the file descriptor from its path or race an append, so import is blocked until the destination thread is closed.

## Exact lineage model

The plugin compares durable bytes, not titles, timestamps, row counts, or rewritten JSON.

```text
missing            destination has no rollout
identical          source == destination
source-ahead       destination is an exact byte prefix of source
destination-ahead  source is an exact byte prefix of destination
diverged           neither is a prefix
```

For divergence, the report gives the common byte count and the first differing row's ordinal/type without returning transcript content. There is no automatic JSONL merge: duplicated tool calls, encrypted reasoning items, turn lifecycle rows, and history-base references cannot be safely interleaved generically.

The plugin does not rewrite historical cwd strings. Rewriting old JSON would break exact prefix lineage and falsify historical tool output. The selected destination cwd is stored in destination thread metadata, and future turns record their own destination context.

Reverted and fork-derived rollouts can declare `session_meta.history_base` with an immutable rollout ID, byte offset, and ordinal boundary. The packer resolves that rollout ID from the canonical filename, recursively follows its own history base, and includes only each referenced complete JSONL prefix. Destination inspection applies the same exact-prefix classification to every dependency. A missing/source-ahead dependency is written before the selected rollout; a diverged or actively written dependency blocks the entire import.

The stable thread ID and selected immutable rollout ID are distinct after `thread/revert`. If both machines have the same thread ID but select different rollout IDs, the destination selection is considered related only when its rollout ID appears in the source history dependency chain. That case is reported as `source-branches-from-destination` and requires explicit agent approval. The importer preserves the old rollout file, writes the new selected rollout at its own canonical path, and updates only the thread's SQLite rollout pointer. Unrelated selected rollout IDs are blocked.

## Bundle v3

The encrypted payload contains manifest/device IDs, rollout hash and ordinal range, bounded thread metadata, the source project/Git snapshot, recursively required history-base prefixes, generated-image hashes/bytes, and the exact selected rollout bytes.

Before any destination write, the importer verifies schema, UUIDs, newline/JSON/ordinal rules, all hashes and sizes, known asset roots, and traversal constraints.

## Device inbox

Each machine generates a local X25519 key pair. The private PKCS#8 key stays in `~/.move-agent-chat/device.json` with restrictive permissions. A public SPKI device card is published as a secret/unlisted Gist and identified by the SHA-256 fingerprint of the public key.

At upload, the source resolves one exact named destination card, creates an ephemeral X25519 key, derives an AES-256-GCM key through HKDF-SHA-256, encrypts the gzip bundle, and uploads it addressed to the destination fingerprint.

The destination lists only uploads addressed to its fingerprint and decrypts with its private key. There is no symmetric transfer code to copy between chats. A successful import deletes the upload; deletion failure is reported independently because it does not roll back a completed local import.

GitHub receives ciphertext plus minimal routing metadata. Secret Gists are unlisted rather than access-controlled private storage, so recipient encryption remains required.

## Project collision analysis

The thread and project are separate state domains. The plugin never synchronizes project files.

For Git repositories it compares normalized remote identities, HEAD, branch, a tracked-file inventory hash, and staged/unstaged/untracked paths. For non-Git directories it builds a bounded inventory of relative paths, file sizes, and hashes for small files within a total hashing budget.

Target selection order is an explicitly supplied existing `targetCwd`, then the exact source path when it exists locally, then one unambiguous saved-project candidate with the same Git remote identity or non-Git basename.

Any difference becomes structured evidence for Codex, including bounded `onlySource`, `onlyDestination`, and `changed` relative-path lists computed from the two inventories. The agent skill requires local read-only inspection of those relevant paths before accepting the project state. The inspection token hashes the upload, destination rollout, selected project snapshot, writer-lock state, and candidate evidence, so a state change invalidates earlier approval.

## Import transaction boundary

Import performs fresh inspection/token verification, an atomic same-directory rollout write, validated image writes, a SQLite transaction for registration, an atomic index update, and independent inbox deletion.

A new-rollout failure removes the newly created rollout best-effort. Existing source-ahead writes are exact-prefix replacements and do not offer a force or divergent rollback path.
