# 0030 — Continuous integration in parallel jobs

- Status: superseded by 0032
- Date: 2026-09-29
- Supersedes: 0008

## Context

ADR 0008 ran `pnpm verify` in one job with a 10-minute timeout. That job took 9 min 22 s before lot 2 step L1; on the L1 pull request every test passed and the job hit its timeout during the final build step. The job had grown with the tests, and later steps add more.

Measured locally on 2026-09-29 (20 cores, so much faster than a CI runner): lint 26 s, type check 10 s, tests 64 s, build 9 s, link check 1 s. The tests are most of the time; in them, about 45 % of the time of the test files goes to creating, migrating and dropping the throw-away databases of the integration tests.

## Decision

- One workflow, `.github/workflows/ci.yml`, on pull requests and pushes to `main`, with read-only permissions. Actions and images are pinned to exact versions; the pnpm store is cached.
- `pnpm verify` is split into parallel jobs, each with a 15-minute timeout: `checks` (lint, type check, link check, `pnpm audit --audit-level critical`), `test` (with PostgreSQL and tmux) and `build`. Together they run every script of `pnpm verify`, which stays the local command that runs everything: a test checks that the workflow runs each of its scripts, so a green local run still predicts a green CI run.
- `e2e` and `docker` are unchanged (10-minute timeouts).
- A final job `ci` needs every other job and fails when any of them failed, was cancelled or was skipped, as in the project skeleton (08, section 4; ADR 0023). Branch protection of `main` requires only `ci`; a test checks that `ci` needs every job.

## Alternatives considered

- Raising the timeout of the single job: CI keeps getting slower with every step, and a failure is reported only after everything before it ran.
- Splitting the tests into shards on several runners (`vitest --shard`): kept for later, if the `test` job alone grows too long; with `ci` as the only required check, adding shards does not change branch protection.

## Consequences

- CI takes as long as its slowest job (today `test`) instead of the sum of all steps.
- Each job installs the dependencies itself (from the cache), which costs some runner minutes.
- Jobs can be added, renamed or removed without changing branch protection, as long as they are listed in the needs of `ci`.
