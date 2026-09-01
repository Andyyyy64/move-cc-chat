# Security model

`move-agent-chat` transfers Codex transcripts, which may contain sensitive prompts, tool calls, command output, paths, and repository metadata. It never treats encryption as evidence that a transcript is safe to disclose.

## Trust boundaries

- Both devices are owned and trusted by the same user.
- Both use an authenticated GitHub account that the user trusts for transport.
- Device private keys and local Codex homes are protected by the local OS account.
- GitHub Gists are an unlisted transport, not a private-storage access-control boundary.
- Anyone who controls a destination private key can decrypt uploads addressed to that device.

## Device identity

Registration generates an X25519 key pair. The private PKCS#8 key is written only to `~/.move-agent-chat/device.json` with restrictive permissions where supported. The published device card contains the name, public SPKI key, creation time, and SHA-256-derived device ID.

A device name cannot silently resolve to two public keys. Duplicate names are rejected, and an existing local identity cannot be renamed by repeating registration.

## Inbox encryption

Each upload uses a fresh ephemeral X25519 key. The sender and destination derive a shared secret, then HKDF-SHA-256 derives an AES-256-GCM key with a protocol-specific info label and random salt. The envelope contains the ephemeral public key, salt, IV, authentication tag, ciphertext, recipient/source fingerprints, thread ID, and plaintext hash.

The plaintext is a gzip-compressed bundle. The destination checks recipient identity, AES-GCM authentication, plaintext hash, bundle schema, rollout and asset hashes, UUIDs, JSONL structure, ordinals, size limits, and safe asset paths before writing.

GitHub sees ciphertext and minimal routing metadata: source/destination device fingerprints, thread ID, and creation time. It does not receive a private key or symmetric transfer code.

Recipient encryption provides confidentiality and ciphertext integrity, not cryptographic sender signatures. Inbox discovery relies on the authenticated GitHub account owning the Gist; treat a compromised GitHub account as able to inject or delete uploads, though it still cannot decrypt an existing upload without the destination private key.

## Included data

- selected rollout JSONL and only the recursively referenced complete history-base prefixes;
- bounded native thread metadata;
- generated images owned by that thread;
- bounded project/Git inventory evidence.

Excluded:

- Codex `auth.json`, API keys, tokens, cookies, global config, secrets directories;
- memories, logs, caches, browser state, Computer Use state;
- shell snapshots and environment variables;
- arbitrary repository/project file contents;
- unrelated threads and SQLite rows.

Exclusion does not remove secrets already printed into the selected transcript.

## Import safety

- Inspection is read-only and separate from import.
- Import requires a token bound to the upload, destination transcript, selected project snapshot, candidate list, and writer-lock state.
- Same-ID history must be identical or exact-prefix related. Diverged history has no force or auto-merge operation.
- Existing writer locks block same-ID mutation.
- Writes use same-directory temporary files and atomic rename.
- Existing destination project, pin, section, name, archive, and unrelated relations are not replaced.
- Project/Git inspection never authorizes Git or filesystem mutation.
- Successful local import and remote Gist deletion are reported independently.

## GitHub and `gh`

The tool executes `gh api`, `gh gist create`, `gh gist view`, and `gh gist delete` without a shell. A compromised `gh` installation or GitHub account can deny service, replace public device cards, or delete uploads. Recipient encryption prevents an attacker with only a Gist URL from reading the payload, but it cannot protect against a compromised destination private key or local OS account.

## Legacy transfer codes

The earlier manual CLI path uses AES-256-GCM with a symmetric key embedded in an `mc_...` transfer code. Anyone holding that code can decrypt the matching Gist while it exists. The agent-first inbox does not use transfer codes and should be preferred for normal Mac/Desktop operation.

## Non-goals

This tool does not defend against malicious local users, compromised OS accounts, private keys copied off-device, secrets already present in a transcript, future Codex schema changes, or repository conflicts accepted incorrectly by the user/agent.
