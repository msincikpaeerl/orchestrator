# 0016 — Encryption of stored secrets

- Status: accepted
- Date: 2026-09-23

## Context

The GitHub token is stored in the database, encrypted with a key from the `ORCHESTRATOR_SECRET_KEY` environment variable (09, section 5). The variable is a text of at least 32 characters, generated with `openssl rand -base64 32`. Later lots store other secrets the same way.

## Decision

- The encryption key is derived from `ORCHESTRATOR_SECRET_KEY` with HKDF-SHA256 (salt `orchestrator`, info `secrets aes-256-gcm v1`, 32 bytes), so any text of sufficient length gives a proper AES key.
- Each secret is encrypted with AES-256-GCM, Node.js's built-in `crypto`, a random 96-bit nonce per encryption and the secret's name as associated data (a ciphertext cannot be moved to another name).
- The `secrets` table stores the name, the scheme version (1), the nonce and the ciphertext followed by its 16-byte authentication tag.
- If the key changed, decryption fails. The server keeps running: at start and at each use of the token it records the problem (`github_connection.unreadable_since`, event `github.token_unreadable`), "Needs you" asks to enter the token again, and the check endpoint answers `github_token_unreadable`. Saving a token clears it. The token is never written to logs, events or API answers.

## Alternatives considered

- PostgreSQL `pgcrypto`: the key would travel in SQL statements and could appear in database logs.
- libsodium (`crypto_secretbox`): an extra native dependency for no gain over the built-in AES-GCM.

## Consequences

- Losing `ORCHESTRATOR_SECRET_KEY` means entering the secrets again; the user documentation says to back it up.
- Changing the key has no rotation command yet; the scheme version allows adding one.
