# Testing

## Levels

| Level | Tool | Location | Runs with | Status |
|---|---|---|---|---|
| Unit | Vitest | next to the code, `*.test.ts` | `pnpm test` | in place |
| Integration | Vitest, real PostgreSQL (dev compose database) | `apps/*/test/`, `packages/*/test/` | `pnpm test` | in place |
| End-to-end | Playwright, in the pinned Playwright Docker image | `apps/web/e2e/*.e2e.ts` | `pnpm test:e2e` | in place |
| Documentation links | remark-validate-links | all `*.md` | `pnpm docs:links` | in place |

Rules (also in CLAUDE.md):

- New behaviour needs tests; a bug fix needs a regression test that fails before the fix.
- Integration tests use the real database, never mocks of it.
- The daemon's tmux and Claude Code layer is tested against a fake `claude` executable; no real Claude Code in CI.
- Never weaken or delete a test to make CI pass.

## Asynchronous effects

After an asynchronous cause (a message sent, a connection terminated, a process started, a file written by another process), wait for its observable effect with a deadline, then assert: `waitFor` from `@orchestrator/daemon/testing`, or a local helper that throws naming what it waited for. Never assume the effect has happened after the cause returns, and never use a fixed sleep instead. Give the test a timeout above its deadlines, so that a failure names the missed deadline. To check that something does *not* happen, first wait for an effect that comes after it would have, as `pool.test.ts` waits for a connection's end before checking that its loss was reported once.

Repeated local runs do not prove there is no race: CI is slower (a run took 352 s where the same tests take a fraction locally). Two tests of lot 2 passed every local run and failed in CI for this reason.

## Integration tests

They need the development PostgreSQL:

```sh
docker compose -f docker/compose.dev.yml up -d --wait postgres
```

A test ends its pools with `endPool(pool)` from `@orchestrator/db`, never `pool.end()` alone, before dropping its database: `pool.end()` resolves while connections are still closing, and `DROP DATABASE … WITH (FORCE)` would terminate them, an unhandled 57P01 error in the test process (seen on a slow CI runner in lot 2 step H).

GitHub is replaced by a local fake (`apps/server/test/fake-github.ts`) that answers like GitHub for the requests the server makes: tests configure the valid tokens, their permissions, the account's plan and repositories. Repositories keep commits, trees, branches and rulesets in memory; `repositoryHistory` and `repositoryFiles` read them back, and `override` injects any answer (for example a refusal) for one request. The server takes the API address as `githubApiUrl` in `buildApp`. `apps/server/test/helpers.ts` starts the application on a new database and captures its logs, so tests can prove that passwords and tokens never reach them.

Daemons are replaced by a scripted client (`apps/server/test/daemon-client.ts`, ADR 0025): it enrolls with `POST /daemon/enroll`, opens the `/daemon` WebSocket with the machine token, sends `hello` (a healthy machine by default, any field changed by the test), heartbeats or any raw text, and records the server's messages and close code. Tests needing it start the application with `listen: true`, which gives its `url`. Offline detection is tested in milliseconds: `daemonSecondMs` makes one second of the heartbeat settings last, for example, 20 ms.

Rules about concurrent requests (ticket numbers, dependency cycles, project keys, the single use of an enrollment code) are tested by sending the requests at the same time with `Promise.all`; the dependency test was checked to fail without the project lock. Ticket states no lot 1 action reaches (`proposed`, `in_progress`, ...) are seeded directly in the database, never through an API.

The runner (lot 2 step F, ADR 0027) is tested with the host's real `tmux` and `git` and a fake `claude` (`apps/daemon/test/fake-claude/`): a TypeScript program, run through a `claude` shell script that `installFakeClaude` writes in the test's `bin` folder, that checks the launch arguments, runs the run's hooks and status line with Claude Code's documented inputs, writes transcript lines, calls MCP tools, reads pasted messages and plays a JSON scenario (`scenario.ts`; `play(scenario, runId?)`, what it did in `log()`). Each test sets `TMUX_TMPDIR` to its own folder, so its `tmux -L orchestrator` server never meets the owner's. `runner-harness.ts` sets up a `RunManager` in the test process with a recorder for a server that answers tool calls as a test says (`answerTools`), and shortens the run limits with `secondMs`; `runner.test.ts`, `permissions-relay.test.ts` (the `PreToolUse` rules through the real hook, the fake's own MCP client against the real SDK relay, the decision tools, the waiting run lifetime, the status line) and `usage-limits.test.ts` (each signal the fake emits) use it; the usage-limit patterns are also checked by the fixtures in `test/fixtures/usage-limit/`, from the documentation until a real limit is captured; `daemon-runs.test.ts` runs the daemon process against a scripted WebSocket server; `workspace.test.ts` fetches from `git http-backend` behind a Basic authentication server (`git-http-server.ts`); `trust.test.ts` races registrations with another process rewriting the file. Test homes are under `/tmp/od-test-*`: a run's socket path must fit the 107 bytes of a Unix socket.

The real daemon is tested in two ways. In `apps/daemon`, unit tests cover the connection with fake sockets and a fake clock (`connection.test.ts`), and `test/` runs `doctor` and the commands against fake `git`, `tmux`, `claude`, `systemctl` and `loginctl` (small shell scripts). `@orchestrator/daemon/testing` gives a throw-away home folder (`HOME`, `ORCHESTRATOR_HOME` and `XDG_CONFIG_HOME` in a temporary folder, `PATH` holding only the fakes and Node.js), the fakes, and the `orchestrator-daemon` command run from its sources with `tsx`. The certificate checks use a test certificate authority made with `openssl`. In `apps/server/test/daemon.test.ts`, the real daemon runs against the real server: enrollment, connection, reconnection after `restart()` of the test application (same database and port), revocation, an unknown key and a stop by signal. `daemon-package.test.ts` builds the package, has the server serve it, installs it with npm into a temporary prefix (npm's cache and settings in the test folder) and runs it.

Each test file calls `createTestDatabase()` from `@orchestrator/db/testing`: it creates an empty database with a random name on that server, and `drop()` removes it. Tests then apply the migrations themselves or through `startServer`. `migrateUpTo(pool, tag)` applies the migrations up to one of them only, to write data as an older version did and then check a later migration (`apps/server/test/event-log.test.ts` does it with the events of `every-event.ts`, which writes every event type through the real code, machines with the scripted daemon). Set `TEST_DATABASE_URL` to use another PostgreSQL server (the database part of the URL is replaced).

## Runs on the server

`apps/server/test/runs.test.ts` (lot 2 step J) drives runs with the scripted daemon: `find` waits for a message the server sends (a `run.start`, a `run.stop`), `request` sends a report and returns its answer (`ack`, `mcp.result`, `git.credential`). Each Run now refusal, the settings budget of the acceptance criteria, the dispatch acknowledgement timeout (shortened with `daemonSecondMs`, the daemons then sending heartbeats; also across a restart of the test application), a run through to `succeeded` and a counted failure, Stop run (with an MCP call after it, refused), `machine_offline`, `machine_revoked`, the machine holding the ticket's commits, credentials, detected and suspected limits with Resume, and the log's masking and cut. Waits on timers use `eventually` with a deadline naming what it waited for.

## MCP backend and questions

`apps/server/test/mcp.test.ts` (lot 2 step K) drives the tools as a daemon relays them, with `run-harness.ts`: the application, a ready project `WEB`, machines with their accounts, a run brought to `running`, `tool` (a tool call and its result) and `ok` (the output of an accepted call). It covers each tool with its refusals and their setting values, the role permissions (a reviewer profile inserted for the test), the paging and cut of the reading tools under `MCP_OUTPUT_MAX_CHARACTERS`, the progress line shown once per interval (the interval shortened with `daemonSecondMs`), `ticket_create` with its per-run limit fixed at the start, **Accept** and **Reject**, the reduced submission, and the owner's answer: live, refused live and resumed, after the waiting run lifetime with the question and the answer cut at line boundaries, with the machine offline or not confirming, and on an account at its maximum.

The runner's cleanup of processes a session leaves is tested in `apps/daemon/test/processes.test.ts`, without systemd: a fake `claude` scenario (`left-behind.ts`) leaves a plain background process, a `nohup` one, a `setsid` one and a double-forked one, and the test waits with a deadline until none of them carries the run's marker in `/proc`, after the run's end and after a waiting run's session is closed. Such scenarios need `addSystemPath()` of `runner-harness.ts`: tmux gives a new session the `PATH` of its client, not the one passed with `-e`.

## systemd tests

`apps/daemon/test/systemd.test.ts` checks the scopes of lot 2 step K with the host's **real** systemd user session, which CI's runner does not have. It runs only when `ORCHESTRATOR_TEST_SYSTEMD=1` is set; it fails (rather than skip) when that is set and `systemctl --user show-environment` does not answer. On WSL with systemd:

```sh
ORCHESTRATOR_TEST_SYSTEMD=1 pnpm exec vitest run --project apps/daemon test/systemd.test.ts
```

What it creates, all transient units of the user's systemd (nothing is written in the home folder, and no unit file is installed):

- `od-test-<hash>-orchestrator-tmux.scope`: the test's tmux server, started by the daemon code as for the real service;
- `od-test-<hash>-orch-run-<run id>.scope`: each run's fake `claude`;
- `od-test-<hash>-daemon.service`: the daemon started with `systemd-run --user`, stopped and started again to play a restart of the service (a transient service is killed by cgroup like the installed unit).

`<hash>` comes from the test's throw-away `ORCHESTRATOR_HOME` (`unitPrefix` in `apps/daemon/src/systemd.ts`): a real `orchestrator-tmux` scope or `orchestrator-daemon` service is never named, stopped or touched. Every `od-test-*` unit is stopped (and its failed state reset) after each test and before the first one, so an interrupted run's leftovers go at the next run. To remove them by hand: `systemctl --user list-units --all 'od-test-*'`, then `systemctl --user stop <units>`.

## Owner's Claude Code probe

`tools/smoke/claude-code-probe.sh` (lot 2 plan, step H) checks with the **real** Claude Code the documented behaviour the daemon relies on: `--setting-sources user` ignoring the repository's settings, `--strict-mcp-config` ignoring `.mcp.json`, a deny rule refusing `cat`, the status line input, and `autoContinueAtUsageLimit`. Only the owner runs it (working rule 10). Its helper `apps/daemon/scripts/claude-code-probe.ts` builds everything from the daemon's own code (`login`, `runSettings`, `runMcpConfig`, `writeUserSettings`, `claudeArguments`, `TrustRegistry`); the daemon's hook, status line and MCP commands are replaced by `claude-code-probe-recorder.ts`, which records and decides nothing. It works in a scratch folder under `$TMPDIR` with its own Claude configuration folder (deleted at the end with the credentials, unless `--keep`), uses `haiku` and one prompt, prints `PASS`, `FAIL`, `NOT ATTEMPTED` or `INFO` per check, and writes sanitised fixtures to `apps/daemon/test/fixtures/claude-code-<version>/`: only the transcript entries the daemon reads, paths, e-mail addresses and credentials masked, and nothing at all when the owner's e-mail, Git user, organisation id or home folder path still appears (`claude-code-probe-fixtures.ts`, unit-tested with planted values). `pnpm lint` checks it with `bash -n`, and `apps/daemon/test/claude-code-probe.test.ts` runs it against the fake `claude` (`--dry-run`, no login).

## Allowlist smoke test

`tools/smoke/allowlist-smoke.sh` (lot 2 plan, step I; 03, section 6) checks each default profile's allowlist with the **real** Claude Code: one session per profile in a scratch Node.js project whose `test`, `lint` and `build` scripts only print a line, asking for the commands a builder needs (install, test, lint, build, `node`, `mkdir`, `ls`, a `Write`, `git status`, `add`, `commit`, `log`) and for commands that must be refused (`curl`, `sudo`, `docker`, `cat` of the daemon's `config.json`). Only the owner runs it (working rule 10), in step N. Its helper `apps/daemon/scripts/allowlist-smoke.ts` reads the profiles from `agents/` with `parseAgentProfileFile` and builds the settings and arguments from the daemon's code, with the probe's recorder instead of the hook (the hook's rules are tested with the fake `claude`); it prints `PASS`, `FAIL` or `NOT ATTEMPTED` per profile and command, sanitises its report and recorded files with the probe's functions and withholds the report (deleting the recorded files) when the owner's data still appears. `pnpm lint` checks it with `bash -n`, and `apps/daemon/test/allowlist-smoke.test.ts` runs it against the fake `claude` (`--dry-run`), whose scenarios give Claude Code 2.1.283's refusal texts.

## Run messages

`apps/server/src/agents/messages.test.ts` renders the appended instructions and the four run message templates for a sample ticket into `apps/server/src/agents/__snapshots__/run-messages.snapshot.md`. A change of `agents/` changes that file: read it in the pull request, then accept it with `pnpm exec vitest run -u apps/server/src/agents`.

## Running tests

```sh
pnpm test                          # all packages
pnpm test --project apps/server    # one package
pnpm exec vitest                   # watch mode
```

The root `vitest.config.ts` declares one project per folder in `apps/` and `packages/` (ADR 0006). A new package is picked up automatically.

## End-to-end tests

Playwright drives Chromium through the UI, on a desktop screen and on a phone (Pixel 7): every test runs on both, and checks that no screen scrolls sideways (02, section 1). They run in the Playwright Docker image pinned in `tools/e2e-docker.sh` and `.github/workflows/ci.yml`, locally and in CI alike (ADR 0021): nothing is installed on the host.

### Run them locally with Docker

```sh
docker compose -f docker/compose.dev.yml up -d --wait postgres
pnpm test:e2e                         # all tests, desktop and phone
pnpm test:e2e --project=phone         # phone only
pnpm test:e2e setup.e2e.ts            # one file
```

`pnpm test:e2e` builds the UI, then runs `playwright test` in the image with the repository mounted at the same path, the host network (the tests use the development PostgreSQL on `localhost:5432`) and your user, so the files it writes are yours. The first run pulls the image. Results are in `apps/web/test-results/` (a trace for each failed test: `apps/web/node_modules/.bin/playwright show-trace <file>`) and, with `CI` set, a report in `apps/web/playwright-report/`.

Playwright starts `apps/server/test/e2e-server.ts` on port 8095 (`E2E_PORT`), with the built UI, a throw-away database and the fake GitHub, whose tokens are in `apps/web/e2e/fixtures.ts`. Before each test, the `fresh` fixture empties the database and resets the fake GitHub through a control address on the next port, so every test starts from the first launch. The fake account has repositories to link (`notes`, `legacy-site`, and `old-archive`, archived). The `failNextGitHubRequest` fixture uses the same control address to make the next GitHub request with a given method and path ending fail (for example a 503 on `POST .../git/trees` for a failed setup); this control exists only in the test server, never in the Orchestrator. For machines, `connectDaemon` makes the test server enroll the scripted daemon of `apps/server/test/daemon-client.ts` with the code shown on the screen, connect it and say `hello` (with fields to change, such as an old Claude Code), sending heartbeats until the next reset; `comeBack` tells the page it is visible again, as when the owner returns from the terminal, so the screens read their data again. Tests run one at a time.

### Run them on the host

Only when Chromium's system libraries are installed (`apps/web/node_modules/.bin/playwright install-deps --dry-run chromium` lists the missing ones; installing them needs root, which is the owner's decision). Then `pnpm test:e2e:host` downloads Chromium into `.playwright-browsers/` at the repository root (ignored by Git), never into the home folder, and runs the tests.

### Upgrading Playwright

Change `@playwright/test` in `apps/web/package.json` and the image tag in `tools/e2e-docker.sh` and `.github/workflows/ci.yml` together; `apps/web/e2e/image-version.test.ts` fails otherwise.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main` (ADR 0008):

- Job `verify`, with a PostgreSQL service (same image as `docker/compose.dev.yml`):
  1. `pnpm install --frozen-lockfile`
  2. `pnpm verify` (lint, format check, `bash -n` of `tools/smoke/*.sh`, type check, tests, build, link check)
  3. `pnpm audit --audit-level critical`
- Job `e2e`, in the Playwright image with a PostgreSQL service: installs dependencies with the image's Node.js and pnpm (Corepack, pnpm store cached), builds the UI and runs `playwright test`. The report and traces of failed tests are kept as the `playwright-report` artifact for 7 days.
- Job `docker`: builds the image, starts `docker/compose.yml` with a generated `.env`, and checks `/health`, `/version` and that a screen address returns the UI.

To check the workflow file locally:

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12
```

CI must stay under 10 minutes (08, section 4).
