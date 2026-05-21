# Release Checklist

This checklist is for preparing `move-agent-chat` as a product-level package,
with Codex support treated as the primary path and Claude Code commands kept as
legacy compatibility.

## Product Surface

Before release, confirm the shipped surface matches the intended name:

- package name is `move-agent-chat`
- main binary is `move-agent-chat`
- compatibility binary `move-chat` still works
- README uses `move-agent-chat` as the primary name
- docs do not present Claude Code as the primary workflow
- Codex++ manifest id and repo metadata use `move-agent-chat`

## Required Local Checks

Run from the repo root:

```bash
npm run build
npm test
node --check codex-plusplus/move-agent-chat/index.js
node --check scripts/install-codexpp-tweak.mjs
npm pack --dry-run
```

The pack dry run must include:

- `README.md`
- `docs/**/*.md`
- `dist/**/*.js`
- `dist/**/*.d.ts`
- `codex-plusplus/move-agent-chat/*`
- `scripts/install-codexpp-tweak.mjs`

## CLI Smoke Tests

Use a real Codex home when possible:

```bash
move-agent-chat codex list --limit 5
move-agent-chat codex list --provider codex-cli --limit 5
```

From inside a Codex thread:

```bash
move-agent-chat codex push --current
```

On another machine or isolated test home:

```bash
move-agent-chat codex pull mc_... --mode handoff
move-agent-chat codex pull mc_... --cwd /path/to/project
```

Expected behavior:

- push prints a `move-agent-chat codex pull mc_...` command
- pull decrypts and imports
- successful pull deletes the Gist
- handoff mode writes `imports/<thread-id>/handoff.md`
- native mode refuses duplicates unless `--force` is provided

## Local UI Smoke Tests

Start the helper:

```bash
move-agent-chat ui --port 17345
```

Verify:

- `GET /api/health` returns `ok: true`
- sessions load for Codex Desktop
- provider switch can show Codex CLI sessions when available
- Push Current works inside a Codex thread
- Push Selected works from the session list
- Preview displays decrypted metadata for a valid code
- Import supports native and handoff mode
- force overwrite is opt-in
- the UI stays bound to `127.0.0.1` unless explicitly changed

## Codex++ Smoke Tests

Install the tweak:

```bash
npm run build
npm run install:codexpp-tweak
```

If the default path is wrong, pass the tweaks directory explicitly:

```bash
node scripts/install-codexpp-tweak.mjs /path/to/codex-plusplus/tweaks
```

Then restart Codex Desktop and verify:

- Settings shows `Move Agent Chat`
- helper command and port are configurable
- Start opens the embedded localhost panel
- Stop terminates only the helper process started by the tweak
- manual `move-agent-chat ui` still works when Codex++ is unavailable

Current automated checks cover syntax and temporary-directory installation. Full
in-app rendering must be verified in an environment with Codex++ installed.

## Security Review

Confirm:

- transfer payload is encrypted before upload
- transfer code parser rejects malformed compact payloads
- AES key length is validated
- encrypted payloads shorter than IV plus auth tag are rejected
- Gist download size has a bounded maximum
- native import rejects path traversal
- duplicate native imports require `--force`
- docs clearly state that transcripts may contain secrets

## Documentation Review

Update these files whenever Codex storage, UI behavior, or transport behavior
changes:

- `README.md`
- `docs/codex-transfer.md`
- `docs/codex-plusplus.md`
- `docs/security.md`
- `docs/release-checklist.md`
- `codex-plusplus/move-agent-chat/README.md`

## Release Steps

1. Ensure the working tree only contains intended changes.
2. Run all required local checks.
3. Run UI and Codex++ smoke tests where the environment supports them.
4. Update version in `package.json` and `package-lock.json`.
5. Run `npm pack --dry-run` and inspect the package contents.
6. Publish or create the GitHub release according to the project release
   process.
7. Install the published package on a clean machine and run
   `move-agent-chat codex list`.

## Rollback

If a release has a broken Codex import path:

- unpublish or deprecate the package version according to npm policy
- publish a patched version
- recommend `--mode handoff` as a temporary workaround if bundle parsing still
  works
- ask users not to use `--force` on affected native imports until fixed
