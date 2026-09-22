# 0015 — Argon2id passwords and database sessions

- Status: accepted
- Date: 2026-09-23

## Context

One owner logs in with a username and a password of at least 12 characters (01, section 3.11). 09, section 5 requires Argon2 hashing and an HTTP-only, SameSite strict session cookie. Sessions must be revocable (logout, password reset, later from Settings).

## Decision

- **Hashing:** Argon2id through `@node-rs/argon2` (prebuilt native binaries, no install script), with OWASP's minimum recommended cost stated in the code: 19 MiB memory, 2 passes, parallelism 1. Hashes are stored in PHC format, so they carry their own parameters and salt. A failed login verifies a dummy hash when the username is unknown, so both cases take the same time and get the same answer.
- **Sessions:** a random 256-bit token, sent in the `orchestrator_session` cookie (HTTP-only, SameSite strict, path `/`, `Secure` when `PUBLIC_URL` is HTTPS). The `sessions` table keeps only its SHA-256 hash, with an expiry date. The lifetime is a setting (`sessionLifetimeDays`, default 30). Logout deletes the session; `orchestrator reset-password` deletes them all.
- The API refuses a second owner at the database level: the `owner` table has a single allowed row.
- **Throttling:** failed logins are counted per username and per client address in the `login_failures` table, so they survive restarts. From the `loginFailuresBeforeDelay`-th failure (default 5), the next attempt must wait `loginFirstDelaySeconds` (default 10), doubled with each further failure up to `loginMaxDelaySeconds` (default 15 minutes). During the wait the API answers 429 with `Retry-After` without checking the password. Failures older than `loginFailureMemoryMinutes` (default 60) are forgotten; a successful login clears its username and address; `orchestrator reset-password` clears everything. Each delay writes an `owner.login_throttled` event, without the typed username (it may be a password typed in the wrong field).

## Alternatives considered

- Node.js's built-in `crypto.argon2`: no dependency, but still experimental in Node.js 24 and without PHC encoding.
- `argon2` (node-gyp based): needs an install script, which pnpm blocks by default.
- Signed stateless cookies (JWT): cannot be revoked without a server-side list anyway.

## Consequences

- Logging in costs about 20 MiB of memory for a few tens of milliseconds, acceptable for one user.
- Behind a reverse proxy, every client has the proxy's address; the per-username limit still applies. Trusting `X-Forwarded-For` can be added with the reverse proxy documentation.
- Someone guessing passwords can make the owner wait up to the maximum delay; `reset-password` lifts it.
- Stealing the database does not give usable session cookies.
