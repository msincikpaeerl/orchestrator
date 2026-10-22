# 0032 — Tests in shards in continuous integration

- Status: accepted
- Date: 2026-10-02
- Supersedes: 0030

## Context

ADR 0030 split `pnpm verify` into parallel jobs, the slowest being `test`. That job took 6 min on PR #27, then 7.5, 9 and 10 min on the next pull requests, the last being step M2's, out of a 15-minute timeout and the 10 minutes CI must stay under (08, section 4). Locally the suite grew only about 15 % over that period: the small CI runner is the limit, not the tests alone.

Measured locally on 2026-10-02 (20 cores, 89 test files, 1,176 tests, 54 s for the whole suite, 655 s of test file time): ten files hold 63 % of the file time, all running the host's tmux or the real daemon (`permissions-relay`, `claude-code-probe`, `acceptance`, `runner`, `allowlist-smoke`, `daemon-runs`, `process-scopes`, `processes`, `tickets`, `usage-limits`, 33 to 52 s each). Vitest's `--shard=i/N` gives each shard the same number of files, ordered by a hash of their paths, never by duration, so those files decide the balance:

| Shards | Share of the file time per shard | Local time per shard |
|---|---|---|
| 2 | 37 %, 63 % | 26 s, 42 s |
| 3 | 24 %, 42 %, 35 % | 22 s, 38 s, 39 s |

With about 1.5 min of setup per job (checkout, install from the cache, tmux, PostgreSQL) and about 8.5 min of tests, the slowest shard is expected at about 7 min with 2 shards and about 5 min with 3.

## Decision

- Everything of ADR 0030 stays, except the `test` job.
- `test` is a matrix of three shards (`shard: [1, 2, 3]`), each running `pnpm test --shard=${{ matrix.shard }}/${{ strategy.job-total }}` on its own runner, with the test PostgreSQL and tmux as before, the same pinned actions, pnpm cache and 15-minute timeout. `fail-fast` is off, so every shard reports its failures.
- `ci` needs the job `test` once: its result is a failure when any shard failed, was cancelled or was skipped. Branch protection still requires only `ci`, which shards do not change.
- Tests check that the workflow runs the sharded command, that the shards are numbered 1 to their count (none left out), and that a job missing from the needs of `ci` is refused.
- A shard is added (the next number in the list, nothing else to change) when a shard takes more than 8 minutes, rather than raising the timeout.
- When one test file is most of a shard's time, a shard more does not shorten it: the file is split, and the new file's name is checked to land apart from the other long files (Vitest places files by a hash of their paths; lot 4 step J, where `acceptance.test.ts` was split and a fourth shard added).
- `pnpm verify` stays the local command, unchanged: it runs every test in one process.

## Alternatives considered

- Two shards: the hash split gives one shard 63 % of the time, about 7 min expected, close to the threshold already; lot 2 keeps adding daemon tests.
- A sequencer that splits by measured durations: better balance, but custom code and durations to keep up to date for a few runner minutes; worth it only if the hash split becomes much worse than today.
- Raising the timeout or a larger runner: the first only delays the problem (ADR 0030); the second costs money on GitHub.

## Consequences

- The `test` job takes about as long as its slowest shard, expected about 5 min instead of 10.
- Each shard pays the setup again: about two more runner minutes per CI run.
- GitHub shows the shards as `test (1)`, `test (2)` and `test (3)`; a failure names its shard, and `pnpm exec vitest run --shard=i/3` runs the same files locally.
- The balance moves when test files are added or renamed, since the split follows their paths.
