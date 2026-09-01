---
name: move-agent-chat
description: Upload or import native local Codex chat threads between registered computers. Use when the user asks to transfer, sync, upload, inspect, or import a Codex thread as local data rather than use Remote or cloud execution.
---

# Move Agent Chat

Use the `move-agent-chat` MCP tools. The durable transcript is append-only local data; project files are not part of the transfer.

## Authorization boundaries

- An upload request authorizes creating one encrypted inbox upload. It does not authorize importing, changing a repository, or deleting local source data.
- An import request authorizes importing the selected upload into this machine's local Codex store after inspection. It does not authorize Git checkout, merge, reset, stash, file replacement, or repository synchronization.
- Device registration creates a local private key and publishes a public device card to the authenticated GitHub Gist account. Do it only when the user asks to set up or register that machine.

## Upload from the source machine

1. Call `get_current_device` and `list_devices`. If this machine or the named destination is unregistered, report the precise missing registration instead of inventing a device.
2. For the current chat, call `upload_thread` without a thread ID. For another chat, call `list_local_threads`, resolve one exact ID, then upload it.
   Archived threads must be unarchived first so the destination does not register an archived rollout as an active chat.
3. Report the destination, thread ID, upload ID, rollout hash, and project/Git summary. Do not print raw transcript data or any private key.

## Import on the destination machine

1. Call `list_inbox` and resolve one exact upload. If multiple uploads could match, identify them by upload ID, source device, thread ID, and timestamp.
2. Call `inspect_upload` before every import. Inspection is read-only and returns exact lineage, target candidates, project/Git differences, blockers, and a state-bound token.
3. If no target directory is selected, or the reported directory/Git state differs, inspect the destination locally with read-only filesystem and Git commands. Compare repository remote identity, HEAD, branch, staged, unstaged, untracked paths, and every reported `onlySource`, `onlyDestination`, or `changed` path that matters to the task. Do not treat a matching directory name as repository identity.
4. Select `targetCwd` only from evidence. Call `inspect_upload` again after selecting it or after any local state change.
5. Never import a `diverged` history. Explain the first-difference evidence and stop for an explicit user decision; this plugin intentionally has no force-overwrite or automatic merge path.
6. If `rolloutSelection.relation` is `source-branches-from-destination`, inspect the source/destination rollout IDs and required history dependency evidence. This preserves the old rollout file and changes which immutable rollout the thread selects. Set `acceptRolloutSwitch=true` only when that branch selection is the intended sync direction. An unrelated rollout selection is blocked.
7. For `missing` or `source-ahead`, call `import_upload` with the fresh inspection token. Set `acceptProjectState=true` only after completing the conflict inspection above. `identical` and `destination-ahead` are safe no-ops.
8. Read back the returned local rollout path, action, project cwd, and independent upload-deletion result. A successful import with failed upload deletion is not a failed import.

For the observed storage contract, lineage rules, and derived SQLite boundaries, read [references/codex-storage.md](references/codex-storage.md) when diagnosing a rejected transfer or adapting to a new Codex version.
