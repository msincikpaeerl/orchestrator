# 0036 — End-to-end tests in shards in continuous integration

- Status: accepted
- Date: 2026-10-13

## Context

ADR 0032 split the `test` job into shards and set the rule: a job over 8 minutes gets a new shard rather than a longer timeout. The `e2e` job stayed one job, in the Playwright image (ADR 0021). It took 469 to 479 seconds on `main` before lot 3 step J2c, which adds end-to-end tests of the clean-up after a merge, so it would pass 8 minutes.

Measured locally on 2026-10-13 (142 tests, every test on a computer screen and on a phone): `playwright test --shard=1/2` ran 71 tests in 2.9 minutes, `--shard=2/2` 71 tests in 3.0 minutes. With one worker and tests not run in parallel inside a file, Playwright splits by file and screen size: the first shard holds the computer screen's tests, the second the phone's, which take about as long.

## Decision

- The `e2e` job is a matrix of two shards (`shard: [1, 2]`), each running `playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }}` on its own runner, with the same image, PostgreSQL service, pnpm cache and 10-minute timeout. `fail-fast` is off. Each shard keeps its own report of failed tests (`playwright-report-1`, `playwright-report-2`).
- `ci` needs the job `e2e` once, as for `test`; branch protection is unchanged.
- A test checks that the job runs the sharded command, that its shards are numbered 1 to their count, and that each keeps its own report.
- ADR 0032's rule applies: a shard over 8 minutes gets the next number in the list.
- `pnpm test:e2e` stays the local command and runs every test; it passes its arguments to Playwright, so `pnpm test:e2e --shard=1/2` runs one shard.

## Alternatives considered

- A longer timeout: refused by ADR 0032's rule; it only delays the problem.
- More than one worker in one job: the tests share one server and one database, reset by each test (`e2e/fixtures.ts`); running them in parallel would need a server per worker.
- One job per screen size (`--project`): the same split today, but a third shard would need a new rule; `--shard` grows by adding a number.

## Consequences

- The `e2e` job takes about as long as its slower shard: about half the tests plus the setup (pulling the image, installing, building the UI), paid again on each runner.
- GitHub shows `e2e (1)` and `e2e (2)`; a failure names its shard.
- The balance follows Playwright's split: when it becomes uneven, a third shard spreads it.
