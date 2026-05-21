# move-agent-chat

Move agent chat sessions between machines.

Codex is the primary target. Claude Code support is still available through the
legacy top-level commands.

## Documentation

- [Codex transfer architecture](docs/codex-transfer.md)
- [Codex++ embedded UI](docs/codex-plusplus.md)
- [Security model](docs/security.md)
- [Release checklist](docs/release-checklist.md)

## Prerequisites

- Node.js 20+
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Codex Desktop or Codex CLI on both machines
- Optional: `sqlite3` for native Codex Desktop thread-list registration

## Install

```bash
npm install -g move-agent-chat
```

Or clone and link:

```bash
git clone https://github.com/Andyyyy64/move-agent-chat.git
cd move-agent-chat
npm install && npm run build && npm link
```

The old `move-chat` binary name is kept as a compatibility alias.

## Codex Usage

### Embed in Codex Desktop with Codex++

The repo includes a Codex++ tweak that adds a Move Agent Chat section inside
Codex Desktop settings.

```bash
npm run build
npm run install:codexpp-tweak
```

Restart Codex Desktop, then open Settings -> Tweaks -> Move Agent Chat.

The tweak starts the local `move-agent-chat ui` helper and embeds it in Codex.
It does not transfer auth files or directly mutate Codex state from the tweak.
See [Codex++ embedded UI](docs/codex-plusplus.md) for the integration model.

### Open the local UI

```bash
move-agent-chat ui
```

The UI runs on `127.0.0.1` by default. It lists local Codex sessions, pushes the
current or selected thread, previews encrypted transfer codes after local
decryption, and imports in native or handoff mode.
See [Codex transfer architecture](docs/codex-transfer.md) for what is packed.

### Send the current Codex thread

From inside a Codex Desktop or Codex CLI thread:

```bash
move-agent-chat codex push --current
```

This prints a command containing an encrypted transfer code:

```bash
move-agent-chat codex pull mc_...
```

Send that command or just the `mc_...` code to the destination machine.

### Receive as a native Codex thread

On the destination machine:

```bash
move-agent-chat codex pull mc_...
```

Native mode writes the transcript under the local Codex sessions directory,
updates `session_index.jsonl`, and, when `sqlite3` is available, registers the
thread in `state_5.sqlite` so it can appear in Codex Desktop's thread list.

If the project lives at a different path:

```bash
move-agent-chat codex pull mc_... --cwd /Users/me/dev/myproject
```

If the imported thread does not appear immediately, restart Codex Desktop.

### Receive as a handoff bundle

Use handoff mode when you do not want to modify Codex's native state:

```bash
move-agent-chat codex pull mc_... --mode handoff
```

This writes a local import directory containing:

- `session.jsonl`: the transferred raw Codex transcript
- `handoff.md`: a short prompt you can paste into Codex to continue

### List local Codex sessions

```bash
move-agent-chat codex list
move-agent-chat codex list --provider codex-cli
move-agent-chat codex list --home /path/to/.codex-app
```

Providers:

- `codex-app`: Codex Desktop, usually `~/.codex-app`
- `codex-cli`: Codex CLI, usually `~/.codex`

When running inside Codex, `CODEX_HOME` and `CODEX_THREAD_ID` are used to find
the active thread.

## Claude Code Usage

The legacy Claude commands are still available:

```bash
move-agent-chat push
move-agent-chat pull mc_...
move-agent-chat list
```

These commands move Claude Code sessions from `~/.claude`.

## What Codex Transfer Includes

Codex native transfer includes:

- The thread transcript JSONL from `sessions/YYYY/MM/DD/`
- Matching `session_index.jsonl` entries
- Thread metadata derived from `state_5.sqlite` when available
- Matching shell snapshots from `shell_snapshots/`
- Matching generated images from `generated_images/<thread-id>/`

It intentionally does not transfer:

- `auth.json`
- API keys or login tokens
- Full `config.toml`
- Plugin caches
- App logs
- Temporary files

## Security

- Bundles are encrypted with AES-256-GCM before leaving your machine.
- The encryption key is encoded only in the transfer code.
- GitHub Gists are created as secret/unlisted Gists by `gh gist create`.
- The Gist is deleted after a successful pull.
- Session transcripts can still contain secrets in prompts, command output, and
  tool results. Treat transfer codes as sensitive until they are consumed.
See [Security model](docs/security.md) for threat boundaries and non-goals.

## How It Works

1. Locate the current or requested Codex thread.
2. Pack the transcript, index entry, and thread-local assets.
3. Compress and encrypt the bundle locally.
4. Upload the encrypted bundle to a secret GitHub Gist.
5. Pull, decrypt, path-rewrite, and import on the destination machine.
6. Delete the Gist after successful import.
