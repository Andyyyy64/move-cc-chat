# move-agent-chat

Move a Codex chat between computers as native **local Codex data**. It does not use Remote or Codex Cloud as the thread store and it does not continuously synchronize in the background.

The primary interface is a Codex plugin with local MCP tools. A source agent uploads one thread to a named device inbox. The destination agent inspects exact transcript lineage and the local project/Git state before importing it.

## Agent workflow

Source Mac:

```text
Use Move Agent Chat to upload this thread to desktop.
```

Destination Desktop:

```text
Use Move Agent Chat to inspect the pending upload from mac and import it into this local Codex.
```

The imported rollout, index entry, generated images, and native SQLite registration live under the destination's local Codex home. The source computer can be offline afterward.

## Install the Codex plugin

Prerequisites:

- Node.js 22.13+
- GitHub CLI (`gh`) authenticated to the same trusted GitHub account on both devices
- Codex Desktop or Codex CLI on both devices

Build the repository:

```bash
npm ci
npm run build
```

Add this repository as a local marketplace, then install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/move-agent-chat
codex plugin add move-agent-chat@personal
```

Start a new Codex chat after installation so the skill and MCP tools load.

## Register both devices once

On the Mac, ask:

```text
Register this device in Move Agent Chat as mac.
```

On the Desktop, ask:

```text
Register this device in Move Agent Chat as desktop.
```

Registration creates an X25519 private key in `~/.move-agent-chat/device.json` and publishes only the public device card as a secret/unlisted GitHub Gist. Device names are stable identifiers and cannot silently move to a different key.

## What happens during import

The destination performs two separate operations:

1. `inspect_upload` decrypts and validates the upload, compares the thread and project state, and returns a state-bound inspection token. It does not write Codex data.
2. `import_upload` requires that fresh token and writes only a missing thread or an exact source-ahead suffix.

Same-ID histories are classified as:

- `missing`: create a native local thread.
- `identical`: idempotent no-op.
- `source-ahead`: destination bytes are an exact prefix; append the verified source suffix.
- `destination-ahead`: safe no-op; the destination already contains more history.
- `diverged`: stop. Automatic merge and force overwrite are intentionally unavailable.

Historical rollout bytes are never path-rewritten. The destination working directory is recorded in destination metadata, preserving exact lineage across Mac → Desktop → Mac transfers.

## Project and Git conflicts

Project files are not copied. The upload carries bounded evidence so the destination Codex can decide where the thread belongs:

- directory path/inventory hashes;
- normalized Git remote identity;
- HEAD and branch;
- tracked inventory hash;
- staged, unstaged, and untracked paths.

If a directory or repository exists on both machines but differs, the plugin stops before import. The companion skill tells Codex to inspect the actual destination repository and relevant files with read-only tools. Accepting the project state only binds the chat to that directory; it never authorizes Git checkout, merge, reset, stash, or file replacement.

## Data included

- the selected rollout JSONL;
- thread metadata needed for native registration;
- matching generated images;
- bounded project/Git evidence.

Excluded:

- `auth.json`, API keys, login cookies, global configuration, memories, logs, caches;
- shell snapshots and environment state;
- arbitrary project/repository files;
- unrelated threads or SQLite rows.

## Legacy CLI transfer

The earlier transfer-code commands remain available for manual one-shot transfer:

```bash
move-agent-chat codex push --current
move-agent-chat codex pull mc_...
```

They use the older bundle/import path. The plugin inbox flow is the supported path for conflict-aware Mac/Desktop synchronization.

## Documentation

- [Current Codex storage and import model](docs/codex-transfer.md)
- [Security model](docs/security.md)
- [Codex++ embedded UI](docs/codex-plusplus.md)
- [Release checklist](docs/release-checklist.md)
