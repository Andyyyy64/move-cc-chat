# Observed Codex local storage contract

This plugin targets native local Codex threads, not ChatGPT cloud conversations.

## Durable and derived state

- `sessions/YYYY/MM/DD/rollout-...-<thread-id>.jsonl` is the durable append-only transcript.
- Paginated JSONL rows have non-decreasing `ordinal` values; current stores can contain duplicate ordinals, which are preserved and reported. Current stores can also contain legacy history with no ordinals. The first row is `session_meta`; later rows include `turn_context`, `response_item`, `event_msg`, and other versioned records.
- `session_index.jsonl` is a lightweight name index.
- `state_5.sqlite.threads` registers the rollout and UI metadata. Current schemas also carry project, explicit name, pin, section, archive, recency, history mode, and model fields.
- `thread_history_1.sqlite` materializes turns and items from the durable rollout using byte and ordinal checkpoints. It is derived and may safely lag the rollout; it must never claim bytes that are not durably present.
- Revert/fork rollouts can reference an immutable `history_base` rollout prefix. The transfer follows that chain and independently compares every required dependency before import.
- A thread ID can select a different immutable rollout ID after revert. If the destination's selected rollout is a validated source history dependency, import writes the new rollout separately and switches the destination SQLite pointer only after explicit agent review; it never overwrites the older rollout.
- `thread-writer-locks/<thread-id>.lock` means another Codex writer may own the rollout. Imports into that existing thread are blocked.
- `generated_images/<thread-id>/` contains known thread-local generated assets. Authentication, global configuration, memories, logs, caches, shell snapshots, and unrelated data are excluded.

## Lineage

The plugin keeps historical transcript bytes unchanged, including source paths. It sets the destination working directory in destination metadata instead of rewriting old tool output. This makes exact prefix comparison reliable across repeated Mac and Desktop transfers.

- `missing`: no destination rollout exists.
- `identical`: byte-for-byte equal.
- `source-ahead`: the complete destination rollout is an exact prefix of the upload.
- `destination-ahead`: the complete upload is an exact prefix of the destination.
- `diverged`: neither is an exact prefix. Automatic merge and force overwrite are prohibited.

## Destination-only metadata

On an existing thread, import updates only transcript-derived fields and the destination cwd. It preserves destination project membership, explicit organization, pin, section, archive state, and unrelated relational rows. On a new thread, project membership is resolved from the destination's own saved project roots.

## Project evidence

Project inspection is advisory and never copies project files. Git identity is based on normalized remote identities, not folder names. The report also includes HEAD, branch, tracked inventory hash, and staged, unstaged, and untracked paths. Non-Git directories use a bounded path, size, and small-file hash inventory. Any difference requires the agent to inspect relevant local files before accepting the target state.
