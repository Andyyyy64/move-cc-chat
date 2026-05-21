# Security Model

`move-agent-chat` is designed to move agent chat state without copying account
credentials or machine-wide configuration. It still moves transcripts, and
transcripts can contain sensitive content.

## Data That Leaves The Machine

For Codex transfer, the uploaded payload is one file named `session.bin`.

Before upload, the bundle is:

1. packed as JSON
2. gzip-compressed
3. encrypted locally with AES-256-GCM
4. base64-encoded for GitHub Gist transport

The uploaded Gist contains only the encrypted payload. It does not contain the
AES key unless the transfer code itself is pasted into the Gist by the user.

## Transfer Code Sensitivity

The `mc_...` transfer code contains:

- the AES-256-GCM key
- the Gist id

Anyone with the code can download and decrypt the bundle while the Gist exists.
Treat the code like a temporary secret. Send it only through a channel you trust,
and avoid leaving it in long-lived public logs.

## GitHub Gist Boundary

The tool uses `gh gist create` without `--public`. GitHub CLI creates secret
Gists by default, meaning they are unlisted but accessible to anyone with the
URL.

This means:

- GitHub receives the encrypted `session.bin`.
- GitHub does not receive the transfer key from this tool.
- The destination machine deletes the Gist after a successful pull or import.
- If deletion fails, the CLI and UI report the Gist id so it can be deleted
  manually.

Secret Gists are not an access-control boundary equivalent to private storage.
They are a transport convenience for encrypted blobs.

## Data Included In Codex Bundles

Included:

- Codex transcript JSONL
- matching `session_index.jsonl` rows
- matching shell snapshots
- generated images for Codex Desktop
- metadata needed to register the thread locally

The transcript may include:

- user prompts
- assistant responses
- tool calls and tool outputs
- command output
- cwd values and git metadata
- summaries and developer instructions stored by Codex

## Data Excluded From Codex Bundles

Excluded by design:

- `auth.json`
- API tokens and login cookies stored outside the transcript
- full `config.toml`
- plugin caches
- Codex app logs
- unrelated sessions
- whole home directories

This does not guarantee there are no secrets in the transcript. If a previous
prompt or command output printed a secret, that secret is part of the chat state
and can be transferred.

## Local UI Boundary

`move-agent-chat ui` binds to `127.0.0.1` by default.

The UI:

- lists local Codex sessions through the helper process
- asks the helper to pack, encrypt, upload, download, decrypt, preview, and
  import
- displays decrypted metadata after the local helper verifies the transfer code
- does not store transfer codes beyond the browser page state

Do not bind the UI to a public network interface unless you are intentionally
placing the helper behind your own access controls.

## Native Import Safety

Native Codex import writes into the selected Codex home. It refuses to overwrite
an existing transcript with the same thread id unless `--force` is used.

Bundle file paths are validated before writing:

- absolute paths are rejected
- `..` traversal is rejected
- restored assets are limited to known bundle paths

SQLite registration is best-effort. A SQLite failure should not corrupt the
transcript import, and the transcript remains available on disk.

## Threats This Does Not Solve

This tool does not solve:

- malicious local users on the same machine
- compromised GitHub accounts or `gh` installations
- transfer codes pasted into public chat, logs, or issue trackers
- secrets already present inside the transcript
- future Codex storage schema changes
- remote access to the localhost UI if it is bound outside loopback

## Operational Rules

Recommended default behavior:

- use `move-agent-chat codex push --current` from the source machine
- send the pull command only to the destination machine
- use preview before import when receiving an old or unexpected code
- use `--mode handoff` when you only need continuity context
- use native mode when you want the thread to appear in Codex history
- delete the Gist manually if automatic cleanup reports a failure
