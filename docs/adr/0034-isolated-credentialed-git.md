# 0034 — Credentialed Git commands run in an isolated repository

- Status: accepted
- Date: 2026-10-06

## Context

The daemon uses the owner's GitHub token for Git commands (fetch, and push from lot 3) in a repository an agent has just worked in, under the owner's own Linux user. An agent, or instructions hidden in a web page it read, can change anything that user can write: the bare clone's configuration and hooks (shared by the run's worktree), the worktree's files, the owner's global Git configuration, `~/.netrc` and `~/.git-credentials`. It needs no `git config` in its allowlist: `node` writes files.

Git reads all of these. Lot 2's fetch ran in the bare clone with its configuration, and two leaks were shown in lot 3 step D1, each with a regression test that fails on the lot 2 daemon:

- `http.proxy` (with `http.sslVerify=false` for HTTPS) sends the fetch to another host, which answers with a credential challenge; the daemon's helper sees the right host and gives the token;
- the remote URL rewritten to another host makes the daemon's helper refuse, and Git then starts `core.askPass`, which inherited the helper's socket and key and asks the daemon for the token itself.

Git also starts programs of its own while holding the credential's variables: `git --git-dir=<bare clone> for-each-ref` for a repository borrowing another's objects (it reads the bare clone's configuration), and `git maintenance run --auto --detach` after a fetch.

## Decision

Every Git command that may hold the credential (fetch and push) reads no file an agent can change (05, section 7.1):

- It runs in an **isolated repository**: a new bare repository made for that one command in the run folder (`git init --bare --template=`, random name, removed afterwards), whose configuration only the daemon writes (no hooks, `core.alternateRefsCommand=true`, `maintenance.auto=false`, `protocol.allow=never` with only the URL's protocol allowed, `http.followRedirects=false`, `push.followTags=false`, and the rest listed in 05). It borrows the bare clone's objects through alternates, read only. A fetch moves its pack into the bare clone, and the daemon sets `refs/remotes/origin/*` with one `update-ref` transaction, without the credential.
- Git is given the run's **explicit URL**, never a remote name: **https** only (http only to a loopback address, for tests; `file` with no credential).
- The **environment is an allowlist**: `PATH`, `LC_ALL=C`, `HOME=/nonexistent`, no global or system configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), no terminal prompt, the proxy variables of the daemon's own environment, and the helper's socket and key.
- The **credential helper is one-shot**: given on the command line, it answers one request only, for the exact protocol, host and repository path of the URL; its first refusal closes it for good.
- The push sends one hash, read once with the submission's facts, by an explicit refspec, never forced, and reads its result from `--porcelain`.

## Alternatives considered

- **Overriding dangerous settings one by one on the command line** (`-c http.proxy= -c core.askPass= ...`). Rejected: it needs a complete list of Git's settings that can send a request elsewhere or start a program, and Git adds new ones (`http.curloptResolve` came in 2.37); `include.path` and `includeIf` pull settings from any file; a forgotten setting is a leak nobody sees. It also does nothing for `~/.netrc` or for the child processes Git starts in another repository, which drop the command-line settings.
- **Detecting changed configuration and refusing the command** (with a "Needs you" item). Rejected: it is the same list, read at another moment, and the file can change between the check and Git reading it, while the agent's session is alive at `ticket_submit`. Common tools change the shared configuration legitimately (husky sets `core.hooksPath`), so it would also raise false alarms the owner cannot act on. Lot 3 step D2 restores a changed configuration and records an event, as information only.

## Consequences

- No setting or file an agent can write changes where a credentialed command connects or which program receives the credential. `apps/daemon/test/credential-leaks.test.ts` plants each known way and checks that nothing reaches another host, no planted program runs, no file and no process holds the token; `push.test.ts` checks with trace2 that no process holding the credential reads the bare clone's configuration.
- The owner's global and system Git configuration is ignored by the daemon: a Git proxy set there (`http.proxy`) is not used, only the proxy variables of the daemon's environment (Help > Machines > Troubleshooting).
- The daemon's local Git commands in the bare clones and worktrees also run with hooks, `core.fsmonitor` and automatic maintenance off, and the same isolated `HOME`, so a program named in the configuration does not start outside the run's process scope.
- What stays open is in 05 section 7.2: agents run as the daemon's user, so an agent can read the daemon's machine token and ask the server for the credential of an active run, and a process it leaves running can read the environment of Git processes started at the same time; filters named in the bare clone's configuration can still start programs from the daemon's local commands (without the credential). The fix, agents under a separate system user, is in lot 7.
- **Do not simplify this** (running the fetch or push in the bare clone again, inheriting the daemon's environment, or dropping `core.alternateRefsCommand` or `maintenance.auto=false`) without rerunning the leak tests and reading this record: each piece closes a leak that was shown.
