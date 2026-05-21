# Move Agent Chat Codex++ Tweak

Adds a Codex Desktop Settings panel that embeds the local `move-agent-chat ui`
helper.

The tweak does not read or write Codex session files directly. It starts the
local CLI helper, embeds the localhost UI, and lets the helper handle encrypted
push, preview, and import.

## Install

From the repo root:

```bash
npm run build
npm run install:codexpp-tweak
```

Or pass an explicit Codex++ tweaks directory:

```bash
node scripts/install-codexpp-tweak.mjs /path/to/codex-plusplus/tweaks
```

Restart Codex Desktop, then open Settings -> Tweaks -> Move Agent Chat.

## Requirements

- Codex++
- `move-agent-chat` available on PATH, or set a custom helper command in the
  tweak panel
- `gh` authenticated for transfer upload/download

## Runtime Shape

Codex++ renderer:

- shows the Move Agent Chat section
- embeds the local UI in an iframe
- calls IPC handlers to start/stop the helper

Codex++ main:

- starts `move-agent-chat ui --host 127.0.0.1 --port <port>`
- checks `/api/health`
- stops only the helper process it started

See `docs/codex-plusplus.md` and `docs/security.md` in the package for the full
integration and security model.
