# Codex Transfer Architecture

`move-agent-chat` treats Codex as the primary provider. It supports Codex
Desktop and Codex CLI through separate home directories.

## Codex Homes

Codex Desktop:

- default home: `~/.codex-app`
- session transcripts: `~/.codex-app/sessions/YYYY/MM/DD/*.jsonl`
- thread list database: `~/.codex-app/state_5.sqlite`
- lightweight thread index: `~/.codex-app/session_index.jsonl`
- shell snapshots: `~/.codex-app/shell_snapshots/<thread-id>.*.sh`
- generated images: `~/.codex-app/generated_images/<thread-id>/`

Codex CLI:

- default home: `~/.codex`
- session transcripts: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- archived transcripts: `~/.codex/archived_sessions/*.jsonl`
- thread list database: `~/.codex/state_5.sqlite`
- lightweight thread index: `~/.codex/session_index.jsonl`
- prompt history: `~/.codex/history.jsonl`

When running inside Codex, the active environment usually exposes:

- `CODEX_HOME`
- `CODEX_THREAD_ID`

These are used by `move-agent-chat codex push --current`.

## Transcript Format

Codex transcript files are JSONL. The important top-level row types are:

- `session_meta`: thread id, cwd, originator, source, CLI version, model
  provider, dynamic tools, and git metadata.
- `turn_context`: per-turn cwd, current date, timezone, model, effort,
  sandbox and approval policy, summary, and developer instructions.
- `response_item`: model messages, reasoning records, tool calls, and tool
  outputs.
- `event_msg`: UI/event stream such as task start, user message, agent message,
  and token counts.

The transcript is the source of truth for continuing work. SQLite and
`session_index.jsonl` are UI/indexing layers.

## Listing Sessions

`move-agent-chat codex list` reads `state_5.sqlite` first because it contains
the current UI thread list and avoids scanning large transcript trees.

If SQLite is unavailable or empty, it falls back to `session_index.jsonl` and
then to walking transcript files. The CLI accepts `--limit` to avoid loading a
large history unnecessarily.

## Packing

`packCodexSession()` creates a gzip JSON bundle with:

- manifest version `2`
- kind `codex-session`
- provider `codex-app` or `codex-cli`
- thread id, title, cwd, updated timestamp, model metadata, first user message,
  and git metadata
- `session.jsonl`
- matching `session_index.jsonl` rows
- matching `shell_snapshots/<thread-id>.*.sh`
- matching `generated_images/<thread-id>/...` for Codex Desktop

The bundle is encrypted by the transport layer before upload.

## Local UI Flow

`move-agent-chat ui` exposes a localhost-only web UI for Codex transfer.

The UI does not browse GitHub Gist contents directly in the page. It calls the
local helper API, and the helper downloads the encrypted `session.bin`, decrypts
it with the key from the transfer code, and returns a structured preview.

The preview intentionally shows metadata instead of dumping the full transcript:

- thread id, title, provider, cwd, model, effort, and git metadata
- total packed bytes and transcript bytes
- shell snapshot count and generated image count
- whether a matching `session_index.jsonl` row is included

Import still happens through the same `unpackCodexSession()` path used by the
CLI, so CLI and UI behavior stay aligned.

## Transfer Code

The transfer code encodes:

- AES-256-GCM key
- Gist id

The key is never uploaded to GitHub. Whoever has the transfer code can decrypt
the Gist payload, so the code must be treated as sensitive until consumed.

## Import Modes

Native mode:

- writes the transcript into the local Codex sessions directory
- appends a `session_index.jsonl` row
- updates `state_5.sqlite.threads` when `sqlite3` is available
- restores matching shell snapshots and generated images
- refuses to overwrite an existing transcript unless `--force` is used

Handoff mode:

- writes `imports/<thread-id>/session.jsonl`
- writes `imports/<thread-id>/handoff.md`
- does not modify native Codex session/index state

Use handoff mode when you want a safe read-only import and native mode when you
want the thread to appear in Codex Desktop or Codex CLI history.

## Path Rewriting

`--cwd` rewrites occurrences of the source cwd in transcript text and shell
snapshots. This is intentionally conservative and string-based, because Codex
tool outputs can contain cwd values in many shapes.

This means:

- exact source cwd occurrences are rewritten
- unrelated text containing the same exact path is also rewritten
- path aliases or symlinks that do not match the exact source cwd are not
  rewritten

## Native UI Registration

Codex Desktop uses `state_5.sqlite.threads` for the thread list. Native import
inserts or replaces the thread row only when requested with `--force`.

The SQLite update is best-effort. If it fails, the imported transcript remains
available on disk and `session_index.jsonl` is still updated.

## Known Storage Coupling

Codex storage is not a public stable API. This implementation is based on the
observed Codex Desktop and Codex CLI layout:

- `sessions/YYYY/MM/DD/*.jsonl` is treated as the transcript source of truth.
- `state_5.sqlite.threads` is treated as a best-effort UI registration layer.
- `session_index.jsonl` is treated as a lightweight fallback index.

If Codex changes these paths or schema columns, native import may still place
the transcript on disk but fail to show the thread in the app until the adapter
is updated.
