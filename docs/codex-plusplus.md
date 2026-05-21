# Codex++ Embedded UI

The repository includes a Codex++ tweak that places Move Agent Chat inside
Codex Desktop.

The tweak is intentionally thin. It does not parse Codex transcripts, decrypt
transfer bundles, or write `state_5.sqlite` itself. It starts the local
`move-agent-chat ui` helper and embeds that localhost UI in Codex Desktop.

## Why This Shape

Directly mutating Codex Desktop state from a tweak would couple the UI to
Codex++ internals and Codex storage internals at the same time. The safer split
is:

- Codex++ tweak: Codex Desktop integration and panel placement
- local helper: session discovery, encryption, Gist transport, preview, import
- core library: Codex bundle parsing and native/handoff import

This keeps the transfer logic testable outside Codex Desktop.

## Files

- `codex-plusplus/move-agent-chat/manifest.json`
- `codex-plusplus/move-agent-chat/index.js`
- `codex-plusplus/move-agent-chat/README.md`
- `scripts/install-codexpp-tweak.mjs`

## Install

Build the CLI first:

```bash
npm run build
```

Install into the detected Codex++ tweaks directory:

```bash
npm run install:codexpp-tweak
```

Or pass the tweaks directory explicitly:

```bash
node scripts/install-codexpp-tweak.mjs /path/to/codex-plusplus/tweaks
```

Restart Codex Desktop and open:

```text
Settings -> Tweaks -> Move Agent Chat
```

## Runtime Behavior

Renderer side:

- registers a `Move Agent Chat` settings section
- lets the user configure the helper command and port
- embeds the helper UI in an iframe
- uses Codex++ IPC to start, stop, and check the helper

Main side:

- checks whether the helper is already responding on `127.0.0.1:<port>`
- starts `move-agent-chat ui --host 127.0.0.1 --port <port>` when needed
- stops only the helper process it started

## Helper Requirements

The helper command defaults to:

```bash
move-agent-chat
```

If the binary is not on PATH inside Codex Desktop, set the helper command in
the tweak panel to an absolute path or a wrapper script.

The helper still requires:

- Node.js 20+
- authenticated `gh`
- local Codex session files

## Manual Fallback

The embedded panel uses the same server as:

```bash
move-agent-chat ui
```

If Codex++ is unavailable or the embedded panel cannot start the helper, run the
UI manually and open the printed localhost URL.

## Current Verification Boundary

The tweak source and installer are syntax-checked and install-tested into a
temporary directory. Full in-app rendering requires Codex++ installed in Codex
Desktop. In environments without Codex++, only the helper UI and API can be
verified.
